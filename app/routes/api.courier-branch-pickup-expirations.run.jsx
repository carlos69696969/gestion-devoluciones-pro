import { refundExpiredBranchPickupOrdersForAllShops } from "../utils/courierBranchPickupExpirationScheduler.server";

const INTERNAL_API_KEYS = [
  process.env.CRON_SECRET,
  process.env.APP_INTERNAL_API_KEY,
  process.env.NOTIFICATIONS_API_KEY,
]
  .map(normalize)
  .filter(Boolean);

function normalize(value) {
  return String(value || "").trim();
}

function jsonWithCors(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
    },
  });
}

function isAuthorized(request) {
  const requestApiKey = normalize(request.headers.get("x-api-key"));
  const authorization = normalize(request.headers.get("authorization"));
  const bearer = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
  const providedKey = requestApiKey || bearer;
  if (!INTERNAL_API_KEYS.length || !providedKey) return false;
  return INTERNAL_API_KEYS.includes(providedKey);
}

async function run(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
      },
    });
  }

  if (!isAuthorized(request)) {
    return jsonWithCors({ ok: false, error: "No autorizado" }, 401);
  }

  const result = await refundExpiredBranchPickupOrdersForAllShops({ logger: console });
  return jsonWithCors({ ok: true, result });
}

export const loader = async ({ request }) => run(request);
export const action = async ({ request }) => run(request);
