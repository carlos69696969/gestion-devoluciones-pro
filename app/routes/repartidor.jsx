import { useState } from "react";
import { Form, redirect, useActionData, useLoaderData, useSearchParams } from "react-router";
import adminStyles from "../styles/admin.module.css";
import styles from "../styles/repartidor.module.css";
import {
  courierOrderTimestampMs,
  formatCourierAddress,
  formatCourierScheduledDate,
  getCourierRouteStatusLabel,
  isCourierHistoryStatus,
  isCourierRouteStatus,
  isCourierRouteTabStatus,
} from "../utils/courier.shared";
import {
  fetchCourierOrdersForShop,
  fetchPickupCourierOrders,
  markCourierOrderAsEnRoute,
  markCourierOrderAsNotDelivered,
  markCourierOrderForRetry,
  resolveCourierPortalShop,
} from "../utils/courier.server";

export const headers = () => ({
  "Cache-Control": "no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow",
});

function getCourierStatusLabel(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "pendiente") return "pendiente";
  if (normalized === "reintento_pendiente") return "pendiente";
  return getCourierRouteStatusLabel(status);
}

function getDeliveryAttemptLabel(attemptCount) {
  const safeAttemptCount = Math.max(0, Number(attemptCount || 0));
  if (!safeAttemptCount) return "";
  return safeAttemptCount === 1 ? "1 intento de entrega" : `${safeAttemptCount} intentos de entrega`;
}

function getVisibleDeliveryAttemptCount(request) {
  const currentAttemptCount = Math.max(0, Number(request?.attemptCount || 0));
  if (currentAttemptCount > 0) return currentAttemptCount;
  return String(request?.status || "").trim().toLowerCase() === "no_entregado" ? 1 : 0;
}

export const action = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const formData = await request.formData();
    const formShop = String(formData.get("shop") || "").trim().toLowerCase();
    const shop = formShop || (await resolveCourierPortalShop(request)).shop;
    const intent = String(formData.get("intent") || "").trim();
    const requestId = String(formData.get("requestId") || "").trim();

    if (!["courier_mark_en_route", "courier_mark_not_delivered", "courier_retry_delivery"].includes(intent) || !requestId) {
      return { ok: false, error: "Accion no valida." };
    }

    const actionHandler =
      intent === "courier_mark_not_delivered"
        ? markCourierOrderAsNotDelivered
        : intent === "courier_retry_delivery"
          ? markCourierOrderForRetry
          : markCourierOrderAsEnRoute;
    const result = await actionHandler({
      shopDomain: shop,
      requestId,
      orderNumber: String(formData.get("orderNumber") || "").trim(),
      customerName: String(formData.get("customerName") || "").trim(),
      customerEmail: String(formData.get("customerEmail") || "").trim(),
      customerPhone: String(formData.get("customerPhone") || "").trim(),
      currentStatus: String(formData.get("currentStatus") || "").trim(),
      currentAttemptCount: String(formData.get("currentAttemptCount") || "").trim(),
    });
    if (!result.ok) {
      return result;
    }

    if (shop) {
      url.searchParams.set("shop", shop);
    }
    url.searchParams.set("tab", intent === "courier_mark_not_delivered" ? "historial" : "en_ruta");
    url.searchParams.set("overrideRequestId", requestId);
    url.searchParams.set(
      "overrideStatus",
      String(
        result?.nextStatus ||
          (intent === "courier_mark_not_delivered"
            ? "no_entregado"
            : intent === "courier_retry_delivery"
              ? "reintento_pendiente"
              : "pendiente"),
      ),
    );
    url.searchParams.set("overrideAttemptCount", String(result?.attemptCount || formData.get("currentAttemptCount") || "0"));
    url.searchParams.set("updated", String(Date.now()));
    return redirect(`${url.pathname}?${url.searchParams.toString()}`);
  } catch (error) {
    console.error("Courier route action failed", error);
    return {
      ok: false,
      error: String(error?.message || error || "No se pudo procesar la accion del repartidor."),
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
  const overrideRequestId = String(searchParams.get("overrideRequestId") || "").trim();
  const overrideStatus = String(searchParams.get("overrideStatus") || "").trim().toLowerCase();
  const overrideAttemptCount = Math.max(0, Number(searchParams.get("overrideAttemptCount") || "0"));
  const effectiveCourierOrders = courierOrders.map((request) =>
    overrideRequestId && String(request?.id || "").trim() === overrideRequestId
      ? {
          ...request,
          status: overrideStatus || request?.status || "pendiente",
          attemptCount: overrideAttemptCount || Number(request?.attemptCount || 0),
        }
      : request,
  );
  const historyOrders = effectiveCourierOrders.filter((request) => isCourierHistoryStatus(request?.status));
  const routeOrders = effectiveCourierOrders.filter((request) => isCourierRouteTabStatus(request?.status));
  const pendingOrders = effectiveCourierOrders.filter(
    (request) => !isCourierRouteTabStatus(request?.status) && !isCourierHistoryStatus(request?.status),
  );
  const routeOrder = routeOrders[0] || null;
  const visibleOrders =
    activeTab === "en_ruta"
      ? routeOrder
        ? [routeOrder]
        : []
      : activeTab === "historial"
        ? historyOrders
        : pendingOrders;
  const hasOrders = visibleOrders.length > 0;
  const emptyMessage =
    activeTab === "en_ruta"
      ? "No hay pedidos en ruta."
      : activeTab === "historial"
        ? "No hay ordenes en historial."
        : "No hay ordenes pendientes por entregar.";
  const isReturnOrder = (request) => String(request?.courierLabel || "") === "Devolucion";
  const isRouteActionVisible = (request) => !isCourierRouteStatus(request?.status) && !isCourierHistoryStatus(request?.status);
  const isNotDeliveredStatus = (request) => String(request?.status || "").trim().toLowerCase() === "no_entregado";
  const canShowDeliveryResultActions = (request) =>
    !isReturnOrder(request) &&
    activeTab === "en_ruta" &&
    isCourierRouteTabStatus(request?.status);
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

  const confirmCourierAction = (request, actionLabel, confirmNote = "Esta accion enviara una notificacion al cliente.") => {
    const orderNumber = String(request?.orderNumber || "").trim() || "-";
    const customerName = String(request?.customerName || "Cliente").trim();
    return window.confirm(
      `Seguro que quieres marcar el pedido #${orderNumber} como ${actionLabel}?\n\nCliente: ${customerName}\n\n${confirmNote}`,
    );
  };

  const renderCourierActionForm = (
    request,
    buttonLabel,
    intent,
    actionLabel = buttonLabel.toLowerCase(),
    buttonClassName = styles.actionButton,
    confirmNote = "Esta accion enviara una notificacion al cliente.",
  ) => (
    <Form
      method="post"
      className={styles.inlineActionForm}
      onSubmit={(event) => {
        if (!confirmCourierAction(request, actionLabel, confirmNote)) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="shop" value={shop || ""} />
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="requestId" value={String(request.id || "")} />
      <input type="hidden" name="orderNumber" value={String(request.orderNumber || "")} />
      <input type="hidden" name="customerName" value={String(request.customerName || "")} />
      <input type="hidden" name="customerEmail" value={String(request.customerEmail || "")} />
      <input type="hidden" name="customerPhone" value={String(request.customerPhone || "")} />
      <input type="hidden" name="currentStatus" value={String(request.status || "")} />
      <input type="hidden" name="currentAttemptCount" value={String(request.attemptCount || 0)} />
      <button type="submit" className={buttonClassName}>
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

          {!hasOrders ? (
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
                    <div className={styles.statusGroup}>
                      {!isReturnOrder(request) && getVisibleDeliveryAttemptCount(request) > 0 ? (
                        <span className={`${adminStyles.courierBadgeStatus} ${styles.statusBadgeFailed}`}>
                          {getDeliveryAttemptLabel(getVisibleDeliveryAttemptCount(request))}
                        </span>
                      ) : null}
                      <span
                        className={`${adminStyles.courierBadgeStatus} ${
                          isCourierRouteStatus(request.status)
                            ? styles.statusBadgeRoute
                            : isNotDeliveredStatus(request)
                              ? styles.statusBadgeFailed
                              : ""
                        }`}
                      >
                        {getCourierStatusLabel(request.status)}
                      </span>
                    </div>
                  </div>
                  <h3 className={adminStyles.courierOrderNumber}>#{request.orderNumber}</h3>
                  <p className={adminStyles.courierCustomerName}>{request.customerName}</p>
                  <p className={adminStyles.courierField}>
                    <strong>Programado:</strong> {formatCourierScheduledDate(request.pickupDate)}
                  </p>
                  <p className={adminStyles.courierAddress}>{formatCourierAddress(request)}</p>
                  <p className={adminStyles.courierField}>{request.customerPhone || "-"}</p>
                  {activeTab === "historial" && !isReturnOrder(request) && isNotDeliveredStatus(request) ? (
                    <div className={styles.historyActionRow}>
                      {renderCourierActionForm(
                        request,
                        "Reeintentar",
                        "courier_retry_delivery",
                        "reeintentar entrega",
                        `${styles.actionButton} ${styles.actionButtonRetry}`,
                        "Esta accion devolvera la orden al flujo de ruta para intentar la entrega nuevamente.",
                      )}
                    </div>
                  ) : null}
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
                          {isRouteActionVisible(request) ? renderCourierActionForm(request, "En ruta", "courier_mark_en_route", "en ruta") : null}
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
                          {isRouteActionVisible(request) ? renderCourierActionForm(request, "En ruta", "courier_mark_en_route", "en ruta") : null}
                          {canShowDeliveryResultActions(request) ? (
                            <>
                              <button type="button" className={styles.actionButton}>
                                Entregado
                              </button>
                              {renderCourierActionForm(
                                request,
                                "No entregado",
                                "courier_mark_not_delivered",
                                "no entregado",
                                `${styles.actionButton} ${styles.actionButtonDanger}`,
                              )}
                            </>
                          ) : null}
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
