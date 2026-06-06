import prisma from "../db.server";

const ADMIN_API_VERSION = "2025-10";
export const METHOD_QUEUE_STATUSES = new Set(["aprobada", "intento_fallido_1", "intento_fallido_2"]);

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


export async function resolveCourierPortalShop(request) {
  const url = new URL(request.url);
  // eslint-disable-next-line no-undef
  const env = process.env || {};
  const incomingShop = String(url.searchParams.get("shop") || "").trim().toLowerCase();
  const configuredShop = String(env.SHOPIFY_SHOP_DOMAIN || "").trim().toLowerCase();

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
  const offlineSession = sessionCandidates.find((session) => session.isOnline === false);
  const fallbackSession = sessionCandidates[0] || null;
  const selectedSession =
    sessionCandidates.find((session) => session.shop === preferredShop) || offlineSession || fallbackSession;

  if (!selectedSession) {
    return { shop: "", accessToken: "" };
  }

  return {
    shop: selectedSession.shop,
    accessToken: selectedSession.accessToken,
  };
}

export async function fetchCourierOrdersByToken({ shop, accessToken }) {
  if (!shop || !accessToken) return [];

  const response = await fetch(`https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({
      query: `#graphql
        query CourierOrders {
          orders(first: 250, query: "fulfillment_status:unfulfilled", sortKey: UPDATED_AT, reverse: true) {
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

  const nodes = payload?.data?.orders?.edges?.map((edge) => edge?.node).filter(Boolean) || [];
  return nodes
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
        status: "pendiente",
        courierLabel: "Entrega",
      };
    });
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

  return pickupOrders.map((requestRow) => ({
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
    status: "pendiente",
    courierLabel: "Devolucion",
  }));
}
