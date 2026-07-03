import prisma from "../db.server";

const INTERNAL_API_KEYS = [
  process.env.NOTIFICATIONS_API_KEY,
  process.env.APP_INTERNAL_API_KEY,
]
  .map(normalize)
  .filter(Boolean);

function jsonWithCors(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-api-key, x-shop-domain",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
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
  const requestApiKey = normalize(request.headers.get("x-api-key"));
  if (!INTERNAL_API_KEYS.length || !requestApiKey) return false;
  return INTERNAL_API_KEYS.includes(requestApiKey);
}

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, x-api-key, x-shop-domain",
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
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

  const latestSettings = await prisma.returnSettings.findFirst({
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
  });
  const exactSettings = await prisma.returnSettings.findUnique({
    where: { shop },
    select: {
      branchAddress: true,
      branchHours: true,
      pickupHours: true,
    },
  });
  const settings = exactSettings || latestSettings;

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
