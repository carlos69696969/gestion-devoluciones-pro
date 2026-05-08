const ACTIVE_RETURN_STATUSES = [
  "en_revision",
  "aprobada",
  "intento_fallido_1",
  "intento_fallido_2",
  "recibida",
  "por_devolver",
  "reembolsada",
  "completada",
  "rechazada",
  "denegada",
];

const ADMIN_API_VERSION = "2025-10";

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
  const candidateShops = preferredShops.length
    ? (preferredHasSession ? preferredShops : Array.from(new Set([...preferredShops, ...sessionShops])))
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
    const createdAt = new Date(match.createdAt);
    const limitDate = Number.isFinite(createdAt.getTime())
      ? new Date(createdAt.getTime() + Number(settings.returnWindowDays || 0) * 24 * 60 * 60 * 1000)
      : null;

    return {
      isDelivered: String(match.displayFulfillmentStatus || "").toUpperCase() === "FULFILLED",
      limitDate: limitDate ? limitDate.toISOString() : "",
    };
  }

  return { isDelivered: false, limitDate: "" };
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

  return jsonWithCors({
    hasExistingReturns,
    isDelivered: Boolean(delivery?.isDelivered),
    limitDate: String(delivery?.limitDate || ""),
  });
};
