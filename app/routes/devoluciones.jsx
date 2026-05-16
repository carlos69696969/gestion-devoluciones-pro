/* eslint-disable react/prop-types */
import { useEffect, useMemo, useState } from "react";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import styles from "../styles/devoluciones.module.css";

const DEFAULT_REASONS = [
  "Me quedo grande",
  "Me quedo chico",
  "Ya no lo quiero",
  "No era lo que pedi",
  "Llego danado",
  "Otro",
];

const DEFAULT_EVIDENCE_REASONS = ["No era lo que pedi", "Llego danado"];
const ADMIN_API_VERSION = "2025-10";
const RETURNED_TO_CUSTOMER_KIND = "returned_to_customer";
const NOT_RETURNED_KIND = "not_returned_after_30_days";
const REQUEST_CREATED_KIND = "request_created";
const STATUS_REVIEW_KIND = "status_review";
const STATUS_APPROVED_KIND = "status_approved";
const STATUS_RECEIVED_KIND = "status_received";
const STATUS_REFUNDED_KIND = "status_refunded";
const PICKUP_DEADLINE_DAYS = 30;
const RETURNED_TO_CUSTOMER_MESSAGE = "Tu devolución fue regresada con éxito.";
const TIMELINE_META_KINDS = new Set([
  REQUEST_CREATED_KIND,
  STATUS_REVIEW_KIND,
  STATUS_APPROVED_KIND,
  STATUS_RECEIVED_KIND,
  STATUS_REFUNDED_KIND,
  RETURNED_TO_CUSTOMER_KIND,
  NOT_RETURNED_KIND,
]);
const ITEM_BLOCK_STATUSES = new Set([
  "en_revision",
  "aprobada",
  "intento_fallido_1",
  "intento_fallido_2",
  "recibida",
  "por_devolver",
  "reembolso_denegado",
  "no_devuelto",
  "reembolsada",
  "completada",
  "denegada",
]);
const ACTIVE_RETURN_STATUSES = new Set([
  "en_revision",
  "aprobada",
  "intento_fallido_1",
  "intento_fallido_2",
  "recibida",
  "por_devolver",
  "reembolso_denegado",
  "no_devuelto",
  "reembolsada",
  "completada",
  "rechazada",
  "denegada",
]);
const DELIVERED_RETURN_STATUSES = new Set(["recibida", "reembolsada", "completada"]);

function jsonWithCors(data) {
  return Response.json(data, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

function maybeProbeResponse(isProbe, payload) {
  return isProbe ? jsonWithCors(payload) : payload;
}

function normalizePortalMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "new") return "new";
  if (mode === "summary") return "summary";
  return "";
}

function parseLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function reasonKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    // Make comparisons accent-insensitive (e.g. "dañado" vs "danado").
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function itemKeyFromRecord(item) {
  const lineItemId = String(item?.lineItemId || "").trim();
  if (lineItemId) return `line:${lineItemId}`;
  const variantId = String(item?.variantId || "").trim();
  if (variantId) return `variant:${variantId}`;
  const productId = String(item?.productId || "").trim();
  if (productId) return `product:${productId}`;
  return `title:${String(item?.title || "").trim().toLowerCase()}`;
}

function getReasonConfig(settings) {
  const reasons = parseLines(settings?.returnReasons);
  const baseReasons = reasons.length ? reasons : DEFAULT_REASONS.slice();
  const evidence = parseLines(settings?.evidenceReasons);
  const baseEvidence = evidence.length ? evidence : DEFAULT_EVIDENCE_REASONS.slice();

  // Ensure evidence reasons are also selectable: if an evidence reason isn't in the main list,
  // append it automatically. Comparisons are done using reasonKey so accents/case don't matter.
  const reasonsByKey = new Map();
  const mergedReasons = [];
  for (const reason of baseReasons) {
    const key = reasonKey(reason);
    if (!key || reasonsByKey.has(key)) continue;
    reasonsByKey.set(key, reason);
    mergedReasons.push(reason);
  }
  for (const reason of baseEvidence) {
    const key = reasonKey(reason);
    if (!key || reasonsByKey.has(key)) continue;
    reasonsByKey.set(key, reason);
    mergedReasons.push(reason);
  }

  const evidenceKeySet = new Set(baseEvidence.map((r) => reasonKey(r)).filter(Boolean));
  const mergedEvidence = mergedReasons.filter((r) => evidenceKeySet.has(reasonKey(r)));

  return {
    reasons: mergedReasons,
    evidenceReasons: mergedEvidence,
    evidenceSet: evidenceKeySet,
  };
}

function normalizeOrder(orderNode) {
  const fallbackName =
    orderNode.shippingAddress?.name ||
    orderNode.billingAddress?.name ||
    "Cliente";
  const fallbackPhone =
    orderNode.shippingAddress?.phone ||
    orderNode.billingAddress?.phone ||
    "";
  const shipping = orderNode.shippingAddress
    ? {
        name: orderNode.shippingAddress.name || "",
        phone: orderNode.shippingAddress.phone || "",
        address1: orderNode.shippingAddress.address1 || "",
        address2: orderNode.shippingAddress.address2 || "",
        city: orderNode.shippingAddress.city || "",
        province: orderNode.shippingAddress.province || "",
        zip: orderNode.shippingAddress.zip || "",
        country: orderNode.shippingAddress.country || "",
      }
    : null;
  const fulfillments = Array.isArray(orderNode?.fulfillments) ? orderNode.fulfillments : [];
  let latestDeliveredMs = 0;
  for (const fulfillment of fulfillments) {
    const deliveredAt = String(fulfillment?.deliveredAt || "").trim();
    if (deliveredAt) {
      const deliveredMs = new Date(deliveredAt).getTime();
      if (Number.isFinite(deliveredMs) && deliveredMs > latestDeliveredMs) latestDeliveredMs = deliveredMs;
    }
    const events = Array.isArray(fulfillment?.events?.nodes) ? fulfillment.events.nodes : [];
    for (const eventNode of events) {
      if (String(eventNode?.status || "").toUpperCase() !== "DELIVERED") continue;
      const happenedAt = String(eventNode?.happenedAt || "").trim();
      if (!happenedAt) continue;
      const eventMs = new Date(happenedAt).getTime();
      if (Number.isFinite(eventMs) && eventMs > latestDeliveredMs) latestDeliveredMs = eventMs;
    }
  }
  const deliveredAtISO = latestDeliveredMs ? new Date(latestDeliveredMs).toISOString() : "";
  return {
    id: orderNode.id,
    orderNumber: orderNode.name?.replace("#", "") || "",
    name: orderNode.name || "",
    displayFulfillmentStatus: String(orderNode.displayFulfillmentStatus || "").toUpperCase(),
    deliveredAt: deliveredAtISO,
    customerName: fallbackName,
    customerEmail: orderNode.email || "",
    customerPhone: fallbackPhone,
    shippingAddress: shipping,
    createdAt: orderNode.createdAt,
    items: orderNode.lineItems.edges.map(({ node }) => ({
      id: node.id,
      productId: node.product?.id || "",
      variantId: node.variant?.id || "",
      imageUrl: node.variant?.image?.url || node.product?.featuredImage?.url || "",
      imageAlt: node.variant?.image?.altText || node.product?.featuredImage?.altText || "",
      title: node.title,
      quantity: node.quantity,
      unitPrice: Number(node.originalUnitPriceSet?.shopMoney?.amount || 0),
    })),
  };
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + Number(days || 0));
  return copy;
}

function toMXN(value) {
  return Number(value || 0).toFixed(2);
}

function normalizeOrderNumber(value) {
  return String(value || "").replace("#", "").trim();
}

function parsePhotoDataUrls(rawValue) {
  if (!rawValue) return [];
  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed.filter(Boolean).slice(0, 2) : [];
  } catch {
    const single = String(rawValue || "").trim();
    return single ? [single] : [];
  }
}

function parseReasonEntries(rawValue) {
  const text = String(rawValue || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    return entries
      .map((entry) => ({
        kind: String(entry?.kind || "").trim() || "legacy",
        reason: String(entry?.reason || "").trim(),
        at: entry?.at ? String(entry.at) : "",
      }))
      .filter((entry) => entry.reason);
  } catch {
    return [{ kind: "legacy", reason: text, at: "" }];
  }
}

function latestReasonFromRaw(rawValue) {
  const entries = parseReasonEntries(rawValue);
  for (let idx = entries.length - 1; idx >= 0; idx -= 1) {
    const kind = String(entries[idx]?.kind || "").toLowerCase();
    if (TIMELINE_META_KINDS.has(kind)) continue;
    return entries[idx]?.reason || "";
  }
  return "";
}

function hasReturnedToCustomerFromRaw(rawValue) {
  const entries = parseReasonEntries(rawValue);
  return entries.some((entry) => String(entry?.kind || "").toLowerCase() === RETURNED_TO_CUSTOMER_KIND);
}

function latestReturnedToCustomerAtFromRaw(rawValue) {
  const entries = parseReasonEntries(rawValue);
  for (let idx = entries.length - 1; idx >= 0; idx -= 1) {
    if (String(entries[idx]?.kind || "").toLowerCase() !== RETURNED_TO_CUSTOMER_KIND) continue;
    return String(entries[idx]?.at || "").trim();
  }
  return "";
}

function latestEntryAtFromKinds(rawValue, kinds) {
  const kindSet = new Set((kinds || []).map((kind) => String(kind || "").toLowerCase()));
  if (!kindSet.size) return "";
  const entries = parseReasonEntries(rawValue);
  for (let idx = entries.length - 1; idx >= 0; idx -= 1) {
    const kind = String(entries[idx]?.kind || "").toLowerCase();
    if (!kindSet.has(kind)) continue;
    return String(entries[idx]?.at || "").trim();
  }
  return "";
}

function isRefundDeniedAfterReceivedFromRaw(rawValue) {
  const entries = parseReasonEntries(rawValue);
  return entries.some((entry) => {
    const kind = String(entry?.kind || "").toLowerCase();
    return kind === "denied_after_received" || kind === RETURNED_TO_CUSTOMER_KIND;
  });
}

function timelineLabelFromStatus(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "en_revision") return "Solicitud en revision";
  if (normalized === "aprobada") return "Devolucion aprobada";
  if (normalized === "intento_fallido_1") return "Intento de devolucion fallido (1 de 2)";
  if (normalized === "intento_fallido_2") return "Intento de devolucion fallido (2 de 2)";
  if (normalized === "rechazada") return "Devolucion rechazada";
  if (normalized === "recibida") return "Recibimos tu producto";
  if (normalized === "por_devolver") return "Pendiente por recoger";
  if (normalized === "no_devuelto") return "No devuelto";
  if (normalized === "denegada" || normalized === "reembolso_denegado") return "Reembolso denegado";
  if (normalized === "reembolsada" || normalized === "completada") return "Reembolso procesado";
  return "Estado actualizado";
}

function timelineToneFromStatus(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "en_revision") return "review";
  if (normalized === "aprobada") return "approved";
  if (normalized === "intento_fallido_1" || normalized === "intento_fallido_2") return "attempt";
  if (normalized === "rechazada") return "rejected";
  if (normalized === "recibida") return "received";
  if (normalized === "por_devolver") return "pending";
  if (normalized === "no_devuelto") return "denied";
  if (normalized === "denegada" || normalized === "reembolso_denegado") return "denied";
  if (normalized === "reembolsada" || normalized === "completada") return "refunded";
  return "default";
}

function timelineLabelFromReasonEntry(entry) {
  const kind = String(entry?.kind || "").toLowerCase();
  if (kind === REQUEST_CREATED_KIND) return "Solicitud de devolucion creada";
  if (kind === STATUS_REVIEW_KIND) return "Solicitud en revision";
  if (kind === STATUS_APPROVED_KIND) return "Devolucion aprobada";
  if (kind === STATUS_RECEIVED_KIND) return "Recibimos tu producto";
  if (kind === STATUS_REFUNDED_KIND) return "Reembolso procesado";
  if (kind === "attempt_failed_1") return "Intento de devolucion fallido (1 de 2)";
  if (kind === "attempt_failed_2") return "Intento de devolucion fallido (2 de 2)";
  if (kind === "review_rejected" || kind === "rejected_after_attempts") return "Devolucion rechazada";
  if (kind === "denied_after_received") return "Reembolso denegado";
  if (kind === NOT_RETURNED_KIND) return "No devuelto";
  if (kind === RETURNED_TO_CUSTOMER_KIND) return "Devolucion devuelta al cliente";
  return "";
}

function timelineToneFromReasonEntry(entry) {
  const kind = String(entry?.kind || "").toLowerCase();
  if (kind === REQUEST_CREATED_KIND) return "default";
  if (kind === STATUS_REVIEW_KIND) return "review";
  if (kind === STATUS_APPROVED_KIND) return "approved";
  if (kind === STATUS_RECEIVED_KIND) return "received";
  if (kind === STATUS_REFUNDED_KIND) return "refunded";
  if (kind === "attempt_failed_1" || kind === "attempt_failed_2") return "attempt";
  if (kind === "review_rejected" || kind === "rejected_after_attempts") return "rejected";
  if (kind === "denied_after_received") return "denied";
  if (kind === NOT_RETURNED_KIND) return "denied";
  if (kind === RETURNED_TO_CUSTOMER_KIND) return "pending";
  return "default";
}

function timelineStatusDescription(status, requestItem) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "en_revision") {
    return "Tu solicitud esta siendo revisada por nuestro equipo.";
  }
  if (normalized === "aprobada") {
    return requestItem.returnMethod === "pickup"
      ? "Tu solicitud fue aprobada. Recogeremos tu producto en el domicilio y fecha indicados."
      : "Tu solicitud fue aprobada. Lleva tu producto a la sucursal de devoluciones.";
  }
  if (normalized === "recibida") {
    return "Recibimos tu producto. Estamos validando para finalizar el proceso.";
  }
  if (normalized === "reembolsada" || normalized === "completada") {
    return "Tu reembolso ya fue procesado al metodo de pago original.";
  }
  if (normalized === "por_devolver") {
    return "Tu paquete esta pendiente por recoger en sucursal.";
  }
  if (normalized === "reembolso_denegado" || normalized === "denegada") {
    return "El reembolso fue denegado. Revisa el motivo de denegacion.";
  }
  if (normalized === "rechazada") {
    return "Tu solicitud fue rechazada. Revisa el motivo para mas detalle.";
  }
  if (normalized === "no_devuelto") {
    return "Se marco como no devuelto por no recoger dentro del plazo.";
  }
  return "";
}

function timelineKindFromStatus(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "en_revision") return STATUS_REVIEW_KIND;
  if (normalized === "aprobada") return STATUS_APPROVED_KIND;
  if (normalized === "recibida") return STATUS_RECEIVED_KIND;
  if (normalized === "reembolsada" || normalized === "completada") return STATUS_REFUNDED_KIND;
  return "";
}

function parseEventMs(value) {
  const text = String(value || "").trim();
  if (!text) return 0;
  const ms = new Date(text).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function normalizeAddress(value) {
  return String(value || "").trim();
}

function buildMapsLink(address) {
  const normalized = normalizeAddress(address);
  if (!normalized || normalized === "-") return "";
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(normalized)}`;
}

function BranchAddressLink({ address }) {
  const normalized = normalizeAddress(address);
  const href = buildMapsLink(address);
  if (!href) return <>{normalized || "-"}</>;
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {normalized}
    </a>
  );
}

function buildStatusTimeline(requestItem) {
  const events = [];
  const entryKinds = new Set(
    (requestItem.reasonEntries || []).map((entry) => String(entry?.kind || "").toLowerCase()).filter(Boolean),
  );
  const pushEvent = (label, at, note = "", tone = "default") => {
    const atMs = parseEventMs(at);
    if (!label || !atMs) return;
    events.push({
      id: `${label}-${atMs}-${events.length}`,
      label,
      at,
      atMs,
      note,
      tone,
    });
  };

  if (!entryKinds.has(REQUEST_CREATED_KIND)) {
    pushEvent("Solicitud de devolucion creada", requestItem.createdAt, "Tu solicitud fue registrada correctamente.");
  }
  if (requestItem.requiresReview && !entryKinds.has(STATUS_REVIEW_KIND)) {
    pushEvent("Solicitud en revision", requestItem.createdAt, "Tu solicitud esta siendo revisada por nuestro equipo.", "review");
  }
  if (!requestItem.requiresReview && !entryKinds.has(STATUS_APPROVED_KIND)) {
    pushEvent(
      "Devolucion aprobada",
      requestItem.createdAt,
      requestItem.returnMethod === "pickup"
        ? "Tu solicitud fue aprobada. Recogeremos tu producto en tu domicilio."
        : "Tu solicitud fue aprobada. Lleva tu producto a la sucursal de devoluciones.",
      "approved",
    );
  }
  if (!entryKinds.has(STATUS_RECEIVED_KIND)) {
    pushEvent(
      "Recibimos tu producto",
      requestItem.receivedAt,
      "Recibimos tu producto. Estamos revisandolo para continuar el proceso.",
      "received",
    );
  }
  if (!entryKinds.has(STATUS_REFUNDED_KIND)) {
    pushEvent(
      "Reembolso procesado",
      requestItem.refundedAt,
      "Tu reembolso fue procesado al metodo de pago original.",
      "refunded",
    );
  }
  if (!entryKinds.has(RETURNED_TO_CUSTOMER_KIND)) {
    pushEvent("Devolucion devuelta al cliente", requestItem.returnedToCustomerAt, RETURNED_TO_CUSTOMER_MESSAGE, "pending");
  }

  for (const entry of requestItem.reasonEntries || []) {
    const label = timelineLabelFromReasonEntry(entry);
    if (!label) continue;
    pushEvent(label, entry.at, entry.reason || "", timelineToneFromReasonEntry(entry));
  }

  const currentStatusKind = timelineKindFromStatus(requestItem.status);
  if (!currentStatusKind || !entryKinds.has(currentStatusKind)) {
    pushEvent(
      timelineLabelFromStatus(requestItem.status),
      requestItem.updatedAt,
      timelineStatusDescription(requestItem.status, requestItem),
      timelineToneFromStatus(requestItem.status),
    );
  }

  const dedup = new Map();
  for (const event of events) {
    const key = `${event.label}|${event.atMs}`;
    if (!dedup.has(key)) dedup.set(key, event);
  }

  return Array.from(dedup.values()).sort((a, b) => b.atMs - a.atMs);
}

function buildOrderImageMap(items) {
  const imageMap = new Map();
  for (const item of items || []) {
    const value = { imageUrl: item.imageUrl || "", imageAlt: item.imageAlt || item.title || "" };
    const keys = [
      itemKeyFromRecord({ lineItemId: item.id }),
      itemKeyFromRecord({ variantId: item.variantId }),
      itemKeyFromRecord({ productId: item.productId }),
      itemKeyFromRecord({ title: item.title }),
    ];
    for (const key of keys) {
      if (!key || imageMap.has(key)) continue;
      imageMap.set(key, value);
    }
  }
  return imageMap;
}

function statusLabelForCustomer(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "en_revision") return "en revision";
  if (normalized === "aprobada") return "aprobada";
  if (normalized === "intento_fallido_1") return "intento de devolucion fallido";
  if (normalized === "intento_fallido_2") return "segundo intento de devolucion fallido";
  if (normalized === "por_devolver") return "recoge tu paquete en nuestra sucursal";
  if (normalized === "reembolso_denegado") return "reembolso denegado";
  if (normalized === "no_devuelto") return "no devuelto";
  if (normalized === "rechazada") return "rechazada";
  if (normalized === "recibida") return "recibida";
  if (normalized === "denegada") return "reembolso denegado";
  if (normalized === "reembolsada") return "reembolsada";
  if (normalized === "completada") return "completada";
  return normalized || "-";
}

async function getOrCreateSettings(shop) {
  const { default: prisma } = await import("../db.server");
  const existing = await prisma.returnSettings.findUnique({ where: { shop } });
  if (existing) return existing;

  return prisma.returnSettings.create({
    data: { shop },
  });
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
                billingAddress { name phone }
                lineItems(first: 50) {
                  edges {
                    node {
                      id
                      title
                      quantity
                      product { id featuredImage { url altText } }
                      variant { id image { url altText } }
                      originalUnitPriceSet { shopMoney { amount } }
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

export const loader = async ({ request }) => {
  const { default: prisma } = await import("../db.server");
  const url = new URL(request.url);
  // eslint-disable-next-line no-undef
  const env = process.env || {};
  const incomingShop = (url.searchParams.get("shop") || "").trim().toLowerCase();
  const configuredShop = String(env.SHOPIFY_SHOP_DOMAIN || "").trim().toLowerCase();
  const shop = incomingShop || configuredShop;
  const orderNumber = (url.searchParams.get("order") || "").trim();
  const email = (url.searchParams.get("email") || "").trim().toLowerCase();
  const requestedMode = normalizePortalMode(url.searchParams.get("mode"));
  const isProbe = url.searchParams.get("probe") === "1";

  if (!shop) {
    return maybeProbeResponse(isProbe, {
      error: "Falta el dominio de la tienda.",
      autoOrder: null,
      settings: null,
      reasons: DEFAULT_REASONS,
      evidenceReasons: DEFAULT_EVIDENCE_REASONS,
      requestedMode,
    });
  }

  const baseSettings = await getOrCreateSettings(shop);
  const baseReasonConfig = getReasonConfig(baseSettings);

  if (!orderNumber) {
    return maybeProbeResponse(isProbe, {
      reasons: baseReasonConfig.reasons,
      evidenceReasons: baseReasonConfig.evidenceReasons,
      settings: baseSettings,
      autoOrder: null,
      shop,
      requestedMode,
      info:
        "Abre esta pagina desde el boton 'Solicitar devolucion' de tu pedido para reconocer tu orden automaticamente.",
    });
  }

  const rawCandidates = Array.from(new Set([incomingShop, configuredShop].filter(Boolean)));
  const allSessions = await prisma.session.findMany({
    select: { id: true, shop: true, isOnline: true, accessToken: true },
  });
  const offlineSessions = allSessions.filter((session) => session.isOnline === false);
  const offlineShops = offlineSessions
    .map((session) => String(session.shop || "").trim().toLowerCase())
    .filter(Boolean);
  const sessionShops = offlineSessions
    .map((session) => String(session.shop || "").trim().toLowerCase())
    .filter(Boolean);
  // Prefer the explicit shop from URL, then configured shop. If we don't have any sessions
  // for that shop (common when the store has multiple myshopify.com domains), fall back to
  // whatever sessions we do have so we can still fetch orders.
  const preferredShops = incomingShop
    ? [incomingShop]
    : configuredShop
      ? [configuredShop]
      : [];
  const preferredHasSession = preferredShops.some((s) =>
    allSessions.some((sess) => String(sess.shop || "").trim().toLowerCase() === s),
  );
  const candidateShops = preferredShops.length
    ? (preferredHasSession
        ? preferredShops
        : Array.from(new Set([...preferredShops, ...offlineShops, ...sessionShops])))
    : Array.from(new Set([...offlineShops, ...sessionShops]));

  if (!candidateShops.length) {
    return maybeProbeResponse(isProbe, {
      reasons: baseReasonConfig.reasons,
      evidenceReasons: baseReasonConfig.evidenceReasons,
      settings: baseSettings,
      autoOrder: null,
      shop,
      requestedMode,
      error: "No se encontro sesion valida para la tienda.",
      diagnostic: `Tiendas recibidas: ${rawCandidates.join(", ") || "-"} | Agrega la tienda correcta en el parametro shop del boton y reinstala la app para regenerar sesion offline.`,
    });
  }
  let lastError = null;
  let triedWithSession = [];

  for (const shopCandidate of candidateShops) {
    const sessionCandidates = allSessions.filter(
      (session) => String(session.shop || "").trim().toLowerCase() === shopCandidate,
    );
    if (!sessionCandidates.length) {
      continue;
    }
    triedWithSession.push(shopCandidate);
    try {
      const canonicalOfflineId = `offline_${shopCandidate}`;
      const orderedCandidates = [
        ...sessionCandidates.filter((s) => s.id === canonicalOfflineId),
        ...sessionCandidates
          .filter((s) => s.id !== canonicalOfflineId)
          // Prefer any offline sessions next, then online sessions as fallback.
          .sort((a, b) => {
            const aOffline = a.isOnline === false ? 0 : 1;
            const bOffline = b.isOnline === false ? 0 : 1;
            return aOffline - bOffline;
          }),
      ];
      let candidates = [];
      let fallbackError = null;
      for (const sessionCandidate of orderedCandidates) {
        try {
          const accessToken = sessionCandidate.accessToken;
          if (!accessToken) continue;
          candidates = await fetchOrderCandidatesByToken({
            shop: shopCandidate,
            accessToken,
            orderNumber,
          });
          fallbackError = null;
          break;
        } catch (tokenError) {
          fallbackError = tokenError;
        }
      }
      if (fallbackError) throw fallbackError;

      // Shopify search by `name:#XXXX` can return close matches like #XXXX0.
      // Keep only exact order-number matches to avoid ambiguity when email is not available.
      candidates = candidates.filter(
        (orderNode) => normalizeOrderNumber(orderNode?.name) === normalizeOrderNumber(orderNumber),
      );

      let match = null;
      if (email) {
        match = candidates.find((o) => (o.email || "").toLowerCase() === email) || null;
        if (!match && candidates.length) {
          const emails = candidates
            .map((o) => String(o.email || "").trim().toLowerCase())
            .filter(Boolean);
          lastError = new Error(
            `No se encontro el pedido #${orderNumber} con ese correo en ${shopCandidate}. Correos encontrados: ${emails.join(", ") || "-"}`,
          );
        }
      } else {
        // The order status page button may not expose the email. If Shopify returns a single
        // candidate for this order number, use it; otherwise require email for disambiguation.
        if (candidates.length === 1) {
          match = candidates[0];
        } else if (candidates.length > 1) {
          const emails = candidates
            .map((o) => String(o.email || "").trim().toLowerCase())
            .filter(Boolean);
          lastError = new Error(
            `Hay ${candidates.length} pedidos que coinciden con #${orderNumber} en ${shopCandidate}. Incluye el parametro email para elegir el correcto. Correos encontrados: ${emails.join(", ") || "-"}`,
          );
        }
      }

      if (!match) {
        continue;
      }

      const order = normalizeOrder(match);
      // IMPORTANT: settings are stored per-shop. If the store has multiple myshopify.com
      // domains, we may find the order using a different domain than the one in the URL.
      // Always use the canonical shopCandidate for settings so admin changes apply.
      const settings = await getOrCreateSettings(shopCandidate);
      const { reasons, evidenceReasons } = getReasonConfig(settings);
      const previousRequests = await prisma.returnRequest.findMany({
        where: {
          shop: shopCandidate,
          shopifyOrderId: order.id,
        },
        include: { items: true },
        orderBy: { createdAt: "desc" },
      });
      const blockedItemKeys = new Set();
      const rejectedReasonsByItemKey = new Map();
      for (const requestRow of previousRequests) {
        for (const item of requestRow.items) {
          const key = itemKeyFromRecord(item);
          if (ITEM_BLOCK_STATUSES.has(String(requestRow.status || "").toLowerCase())) {
            blockedItemKeys.add(key);
          } else if (
            String(requestRow.status || "").toLowerCase() === "rechazada" &&
            isRefundDeniedAfterReceivedFromRaw(requestRow.rejectionReason)
          ) {
            // Backward compatibility: old denied returns were stored as "rechazada".
            blockedItemKeys.add(key);
          }
          if (
            ["rechazada", "denegada", "por_devolver", "reembolso_denegado", "no_devuelto"].includes(String(requestRow.status || "").toLowerCase()) &&
            latestReasonFromRaw(requestRow.rejectionReason) &&
            !rejectedReasonsByItemKey.has(key)
          ) {
            rejectedReasonsByItemKey.set(key, latestReasonFromRaw(requestRow.rejectionReason));
          }
        }
      }
      const itemsWithEligibility = order.items.map((item) => {
        const key = itemKeyFromRecord({
          lineItemId: item.id,
          variantId: item.variantId,
          productId: item.productId,
          title: item.title,
        });
        return {
          ...item,
          isAlreadyReturned: blockedItemKeys.has(key),
          lastRejectedReason: rejectedReasonsByItemKey.get(key) || "",
        };
      });
      const orderImageMap = buildOrderImageMap(order.items);
      const completedRequests = previousRequests
        .filter((requestRow) => ACTIVE_RETURN_STATUSES.has(String(requestRow.status || "").toLowerCase()))
        .map((requestRow) => {
          const status = String(requestRow.status || "").toLowerCase();
          const pendingPickupSinceAt =
            latestEntryAtFromKinds(requestRow.rejectionReason, ["denied_after_received"]) ||
            requestRow.updatedAt?.toISOString?.() ||
            "";
          const pickupDeadlineDate =
            ["por_devolver", "reembolso_denegado", "denegada", "no_devuelto"].includes(status) && pendingPickupSinceAt
              ? addDays(pendingPickupSinceAt, PICKUP_DEADLINE_DAYS)
              : null;
          return {
          id: requestRow.id,
          status,
          statusLabel: statusLabelForCustomer(requestRow.status),
          rejectionReason: latestReasonFromRaw(requestRow.rejectionReason),
          reasonEntries: parseReasonEntries(requestRow.rejectionReason),
          wasReturnedToCustomer: hasReturnedToCustomerFromRaw(requestRow.rejectionReason),
          returnedToCustomerAt: latestReturnedToCustomerAtFromRaw(requestRow.rejectionReason),
          pickupDeadlineAt: pickupDeadlineDate ? pickupDeadlineDate.toISOString() : "",
          createdAt: requestRow.createdAt,
          updatedAt: requestRow.updatedAt,
          receivedAt: requestRow.receivedAt,
          refundedAt: requestRow.refundedAt,
          orderNumber: requestRow.orderNumber,
          customerName: requestRow.customerName || order.customerName || "-",
          customerEmail: requestRow.customerEmail || order.customerEmail || "-",
          customerPhone: requestRow.customerPhone || order.customerPhone || "-",
          returnMethod: requestRow.returnMethod,
          // Always reflect the latest admin configuration for branch pickup details.
          branchAddress: settings.branchAddress || "-",
          branchInstructions: settings.branchInstructions || "-",
          branchHours: settings.branchHours || "-",
          pickupAddress: requestRow.pickupAddress || "-",
          pickupNeighborhood: requestRow.pickupNeighborhood || "-",
          pickupCity: requestRow.pickupCity || "-",
          pickupState: requestRow.pickupState || "-",
          pickupPostalCode: requestRow.pickupPostalCode || "-",
          pickupDate: requestRow.pickupDate || "-",
          pickupNotes: requestRow.pickupNotes || "",
          requiresReview: Boolean(requestRow.requiresReview),
          estimatedRefund: Number(requestRow.estimatedRefund || 0),
          returnCost: Number(requestRow.returnCost || 0),
          finalRefund: Number(requestRow.finalRefund || 0),
          items: (requestRow.items || []).map((item) => {
            const image =
              orderImageMap.get(
                itemKeyFromRecord({
                  lineItemId: item.lineItemId,
                  variantId: item.variantId,
                  productId: item.productId,
                  title: item.title,
                }),
              ) || {};
            return {
              id: item.id,
              title: item.title,
              quantity: Number(item.quantity || 1),
              reason: item.reason || "-",
              details: item.details || "",
              photoDataUrls: parsePhotoDataUrls(item.photoDataUrl),
              imageUrl: image.imageUrl || "",
              imageAlt: image.imageAlt || item.title || "Producto",
            };
          }),
        };
      });
      const existingRequestCountAnyShop = await prisma.returnRequest.count({
        where: {
          orderNumber: order.orderNumber,
          ...(email
            ? {
                customerEmail: {
                  equals: email,
                  mode: "insensitive",
                },
              }
            : {}),
        },
      });
      const hasExistingReturns = completedRequests.length > 0 || existingRequestCountAnyShop > 0;
      const hasEligibleItems = itemsWithEligibility.some((item) => !item.isAlreadyReturned);
      const isDelivered = Boolean(order.deliveredAt);
      const limitBaseDate = isDelivered ? new Date(order.deliveredAt) : null;
      const limitDate = limitBaseDate ? addDays(limitBaseDate, settings.returnWindowDays) : null;
      const now = new Date();
      const isExpired = limitDate ? now > limitDate : false;
      const latestRequest = completedRequests[0] || null;
      const latestStatus = String(latestRequest?.status || "").toLowerCase();
      const hasPendingReview = latestStatus === "en_revision";
      const hasFailedPickupAttempt = ["intento_fallido_1", "intento_fallido_2"].includes(latestStatus);
      const hasRejected = latestStatus === "rechazada";
      const hasDenied = ["denegada", "por_devolver", "reembolso_denegado", "no_devuelto"].includes(latestStatus);
      const allDelivered =
        completedRequests.length > 0 &&
        completedRequests.every((requestRow) => DELIVERED_RETURN_STATUSES.has(requestRow.status));
      const hasRefundProcessed = ["reembolsada", "completada"].includes(latestStatus);
      const completionTitle = hasPendingReview
        ? "Solicitud de devolucion en revision."
        : hasFailedPickupAttempt
          ? "Intento de devolucion fallido."
        : hasRejected
          ? "Solicitud de devolucion rechazada."
        : hasDenied
          ? "Reembolso denegado."
        : allDelivered
          ? "Devolucion completada con exito."
          : "Solicitud de devolucion registrada.";
      const completionText = hasPendingReview
        ? "Tu solicitud ya fue registrada. Estamos revisandola y aqui puedes ver su estado."
        : hasFailedPickupAttempt
          ? "Tuvimos un intento de recoleccion fallido. Revisa el motivo en el detalle y espera el siguiente intento."
        : hasRejected
          ? "Tu solicitud fue rechazada. Puedes revisar el motivo y volver a solicitar tu devolucion."
        : hasDenied
          ? "Tu reembolso fue denegado. Revisa el motivo de denegacion en el detalle."
        : allDelivered
          ? "Todos los productos de este pedido fueron devueltos con exito."
          : "Tu solicitud ya fue registrada. Aqui puedes ver todos los datos de tu devolucion.";
      const completionRefundText = hasRefundProcessed
        ? "Tu reembolso ya fue procesado correctamente. Dependiendo de tu banco, puede reflejarse en un plazo de 5 a 10 dias habiles."
        : "";
      return maybeProbeResponse(isProbe, {
        reasons,
        evidenceReasons,
        settings,
        autoOrder: {
          ...order,
          items: itemsWithEligibility,
        },
        shop: shopCandidate,
        requestedMode,
        hasExistingReturns,
        hasEligibleItems,
        isExpired,
        limitDate: limitDate ? limitDate.toISOString() : "",
        completedRequests,
        completedAllDelivered: allDelivered,
        completedTitle: completionTitle,
        completedText: completionText,
        completedRefundText: completionRefundText,
        hasDeniedStatus: hasDenied,
        isDelivered,
        message: !isDelivered
          ? "Tu pedido aun no esta marcado como entregado. Las devoluciones se habilitan cuando se marca como entregado."
          : isExpired
            ? `Tu periodo de devolucion vencio el ${limitDate.toLocaleDateString("es-MX")}.`
            : hasEligibleItems
              ? `Estas dentro del periodo de devolucion (${settings.returnWindowDays} dias). Fecha limite: ${limitDate.toLocaleDateString("es-MX")}.`
              : completionTitle,
      });
    } catch (err) {
      lastError = err;
    }
  }

  try {
    if (!lastError) {
      throw new Error("No se encontro un pedido valido en las tiendas configuradas.");
    }
    throw lastError;
  } catch (err) {
    const rawMessage = String(err?.message || err || "");
    const isOrdersScopeError =
      rawMessage.toLowerCase().includes("orders") &&
      rawMessage.toLowerCase().includes("access denied");

    const diagnostic = [
      `Tiendas probadas: ${candidateShops.join(", ") || "-"}`,
      `Tiendas probadas con sesion: ${triedWithSession.join(", ") || "-"}`,
      `Tiendas con sesion offline: ${offlineShops.join(", ") || "-"}`,
      `Ids de sesion offline: ${offlineSessions.map((s) => s.id).join(", ") || "-"}`,
      `Ids de sesion totales: ${allSessions.map((s) => s.id).join(", ") || "-"}`,
      `Pedido recibido: ${orderNumber || "-"}`,
      `Email recibido: ${email || "-"}`,
    ].join(" | ");

    return maybeProbeResponse(isProbe, {
      reasons: getReasonConfig(baseSettings).reasons,
      evidenceReasons: getReasonConfig(baseSettings).evidenceReasons,
      settings: baseSettings,
      autoOrder: null,
      shop,
      requestedMode,
      error: isOrdersScopeError
        ? "La app no tiene permisos de pedidos (read_orders) para esta tienda."
        : "No se pudo cargar el pedido automaticamente.",
      diagnostic: `${diagnostic} | Shop original: ${incomingShop || "-"} | Error tecnico: ${rawMessage || "-"}`,
    });
  }
};

export const action = async ({ request }) => {
  const { default: prisma } = await import("../db.server");
  const formData = await request.formData();
  const shop = String(formData.get("shop") || "").trim().toLowerCase();
  const payloadRaw = String(formData.get("payload") || "");

  if (!shop || !payloadRaw) {
    return { ok: false, error: "Informacion incompleta para enviar la devolucion." };
  }

  const settings = await getOrCreateSettings(shop);
  const payload = JSON.parse(payloadRaw);
  const { evidenceSet } = getReasonConfig(settings);

  if (!payload.items?.length) {
    return { ok: false, error: "Selecciona al menos un producto." };
  }

  const requiresReview = payload.items.some((item) => evidenceSet.has(reasonKey(item.reason)));
  const previousRequests = await prisma.returnRequest.findMany({
    where: {
      shop,
      shopifyOrderId: String(payload?.order?.id || ""),
      status: { in: Array.from(ITEM_BLOCK_STATUSES) },
    },
    include: { items: true },
  });
  const blockedItemKeys = new Set();
  for (const requestRow of previousRequests) {
    for (const item of requestRow.items) {
      blockedItemKeys.add(itemKeyFromRecord(item));
    }
  }
  const duplicatedItem = payload.items.find((item) =>
    blockedItemKeys.has(
      itemKeyFromRecord({
        lineItemId: item.id,
        variantId: item.variantId,
        productId: item.productId,
        title: item.title,
      }),
    ),
  );
  if (duplicatedItem) {
    return {
      ok: false,
      error: `El producto "${duplicatedItem.title}" ya tiene una devolucion activa, ya fue devuelto o fue denegado.`,
    };
  }

  for (const item of payload.items) {
    if (evidenceSet.has(reasonKey(item.reason))) {
      if (!String(item.details || "").trim()) {
        return {
          ok: false,
          error: "Para 'Llego danado' o 'No era lo que pedi' debes escribir descripcion.",
        };
      }
      const photos = Array.isArray(item.photoDataUrls)
        ? item.photoDataUrls.filter(Boolean)
        : String(item.photoDataUrl || "").trim()
          ? [String(item.photoDataUrl)]
          : [];
      if (!photos.length) {
        return {
          ok: false,
          error: "Para 'Llego danado' o 'No era lo que pedi' debes subir una foto.",
        };
      }
    }
  }

  if (payload.returnMethod === "pickup") {
    const required = [
      "pickupAddress",
      "pickupCity",
      "pickupState",
      "pickupPostalCode",
      "pickupDate",
    ];
    const missing = required.find((field) => !String(payload[field] || "").trim());
    if (missing) {
      return { ok: false, error: "Completa todos los datos de recoleccion." };
    }
  }

  const deliveredAt = String(payload?.order?.deliveredAt || "").trim();
  if (!deliveredAt) {
    return {
      ok: false,
      error: "Tu pedido aun no esta marcado como entregado. Las devoluciones se habilitan cuando se marca como entregado.",
    };
  }

  const deliveryDate = new Date(deliveredAt);
  if (!Number.isFinite(deliveryDate.getTime())) {
    return {
      ok: false,
      error: "No pudimos validar la fecha de entrega de tu pedido. Intenta de nuevo en unos minutos.",
    };
  }

  const limitDate = addDays(deliveryDate, settings.returnWindowDays);
  if (new Date() > limitDate) {
    return {
      ok: false,
      error: `Tu periodo de devolucion vencio el ${limitDate.toLocaleDateString("es-MX")}.`,
    };
  }

  if (payload.returnMethod === "pickup" && String(payload.pickupDate || "").trim()) {
    const selectedDate = new Date(`${payload.pickupDate}T23:59:59`);
    if (Number.isFinite(selectedDate.getTime()) && selectedDate.getTime() > limitDate.getTime()) {
      return {
        ok: false,
        error: `Esa fecha sobrepasa el tiempo de devolucion. Fecha limite: ${limitDate.toLocaleDateString("es-MX")}.`,
      };
    }
  }

  const estimatedRefund = Number(payload.estimatedRefund || 0);
  const pickupCost = Number(settings.pickupCost || 0);
  const effectivePickupCost = requiresReview ? 0 : pickupCost;
  const returnCost = payload.returnMethod === "pickup" ? effectivePickupCost : 0;
  const finalRefundRaw = estimatedRefund - returnCost;
  if (payload.returnMethod === "pickup" && returnCost > 0 && finalRefundRaw <= 0) {
    return {
      ok: false,
      error:
        "El costo de recoleccion es mayor o igual al subtotal de productos. Elige entrega en sucursal para continuar.",
    };
  }
  const finalRefund = Math.max(0, finalRefundRaw);
  const createdTimelineAt = new Date().toISOString();
  const initialStatusKind = requiresReview ? STATUS_REVIEW_KIND : STATUS_APPROVED_KIND;
  const initialStatusMessage = requiresReview
    ? "Tu solicitud esta siendo revisada por nuestro equipo."
    : payload.returnMethod === "pickup"
      ? "Tu solicitud fue aprobada. Recogeremos tu producto en tu domicilio en la fecha establecida por ti."
      : "Tu solicitud fue aprobada. Lleva tu producto a la sucursal de devoluciones.";
  const initialTimelineEntries = [
    {
      kind: REQUEST_CREATED_KIND,
      reason: "Solicitud de devolucion registrada.",
      at: createdTimelineAt,
    },
    {
      kind: initialStatusKind,
      reason: initialStatusMessage,
      at: createdTimelineAt,
    },
  ];

  await prisma.returnRequest.create({
    data: {
      shop,
      shopifyOrderId: payload.order.id,
      orderNumber: payload.order.orderNumber,
      customerName: payload.customerName || payload.order.customerName,
      customerEmail: payload.customerEmail || payload.order.customerEmail,
      customerPhone: payload.customerPhone || payload.order.customerPhone || null,
      returnMethod: payload.returnMethod,
      returnCost,
      estimatedRefund,
      finalRefund,
      requiresReview,
      status: requiresReview ? "en_revision" : "aprobada",
      rejectionReason: JSON.stringify({ entries: initialTimelineEntries }),
      branchAddress: settings.branchAddress,
      branchInstructions: settings.branchInstructions,
      branchHours: settings.branchHours,
      pickupInstructions: settings.pickupInstructions,
      pickupHours: settings.pickupHours,
      pickupDate: payload.pickupDate || null,
      pickupTimeSlot: null,
      pickupNotes: payload.pickupNotes || null,
      limitDate,
      pickupFullName: payload.pickupFullName || null,
      pickupPhone: payload.pickupPhone || null,
      pickupAddress: payload.pickupAddress || null,
      pickupNeighborhood: payload.pickupNeighborhood || null,
      pickupCity: payload.pickupCity || null,
      pickupState: payload.pickupState || null,
      pickupPostalCode: payload.pickupPostalCode || null,
      pickupReferences: payload.pickupReferences || null,
      items: {
        create: payload.items.map((item) => ({
          lineItemId: item.id || null,
          productId: item.productId || "",
          variantId: item.variantId || null,
          title: item.title,
          quantity: Number(item.quantity || 1),
          reason: item.reason,
          details: item.details || null,
          // Store up to 2 photos as JSON in the existing column (keeps schema unchanged)
          photoDataUrl: Array.isArray(item.photoDataUrls)
            ? JSON.stringify(item.photoDataUrls.slice(0, 2))
            : item.photoDataUrl || null,
        })),
      },
    },
  });

  return {
    ok: true,
    saved: true,
    requiresReview,
    message: requiresReview
      ? "Estamos revisando tu solicitud. Una vez que revisemos las fotos y aprobemos tu devolucion, te notificaremos por WhatsApp."
      : "Tu devolucion fue aprobada automaticamente.",
  };
};

export default function PublicReturnsPortal() {
  const {
    reasons,
    evidenceReasons,
    settings,
    autoOrder,
    shop,
    hasEligibleItems,
    error,
    info,
    isExpired,
    limitDate,
    message,
    diagnostic,
    completedRequests = [],
    completedTitle = "Solicitud de devolucion completada.",
    completedText = "",
    completedRefundText = "",
    requestedMode = "",
    hasDeniedStatus = false,
    isDelivered = false,
  } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const hasExistingReturns = completedRequests.length > 0 || Boolean(actionData?.saved);
  const effectivePortalMode = (() => {
    if (actionData?.saved) return "summary";
    if (requestedMode === "new") return "new";
    if (requestedMode === "summary") return hasExistingReturns ? "summary" : "new";
    return hasExistingReturns ? "summary" : "new";
  })();
  const hasNoEligibleItems =
    autoOrder && isDelivered && !isExpired && effectivePortalMode === "new" && !hasEligibleItems;
  const showNewRequestForm =
    autoOrder && isDelivered && !isExpired && effectivePortalMode === "new" && hasEligibleItems;
  const showSummaryView =
    autoOrder && isDelivered && !isExpired && effectivePortalMode === "summary" && hasExistingReturns;

  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <div className={styles.header}>
          <div>
            <h1 className={styles.h1}>Portal de devoluciones</h1>
            {info ? <p className={`${styles.notice} ${styles.noticeMuted}`}>{info}</p> : null}
            {typeof diagnostic === "string" ? (
              <p className={`${styles.notice} ${styles.noticeMuted}`}>{diagnostic}</p>
            ) : null}
            {error ? <p className={`${styles.notice} ${styles.noticeError}`}>{error}</p> : null}
            {message ? (
              <p
                className={`${styles.notice} ${
                  isExpired || hasDeniedStatus ? styles.noticeError : styles.noticeSuccess
                }`}
              >
                {message}
              </p>
            ) : null}
          </div>
        </div>

        {showNewRequestForm ? (
          <ReturnsRequestForm
            order={autoOrder}
            reasons={reasons}
            evidenceReasons={evidenceReasons}
            settings={settings}
            shop={shop}
            isSubmitting={isSubmitting}
            actionData={actionData}
          />
        ) : null}

        {hasNoEligibleItems ? (
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>No hay productos disponibles</h2>
            <p className={styles.cardMeta}>Este pedido ya no tiene productos para devolver.</p>
          </section>
        ) : null}

        {autoOrder && isDelivered && isExpired ? (
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>Periodo vencido</h2>
            <p className={styles.cardMeta}>
              No puedes continuar. Fecha limite: {new Date(limitDate).toLocaleDateString("es-MX")}.
            </p>
          </section>
        ) : null}

        {showSummaryView ? (
          <CompletedReturnsSection
            completedTitle={completedTitle}
            completedText={completedText}
            completedRefundText={completedRefundText}
            completedRequests={completedRequests}
          />
        ) : null}
      </div>
    </main>
  );
}

function CompletedReturnsSection({ completedTitle, completedText, completedRefundText, completedRequests }) {
  return (
    <section className={styles.card}>
      <h2 className={styles.cardTitle}>{completedTitle}</h2>
      <p className={styles.cardMeta}>{completedText}</p>
      {completedRefundText ? <p className={`${styles.cardMeta} ${styles.refundProcessedText}`}>{completedRefundText}</p> : null}
      <div className={styles.divider} />
      <div className={styles.completedGrid}>
        {completedRequests.map((requestItem) => (
          <CompletedReturnSummary key={requestItem.id} requestItem={requestItem} />
        ))}
      </div>
    </section>
  );
}

function ImageViewer({ image, onClose }) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  useEffect(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setDragging(false);
  }, [image?.src]);

  if (!image?.src) return null;

  const applyZoom = (nextZoom) => {
    const clamped = Math.min(4, Math.max(1, Number(nextZoom || 1)));
    setZoom(clamped);
    if (clamped <= 1) setOffset({ x: 0, y: 0 });
  };

  const beginDrag = (event) => {
    if (zoom <= 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    setDragStart({
      x: event.clientX - offset.x,
      y: event.clientY - offset.y,
    });
  };

  const onDrag = (event) => {
    if (!dragging || zoom <= 1) return;
    setOffset({
      x: event.clientX - dragStart.x,
      y: event.clientY - dragStart.y,
    });
  };

  const finishDrag = (event) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
  };

  return (
    <div className={styles.imageViewerOverlay} onClick={onClose} role="presentation">
      <div className={styles.imageViewerDialog} onClick={(event) => event.stopPropagation()} role="presentation">
        <div className={styles.imageViewerToolbar}>
          <button type="button" className={styles.imageViewerBtn} onClick={() => applyZoom(zoom - 0.25)}>
            -
          </button>
          <span className={styles.imageViewerZoom}>{Math.round(zoom * 100)}%</span>
          <button type="button" className={styles.imageViewerBtn} onClick={() => applyZoom(zoom + 0.25)}>
            +
          </button>
          <button type="button" className={styles.imageViewerBtn} onClick={() => applyZoom(1)}>
            Reset
          </button>
          <button type="button" className={styles.imageViewerBtn} onClick={onClose}>
            Cerrar
          </button>
        </div>
        <div
          className={styles.imageViewerStage}
          onWheel={(event) => {
            event.preventDefault();
            applyZoom(zoom + (event.deltaY < 0 ? 0.2 : -0.2));
          }}
        >
          <img
            src={image.src}
            alt={image.alt || "Imagen"}
            className={styles.imageViewerImg}
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
              cursor: zoom > 1 ? (dragging ? "grabbing" : "grab") : "zoom-in",
            }}
            onDoubleClick={() => applyZoom(zoom > 1 ? 1 : 2)}
            onPointerDown={beginDrag}
            onPointerMove={onDrag}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
            draggable={false}
          />
        </div>
      </div>
    </div>
  );
}

function timelineToneClassName(tone) {
  if (tone === "review") return styles.timelineToneReview;
  if (tone === "approved") return styles.timelineToneApproved;
  if (tone === "attempt") return styles.timelineToneAttempt;
  if (tone === "rejected") return styles.timelineToneRejected;
  if (tone === "received") return styles.timelineToneReceived;
  if (tone === "pending") return styles.timelineTonePending;
  if (tone === "denied") return styles.timelineToneDenied;
  if (tone === "refunded") return styles.timelineToneRefunded;
  return "";
}

function CompletedReturnSummary({ requestItem }) {
  const [viewerImage, setViewerImage] = useState(null);
  const [showAllStates, setShowAllStates] = useState(false);
  const timelineEvents = useMemo(() => buildStatusTimeline(requestItem), [requestItem]);
  const currentTimelineEvent = timelineEvents[0] || null;
  const normalizedStatus = String(requestItem.status || "").toLowerCase();
  const isFailedPickupAttempt =
    normalizedStatus === "intento_fallido_1" || normalizedStatus === "intento_fallido_2";
  const isSecondFailedPickupAttempt = normalizedStatus === "intento_fallido_2";
  const isPendingToReturn = normalizedStatus === "por_devolver";
  const failedAttemptLabel =
    normalizedStatus === "intento_fallido_2"
      ? "Segundo intento de devolucion fallido"
      : "Intento de devolucion fallido";
  const isRejectedOrDenied = ["rechazada", "denegada", "por_devolver", "reembolso_denegado", "no_devuelto"].includes(
    normalizedStatus,
  );
  const isReview = normalizedStatus === "en_revision";
  const isApproved = normalizedStatus === "aprobada";
  const isReceived = normalizedStatus === "recibida";
  const isRefunded = normalizedStatus === "reembolsada";
  const pickupDeadlineLabel = requestItem.pickupDeadlineAt
    ? new Date(requestItem.pickupDeadlineAt).toLocaleDateString("es-MX")
    : "";
  return (
    <article className={styles.completedCard}>
      <h3 className={styles.completedTitle}>Pedido #{requestItem.orderNumber}</h3>
      <p className={styles.completedMeta}>
        Cliente: {requestItem.customerName} | Email: {requestItem.customerEmail} | Telefono: {requestItem.customerPhone}
      </p>
      <p className={styles.completedStatus}>
        Estado de devolucion:{" "}
        <strong
          className={
            isRejectedOrDenied
              ? styles.deniedText
              : isReview
                ? styles.reviewText
                : isApproved
                  ? styles.approvedText
                : isFailedPickupAttempt
                  ? isSecondFailedPickupAttempt
                    ? styles.secondFailedPickupText
                    : styles.failedPickupText
                : isReceived
                  ? styles.receivedText
                : isRefunded
                  ? styles.refundedText
                  : ""
          }
        >
          {requestItem.statusLabel}
        </strong>
      </p>
      {currentTimelineEvent ? (
        <div className={styles.statusTimelineCurrent}>
          <p className={styles.statusTimelineTitle}>Estado actual</p>
          <p className={styles.statusTimelineCurrentLine}>
            <strong className={timelineToneClassName(currentTimelineEvent.tone)}>{currentTimelineEvent.label}</strong>{" "}
            <span>{new Date(currentTimelineEvent.at).toLocaleString("es-MX")}</span>
          </p>
          {currentTimelineEvent.note ? (
            <p className={`${styles.statusTimelineItemNote} ${timelineToneClassName(currentTimelineEvent.tone)}`}>
              {currentTimelineEvent.note}
            </p>
          ) : null}
        </div>
      ) : null}
      {timelineEvents.length > 1 ? (
        <button
          type="button"
          className={styles.statusTimelineToggle}
          onClick={() => setShowAllStates((prev) => !prev)}
        >
          {showAllStates ? "Ocultar estados" : "Ver todos los estados"}
        </button>
      ) : null}
      {showAllStates ? (
        <div className={styles.statusTimelineList}>
          {timelineEvents.map((event) => (
            <div key={event.id} className={styles.statusTimelineItem}>
              <p className={`${styles.statusTimelineItemTitle} ${timelineToneClassName(event.tone)}`}>{event.label}</p>
              <p className={styles.statusTimelineItemAt}>{new Date(event.at).toLocaleString("es-MX")}</p>
              {event.note ? (
                <p className={`${styles.statusTimelineItemNote} ${timelineToneClassName(event.tone)}`}>{event.note}</p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {isReceived ? (
        <p className={`${styles.completedStatus} ${styles.receivedHintText}`}>
          Recibimos tu producto con exito, lo revisaremos. Una vez finalicemos realizaremos tu reembolso, regresa mas tarde para ver el estado de tu devolucion.
        </p>
      ) : null}
      {isFailedPickupAttempt ? (
        <p className={`${styles.completedStatus} ${styles.failedPickupHintText}`}>
          {failedAttemptLabel}: {requestItem.rejectionReason || "No se encontro al cliente en el domicilio para entregar el paquete."}
        </p>
      ) : null}
      {isApproved ? (
        <p className={`${styles.completedStatus} ${styles.approvedHintText}`}>
          {requestItem.returnMethod === "pickup"
            ? "Tu solicitud de devolucion fue aprobada, recogeremos tu producto en tu domicilio en la fecha establecida por ti."
            : "Tu solicitud de devolucion fue aprobada, lleva tu producto a la sucursal de devoluciones."}
        </p>
      ) : null}
      {isReview ? (
        <p className={`${styles.completedStatus} ${styles.reviewHintText}`}>
          Tu solicitud esta siendo revisada por nuestro equipo, regresa mas tarde para revisar el estado de tu solicitud.
        </p>
      ) : null}
      {requestItem.rejectionReason && isRejectedOrDenied ? (
        <p className={styles.completedStatus}>
          Motivo de denegacion: <strong className={styles.deniedText}>{requestItem.rejectionReason}</strong>
        </p>
      ) : null}
      {requestItem.wasReturnedToCustomer ? (
        <p className={`${styles.completedStatus} ${styles.returnedToCustomerHintText}`}>
          {RETURNED_TO_CUSTOMER_MESSAGE}
        </p>
      ) : null}
      {isPendingToReturn ? (
        <p className={`${styles.completedStatus} ${styles.returnedToCustomerHintText}`}>
          Recoge tu paquete en nuestra sucursal: <BranchAddressLink address={requestItem.branchAddress} />. Horario: {requestItem.branchHours || "-"}. Tienes 30 dias para recogerlo. Fecha limite: {pickupDeadlineLabel || "-"}.
        </p>
      ) : null}

      <div className={styles.summary}>
        <p><strong>Metodo:</strong> {requestItem.returnMethod === "pickup" ? "Recoleccion a domicilio" : "Entrega en sucursal"}</p>
        <p><strong>Subtotal (sin impuestos):</strong> ${toMXN(requestItem.estimatedRefund)} MXN</p>
        <p><strong>Costo devolucion:</strong> ${toMXN(requestItem.returnCost)} MXN</p>
        <p><strong>Reembolso final:</strong> ${toMXN(requestItem.finalRefund)} MXN</p>
        <p><strong>Fecha de solicitud:</strong> {new Date(requestItem.createdAt).toLocaleString("es-MX")}</p>
        {requestItem.receivedAt ? (
          <p><strong>Fecha recibida:</strong> {new Date(requestItem.receivedAt).toLocaleString("es-MX")}</p>
        ) : null}
        {requestItem.returnedToCustomerAt ? (
          <p><strong>Fecha devuelta al cliente:</strong> {new Date(requestItem.returnedToCustomerAt).toLocaleString("es-MX")}</p>
        ) : null}
        {requestItem.refundedAt ? (
          <p><strong>Fecha reembolsada:</strong> {new Date(requestItem.refundedAt).toLocaleString("es-MX")}</p>
        ) : null}

        {requestItem.returnMethod === "pickup" ? (
          <>
            <p>
              <strong>Direccion de recoleccion:</strong>{" "}
              {[requestItem.pickupAddress, requestItem.pickupNeighborhood, requestItem.pickupCity, requestItem.pickupState, requestItem.pickupPostalCode]
                .filter((value) => value && value !== "-")
                .join(", ") || "-"}
            </p>
            <p><strong>Dia de recoleccion:</strong> {requestItem.pickupDate || "-"}</p>
            {requestItem.pickupNotes ? <p><strong>Instrucciones del cliente:</strong> {requestItem.pickupNotes}</p> : null}
          </>
        ) : (
          <>
            <p><strong>Direccion de la sucursal:</strong> <BranchAddressLink address={requestItem.branchAddress} /></p>
            <p><strong>Instrucciones:</strong> {requestItem.branchInstructions || "-"}</p>
            <p><strong>Horarios de entrega:</strong> {requestItem.branchHours || "-"}</p>
          </>
        )}
      </div>

      <h4 className={styles.orderDetailTitle}>Productos devueltos</h4>
      <ul className={styles.productList}>
        {requestItem.items.map((item) => (
          <li key={item.id} className={styles.productItem}>
            <div className={styles.productItemHeader}>
              {item.imageUrl ? (
                <button
                  type="button"
                  className={styles.imageButton}
                  onClick={() =>
                    setViewerImage({
                      src: item.imageUrl,
                      alt: item.imageAlt || item.title,
                    })
                  }
                >
                  <img src={item.imageUrl} alt={item.imageAlt || item.title} className={styles.productThumb} />
                </button>
              ) : (
                <div className={styles.productThumbPlaceholder} />
              )}
              <div className={styles.productCopy}>
                <p className={styles.productLineTitle}>{item.title} x{item.quantity}</p>
                <p className={styles.productLineMeta}>Motivo: {item.reason || "-"}</p>
              </div>
            </div>
            {item.details ? <p className={styles.productLineMeta}>Descripcion: {item.details}</p> : null}
            {item.photoDataUrls?.length ? (
              <div className={styles.evidencePhotos}>
                {item.photoDataUrls.map((src, idx) => (
                  <button
                    key={`${item.id}_${idx}`}
                    type="button"
                    className={styles.evidenceLink}
                    onClick={() =>
                      setViewerImage({
                        src,
                        alt: `Evidencia ${idx + 1}`,
                      })
                    }
                  >
                    <img src={src} alt={`Evidencia ${idx + 1}`} className={styles.evidencePhoto} />
                    <span>Foto {idx + 1}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      <ImageViewer image={viewerImage} onClose={() => setViewerImage(null)} />

    </article>
  );
}

function ReturnsRequestForm({ order, reasons, evidenceReasons, settings, shop, isSubmitting, actionData }) {
  const evidenceSet = useMemo(
    () => new Set((evidenceReasons || []).map((reason) => reasonKey(reason)).filter(Boolean)),
    [evidenceReasons],
  );
  const limitDateObj = useMemo(
    () => addDays(order.deliveredAt || order.createdAt, settings.returnWindowDays),
    [order.deliveredAt, order.createdAt, settings.returnWindowDays],
  );
  const limitDateISO = useMemo(() => limitDateObj.toISOString().slice(0, 10), [limitDateObj]);
  const [step, setStep] = useState(1);
  const [submitLocked, setSubmitLocked] = useState(false);
  const [clientError, setClientError] = useState("");
  const [selected, setSelected] = useState({});
  const [reasonsByItem, setReasonsByItem] = useState(
    Object.fromEntries(order.items.map((item) => [item.id, ""])),
  );
  const [detailsByItem, setDetailsByItem] = useState({});
  const [photoByItem, setPhotoByItem] = useState({});
  const [viewerImage, setViewerImage] = useState(null);
  const [returnMethod, setReturnMethod] = useState("branch");
  const customerName = order.customerName || "";
  const customerPhone = order.customerPhone || "";
  const ship = order.shippingAddress || null;
  const pickupAddressLines = useMemo(() => {
    const name = String(ship?.name || customerName || "").trim();
    const phone = String(ship?.phone || customerPhone || "").trim();
    const line1 = String(ship?.address1 || "").trim();
    const line2 = String(ship?.address2 || "").trim();
    const zip = String(ship?.zip || "").trim();
    const city = String(ship?.city || "").trim();
    const province = String(ship?.province || "").trim();
    const country = String(ship?.country || "").trim();

    const lines = [];
    if (name) lines.push(name);
    if (line1) lines.push(line1);
    if (line2) lines.push(line2);

    const cityLine = [zip, city, province].filter(Boolean).join(" ");
    if (cityLine) lines.push(cityLine);
    if (country) lines.push(country);
    if (phone) lines.push(phone);
    return lines;
  }, [ship, customerName, customerPhone]);
  const [pickup, setPickup] = useState({
    pickupFullName: order.customerName || "",
    pickupPhone: order.customerPhone || "",
    pickupAddress: ship?.address1 || "",
    pickupNeighborhood: ship?.address2 || "",
    pickupCity: ship?.city || "",
    pickupState: ship?.province || "",
    pickupPostalCode: ship?.zip || "",
    pickupReferences: "",
    pickupDate: "",
    pickupNotes: "",
  });

  const selectedItems = useMemo(
    () =>
      order.items
        .filter((item) => selected[item.id])
        .map((item) => ({
          ...item,
          reason: reasonsByItem[item.id] || "",
          details: detailsByItem[item.id] || "",
          photoDataUrls: Array.isArray(photoByItem[item.id]) ? photoByItem[item.id] : [],
          // Back-compat: keep the first photo as a single field too
          photoDataUrl: Array.isArray(photoByItem[item.id]) ? (photoByItem[item.id][0] || "") : "",
        })),
    [order.items, reasonsByItem, selected, detailsByItem, photoByItem],
  );

  const requiresReview = selectedItems.some((item) => evidenceSet.has(reasonKey(item.reason)));
  const estimatedRefund = selectedItems.reduce(
    (sum, item) => sum + Number(item.unitPrice || 0) * Number(item.quantity || 1),
    0,
  );
  const pickupCost = Number(settings.pickupCost || 0);
  const effectivePickupCost = requiresReview ? 0 : pickupCost;
  const returnCost = returnMethod === "pickup" ? effectivePickupCost : 0;
  const finalRefund = Math.max(0, estimatedRefund - returnCost);

  const payload = useMemo(
    () => ({
      order,
      customerName,
      customerEmail: order.customerEmail,
      customerPhone,
      items: selectedItems,
      returnMethod,
      estimatedRefund,
      ...pickup,
    }),
    [order, customerName, customerPhone, selectedItems, returnMethod, estimatedRefund, pickup],
  );

  const goToStep = (nextStep) => {
    setClientError("");
    setStep(nextStep);
  };

  const validateStep = (currentStep) => {
    if (currentStep === 1) {
      if (!selectedItems.length) return "Selecciona al menos un producto.";
      const missingReason = selectedItems.some((item) => !String(item.reason || "").trim());
      if (missingReason) return "Selecciona un motivo para cada producto seleccionado.";
      const needsEvidence = selectedItems.some((item) => evidenceSet.has(reasonKey(item.reason)));
      if (needsEvidence) {
        const missingDetails = selectedItems.some(
          (item) => evidenceSet.has(reasonKey(item.reason)) && !String(item.details || "").trim(),
        );
        if (missingDetails) return "Completa la descripcion del problema en los productos marcados.";
        const missingPhoto = selectedItems.some((item) => {
          if (!evidenceSet.has(reasonKey(item.reason))) return false;
          const photos = Array.isArray(item.photoDataUrls) ? item.photoDataUrls : [];
          return photos.length < 1;
        });
        if (missingPhoto) return "Sube una foto del problema en los productos marcados.";
      }
    }

    if (currentStep === 2) {
      if (returnMethod !== "branch" && returnMethod !== "pickup") {
        return "Selecciona un metodo de devolucion.";
      }
      if (returnMethod === "pickup" && returnCost > 0 && estimatedRefund - returnCost <= 0) {
        return "El costo de recoleccion es mayor o igual al subtotal de productos. Elige entrega en sucursal.";
      }
    }

    if (currentStep === 3) {
      if (returnMethod === "pickup") {
        const required = [
          ["pickupAddress", "Direccion completa"],
          ["pickupCity", "Ciudad"],
          ["pickupState", "Estado"],
          ["pickupPostalCode", "Codigo postal"],
          ["pickupDate", "Dia de recoleccion"],
        ];
        const missing = required.find(([key]) => !String(pickup[key] || "").trim());
        if (missing) return `Completa: ${missing[1]}.`;

        if (String(pickup.pickupDate || "").trim()) {
          const selectedDate = new Date(`${pickup.pickupDate}T23:59:59`);
          if (Number.isFinite(selectedDate.getTime()) && selectedDate.getTime() > limitDateObj.getTime()) {
            return `Esa fecha sobrepasa el tiempo de devolucion. Fecha limite: ${limitDateObj.toLocaleDateString("es-MX")}.`;
          }
        }
      }
    }

    return "";
  };

  const nextFrom = (currentStep) => {
    const msg = validateStep(currentStep);
    if (msg) {
      setClientError(msg);
      return;
    }
    goToStep(currentStep + 1);
  };

  useEffect(() => {
    if (actionData?.saved) {
      setSubmitLocked(true);
      return;
    }
    if (actionData?.error) {
      setSubmitLocked(false);
    }
  }, [actionData?.saved, actionData?.error]);

  const isSubmitBusy = isSubmitting || submitLocked || Boolean(actionData?.saved);

  const handleSubmit = (event) => {
    if (step !== 4) return;
    if (isSubmitBusy) {
      event.preventDefault();
      return;
    }
    setSubmitLocked(true);
  };

  return (
    <section className={styles.card}>
      <h2 className={styles.cardTitle}>Solicitud para pedido {order.name}</h2>
      <p className={styles.cardMeta}>
        Cliente: {order.customerName} | Email: {order.customerEmail}
      </p>
      <Form method="post" onSubmit={handleSubmit}>
        <input type="hidden" name="shop" value={shop} />
        <input type="hidden" name="payload" value={JSON.stringify(payload)} />
        <div className={styles.fieldGrid}>
          <div className={styles.stepHeader}>
            <span className={styles.stepPill}>Paso {step} de 4</span>
            <span className={styles.stepName}>
              {step === 1
                ? "Productos"
                : step === 2
                  ? "Metodo"
                  : step === 3
                    ? "Contacto"
                    : "Resumen"}
            </span>
          </div>

          {clientError && !(step === 3 && returnMethod === "pickup") && step !== 1 ? (
            <p className={`${styles.notice} ${styles.noticeError}`}>{clientError}</p>
          ) : null}

          {step === 1 ? (
            <div>
              <div className={styles.divider} />
              <h3 className={styles.sectionTitle}>1) Productos a devolver</h3>
              {order.items.map((item) => {
                const reason = reasonsByItem[item.id] || "";
                const needsEvidence = evidenceSet.has(reasonKey(reason));
                const isAlreadyReturned = Boolean(item.isAlreadyReturned);
                return (
                  <div key={item.id} className={styles.productRow}>
                    <label className={styles.productLabel}>
                      <input
                        type="checkbox"
                        disabled={isAlreadyReturned}
                        checked={Boolean(selected[item.id])}
                        onChange={(event) =>
                          setSelected((prev) => ({ ...prev, [item.id]: event.target.checked }))
                        }
                      />
                      {item.imageUrl ? (
                        <button
                          type="button"
                          className={styles.imageButton}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setViewerImage({
                              src: item.imageUrl,
                              alt: item.imageAlt || item.title,
                            });
                          }}
                        >
                          <img
                            alt={item.imageAlt || item.title}
                            src={item.imageUrl}
                            className={styles.img}
                          />
                        </button>
                      ) : (
                        <div className={styles.imgPlaceholder} />
                      )}
                      <div>
                        <div className={styles.productTitle}>{item.title}</div>
                        <div className={styles.productMeta}>
                          x{item.quantity} - ${toMXN(item.unitPrice)} c/u
                        </div>
                        {isAlreadyReturned ? (
                          <div className={`${styles.notice} ${styles.noticeMuted}`} style={{ marginTop: 4 }}>
                            Este producto ya tiene una devolucion activa, ya fue devuelto o fue denegado.
                          </div>
                        ) : null}
                      </div>
                    </label>

                    {selected[item.id] && !isAlreadyReturned ? (
                      <div className={styles.fieldGrid} style={{ marginTop: 10 }}>
                        <label>
                          <span className={styles.fieldLabel}>Motivo</span>
                          <select
                            value={reason}
                            onChange={(event) =>
                              setReasonsByItem((prev) => ({ ...prev, [item.id]: event.target.value }))
                            }
                            className={styles.select}
                          >
                            <option value="">Selecciona un motivo</option>
                            {reasons.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                        </label>

                      {needsEvidence ? (
                        <>
                          <label>
                            <span className={styles.fieldLabel}>Descripcion del problema (obligatoria)</span>
                            <textarea
                              value={detailsByItem[item.id] || ""}
                              onChange={(event) =>
                                setDetailsByItem((prev) => ({ ...prev, [item.id]: event.target.value }))
                              }
                              className={styles.textarea}
                            />
                          </label>
                          <div>
                            <div className={styles.fieldLabel}>Foto del problema (obligatoria)</div>
                            {(() => {
                              const photos = Array.isArray(photoByItem[item.id]) ? photoByItem[item.id] : [];
                              const slots = Math.min(photos.length + 1, 2);

                              const setPhotoAt = (index, dataUrl) => {
                                setPhotoByItem((prev) => {
                                  const current = Array.isArray(prev[item.id]) ? prev[item.id] : [];
                                  const next = current.slice(0, 2);
                                  next[index] = dataUrl;
                                  return { ...prev, [item.id]: next.filter(Boolean).slice(0, 2) };
                                });
                              };

                              const readFile = (file, index) => {
                                const reader = new FileReader();
                                reader.onload = () => setPhotoAt(index, String(reader.result || ""));
                                reader.readAsDataURL(file);
                              };

                              return (
                                <div className={styles.photoGrid}>
                                  {Array.from({ length: slots }).map((_, slotIndex) => {
                                    const preview = photos[slotIndex] || "";
                                    const inputId = `photo_${item.id}_${slotIndex}`;
                                    return (
                                      <label key={inputId} className={styles.photoSlot} htmlFor={inputId}>
                                        <input
                                          id={inputId}
                                          className={styles.hiddenFile}
                                          type="file"
                                          accept="image/*"
                                          onChange={(event) => {
                                            const file = event.target.files?.[0];
                                            if (!file) return;
                                            readFile(file, slotIndex);
                                            // allow selecting the same file again later
                                            event.target.value = "";
                                          }}
                                        />
                                        {preview ? (
                                          <img className={styles.photoPreview} alt="Foto del problema" src={preview} />
                                        ) : (
                                          <span className={styles.photoSlotText}>Seleccionar foto</span>
                                        )}
                                      </label>
                                    );
                                  })}
                                </div>
                              );
                            })()}
                          </div>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                );
              })}

              <div className={styles.btnRow}>
                {clientError ? (
                  <p className={`${styles.notice} ${styles.noticeError}`} style={{ margin: 0 }}>
                    {clientError}
                  </p>
                ) : (
                  <span />
                )}
                <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={isSubmitBusy} onClick={() => nextFrom(1)}>
                  Siguiente
                </button>
              </div>
            </div>
          ) : null}

          {step === 2 ? (
            <div>
              {requiresReview ? (
                <p
                  className={`${styles.notice} ${styles.noticeMuted} ${styles.noteMsg}`}
                  style={{ marginTop: 6 }}
                >
                  <strong className={styles.noteWord}>Nota:</strong> Tu solicitud sera revisada antes de ser aprobada.
                  Revisaremos las fotos y el motivo de la devolucion. Por favor, elige tu metodo de devolucion.
                </p>
              ) : null}
              <div className={styles.divider} />
              <h3 className={styles.sectionTitle}>2) Metodo de devolucion</h3>
              <div className={styles.radioBlock}>
                <div className={styles.radioItem}>
                  <input
                    id="return_method_branch"
                    type="radio"
                    name="returnMethodChoice"
                    value="branch"
                    checked={returnMethod === "branch"}
                    onChange={() => setReturnMethod("branch")}
                  />
                  <label htmlFor="return_method_branch" className={styles.radioContent}>
                    <div className={styles.radioTitle}>Entrega en sucursal (sin costo)</div>
                    <div className={styles.radioDesc}>
                      Entrega el producto en nuestra sucursal
                      {settings?.branchAddress ? (
                        <>
                          : <BranchAddressLink address={settings.branchAddress} />
                        </>
                      ) : (
                        "."
                      )}
                    </div>
                  </label>
                </div>
                <div className={styles.radioItem}>
                  <input
                    id="return_method_pickup"
                    type="radio"
                    name="returnMethodChoice"
                    value="pickup"
                    checked={returnMethod === "pickup"}
                    onChange={() => setReturnMethod("pickup")}
                  />
                  <label htmlFor="return_method_pickup" className={styles.radioContent}>
                    <div className={styles.radioTitle}>
                      {requiresReview
                        ? "Recoleccion a domicilio (sin costo) 🚚"
                        : `Recoleccion a domicilio ($${toMXN(pickupCost)} MXN) 🚚`}
                    </div>
                    <div className={styles.radioDesc}>
                      Nosotros recogemos el paquete a tu domicilio.
                    </div>
                  </label>
                </div>
              </div>

              <div className={styles.btnRow}>
                <button type="button" className={styles.btn} disabled={isSubmitBusy} onClick={() => goToStep(1)}>
                  Atras
                </button>
                <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={isSubmitBusy} onClick={() => nextFrom(2)}>
                  Siguiente
                </button>
              </div>
            </div>
          ) : null}

          {step === 3 ? (
            <div>
              <div className={styles.divider} />
              <h3 className={styles.sectionTitle}>3) Datos de contacto</h3>

              {returnMethod === "branch" ? (
                <div className={styles.summary} style={{ marginTop: 12 }}>
                  <h3 className={styles.sectionTitle}>Entrega en sucursal</h3>
                  <p><strong>Cliente:</strong> {order.customerName || "Cliente"}</p>
                  {order.customerPhone ? <p><strong>Telefono:</strong> {order.customerPhone}</p> : null}
                  <p><strong>Direccion de la sucursal:</strong> <BranchAddressLink address={settings.branchAddress} /></p>
                  <p><strong>Instrucciones:</strong> {settings.branchInstructions}</p>
                  <p><strong>Horarios de entrega:</strong> {settings.branchHours}</p>
                </div>
              ) : (
                <div className={styles.summary} style={{ marginTop: 12 }}>
                  <h3 className={styles.sectionTitle}>Recoleccion a domicilio</h3>
                  <p><strong>Instrucciones:</strong> {settings.pickupInstructions}</p>
                  <p><strong>Horario de recoleccion:</strong> {settings.pickupHours}</p>
                  <div className={styles.summary} style={{ marginTop: 12, background: "#fff" }}>
                    <h3 className={styles.sectionTitle} style={{ marginTop: 0 }}>
                      Direccion de recoleccion
                    </h3>
                    {pickupAddressLines.length ? (
                      <div style={{ display: "grid", gap: 2, color: "var(--text)" }}>
                        {pickupAddressLines.map((line) => (
                          <div key={line}>{line}</div>
                        ))}
                      </div>
                    ) : (
                      <div className={styles.notice}>No encontramos direccion de envio en este pedido.</div>
                    )}
                  </div>

                  <div className={styles.fieldGrid} style={{ marginTop: 10 }}>
                    <label>
                      <span className={styles.fieldLabel}>Que dia quieres que pasemos por tu paquete</span>
                      <input
                        type="date"
                        value={pickup.pickupDate}
                        onChange={(event) => setPickup((prev) => ({ ...prev, pickupDate: event.target.value }))}
                        max={limitDateISO}
                        className={styles.input}
                      />
                    </label>

                    <label>
                      Instrucciones (opcional)
                      <textarea
                        placeholder="Ej: dejar con el vecino, tocar timbre, etc."
                        value={pickup.pickupNotes}
                        onChange={(event) => setPickup((prev) => ({ ...prev, pickupNotes: event.target.value }))}
                        className={styles.textarea}
                        rows={3}
                      />
                    </label>

                    {clientError ? (
                      <p className={`${styles.notice} ${styles.noticeError}`}>{clientError}</p>
                    ) : null}
                  </div>
                </div>
              )}

              <div className={styles.btnRow}>
                <button type="button" className={styles.btn} disabled={isSubmitBusy} onClick={() => goToStep(2)}>
                  Atras
                </button>
                <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={isSubmitBusy} onClick={() => nextFrom(3)}>
                  Siguiente
                </button>
              </div>
            </div>
          ) : null}

          {step === 4 ? (
            <div>
              <div className={styles.divider} />
              <div className={styles.summary}>
                <h3 className={styles.sectionTitle}>4) Confirmacion y resumen</h3>
                <p><strong>Productos a devolver:</strong></p>
                {selectedItems.length ? (
                  <div className={styles.summaryItems}>
                    {selectedItems.map((item) => (
                      <div key={item.id} className={styles.summaryItem}>
                        {item.imageUrl ? (
                          <button
                            type="button"
                            className={styles.imageButton}
                            onClick={() =>
                              setViewerImage({
                                src: item.imageUrl,
                                alt: item.imageAlt || item.title,
                              })
                            }
                          >
                            <img
                              alt={item.imageAlt || item.title}
                              src={item.imageUrl}
                              className={styles.img}
                            />
                          </button>
                        ) : (
                          <div className={styles.imgPlaceholder} />
                        )}
                        <div>
                          <div className={styles.productTitle}>{item.title}</div>
                          <div className={styles.productMeta}>
                            x{item.quantity} · Motivo: {item.reason || "-"}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p>-</p>
                )}
                <p><strong>Monto estimado a reembolsar:</strong> ${toMXN(estimatedRefund)} MXN</p>
                {returnMethod === "branch" ? (
                  <>
                    <p><strong>Direccion sucursal:</strong> <BranchAddressLink address={settings.branchAddress} /></p>
                    <p><strong>Instrucciones:</strong> {settings.branchInstructions}</p>
                    <p><strong>Horarios de entrega:</strong> {settings.branchHours}</p>
                  </>
                ) : (
                  <>
                    <p>
                      <strong>Direccion recoleccion:</strong>{" "}
                      {[pickup.pickupAddress, pickup.pickupNeighborhood, pickup.pickupCity, pickup.pickupState, pickup.pickupPostalCode]
                        .filter(Boolean)
                        .join(", ") || "-"}
                    </p>
                    <p><strong>Dia:</strong> {pickup.pickupDate || "-"}</p>
                    <p><strong>Instrucciones:</strong> {settings.pickupInstructions}</p>
                    <p><strong>Instrucciones del cliente:</strong> {pickup.pickupNotes || "-"}</p>
                    <p><strong>Costo recoleccion:</strong> ${toMXN(returnCost)} MXN</p>
                    <p><strong>Total final a reembolsar:</strong> ${toMXN(finalRefund)} MXN</p>
                  </>
                )}
              </div>

              {actionData?.error ? <p style={{ color: "#b42318" }}>{actionData.error}</p> : null}
              {actionData?.saved ? <p style={{ color: "#027a48" }}>{actionData.message}</p> : null}

              {!actionData?.saved ? (
                <div className={styles.btnRow}>
                  <button type="button" className={styles.btn} disabled={isSubmitBusy} onClick={() => goToStep(3)}>
                    Atras
                  </button>
                  <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={isSubmitBusy} type="submit">
                    Confirmar devolucion
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </Form>
      <ImageViewer image={viewerImage} onClose={() => setViewerImage(null)} />
    </section>
  );
}
