import prisma from "../db.server";
import {
  dedupeCourierRequestsByOrderNumber,
  courierOrderTimestampMs,
  getCourierRouteStatusFromTags,
} from "./courier.shared";

const ADMIN_API_VERSION = "2025-10";
export const METHOD_QUEUE_STATUSES = new Set([
  "aprobada",
  "intento_fallido_1",
  "intento_fallido_2",
  "en_ruta_1",
  "en_ruta_2",
  "en_ruta_3",
]);
const NOTIFICATIONS_API_BASE_URL = String(
  process.env.NOTIFICATIONS_API_URL || "https://centro-de-notificaciones-cariana.onrender.com",
).replace(/\/+$/, "");
const NOTIFICATIONS_API_KEY = String(
  process.env.NOTIFICATIONS_API_KEY || process.env.APP_INTERNAL_API_KEY || "",
).trim();

function normalizeShop(value) {
  return String(value || "").trim().toLowerCase();
}

async function resolveCourierShopSession(shopDomain) {
  const shop = normalizeShop(shopDomain);
  if (!shop) return null;

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

  return candidates[0] || null;
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
  if (!shopDomain || !requestRow || !NOTIFICATIONS_API_BASE_URL) return;

  const title = "\u{1F69A} En ruta para recoger tu devoluci\u00f3n";
  const message = `Tu pedido #${requestRow.orderNumber}. Nuestro repartidor ya se dirige a tu domicilio para recoger tu devolucion. \u{1F4E6} Ten tu paquete listo y correctamente sellado. \u{1F4DD} No olvides colocar tu numero de pedido y nombre del comprador en el exterior del paquete.`;
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

      if (response.ok) return;

      const detail = await response.text().catch(() => "");
      lastFailure = {
        endpoint,
        status: response.status,
        detail: String(detail || "").slice(0, 300),
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
}

async function addShopifyOrderTag({ shopDomain, shopifyOrderId, tag }) {
  const orderId = String(shopifyOrderId || "").trim();
  const cleanTag = String(tag || "").trim();
  if (!shopDomain || !orderId || !cleanTag) return;

  const session = await resolveCourierShopSession(shopDomain);
  if (!session?.accessToken) {
    throw new Error("No se encontro una sesion valida de Shopify para sincronizar la orden.");
  }

  const response = await fetch(`https://${shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": session.accessToken,
    },
    body: JSON.stringify({
      query: `#graphql
        mutation AddCourierRouteTag($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) {
            node { id }
            userErrors { field message }
          }
        }`,
      variables: {
        id: orderId,
        tags: [cleanTag],
      },
    }),
  });

  const payload = await response.json().catch(() => ({}));
  const topErrors = payload?.errors || [];
  const userErrors = payload?.data?.tagsAdd?.userErrors || [];
  if (!response.ok || topErrors.length || userErrors.length) {
    const message = topErrors[0]?.message || userErrors[0]?.message || `No se pudo agregar la etiqueta ${cleanTag}.`;
    throw new Error(message);
  }
}

async function emitCourierDeliveryRouteNotification({ shopDomain, requestRow, routeStep = 1 }) {
  if (!shopDomain || !requestRow || !NOTIFICATIONS_API_BASE_URL) return;

  const title = "\u{1F69A} Tu pedido ya va en ruta";
  const message = `Tu pedido #${requestRow.orderNumber}. Nuestro repartidor ya va en camino. \u{1F4E6} Mantente atento para recibirlo.`;
  const eventPayload = {
    status: "order_in_transit",
    event: "order_in_transit",
    action: "courier_mark_en_route",
    title,
    message,
    note: message,
    source: "portal_repartidor",
    order_number: requestRow.orderNumber || null,
    customer: {
      email: requestRow.customerEmail || null,
      name: requestRow.customerName || null,
      phone: requestRow.customerPhone || null,
    },
    courier_label: "Entrega",
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

      if (response.ok) return;

      const detail = await response.text().catch(() => "");
      lastFailure = {
        endpoint,
        status: response.status,
        detail: String(detail || "").slice(0, 300),
      };
    } catch (error) {
      lastFailure = {
        endpoint,
        error: String(error?.message || error || "unknown"),
      };
    }
  }

  console.error("Failed to emit courier delivery notification", {
    shopDomain,
    ...lastFailure,
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
  const nextStep = currentStep ? currentStep + 1 : 1;
  if (nextStep > 3) {
    return { ok: false, error: "Esta orden ya alcanzo el maximo de 3 avisos en ruta." };
  }

  const nextStatus = getCourierNextRouteStatus(currentStatus || "");
  const nextTag = nextStep === 1 ? "en ruta" : `en ruta ${nextStep}`;

  await addShopifyOrderTag({
    shopDomain,
    shopifyOrderId: orderGid,
    tag: nextTag,
  });

  const requestRow = {
    shop: shopDomain,
    orderNumber: String(orderNumber || "").trim() || orderGid.replace(/^gid:\/\/shopify\/Order\//, ""),
    customerName: String(customerName || "Cliente").trim(),
    customerEmail: String(customerEmail || "").trim(),
    customerPhone: String(customerPhone || "-").trim() || "-",
  };

  await emitCourierDeliveryRouteNotification({
    shopDomain,
    requestRow,
    routeStep: nextStep,
  });

  return { ok: true, requestRow, nextStatus, routeStep: nextStep };
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
  ]);
  if (blockedStatuses.has(normalizedStatus)) {
    return { ok: false, error: "Esta solicitud ya esta cerrada y no se puede volver a poner en ruta." };
  }

  const currentStep = getCourierRouteStep(requestRow.status);
  const nextStep = currentStep ? currentStep + 1 : 1;
  if (nextStep > 3) {
    return { ok: false, error: "Esta orden ya alcanzo el maximo de 3 avisos en ruta." };
  }

  const nextStatus = getCourierNextRouteStatus(requestRow.status);
  await prisma.returnRequest.update({
    where: { id },
    data: { status: nextStatus },
  });

  try {
    await addShopifyOrderTag({
      shopDomain: requestRow.shop,
      shopifyOrderId: requestRow.shopifyOrderId,
      tag: nextStep === 1 ? "en ruta" : `en ruta ${nextStep}`,
    });
  } catch (error) {
    console.error("Failed to sync Shopify route tag", {
      shopDomain: requestRow.shop,
      orderNumber: requestRow.orderNumber,
      error: String(error?.message || error || "unknown"),
    });
  }

  await emitCourierReturnRouteNotification({
    shopDomain: requestRow.shop,
    requestRow,
    routeStep: nextStep,
  });

  return { ok: true, requestRow, nextStatus, routeStep: nextStep };
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
                displayFulfillmentStatus
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

export async function fetchCourierOrdersByToken({ shop, accessToken }) {
  if (!shop || !accessToken) return [];

  const queryCandidates = ["fulfillment_status:unfulfilled", "status:open", "status:any"];

  for (const queryString of queryCandidates) {
    const nodes = await fetchCourierOrdersByQuery({ shop, accessToken, queryString });
    const courierOrders = nodes
      .filter((orderNode) => {
        const status = String(orderNode?.displayFulfillmentStatus || "").toUpperCase();
        return isCourierLocalDeliveryOrder(orderNode) && !["FULFILLED", "RESTOCKED"].includes(status);
      })
      .map((orderNode) => {
        const shipping = orderNode.shippingAddress || null;
        const billing = orderNode.billingAddress || null;
        return {
          id: orderNode.id,
          orderNumber: String(orderNode.name || "").replace("#", ""),
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
          updatedAt: orderNode.createdAt,
          status: getCourierRouteStatusFromTags(orderNode.tags),
          courierLabel: "Entrega",
        };
      });

    if (courierOrders.length > 0) {
      return courierOrders;
    }
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

  const pickupOrders = await prisma.returnRequest.findMany({
    where: {
      shop,
      returnMethod: "pickup",
      status: { in: Array.from(METHOD_QUEUE_STATUSES) },
    },
    select: {
      id: true,
      orderNumber: true,
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
    },
    orderBy: [{ pickupDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: 250,
  });

  const courierOrders = pickupOrders.map((requestRow) => ({
    id: `pickup-${requestRow.id}`,
    orderNumber: String(requestRow.orderNumber || "").replace("#", ""),
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
    status: String(requestRow.status || "pendiente").trim() || "pendiente",
    courierLabel: "Devolucion",
  }));

  return dedupeCourierRequestsByOrderNumber(courierOrders).sort(
    (a, b) => courierOrderTimestampMs(a) - courierOrderTimestampMs(b),
  );
}
