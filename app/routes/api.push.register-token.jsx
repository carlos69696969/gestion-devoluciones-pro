import prisma from "../db.server";

function jsonWithCors(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

function normalize(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return normalize(value).toLowerCase();
}

function resolveShop(payload, request) {
  const byPayload = normalize(payload?.shop);
  if (byPayload) return byPayload.toLowerCase();

  const byHeader = normalize(request.headers.get("x-shop-domain"));
  if (byHeader) return byHeader.toLowerCase();

  const byEnv = normalize(process.env.SHOPIFY_SHOP_DOMAIN || process.env.SHOPIFY_SHOP || "");
  if (byEnv) return byEnv.toLowerCase();

  return "";
}

export const loader = async () =>
  jsonWithCors({ ok: false, error: "Method not allowed" }, 405);

export const action = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (request.method !== "POST") {
    return jsonWithCors({ ok: false, error: "Method not allowed" }, 405);
  }

  let payload = {};
  try {
    payload = await request.json();
  } catch {
    return jsonWithCors({ ok: false, error: "JSON invalido" }, 400);
  }

  const token = normalize(payload?.token);
  const shop = resolveShop(payload, request);
  const customerId = normalize(payload?.user_id);
  const customerEmail = normalizeEmail(payload?.user_email);
  const platform = normalize(payload?.platform || "android").toLowerCase();
  const packageName = normalize(payload?.package_name);
  const androidVersion = normalize(payload?.android_version);
  const deviceId = normalize(payload?.device_id);

  if (!token || token.length < 20) {
    return jsonWithCors({ ok: false, error: "Token FCM invalido" }, 400);
  }

  if (!shop) {
    return jsonWithCors(
      {
        ok: false,
        error: "No se pudo resolver la tienda (shop)",
      },
      400,
    );
  }

  const saved = await prisma.pushDevice.upsert({
    where: { token },
    update: {
      shop,
      customerId: customerId || null,
      customerEmail: customerEmail || null,
      platform: platform || "android",
      packageName: packageName || null,
      androidVersion: androidVersion || null,
      deviceId: deviceId || null,
      isActive: true,
      lastSeenAt: new Date(),
    },
    create: {
      shop,
      token,
      customerId: customerId || null,
      customerEmail: customerEmail || null,
      platform: platform || "android",
      packageName: packageName || null,
      androidVersion: androidVersion || null,
      deviceId: deviceId || null,
      isActive: true,
      lastSeenAt: new Date(),
    },
    select: {
      id: true,
      shop: true,
      customerId: true,
      customerEmail: true,
      platform: true,
      updatedAt: true,
    },
  });

  return jsonWithCors({
    ok: true,
    device: saved,
  });
};
