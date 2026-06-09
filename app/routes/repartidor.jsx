import { useState } from "react";
import { Form, redirect, useActionData, useLoaderData, useSearchParams } from "react-router";
import adminStyles from "../styles/admin.module.css";
import styles from "../styles/repartidor.module.css";
import {
  courierOrderTimestampMs,
  formatCourierAddress,
  formatCourierScheduledDate,
  getCourierRouteStatusLabel,
  isCourierRouteStatus,
} from "../utils/courier.shared";
import {
  fetchCourierOrdersForShop,
  fetchPickupCourierOrders,
  markCourierOrderAsEnRoute,
  resolveCourierPortalShop,
} from "../utils/courier.server";

export const headers = () => ({
  "Cache-Control": "no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow",
});

function getCourierStatusLabel(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "pendiente") return "pendiente";
  return getCourierRouteStatusLabel(status);
}

export const action = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const formData = await request.formData();
    const formShop = String(formData.get("shop") || "").trim().toLowerCase();
    const shop = formShop || (await resolveCourierPortalShop(request)).shop;
    const intent = String(formData.get("intent") || "").trim();
    const requestId = String(formData.get("requestId") || "").trim();

    if (intent !== "courier_mark_en_route" || !requestId) {
      return { ok: false, error: "Accion no valida." };
    }

    const result = await markCourierOrderAsEnRoute({
      shopDomain: shop,
      requestId,
      orderNumber: String(formData.get("orderNumber") || "").trim(),
      customerName: String(formData.get("customerName") || "").trim(),
      customerEmail: String(formData.get("customerEmail") || "").trim(),
      customerPhone: String(formData.get("customerPhone") || "").trim(),
      currentStatus: String(formData.get("currentStatus") || "").trim(),
    });
    if (!result.ok) {
      return result;
    }

    if (shop) {
      url.searchParams.set("shop", shop);
    }
    url.searchParams.set("tab", "en_ruta");
    url.searchParams.set("updated", String(Date.now()));
    return redirect(`${url.pathname}?${url.searchParams.toString()}`);
  } catch (error) {
    console.error("Courier route action failed", error);
    return {
      ok: false,
      error: String(error?.message || error || "No se pudo marcar la orden en ruta."),
    };
  }
};

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const { shop, sessionCandidates, allSessionCandidates } = await resolveCourierPortalShop(request);
  const requestedTab = String(url.searchParams.get("tab") || "pedidos").trim().toLowerCase();
  const activeTab = ["pedidos", "en_ruta", "historial"].includes(requestedTab) ? requestedTab : "pedidos";

  if (!shop || !sessionCandidates?.length) {
    return {
      activeTab,
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
    activeTab,
    shop: resolvedShop,
    courierOrders,
  };
};

export default function RepartidorPublicPortal() {
  const { shop, courierOrders, activeTab: initialActiveTab } = useLoaderData();
  const actionData = useActionData();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState(initialActiveTab || "pedidos");
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
  const isRouteActionVisible = (request) => !isCourierRouteStatus(request?.status);

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

  const handleTabChange = (nextTab) => {
    setActiveTab(nextTab);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("tab", nextTab);
    if (shop) {
      nextParams.set("shop", shop);
    }
    setSearchParams(nextParams, { replace: true });
  };

  const confirmRouteAction = (request) => {
    const orderNumber = String(request?.orderNumber || "").trim() || "-";
    const customerName = String(request?.customerName || "Cliente").trim();
    return window.confirm(
      `Seguro que quieres marcar el pedido #${orderNumber} como en ruta?\n\nCliente: ${customerName}\n\nEsta accion enviara una notificacion al cliente.`,
    );
  };

  const renderRouteForm = (request, buttonLabel) => (
    <Form
      method="post"
      className={styles.inlineActionForm}
      onSubmit={(event) => {
        if (!confirmRouteAction(request)) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="shop" value={shop || ""} />
      <input type="hidden" name="intent" value="courier_mark_en_route" />
      <input type="hidden" name="requestId" value={String(request.id || "")} />
      <input type="hidden" name="orderNumber" value={String(request.orderNumber || "")} />
      <input type="hidden" name="customerName" value={String(request.customerName || "")} />
      <input type="hidden" name="customerEmail" value={String(request.customerEmail || "")} />
      <input type="hidden" name="customerPhone" value={String(request.customerPhone || "")} />
      <input type="hidden" name="currentStatus" value={String(request.status || "")} />
      <button type="submit" className={styles.actionButton}>
        {buttonLabel}
      </button>
    </Form>
  );

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
          {actionData?.ok === false && actionData?.error ? (
            <p className={styles.empty} role="alert" aria-live="polite">
              {actionData.error}
            </p>
          ) : null}
          <h2 className={styles.cardTitle}>Ordenes repartidor</h2>
          <div className={styles.tabRow} role="tablist" aria-label="Secciones de repartidor">
            <button
              type="button"
              className={`${styles.tabButton} ${activeTab === "pedidos" ? styles.tabButtonActive : ""}`}
              onClick={() => handleTabChange("pedidos")}
            >
              Pedidos
            </button>
            <button
              type="button"
              className={`${styles.tabButton} ${activeTab === "en_ruta" ? styles.tabButtonActive : ""}`}
              onClick={() => handleTabChange("en_ruta")}
            >
              En ruta
            </button>
            <button
              type="button"
              className={`${styles.tabButton} ${activeTab === "historial" ? styles.tabButtonActive : ""}`}
              onClick={() => handleTabChange("historial")}
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
                    <span className={`${adminStyles.courierBadgeStatus} ${isCourierRouteStatus(request.status) ? styles.statusBadgeRoute : ""}`}>{getCourierStatusLabel(request.status)}</span>
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
                          {isRouteActionVisible(request) ? renderRouteForm(request, "En ruta") : null}
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
                          {isRouteActionVisible(request) ? renderRouteForm(request, "En ruta") : null}
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
