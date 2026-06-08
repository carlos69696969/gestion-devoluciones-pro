import { Form, useLoaderData } from "react-router";
import { useState } from "react";
import prisma from "../db.server";
import adminStyles from "../styles/admin.module.css";
import styles from "../styles/repartidor.module.css";
import {
  courierOrderTimestampMs,
  formatCourierAddress,
  formatCourierScheduledDate,
} from "../utils/courier.shared";
import {
  emitCourierReturnRouteNotification,
  fetchCourierOrdersForShop,
  fetchPickupCourierOrders,
  getCourierNextRouteStatus,
  getCourierRouteStatusLabel,
  resolveCourierPortalShop,
  isCourierRouteStatus,
} from "../utils/courier.server";

export const headers = () => ({
  "Cache-Control": "no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow",
});

function getCourierRouteStep(status) {
  const match = String(status || "")
    .trim()
    .toLowerCase()
    .match(/^en_ruta_(\d)$/);
  return match ? Number(match[1]) : 0;
}

function getCourierStatusLabel(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "pendiente") return "pendiente";
  return getCourierRouteStatusLabel(status);
}

export const action = async ({ request }) => {
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "").trim();
  const requestId = Number(formData.get("requestId") || 0);

  if (intent !== "courier_mark_en_route" || !Number.isFinite(requestId) || requestId <= 0) {
    return { ok: false, error: "Accion no valida." };
  }

  const requestRow = await prisma.returnRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      shop: true,
      orderNumber: true,
      customerName: true,
      customerEmail: true,
      customerPhone: true,
      returnMethod: true,
      status: true,
    },
  });

  if (!requestRow) {
    return { ok: false, error: "No encontramos la orden de devolucion." };
  }

  if (String(requestRow.returnMethod || "") !== "pickup") {
    return { ok: false, error: "Solo se puede marcar en ruta una devolucion de recoleccion." };
  }

  const currentStep = getCourierRouteStep(requestRow.status);
  const nextStep = currentStep ? currentStep + 1 : 1;
  if (nextStep > 3) {
    return { ok: false, error: "Esta orden ya alcanzo el maximo de 3 avisos en ruta." };
  }

  const nextStatus = getCourierNextRouteStatus(requestRow.status);
  await prisma.returnRequest.update({
    where: { id: requestId },
    data: { status: nextStatus },
  });

  await emitCourierReturnRouteNotification({
    shopDomain: requestRow.shop,
    requestRow,
    routeStep: nextStep,
  });

  return { ok: true, message: "Orden marcada en ruta y notificacion enviada." };
};

export const loader = async ({ request }) => {
  const { shop, sessionCandidates, allSessionCandidates } = await resolveCourierPortalShop(request);

  if (!shop || !sessionCandidates?.length) {
    return {
      shop: shop || "",
      courierOrders: [],
      error:
        "No se encontro una sesion valida para la tienda. Verifica que la app siga instalada y que exista una sesion offline.",
    };
  }

  const sessionCandidatesByShop = new Map();
  for (const sessionCandidate of allSessionCandidates || sessionCandidates || []) {
    const candidateShop = String(sessionCandidate?.shop || "").trim().toLowerCase();
    if (!candidateShop) continue;
    const current = sessionCandidatesByShop.get(candidateShop) || [];
    current.push(sessionCandidate);
    sessionCandidatesByShop.set(candidateShop, current);
  }

  const shopCandidates = [
    shop,
    ...Array.from(sessionCandidatesByShop.keys()).filter((candidate) => candidate !== shop),
  ].filter(Boolean);

  let courierOrders = [];
  let resolvedShop = shop;

  for (const shopCandidate of shopCandidates) {
    const candidateSessions = sessionCandidatesByShop.get(shopCandidate) || [];
    if (!candidateSessions.length) continue;

    const [deliveryResult, pickupResult] = await Promise.allSettled([
      fetchCourierOrdersForShop({ shop: shopCandidate, sessionCandidates: candidateSessions }),
      fetchPickupCourierOrders(shopCandidate),
    ]);

    const deliveryOrders = deliveryResult.status === "fulfilled" ? deliveryResult.value : [];
    const pickupOrders = pickupResult.status === "fulfilled" ? pickupResult.value : [];
    const nextCourierOrders = [...deliveryOrders, ...pickupOrders].sort(
      (a, b) => courierOrderTimestampMs(a) - courierOrderTimestampMs(b),
    );

    if (deliveryOrders.length > 0) {
      courierOrders = nextCourierOrders;
      resolvedShop = shopCandidate;
      break;
    }

    if (!courierOrders.length && nextCourierOrders.length > 0) {
      courierOrders = nextCourierOrders;
      resolvedShop = shopCandidate;
    }
  }

  return {
    shop: resolvedShop,
    courierOrders,
  };
};

export default function RepartidorPublicPortal() {
  const { shop, courierOrders } = useLoaderData();
  const [activeTab, setActiveTab] = useState("pedidos");
  const routeOrder = courierOrders.find((request) => isCourierRouteStatus(request?.status)) || courierOrders[0] || null;
  const visibleOrders =
    activeTab === "en_ruta"
      ? routeOrder
        ? [routeOrder]
        : []
      : activeTab === "historial"
        ? []
        : courierOrders;
  const hasOrders = visibleOrders.length > 0;
  const isHistoryTab = activeTab === "historial";
  const emptyMessage =
    activeTab === "en_ruta" ? "No hay pedidos en ruta." : "No hay ordenes pendientes por entregar.";
  const isReturnOrder = (request) => String(request?.courierLabel || "") === "Devolucion";
  const isRouteActionVisible = (request) => isReturnOrder(request) && !isCourierRouteStatus(request?.status);

  const buildMapsUrl = (request) => {
    const address = formatCourierAddress(request);
    const query = encodeURIComponent(address);
    return `https://www.google.com/maps/search/?api=1&query=${query}`;
  };

  const buildPhoneUrl = (request) => {
    const phone = String(request?.customerPhone || "").trim();
    const safePhone = phone.replace(/[^\d+]/g, "");
    return safePhone ? `tel:${safePhone}` : "";
  };

  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Portal publico</p>
            <h1 className={styles.title}>Ordenes repartidor</h1>
            <p className={styles.subtitle}>
              Vista publica y sin login para ver ordenes pendientes de entrega y devolucion.
            </p>
          </div>
          <div className={styles.shopBadge}>{shop ? `Tienda: ${shop}` : "Sin tienda detectada"}</div>
        </header>

        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Ordenes repartidor</h2>
          <div className={styles.tabRow} role="tablist" aria-label="Secciones de repartidor">
            <button
              type="button"
              className={`${styles.tabButton} ${activeTab === "pedidos" ? styles.tabButtonActive : ""}`}
              onClick={() => setActiveTab("pedidos")}
            >
              Pedidos
            </button>
            <button
              type="button"
              className={`${styles.tabButton} ${activeTab === "en_ruta" ? styles.tabButtonActive : ""}`}
              onClick={() => setActiveTab("en_ruta")}
            >
              En ruta
            </button>
            <button
              type="button"
              className={`${styles.tabButton} ${activeTab === "historial" ? styles.tabButtonActive : ""}`}
              onClick={() => setActiveTab("historial")}
            >
              Historial
            </button>
          </div>

          {isHistoryTab ? null : !hasOrders ? (
            <p className={styles.empty}>{emptyMessage}</p>
          ) : (
            <div className={adminStyles.courierGrid}>
              {visibleOrders.map((request) => (
                <article
                  key={request.id}
                  className={`${adminStyles.courierCard} ${
                    request.courierLabel === "Devolucion"
                      ? adminStyles.courierCardReturn
                      : adminStyles.courierCardDelivery
                  }`}
                >
                  <div className={adminStyles.courierHeader}>
                    <span
                      className={
                        request.courierLabel === "Devolucion"
                          ? adminStyles.courierBadgeReturn
                          : adminStyles.courierBadgeDelivery
                      }
                    >
                      {request.courierLabel}
                    </span>
                    <span className={adminStyles.courierBadgeStatus}>{getCourierStatusLabel(request.status)}</span>
                  </div>
                  <h3 className={adminStyles.courierOrderNumber}>#{request.orderNumber}</h3>
                  <p className={adminStyles.courierCustomerName}>{request.customerName}</p>
                  <p className={adminStyles.courierField}>
                    <strong>Programado:</strong> {formatCourierScheduledDate(request.pickupDate)}
                  </p>
                  <p className={adminStyles.courierAddress}>{formatCourierAddress(request)}</p>
                  <p className={adminStyles.courierField}>{request.customerPhone || "-"}</p>
                  {activeTab === "en_ruta" ? (
                    <div className={styles.actionRow}>
                      {isReturnOrder(request) ? (
                        <>
                          <a
                            className={`${styles.actionButton} ${styles.actionButtonPrimary}`}
                            href={buildMapsUrl(request)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Mapa
                          </a>
                          {buildPhoneUrl(request) ? (
                            <a
                              className={`${styles.actionButton} ${styles.actionButtonSecondary}`}
                              href={buildPhoneUrl(request)}
                            >
                              Telefono
                            </a>
                          ) : (
                            <button
                              type="button"
                              className={`${styles.actionButton} ${styles.actionButtonSecondary}`}
                              disabled
                            >
                              Telefono
                            </button>
                          )}
                          {isRouteActionVisible(request) ? (
                            <Form method="post" className={styles.inlineActionForm}>
                              <input type="hidden" name="intent" value="courier_mark_en_route" />
                              <input
                                type="hidden"
                                name="requestId"
                                value={String(request.id || "").replace(/^pickup-/, "")}
                              />
                              <button type="submit" className={styles.actionButton}>
                                En ruta
                              </button>
                            </Form>
                          ) : null}
                          <button type="button" className={styles.actionButton}>
                            Recibido
                          </button>
                          <button type="button" className={styles.actionButton}>
                            No recibido
                          </button>
                        </>
                      ) : (
                        <>
                          <a
                            className={`${styles.actionButton} ${styles.actionButtonPrimary}`}
                            href={buildMapsUrl(request)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Mapa
                          </a>
                          {buildPhoneUrl(request) ? (
                            <a
                              className={`${styles.actionButton} ${styles.actionButtonSecondary}`}
                              href={buildPhoneUrl(request)}
                            >
                              Telefono
                            </a>
                          ) : (
                            <button
                              type="button"
                              className={`${styles.actionButton} ${styles.actionButtonSecondary}`}
                              disabled
                            >
                              Telefono
                            </button>
                          )}
                          <button type="button" className={styles.actionButton}>
                            En ruta
                          </button>
                          <button type="button" className={styles.actionButton}>
                            Entregado
                          </button>
                          <button type="button" className={styles.actionButton}>
                            No entregado
                          </button>
                        </>
                      )}
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
