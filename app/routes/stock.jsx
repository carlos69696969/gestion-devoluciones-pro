import { useEffect, useMemo, useRef, useState } from "react";
import {
  Form,
  redirect,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useRevalidator,
  useSearchParams,
  useSubmit,
} from "react-router";
import prisma from "../db.server";
import { ensureStockUserTable } from "../utils/stockUsers.server";
import styles from "../styles/stock.module.css";

const MAX_STOCK_PHOTOS = 16;
const MAX_STOCK_PHOTO_CHARS = 1_250_000;
const ADMIN_API_VERSION = "2025-10";
const STOCK_PUBLICATION_LOCK_MS = 2 * 60 * 1000;
const STOCK_PUBLICATION_REFRESH_MS = 5000;
const STOCK_PUBLICATION_HEARTBEAT_MS = 30000;
const STOCK_CAPTURE_DRAFT_VERSION = 1;
const STOCK_TIME_ZONE = "America/Mexico_City";
const STOCK_USER_ROLES = {
  PREPARER: "preparador_stock",
  PUBLISHER: "publicador_productos",
};
const STOCK_ALPHA_SIZES = ["XS", "S", "M", "L", "XL", "XXL", "XXXL"];
const STOCK_WOMEN_BOTTOM_SIZES = ["1", "3", "5", "7", "9", "11", "13", "15", "17", "19", "21", "23"];
const STOCK_WOMEN_SHOE_SIZES = [
  "21.5",
  "22",
  "22.5",
  "23",
  "23.5",
  "24",
  "24.5",
  "25",
  "25.5",
  "26",
  "26.5",
  "27",
  "27.5",
  "28",
];
const STOCK_MEN_BOTTOM_SIZES = ["26", "28", "30", "32", "34", "36", "38", "40", "42", "44", "46", "48"];
const STOCK_MEN_SHOE_SIZES = [
  "24.5",
  "25",
  "25.5",
  "26",
  "26.5",
  "27",
  "27.5",
  "28",
  "28.5",
  "29",
  "29.5",
  "30",
  "30.5",
  "31",
];
const STOCK_AUDIENCES = [
  { value: "hombre", label: "Hombre", code: "H" },
  { value: "mujer", label: "Mujer", code: "M" },
];
const STOCK_GARMENTS = [
  { value: "playera", label: "Playera", code: "PL", section: "Parte superior", audiences: ["hombre", "mujer"] },
  { value: "camisa", label: "Camisa", code: "CA", section: "Parte superior", audiences: ["hombre", "mujer"] },
  { value: "chamarra", label: "Chamarra", code: "CH", section: "Parte superior", audiences: ["hombre", "mujer"] },
  { value: "sudadera", label: "Sudadera", code: "SU", section: "Parte superior", audiences: ["mujer"] },
  { value: "chaleco", label: "Chaleco", code: "CL", section: "Parte superior", audiences: ["mujer"] },
  { value: "sueter", label: "Sueter", code: "ST", section: "Parte superior", audiences: ["hombre", "mujer"] },
  { value: "blusa", label: "Blusa", code: "BL", section: "Parte superior", audiences: ["mujer"] },
  { value: "pantalon", label: "Pantalon", code: "PA", section: "Parte inferior", audiences: ["hombre", "mujer"] },
  { value: "short", label: "Short", code: "SH", section: "Parte inferior", audiences: ["hombre", "mujer"] },
  { value: "falda", label: "Falda", code: "FA", section: "Parte inferior", audiences: ["mujer"] },
  { value: "vestido", label: "Vestido", code: "VE", section: "Parte superior e inferior", audiences: ["mujer"] },
  { value: "conjunto", label: "Conjunto", code: "CO", section: "Parte superior e inferior", audiences: ["hombre", "mujer"] },
  { value: "tenis", label: "Tenis", code: "TE", section: "Calzado", audiences: ["hombre", "mujer"] },
];

function cleanShop(value) {
  return String(value || "").trim().toLowerCase();
}

function isMyShopifyDomain(value) {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(String(value || "").trim());
}

function portalShopFromRequest(request) {
  const url = new URL(request.url);
  return cleanShop(url.searchParams.get("shop")) || cleanShop(process.env.SHOPIFY_SHOP_DOMAIN) || "portal-stock";
}

async function resolveStockShopSessions(shop) {
  const requestedShop = cleanShop(shop);
  const configuredShop = cleanShop(process.env.SHOPIFY_SHOP_DOMAIN);
  const allSessions = await prisma.session.findMany({
    select: { id: true, shop: true, isOnline: true, accessToken: true, scope: true },
  });
  const candidateShops = Array.from(
    new Set(
      [requestedShop, configuredShop, ...allSessions.map((session) => cleanShop(session.shop))]
        .filter(Boolean)
        .filter(isMyShopifyDomain),
    ),
  );
  const sessions = [];
  for (const candidateShop of candidateShops) {
    const canonicalOfflineId = `offline_${candidateShop}`;
    const matches = allSessions
      .filter((session) => cleanShop(session.shop) === candidateShop && session.accessToken)
      .sort((first, second) => {
        if (first.id === canonicalOfflineId) return -1;
        if (second.id === canonicalOfflineId) return 1;
        if (first.isOnline === false && second.isOnline !== false) return -1;
        if (second.isOnline === false && first.isOnline !== false) return 1;
        return 0;
      });
    for (const session of matches) {
      sessions.push({ shop: candidateShop, accessToken: String(session.accessToken || "").trim() });
    }
  }
  return sessions.filter((session) => session.shop && session.accessToken);
}

async function shopifyStockGraphql({ shop, accessToken, query, variables }) {
  const response = await fetch(`https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.errors?.length) {
    throw new Error(payload?.errors?.[0]?.message || `No se pudo consultar inventario (${response.status}).`);
  }
  return payload.data;
}

async function fetchShopifyInventoryQuantityBySku({ sessions, sku }) {
  const cleanSku = String(sku || "").trim();
  if (!cleanSku || !sessions.length) return null;
  let lastError = null;
  for (const session of sessions) {
    try {
      const data = await shopifyStockGraphql({
        shop: session.shop,
        accessToken: session.accessToken,
        query: `#graphql
          query StockVariantInventoryBySku($query: String!) {
            productVariants(first: 20, query: $query) {
              nodes {
                sku
                inventoryQuantity
              }
            }
          }`,
        variables: { query: `sku:${cleanSku}` },
      });
      const variants = data?.productVariants?.nodes || [];
      const matchingVariants = variants.filter(
        (variant) => String(variant?.sku || "").trim().toLowerCase() === cleanSku.toLowerCase(),
      );
      if (!matchingVariants.length) return null;
      return matchingVariants.reduce((sum, variant) => sum + (Number(variant.inventoryQuantity) || 0), 0);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}

async function syncReleasedStockLocations(shop) {
  const cleanShopDomain = cleanShop(shop);
  if (!cleanShopDomain) return;
  const publishedDrafts = await prisma.stockProductDraft.findMany({
    where: {
      shop: cleanShopDomain,
      status: "listo",
      locationReleasedAt: null,
      sku: { not: null },
      locationCode: { not: null },
    },
    select: { id: true, sku: true },
    orderBy: [{ publishedAt: "asc" }, { id: "asc" }],
    take: 60,
  });
  if (!publishedDrafts.length) return;
  const sessions = await resolveStockShopSessions(cleanShopDomain);
  if (!sessions.length) return;
  for (const draft of publishedDrafts) {
    const quantity = await fetchShopifyInventoryQuantityBySku({ sessions, sku: draft.sku }).catch((error) => {
      console.error("No se pudo consultar inventario de stock", { sku: draft.sku, error });
      return null;
    });
    if (quantity === null || quantity > 0) continue;
    await prisma.stockProductDraft.updateMany({
      where: { id: draft.id, shop: cleanShopDomain, locationReleasedAt: null },
      data: { locationReleasedAt: new Date() },
    });
  }
}

async function clearExpiredStockPublicationLocks(shop) {
  const cleanShopDomain = cleanShop(shop);
  if (!cleanShopDomain) return;
  await prisma.stockProductDraft.updateMany({
    where: {
      shop: cleanShopDomain,
      status: "pendiente",
      publishingLockedAt: { lt: new Date(Date.now() - STOCK_PUBLICATION_LOCK_MS) },
    },
    data: {
      publishingLockedByStockUserId: null,
      publishingLockedAt: null,
    },
  });
}

function sanitizeText(value, maxLength = 180) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeAudience(value) {
  const cleanValue = String(value || "").trim().toLowerCase();
  return STOCK_AUDIENCES.some((audience) => audience.value === cleanValue) ? cleanValue : STOCK_AUDIENCES[0].value;
}

function normalizeGarment(value) {
  const cleanValue = String(value || "").trim().toLowerCase();
  return STOCK_GARMENTS.some((garment) => garment.value === cleanValue) ? cleanValue : STOCK_GARMENTS[0].value;
}

function audienceConfig(value) {
  return STOCK_AUDIENCES.find((audience) => audience.value === normalizeAudience(value)) || STOCK_AUDIENCES[0];
}

function garmentConfig(value) {
  return STOCK_GARMENTS.find((garment) => garment.value === normalizeGarment(value)) || STOCK_GARMENTS[0];
}

function stockSizesFor(audience, garment) {
  const currentAudience = normalizeAudience(audience);
  const currentGarment = garmentConfig(garment);
  if (currentAudience === "mujer" && currentGarment.section === "Parte inferior") {
    return STOCK_WOMEN_BOTTOM_SIZES;
  }
  if (currentAudience === "mujer" && currentGarment.section === "Calzado") {
    return STOCK_WOMEN_SHOE_SIZES;
  }
  if (currentAudience === "hombre" && currentGarment.section === "Parte inferior") {
    return STOCK_MEN_BOTTOM_SIZES;
  }
  if (currentAudience === "hombre" && currentGarment.section === "Calzado") {
    return STOCK_MEN_SHOE_SIZES;
  }
  return STOCK_ALPHA_SIZES;
}

function stockSkuPrefix(audience, garment) {
  return `${audienceConfig(audience).code}-${garmentConfig(garment).code}`;
}

function nextStockSkuForPrefix(prefix, existingSkus = []) {
  const matcher = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`, "i");
  const usedNumbers = new Set();
  const highestNumber = existingSkus.reduce((highest, sku) => {
    const match = String(sku || "").trim().match(matcher);
    const number = match ? Number(match[1] || 0) : 0;
    if (number >= 1 && number <= 10000) usedNumbers.add(number);
    return number ? Math.max(highest, number) : highest;
  }, 0);
  const nextNumber = highestNumber < 10000 ? highestNumber + 1 : 1;
  for (let number = nextNumber; number <= 10000; number += 1) {
    if (!usedNumbers.has(number)) return `${prefix}-${String(number).padStart(2, "0")}`;
  }
  for (let number = 1; number < nextNumber; number += 1) {
    if (!usedNumbers.has(number)) return `${prefix}-${String(number).padStart(2, "0")}`;
  }
  return `${prefix}-10000`;
}

function defaultStockLocation(audience, garment) {
  return `${audienceConfig(audience).label}-${garmentConfig(garment).label}-A1`;
}

function nextStockLocation(currentLocation, audience, garment) {
  const defaultLocation = defaultStockLocation(audience, garment);
  const match = String(currentLocation || "").trim().toUpperCase().match(/-([A-Z])(\d+)$/);
  const currentLetter = match?.[1] || "A";
  const currentRound = Math.max(1, Number(match?.[2] || 1));
  if (currentLetter === "Z") {
    return `${audienceConfig(audience).label}-${garmentConfig(garment).label}-A${currentRound + 1}`;
  }
  const nextLetter = String.fromCharCode(currentLetter.charCodeAt(0) + 1);
  return defaultLocation.replace(/-[A-Z]\d+$/, `-${nextLetter}${currentRound}`);
}

function stockLabels() {
  return {
    audiences: Object.fromEntries(STOCK_AUDIENCES.map((audience) => [audience.value, audience.label])),
    garments: Object.fromEntries(STOCK_GARMENTS.map((garment) => [garment.value, garment.label])),
  };
}

function stockUserRoleLabel(role) {
  return role === STOCK_USER_ROLES.PUBLISHER ? "Publicador de productos" : "Preparador de stock";
}

function stockMexicoDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: STOCK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const partMap = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${partMap.year}-${partMap.month}-${partMap.day}`;
}

function stockMexicoDateTimeParts(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return { dateKey: "", minutes: -1 };
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: STOCK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const partMap = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const hour = Number(partMap.hour || 0);
  const minute = Number(partMap.minute || 0);
  return {
    dateKey: `${partMap.year}-${partMap.month}-${partMap.day}`,
    minutes: hour * 60 + minute,
  };
}

function normalizeStockLogoutTime(value) {
  const cleanValue = String(value || "").trim();
  return /^([01]\d|2[0-3]):00$/.test(cleanValue) ? cleanValue : "";
}

function stockLogoutMinutes(value) {
  const [hour = "0", minute = "0"] = String(value || "").split(":");
  return Number(hour || 0) * 60 + Number(minute || 0);
}

function stockAutoLogoutKey(shop, logoutTime, dateKey) {
  return `cariana-stock-auto-logout:${cleanShop(shop) || "portal-stock"}:${logoutTime}:${dateKey}`;
}

function formatStockHistoryTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: STOCK_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function sanitizePhotoDataUrl(value) {
  const photo = String(value || "").trim();
  if (!photo.startsWith("data:image/")) return "";
  if (photo.length > MAX_STOCK_PHOTO_CHARS) return "";
  return photo;
}

function sanitizeStockVariants(value, allowedSizes = STOCK_ALPHA_SIZES) {
  let parsed = [];
  try {
    parsed = JSON.parse(String(value || "[]"));
  } catch (_error) {
    parsed = [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((variant) => {
      const color = sanitizeText(variant?.color, 80);
      const price = Math.max(0, Number(variant?.price || 0) || 0);
      const sizes = (Array.isArray(variant?.sizes) ? variant.sizes : [])
        .map((sizeRow) => ({
          size: allowedSizes.includes(String(sizeRow?.size || "").trim().toUpperCase())
            ? String(sizeRow.size).trim().toUpperCase()
            : "",
          quantity: Math.max(1, Math.min(9999, Number(sizeRow?.quantity || 0) || 0)),
        }))
        .filter((sizeRow) => sizeRow.size && sizeRow.quantity);
      return { color, price, sizes };
    })
    .filter((variant) => variant.color && variant.sizes.length);
}

function serializeDraft(draft, currentStockUserId = 0) {
  const variants = Array.isArray(draft.variants) ? draft.variants : [];
  const lockedByUserId = Number(draft.publishingLockedByStockUserId || 0);
  const isLockedByCurrentUser = Boolean(lockedByUserId && lockedByUserId === Number(currentStockUserId || 0));
  return {
    id: draft.id,
    productName: draft.productName,
    color: draft.color || "",
    size: draft.size || "",
    quantity: draft.quantity,
    sku: draft.sku || "",
    audience: draft.audience || "",
    audienceLabel: stockLabels().audiences[draft.audience] || "",
    garmentType: draft.garmentType || "",
    garmentLabel: stockLabels().garments[draft.garmentType] || "",
    locationCode: draft.locationCode || "",
    price: draft.price,
    notes: draft.notes || "",
    photos: Array.isArray(draft.photos) ? draft.photos : [],
    variants,
    status: draft.status,
    publishingLockedByStockUserId: lockedByUserId,
    publishingLockedAt: draft.publishingLockedAt ? draft.publishingLockedAt.toISOString() : "",
    isLockedByCurrentUser,
    isLockedByOther: Boolean(lockedByUserId && !isLockedByCurrentUser),
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
  };
}

function serializeStockUser(stockUser) {
  if (!stockUser) return null;
  return {
    id: stockUser.id,
    name: stockUser.name,
    role: stockUser.role,
  };
}

function generateStockSessionToken() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

async function generateUniqueStockCode(shop, excludeUserId = 0) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const existingUser = await prisma.stockUser.findFirst({
      where: {
        shop,
        code,
        ...(excludeUserId ? { NOT: { id: excludeUserId } } : {}),
      },
      select: { id: true },
    });
    if (!existingUser) return code;
  }
  return "";
}

function serializePreparedStockHistory(draft) {
  return {
    id: draft.id,
    sku: draft.sku || "",
    locationCode: draft.locationCode || "",
    quantity: Math.max(1, Number(draft.quantity || 0) || 1),
    createdAt: draft.createdAt.toISOString(),
    time: formatStockHistoryTime(draft.createdAt),
  };
}

export const headers = () => ({
  "Cache-Control": "no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow",
});

export async function loader({ request }) {
  const url = new URL(request.url);
  const shop = portalShopFromRequest(request);
  const accessCode = String(url.searchParams.get("codigo") || url.searchParams.get("code") || "").trim();
  const sessionToken = String(url.searchParams.get("sesion") || url.searchParams.get("session") || "").trim();
  let drafts = [];
  let skuRows = [];
  let locationRows = [];
  let releasedLocationRows = [];
  let preparedHistoryRows = [];
  let stockSettings = null;
  let error = "";
  let stockUser = null;
  try {
    if (accessCode || sessionToken) await ensureStockUserTable(prisma);
    if (sessionToken) {
      stockUser = await prisma.stockUser.findFirst({
        where: { shop, sessionToken, active: true },
      });
      if (stockUser) {
        await prisma.stockUser.update({
          where: { id: stockUser.id },
          data: { sessionLastSeenAt: new Date() },
        });
      } else {
        error = "Tu sesion ya no esta activa. Ingresa tu codigo nuevamente.";
      }
    } else if (accessCode) {
      stockUser = await prisma.stockUser.findFirst({
        where: { shop, code: accessCode, active: true, sessionToken: null },
      });
      if (stockUser) {
        const nextSessionToken = generateStockSessionToken();
        await prisma.stockUser.update({
          where: { id: stockUser.id },
          data: {
            sessionToken: nextSessionToken,
            sessionStartedAt: new Date(),
            sessionLastSeenAt: new Date(),
          },
        });
        return redirect(`/stock?shop=${encodeURIComponent(shop)}&sesion=${encodeURIComponent(nextSessionToken)}`);
      }
      error = "Codigo invalido o la cuenta ya inicio sesion.";
    }

    if (stockUser) {
      await syncReleasedStockLocations(shop);
      await clearExpiredStockPublicationLocks(shop);
      [drafts, skuRows, locationRows, releasedLocationRows, preparedHistoryRows, stockSettings] = await Promise.all([
        prisma.stockProductDraft.findMany({
          where: { shop, status: "pendiente" },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: 80,
        }),
        prisma.stockProductDraft.findMany({
          where: { shop },
          select: { sku: true },
        }),
        prisma.stockLocationState.findMany({
          where: { shop },
        }),
        prisma.stockProductDraft.findMany({
          where: {
            shop,
            locationReleasedAt: { not: null },
            locationReusedAt: null,
            locationCode: { not: null },
          },
          select: { audience: true, garmentType: true, locationCode: true },
          orderBy: [{ locationReleasedAt: "asc" }, { id: "asc" }],
        }),
        stockUser.role === STOCK_USER_ROLES.PREPARER
          ? prisma.stockProductDraft.findMany({
              where: {
                shop,
                preparedByStockUserId: stockUser.id,
                createdAt: { gte: new Date(Date.now() - 48 * 60 * 60 * 1000) },
              },
              select: { id: true, sku: true, locationCode: true, quantity: true, createdAt: true },
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: 120,
            })
          : Promise.resolve([]),
        prisma.returnSettings.findUnique({
          where: { shop },
          select: { stockLogoutTime: true },
        }),
      ]);
    }
  } catch (loadError) {
    console.error("No se pudo cargar portal stock", loadError);
    error = "El almacenamiento de stock se esta preparando. Actualiza la pagina en un momento.";
  }
  const existingSkus = skuRows.map((row) => row.sku).filter(Boolean);
  const nextSkuByCategory = Object.fromEntries(
    STOCK_AUDIENCES.flatMap((audience) =>
      STOCK_GARMENTS.map((garment) => {
        const prefix = stockSkuPrefix(audience.value, garment.value);
        return [`${audience.value}:${garment.value}`, nextStockSkuForPrefix(prefix, existingSkus)];
      }),
    ),
  );
  const locationByCategory = Object.fromEntries(
    STOCK_AUDIENCES.flatMap((audience) =>
      STOCK_GARMENTS.map((garment) => {
        const releasedLocation = releasedLocationRows.find(
          (row) => row.audience === audience.value && row.garmentType === garment.value,
        )?.locationCode;
        const location = locationRows.find(
          (row) => row.audience === audience.value && row.garmentType === garment.value,
        )?.currentLocation;
        return [
          `${audience.value}:${garment.value}`,
          releasedLocation || location || defaultStockLocation(audience.value, garment.value),
        ];
      }),
    ),
  );

  return {
    shop,
    drafts: drafts.map((draft) => serializeDraft(draft, stockUser?.id)),
    preparedHistory: preparedHistoryRows
      .filter((draft) => stockMexicoDateKey(draft.createdAt) === stockMexicoDateKey(new Date()))
      .map(serializePreparedStockHistory),
    stockUser: serializeStockUser(stockUser),
    accessCode: stockUser ? sessionToken || accessCode : "",
    sessionToken: stockUser ? sessionToken || "" : "",
    audiences: STOCK_AUDIENCES,
    garments: STOCK_GARMENTS,
    nextSkuByCategory,
    locationByCategory,
    stockLogoutTime: normalizeStockLogoutTime(stockSettings?.stockLogoutTime),
    error,
  };
}

export async function action({ request }) {
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "").trim();
  const shop = cleanShop(formData.get("shop")) || portalShopFromRequest(request);
  const stockCode = String(formData.get("stockCode") || "").trim();
  const stockPortalHref = (params = "") =>
    `/stock?shop=${encodeURIComponent(shop)}${stockCode ? `&sesion=${encodeURIComponent(stockCode)}` : ""}${params}`;

  if (intent === "stock_login") {
    try {
      await ensureStockUserTable(prisma);
      const code = String(formData.get("code") || "").trim();
      if (!/^\d{6}$/.test(code)) return { ok: false, error: "Escribe tu codigo de 6 digitos." };
      const stockUser = await prisma.stockUser.findFirst({
        where: { shop, code, active: true },
        select: { id: true, sessionToken: true },
      });
      if (!stockUser) return { ok: false, error: "Codigo invalido. Revisa el codigo con el administrador." };
      if (stockUser.sessionToken) {
        return { ok: false, error: "Esta cuenta ya inicio sesion." };
      }
      const sessionToken = generateStockSessionToken();
      await prisma.stockUser.update({
        where: { id: stockUser.id },
        data: {
          sessionToken,
          sessionStartedAt: new Date(),
          sessionLastSeenAt: new Date(),
        },
      });
      return redirect(`/stock?shop=${encodeURIComponent(shop)}&sesion=${encodeURIComponent(sessionToken)}`);
    } catch (stockLoginError) {
      console.error("No se pudo validar el codigo de stock", stockLoginError);
      return { ok: false, error: "No se pudo validar el codigo. Intenta nuevamente." };
    }
  }

  if (stockCode) await ensureStockUserTable(prisma);
  const stockUser = stockCode
    ? await prisma.stockUser.findFirst({
        where: { shop, sessionToken: stockCode, active: true },
        select: { id: true, role: true },
      })
    : null;

  if (intent === "stock_logout") {
    if (!stockUser) return redirect(`/stock?shop=${encodeURIComponent(shop)}`);
    try {
      const nextCode = await generateUniqueStockCode(shop, stockUser.id);
      await prisma.stockUser.update({
        where: { id: stockUser.id },
        data: {
          ...(nextCode ? { code: nextCode } : {}),
          sessionToken: null,
          sessionStartedAt: null,
          sessionLastSeenAt: null,
        },
      });
    } catch (stockLogoutError) {
      console.error("No se pudo cerrar la sesion de stock", stockLogoutError);
    }
    return redirect(`/stock?shop=${encodeURIComponent(shop)}`);
  }

  if (stockUser) await clearExpiredStockPublicationLocks(shop);

  if (intent === "advance_stock_location") {
    if (stockUser?.role !== STOCK_USER_ROLES.PREPARER) {
      return { ok: false, error: "Solo un preparador de stock puede avanzar ubicaciones." };
    }
    const audience = normalizeAudience(formData.get("audience"));
    const garmentType = normalizeGarment(formData.get("garmentType"));
    const currentLocation =
      sanitizeText(formData.get("currentLocation"), 80) || defaultStockLocation(audience, garmentType);
    const nextLocation = nextStockLocation(currentLocation, audience, garmentType);
    await prisma.stockLocationState.upsert({
      where: { shop_audience_garmentType: { shop, audience, garmentType } },
      create: { shop, audience, garmentType, currentLocation: nextLocation },
      update: { currentLocation: nextLocation },
    });
    return redirect(stockPortalHref());
  }

  if (intent === "lock_stock_draft") {
    if (stockUser?.role !== STOCK_USER_ROLES.PUBLISHER) {
      return { ok: false, error: "Solo un publicador de productos puede tomar productos." };
    }
    const draftId = Number(formData.get("draftId") || 0);
    if (!draftId) return { ok: false, error: "Producto de stock invalido." };
    const lockCutoff = new Date(Date.now() - STOCK_PUBLICATION_LOCK_MS);
    const lockedDraft = await prisma.stockProductDraft.updateMany({
      where: {
        id: draftId,
        shop,
        status: "pendiente",
        OR: [
          { publishingLockedByStockUserId: null },
          { publishingLockedByStockUserId: stockUser.id },
          { publishingLockedAt: { lt: lockCutoff } },
        ],
      },
      data: {
        publishingLockedByStockUserId: stockUser.id,
        publishingLockedAt: new Date(),
      },
    });
    if (!lockedDraft.count) {
      return { ok: false, error: "Esta orden ya esta siendo trabajada." };
    }
    return { ok: true, draftId };
  }

  if (intent === "release_stock_draft") {
    if (stockUser?.role !== STOCK_USER_ROLES.PUBLISHER) {
      return { ok: false, error: "Solo un publicador de productos puede soltar productos." };
    }
    const draftId = Number(formData.get("draftId") || 0);
    if (!draftId) return { ok: false, error: "Producto de stock invalido." };
    await prisma.stockProductDraft.updateMany({
      where: {
        id: draftId,
        shop,
        status: "pendiente",
        publishingLockedByStockUserId: stockUser.id,
      },
      data: {
        publishingLockedByStockUserId: null,
        publishingLockedAt: null,
      },
    });
    return { ok: true, draftId };
  }

  if (intent === "publish_stock_draft") {
    if (stockUser?.role !== STOCK_USER_ROLES.PUBLISHER) {
      return { ok: false, error: "Solo un publicador de productos puede marcar productos como listos." };
    }
    const draftId = Number(formData.get("draftId") || 0);
    if (!draftId) return { ok: false, error: "Producto de stock invalido." };
    const updatedDraft = await prisma.stockProductDraft.updateMany({
      where: {
        id: draftId,
        shop,
        status: "pendiente",
        publishingLockedByStockUserId: stockUser.id,
      },
      data: {
        status: "listo",
        photos: [],
        publishedByStockUserId: stockUser.id,
        publishedAt: new Date(),
        publishingLockedByStockUserId: null,
        publishingLockedAt: null,
      },
    });
    if (!updatedDraft.count) {
      return { ok: false, error: "Toma este producto antes de marcarlo como listo." };
    }
    return redirect(stockPortalHref("&publicado=1"));
  }

  if (intent !== "create_stock_draft") {
    return { ok: false, error: "Accion no reconocida." };
  }

  if (stockUser?.role !== STOCK_USER_ROLES.PREPARER) {
    return { ok: false, error: "Solo un preparador de stock puede guardar productos." };
  }

  const audience = normalizeAudience(formData.get("audience"));
  const garmentType = normalizeGarment(formData.get("garmentType"));
  const productName = sanitizeText(formData.get("productName")) || garmentConfig(garmentType).label;
  const variants = sanitizeStockVariants(formData.get("variants"), stockSizesFor(audience, garmentType));
  if (!variants.length) return { ok: false, error: "Agrega color y al menos una talla con cantidad." };
  const quantity = variants.reduce(
    (sum, variant) => sum + variant.sizes.reduce((sizeSum, sizeRow) => sizeSum + sizeRow.quantity, 0),
    0,
  );
  const firstVariant = variants[0] || {};
  const firstSize = firstVariant.sizes?.[0] || {};
  const price = Math.max(0, Number(firstVariant.price || 0) || 0);
  const photos = formData
    .getAll("photos")
    .map(sanitizePhotoDataUrl)
    .filter(Boolean)
    .slice(0, MAX_STOCK_PHOTOS);
  const existingSkus = (
    await prisma.stockProductDraft.findMany({
      where: { shop },
      select: { sku: true },
    })
  )
    .map((row) => row.sku)
    .filter(Boolean);
  const sku = nextStockSkuForPrefix(stockSkuPrefix(audience, garmentType), existingSkus);
  await syncReleasedStockLocations(shop);
  const releasedLocationDraft = await prisma.stockProductDraft.findFirst({
    where: {
      shop,
      audience,
      garmentType,
      locationReleasedAt: { not: null },
      locationReusedAt: null,
      locationCode: { not: null },
    },
    select: { id: true, locationCode: true },
    orderBy: [{ locationReleasedAt: "asc" }, { id: "asc" }],
  });
  const locationState = await prisma.stockLocationState.findUnique({
    where: { shop_audience_garmentType: { shop, audience, garmentType } },
  });
  const locationCode =
    releasedLocationDraft?.locationCode || locationState?.currentLocation || defaultStockLocation(audience, garmentType);
  const nextLocation = nextStockLocation(locationCode, audience, garmentType);

  const stockWriteOperations = [
    prisma.stockProductDraft.create({
      data: {
        shop,
        productName,
        audience,
        garmentType,
        locationCode,
        color: firstVariant.color || null,
        size: firstSize.size || null,
        quantity,
        sku,
        price,
        notes: sanitizeText(formData.get("notes"), 600) || null,
        photos,
        variants,
        status: "pendiente",
        preparedByStockUserId: stockUser.id,
      },
    }),
  ];
  if (releasedLocationDraft) {
    stockWriteOperations.push(
      prisma.stockProductDraft.update({
        where: { id: releasedLocationDraft.id },
        data: { locationReusedAt: new Date() },
      }),
    );
  } else {
    stockWriteOperations.push(
      prisma.stockLocationState.upsert({
        where: { shop_audience_garmentType: { shop, audience, garmentType } },
        create: { shop, audience, garmentType, currentLocation: nextLocation },
        update: { currentLocation: nextLocation },
      }),
    );
  }

  await prisma.$transaction(stockWriteOperations);

  return redirect(
    stockPortalHref(
      `&guardado=1&sku=${encodeURIComponent(sku)}&ubicacion=${encodeURIComponent(locationCode)}&cantidad=${encodeURIComponent(
        String(quantity),
      )}`,
    ),
  );
}

function money(value) {
  return new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: "MXN",
  }).format(Number(value || 0));
}

function blankStockVariant(id = "variant-1") {
  return {
    id,
    color: "",
    price: "",
    sizes: [],
    sizeMenuOpen: false,
    selectedSize: "",
    quantityDraft: "",
    pendingDeleteSize: "",
  };
}

function stockCaptureDraftKey(shop) {
  return `cariana-stock-capture-draft:${cleanShop(shop) || "portal-stock"}`;
}

function stockSessionStorageKey(shop) {
  return `cariana-stock-session:${cleanShop(shop) || "portal-stock"}`;
}

function stockPublisherDraftKey(shop, accessCode) {
  return `cariana-stock-publisher-draft:${cleanShop(shop) || "portal-stock"}:${String(accessCode || "").trim()}`;
}

function normalizeStockVariantDraft(variant, index = 0, allowedSizes = STOCK_ALPHA_SIZES) {
  const base = blankStockVariant(`variant-${index + 1}`);
  const sizes = (Array.isArray(variant?.sizes) ? variant.sizes : [])
    .map((sizeRow) => ({
      size: allowedSizes.includes(String(sizeRow?.size || "").trim().toUpperCase())
        ? String(sizeRow.size).trim().toUpperCase()
        : "",
      quantity: Math.max(1, Math.min(9999, Number(sizeRow?.quantity || 0) || 0)),
    }))
    .filter((sizeRow) => sizeRow.size && sizeRow.quantity);
  return {
    ...base,
    id: String(variant?.id || base.id),
    color: String(variant?.color || "").slice(0, 80),
    price: String(variant?.price ?? ""),
    sizes,
    sizeMenuOpen: Boolean(variant?.sizeMenuOpen),
    selectedSize: allowedSizes.includes(String(variant?.selectedSize || "").trim().toUpperCase())
      ? String(variant.selectedSize).trim().toUpperCase()
      : "",
    quantityDraft: String(variant?.quantityDraft || ""),
    pendingDeleteSize: allowedSizes.includes(String(variant?.pendingDeleteSize || "").trim().toUpperCase())
      ? String(variant.pendingDeleteSize).trim().toUpperCase()
      : "",
  };
}

function normalizeStockPhotoDraft(photo, index = 0) {
  const dataUrl = sanitizePhotoDataUrl(photo?.dataUrl);
  if (!dataUrl) return null;
  return {
    id: String(photo?.id || `restored-photo-${index}`),
    name: String(photo?.name || `foto-producto-${index + 1}.jpg`).slice(0, 120),
    dataUrl,
  };
}

function formatStockSizes(sizes = []) {
  return sizes.map((sizeRow) => `${sizeRow.size}=(${sizeRow.quantity})`).join(", ");
}

function printStockLabels({ sku, locationCode, quantity }) {
  try {
    const labelCount = Math.max(1, Math.min(9999, Number(quantity || 0) || 0));
    if (!sku || !locationCode || !window.Android || typeof window.Android.printStockLabels !== "function") return;
    window.Android.printStockLabels(String(sku), String(locationCode), String(labelCount));
  } catch (_error) {
    // La impresion es una mejora nativa de Android; el guardado debe continuar si no esta disponible.
  }
}

function stockDisplayVariants(draft) {
  if (!draft) return [];
  const variants = Array.isArray(draft.variants) ? draft.variants : [];
  const normalizedVariants = variants
    .map((variant, index) => ({
      color: String(variant?.color || `Color ${index + 1}`).trim(),
      price: Number(variant?.price ?? draft.price ?? 0) || 0,
      sizes: Array.isArray(variant?.sizes)
        ? variant.sizes
            .map((sizeRow) => ({
              size: String(sizeRow?.size || "").trim().toUpperCase(),
              quantity: Math.max(1, Number(sizeRow?.quantity || 0) || 0),
            }))
            .filter((sizeRow) => sizeRow.size && sizeRow.quantity)
        : [],
    }))
    .filter((variant) => variant.color || variant.sizes.length);
  if (normalizedVariants.length) return normalizedVariants;
  const size = String(draft.size || "").trim().toUpperCase();
  const quantity = Math.max(1, Number(draft.quantity || 0) || 0);
  return [
    {
      color: String(draft.color || "-").trim(),
      price: Number(draft.price || 0) || 0,
      sizes: size ? [{ size, quantity }] : [],
    },
  ];
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function compressImageFile(file) {
  const originalDataUrl = await fileToDataUrl(file);
  const image = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = originalDataUrl;
  });
  const maxSide = 1400;
  const scale = Math.min(1, maxSide / Math.max(image.width || maxSide, image.height || maxSide));
  const width = Math.max(1, Math.round((image.width || maxSide) * scale));
  const height = Math.max(1, Math.round((image.height || maxSide) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", 0.78);
}

export default function StockPortal() {
  const {
    shop,
    drafts,
    preparedHistory = [],
    stockUser,
    accessCode,
    sessionToken,
    error,
    audiences,
    garments,
    nextSkuByCategory,
    locationByCategory,
    stockLogoutTime,
  } = useLoaderData();
  const actionData = useActionData();
  const publishStockFetcher = useFetcher();
  const lockStockFetcher = useFetcher();
  const releaseStockFetcher = useFetcher();
  const heartbeatStockFetcher = useFetcher();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const submit = useSubmit();
  const [searchParams, setSearchParams] = useSearchParams();
  const savedFlag = searchParams.get("guardado");
  const requestedPublisherDraftId = Number(searchParams.get("draftId") || 0);
  const [activeTab, setActiveTab] = useState("capturar");
  const [photos, setPhotos] = useState([]);
  const [selectedDraftId, setSelectedDraftId] = useState(requestedPublisherDraftId);
  const [pendingSelectedDraftId, setPendingSelectedDraftId] = useState(0);
  const [publisherMessage, setPublisherMessage] = useState("");
  const [publisherStateLoaded, setPublisherStateLoaded] = useState(false);
  const [selectedAudience, setSelectedAudience] = useState(audiences?.[0]?.value || "hombre");
  const [selectedGarment, setSelectedGarment] = useState(garments?.[0]?.value || "playera");
  const [captureStep, setCaptureStep] = useState("audience");
  const [showPreparedHistory, setShowPreparedHistory] = useState(false);
  const [stockReprintMode, setStockReprintMode] = useState(false);
  const [stockPortalLoggingOut, setStockPortalLoggingOut] = useState(false);
  const [variantGroups, setVariantGroups] = useState([blankStockVariant()]);
  const [captureDraftLoaded, setCaptureDraftLoaded] = useState(false);
  const [previewPhoto, setPreviewPhoto] = useState(null);
  const [photoZoom, setPhotoZoom] = useState({ scale: 1, x: 0, y: 0 });
  const [checkedStockItems, setCheckedStockItems] = useState({});
  const photoGestureRef = useRef({ distance: 0, scale: 1, startX: 0, startY: 0 });
  const pendingStockSaveRef = useRef(false);
  const lastDraftCountRef = useRef(drafts.length);
  const restoredPublisherStateKeyRef = useRef("");
  const isSubmitting = navigation.state !== "idle";
  const navigationIntent = navigation.formData?.get("intent");
  const isStockLoginSubmitting = navigation.state !== "idle" && navigationIntent === "stock_login";
  const isPreparerStock = stockUser?.role === STOCK_USER_ROLES.PREPARER;
  const isProductPublisher = stockUser?.role === STOCK_USER_ROLES.PUBLISHER;
  const captureDraftKey = useMemo(() => stockCaptureDraftKey(shop), [shop]);
  const stockSessionKey = useMemo(() => stockSessionStorageKey(shop), [shop]);
  const publisherDraftKey = useMemo(() => stockPublisherDraftKey(shop, accessCode), [accessCode, shop]);
  const suggestedSku =
    nextSkuByCategory?.[`${selectedAudience}:${selectedGarment}`] ||
    nextStockSkuForPrefix(stockSkuPrefix(selectedAudience, selectedGarment), []);
  const suggestedLocation =
    locationByCategory?.[`${selectedAudience}:${selectedGarment}`] ||
    defaultStockLocation(selectedAudience, selectedGarment);
  const selectedDraft = useMemo(
    () => drafts.find((draft) => Number(draft.id) === Number(selectedDraftId)) || null,
    [drafts, selectedDraftId],
  );
  const selectedDraftVariants = useMemo(() => stockDisplayVariants(selectedDraft), [selectedDraft]);
  const selectedDraftChecklistKeys = useMemo(() => {
    if (!selectedDraft) return [];
    return [
      `draft:${selectedDraft.id}:sku`,
      ...selectedDraftVariants.flatMap((variant, variantIndex) =>
        variant.sizes.map((sizeRow) => `draft:${selectedDraft.id}:variant:${variantIndex}:size:${sizeRow.size}`),
      ),
    ];
  }, [selectedDraft, selectedDraftVariants]);
  const isSelectedDraftPublishReady =
    selectedDraftChecklistKeys.length > 1 &&
    selectedDraftChecklistKeys.every((key) => checkedStockItems[key]);
  const currentStockSizes = useMemo(
    () => stockSizesFor(selectedAudience, selectedGarment),
    [selectedAudience, selectedGarment],
  );
  const stockSizeMenuOpen = variantGroups.some((variant) => variant.sizeMenuOpen);
  const stockFormComplete =
    photos.length > 0 &&
    variantGroups.length > 0 &&
    variantGroups.every(
      (variant) =>
        String(variant.color || "").trim() &&
        String(variant.price ?? "").trim() &&
        Number(variant.price) >= 0 &&
        Array.isArray(variant.sizes) &&
        variant.sizes.length > 0,
    );

  const toggleStockChecklistItem = (key) => {
    setCheckedStockItems((current) => ({ ...current, [key]: !current[key] }));
  };

  function clearPublisherDraftState() {
    try {
      window.localStorage.removeItem(publisherDraftKey);
    } catch (_error) {
      // localStorage puede estar bloqueado; en ese caso simplemente no se conserva esta vista.
    }
  }

  function setPublisherDraftUrl(draftId) {
    const nextParams = new URLSearchParams(window.location.search);
    if (draftId) {
      nextParams.set("draftId", String(draftId));
    } else {
      nextParams.delete("draftId");
    }
    setSearchParams(nextParams, { replace: true });
  }

  function resetStockCaptureFlow(clearSavedFlag = false) {
    try {
      window.localStorage.removeItem(captureDraftKey);
    } catch (_error) {
      // localStorage puede estar bloqueado; el guardado real ya se hizo en servidor.
    }
    setActiveTab("capturar");
    setCaptureStep("audience");
    setShowPreparedHistory(false);
    setStockReprintMode(false);
    setPhotos([]);
    resetStockVariants();
    setCaptureDraftLoaded(true);
    if (clearSavedFlag) {
      const nextParams = new URLSearchParams(window.location.search);
      nextParams.delete("guardado");
      setSearchParams(nextParams, { replace: true });
    }
  }

  function stockLoginUrl() {
    return `/stock?shop=${encodeURIComponent(shop)}`;
  }

  function logoutStockPortal() {
    setStockPortalLoggingOut(true);
    try {
      window.localStorage.removeItem(captureDraftKey);
      window.localStorage.removeItem(publisherDraftKey);
      window.localStorage.removeItem(stockSessionKey);
    } catch (_error) {
      // Si localStorage no esta disponible, de todos modos se fuerza la pantalla de codigo.
    }
    setSelectedDraftId(0);
    setPendingSelectedDraftId(0);
    setCheckedStockItems({});
    setShowPreparedHistory(false);
    setStockReprintMode(false);
    const logoutForm = new FormData();
    logoutForm.set("intent", "stock_logout");
    logoutForm.set("shop", shop);
    logoutForm.set("stockCode", accessCode || sessionToken || "");
    submit(logoutForm, { method: "post" });
  }

  function confirmAndLogoutStockPortal() {
    if (!window.confirm("¿Seguro que quieres cerrar sesión?")) return;
    logoutStockPortal();
  }

  useEffect(() => {
    const urlSessionToken = String(searchParams.get("sesion") || searchParams.get("session") || "").trim();
    const activeSessionToken = String(sessionToken || accessCode || "").trim();
    try {
      if (stockUser && activeSessionToken) {
        window.localStorage.setItem(stockSessionKey, activeSessionToken);
        return;
      }
      if (!stockUser && urlSessionToken) {
        window.localStorage.removeItem(stockSessionKey);
        return;
      }
      if (!stockUser && !urlSessionToken) {
        const storedToken = String(window.localStorage.getItem(stockSessionKey) || "").trim();
        if (storedToken) {
          window.location.replace(`/stock?shop=${encodeURIComponent(shop)}&sesion=${encodeURIComponent(storedToken)}`);
        }
      }
    } catch (_error) {
      // Si localStorage no esta disponible, el usuario puede entrar con su codigo.
    }
  }, [accessCode, searchParams, sessionToken, shop, stockSessionKey, stockUser]);

  useEffect(() => {
    if (savedFlag) {
      printStockLabels({
        sku: searchParams.get("sku") || "",
        locationCode: searchParams.get("ubicacion") || "",
        quantity: searchParams.get("cantidad") || "",
      });
      pendingStockSaveRef.current = false;
      resetStockCaptureFlow(true);
      return;
    }

    try {
      const rawDraft = window.localStorage.getItem(captureDraftKey);
      if (!rawDraft) {
        setCaptureDraftLoaded(true);
        return;
      }
      const draft = JSON.parse(rawDraft);
      if (draft?.version !== STOCK_CAPTURE_DRAFT_VERSION) {
        window.localStorage.removeItem(captureDraftKey);
        setCaptureDraftLoaded(true);
        return;
      }
      const restoredAudience = normalizeAudience(draft.selectedAudience);
      const restoredGarment = normalizeGarment(draft.selectedGarment);
      const restoredStockSizes = stockSizesFor(restoredAudience, restoredGarment);
      const restoredVariants = (Array.isArray(draft.variantGroups) ? draft.variantGroups : [])
        .map((variant, index) => normalizeStockVariantDraft(variant, index, restoredStockSizes))
        .filter(Boolean);
      const restoredPhotos = (Array.isArray(draft.photos) ? draft.photos : [])
        .map(normalizeStockPhotoDraft)
        .filter(Boolean)
        .slice(0, MAX_STOCK_PHOTOS);

      setActiveTab("capturar");
      setCaptureStep(["audience", "product", "details"].includes(draft.captureStep) ? draft.captureStep : "audience");
      setSelectedAudience(restoredAudience);
      setSelectedGarment(restoredGarment);
      setVariantGroups(restoredVariants.length ? restoredVariants : [blankStockVariant()]);
      setPhotos(restoredPhotos);
    } catch (restoreError) {
      console.error("No se pudo restaurar el borrador de stock", restoreError);
    } finally {
      setCaptureDraftLoaded(true);
    }
  }, [captureDraftKey, savedFlag, setSearchParams]);

  useEffect(() => {
    if (!stockUser || !stockLogoutTime) return undefined;
    const checkStockLogoutTime = () => {
      const { dateKey, minutes } = stockMexicoDateTimeParts();
      const targetMinutes = stockLogoutMinutes(stockLogoutTime);
      if (!dateKey || minutes < 0 || !Number.isFinite(targetMinutes) || minutes < targetMinutes) return;
      const storageKey = stockAutoLogoutKey(shop, stockLogoutTime, dateKey);
      try {
        if (window.localStorage.getItem(storageKey)) return;
        window.localStorage.setItem(storageKey, "1");
      } catch (_error) {
        // Si no se puede marcar localmente, cerrar sesion sigue siendo lo correcto.
      }
      logoutStockPortal();
    };

    checkStockLogoutTime();
    const intervalId = window.setInterval(checkStockLogoutTime, 15000);
    return () => window.clearInterval(intervalId);
  }, [shop, stockLogoutTime, stockUser, captureDraftKey, publisherDraftKey]);

  useEffect(() => {
    if (!stockUser || !isPreparerStock) return undefined;
    const intervalId = window.setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 30000);
    return () => window.clearInterval(intervalId);
  }, [isPreparerStock, revalidator, stockUser]);

  useEffect(() => {
    if (navigation.state !== "idle") return;
    if (pendingStockSaveRef.current && drafts.length > lastDraftCountRef.current) {
      pendingStockSaveRef.current = false;
      resetStockCaptureFlow();
    }
    lastDraftCountRef.current = drafts.length;
  }, [drafts.length, navigation.state]);

  useEffect(() => {
    if (actionData?.error) pendingStockSaveRef.current = false;
  }, [actionData?.error]);

  useEffect(() => {
    if (!isProductPublisher) {
      restoredPublisherStateKeyRef.current = "";
      setPublisherStateLoaded(true);
      return;
    }
    const restoreKey = `${publisherDraftKey}:${requestedPublisherDraftId || "saved"}`;
    if (restoredPublisherStateKeyRef.current === restoreKey) {
      setPublisherStateLoaded(true);
      return;
    }
    restoredPublisherStateKeyRef.current = restoreKey;
    setPublisherStateLoaded(false);
    try {
      const rawState = window.localStorage.getItem(publisherDraftKey);
      const savedState = rawState ? JSON.parse(rawState) : {};
      const draftId = requestedPublisherDraftId || Number(savedState?.selectedDraftId || 0);
      const restoredDraft = drafts.find((draft) => Number(draft.id) === draftId);
      if (!draftId || !restoredDraft || restoredDraft.isLockedByOther) {
        window.localStorage.removeItem(publisherDraftKey);
        if (requestedPublisherDraftId) setPublisherDraftUrl(0);
        return;
      }
      const savedChecks =
        savedState?.checkedStockItems && typeof savedState.checkedStockItems === "object"
          ? savedState.checkedStockItems
          : {};
      setSelectedDraftId(draftId);
      setCheckedStockItems(savedChecks);
      if (!restoredDraft.isLockedByCurrentUser) {
        setPendingSelectedDraftId(draftId);
        lockStockFetcher.submit(
          {
            intent: "lock_stock_draft",
            shop,
            stockCode: accessCode || "",
            draftId: String(draftId),
          },
          { method: "post" },
        );
      }
    } catch (restoreError) {
      console.error("No se pudo restaurar el publicador de stock", restoreError);
    } finally {
      setPublisherStateLoaded(true);
    }
  }, [accessCode, drafts, isProductPublisher, lockStockFetcher, publisherDraftKey, requestedPublisherDraftId, shop]);

  useEffect(() => {
    if (!isProductPublisher || !publisherStateLoaded) return;
    try {
      if (!selectedDraftId && !Object.keys(checkedStockItems).length) {
        window.localStorage.removeItem(publisherDraftKey);
        return;
      }
      window.localStorage.setItem(
        publisherDraftKey,
        JSON.stringify({
          version: STOCK_CAPTURE_DRAFT_VERSION,
          selectedDraftId,
          checkedStockItems,
          updatedAt: new Date().toISOString(),
        }),
      );
    } catch (saveError) {
      console.error("No se pudo guardar el avance del publicador de stock", saveError);
    }
  }, [checkedStockItems, isProductPublisher, publisherDraftKey, publisherStateLoaded, selectedDraftId]);

  useEffect(() => {
    if (!isProductPublisher) return undefined;
    const intervalId = window.setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, STOCK_PUBLICATION_REFRESH_MS);
    return () => window.clearInterval(intervalId);
  }, [isProductPublisher, revalidator]);

  useEffect(() => {
    if (!isProductPublisher || !selectedDraftId) return undefined;
    const intervalId = window.setInterval(() => {
      if (heartbeatStockFetcher.state !== "idle") return;
      heartbeatStockFetcher.submit(
        {
          intent: "lock_stock_draft",
          shop,
          stockCode: accessCode || "",
          draftId: String(selectedDraftId),
        },
        { method: "post" },
      );
    }, STOCK_PUBLICATION_HEARTBEAT_MS);
    return () => window.clearInterval(intervalId);
  }, [accessCode, heartbeatStockFetcher, isProductPublisher, selectedDraftId, shop]);

  useEffect(() => {
    if (!pendingSelectedDraftId || lockStockFetcher.state !== "idle" || !lockStockFetcher.data) return;
    const responseDraftId = Number(lockStockFetcher.data.draftId || 0);
    if (responseDraftId && responseDraftId !== Number(pendingSelectedDraftId)) return;
    if (lockStockFetcher.data.ok) {
      setSelectedDraftId(responseDraftId || Number(pendingSelectedDraftId));
      setPublisherDraftUrl(responseDraftId || Number(pendingSelectedDraftId));
      setPublisherMessage("");
      revalidator.revalidate();
    } else {
      setPublisherMessage(lockStockFetcher.data.error || "Esta orden ya esta siendo trabajada.");
      setSelectedDraftId(0);
      setCheckedStockItems({});
      clearPublisherDraftState();
      setPublisherDraftUrl(0);
      revalidator.revalidate();
    }
    setPendingSelectedDraftId(0);
  }, [lockStockFetcher.data, lockStockFetcher.state, pendingSelectedDraftId, revalidator]);

  useEffect(() => {
    if (!selectedDraftId) return;
    if (selectedDraft) return;
    setSelectedDraftId(0);
    setCheckedStockItems({});
    clearPublisherDraftState();
    setPublisherDraftUrl(0);
  }, [selectedDraft, selectedDraftId]);

  useEffect(() => {
    if (!captureDraftLoaded || savedFlag) return;
    const draft = {
      version: STOCK_CAPTURE_DRAFT_VERSION,
      activeTab,
      captureStep,
      selectedAudience,
      selectedGarment,
      variantGroups,
      photos,
      updatedAt: new Date().toISOString(),
    };
    try {
      window.localStorage.setItem(captureDraftKey, JSON.stringify(draft));
    } catch (saveError) {
      try {
        window.localStorage.setItem(captureDraftKey, JSON.stringify({ ...draft, photos: [] }));
      } catch (_retryError) {
        console.error("No se pudo guardar el borrador de stock", saveError);
      }
    }
  }, [
    activeTab,
    captureDraftKey,
    captureDraftLoaded,
    captureStep,
    photos,
    savedFlag,
    selectedAudience,
    selectedGarment,
    variantGroups,
  ]);

  async function handlePhotoFiles(event) {
    const files = Array.from(event.target.files || []).slice(0, MAX_STOCK_PHOTOS - photos.length);
    if (!files.length) return;
    const compressed = [];
    for (const file of files) {
      try {
        compressed.push({
          id: `${Date.now()}-${file.name}-${compressed.length}`,
          name: file.name || "foto-producto.jpg",
          dataUrl: await compressImageFile(file),
        });
      } catch (error) {
        console.error("No se pudo procesar la foto de stock", error);
      }
    }
    setPhotos((current) => [...current, ...compressed].slice(0, MAX_STOCK_PHOTOS));
    event.target.value = "";
  }

  function openPublisherDraft(draft) {
    if (!draft) return;
    if (draft.isLockedByOther) {
      setPublisherMessage("Esta orden ya esta siendo trabajada.");
      return;
    }
    setPublisherMessage("");
    setPendingSelectedDraftId(draft.id);
    lockStockFetcher.submit(
      {
        intent: "lock_stock_draft",
        shop,
        stockCode: accessCode || "",
        draftId: String(draft.id),
      },
      { method: "post" },
    );
  }

  function returnToPublisherList() {
    const draftId = selectedDraftId;
    setSelectedDraftId(0);
    setCheckedStockItems({});
    clearPublisherDraftState();
    setPublisherDraftUrl(0);
    if (!draftId) return;
    releaseStockFetcher.submit(
      {
        intent: "release_stock_draft",
        shop,
        stockCode: accessCode || "",
        draftId: String(draftId),
      },
      { method: "post" },
    );
  }

  function chooseAudience(value) {
    setShowPreparedHistory(false);
    setStockReprintMode(false);
    setSelectedAudience(value);
    setCaptureStep("product");
  }

  function closePreparedHistory() {
    setShowPreparedHistory(false);
    setStockReprintMode(false);
  }

  function reprintPreparedHistoryItem(item) {
    if (!stockReprintMode) return;
    const sku = String(item?.sku || "").trim();
    const locationCode = String(item?.locationCode || "").trim();
    if (!sku || !locationCode) {
      window.alert("No se puede reimprimir esta orden porque falta SKU o ubicacion.");
      return;
    }
    const confirmed = window.confirm(`¿Seguro que quieres reimprimir las etiquetas de ${sku}?`);
    if (!confirmed) return;
    printStockLabels({
      sku,
      locationCode,
      quantity: item?.quantity || 1,
    });
    setStockReprintMode(false);
  }

  function chooseGarment(value) {
    setSelectedGarment(value);
    setCaptureStep("details");
    resetStockVariants();
  }

  function resetStockVariants() {
    setVariantGroups([blankStockVariant()]);
  }

  const cleanVariantGroups = useMemo(
    () =>
      variantGroups
        .map((variant) => ({
          color: String(variant.color || "").trim(),
          price: Math.max(0, Number(variant.price || 0) || 0),
          sizes: (Array.isArray(variant.sizes) ? variant.sizes : [])
            .map((sizeRow) => ({
              size: String(sizeRow.size || "").trim().toUpperCase(),
              quantity: Math.max(1, Math.min(9999, Number(sizeRow.quantity || 0) || 0)),
            }))
            .filter((sizeRow) => currentStockSizes.includes(sizeRow.size) && sizeRow.quantity),
        }))
        .filter((variant) => variant.color && variant.sizes.length),
    [currentStockSizes, variantGroups],
  );

  function updateVariant(variantId, field, value) {
    setVariantGroups((currentGroups) =>
      currentGroups.map((variant) =>
        variant.id === variantId
          ? {
              ...variant,
              [field]: value,
            }
          : variant,
      ),
    );
  }

  function selectVariantSize(variantId, value) {
    if (value === "__done") {
      setVariantGroups((currentGroups) =>
        currentGroups.map((variant) =>
          variant.id === variantId
            ? { ...variant, sizeMenuOpen: false, selectedSize: "", quantityDraft: "", pendingDeleteSize: "" }
            : variant,
        ),
      );
      return;
    }
    if (!currentStockSizes.includes(value)) return;
    setVariantGroups((currentGroups) =>
      currentGroups.map((variant) => {
        if (variant.id !== variantId) return variant;
        const exists = variant.sizes.some((sizeRow) => String(sizeRow.size || "").trim().toUpperCase() === value);
        return exists
          ? { ...variant, selectedSize: "", quantityDraft: "", pendingDeleteSize: value }
          : { ...variant, selectedSize: value, quantityDraft: "", pendingDeleteSize: "" };
      }),
    );
  }

  function confirmVariantSize(variantId) {
    setVariantGroups((currentGroups) =>
      currentGroups.map((variant) => {
        if (variant.id !== variantId) return variant;
        const cleanSize = String(variant.selectedSize || "").trim().toUpperCase();
        const quantity = Math.max(1, Math.min(9999, Number(variant.quantityDraft || 0) || 0));
        if (!cleanSize || !quantity) return variant;
        const nextSizes = [
          ...variant.sizes.filter((sizeRow) => String(sizeRow.size || "").trim().toUpperCase() !== cleanSize),
          { size: cleanSize, quantity },
        ];
        return { ...variant, sizes: nextSizes, selectedSize: "", quantityDraft: "", pendingDeleteSize: "" };
      }),
    );
  }

  function cancelVariantSizeQuantity(variantId) {
    setVariantGroups((currentGroups) =>
      currentGroups.map((variant) =>
        variant.id === variantId ? { ...variant, selectedSize: "", quantityDraft: "" } : variant,
      ),
    );
  }

  function removeSizeFromVariant(variantId, size) {
    const cleanSize = String(size || "").trim().toUpperCase();
    setVariantGroups((currentGroups) =>
      currentGroups.map((variant) => {
        if (variant.id !== variantId) return variant;
        const nextSizes = variant.sizes.filter(
          (sizeRow) => String(sizeRow.size || "").trim().toUpperCase() !== cleanSize,
        );
        return {
          ...variant,
          sizes: nextSizes,
          selectedSize: "",
          quantityDraft: "",
          pendingDeleteSize: "",
        };
      }),
    );
  }

  function toggleVariantSizeMenu(variantId) {
    setVariantGroups((currentGroups) =>
      currentGroups.map((variant) =>
        variant.id === variantId
          ? {
              ...variant,
              sizeMenuOpen: !variant.sizeMenuOpen,
              selectedSize: "",
              quantityDraft: "",
              pendingDeleteSize: "",
            }
          : variant,
      ),
    );
  }

  function cancelVariantSizeDelete(variantId) {
    updateVariant(variantId, "pendingDeleteSize", "");
  }

  function addVariantGroup() {
    const nextId = `variant-${Date.now()}`;
    setVariantGroups((currentGroups) => [...currentGroups, blankStockVariant(nextId)]);
  }

  function removeVariantGroup(variantId) {
    setVariantGroups((currentGroups) => {
      const nextGroups = currentGroups.filter((variant) => variant.id !== variantId);
      return nextGroups.length ? nextGroups : [blankStockVariant()];
    });
  }

  function openPhotoPreview(photo) {
    setPreviewPhoto(photo);
    setPhotoZoom({ scale: 1, x: 0, y: 0 });
    photoGestureRef.current = { distance: 0, scale: 1, startX: 0, startY: 0 };
  }

  function closePhotoPreview() {
    setPreviewPhoto(null);
    setPhotoZoom({ scale: 1, x: 0, y: 0 });
  }

  function touchDistance(touches) {
    if (!touches || touches.length < 2) return 0;
    const deltaX = touches[0].clientX - touches[1].clientX;
    const deltaY = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(deltaX * deltaX + deltaY * deltaY);
  }

  function handlePreviewTouchStart(event) {
    if (event.touches.length === 2) {
      photoGestureRef.current = {
        ...photoGestureRef.current,
        distance: touchDistance(event.touches),
        scale: photoZoom.scale,
      };
      return;
    }
    if (event.touches.length === 1 && photoZoom.scale > 1) {
      photoGestureRef.current = {
        ...photoGestureRef.current,
        startX: event.touches[0].clientX - photoZoom.x,
        startY: event.touches[0].clientY - photoZoom.y,
      };
    }
  }

  function handlePreviewTouchMove(event) {
    if (event.touches.length === 2) {
      event.preventDefault();
      const initialDistance = photoGestureRef.current.distance || touchDistance(event.touches);
      const nextScale = Math.min(
        4,
        Math.max(1, photoGestureRef.current.scale * (touchDistance(event.touches) / initialDistance)),
      );
      setPhotoZoom((current) => ({
        ...current,
        scale: nextScale,
        x: nextScale === 1 ? 0 : current.x,
        y: nextScale === 1 ? 0 : current.y,
      }));
      return;
    }
    if (event.touches.length === 1 && photoZoom.scale > 1) {
      event.preventDefault();
      setPhotoZoom((current) => ({
        ...current,
        x: event.touches[0].clientX - photoGestureRef.current.startX,
        y: event.touches[0].clientY - photoGestureRef.current.startY,
      }));
    }
  }

  function handlePreviewTouchEnd() {
    if (photoZoom.scale <= 1.02) {
      setPhotoZoom({ scale: 1, x: 0, y: 0 });
    }
  }

  const garmentGroups = useMemo(() => {
    return (garments || STOCK_GARMENTS)
      .filter((garment) => !garment.audiences || garment.audiences.includes(selectedAudience))
      .reduce((groups, garment) => {
        const section = garment.section || "Productos";
        return {
          ...groups,
          [section]: [...(groups[section] || []), garment],
        };
      }, {});
  }, [garments, selectedAudience]);

  return (
    <main className={`${styles.page} ${!stockUser ? styles.loginPage : ""}`}>
      {!stockUser ? (
        <div className={styles.loginAccessContainer}>
          <section className={`${styles.card} ${styles.loginCard}`}>
            <p className={styles.loginEyebrow}>Portal stock</p>
            <h1 className={styles.loginTitle}>Ingresa tu codigo</h1>
            <p className={styles.loginSubtitle}>Tu codigo es necesario para acceder al portal de stock.</p>
            <Form method="post" className={styles.loginForm}>
              <input type="hidden" name="intent" value="stock_login" />
              <input type="hidden" name="shop" value={shop} />
              <input
                autoFocus
                aria-label="Codigo unico"
                inputMode="numeric"
                maxLength={6}
                name="code"
                pattern="[0-9]{6}"
                placeholder="000000"
                required
              />
            <button className={styles.primaryButton} type="submit" disabled={isSubmitting}>
              {isStockLoginSubmitting ? (
                <span className={styles.loadingButtonContent}>
                  <span className={styles.buttonSpinner} aria-hidden="true" />
                  Cargando
                </span>
              ) : (
                "Entrar"
              )}
            </button>
            </Form>
            {error ? <p className={styles.error}>{error}</p> : null}
            {actionData?.error ? <p className={styles.error}>{actionData.error}</p> : null}
          </section>
        </div>
      ) : null}

      {stockUser ? (
        <header className={styles.header}>
          <div>
            <h1>Portal stock</h1>
            <span className={styles.userLine}>
              <span>{stockUserRoleLabel(stockUser.role)}:</span>{" "}
              <strong>{stockUser.name}</strong>
            </span>
          </div>
        </header>
      ) : null}

      {stockUser && error ? <p className={styles.error}>{error}</p> : null}
      {stockUser && actionData?.error ? <p className={styles.error}>{actionData.error}</p> : null}

      {isPreparerStock && activeTab === "capturar" ? (
        <section className={styles.card}>
          {captureStep === "audience" && !showPreparedHistory ? (
            <div className={styles.stockHomeActions}>
              <button
                className={styles.slimSessionButton}
                type="button"
                disabled={stockPortalLoggingOut}
                onClick={confirmAndLogoutStockPortal}
              >
                {stockPortalLoggingOut ? (
                  <span className={styles.loadingButtonContent}>
                    <span className={styles.buttonSpinner} aria-hidden="true" />
                    Cargando
                  </span>
                ) : (
                  "Cerrar sesión"
                )}
              </button>
              <button className={styles.slimHistoryButton} type="button" onClick={() => setShowPreparedHistory(true)}>
                Historial
              </button>
            </div>
          ) : null}

          {captureStep === "audience" && showPreparedHistory ? (
            <div className={styles.preparedHistoryPanel}>
              <div className={`${styles.stepHeader} ${styles.preparedHistoryHeader}`}>
                <h2>Historial del dia</h2>
                <button className={styles.textButton} type="button" onClick={closePreparedHistory}>
                  Regresar
                </button>
                <button
                  aria-label={stockReprintMode ? "Cancelar reimpresion" : "Reimprimir etiquetas"}
                  className={`${styles.stockReprintButton} ${
                    stockReprintMode ? styles.stockReprintButtonActive : ""
                  }`}
                  title={stockReprintMode ? "Cancelar reimpresion" : "Reimprimir etiquetas"}
                  type="button"
                  onClick={() => setStockReprintMode((current) => !current)}
                >
                  🖨️
                </button>
              </div>
              {stockReprintMode ? (
                <p className={styles.reprintHint}>Presiona la orden que quieres reimprimir.</p>
              ) : null}
              {preparedHistory.length ? (
                <div className={styles.preparedHistoryList}>
                  {preparedHistory.map((item) => (
                    <button
                      aria-disabled={!stockReprintMode}
                      className={`${styles.preparedHistoryRow} ${
                        stockReprintMode ? styles.preparedHistoryRowSelectable : ""
                      }`}
                      key={item.id}
                      type="button"
                      onClick={() => reprintPreparedHistoryItem(item)}
                    >
                      <strong>{item.sku || "-"}</strong>
                      <span>{item.time || "-"}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className={styles.empty}>Todavia no hay productos guardados hoy.</p>
              )}
            </div>
          ) : null}

          {captureStep === "audience" && !showPreparedHistory ? (
            <div className={styles.choicePanel}>
              <h2 className={styles.audienceTitle}>Para quién es este producto</h2>
              <div className={styles.choiceGrid}>
                {(audiences || STOCK_AUDIENCES).map((audience) => (
                  <button
                    className={`${styles.choiceButton} ${
                      selectedAudience === audience.value ? styles.choiceButtonActive : ""
                    }`}
                    key={audience.value}
                    type="button"
                    onClick={() => chooseAudience(audience.value)}
                  >
                    {audience.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {captureStep === "product" ? (
            <div className={styles.choicePanel}>
              <div className={styles.stepHeader}>
                <div>
                  <span>{audienceConfig(selectedAudience).label}</span>
                  <h2>Qué producto vas a agregar</h2>
                </div>
                <button className={styles.textButton} type="button" onClick={() => setCaptureStep("audience")}>
                  Regresar
                </button>
              </div>
              {Object.entries(garmentGroups).map(([section, sectionGarments]) => (
                <div className={styles.productGroup} key={section}>
                  <h3>{section}</h3>
                  <div className={styles.productGrid}>
                    {sectionGarments.map((garment) => (
                      <button
                        className={`${styles.choiceButton} ${
                          selectedGarment === garment.value ? styles.choiceButtonActive : ""
                        }`}
                        key={garment.value}
                        type="button"
                        onClick={() => chooseGarment(garment.value)}
                      >
                        {garment.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {captureStep === "details" ? (
            <>
              <div className={styles.changeProductRow}>
                <button className={styles.textButton} type="button" onClick={() => setCaptureStep("product")}>
                  Cambiar producto
                </button>
              </div>

              <Form
                method="post"
                className={styles.form}
                onSubmit={() => {
                  pendingStockSaveRef.current = true;
                }}
              >
                <input type="hidden" name="intent" value="create_stock_draft" />
                <input type="hidden" name="shop" value={shop} />
                <input type="hidden" name="stockCode" value={accessCode || ""} />
                <input type="hidden" name="audience" value={selectedAudience} />
                <input type="hidden" name="garmentType" value={selectedGarment} />
                <input type="hidden" name="variants" value={JSON.stringify(cleanVariantGroups)} />
                {photos.map((photo) => (
                  <input key={photo.id} type="hidden" name="photos" value={photo.dataUrl} />
                ))}

                <div className={styles.generatedPanel}>
                  <span>
                    SKU automatico
                    <strong>{suggestedSku}</strong>
                  </span>
                  <span>
                    Ubicacion
                    <strong>{suggestedLocation}</strong>
                  </span>
                </div>

                <div>
                  <label className={`${styles.photoPicker} ${photos.length >= MAX_STOCK_PHOTOS ? styles.photoPickerDisabled : ""}`}>
                    <span>Agregar fotos</span>
                    <strong>{photos.length}/{MAX_STOCK_PHOTOS}</strong>
                    <input
                      accept="image/*"
                      className={styles.photoInput}
                      disabled={photos.length >= MAX_STOCK_PHOTOS}
                      type="file"
                      onChange={handlePhotoFiles}
                    />
                  </label>
                </div>

                {photos.length ? (
                  <div className={styles.photoGrid}>
                    {photos.map((photo) => (
                      <figure className={styles.photoThumb} key={photo.id}>
                        <button
                          className={styles.photoPreviewButton}
                          type="button"
                          onClick={() => openPhotoPreview(photo)}
                        >
                          <img src={photo.dataUrl} alt={photo.name} />
                        </button>
                        <button
                          aria-label={`Quitar foto ${photo.name || ""}`}
                          className={styles.removePhotoButton}
                          type="button"
                          onClick={() => setPhotos((current) => current.filter((item) => item.id !== photo.id))}
                        >
                          X
                        </button>
                      </figure>
                    ))}
                  </div>
                ) : null}

                <div className={styles.variantEditor}>
                  {variantGroups.map((variant, index) => (
                    <div className={styles.variantBlock} key={variant.id}>
                      {variantGroups.length > 1 ? (
                        <div className={styles.variantBlockHeader}>
                          <span>{variant.color || "Nuevo color"}</span>
                          <button
                            className={styles.removeVariantButton}
                            type="button"
                            onClick={() => removeVariantGroup(variant.id)}
                          >
                            Quitar color
                          </button>
                        </div>
                      ) : null}

                      <div className={styles.productFields}>
                        <label>
                          Color
                          <input
                            name={`colorDraft-${variant.id}`}
                            value={variant.color || ""}
                            onChange={(event) => updateVariant(variant.id, "color", event.currentTarget.value)}
                          />
                        </label>
                        <label>
                          Precio
                          <input
                            min="0"
                            name={`priceDraft-${variant.id}`}
                            inputMode="decimal"
                            step="0.01"
                            type="number"
                            value={variant.price ?? ""}
                            onChange={(event) => updateVariant(variant.id, "price", event.currentTarget.value)}
                          />
                        </label>
                      </div>

                      <div className={styles.sizeFlow}>
                        <label>
                          Talla
                          <button
                            className={styles.sizeDropdownButton}
                            type="button"
                            onClick={() => toggleVariantSizeMenu(variant.id)}
                          >
                            {formatStockSizes(variant.sizes) || "Seleccionar tallas"}
                          </button>
                        </label>

                        {variant.sizeMenuOpen ? (
                          <div className={styles.sizeDropdownPanel}>
                            {currentStockSizes.map((size) => {
                              const selectedSizeRow = variant.sizes.find((sizeRow) => sizeRow.size === size);
                              return (
                                <button
                                  className={`${styles.sizeOptionButton} ${
                                    selectedSizeRow ? styles.sizeOptionSelected : ""
                                  }`}
                                  key={`${variant.id}-option-${size}`}
                                  type="button"
                                  onClick={() => selectVariantSize(variant.id, size)}
                                >
                                  {selectedSizeRow ? `${size}=(${selectedSizeRow.quantity})` : size}
                                </button>
                              );
                            })}

                            <button
                              className={styles.sizeDoneButton}
                              type="button"
                              onClick={() => selectVariantSize(variant.id, "__done")}
                            >
                              Listo
                            </button>
                          </div>
                        ) : null}

                        {variant.selectedSize ? (
                          <div className={styles.stockModalBackdrop} role="presentation">
                            <div className={styles.stockModal} role="dialog" aria-modal="true">
                              <h3>Cantidad para {variant.selectedSize}</h3>
                              <input
                                autoFocus
                                min="1"
                                inputMode="numeric"
                                placeholder="Cantidad"
                                type="number"
                                value={variant.quantityDraft || ""}
                                onChange={(event) =>
                                  updateVariant(variant.id, "quantityDraft", event.currentTarget.value)
                                }
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") {
                                    event.preventDefault();
                                    confirmVariantSize(variant.id);
                                  }
                                }}
                              />
                              <div className={styles.stockModalActions}>
                                <button
                                  className={styles.secondaryButton}
                                  type="button"
                                  onClick={() => cancelVariantSizeQuantity(variant.id)}
                                >
                                  Cancelar
                                </button>
                                <button
                                  className={styles.primaryButton}
                                  type="button"
                                  disabled={!variant.quantityDraft}
                                  onClick={() => confirmVariantSize(variant.id)}
                                >
                                  Listo
                                </button>
                              </div>
                            </div>
                          </div>
                        ) : null}

                        {variant.pendingDeleteSize ? (
                          <div className={styles.stockModalBackdrop} role="presentation">
                            <div className={styles.stockModal} role="dialog" aria-modal="true">
                              <h3>¿Eliminar {variant.pendingDeleteSize}?</h3>
                              <p>Se borrara la cantidad de esta talla.</p>
                              <div className={styles.stockModalActions}>
                                <button
                                  className={styles.secondaryButton}
                                  type="button"
                                  onClick={() => cancelVariantSizeDelete(variant.id)}
                                >
                                  No
                                </button>
                                <button
                                  className={styles.primaryButton}
                                  type="button"
                                  onClick={() => removeSizeFromVariant(variant.id, variant.pendingDeleteSize)}
                                >
                                  Si
                                </button>
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>

                {!stockSizeMenuOpen ? (
                  <div className={styles.formActions}>
                    <button className={styles.secondaryButton} type="button" onClick={addVariantGroup}>
                      + Agregar
                    </button>
                    <button
                      className={styles.primaryButton}
                      type="submit"
                      disabled={isSubmitting || !stockFormComplete}
                    >
                      {isSubmitting ? "Guardando..." : "Listo"}
                    </button>
                  </div>
                ) : null}
              </Form>
            </>
          ) : null}
        </section>
      ) : isProductPublisher ? (
        <section
          className={`${styles.pendingLayout} ${
            selectedDraft ? styles.publisherDetailLayout : styles.publisherListLayout
          }`}
        >
          {!selectedDraft ? (
          <div className={styles.listCard}>
            <h2>Productos listos</h2>
            {publisherMessage ? <p className={styles.error}>{publisherMessage}</p> : null}
            {drafts.length ? (
              <div className={styles.draftList}>
                {drafts.map((draft) => (
                  <button
                    aria-disabled={draft.isLockedByOther}
                    className={`${styles.draftButton} ${draft.isLockedByOther ? styles.draftButtonLocked : ""} ${
                      pendingSelectedDraftId === draft.id ? styles.draftButtonPending : ""
                    }`}
                    key={draft.id}
                    type="button"
                    onClick={() => openPublisherDraft(draft)}
                  >
                    <strong>{draft.locationCode || draft.productName}</strong>
                    {draft.isLockedByOther ? <small>Ya esta siendo trabajada</small> : null}
                  </button>
                ))}
              </div>
            ) : (
              <p className={styles.empty}>Todavia no hay productos listos.</p>
            )}
          </div>
          ) : null}

          {selectedDraft ? (
            <article className={styles.detailCard}>
              <div className={styles.publisherDetailActions}>
                <button className={styles.secondaryButton} type="button" onClick={returnToPublisherList}>
                  Regresar
                </button>
              </div>
              {selectedDraft.photos?.length ? (
                <div className={styles.downloadGrid}>
                  {selectedDraft.photos.map((photo, index) => (
                    <figure className={styles.downloadPhoto} key={`${selectedDraft.id}-${index}`}>
                      <button
                        className={styles.photoPreviewButton}
                        type="button"
                        onClick={() =>
                          openPhotoPreview({
                            dataUrl: photo,
                            name: `${selectedDraft.productName || "producto"} ${index + 1}`,
                          })
                        }
                      >
                        <img src={photo} alt={`${selectedDraft.productName} ${index + 1}`} />
                      </button>
                      <a href={photo} download={`${selectedDraft.sku || selectedDraft.productName}-foto-${index + 1}.jpg`}>
                        Descargar foto
                      </a>
                    </figure>
                  ))}
                </div>
              ) : (
                <p className={styles.empty}>Este producto no tiene fotos.</p>
              )}
              <dl className={styles.detailGrid}>
                <div className={styles.detailMetaColumn}>
                  <div>
                    <dt>Ubicacion</dt>
                    <dd>{selectedDraft.locationCode || "-"}</dd>
                  </div>
                  <div className={styles.detailCheckCard}>
                    <dt>SKU</dt>
                    <dd>
                      <span>{selectedDraft.sku || "-"}</span>
                      <input
                        type="checkbox"
                        aria-label={`SKU listo ${selectedDraft.sku || ""}`}
                        checked={Boolean(checkedStockItems[`draft:${selectedDraft.id}:sku`])}
                        onChange={() => toggleStockChecklistItem(`draft:${selectedDraft.id}:sku`)}
                      />
                    </dd>
                  </div>
                  <div>
                    <dt>Precio</dt>
                    <dd>{money(selectedDraft.price)}</dd>
                  </div>
                  <publishStockFetcher.Form
                    method="post"
                    className={styles.stockPublishForm}
                    onSubmit={(event) => {
                      if (!window.confirm(`¿Marcar ${selectedDraft.sku || selectedDraft.locationCode} como listo?`)) {
                        event.preventDefault();
                      }
                    }}
                  >
                    <input type="hidden" name="intent" value="publish_stock_draft" />
                    <input type="hidden" name="shop" value={shop} />
                    <input type="hidden" name="stockCode" value={accessCode || ""} />
                    <input type="hidden" name="draftId" value={selectedDraft.id} />
                    <button
                      className={styles.primaryButton}
                      type="submit"
                      disabled={publishStockFetcher.state !== "idle" || !isSelectedDraftPublishReady}
                    >
                      {publishStockFetcher.state !== "idle" ? "Guardando..." : "Listo"}
                    </button>
                  </publishStockFetcher.Form>
                </div>
                <div className={styles.detailColorCard}>
                  <dt>Color</dt>
                  <dd>
                    {selectedDraftVariants.map((variant, variantIndex) => (
                      <div className={styles.detailColorRow} key={`${selectedDraft.id}-color-${variantIndex}`}>
                        <strong>{variant.color || "-"}</strong>
                        {variant.sizes.length ? (
                          <div className={styles.detailSizeChecks}>
                            {variant.sizes.map((sizeRow) => (
                              <label
                                className={styles.detailSizeCheck}
                                key={`${selectedDraft.id}-${variantIndex}-${sizeRow.size}`}
                              >
                                <span>
                                  {sizeRow.size}=({sizeRow.quantity})
                                </span>
                                <input
                                  type="checkbox"
                                  aria-label={`Listo ${variant.color || "color"} ${sizeRow.size}`}
                                  checked={Boolean(
                                    checkedStockItems[
                                      `draft:${selectedDraft.id}:variant:${variantIndex}:size:${sizeRow.size}`
                                    ],
                                  )}
                                  onChange={() =>
                                    toggleStockChecklistItem(
                                      `draft:${selectedDraft.id}:variant:${variantIndex}:size:${sizeRow.size}`,
                                    )
                                  }
                                />
                              </label>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </dd>
                </div>
              </dl>
              {publishStockFetcher.data?.error ? (
                <p className={styles.error}>{publishStockFetcher.data.error}</p>
              ) : null}
              {selectedDraft.notes ? <p className={styles.notes}>{selectedDraft.notes}</p> : null}
            </article>
          ) : null}
        </section>
      ) : null}
      {previewPhoto ? (
        <div className={styles.photoViewerBackdrop} role="presentation">
          <div className={styles.photoViewer} role="dialog" aria-modal="true">
            <button className={styles.photoViewerClose} type="button" onClick={closePhotoPreview}>
              Cerrar
            </button>
            <div
              className={styles.photoViewerStage}
              onTouchStart={handlePreviewTouchStart}
              onTouchMove={handlePreviewTouchMove}
              onTouchEnd={handlePreviewTouchEnd}
              onClick={(event) => {
                if (event.currentTarget === event.target) closePhotoPreview();
              }}
            >
              <img
                src={previewPhoto.dataUrl}
                alt={previewPhoto.name || "Foto del producto"}
                style={{
                  transform: `translate3d(${photoZoom.x}px, ${photoZoom.y}px, 0) scale(${photoZoom.scale})`,
                }}
              />
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
