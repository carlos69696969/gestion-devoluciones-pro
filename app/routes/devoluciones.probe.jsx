import { randomInt } from "node:crypto";

const ACTIVE_RETURN_STATUSES = [
  "en_revision",
  "aprobada",
  "en_ruta",
  "en_ruta_1",
  "en_ruta_2",
  "en_ruta_3",
  "reintento_pendiente",
  "intento_fallido_1",
  "intento_fallido_2",
  "intento_fallido_3",
  "recibida",
  "por_devolver",
  "reembolso_denegado",
  "no_devuelto",
  "reembolsada",
  "completada",
  "rechazada",
  "denegada",
];

const ADMIN_API_VERSION = "2025-10";
const DELIVERED_FULFILLMENT_STATUSES = new Set(["FULFILLED", "PARTIALLY_FULFILLED"]);
const DELIVERY_CODE_MIN = 100000;
const DELIVERY_CODE_MAX_EXCLUSIVE = 1000000;
const DELIVERY_CODE_GENERATION_ATTEMPTS = 30;

function jsonWithCors(data) {
  return Response.json(data, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

function normalizeOrderNumber(value) {
  return String(value || "").replace("#", "").trim();
}

function latestDeliveredAtFromOrderNode(orderNode) {
  const fulfillments = Array.isArray(orderNode?.fulfillments) ? orderNode.fulfillments : [];
  let latestMs = 0;

  for (const fulfillment of fulfillments) {
    const deliveredAt = String(fulfillment?.deliveredAt || "").trim();
    if (deliveredAt) {
      const deliveredMs = new Date(deliveredAt).getTime();
      if (Number.isFinite(deliveredMs) && deliveredMs > latestMs) latestMs = deliveredMs;
    }

    const events = Array.isArray(fulfillment?.events?.nodes) ? fulfillment.events.nodes : [];
    for (const eventNode of events) {
      if (String(eventNode?.status || "").toUpperCase() !== "DELIVERED") continue;
      const happenedAt = String(eventNode?.happenedAt || "").trim();
      if (!happenedAt) continue;
      const eventMs = new Date(happenedAt).getTime();
      if (Number.isFinite(eventMs) && eventMs > latestMs) latestMs = eventMs;
    }
  }

  if (!latestMs) return "";
  return new Date(latestMs).toISOString();
}

function deliveredByFulfillmentStatus(orderNode) {
  const status = String(orderNode?.displayFulfillmentStatus || "")
    .trim()
    .toUpperCase();
  return DELIVERED_FULFILLMENT_STATUSES.has(status);
}

async function fetchOrderCandidatesByToken({ shop, accessToken, orderNumber }) {
  const response = await fetch(`https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({
      query: `#graphql
        query FindOrder($query: String!) {
          orders(first: 5, query: $query) {
            edges {
              node {
                id
                name
                email
                createdAt
                displayFulfillmentStatus
                fulfillments {
                  deliveredAt
                  events(first: 20, reverse: true, sortKey: HAPPENED_AT) {
                    nodes {
                      status
                      happenedAt
                    }
                  }
                }
              }
            }
          }
        }`,
      variables: { query: `name:#${orderNumber}` },
    }),
  });
  const data = await response.json();
  if (!response.ok || data?.errors?.length) {
    throw new Error(
      data?.errors?.[0]?.message || `Error consultando Shopify Admin API (${response.status}).`,
    );
  }
  return data?.data?.orders?.edges?.map((edge) => edge.node) || [];
}

async function resolveDeliveryStatus({ prisma, requestedShop, orderNumber, customerEmail }) {
  const allSessions = await prisma.session.findMany({
    select: { id: true, shop: true, isOnline: true, accessToken: true },
  });
  const offlineSessions = allSessions.filter((session) => session.isOnline === false);
  const sessionShops = offlineSessions
    .map((session) => String(session.shop || "").trim().toLowerCase())
    .filter(Boolean);
  const preferredShops = requestedShop ? [requestedShop] : [];
  const preferredHasSession = preferredShops.some((candidate) =>
    allSessions.some((session) => String(session.shop || "").trim().toLowerCase() === candidate),
  );
  if (preferredShops.length && !preferredHasSession) {
    return { isDelivered: false, limitDate: "", shop: "", shopifyOrderId: "" };
  }
  const candidateShops = preferredShops.length
    ? preferredShops
    : Array.from(new Set(sessionShops));

  for (const shopCandidate of candidateShops) {
    const sessionCandidates = allSessions.filter(
      (session) => String(session.shop || "").trim().toLowerCase() === shopCandidate,
    );
    if (!sessionCandidates.length) continue;

    const canonicalOfflineId = `offline_${shopCandidate}`;
    const orderedCandidates = [
      ...sessionCandidates.filter((session) => session.id === canonicalOfflineId),
      ...sessionCandidates
        .filter((session) => session.id !== canonicalOfflineId)
        .sort((a, b) => {
          const aOffline = a.isOnline === false ? 0 : 1;
          const bOffline = b.isOnline === false ? 0 : 1;
          return aOffline - bOffline;
        }),
    ];

    let orders = [];
    for (const sessionCandidate of orderedCandidates) {
      try {
        if (!sessionCandidate.accessToken) continue;
        orders = await fetchOrderCandidatesByToken({
          shop: shopCandidate,
          accessToken: sessionCandidate.accessToken,
          orderNumber,
        });
        break;
      } catch {
        // Intentionally continue with the next session token candidate.
      }
    }
    if (!orders.length) continue;

    const exactMatches = orders.filter(
      (orderNode) => normalizeOrderNumber(orderNode?.name) === normalizeOrderNumber(orderNumber),
    );
    if (!exactMatches.length) continue;

    const match = customerEmail
      ? exactMatches.find((orderNode) => String(orderNode?.email || "").trim().toLowerCase() === customerEmail)
      : exactMatches.length === 1
        ? exactMatches[0]
        : null;
    if (!match) continue;

    const settings =
      (await prisma.returnSettings.findUnique({ where: { shop: shopCandidate } })) ||
      (await prisma.returnSettings.create({ data: { shop: shopCandidate } }));
    const deliveredAtFromEvents = latestDeliveredAtFromOrderNode(match);
    const deliveredAt =
      deliveredAtFromEvents ||
      (deliveredByFulfillmentStatus(match) ? String(match?.createdAt || "") : "");
    const deliveredMs = deliveredAt ? new Date(deliveredAt).getTime() : NaN;
    const limitDate = Number.isFinite(deliveredMs)
      ? new Date(deliveredMs + Number(settings.returnWindowDays || 0) * 24 * 60 * 60 * 1000)
      : null;

    return {
      isDelivered: Boolean(deliveredAt),
      limitDate: limitDate ? limitDate.toISOString() : "",
      shop: shopCandidate,
      shopifyOrderId: String(match?.id || "").trim(),
    };
  }

  return { isDelivered: false, limitDate: "", shop: "", shopifyOrderId: "" };
}

async function resolveDeliveryCode({ prisma, delivery, orderNumber, canDisplayCode }) {
  const resolvedShop = String(delivery?.shop || "").trim();
  const shopifyOrderId = String(delivery?.shopifyOrderId || "").trim();
  if (!resolvedShop || !shopifyOrderId) return "";

  const orderIdentity = {
    shop_shopifyOrderId: {
      shop: resolvedShop,
      shopifyOrderId,
    },
  };
  const existingAssignment = await prisma.deliveryCodeAssignment.findUnique({
    where: orderIdentity,
  });

  if (delivery?.isDelivered) {
    if (existingAssignment?.active || existingAssignment?.code) {
      await prisma.deliveryCodeAssignment.update({
        where: orderIdentity,
        data: {
          code: null,
          active: false,
          releasedAt: new Date(),
        },
      });
    }
    return "";
  }

  if (!canDisplayCode) return "";
  if (existingAssignment) {
    return existingAssignment.active ? String(existingAssignment.code || "") : "";
  }

  for (let attempt = 0; attempt < DELIVERY_CODE_GENERATION_ATTEMPTS; attempt += 1) {
    const code = String(randomInt(DELIVERY_CODE_MIN, DELIVERY_CODE_MAX_EXCLUSIVE));
    try {
      const assignment = await prisma.deliveryCodeAssignment.create({
        data: {
          shop: resolvedShop,
          shopifyOrderId,
          orderNumber,
          code,
          historicalCode: code,
        },
      });
      return String(assignment.code || "");
    } catch (error) {
      if (error?.code !== "P2002") throw error;
      const concurrentAssignment = await prisma.deliveryCodeAssignment.findUnique({
        where: orderIdentity,
      });
      if (concurrentAssignment) {
        return concurrentAssignment.active ? String(concurrentAssignment.code || "") : "";
      }
    }
  }

  throw new Error("No fue posible generar una clave de entrega unica.");
}

export const loader = async ({ request }) => {
  const { default: prisma } = await import("../db.server");
  const url = new URL(request.url);
  const orderNumber = String(url.searchParams.get("order") || "")
    .replace("#", "")
    .trim();
  const customerEmail = String(url.searchParams.get("email") || "")
    .trim()
    .toLowerCase();
  const shop = String(url.searchParams.get("shop") || "")
    .trim()
    .toLowerCase();

  if (!orderNumber) {
    return jsonWithCors({ hasExistingReturns: false, isDelivered: false, limitDate: "" });
  }

  const baseWhere = {
    orderNumber,
    status: { in: ACTIVE_RETURN_STATUSES },
    ...(customerEmail
      ? {
          customerEmail: {
            equals: customerEmail,
            mode: "insensitive",
          },
        }
      : {}),
  };

  // Prefer exact shop match when available, but fall back to cross-shop lookup.
  // Some historical requests were saved under a different myshopify domain alias.
  let hasExistingReturns = false;
  if (shop) {
    hasExistingReturns =
      (await prisma.returnRequest.count({
        where: {
          ...baseWhere,
          shop,
        },
      })) > 0;
  }
  if (!hasExistingReturns) {
    hasExistingReturns =
      (await prisma.returnRequest.count({
        where: baseWhere,
      })) > 0;
  }

  const delivery = await resolveDeliveryStatus({
    prisma,
    requestedShop: shop,
    orderNumber,
    customerEmail,
  });
  const deliveryCode = await resolveDeliveryCode({
    prisma,
    delivery,
    orderNumber,
    canDisplayCode: Boolean(customerEmail),
  });

  return jsonWithCors({
    hasExistingReturns,
    isDelivered: Boolean(delivery?.isDelivered),
    limitDate: String(delivery?.limitDate || ""),
    deliveryCode,
  });
};
