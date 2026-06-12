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
  markCourierOrderAsDelivered,
  markCourierOrderAsEnRoute,
  markCourierOrderAsNotDelivered,
  markCourierOrderForRetry,
  markCourierOrderReadyForBranchPickup,
  markCourierReturnAsReceived,
  markCourierReturnForRetry,
  markCourierReturnPickupAttemptFailed,
  rejectCourierReturnAfterFailedPickups,
  resolveCourierPortalShop,
} from "../utils/courier.server";

const PICKUP_FAILED_REASON_OPTIONS = [
  "No logramos completar la recolección. 🚚 Visitamos tu domicilio, pero no obtuvimos respuesta al tocar la puerta ni al comunicarnos contigo. Nuestro equipo volverá a intentarlo mañana. 📦✨",
  "Recolección reagendada. 📦✨ Nos comunicamos contigo y acordamos realizar un nuevo intento de recolección el día de mañana, ya que no te encontrabas en el domicilio indicado. 🚚",
];
const FINAL_PICKUP_REJECTION_REASON =
  "❌🚚 Después de 3 intentos de recolección en el domicilio registrado, no fue posible recibir el producto. Por esta razón, la solicitud de devolución fue rechazada automáticamente.";
const SECOND_PICKUP_FAILED_WARNING =
  "⚠️ Nota importante: Si mañana no logramos localizarte en tu domicilio por tercera ocasión, tu devolución será cancelada. 📦❌";

function getFailedPickupMessage(request, rejectionReason) {
  const normalizedStatus = String(request?.status || "").trim().toLowerCase();
  if (normalizedStatus !== "en_ruta_2") return rejectionReason;
  return `${rejectionReason}\n\n${SECOND_PICKUP_FAILED_WARNING}`;
}

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

function getFailedDeliveryAttemptCount(request) {
  const currentAttemptCount = Math.max(0, Number(request?.attemptCount || 0));
  if (currentAttemptCount > 0) return currentAttemptCount;
  const normalizedStatus = String(request?.status || "").trim().toLowerCase();
  return normalizedStatus === "no_entregado" ? 1 : 0;
}

function getDeliveryAttemptLabel(request, activeTab) {
  const failedAttemptCount = getFailedDeliveryAttemptCount(request);
  if (!failedAttemptCount) return "";

  const normalizedStatus = String(request?.status || "").trim().toLowerCase();
  if (["no_entregado", "recoger_en_sucursal"].includes(normalizedStatus)) {
    return failedAttemptCount === 1 ? "1 intento" : `${failedAttemptCount} intentos`;
  }

  const currentAttemptNumber = isCourierRouteStatus(normalizedStatus)
    ? Math.min(failedAttemptCount, 3)
    : Math.min(failedAttemptCount + 1, 3);
  if (currentAttemptNumber === 1 && isCourierRouteStatus(normalizedStatus)) return "";
  if (activeTab === "en_ruta") {
    if (currentAttemptNumber === 1) return "Primer intento";
    if (currentAttemptNumber === 2) return "Segundo intento";
    return "Tercer intento";
  }
  return currentAttemptNumber === 1 ? "1 intento" : `${currentAttemptNumber} intentos`;
}

function courierHistoryTimestampMs(request) {
  const courierHistoryAtMs = new Date(request?.courierHistoryAt || "").getTime();
  if (Number.isFinite(courierHistoryAtMs)) return courierHistoryAtMs;
  if (String(request?.courierLabel || "").trim().toLowerCase() === "entrega") return 0;
  const updatedAtMs = new Date(request?.updatedAt || "").getTime();
  if (Number.isFinite(updatedAtMs)) return updatedAtMs;
  return courierOrderTimestampMs(request);
}

function courierMexicoDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function isCourierHistoryFromToday(request) {
  const historyTimestamp = courierHistoryTimestampMs(request);
  if (!historyTimestamp) return false;
  return courierMexicoDateKey(historyTimestamp) === courierMexicoDateKey(new Date());
}

function isCourierScheduledTodayOrLater(request) {
  const scheduledDate = new Date(request?.pickupDate || request?.createdAt || "");
  if (Number.isNaN(scheduledDate.getTime())) return true;
  return courierMexicoDateKey(scheduledDate) >= courierMexicoDateKey(new Date());
}

function getReturnFailedAttemptCount(request) {
  const normalizedStatus = String(request?.status || "").trim().toLowerCase();
  const match = normalizedStatus.match(/^intento_fallido_(\d+)$/);
  if (match) return Math.max(1, Number(match[1]) || 1);
  return normalizedStatus === "rechazada" ? Math.max(3, Number(request?.attemptCount || 0)) : 0;
}

function getReturnFailedAttemptLabel(request) {
  const failedAttemptCount = getReturnFailedAttemptCount(request);
  if (!failedAttemptCount) return "";
  return failedAttemptCount === 1 ? "1 intento" : `${failedAttemptCount} intentos`;
}

function getReturnRetryAttemptLabel(request) {
  const normalizedStatus = String(request?.status || "").trim().toLowerCase();
  if (normalizedStatus !== "reintento_pendiente" && !normalizedStatus.startsWith("en_ruta_")) return "";
  const routeAttemptMatch = normalizedStatus.match(/^en_ruta_(\d+)$/);
  const routeAttemptNumber = routeAttemptMatch ? Number(routeAttemptMatch[1]) || 1 : 0;
  const nextAttemptNumber = Math.min(Math.max(Number(request?.attemptCount || 0) + 1, 1), 3);
  const attemptNumber = routeAttemptNumber || nextAttemptNumber;
  if (attemptNumber === 1) return "primer intento";
  if (attemptNumber === 2) return "segundo intento";
  return "tercer intento";
}

async function fetchNextPendingCourierOrder({ shop, sessionCandidates, allSessionCandidates, excludeRequestId }) {
  if (!shop || !sessionCandidates?.length) return null;

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

  for (const shopCandidate of shopCandidates) {
    const candidateSessions = sessionCandidatesByShop.get(shopCandidate) || [];
    if (!candidateSessions.length) continue;

    const [deliveryResult, pickupResult] = await Promise.allSettled([
      fetchCourierOrdersForShop({ shop: shopCandidate, sessionCandidates: candidateSessions }),
      fetchPickupCourierOrders(shopCandidate),
    ]);

    const deliveryOrders = deliveryResult.status === "fulfilled" ? deliveryResult.value : [];
    const pickupOrders = pickupResult.status === "fulfilled" ? pickupResult.value : [];
    const pendingOrder = [...deliveryOrders, ...pickupOrders]
      .sort((a, b) => courierOrderTimestampMs(a) - courierOrderTimestampMs(b))
      .find((requestRow) => {
        const requestRowId = String(requestRow?.id || "").trim();
        return (
          requestRowId &&
          requestRowId !== excludeRequestId &&
          !isCourierRouteTabStatus(requestRow?.status) &&
          !isCourierHistoryStatus(requestRow?.status)
        );
      });

    if (pendingOrder) {
      return { shop: shopCandidate, order: pendingOrder };
    }
  }

  return null;
}

export const action = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const formData = await request.formData();
    const formShop = String(formData.get("shop") || "").trim().toLowerCase();
    const portalShop = await resolveCourierPortalShop(request);
    const shop = formShop || portalShop.shop;
    const intent = String(formData.get("intent") || "").trim();
    const requestId = String(formData.get("requestId") || "").trim();

    if (
      ![
        "courier_mark_en_route",
        "courier_mark_not_delivered",
        "courier_mark_delivered",
        "courier_retry_delivery",
        "courier_return_mark_received",
        "courier_return_pickup_attempt_failed",
        "courier_return_retry_pickup",
        "courier_return_reject_after_failed_pickups",
      ].includes(intent) ||
      !requestId
    ) {
      return { ok: false, error: "Accion no valida." };
    }

    const actionHandler =
      intent === "courier_mark_delivered"
        ? markCourierOrderAsDelivered
        : intent === "courier_return_mark_received"
          ? markCourierReturnAsReceived
        : intent === "courier_return_retry_pickup"
          ? markCourierReturnForRetry
        : intent === "courier_return_pickup_attempt_failed"
          ? markCourierReturnPickupAttemptFailed
        : intent === "courier_return_reject_after_failed_pickups"
          ? rejectCourierReturnAfterFailedPickups
        : intent === "courier_mark_not_delivered"
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
      rejectionReason: String(formData.get("rejectionReason") || "").trim(),
    });
    if (!result.ok) {
      return result;
    }

    if (shop) {
      url.searchParams.set("shop", shop);
    }

    let nextOverrideRequestId = requestId;
    let nextOverrideStatus = String(
      result?.nextStatus ||
        (intent === "courier_mark_delivered"
          ? "entregado"
          : intent === "courier_mark_not_delivered"
            ? "no_entregado"
            : intent === "courier_retry_delivery"
              ? "reintento_pendiente"
              : "en_ruta"),
    );
    let nextOverrideAttemptCount = String(result?.attemptCount || formData.get("currentAttemptCount") || "0");
    const nextTab =
      intent === "courier_return_mark_received" ||
      intent === "courier_return_pickup_attempt_failed" ||
      intent === "courier_return_reject_after_failed_pickups"
        ? "historial"
        : "en_ruta";

    if (intent === "courier_mark_not_delivered" || intent === "courier_mark_delivered") {
      const nextPending = await fetchNextPendingCourierOrder({
        shop,
        sessionCandidates: portalShop.sessionCandidates,
        allSessionCandidates: portalShop.allSessionCandidates,
        excludeRequestId: requestId,
      });

      if (nextPending?.order) {
        const nextRouteResult = await markCourierOrderAsEnRoute({
          shopDomain: nextPending.shop,
          requestId: String(nextPending.order.id || ""),
          orderNumber: String(nextPending.order.orderNumber || ""),
          customerName: String(nextPending.order.customerName || ""),
          customerEmail: String(nextPending.order.customerEmail || ""),
          customerPhone: String(nextPending.order.customerPhone || ""),
          currentStatus: String(nextPending.order.status || ""),
          currentAttemptCount: String(nextPending.order.attemptCount || 0),
        });

        if (nextRouteResult?.ok) {
          nextOverrideRequestId = String(nextPending.order.id || "");
          nextOverrideStatus = String(nextRouteResult.nextStatus || "en_ruta");
          nextOverrideAttemptCount = String(nextRouteResult.attemptCount || nextPending.order.attemptCount || 1);
          if (nextPending.shop) {
            url.searchParams.set("shop", nextPending.shop);
          }
        }
      }
    }

    url.searchParams.set("tab", nextTab);
    url.searchParams.set("overrideRequestId", nextOverrideRequestId);
    url.searchParams.set("overrideStatus", nextOverrideStatus);
    url.searchParams.set("overrideAttemptCount", nextOverrideAttemptCount);
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
  const overrideRequestId = String(url.searchParams.get("overrideRequestId") || "").trim();
  const overrideStatus = String(url.searchParams.get("overrideStatus") || "").trim().toLowerCase();
  const overrideAttemptCount = Math.max(0, Number(url.searchParams.get("overrideAttemptCount") || "0"));

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

  const overrideTargetOrder = courierOrders.find((requestRow) => String(requestRow?.id || "").trim() === overrideRequestId);
  if (
    overrideRequestId &&
    !overrideRequestId.startsWith("pickup-") &&
    overrideStatus === "no_entregado" &&
    overrideAttemptCount >= 3 &&
    String(overrideTargetOrder?.status || "").trim().toLowerCase() !== "recoger_en_sucursal"
  ) {
    await markCourierOrderReadyForBranchPickup({
      shopDomain: resolvedShop,
      requestId: overrideRequestId,
      orderNumber: overrideTargetOrder?.orderNumber || "",
    });
    courierOrders = courierOrders.map((requestRow) =>
      String(requestRow?.id || "").trim() === overrideRequestId
        ? {
            ...requestRow,
            status: "recoger_en_sucursal",
            attemptCount: Math.max(overrideAttemptCount, Number(requestRow?.attemptCount || 0), 3),
          }
        : requestRow,
    );
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
  const [failedPickupRequest, setFailedPickupRequest] = useState(null);
  const overrideRequestId = String(searchParams.get("overrideRequestId") || "").trim();
  const overrideStatus = String(searchParams.get("overrideStatus") || "").trim().toLowerCase();
  const overrideAttemptCount = Math.max(0, Number(searchParams.get("overrideAttemptCount") || "0"));
  const effectiveCourierOrders = courierOrders.map((request) =>
    (() => {
      const isOverrideTarget = overrideRequestId && String(request?.id || "").trim() === overrideRequestId;
      const persistedStatus = String(request?.status || "").trim().toLowerCase();
      const hasFinalPersistedStatus = ["rechazada", "recibida", "reembolsada", "completada", "denegada"].includes(
        persistedStatus,
      );
      const canApplyOverride = isOverrideTarget && !hasFinalPersistedStatus;
      const attemptCount = canApplyOverride
        ? overrideAttemptCount || Number(request?.attemptCount || 0)
        : Number(request?.attemptCount || 0);
      const status = canApplyOverride ? overrideStatus || request?.status || "pendiente" : request?.status;
      return {
        ...request,
        status: status === "no_entregado" && attemptCount >= 3 ? "recoger_en_sucursal" : status,
        attemptCount,
      };
    })(),
  );
  const historyOrders = effectiveCourierOrders
    .filter((request) => isCourierHistoryStatus(request?.status) && isCourierHistoryFromToday(request))
    .sort((firstRequest, secondRequest) => courierHistoryTimestampMs(secondRequest) - courierHistoryTimestampMs(firstRequest));
  const routeOrders = effectiveCourierOrders.filter(
    (request) => isCourierRouteTabStatus(request?.status) && isCourierScheduledTodayOrLater(request),
  );
  const pendingOrders = effectiveCourierOrders.filter(
    (request) => !isCourierRouteTabStatus(request?.status) && !isCourierHistoryStatus(request?.status),
  );
  const routeOrder = routeOrders[0] || null;
  const pendingPreviewOrder = pendingOrders[0] || null;
  const visibleOrders =
    activeTab === "en_ruta"
      ? routeOrder
        ? [routeOrder]
        : pendingPreviewOrder
          ? [pendingPreviewOrder]
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
  const isPickupReadyStatus = (request) => String(request?.status || "").trim().toLowerCase() === "recoger_en_sucursal";
  const isReturnRetryPendingStatus = (request) =>
    isReturnOrder(request) && String(request?.status || "").trim().toLowerCase() === "reintento_pendiente";
  const isReturnRetryRouteStatus = (request) =>
    isReturnOrder(request) && /^en_ruta_[23]$/.test(String(request?.status || "").trim().toLowerCase());
  const isReturnPickupFailedStatus = (request) =>
    ["intento_fallido_1", "intento_fallido_2", "intento_fallido_3"].includes(
      String(request?.status || "").trim().toLowerCase(),
    );
  const isReturnRejectedStatus = (request) =>
    isReturnOrder(request) && String(request?.status || "").trim().toLowerCase() === "rechazada";
  const canShowReturnResultActions = (request) =>
    isReturnOrder(request) &&
    activeTab === "en_ruta" &&
    isCourierRouteStatus(request?.status);
  const canShowDeliveryResultActions = (request) =>
    !isReturnOrder(request) &&
    activeTab === "en_ruta" &&
    isCourierRouteStatus(request?.status);
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

  const renderFailedPickupReasonForm = (request, rejectionReason, index) => {
    const failedPickupMessage = getFailedPickupMessage(request, rejectionReason);
    return (
      <Form
      method="post"
      onSubmit={(event) => {
        if (!confirmCourierAction(request, "intento de devolucion fallido", "Se enviara el mensaje seleccionado al cliente.")) {
          event.preventDefault();
          return;
        }
        setFailedPickupRequest(null);
      }}
    >
      <input type="hidden" name="shop" value={shop || ""} />
      <input
        type="hidden"
        name="intent"
        value={String(request.status || "").toLowerCase() === "en_ruta_3"
          ? "courier_return_reject_after_failed_pickups"
          : "courier_return_pickup_attempt_failed"}
      />
      <input type="hidden" name="requestId" value={String(request.id || "")} />
      <input type="hidden" name="orderNumber" value={String(request.orderNumber || "")} />
      <input type="hidden" name="customerName" value={String(request.customerName || "")} />
      <input type="hidden" name="customerEmail" value={String(request.customerEmail || "")} />
      <input type="hidden" name="customerPhone" value={String(request.customerPhone || "")} />
      <input type="hidden" name="currentStatus" value={String(request.status || "")} />
      <input type="hidden" name="currentAttemptCount" value={String(request.attemptCount || 0)} />
        <input type="hidden" name="rejectionReason" value={failedPickupMessage} />
        <button type="submit" className={styles.reasonOptionButton}>
          <span className={styles.reasonOptionLabel}>Mensaje automatico {index + 1}</span>
          <span className={styles.reasonOptionText}>{failedPickupMessage}</span>
        </button>
      </Form>
    );
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
                      {!isReturnOrder(request) && getDeliveryAttemptLabel(request, activeTab) ? (
                        <span className={`${adminStyles.courierBadgeStatus} ${styles.statusBadgeFailed}`}>
                          {getDeliveryAttemptLabel(request, activeTab)}
                        </span>
                      ) : null}
                      {isReturnOrder(request) && isReturnPickupFailedStatus(request) ? (
                        <>
                          <span className={`${adminStyles.courierBadgeStatus} ${styles.statusBadgeAttempt}`}>
                            {getReturnFailedAttemptLabel(request)}
                          </span>
                          <span className={`${adminStyles.courierBadgeStatus} ${styles.statusBadgeFailed}`}>
                            no recibido
                          </span>
                        </>
                      ) : isReturnRejectedStatus(request) ? (
                        <>
                          <span className={`${adminStyles.courierBadgeStatus} ${styles.statusBadgeAttempt}`}>
                            3 intentos
                          </span>
                          <span className={`${adminStyles.courierBadgeStatus} ${styles.statusBadgeFailed}`}>
                            rechazada
                          </span>
                        </>
                      ) : (
                        <>
                          {isReturnOrder(request) &&
                          String(request.status || "").trim().toLowerCase() === "recibida" &&
                          Number(request.attemptCount || 0) >= 2 ? (
                            <span className={`${adminStyles.courierBadgeStatus} ${styles.statusBadgeAttempt}`}>
                              {`${Number(request.attemptCount)} intentos`}
                            </span>
                          ) : null}
                          {isReturnRetryPendingStatus(request) || isReturnRetryRouteStatus(request) ? (
                            <span className={`${adminStyles.courierBadgeStatus} ${styles.statusBadgeAttempt}`}>
                              {getReturnRetryAttemptLabel(request)}
                            </span>
                          ) : null}
                          <span
                            className={`${adminStyles.courierBadgeStatus} ${
                              isCourierRouteStatus(request.status)
                                ? styles.statusBadgeRoute
                                : ["recibida", "entregado"].includes(
                                    String(request.status || "").trim().toLowerCase(),
                                  )
                                  ? styles.statusBadgeReceived
                                : isPickupReadyStatus(request)
                                  ? styles.statusBadgeAttempt
                                : isNotDeliveredStatus(request)
                                  ? styles.statusBadgeFailed
                                  : ""
                            }`}
                        >
                            {activeTab === "pedidos" ||
                            (activeTab === "en_ruta" && !isCourierRouteStatus(request.status))
                              ? "pendiente"
                              : getCourierStatusLabel(request.status)}
                          </span>
                        </>
                      )}
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
                  {activeTab === "historial" &&
                  isReturnOrder(request) &&
                  isReturnPickupFailedStatus(request) &&
                  String(request.status || "").toLowerCase() !== "intento_fallido_3" ? (
                    <div className={styles.historyActionRow}>
                      {renderCourierActionForm(
                        request,
                        "Reintentar",
                        "courier_return_retry_pickup",
                        "reintentar devolucion",
                        `${styles.actionButton} ${styles.actionButtonRetry}`,
                        "Esta accion devolvera la devolucion a En ruta como pendiente para que despues puedas marcarla en ruta manualmente.",
                      )}
                    </div>
                  ) : null}
                  {activeTab === "historial" &&
                  isReturnOrder(request) &&
                  String(request.status || "").toLowerCase() === "intento_fallido_3" ? (
                    <div className={styles.historyActionRow}>
                      {renderCourierActionForm(
                        request,
                        "Rechazar devolucion",
                        "courier_return_reject_after_failed_pickups",
                        "rechazada",
                        `${styles.actionButton} ${styles.actionButtonDanger}`,
                        "Esta accion rechazara definitivamente la devolucion y notificara al cliente.",
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
                          {canShowReturnResultActions(request) ? (
                            <>
                              {renderCourierActionForm(
                                request,
                                "Recibido",
                                "courier_return_mark_received",
                                "recibido",
                              )}
                              <button
                                type="button"
                                className={`${styles.actionButton} ${styles.actionButtonDanger}`}
                                onClick={() => setFailedPickupRequest(request)}
                              >
                                No recibido
                              </button>
                            </>
                          ) : null}
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
                              {renderCourierActionForm(request, "Entregado", "courier_mark_delivered", "entregado")}
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
      {failedPickupRequest ? (
        <div className={styles.modalBackdrop} role="presentation" onClick={() => setFailedPickupRequest(null)}>
          <section
            className={styles.reasonModal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="failed-pickup-reason-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="failed-pickup-reason-title" className={styles.reasonModalTitle}>
              Selecciona un mensaje completo
            </h2>
            <div className={styles.reasonOptionList}>
              {(String(failedPickupRequest.status || "").toLowerCase() === "en_ruta_3"
                ? [FINAL_PICKUP_REJECTION_REASON]
                : PICKUP_FAILED_REASON_OPTIONS
              ).map((option, index) => (
                <div key={option}>{renderFailedPickupReasonForm(failedPickupRequest, option, index)}</div>
              ))}
            </div>
            <div className={styles.reasonModalActions}>
              <button type="button" className={styles.actionButton} onClick={() => setFailedPickupRequest(null)}>
                Cerrar
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
