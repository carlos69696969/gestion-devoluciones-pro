import prisma from "../db.server";
import {
  dedupeCourierRequestsByOrderNumber,
  courierOrderTimestampMs,
  getCourierDeliveryAttemptCountFromTags,
  getCourierRouteStatusFromTags,
} from "./courier.shared";

const ADMIN_API_VERSION = "2025-10";
export const METHOD_QUEUE_STATUSES = new Set([
  "aprobada",
  "en_ruta",
  "en_ruta_1",
  "en_ruta_2",
  "en_ruta_3",
  "intento_fallido_1",
  "intento_fallido_2",
  "no_recibido",
]);
const BRANCH_PICKUP_STATUSES = new Set([
  "por_devolver",
  "no_devuelto",
  "reembolso_denegado",
  "denegada",
]);
const NOTIFICATIONS_API_BASE_URL = String(
  process.env.NOTIFICATIONS_API_URL || "https://centro-de-notificaciones-cariana.onrender.com",
).replace(/\/+$/, "");
const NOTIFICATIONS_API_KEY = String(
  process.env.NOTIFICATIONS_API_KEY || process.env.APP_INTERNAL_API_KEY || "",
).trim();
const STATUS_RECEIVED_KIND = "status_received";
const PICKUP_FAILED_REASON_FIRST =
  "No logramos completar la recoleccion. Visitamos tu domicilio, pero no obtuvimos respuesta. Nuestro equipo volvera a intentarlo.";
const PICKUP_FAILED_REASON_SECOND =
  "Recoleccion reagendada. Nos comunicamos contigo y acordamos realizar un nuevo intento, ya que no te encontrabas en el domicilio indicado.";
const RETURN_EVENT_BY_INTENT = {
  courier_return_mark_received: "return_picked_up",
  courier_return_pickup_attempt_failed: "return_pickup_scheduled",
  courier_return_reject_after_failed_pickups: "return_rejected",
};

function normalizeShop(value) {
  return String(value || "").trim().toLowerCase();
}

function returnItemKey(item) {
  const lineItemId = String(item?.lineItemId || "").trim();
  if (lineItemId) return `line:${lineItemId}`;
  const variantId = String(item?.variantId || "").trim();
  if (variantId) return `variant:${variantId}`;
  const productId = String(item?.productId || "").trim();
  if (productId) return `product:${productId}`;
  return `title:${String(item?.title || "").trim().toLowerCase()}`;
}

function returnRequestItemsSignature(requestRow) {
  const itemParts = (requestRow?.items || [])
    .map((item) => `${returnItemKey(item)}:${Math.max(1, Number(item?.quantity || 1))}`)
    .sort();
  if (!itemParts.length) return `request:${requestRow?.id || ""}`;
  const orderReference =
    String(requestRow?.shopifyOrderId || "").trim() ||
    String(requestRow?.orderNumber || "").trim();
  return `${orderReference}|${itemParts.join(",")}`;
}

function returnRequestOrderReferences(requestRow) {
  const references = new Set();
  const shopifyOrderId = String(requestRow?.shopifyOrderId || "").trim();
  const orderNumber = String(requestRow?.orderNumber || "").replace(/^#/, "").trim();
  const shopifyOrderNumericId = shopifyOrderId.match(/(\d+)$/)?.[1] || "";

  if (shopifyOrderId) references.add(`shopify:${shopifyOrderId}`);
  if (shopifyOrderNumericId) references.add(`shopify-numeric:${shopifyOrderNumericId}`);
  if (orderNumber) references.add(`order-number:${orderNumber}`);

  return Array.from(references);
}

function requestWasCreatedAfter(candidate, reference) {
  const candidateCreatedAt = new Date(candidate?.createdAt || 0).getTime();
  const referenceCreatedAt = new Date(reference?.createdAt || 0).getTime();
  if (candidateCreatedAt !== referenceCreatedAt) {
    return candidateCreatedAt > referenceCreatedAt;
  }
  return Number(candidate?.id || 0) > Number(reference?.id || 0);
}

function excludePickupRequestsSupersededByBranch(requestRows) {
  const rows = Array.isArray(requestRows) ? requestRows : [];
  const latestBranchRequestBySignature = new Map();
  const branchPickupOrderReferences = new Set();

  for (const requestRow of rows) {
    const returnMethod = String(requestRow?.returnMethod || "").trim().toLowerCase();
    const status = String(requestRow?.status || "").trim().toLowerCase();
    if (BRANCH_PICKUP_STATUSES.has(status)) {
      for (const orderReference of returnRequestOrderReferences(requestRow)) {
        branchPickupOrderReferences.add(orderReference);
      }
    }
    if (returnMethod !== "pickup") {
      const signature = returnRequestItemsSignature(requestRow);
      const current = latestBranchRequestBySignature.get(signature);
      if (!current || requestWasCreatedAfter(requestRow, current)) {
        latestBranchRequestBySignature.set(signature, requestRow);
      }
    }
  }

  return rows.filter((requestRow) => {
    if (String(requestRow?.returnMethod || "").trim().toLowerCase() !== "pickup") return false;
    if (BRANCH_PICKUP_STATUSES.has(String(requestRow?.status || "").trim().toLowerCase())) return false;
    if (
      returnRequestOrderReferences(requestRow).some((orderReference) =>
        branchPickupOrderReferences.has(orderReference),
      )
    ) {
      return false;
    }
    const branchRequest = latestBranchRequestBySignature.get(returnRequestItemsSignature(requestRow));
    return !branchRequest || !requestWasCreatedAfter(branchRequest, requestRow);
  });
}

function normalizeDeliveryAttemptCount(value, fallback = 0) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 0), 3);
}

async function getReturnBranchDetails(shopDomain) {
  const shop = normalizeShop(shopDomain);
  if (!shop) {
    return {
      branchAddress: "",
      branchHours: "",
    };
  }

  const settings = await prisma.returnSettings.findUnique({
    where: { shop },
    select: { branchAddress: true, branchHours: true },
  });

  return {
    branchAddress: String(settings?.branchAddress || "").trim(),
    branchHours: String(settings?.branchHours || "").trim(),
  };
}

function parseReasonEntries(rawValue) {
  const text = String(rawValue || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed?.entries)) return parsed.entries.filter(Boolean);
  } catch {
    return [{ kind: "legacy", reason: text, at: "" }];
  }
  return [{ kind: "legacy", reason: text, at: "" }];
}

function appendReasonEntry(rawValue, entry) {
  const entries = parseReasonEntries(rawValue);
  entries.push({
    kind: String(entry?.kind || "legacy"),
    reason: String(entry?.reason || "").trim(),
    at: new Date().toISOString(),
  });
  return JSON.stringify({ entries });
}

function appendTimelineMetaEntry(rawValue, entry) {
  const kind = String(entry?.kind || "").trim().toLowerCase();
  if (!kind) return rawValue || "";
  const entries = parseReasonEntries(rawValue);
  if (entries.some((item) => String(item?.kind || "").toLowerCase() === kind)) {
    return JSON.stringify({ entries });
  }
  entries.push({
    kind,
    reason: String(entry?.reason || "").trim(),
    at: new Date().toISOString(),
  });
  return JSON.stringify({ entries });
}

function getReturnFailedAttemptCount(rawValue) {
  return parseReasonEntries(rawValue).reduce((maxAttempt, entry) => {
    const match = String(entry?.kind || "").toLowerCase().match(/^attempt_failed_(\d)$/);
    return match ? Math.max(maxAttempt, Number(match[1]) || 0) : maxAttempt;
  }, 0);
}

function getNextPickupDate(rawValue) {
  const match = String(rawValue || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  const date = match
    ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    : new Date();
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function formatPickupDateForMessage(rawValue) {
  const match = String(rawValue || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return String(rawValue || "").trim();
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat("es-MX", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function getDeliveryAttemptTag(attemptCount) {
  const safeAttemptCount = Math.min(Math.max(Number(attemptCount || 0), 1), 3);
  return `intento entrega ${safeAttemptCount}`;
}

async function recordCourierDeliveryEvent({
  shopDomain,
  requestId,
  orderNumber,
  status,
  attemptCount,
  note = "",
}) {
  const shop = normalizeShop(shopDomain);
  const cleanRequestId = String(requestId || "").trim();
  const cleanStatus = String(status || "").trim().toLowerCase();
  if (!shop || !cleanRequestId || !cleanStatus || cleanRequestId.startsWith("pickup-")) return;

  try {
    await prisma.courierEvent.create({
      data: {
        shop,
        requestId: cleanRequestId,
        orderNumber: String(orderNumber || "").trim() || null,
        status: cleanStatus,
        attempt: Math.max(0, Number(attemptCount || 0)) || null,
        note: String(note || "").trim() || null,
      },
    });
  } catch (error) {
    console.error("Courier event history is not available yet", error);
  }
}

async function getMaxCourierDeliveryAttemptFromEvents({
  shopDomain,
  requestId,
  orderNumber,
  statuses = [],
}) {
  const shop = normalizeShop(shopDomain);
  const cleanRequestId = String(requestId || "").trim();
  const cleanOrderNumber = String(orderNumber || "").replace(/^#/, "").trim();
  const cleanStatuses = (Array.isArray(statuses) ? statuses : [])
    .map((status) => String(status || "").trim().toLowerCase())
    .filter(Boolean);

  if (!shop || (!cleanRequestId && !cleanOrderNumber)) return 0;

  const references = [];
  if (cleanRequestId) references.push({ requestId: cleanRequestId });
  if (cleanOrderNumber) references.push({ orderNumber: cleanOrderNumber });

  const where = {
    shop,
    OR: references,
  };
  if (cleanStatuses.length) {
    where.status = { in: cleanStatuses };
  }

  try {
    const events = await prisma.courierEvent.findMany({
      where,
      select: { attempt: true },
    });

    return events.reduce((maxAttempt, event) => {
      const attempt = Math.max(0, Number(event?.attempt || 0) || 0);
      return Math.max(maxAttempt, attempt);
    }, 0);
  } catch (error) {
    console.error("Courier event attempts are not available yet", error);
    return 0;
  }
}

async function getMaxCourierFailedDeliveryAttempt({ shopDomain, requestId, orderNumber }) {
  return getMaxCourierDeliveryAttemptFromEvents({
    shopDomain,
    requestId,
    orderNumber,
    statuses: ["no_entregado", "recoger_en_sucursal"],
  });
}

const COURIER_STATUS_TAGS = [
  "en ruta",
  "en ruta 2",
  "en ruta 3",
  "no entregado",
  "recoger en sucursal",
  "entregado",
  "reintentar entrega",
  "intento entrega 1",
  "intento entrega 2",
  "intento entrega 3",
];

function normalizeCourierTag(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

function getCourierRouteTag(step) {
  const safeStep = Math.min(Math.max(Number(step || 0), 1), 3);
  return safeStep === 1 ? "en ruta" : `en ruta ${safeStep}`;
}

function getPreferredCourierStatusTag(tags) {
  const normalizedTags = new Set((Array.isArray(tags) ? tags : []).map(normalizeCourierTag));
  if (normalizedTags.has("entregado")) return "entregado";
  if (normalizedTags.has("recoger en sucursal")) return "recoger en sucursal";
  const attemptCount = Math.max(0, Number(getCourierDeliveryAttemptCountFromTags(tags) || 0));
  if (normalizedTags.has("no entregado")) return attemptCount >= 3 ? "recoger en sucursal" : "no entregado";
  if (normalizedTags.has("en ruta 3")) return "en ruta 3";
  if (normalizedTags.has("en ruta 2")) return "en ruta 2";
  if (normalizedTags.has("en ruta")) return "en ruta";

  if (attemptCount >= 3) return "en ruta 3";
  if (attemptCount === 2) return "en ruta 2";
  if (attemptCount === 1) return "en ruta";
  if (normalizedTags.has("reintentar entrega")) return "en ruta";
  return null;
}

async function normalizeCourierOrderTags({ shopDomain, shopifyOrderId, tags }) {
  const preferredTag = getPreferredCourierStatusTag(tags);
  if (!preferredTag) return;

  const currentCourierTags = Array.from(
    new Set((Array.isArray(tags) ? tags : []).map(normalizeCourierTag).filter((tag) => COURIER_STATUS_TAGS.includes(tag))),
  );

  if (!currentCourierTags.length) return;

  const needsNormalization =
    currentCourierTags.length > 1 ||
    currentCourierTags.some((tag) => tag !== preferredTag) ||
    currentCourierTags.some((tag) => tag.startsWith("intento entrega")) ||
    currentCourierTags.includes("reintentar entrega");

  if (!needsNormalization) return;

  await syncShopifyOrderTags({
    shopDomain,
    shopifyOrderId,
    addTags: [preferredTag],
    removeTags: currentCourierTags.filter((tag) => tag !== preferredTag),
  });
}

async function replaceCourierOrderStatusTag({ shopDomain, shopifyOrderId, statusTag }) {
  const cleanStatusTag = String(statusTag || "").trim();
  if (!shopDomain || !shopifyOrderId || !cleanStatusTag) return;

  await syncShopifyOrderTags({
    shopDomain,
    shopifyOrderId,
    addTags: [cleanStatusTag],
    removeTags: COURIER_STATUS_TAGS.filter((tag) => tag !== cleanStatusTag),
  });
}

async function resolveCourierShopSessions(shopDomain) {
  const shop = normalizeShop(shopDomain);
  if (!shop) return [];

  const sessions = await prisma.session.findMany({
    where: { shop },
    select: { id: true, shop: true, isOnline: true, accessToken: true },
  });

  const candidates = sessions
    .map((session) => ({
      id: String(session.id || "").trim(),
      shop: String(session.shop || "").trim().toLowerCase(),
      isOnline: Boolean(session.isOnline),
      accessToken: String(session.accessToken || "").trim(),
    }))
    .filter((session) => session.shop && session.accessToken);

  candidates.sort((a, b) => {
    const aOffline = a.isOnline === false ? 0 : 1;
    const bOffline = b.isOnline === false ? 0 : 1;
    if (aOffline !== bOffline) return aOffline - bOffline;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });

  return candidates;
}

async function resolveCourierShopSession(shopDomain) {
  const sessions = await resolveCourierShopSessions(shopDomain);
  return sessions[0] || null;
}
function getCourierCustomAttribute(orderNode, keys) {
  const attributes = Array.isArray(orderNode?.customAttributes) ? orderNode.customAttributes : [];
  const normalizedKeys = keys.map((key) => String(key || "").trim().toLowerCase());
  const match = attributes.find((attribute) => {
    const key = String(attribute?.key || "").trim().toLowerCase();
    return normalizedKeys.includes(key);
  });
  return String(match?.value || "").trim();
}

function getCourierScheduledDate(orderNode) {
  return getCourierCustomAttribute(orderNode, [
    "programado",
    "pickupDate",
    "pickup_date",
    "delivery_date",
    "deliveryDate",
    "scheduled_date",
    "scheduledDate",
    "preferred_delivery_date",
  ]);
}

export function isCourierLocalDeliveryOrder(orderNode) {
  const shippingLines = Array.isArray(orderNode?.shippingLines?.nodes) ? orderNode.shippingLines.nodes : [];
  return shippingLines.some((line) => {
    const title = String(line?.title || "").toLowerCase();
    const code = String(line?.code || "").toLowerCase();
    const category = String(line?.deliveryCategory || "").toLowerCase();
    return title.includes("local") || code.includes("local") || category.includes("local");
  });
}

export function isCourierRouteStatus(status) {
  return String(status || "")
    .trim()
    .toLowerCase()
    .startsWith("en_ruta");
}

function getCourierRouteStep(status) {
  const match = String(status || "")
    .trim()
    .toLowerCase()
    .match(/^en_ruta_(\d)$/);
  return match ? Number(match[1]) : 0;
}

export function getCourierRouteStatusLabel(status) {
  return isCourierRouteStatus(status) ? "en ruta" : String(status || "pendiente").replace(/_/g, " ");
}

export function getCourierNextRouteStatus(status) {
  const currentStep = getCourierRouteStep(status);
  if (!currentStep) return "en_ruta_1";
  if (currentStep >= 3) return "en_ruta_3";
  return `en_ruta_${currentStep + 1}`;
}

export async function emitCourierReturnRouteNotification({ shopDomain, requestRow, routeStep = 1 }) {
  if (!shopDomain || !requestRow || !NOTIFICATIONS_API_BASE_URL) {
    return { ok: false, error: "No se pudo preparar la notificacion." };
  }

  const title = "\u{1F69A} \u00a1Vamos en camino!";
  const message = `Tu pedido #${requestRow.orderNumber}. Nuestro repartidor ya se dirige a tu domicilio para recoger tu devoluci\u00f3n. \u{1F4E6} Ten tu paquete listo y correctamente sellado. \u{1F4DD} No olvides colocar tu n\u00famero de pedido y nombre del comprador en el exterior del paquete.`;
  const eventPayload = {
    status: "order_in_transit",
    event: "order_in_transit",
    action: "courier_mark_en_route",
    title,
    message,
    note: message,
    source: "portal_repartidor",
    order_number: requestRow.orderNumber || null,
    return_id: requestRow.id || null,
    email: requestRow.customerEmail || null,
    customer_email: requestRow.customerEmail || null,
    customer: {
      email: requestRow.customerEmail || null,
      name: requestRow.customerName || null,
      phone: requestRow.customerPhone || null,
    },
    return_method: requestRow.returnMethod || null,
    courier_label: "Devolucion",
    route_step: routeStep,
  };

  const endpoints = NOTIFICATIONS_API_KEY
    ? [
        `${NOTIFICATIONS_API_BASE_URL}/api/returns/events`,
        `${NOTIFICATIONS_API_BASE_URL}/proxy/returns/events`,
      ]
    : [`${NOTIFICATIONS_API_BASE_URL}/proxy/returns/events`];

  let lastFailure = null;
  for (const endpoint of endpoints) {
    const headers = {
      "Content-Type": "application/json",
      "x-shop-domain": shopDomain,
    };
    if (NOTIFICATIONS_API_KEY) {
      headers["x-api-key"] = NOTIFICATIONS_API_KEY;
    }

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          shopDomain,
          event: eventPayload,
        }),
      });

      const responsePayload = await response.json().catch(() => null);
      if (response.ok && !responsePayload?.result?.skipped) {
        return { ok: true };
      }

      lastFailure = {
        endpoint,
        status: response.status,
        detail: String(
          responsePayload?.result?.reason ||
            responsePayload?.error ||
            "El centro de notificaciones omitio el evento.",
        ).slice(0, 300),
      };
    } catch (error) {
      lastFailure = {
        endpoint,
        error: String(error?.message || error || "unknown"),
      };
    }
  }

  console.error("Failed to emit courier route notification", {
    shopDomain,
    ...lastFailure,
  });
  return {
    ok: false,
    error: lastFailure?.detail || lastFailure?.error || "No se pudo enviar la notificacion.",
  };
}

async function emitCourierReturnActionNotification({ shopDomain, requestRow, intent, note = "" }) {
  if (!shopDomain || !requestRow || !NOTIFICATIONS_API_BASE_URL) {
    return { ok: true };
  }

  const mappedStatus = RETURN_EVENT_BY_INTENT[intent];
  if (!mappedStatus) return { ok: true };

  const eventPayload = {
    status: mappedStatus,
    event: mappedStatus,
    action: intent,
    return_reference: requestRow.orderNumber || (requestRow.id ? `DEV-${requestRow.id}` : ""),
    return_id: requestRow.id || null,
    order_number: requestRow.orderNumber || null,
    email: requestRow.customerEmail || null,
    customer_email: requestRow.customerEmail || null,
    customer: {
      email: requestRow.customerEmail || null,
      name: requestRow.customerName || null,
      phone: requestRow.customerPhone || null,
    },
    note: note || "",
    source: "portal_repartidor",
    return_method: requestRow.returnMethod || null,
    courier_label: "Devolucion",
  };

  const endpoints = NOTIFICATIONS_API_KEY
    ? [
        `${NOTIFICATIONS_API_BASE_URL}/api/returns/events`,
        `${NOTIFICATIONS_API_BASE_URL}/proxy/returns/events`,
      ]
    : [`${NOTIFICATIONS_API_BASE_URL}/proxy/returns/events`];

  let lastFailure = null;
  for (const endpoint of endpoints) {
    const headers = {
      "Content-Type": "application/json",
      "x-shop-domain": shopDomain,
    };
    if (NOTIFICATIONS_API_KEY) {
      headers["x-api-key"] = NOTIFICATIONS_API_KEY;
    }

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          shopDomain,
          event: eventPayload,
        }),
      });

      const responsePayload = await response.json().catch(() => null);
      if (response.ok && !responsePayload?.result?.skipped) {
        return { ok: true };
      }

      lastFailure = {
        endpoint,
        status: response.status,
        detail: String(
          responsePayload?.result?.reason ||
            responsePayload?.error ||
            "El centro de notificaciones omitio el evento.",
        ).slice(0, 300),
      };
    } catch (error) {
      lastFailure = {
        endpoint,
        error: String(error?.message || error || "unknown"),
      };
    }
  }

  console.error("Failed to emit courier return action notification", {
    shopDomain,
    intent,
    ...lastFailure,
  });
  return {
    ok: false,
    error: lastFailure?.detail || lastFailure?.error || "No se pudo enviar la notificacion.",
  };
}

async function mutateShopifyOrderTags({ shopDomain, orderId, session, mutationName, tags, fallbackError }) {
  const cleanTags = (Array.isArray(tags) ? tags : []).map((tag) => String(tag || "").trim()).filter(Boolean);
  if (!cleanTags.length) {
    return;
  }

  const response = await fetch(`https://${shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": session.accessToken,
    },
    body: JSON.stringify({
      query: `#graphql
        mutation SyncCourierOrderTags($id: ID!, $tags: [String!]!) {
          ${mutationName}(id: $id, tags: $tags) {
            node { id }
            userErrors { field message }
          }
        }`,
      variables: {
        id: orderId,
        tags: cleanTags,
      },
    }),
  });

  const payload = await response.json().catch(() => ({}));
  const topErrors = payload?.errors || [];
  const userErrors = payload?.data?.[mutationName]?.userErrors || [];
  if (!response.ok || topErrors.length || userErrors.length) {
    throw new Error(topErrors[0]?.message || userErrors[0]?.message || fallbackError);
  }
}

async function syncShopifyOrderTags({ shopDomain, shopifyOrderId, addTags = [], removeTags = [] }) {
  const orderId = String(shopifyOrderId || "").trim();
  const addList = (Array.isArray(addTags) ? addTags : []).map((tag) => String(tag || "").trim()).filter(Boolean);
  const removeList = (Array.isArray(removeTags) ? removeTags : []).map((tag) => String(tag || "").trim()).filter(Boolean);
  if (!shopDomain || !orderId || (!addList.length && !removeList.length)) return;

  const sessions = await resolveCourierShopSessions(shopDomain);
  if (!sessions.length) {
    throw new Error("No se encontro una sesion valida de Shopify para sincronizar la orden.");
  }

  let lastError = null;

  for (const session of sessions) {
    try {
      if (removeList.length) {
        await mutateShopifyOrderTags({
          shopDomain,
          orderId,
          session,
          mutationName: "tagsRemove",
          tags: removeList,
          fallbackError: `No se pudo quitar la etiqueta ${removeList[0]}.`,
        });
      }
      if (addList.length) {
        await mutateShopifyOrderTags({
          shopDomain,
          orderId,
          session,
          mutationName: "tagsAdd",
          tags: addList,
          fallbackError: `No se pudo agregar la etiqueta ${addList[0]}.`,
        });
      }
      return;
    } catch (error) {
      lastError = String(error?.message || error || "No se pudieron sincronizar las etiquetas de Shopify.");
    }
  }

  throw new Error(lastError || "No se pudieron sincronizar las etiquetas de Shopify.");
}

async function markShopifyOrderFulfillmentsAsDelivered({ shopDomain, shopifyOrderId }) {
  const orderId = String(shopifyOrderId || "").trim();
  if (!shopDomain || !orderId) {
    throw new Error("No se pudo identificar la orden para marcarla como entregada.");
  }

  const sessions = await resolveCourierShopSessions(shopDomain);
  if (!sessions.length) {
    throw new Error("No se encontro una sesion valida de Shopify para completar la entrega.");
  }

  let lastError = null;

  for (const session of sessions) {
    try {
      const queryResponse = await fetch(`https://${shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": session.accessToken,
        },
        body: JSON.stringify({
          query: `#graphql
            query CourierOrderFulfillments($id: ID!) {
              order(id: $id) {
                fulfillmentOrders(first: 50) {
                  nodes {
                    id
                    status
                  }
                }
                fulfillments {
                  id
                  status
                  deliveredAt
                }
              }
            }`,
          variables: { id: orderId },
        }),
      });

      const queryPayload = await queryResponse.json().catch(() => ({}));
      const queryErrors = queryPayload?.errors || [];
      if (!queryResponse.ok || queryErrors.length || !queryPayload?.data?.order) {
        const queryError = String(queryErrors[0]?.message || "").trim();
        if (queryError.toLowerCase().includes("access denied for fulfillmentorders")) {
          throw new Error(
            "Shopify requiere reautorizar la app con permisos de fulfillment antes de marcar pedidos como entregados.",
          );
        }
        throw new Error(queryError || "No se pudieron consultar las preparaciones de la orden.");
      }

      const fulfillmentOrderIds = (queryPayload.data.order.fulfillmentOrders?.nodes || [])
        .filter((fulfillmentOrder) => ["OPEN", "IN_PROGRESS"].includes(String(fulfillmentOrder?.status || "").toUpperCase()))
        .map((fulfillmentOrder) => String(fulfillmentOrder?.id || "").trim())
        .filter(Boolean);
      const fulfillmentIds = (queryPayload.data.order.fulfillments || [])
        .filter((fulfillment) => !fulfillment?.deliveredAt && String(fulfillment?.status || "").toUpperCase() !== "CANCELLED")
        .map((fulfillment) => String(fulfillment?.id || "").trim())
        .filter(Boolean);

      if (fulfillmentOrderIds.length) {
        const createResponse = await fetch(`https://${shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": session.accessToken,
          },
          body: JSON.stringify({
            query: `#graphql
              mutation CompleteCourierFulfillment($fulfillment: FulfillmentInput!) {
                fulfillmentCreate(fulfillment: $fulfillment) {
                  fulfillment { id }
                  userErrors { field message }
                }
              }`,
            variables: {
              fulfillment: {
                notifyCustomer: false,
                lineItemsByFulfillmentOrder: fulfillmentOrderIds.map((fulfillmentOrderId) => ({ fulfillmentOrderId })),
              },
            },
          }),
        });

        const createPayload = await createResponse.json().catch(() => ({}));
        const createErrors = createPayload?.errors || [];
        const createUserErrors = createPayload?.data?.fulfillmentCreate?.userErrors || [];
        const createdFulfillmentId = String(createPayload?.data?.fulfillmentCreate?.fulfillment?.id || "").trim();
        if (!createResponse.ok || createErrors.length || createUserErrors.length || !createdFulfillmentId) {
          throw new Error(
            createErrors[0]?.message ||
              createUserErrors[0]?.message ||
              "No se pudo completar la preparacion de la orden.",
          );
        }
        fulfillmentIds.push(createdFulfillmentId);
      }

      for (const fulfillmentId of Array.from(new Set(fulfillmentIds))) {
        const eventResponse = await fetch(`https://${shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": session.accessToken,
          },
          body: JSON.stringify({
            query: `#graphql
              mutation MarkCourierFulfillmentDelivered($fulfillmentEvent: FulfillmentEventInput!) {
                fulfillmentEventCreate(fulfillmentEvent: $fulfillmentEvent) {
                  fulfillmentEvent { id status }
                  userErrors { field message }
                }
              }`,
            variables: {
              fulfillmentEvent: {
                fulfillmentId,
                status: "DELIVERED",
              },
            },
          }),
        });

        const eventPayload = await eventResponse.json().catch(() => ({}));
        const eventErrors = eventPayload?.errors || [];
        const eventUserErrors = eventPayload?.data?.fulfillmentEventCreate?.userErrors || [];
        if (!eventResponse.ok || eventErrors.length || eventUserErrors.length) {
          throw new Error(eventErrors[0]?.message || eventUserErrors[0]?.message || "No se pudo registrar la entrega.");
        }
      }

      return;
    } catch (error) {
      lastError = String(error?.message || error || "No se pudo marcar la orden como entregada.");
    }
  }

  throw new Error(lastError || "No se pudo marcar la orden como entregada.");
}

async function addShopifyOrderTag({ shopDomain, shopifyOrderId, tag }) {
  return syncShopifyOrderTags({
    shopDomain,
    shopifyOrderId,
    addTags: [tag],
  });
}
async function emitCourierDeliveryManualStatusNotification({ shopDomain, requestRow, status, routeStep = null }) {
  if (!shopDomain || !requestRow || !NOTIFICATIONS_API_BASE_URL) {
    return { ok: false, error: "No se pudo preparar la notificacion." };
  }

  const attemptCount = Math.max(0, Number(requestRow.attemptCount || 0) || 0);
  const branchDetails =
    status === "no_entregado" && attemptCount >= 3
      ? await getReturnBranchDetails(shopDomain)
      : { branchAddress: "", branchHours: "" };

  const endpoints = NOTIFICATIONS_API_KEY
    ? [
        {
          url: `${NOTIFICATIONS_API_BASE_URL}/api/orders/manual-status`,
          headers: {
            "Content-Type": "application/json",
            "x-shop-domain": shopDomain,
            "x-api-key": NOTIFICATIONS_API_KEY,
          },
        },
        {
          url: `${NOTIFICATIONS_API_BASE_URL}/proxy/orders/manual-status`,
          headers: {
            "Content-Type": "application/json",
            "x-shop-domain": shopDomain,
          },
        },
      ]
    : [
        {
          url: `${NOTIFICATIONS_API_BASE_URL}/proxy/orders/manual-status`,
          headers: {
            "Content-Type": "application/json",
            "x-shop-domain": shopDomain,
          },
        },
      ];

  let lastFailure = null;

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: endpoint.headers,
        body: JSON.stringify({
          shopDomain,
          orderNumber: requestRow.orderNumber || null,
          customerEmail: requestRow.customerEmail || null,
          status,
          attemptCount,
          branchAddress: branchDetails.branchAddress || null,
          branchHours: branchDetails.branchHours || null,
          routeStep,
        }),
      });

      const responsePayload = await response.json().catch(() => null);
      const totalRecipients = Number(responsePayload?.result?.total || 0) || 0;
      const sentRecipients = Number(responsePayload?.result?.sent || 0) || 0;

      if (response.ok && totalRecipients > 0 && sentRecipients > 0) {
        return { ok: true };
      }

      lastFailure = {
        endpoint: endpoint.url,
        status: response.status,
        detail: String(
          responsePayload?.error ||
            responsePayload?.detail ||
            (response.ok && totalRecipients <= 0 ? "No hay dispositivos activos para recibir la notificacion." : "") ||
            (response.ok && sentRecipients <= 0 ? "La notificacion no fue entregada a ningun dispositivo." : "") ||
            "No se pudo enviar la notificacion.",
        ).slice(0, 300),
      };
    } catch (error) {
      lastFailure = {
        endpoint: endpoint.url,
        error: String(error?.message || error || "unknown"),
      };
    }
  }

  console.error("Failed to emit courier delivery notification", {
    shopDomain,
    orderNumber: requestRow.orderNumber || null,
    status,
    routeStep,
    ...lastFailure,
  });
  return {
    ok: false,
    error: lastFailure?.detail || lastFailure?.error || "No se pudo enviar la notificacion.",
  };
}

async function emitCourierDeliveryRouteNotification({ shopDomain, requestRow, routeStep = 1 }) {
  return emitCourierDeliveryManualStatusNotification({
    shopDomain,
    requestRow,
    status: "en_ruta",
    routeStep,
  });
}
export async function markCourierOrderAsEnRoute({
  shopDomain,
  requestId,
  orderNumber,
  customerName,
  customerEmail,
  customerPhone,
  currentStatus,
  currentAttemptCount,
}) {
  const isPickupRequest = String(requestId || "").startsWith("pickup-");

  if (isPickupRequest) {
    return markCourierReturnAsEnRoute({
      requestId: String(requestId || "").replace(/^pickup-/, ""),
    });
  }

  const orderGid = String(requestId || "").trim();
  if (!shopDomain || !orderGid) {
    return { ok: false, error: "Accion no valida." };
  }

  const currentStep = getCourierRouteStep(currentStatus);
  const previousFailedAttemptCount = await getMaxCourierFailedDeliveryAttempt({
    shopDomain,
    requestId: orderGid,
    orderNumber,
  });
  const previousAttemptCount = Math.max(
    normalizeDeliveryAttemptCount(currentAttemptCount, 0),
    previousFailedAttemptCount,
  );
  const nextStep = currentStep
    ? Math.max(currentStep + 1, Math.min(previousFailedAttemptCount + 1, 3))
    : Math.min(previousAttemptCount + 1, 3);
  if (nextStep > 3) {
    return { ok: false, error: "Esta orden ya alcanzo el maximo de 3 avisos en ruta." };
  }

  const nextStatus = `en_ruta_${nextStep}`;
  const routeTag = getCourierRouteTag(nextStep);
  const requestRow = {
    shop: shopDomain,
    shopifyOrderId: orderGid,
    orderNumber: String(orderNumber || "").trim() || orderGid.replace(/^gid:\/\/shopify\/Order\//, ""),
    customerName: String(customerName || "Cliente").trim(),
    customerEmail: String(customerEmail || "").trim(),
    customerPhone: String(customerPhone || "-").trim() || "-",
    status: nextStatus,
    attemptCount: nextStep,
  };

  try {
    await replaceCourierOrderStatusTag({
      shopDomain,
      shopifyOrderId: orderGid,
      statusTag: routeTag,
    });
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error || "No se pudo marcar la orden en ruta en Shopify."),
    };
  }

  await recordCourierDeliveryEvent({
    shopDomain,
    requestId: orderGid,
    orderNumber: requestRow.orderNumber,
    status: nextStatus,
    attemptCount: nextStep,
  });

  if (nextStep >= 2) {
    const notificationResult = await emitCourierDeliveryRouteNotification({
      shopDomain,
      requestRow,
      routeStep: nextStep,
    });
    if (!notificationResult?.ok) {
      return { ok: false, error: notificationResult?.error || "No se pudo enviar la notificacion." };
    }
  }

  return { ok: true, requestRow, routeStep: nextStep, nextStatus, attemptCount: requestRow.attemptCount };
}
export async function markCourierOrderAsNotDelivered({
  shopDomain,
  requestId,
  orderNumber,
  customerName,
  customerEmail,
  customerPhone,
  currentStatus,
  currentAttemptCount,
}) {
  const isPickupRequest = String(requestId || "").startsWith("pickup-");
  if (isPickupRequest) {
    return { ok: false, error: "Esta accion solo aplica para entregas." };
  }

  const orderGid = String(requestId || "").trim();
  if (!shopDomain || !orderGid) {
    return { ok: false, error: "Accion no valida." };
  }

  const currentRouteStep = getCourierRouteStep(currentStatus);
  const previousFailedAttemptCount = await getMaxCourierFailedDeliveryAttempt({
    shopDomain,
    requestId: orderGid,
    orderNumber,
  });
  const inferredAttemptFromHistory =
    currentRouteStep && previousFailedAttemptCount >= currentRouteStep
      ? previousFailedAttemptCount + 1
      : previousFailedAttemptCount;
  const nextAttemptCount = Math.min(
    Math.max(
      1,
      normalizeDeliveryAttemptCount(currentAttemptCount, currentRouteStep || 1),
      currentRouteStep,
      inferredAttemptFromHistory,
    ),
    3,
  );
  const nextStatus = nextAttemptCount >= 3 ? "recoger_en_sucursal" : "no_entregado";
  const statusTag = nextAttemptCount >= 3 ? "recoger en sucursal" : "no entregado";
  const requestRow = {
    shop: shopDomain,
    shopifyOrderId: orderGid,
    orderNumber: String(orderNumber || "").trim() || orderGid.replace(/^gid:\/\/shopify\/Order\//, ""),
    customerName: String(customerName || "Cliente").trim(),
    customerEmail: String(customerEmail || "").trim(),
    customerPhone: String(customerPhone || "-").trim() || "-",
    status: nextStatus,
    attemptCount: nextAttemptCount,
  };

  try {
    await replaceCourierOrderStatusTag({
      shopDomain,
      shopifyOrderId: orderGid,
      statusTag,
    });
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error || "No se pudo marcar la orden como no entregada en Shopify."),
    };
  }

  await recordCourierDeliveryEvent({
    shopDomain,
    requestId: orderGid,
    orderNumber: requestRow.orderNumber,
    status: nextStatus,
    attemptCount: nextAttemptCount,
  });

  const notificationResult = await emitCourierDeliveryManualStatusNotification({
    shopDomain,
    requestRow,
    status: "no_entregado",
  });
  if (!notificationResult?.ok) {
    return { ok: false, error: notificationResult?.error || "No se pudo enviar la notificacion." };
  }

  return { ok: true, requestRow, nextStatus, attemptCount: nextAttemptCount };
}

export async function markCourierOrderForRetry({
  shopDomain,
  requestId,
  orderNumber,
  customerName,
  customerEmail,
  customerPhone,
  currentStatus,
  currentAttemptCount,
}) {
  const isPickupRequest = String(requestId || "").startsWith("pickup-");
  if (isPickupRequest) {
    return { ok: false, error: "Esta accion solo aplica para entregas." };
  }

  const orderGid = String(requestId || "").trim();
  if (!shopDomain || !orderGid) {
    return { ok: false, error: "Accion no valida." };
  }

  const normalizedCurrentStatus = String(currentStatus || "").trim().toLowerCase();
  if (normalizedCurrentStatus === "recoger_en_sucursal") {
    return { ok: false, error: "Esta orden ya esta pendiente por recoger en sucursal." };
  }

  const currentAttempt = normalizeDeliveryAttemptCount(currentAttemptCount, 0);
  const nextStatus = "reintento_pendiente";
  const requestRow = {
    shop: shopDomain,
    shopifyOrderId: orderGid,
    orderNumber: String(orderNumber || "").trim() || orderGid.replace(/^gid:\/\/shopify\/Order\//, ""),
    customerName: String(customerName || "Cliente").trim(),
    customerEmail: String(customerEmail || "").trim(),
    customerPhone: String(customerPhone || "-").trim() || "-",
    status: nextStatus,
    attemptCount: currentAttempt,
  };

  try {
    await replaceCourierOrderStatusTag({
      shopDomain,
      shopifyOrderId: orderGid,
      statusTag: "reintentar entrega",
    });
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error || "No se pudo reenviar la orden a ruta."),
    };
  }

  await recordCourierDeliveryEvent({
    shopDomain,
    requestId: orderGid,
    orderNumber: requestRow.orderNumber,
    status: nextStatus,
    attemptCount: currentAttempt,
  });

  return {
    ok: true,
    requestRow,
    nextStatus,
    attemptCount: currentAttempt,
  };
}

export async function markCourierOrderReadyForBranchPickup({ shopDomain, requestId, orderNumber = "" }) {
  const isPickupRequest = String(requestId || "").startsWith("pickup-");
  if (isPickupRequest) {
    return { ok: false, error: "Esta accion solo aplica para entregas." };
  }

  const orderGid = String(requestId || "").trim();
  if (!shopDomain || !orderGid) {
    return { ok: false, error: "Accion no valida." };
  }

  try {
    await replaceCourierOrderStatusTag({
      shopDomain,
      shopifyOrderId: orderGid,
      statusTag: "recoger en sucursal",
    });
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error || "No se pudo marcar la orden para recoger en sucursal."),
    };
  }

  await recordCourierDeliveryEvent({
    shopDomain,
    requestId: orderGid,
    orderNumber,
    status: "recoger_en_sucursal",
    attemptCount: 3,
  });

  return { ok: true, nextStatus: "recoger_en_sucursal", attemptCount: 3 };
}

export async function markCourierOrderAsDelivered({
  shopDomain,
  requestId,
  orderNumber,
  customerName,
  customerEmail,
  customerPhone,
  currentAttemptCount,
}) {
  const isPickupRequest = String(requestId || "").startsWith("pickup-");
  if (isPickupRequest) {
    return { ok: false, error: "Esta accion solo aplica para entregas." };
  }

  const orderGid = String(requestId || "").trim();
  if (!shopDomain || !orderGid) {
    return { ok: false, error: "Accion no valida." };
  }

  const previousAttemptCount = await getMaxCourierDeliveryAttemptFromEvents({
    shopDomain,
    requestId: orderGid,
    orderNumber,
    statuses: ["en_ruta_1", "en_ruta_2", "en_ruta_3", "no_entregado", "recoger_en_sucursal"],
  });
  const deliveredAttemptCount = Math.max(
    1,
    normalizeDeliveryAttemptCount(currentAttemptCount, 1),
    previousAttemptCount,
  );
  const requestRow = {
    shop: shopDomain,
    shopifyOrderId: orderGid,
    orderNumber: String(orderNumber || "").trim() || orderGid.replace(/^gid:\/\/shopify\/Order\//, ""),
    customerName: String(customerName || "Cliente").trim(),
    customerEmail: String(customerEmail || "").trim(),
    customerPhone: String(customerPhone || "-").trim() || "-",
    status: "entregado",
    attemptCount: deliveredAttemptCount,
  };

  try {
    await markShopifyOrderFulfillmentsAsDelivered({
      shopDomain,
      shopifyOrderId: orderGid,
    });
    await replaceCourierOrderStatusTag({
      shopDomain,
      shopifyOrderId: orderGid,
      statusTag: "entregado",
    });
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error || "No se pudo marcar la orden como entregada en Shopify."),
    };
  }

  await recordCourierDeliveryEvent({
    shopDomain,
    requestId: orderGid,
    orderNumber: requestRow.orderNumber,
    status: "entregado",
    attemptCount: requestRow.attemptCount,
  });

  return { ok: true, requestRow, nextStatus: "entregado", attemptCount: requestRow.attemptCount };
}
async function sendCourierReturnRouteNotificationOnly({ requestId }) {
  const id = Number(requestId || 0);
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, error: "Accion no valida." };
  }

  const requestRow = await prisma.returnRequest.findUnique({
    where: { id },
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

  const currentStep = getCourierRouteStep(requestRow.status);
  const nextStep = currentStep ? currentStep + 1 : 1;
  if (nextStep > 3) {
    return { ok: false, error: "Esta orden ya alcanzo el maximo de 3 avisos en ruta." };
  }

  const notificationResult = await emitCourierReturnRouteNotification({
    shopDomain: requestRow.shop,
    requestRow,
    routeStep: nextStep,
  });
  if (!notificationResult?.ok) {
    return { ok: false, error: notificationResult?.error || "No se pudo enviar la notificacion." };
  }

  return { ok: true, requestRow, routeStep: nextStep };
}

export async function markCourierReturnAsEnRoute({ requestId }) {
  const id = Number(requestId || 0);
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, error: "Accion no valida." };
  }

  const requestRow = await prisma.returnRequest.findUnique({
    where: { id },
    select: {
      id: true,
      shop: true,
      orderNumber: true,
      customerName: true,
      customerEmail: true,
      customerPhone: true,
      returnMethod: true,
      status: true,
      shopifyOrderId: true,
      rejectionReason: true,
    },
  });

  if (!requestRow) {
    return { ok: false, error: "No encontramos la orden de devolucion." };
  }

  if (String(requestRow.returnMethod || "") !== "pickup") {
    return { ok: false, error: "Solo se puede marcar en ruta una devolucion de recoleccion." };
  }

  const normalizedStatus = String(requestRow.status || "").trim().toLowerCase();
  const blockedStatuses = new Set([
    "rechazada",
    "denegada",
    "reembolso_denegado",
    "no_devuelto",
    "reembolsada",
    "completada",
    "recibida",
  ]);
  if (blockedStatuses.has(normalizedStatus)) {
    return { ok: false, error: "Esta solicitud ya esta cerrada y no se puede volver a poner en ruta." };
  }

  const currentStep = getCourierRouteStep(requestRow.status);
  const failedAttemptStep = normalizedStatus === "reintento_pendiente" ? getReturnFailedAttemptCount(requestRow.rejectionReason) : 0;
  const nextStep = currentStep ? currentStep + 1 : Math.min(Math.max(failedAttemptStep + 1, 1), 3);
  if (nextStep > 3) {
    return { ok: false, error: "Esta orden ya alcanzo el maximo de 3 avisos en ruta." };
  }

  const nextStatus = `en_ruta_${nextStep}`;
  await prisma.returnRequest.update({
    where: { id },
    data: {
      status: nextStatus,
      rejectionReason: appendReasonEntry(requestRow.rejectionReason, {
        kind: `courier_en_route_${nextStep}`,
        reason: `${nextStep === 1 ? "Primer" : nextStep === 2 ? "Segundo" : "Tercer"} intento en ruta`,
      }),
    },
  });

  await emitCourierReturnRouteNotification({
    shopDomain: requestRow.shop,
    requestRow,
    routeStep: nextStep,
  });

  return { ok: true, requestRow, nextStatus, routeStep: nextStep };
}

function isCourierReturnRouteLikeStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  return normalized === "en_ruta" || normalized.startsWith("en_ruta_");
}

function getCourierReturnFailedAttemptStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "aprobada" || normalized === "en_ruta" || normalized === "en_ruta_1") {
    return "intento_fallido_1";
  }
  if (normalized === "intento_fallido_1" || normalized === "en_ruta_2") {
    return "intento_fallido_2";
  }
  if (normalized === "intento_fallido_2" || normalized === "en_ruta_3") {
    return "intento_fallido_3";
  }
  return "";
}

async function getCourierReturnRequestForAction(requestId) {
  const id = Number(String(requestId || "").replace(/^pickup-/, "") || 0);
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, error: "Accion no valida." };
  }

  const requestRow = await prisma.returnRequest.findUnique({
    where: { id },
    select: {
      id: true,
      shop: true,
      orderNumber: true,
      customerName: true,
      customerEmail: true,
      customerPhone: true,
      returnMethod: true,
      status: true,
      rejectionReason: true,
      pickupDate: true,
      updatedAt: true,
    },
  });

  if (!requestRow) {
    return { ok: false, error: "No encontramos la orden de devolucion." };
  }

  if (String(requestRow.returnMethod || "").toLowerCase() !== "pickup") {
    return { ok: false, error: "Esta accion solo aplica para devoluciones de recoleccion." };
  }

  return { ok: true, requestRow };
}

export async function markCourierReturnAsReceived({ requestId }) {
  const lookup = await getCourierReturnRequestForAction(requestId);
  if (!lookup.ok) return lookup;

  const requestRow = lookup.requestRow;
  const currentStatus = String(requestRow.status || "").trim().toLowerCase();
  const canMarkReceived =
    currentStatus === "aprobada" ||
    isCourierReturnRouteLikeStatus(currentStatus) ||
    currentStatus === "intento_fallido_1" ||
    currentStatus === "intento_fallido_2" ||
    currentStatus === "intento_fallido_3";

  if (!canMarkReceived) {
    return { ok: false, error: "Solo puedes marcar como recibida una devolucion aprobada o con intento fallido." };
  }

  await prisma.returnRequest.update({
    where: { id: requestRow.id },
    data: {
      status: "recibida",
      receivedAt: new Date(),
      rejectionReason: appendTimelineMetaEntry(requestRow.rejectionReason, {
        kind: STATUS_RECEIVED_KIND,
        reason: "Producto recibido. 📦 Hemos recibido tu devolución y nuestro equipo ya se encuentra revisando tu producto. Una vez finalizado el proceso de verificación, realizaremos tu reembolso correspondiente. 💰",
      }),
    },
  });

  await emitCourierReturnActionNotification({
    shopDomain: requestRow.shop,
    requestRow,
    intent: "courier_return_mark_received",
    note: "Recibimos tu producto para validar la devolucion.",
  });

  return { ok: true, requestRow, nextStatus: "recibida", attemptCount: 0 };
}

export async function markCourierReturnPickupAttemptFailed({ requestId, rejectionReason: selectedRejectionReason }) {
  const lookup = await getCourierReturnRequestForAction(requestId);
  if (!lookup.ok) return lookup;

  const requestRow = lookup.requestRow;
  const currentStatus = String(requestRow.status || "").trim().toLowerCase();
  const nextStatus = getCourierReturnFailedAttemptStatus(currentStatus);
  if (!nextStatus) {
    return { ok: false, error: "Ya no puedes registrar mas intentos fallidos para esta devolucion." };
  }

  const rejectionReason =
    String(selectedRejectionReason || "").trim() ||
    (nextStatus === "intento_fallido_1" ? PICKUP_FAILED_REASON_FIRST : PICKUP_FAILED_REASON_SECOND);
  const nextPickupDate = getNextPickupDate(requestRow.pickupDate);
  const reprogrammedReason = `Reprogramado para el ${formatPickupDateForMessage(nextPickupDate)}.\n\n${rejectionReason}`;
  const attemptCount = Number(nextStatus.replace("intento_fallido_", "")) || 0;

  await prisma.returnRequest.update({
    where: { id: requestRow.id },
    data: {
      status: nextStatus,
      pickupDate: nextPickupDate,
      rejectionReason: appendReasonEntry(requestRow.rejectionReason, {
        kind: `attempt_failed_${attemptCount}`,
        reason: reprogrammedReason,
      }),
    },
  });

  await emitCourierReturnActionNotification({
    shopDomain: requestRow.shop,
    requestRow,
    intent: "courier_return_pickup_attempt_failed",
    note: reprogrammedReason,
  });

  return { ok: true, requestRow, nextStatus, attemptCount };
}

export async function markCourierReturnForRetry({ requestId }) {
  const lookup = await getCourierReturnRequestForAction(requestId);
  if (!lookup.ok) return lookup;

  const requestRow = lookup.requestRow;
  const currentStatus = String(requestRow.status || "").trim().toLowerCase();
  if (currentStatus !== "intento_fallido_1" && currentStatus !== "intento_fallido_2") {
    return { ok: false, error: "Solo puedes reintentar una devolucion con intento fallido." };
  }

  await prisma.returnRequest.update({
    where: { id: requestRow.id },
    data: {
      status: "reintento_pendiente",
      rejectionReason: appendReasonEntry(requestRow.rejectionReason, {
        kind: `courier_retry_${getReturnFailedAttemptCount(requestRow.rejectionReason) + 1}`,
        reason: "Recoleccion reprogramada para un nuevo intento.",
      }),
    },
  });

  return {
    ok: true,
    requestRow,
    nextStatus: "reintento_pendiente",
    attemptCount: getReturnFailedAttemptCount(requestRow.rejectionReason),
  };
}

export async function rejectCourierReturnAfterFailedPickups({ requestId, rejectionReason: selectedRejectionReason }) {
  const lookup = await getCourierReturnRequestForAction(requestId);
  if (!lookup.ok) return lookup;

  const requestRow = lookup.requestRow;
  const currentStatus = String(requestRow.status || "").trim().toLowerCase();
  if (currentStatus !== "intento_fallido_3" && currentStatus !== "en_ruta_3") {
    return { ok: false, error: "Solo puedes rechazar despues del tercer intento fallido." };
  }

  const rejectionReason =
    String(selectedRejectionReason || "").trim() ||
    "❌🚚 Después de 3 intentos de recolección en el domicilio registrado, no fue posible recibir el producto. Por esta razón, la solicitud de devolución fue rechazada automáticamente.";

  await prisma.returnRequest.update({
    where: { id: requestRow.id },
    data: {
      status: "rechazada",
      rejectionReason: appendReasonEntry(
        appendReasonEntry(requestRow.rejectionReason, {
          kind: "attempt_failed_3",
          reason: rejectionReason,
        }),
        {
          kind: "rejected_after_attempts",
          reason: rejectionReason,
        },
      ),
      refundError: null,
    },
  });

  await emitCourierReturnActionNotification({
    shopDomain: requestRow.shop,
    requestRow,
    intent: "courier_return_reject_after_failed_pickups",
    note: rejectionReason,
  });

  return { ok: true, requestRow, nextStatus: "rechazada", attemptCount: 3 };
}


export async function resolveCourierPortalShop(request) {
  const url = new URL(request.url);
  // eslint-disable-next-line no-undef
  const env = process.env || {};
  const incomingShop = normalizeShop(url.searchParams.get("shop") || "");
  const configuredShop = normalizeShop(env.SHOPIFY_SHOP_DOMAIN || "");

  const sessions = await prisma.session.findMany({
    select: { id: true, shop: true, isOnline: true, accessToken: true },
  });

  const sessionCandidates = sessions
    .map((session) => ({
      id: String(session.id || "").trim(),
      shop: String(session.shop || "").trim().toLowerCase(),
      isOnline: Boolean(session.isOnline),
      accessToken: String(session.accessToken || "").trim(),
    }))
    .filter((session) => session.shop && session.accessToken);

  const preferredShop = [incomingShop, configuredShop].find((shop) =>
    sessionCandidates.some((session) => session.shop === shop),
  );
  const selectedShop =
    preferredShop ||
    sessionCandidates.find((session) => session.isOnline === false)?.shop ||
    sessionCandidates[0]?.shop ||
    "";

  const selectedSessions = sessionCandidates
    .filter((session) => session.shop === selectedShop)
    .sort((a, b) => {
      const aOffline = a.isOnline === false ? 0 : 1;
      const bOffline = b.isOnline === false ? 0 : 1;
      if (aOffline !== bOffline) return aOffline - bOffline;
      return String(a.id || "").localeCompare(String(b.id || ""));
    });

  if (!selectedShop || !selectedSessions.length) {
    return { shop: "", sessionCandidates: [], allSessionCandidates: sessionCandidates };
  }

  return {
    shop: selectedShop,
    sessionCandidates: selectedSessions,
    allSessionCandidates: sessionCandidates,
  };
}

async function fetchCourierOrdersByQuery({ shop, accessToken, queryString }) {
  const response = await fetch(`https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({
      query: `#graphql
        query CourierOrders {
          orders(first: 250, query: "${queryString}", sortKey: UPDATED_AT, reverse: true) {
            edges {
              node {
                id
                name
                createdAt
                updatedAt
                displayFulfillmentStatus
                fulfillments(first: 20) {
                  deliveredAt
                }
                shippingAddress {
                  name
                  phone
                  address1
                  address2
                  city
                  province
                  zip
                  country
                }
                billingAddress {
                  name
                  phone
                }
                customAttributes {
                  key
                  value
                }
                tags
                shippingLines(first: 5) {
                  nodes {
                    title
                    code
                    deliveryCategory
                  }
                }
              }
            }
          }
        }`,
    }),
  });

  const payload = await response.json();
  if (!response.ok || payload?.errors?.length) {
    throw new Error(payload?.errors?.[0]?.message || `Error consultando Shopify Admin API (${response.status}).`);
  }

  return payload?.data?.orders?.edges?.map((edge) => edge?.node).filter(Boolean) || [];
}

async function fetchCourierOrdersByIds({ shop, accessToken, orderIds }) {
  const cleanOrderIds = Array.from(
    new Set((Array.isArray(orderIds) ? orderIds : []).map((id) => String(id || "").trim()).filter(Boolean)),
  );
  if (!shop || !accessToken || !cleanOrderIds.length) return [];

  const response = await fetch(`https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({
      query: `#graphql
        query CourierOrdersByIds($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Order {
              id
              name
              createdAt
              updatedAt
              displayFulfillmentStatus
              fulfillments(first: 20) {
                deliveredAt
              }
              shippingAddress {
                name
                phone
                address1
                address2
                city
                province
                zip
                country
              }
              billingAddress {
                name
                phone
              }
              customAttributes {
                key
                value
              }
              tags
              shippingLines(first: 5) {
                nodes {
                  title
                  code
                  deliveryCategory
                }
              }
            }
          }
        }`,
      variables: { ids: cleanOrderIds },
    }),
  });

  const payload = await response.json();
  if (!response.ok || payload?.errors?.length) {
    throw new Error(payload?.errors?.[0]?.message || `Error consultando Shopify Admin API (${response.status}).`);
  }

  return (payload?.data?.nodes || []).filter(Boolean);
}

async function mapShopifyOrderNodeToCourierOrder({ shop, orderNode }) {
  const shipping = orderNode.shippingAddress || null;
  const billing = orderNode.billingAddress || null;
  const courierTags = Array.isArray(orderNode?.tags) ? orderNode.tags : [];
  const fulfillmentStatus = String(orderNode?.displayFulfillmentStatus || "").toUpperCase();
  const isShopifyDelivered = fulfillmentStatus === "FULFILLED";
  const orderNumber = String(orderNode.name || "").replace("#", "");
  const tagAttemptCount = getCourierDeliveryAttemptCountFromTags(orderNode.tags);
  const failedAttemptCount = isShopifyDelivered
    ? 0
    : await getMaxCourierFailedDeliveryAttempt({
        shopDomain: shop,
        requestId: orderNode.id,
        orderNumber,
      });
  const attemptCount = Math.max(tagAttemptCount, failedAttemptCount);
  const deliveredAt =
    (orderNode?.fulfillments || [])
      .map((fulfillment) => String(fulfillment?.deliveredAt || "").trim())
      .filter(Boolean)
      .sort((firstDate, secondDate) => new Date(secondDate).getTime() - new Date(firstDate).getTime())[0] || "";
  return {
    id: orderNode.id,
    orderNumber,
    customerName: String(shipping?.name || billing?.name || "Cliente").trim(),
    customerEmail: "",
    customerPhone: String(shipping?.phone || billing?.phone || "-").trim() || "-",
    pickupDate: getCourierScheduledDate(orderNode) || String(orderNode.createdAt || ""),
    pickupAddress: String(shipping?.address1 || "").trim(),
    pickupNeighborhood: String(shipping?.address2 || "").trim(),
    pickupCity: String(shipping?.city || "").trim(),
    pickupState: String(shipping?.province || "").trim(),
    pickupPostalCode: String(shipping?.zip || "").trim(),
    pickupCountry: String(shipping?.country || "Mexico").trim() || "Mexico",
    createdAt: orderNode.createdAt,
    updatedAt: orderNode.updatedAt || orderNode.createdAt,
    courierHistoryAt: isShopifyDelivered ? deliveredAt : orderNode.updatedAt || "",
    status: isShopifyDelivered ? "entregado" : getCourierRouteStatusFromTags(orderNode.tags),
    attemptCount,
    courierLabel: "Entrega",
  };
}

export async function fetchCourierOrdersByToken({ shop, accessToken }) {
  if (!shop || !accessToken) return [];

  const courierOrdersById = new Map();

  for (const queryString of ["fulfillment_status:unfulfilled", "status:open"]) {
    const nodes = await fetchCourierOrdersByQuery({ shop, accessToken, queryString });
    const normalizationJobs = [];
    const courierOrders = await Promise.all(nodes
      .filter((orderNode) => {
        const fulfillmentStatus = String(orderNode?.displayFulfillmentStatus || "").toUpperCase();
        const courierStatus = getCourierRouteStatusFromTags(orderNode?.tags);
        return (
          isCourierLocalDeliveryOrder(orderNode) &&
          !["FULFILLED", "RESTOCKED"].includes(fulfillmentStatus) &&
          courierStatus !== "recoger_en_sucursal"
        );
      })
      .map(async (orderNode) => {
        const courierTags = Array.isArray(orderNode?.tags) ? orderNode.tags : [];
        const fulfillmentStatus = String(orderNode?.displayFulfillmentStatus || "").toUpperCase();
        const isShopifyDelivered = fulfillmentStatus === "FULFILLED";
        const preferredTag = isShopifyDelivered ? "entregado" : getPreferredCourierStatusTag(courierTags);
        if (preferredTag) {
          const normalizedCourierTags = Array.from(
            new Set(courierTags.map(normalizeCourierTag).filter((tag) => COURIER_STATUS_TAGS.includes(tag))),
          );
          const shouldNormalize =
            normalizedCourierTags.length > 1 ||
            normalizedCourierTags.some((tag) => tag !== preferredTag) ||
            normalizedCourierTags.some((tag) => tag.startsWith("intento entrega")) ||
            normalizedCourierTags.includes("reintentar entrega");
          if (shouldNormalize) {
            normalizationJobs.push(
              isShopifyDelivered
                ? replaceCourierOrderStatusTag({
                    shopDomain: shop,
                    shopifyOrderId: orderNode.id,
                    statusTag: "entregado",
                  })
                : normalizeCourierOrderTags({
                    shopDomain: shop,
                    shopifyOrderId: orderNode.id,
                    tags: courierTags,
                  }),
            );
          }
        }
        return mapShopifyOrderNodeToCourierOrder({ shop, orderNode });
      }));

    if (normalizationJobs.length > 0) {
      await Promise.allSettled(normalizationJobs);
    }

    for (const courierOrder of courierOrders) {
      const orderId = String(courierOrder?.id || "").trim();
      if (orderId) {
        courierOrdersById.set(orderId, courierOrder);
      }
    }
  }

  return Array.from(courierOrdersById.values());
}

export async function fetchCourierOrdersByIdsForShop({ shop, sessionCandidates, orderIds }) {
  const candidates = Array.isArray(sessionCandidates) ? sessionCandidates : [];
  const cleanOrderIds = Array.from(
    new Set((Array.isArray(orderIds) ? orderIds : []).map((id) => String(id || "").trim()).filter(Boolean)),
  );
  if (!shop || !cleanOrderIds.length) return [];

  let lastError = null;
  for (const sessionCandidate of candidates) {
    try {
      const accessToken = String(sessionCandidate?.accessToken || "").trim();
      if (!accessToken) continue;
      const nodes = await fetchCourierOrdersByIds({ shop, accessToken, orderIds: cleanOrderIds });
      return Promise.all(nodes.map((orderNode) => mapShopifyOrderNodeToCourierOrder({ shop, orderNode })));
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    console.error("Failed to fetch courier route orders by id", lastError);
  }
  return [];
}

export async function fetchCourierOrdersForShop({ shop, sessionCandidates }) {
  const candidates = Array.isArray(sessionCandidates) ? sessionCandidates : [];
  let lastError = null;

  for (const sessionCandidate of candidates) {
    try {
      const accessToken = String(sessionCandidate?.accessToken || "").trim();
      if (!accessToken) continue;
      const courierOrders = await fetchCourierOrdersByToken({ shop, accessToken });
      if (courierOrders.length > 0) {
        return courierOrders;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) throw lastError;
  return [];
}

export async function fetchPickupCourierOrders(shop) {
  if (!shop) return [];

  const requestRows = await prisma.returnRequest.findMany({
    where: {
      shop,
      OR: [
        {
          returnMethod: "pickup",
          status: { in: Array.from(METHOD_QUEUE_STATUSES) },
        },
        {
          returnMethod: { not: "pickup" },
        },
        {
          status: { in: Array.from(BRANCH_PICKUP_STATUSES) },
        },
      ],
    },
    select: {
      id: true,
      shopifyOrderId: true,
      orderNumber: true,
      returnMethod: true,
      customerName: true,
      customerPhone: true,
      pickupDate: true,
      pickupAddress: true,
      pickupNeighborhood: true,
      pickupCity: true,
      pickupState: true,
      pickupPostalCode: true,
      createdAt: true,
      updatedAt: true,
      status: true,
      rejectionReason: true,
      items: {
        select: {
          lineItemId: true,
          productId: true,
          variantId: true,
          title: true,
          quantity: true,
        },
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 1000,
  });

  const pickupOrders = excludePickupRequestsSupersededByBranch(requestRows);
  const courierOrders = pickupOrders.map((requestRow) => ({
    id: `pickup-${requestRow.id}`,
    orderNumber: String(requestRow.orderNumber || "").replace("#", ""),
    dedupeKey: `pickup-request:${requestRow.id}`,
    customerName: String(requestRow.customerName || "Cliente").trim(),
    customerPhone: String(requestRow.customerPhone || "-").trim() || "-",
    pickupDate: String(requestRow.pickupDate || requestRow.createdAt || "").trim(),
    pickupAddress: String(requestRow.pickupAddress || "").trim(),
    pickupNeighborhood: String(requestRow.pickupNeighborhood || "").trim(),
    pickupCity: String(requestRow.pickupCity || "").trim(),
    pickupState: String(requestRow.pickupState || "").trim(),
    pickupPostalCode: String(requestRow.pickupPostalCode || "").trim(),
    pickupCountry: "Mexico",
    createdAt: requestRow.createdAt,
    updatedAt: requestRow.updatedAt,
    rejectionReason: requestRow.rejectionReason,
    status: ["reembolsada", "completada"].includes(String(requestRow.status || "").trim().toLowerCase())
      ? "recibida"
      : String(requestRow.status || "pendiente").trim() || "pendiente",
    attemptCount: getReturnFailedAttemptCount(requestRow.rejectionReason),
    courierLabel: "Devolucion",
  }));

  return dedupeCourierRequestsByOrderNumber(courierOrders).sort(
    (a, b) => courierOrderTimestampMs(a) - courierOrderTimestampMs(b),
  );
}

