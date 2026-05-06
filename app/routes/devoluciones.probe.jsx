const ACTIVE_RETURN_STATUSES = ["en_revision", "aprobada", "recibida", "reembolsada", "completada"];

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

  const hasExistingReturns =
    (await prisma.returnRequest.count({
      where: {
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
        ...(shop ? { shop } : {}),
      },
    })) > 0;

  return jsonWithCors({ hasExistingReturns });
};

