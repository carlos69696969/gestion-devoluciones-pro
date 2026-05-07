const ACTIVE_RETURN_STATUSES = [
  "en_revision",
  "aprobada",
  "intento_fallido_1",
  "intento_fallido_2",
  "recibida",
  "reembolsada",
  "completada",
  "rechazada",
  "denegada",
];

function jsonWithCors(data) {
  return Response.json(data, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
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
    return jsonWithCors({ hasExistingReturns: false });
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

  return jsonWithCors({ hasExistingReturns });
};
