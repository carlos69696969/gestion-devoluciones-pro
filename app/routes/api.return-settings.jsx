import prisma from "../db.server";

const INTERNAL_API_KEY =
  process.env.NOTIFICATIONS_API_KEY || process.env.APP_INTERNAL_API_KEY || "";

function jsonWithCors(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-api-key, x-shop-domain",
    },
  });
}

function normalize(value) {
  return String(value || "").trim();
}

function resolveShop(request) {
  const url = new URL(request.url);
  const byQuery = normalize(url.searchParams.get("shop") || url.searchParams.get("shopDomain"));
  if (byQuery) return byQuery.toLowerCase();

  const byHeader = normalize(request.headers.get("x-shop-domain"));
  if (byHeader) return byHeader.toLowerCase();

  return "";
}

function isAuthorized(request) {
  if (!INTERNAL_API_KEY) return false;
  return normalize(request.headers.get("x-api-key")) === INTERNAL_API_KEY;
}

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, x-api-key, x-shop-domain",
      },
    });
  }

  if (!isAuthorized(request)) {
    return jsonWithCors({ ok: false, error: "No autorizado" }, 401);
  }

  const shop = resolveShop(request);
  if (!shop) {
    return jsonWithCors({ ok: false, error: "Falta shop" }, 400);
  }

  const exactSettings = await prisma.returnSettings.findUnique({
    where: { shop },
    select: {
      branchAddress: true,
      branchHours: true,
      pickupHours: true,
    },
  });
  const settings =
    exactSettings ||
    (await prisma.returnSettings.findFirst({
      where: {
        OR: [
          { branchAddress: { not: "" } },
          { branchHours: { not: "" } },
          { pickupHours: { not: "" } },
        ],
      },
      select: {
        branchAddress: true,
        branchHours: true,
        pickupHours: true,
      },
      orderBy: { updatedAt: "desc" },
    }));

  return jsonWithCors({
    ok: true,
    settings: {
      branchAddress: normalize(settings?.branchAddress),
      branchHours: normalize(settings?.branchHours),
      pickupHours: normalize(settings?.pickupHours),
    },
  });
};

export const action = loader;
