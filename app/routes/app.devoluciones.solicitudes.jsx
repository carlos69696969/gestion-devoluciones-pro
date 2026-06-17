/* eslint-disable react/prop-types */
import { useEffect, useState } from "react";
import { Form, Link, useActionData, useFetcher, useLoaderData, useLocation, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  compareCourierDisplayOrder,
  getCourierRouteStatusFromTags,
  isCourierHistoryStatus,
  isCourierRouteStatus,
} from "../utils/courier.shared";
import styles from "../styles/admin.module.css";

const STATUS_LABEL = {
  pendiente: "pendiente",
  en_revision: "en revision",
  aprobada: "aprobada",
  en_ruta: "en ruta",
  intento_fallido_1: "intento de devolucion fallido",
  intento_fallido_2: "segundo intento de devolucion fallido",
  por_devolver: "pendiente por recoger",
  no_devuelto: "no devuelto",
  rechazada: "rechazada",
  denegada: "reembolso denegado",
  reembolso_denegado: "reembolso denegado",
  recibida: "recibida",
  reembolsada: "reembolsada",
  completada: "completada",
};

const VIEW_MODE = {
  PICKUP: "pickup",
  BRANCH: "branch",
  REVIEW: "review",
  REFUNDS: "refunds",
  TO_RETURN: "to_return",
  HISTORY: "history",
  COURIER: "courier",
  COURIER_HISTORY: "courier_history",
  BRANCH_PICKUP: "branch_pickup",
  COURIERS: "couriers",
};
const COURIER_HISTORY_SINCE = new Date("2026-06-10T00:00:00-06:00");

const METHOD_QUEUE_STATUSES = new Set([
  "aprobada",
  "en_ruta",
  "en_ruta_1",
  "en_ruta_2",
  "en_ruta_3",
  "intento_fallido_1",
  "intento_fallido_2",
  "no_recibido",
]);
const REFUND_QUEUE_STATUSES = new Set(["recibida"]);
const RETURN_TO_CUSTOMER_STATUSES = new Set(["por_devolver"]);
const BRANCH_PICKUP_STATUSES = new Set([
  "por_devolver",
  "no_devuelto",
  "reembolso_denegado",
  "denegada",
]);
const HISTORY_STATUSES = new Set(["reembolsada", "rechazada", "denegada", "reembolso_denegado", "no_devuelto"]);
const RETURNED_TO_CUSTOMER_MESSAGE = "Tu devolucion fue regresada con éxito.";
const RETURNED_TO_CUSTOMER_KIND = "returned_to_customer";
const NOT_RETURNED_KIND = "not_returned_after_30_days";
const REQUEST_CREATED_KIND = "request_created";
const STATUS_REVIEW_KIND = "status_review";
const STATUS_APPROVED_KIND = "status_approved";
const STATUS_RECEIVED_KIND = "status_received";
const STATUS_IN_ROUTE_KIND = "status_in_route";
const STATUS_REFUNDED_KIND = "status_refunded";
const TIMELINE_META_KINDS = new Set([
  REQUEST_CREATED_KIND,
  STATUS_REVIEW_KIND,
  STATUS_APPROVED_KIND,
  STATUS_RECEIVED_KIND,
  STATUS_IN_ROUTE_KIND,
  STATUS_REFUNDED_KIND,
  RETURNED_TO_CUSTOMER_KIND,
  NOT_RETURNED_KIND,
]);
const NOT_RETURNED_REASON = "El cliente no recogio su paquete en sucursal dentro de 30 dias.";
const PICKUP_DEADLINE_DAYS = 30;
const NOTIFICATIONS_API_BASE_URL = String(
  process.env.NOTIFICATIONS_API_URL || "https://centro-de-notificaciones-cariana.onrender.com",
).replace(/\/+$/, "");
const NOTIFICATIONS_API_KEY = String(
  process.env.NOTIFICATIONS_API_KEY || process.env.APP_INTERNAL_API_KEY || "",
).trim();

const RETURN_EVENT_BY_INTENT = {
  approve_request: "return_approved",
  reject_request: "return_rejected",
  mark_received: "return_picked_up",
  pickup_attempt_failed: "return_pickup_scheduled",
  reject_after_failed_pickups: "return_rejected",
  deny_received: "return_rejected",
  mark_returned_to_customer: "return_rejected",
  mark_not_returned: "return_rejected",
  process_refund: "refund_completed",
};

function buildReturnReference(requestRow) {
  if (!requestRow) return "";
  const orderNumber = String(requestRow.orderNumber || "").trim();
  if (orderNumber) return orderNumber;
  const id = Number(requestRow.id || 0);
  return id ? `DEV-${id}` : "";
}

function buildReturnEventPayload({ requestRow, intent, note }) {
  const mappedStatus = RETURN_EVENT_BY_INTENT[intent];
  if (!mappedStatus || !requestRow) return null;

  const returnReference = buildReturnReference(requestRow);
  return {
    status: mappedStatus,
    event: mappedStatus,
    action: intent,
    return_reference: returnReference,
    return_id: requestRow.id || null,
    order_number: requestRow.orderNumber || null,
    email: requestRow.customerEmail || null,
    customer_email: requestRow.customerEmail || null,
    customer: {
      email: requestRow.customerEmail || null,
      name: requestRow.customerName || null,
      phone: requestRow.customerPhone || null,
    },
    note: note || "",
    source: "portal_devoluciones",
    return_method: requestRow.returnMethod || null,
  };
}

async function emitReturnNotificationEvent({ shopDomain, requestRow, intent, note = "" }) {
  if (!shopDomain || !NOTIFICATIONS_API_BASE_URL) {
    return;
  }
  const eventPayload = buildReturnEventPayload({ requestRow, intent, note });
  if (!eventPayload) return;

  const endpoints = NOTIFICATIONS_API_KEY
    ? [
        `${NOTIFICATIONS_API_BASE_URL}/api/returns/events`,
        `${NOTIFICATIONS_API_BASE_URL}/proxy/returns/events`,
      ]
    : [`${NOTIFICATIONS_API_BASE_URL}/proxy/returns/events`];

  let lastFailure = null;
  for (const endpoint of endpoints) {
    const headers = {
      "Content-Type": "application/json",
      "x-shop-domain": shopDomain,
    };
    if (NOTIFICATIONS_API_KEY) {
      headers["x-api-key"] = NOTIFICATIONS_API_KEY;
    }

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          shopDomain,
          event: eventPayload,
        }),
      });

      if (response.ok) {
        return;
      }

      const detail = await response.text().catch(() => "");
      lastFailure = {
        endpoint,
        status: response.status,
        detail: String(detail || "").slice(0, 300),
      };
    } catch (error) {
      lastFailure = {
        endpoint,
        error: String(error?.message || error || "unknown"),
      };
    }
  }

  console.error("Failed to emit return notification event", {
    shopDomain,
    intent,
    ...lastFailure,
  });
}

async function emitOrderStatusNotification({ shopDomain, requestRow, status, note = "" }) {
  if (!shopDomain || !requestRow || !NOTIFICATIONS_API_BASE_URL || !NOTIFICATIONS_API_KEY) {
    return;
  }

  const endpoint = `${NOTIFICATIONS_API_BASE_URL}/api/orders/manual-status`;
  const headers = {
    "Content-Type": "application/json",
    "x-shop-domain": shopDomain,
    "x-api-key": NOTIFICATIONS_API_KEY,
  };

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        shopDomain,
        orderNumber: requestRow.orderNumber || null,
        customerEmail: requestRow.customerEmail || null,
        status,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error("Failed to emit order status notification", {
        shopDomain,
        orderNumber: requestRow.orderNumber || null,
        status,
        note,
        endpoint,
        responseStatus: response.status,
        detail: String(detail || "").slice(0, 300),
      });
    }
  } catch (error) {
    console.error("Failed to emit order status notification", {
      shopDomain,
      orderNumber: requestRow.orderNumber || null,
      status,
      note,
      endpoint,
      error: String(error?.message || error || "unknown"),
    });
  }
}

const PICKUP_FAILED_REASON_OPTIONS = [
  "No logramos completar la recolección. 🚚 Visitamos tu domicilio, pero no obtuvimos respuesta al tocar la puerta ni al comunicarnos contigo. Nuestro equipo volverá a intentarlo mañana. 📦✨",
  "Recolección reagendada. 📦✨ Nos comunicamos contigo y acordamos realizar un nuevo intento de recolección el día de mañana, ya que no te encontrabas en el domicilio indicado. 🚚",
];
const REJECT_AFTER_FAILED_AUTO_REASON =
  "❌🚚 Después de 3 intentos de recolección en el domicilio registrado, no fue posible recibir el producto. Por esta razón, la solicitud de devolución fue rechazada automáticamente.";
const REJECT_AFTER_FAILED_REASON_OPTIONS = [
  REJECT_AFTER_FAILED_AUTO_REASON,
];
const NEVER_ARRIVED_BRANCH_REASON = "Nunca llego a la sucursal para completar la devolucion.";


function getStatusClassName(status) {
  if (status === "en_revision") return "statusReview";
  if (status === "aprobada") return "statusApproved";
  if (status === "en_ruta") return "statusApproved";
  if (status === "intento_fallido_1" || status === "intento_fallido_2") return "statusAttemptFailed";
  if (status === "por_devolver") return "statusPendingReturn";
  if (status === "rechazada") return "statusRejected";
  if (status === "reembolso_denegado") return "statusDenied";
  if (status === "no_devuelto") return "statusDenied";
  if (status === "recibida") return "statusReceived";
  if (status === "reembolsada") return "statusRefunded";
  if (status === "denegada") return "statusDenied";
  return "statusDefault";
}

function isPickupFailedAttemptStatus(status) {
  return status === "intento_fallido_1" || status === "intento_fallido_2";
}

function normalizeViewMode(rawValue) {
  const value = String(rawValue || "").trim().toLowerCase();
  if (value === VIEW_MODE.PICKUP) return VIEW_MODE.PICKUP;
  if (value === VIEW_MODE.REVIEW) return VIEW_MODE.REVIEW;
  if (value === VIEW_MODE.REFUNDS) return VIEW_MODE.REFUNDS;
  if (value === VIEW_MODE.TO_RETURN) return VIEW_MODE.TO_RETURN;
  if (value === VIEW_MODE.HISTORY) return VIEW_MODE.HISTORY;
  if (value === VIEW_MODE.COURIER) return VIEW_MODE.COURIER;
  if (value === VIEW_MODE.COURIER_HISTORY) return VIEW_MODE.COURIER_HISTORY;
  if (value === VIEW_MODE.BRANCH_PICKUP) return VIEW_MODE.BRANCH_PICKUP;
  if (value === VIEW_MODE.COURIERS) return VIEW_MODE.COURIERS;
  return VIEW_MODE.BRANCH;
}

function viewModeFromPathname(pathname) {
  const path = String(pathname || "")
    .toLowerCase()
    .replace(/\/+$/, "");
  if (path.endsWith("/pickup")) return VIEW_MODE.PICKUP;
  if (path.endsWith("/branch")) return VIEW_MODE.BRANCH;
  if (path.endsWith("/review")) return VIEW_MODE.REVIEW;
  if (path.endsWith("/refunds")) return VIEW_MODE.REFUNDS;
  if (path.endsWith("/to_return")) return VIEW_MODE.TO_RETURN;
  if (path.endsWith("/history")) return VIEW_MODE.HISTORY;
  if (path.endsWith("/courier_history")) return VIEW_MODE.COURIER_HISTORY;
  if (path.endsWith("/repartidor")) return VIEW_MODE.COURIER;
  if (path.endsWith("/branch_pickup")) return VIEW_MODE.BRANCH_PICKUP;
  if (path.endsWith("/couriers")) return VIEW_MODE.COURIERS;
  return "";
}

function toMoney(value) {
  return Number(value || 0).toFixed(2);
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

function returnRequestItemsSignature(requestRow) {
  const itemParts = (requestRow?.items || [])
    .map((item) => `${itemKeyFromRecord(item)}:${Math.max(1, Number(item?.quantity || 1))}`)
    .sort();
  if (!itemParts.length) return `request:${requestRow?.id || ""}`;
  const orderReference =
    String(requestRow?.shopifyOrderId || "").trim() ||
    String(requestRow?.orderNumber || "").trim();
  return `${orderReference}|${itemParts.join(",")}`;
}

function returnRequestOrderReferences(requestRow) {
  const references = new Set();
  const shopifyOrderId = String(requestRow?.shopifyOrderId || "").trim();
  const orderNumber = String(requestRow?.orderNumber || "").replace(/^#/, "").trim();
  const shopifyOrderNumericId = shopifyOrderId.match(/(\d+)$/)?.[1] || "";

  if (shopifyOrderId) references.add(`shopify:${shopifyOrderId}`);
  if (shopifyOrderNumericId) references.add(`shopify-numeric:${shopifyOrderNumericId}`);
  if (orderNumber) references.add(`order-number:${orderNumber}`);

  return Array.from(references);
}

function requestWasCreatedAfter(candidate, reference) {
  const candidateCreatedAt = new Date(candidate?.createdAt || 0).getTime();
  const referenceCreatedAt = new Date(reference?.createdAt || 0).getTime();
  if (candidateCreatedAt !== referenceCreatedAt) {
    return candidateCreatedAt > referenceCreatedAt;
  }
  return Number(candidate?.id || 0) > Number(reference?.id || 0);
}

function excludePickupRequestsSupersededByBranch(requestRows) {
  const rows = Array.isArray(requestRows) ? requestRows : [];
  const latestBranchRequestBySignature = new Map();
  const branchPickupOrderReferences = new Set();

  for (const requestRow of rows) {
    const returnMethod = String(requestRow?.returnMethod || "").trim().toLowerCase();
    const status = String(requestRow?.status || "").trim().toLowerCase();
    if (BRANCH_PICKUP_STATUSES.has(status)) {
      for (const orderReference of returnRequestOrderReferences(requestRow)) {
        branchPickupOrderReferences.add(orderReference);
      }
    }
    if (returnMethod !== "pickup") {
      const signature = returnRequestItemsSignature(requestRow);
      const current = latestBranchRequestBySignature.get(signature);
      if (!current || requestWasCreatedAfter(requestRow, current)) {
        latestBranchRequestBySignature.set(signature, requestRow);
      }
    }
  }

  return rows.filter((requestRow) => {
    if (String(requestRow?.returnMethod || "").trim().toLowerCase() !== "pickup") return false;
    if (BRANCH_PICKUP_STATUSES.has(String(requestRow?.status || "").trim().toLowerCase())) return false;
    if (
      returnRequestOrderReferences(requestRow).some((orderReference) =>
        branchPickupOrderReferences.has(orderReference),
      )
    ) {
      return false;
    }
    const branchRequest = latestBranchRequestBySignature.get(returnRequestItemsSignature(requestRow));
    return !branchRequest || !requestWasCreatedAfter(branchRequest, requestRow);
  });
}

function formatVariantSummary(variantNode) {
  const options = Array.isArray(variantNode?.selectedOptions) ? variantNode.selectedOptions : [];
  const labels = options
    .map((option) => {
      const name = String(option?.name || "").trim();
      const value = String(option?.value || "").trim();
      if (!name || !value) return "";
      return `${name}: ${value}`;
    })
    .filter(Boolean);
  if (labels.length) return labels.join(" | ");
  const fallback = String(variantNode?.title || "").trim();
  if (!fallback || fallback.toLowerCase() === "default title") return "";
  return fallback;
}

function parsePhotoUrls(rawValue) {
  if (!rawValue) return [];
  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed.filter(Boolean).slice(0, 2) : [];
  } catch {
    return [String(rawValue)].filter(Boolean);
  }
}

function normalizeDisplayedReasonText(rawValue) {
  const text = String(rawValue || "").trim();
  if (!text) return "";
  const compact = text.replace(/\s+/g, " ").trim();
  const lowered = compact.toLowerCase();
  if (lowered === "tu reembolso fue procesado al metodo de pago original.") {
    return "💸 Tu reembolso ya fue procesado correctamente. Dependiendo de tu banco, el monto podrá verse reflejado en tu cuenta dentro de 5 a 10 días hábiles. Gracias por confiar en Cariana. 💙";
  }
  if (lowered === "recibimos tu producto. estamos validando para finalizar el proceso.") {
    return "Producto recibido. 📦 Hemos recibido tu devolución y nuestro equipo ya se encuentra revisando tu producto. Una vez finalizado el proceso de verificación, realizaremos tu reembolso correspondiente. 💰";
  }
  if (
    lowered.includes("devolucion fue regresada con ecxito") ||
    lowered.includes("devolucion fue regresada con éxito") ||
    lowered.includes("devoluciã³n fue regresada con ã©xito")
  ) {
    return RETURNED_TO_CUSTOMER_MESSAGE;
  }
  return compact
    .replace(/ecxito/gi, "éxito")
    .replace(/devoluciã³n/gi, "devolución")
    .replace(/ã©xito/gi, "éxito");
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
        reason: normalizeDisplayedReasonText(entry?.reason),
        at: entry?.at ? String(entry.at) : "",
      }))
      .filter((entry) => entry.reason);
  } catch {
    return [{ kind: "legacy", reason: normalizeDisplayedReasonText(text), at: "" }];
  }
}

function isReturnedToCustomerEntry(entry) {
  return String(entry?.kind || "").toLowerCase() === RETURNED_TO_CUSTOMER_KIND;
}

function isSystemProgressEntry(entry) {
  const kind = String(entry?.kind || "").toLowerCase();
  return TIMELINE_META_KINDS.has(kind);
}

function latestReturnedToCustomerAtFromRaw(rawValue) {
  const entries = parseReasonEntries(rawValue);
  for (let idx = entries.length - 1; idx >= 0; idx -= 1) {
    if (!isReturnedToCustomerEntry(entries[idx])) continue;
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

function addDays(dateValue, days) {
  const base = new Date(dateValue);
  if (!Number.isFinite(base.getTime())) return null;
  const result = new Date(base);
  result.setDate(result.getDate() + Number(days || 0));
  return result;
}

function appendReasonEntry(rawValue, entry) {
  const entries = parseReasonEntries(rawValue);
  entries.push({
    kind: String(entry?.kind || "legacy"),
    reason: String(entry?.reason || "").trim(),
    at: new Date().toISOString(),
  });
  return JSON.stringify({ entries });
}

function appendTimelineMetaEntry(rawValue, entry) {
  const kind = String(entry?.kind || "").trim().toLowerCase();
  if (!kind) return rawValue || "";
  const entries = parseReasonEntries(rawValue);
  if (entries.some((item) => String(item?.kind || "").toLowerCase() === kind)) {
    return JSON.stringify({ entries });
  }
  entries.push({
    kind,
    reason: String(entry?.reason || "").trim(),
    at: new Date().toISOString(),
  });
  return JSON.stringify({ entries });
}

function latestReasonFromRaw(rawValue) {
  const entries = parseReasonEntries(rawValue);
  for (let idx = entries.length - 1; idx >= 0; idx -= 1) {
    if (isSystemProgressEntry(entries[idx])) continue;
    return entries[idx]?.reason || "";
  }
  return "";
}

function reasonEntryLabel(entry) {
  const kind = String(entry?.kind || "").toLowerCase();
  if (kind === "attempt_failed_1") return "Primer intento";
  if (kind === "attempt_failed_2") return "Segundo intento";
  if (kind === "attempt_failed_3") return "Tercer intento";
  if (kind === "rejected_after_attempts") return "Motivo de rechazo final";
  if (kind === "review_rejected") return "Motivo de rechazo";
  if (kind === "denied_after_received") return "Motivo de denegacion";
  if (kind === RETURNED_TO_CUSTOMER_KIND) return "Devuelto al cliente";
  if (kind === NOT_RETURNED_KIND) return "No devuelto";
  return "Motivo";
}

function timelineLabelFromStatus(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "en_revision") return "Solicitud en revision";
  if (normalized === "aprobada") return "Devolucion aprobada";
  if (normalized === "en_ruta") return "En ruta";
  if (normalized === "intento_fallido_1") return "Primer intento";
  if (normalized === "intento_fallido_2") return "Segundo intento";
  if (normalized === "rechazada") return "Devolucion rechazada";
  if (normalized === "recibida") return "Recibimos tu producto";
  if (normalized === "por_devolver") return "Pendiente por recoger";
  if (normalized === "no_devuelto") return "No devuelto";
  if (normalized === "denegada" || normalized === "reembolso_denegado") return "Reembolso denegado";
  if (normalized === "reembolsada" || normalized === "completada") return "Reembolso procesado";
  return "Estado actualizado";
}

function timelineLabelFromReasonEntry(entry) {
  const kind = String(entry?.kind || "").toLowerCase();
  const courierRouteMatch = kind.match(/^courier_en_route_(\d)$/);
  if (courierRouteMatch) return `${courierAttemptLabel(courierRouteMatch[1])} en ruta`;
  const courierRetryMatch = kind.match(/^courier_retry_(\d)$/);
  if (courierRetryMatch) return `${courierAttemptLabel(courierRetryMatch[1])} reprogramado`;
  if (kind === STATUS_REVIEW_KIND) return "Solicitud en revision";
  if (kind === STATUS_APPROVED_KIND) return "Devolucion aprobada";
  if (kind === STATUS_IN_ROUTE_KIND) return "En ruta";
  if (kind === STATUS_RECEIVED_KIND) return "Recibimos tu producto";
  if (kind === STATUS_REFUNDED_KIND) return "Reembolso procesado";
  if (kind === "attempt_failed_1") return "Primer intento";
  if (kind === "attempt_failed_2") return "Segundo intento";
  if (kind === "review_rejected" || kind === "rejected_after_attempts") return "Devolucion rechazada";
  if (kind === "denied_after_received") return "Reembolso denegado";
  if (kind === NOT_RETURNED_KIND) return "No devuelto";
  if (kind === RETURNED_TO_CUSTOMER_KIND) return "Devolucion devuelta al cliente";
  return "";
}

function timelineToneFromStatus(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "en_revision") return "review";
  if (normalized === "aprobada") return "approved";
  if (normalized === "en_ruta") return "approved";
  if (normalized === "intento_fallido_1" || normalized === "intento_fallido_2" || normalized === "intento_fallido_3") return "attempt";
  if (normalized === "rechazada") return "rejected";
  if (normalized === "recibida") return "received";
  if (normalized === "por_devolver") return "pending";
  if (normalized === "denegada" || normalized === "reembolso_denegado" || normalized === "no_devuelto") return "denied";
  if (normalized === "reembolsada" || normalized === "completada") return "refunded";
  return "default";
}

function timelineToneFromReasonEntry(entry) {
  const kind = String(entry?.kind || "").toLowerCase();
  if (kind === REQUEST_CREATED_KIND) return "default";
  if (kind === STATUS_REVIEW_KIND) return "review";
  if (kind === STATUS_APPROVED_KIND) return "approved";
  if (kind === STATUS_IN_ROUTE_KIND) return "approved";
  if (kind === STATUS_RECEIVED_KIND) return "received";
  if (kind === STATUS_REFUNDED_KIND) return "refunded";
  if (kind === "attempt_failed_1" || kind === "attempt_failed_2" || kind === "attempt_failed_3") return "attempt";
  if (kind === "review_rejected" || kind === "rejected_after_attempts") return "rejected";
  if (kind === "denied_after_received") return "denied";
  if (kind === RETURNED_TO_CUSTOMER_KIND) return "pending";
  if (kind === NOT_RETURNED_KIND) return "denied";
  return "default";
}

function timelineStatusDescription(status, requestRow) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "en_revision") {
    return "Tu solicitud esta siendo revisada por nuestro equipo.";
  }
  if (normalized === "aprobada") {
    return requestRow.returnMethod === "pickup"
      ? "Tu solicitud fue aprobada. Recogeremos tu producto en el domicilio y fecha indicados."
      : "Tu solicitud fue aprobada. Lleva tu producto a la sucursal de devoluciones.";
  }
  if (normalized === "en_ruta") {
    return "Tu recoleccion ya va en ruta hacia tu domicilio. Nuestro equipo se dirige para continuar el proceso.";
  }
  if (normalized === "recibida") {
    return "Producto recibido. 📦 Hemos recibido tu devolución y nuestro equipo ya se encuentra revisando tu producto. Una vez finalizado el proceso de verificación, realizaremos tu reembolso correspondiente. 💰";
  }
  if (normalized === "reembolsada" || normalized === "completada") {
    return "Tu reembolso ya fue procesado al metodo de pago original.";
  }
  if (normalized === "por_devolver") {
    return "Tu paquete esta pendiente por recoger en sucursal.";
  }
  if (normalized === "reembolso_denegado" || normalized === "denegada") {
    const denialReason = String(requestRow?.rejectionReason || "").trim();
    return denialReason || "El reembolso fue denegado. Revisa el motivo de denegacion.";
  }
  if (normalized === "rechazada") {
    const rejectionReason = String(requestRow?.rejectionReason || "").trim();
    return rejectionReason || "Tu solicitud fue rechazada. Revisa el motivo para mas detalle.";
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
  if (normalized === "en_ruta") return STATUS_IN_ROUTE_KIND;
  if (normalized === "recibida") return STATUS_RECEIVED_KIND;
  if (normalized === "reembolsada" || normalized === "completada") return STATUS_REFUNDED_KIND;
  return "";
}

function hasReachedApprovedPhase(status) {
  const normalized = String(status || "").toLowerCase();
  return [
    "aprobada",
    "en_ruta",
    "intento_fallido_1",
    "intento_fallido_2",
    "recibida",
    "por_devolver",
    "no_devuelto",
    "denegada",
    "reembolso_denegado",
    "reembolsada",
    "completada",
  ].includes(normalized);
}

function parseEventMs(value) {
  const text = String(value || "").trim();
  if (!text) return 0;
  const ms = new Date(text).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function buildStatusTimeline(requestRow, hideCourierProgress = false) {
  const events = [];
  const entryKinds = new Set(
    (requestRow.timelineEntries || []).map((entry) => String(entry?.kind || "").toLowerCase()).filter(Boolean),
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

  if (requestRow.requiresReview && !entryKinds.has(STATUS_REVIEW_KIND)) {
    pushEvent("Solicitud en revision", requestRow.createdAt, "Tu solicitud esta siendo revisada por nuestro equipo.", "review");
  }
  if (requestRow.requiresReview && !entryKinds.has(STATUS_APPROVED_KIND) && hasReachedApprovedPhase(requestRow.status)) {
    pushEvent(
      "Devolucion aprobada",
      requestRow.receivedAt || requestRow.updatedAt || requestRow.createdAt,
      requestRow.returnMethod === "pickup"
        ? "Tu solicitud fue aprobada. Recogeremos tu producto en tu domicilio."
        : "Tu solicitud fue aprobada. Lleva tu producto a la sucursal de devoluciones.",
      "approved",
    );
  }
  if (!requestRow.requiresReview && !entryKinds.has(STATUS_APPROVED_KIND)) {
    pushEvent(
      "Devolucion aprobada",
      requestRow.createdAt,
      requestRow.returnMethod === "pickup"
        ? "Tu solicitud fue aprobada. Recogeremos tu producto en tu domicilio."
        : "Tu solicitud fue aprobada. Lleva tu producto a la sucursal de devoluciones.",
      "approved",
    );
  }
  if (!entryKinds.has(STATUS_RECEIVED_KIND)) {
    pushEvent(
      "Recibimos tu producto",
      requestRow.receivedAt,
      "Recibimos tu producto. Estamos revisandolo para continuar el proceso.",
      "received",
    );
  }
  if (!entryKinds.has(STATUS_REFUNDED_KIND)) {
    pushEvent(
      "Reembolso procesado",
      requestRow.refundedAt,
      "💸 Tu reembolso ya fue procesado correctamente. Dependiendo de tu banco, el monto podrá verse reflejado en tu cuenta dentro de 5 a 10 días hábiles. Gracias por confiar en Cariana. 💙",
      "refunded",
    );
  }
  if (!entryKinds.has(RETURNED_TO_CUSTOMER_KIND)) {
    pushEvent("Devolucion devuelta al cliente", requestRow.returnedToCustomerAt, RETURNED_TO_CUSTOMER_MESSAGE, "pending");
  }

  for (const entry of requestRow.timelineEntries || []) {
    const kind = String(entry?.kind || "").toLowerCase();
    if (hideCourierProgress && (kind.startsWith("courier_en_route_") || kind.startsWith("courier_retry_"))) continue;
    const label = timelineLabelFromReasonEntry(entry);
    if (!label) continue;
    const note = kind === RETURNED_TO_CUSTOMER_KIND
      ? RETURNED_TO_CUSTOMER_MESSAGE
      : normalizeDisplayedReasonText(entry.reason);
    pushEvent(label, entry.at, note, timelineToneFromReasonEntry(entry));
  }

  const currentStatusKind = timelineKindFromStatus(requestRow.status);
  if (!currentStatusKind || !entryKinds.has(currentStatusKind)) {
    pushEvent(
      timelineLabelFromStatus(requestRow.status),
      requestRow.updatedAt,
      timelineStatusDescription(requestRow.status, requestRow),
      timelineToneFromStatus(requestRow.status),
    );
  }

  const dedup = new Map();
  for (const event of events) {
    const key = `${event.label}|${event.atMs}`;
    if (!dedup.has(key)) dedup.set(key, event);
  }

  return Array.from(dedup.values()).sort((a, b) => b.atMs - a.atMs);
}

function courierAttemptLabel(attempt) {
  const attemptNumber = Number(attempt || 0);
  if (attemptNumber === 1) return "Primer intento";
  if (attemptNumber === 2) return "Segundo intento";
  if (attemptNumber === 3) return "Tercer intento";
  return "Intento";
}

function courierAttemptCountLabel(attempt) {
  const attemptNumber = Number(attempt || 0);
  if (attemptNumber <= 0) return "";
  return attemptNumber === 1 ? "1 intento" : `${attemptNumber} intentos`;
}

function pickupRescheduleAttemptLabel(status) {
  const match = String(status || "").trim().toLowerCase().match(/^intento_fallido_(\d)$/);
  if (!match) return "";
  const attempt = Number(match[1]) || 0;
  return `${attempt} ${attempt === 1 ? "intento" : "intentos"}`;
}

function courierEventLabel(status, attempt) {
  const normalized = String(status || "").trim().toLowerCase();
  const attemptLabel = courierAttemptLabel(attempt);
  if (normalized === "en_ruta" || normalized.startsWith("en_ruta_")) return `${attemptLabel} en ruta`;
  if (normalized === "no_entregado") return `${attemptLabel} no entregado`;
  if (normalized === "reintento_pendiente") return `${attemptLabel} reprogramado`;
  if (normalized === "recoger_en_sucursal") return "Enviado a recoger en sucursal";
  if (normalized === "entregado") return `${attemptLabel} entregado`;
  return normalized.replace(/_/g, " ");
}

function courierHistoryEventLabel(event) {
  const label = courierEventLabel(event.status, event.attempt);
  if (String(event.status || "").trim().toLowerCase() !== "reintento_pendiente") return label;
  const eventDate = new Date(event.createdAt);
  if (!Number.isFinite(eventDate.getTime())) return label;
  const mexicoDateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(eventDate);
  const mexicoDateLookup = Object.fromEntries(mexicoDateParts.map((part) => [part.type, part.value]));
  const reprogrammedDate = new Date(Date.UTC(
    Number(mexicoDateLookup.year),
    Number(mexicoDateLookup.month) - 1,
    Number(mexicoDateLookup.day) + 1,
  ));
  const formattedDate = new Intl.DateTimeFormat("es-MX", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(reprogrammedDate);
  return `${label} para el ${formattedDate}`;
}

function returnCourierHistoryLabel(entry, finalAttempt) {
  const kind = String(entry?.kind || "").trim().toLowerCase();
  if (kind === STATUS_APPROVED_KIND) return "";
  if (kind.startsWith("courier_retry_") || kind === "rejected_after_attempts") return "";
  const failedAttemptMatch = kind.match(/^attempt_failed_(\d)$/);
  if (failedAttemptMatch) return `${courierAttemptLabel(failedAttemptMatch[1])} no entregado`;
  if (kind === STATUS_RECEIVED_KIND) return `${courierAttemptLabel(finalAttempt)} entregado`;
  return timelineLabelFromReasonEntry(entry);
}

function courierAttemptFromHistoryEvents(historyEvents, fallbackAttempt = 0) {
  const historyAttempt = (historyEvents || []).reduce((maxAttempt, event) => {
    const match = String(event?.label || "").match(/^(Primer|Segundo|Tercer) intento/i);
    if (!match) return maxAttempt;
    const attempt = match[1].toLowerCase() === "primer" ? 1 : match[1].toLowerCase() === "segundo" ? 2 : 3;
    return Math.max(maxAttempt, attempt);
  }, 0);
  return Math.max(historyAttempt, Number(fallbackAttempt || 0));
}

function courierStatusFromActivityAction(action, fallbackStatus = "") {
  const normalizedAction = String(action || "").trim().toLowerCase();
  const statusByAction = {
    courier_mark_delivered: "entregado",
    courier_mark_not_delivered: "no_entregado",
    courier_return_mark_received: "recibida",
    courier_return_pickup_attempt_failed: "no_recibido",
    courier_return_reject_after_failed_pickups: "rechazada",
  };
  return statusByAction[normalizedAction] || fallbackStatus;
}

function courierHistoryStatusLabel(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "no_entregado") return "no entregado";
  if (normalized === "no_recibido") return "no recibido";
  return getCourierStatusLabel(status);
}

function isCourierFinalActivityAction(action) {
  return [
    "courier_mark_delivered",
    "courier_mark_not_delivered",
    "courier_return_mark_received",
    "courier_return_pickup_attempt_failed",
    "courier_return_reject_after_failed_pickups",
  ].includes(String(action || "").trim().toLowerCase());
}

function buildCourierHistoryEvents(request) {
  if (request.courierLabel === "Devolución") {
    const entries = parseReasonEntries(request.rejectionReason);
    const finalAttempt = Math.max(
      1,
      entries.reduce((maxAttempt, entry) => {
        const kind = String(entry?.kind || "").trim().toLowerCase();
        const match = kind.match(/^(?:courier_en_route_|courier_retry_|attempt_failed_)(\d)$/);
        return match ? Math.max(maxAttempt, Number(match[1]) || 0) : maxAttempt;
      }, 0),
    );
    return entries
      .map((entry, index) => ({
        id: `${entry.kind}-${entry.at}-${index}`,
        label: returnCourierHistoryLabel(entry, finalAttempt),
        at: entry.at,
        atMs: parseEventMs(entry.at),
      }))
      .filter((entry) => entry.label && entry.atMs)
      .sort((a, b) => a.atMs - b.atMs);
  }

  if (request.persistedHistoryEvents?.length) {
    return request.persistedHistoryEvents.map((event) => ({
      id: `delivery-event-${event.id}`,
      label: courierHistoryEventLabel(event),
      at: event.createdAt,
      atMs: parseEventMs(event.createdAt),
      note: event.note || "",
    }));
  }

  const status = String(request.status || "").trim().toLowerCase();
  if (status === "pendiente") return [];
  return [{
    id: `delivery-${status}`,
    label: courierEventLabel(status, request.attemptCount),
    at: request.courierHistoryAt || request.updatedAt,
    atMs: parseEventMs(request.courierHistoryAt || request.updatedAt),
  }].filter((entry) => entry.atMs);
}

function formatCourierHistoryDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("es-MX", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function nextMexicoCalendarDay(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return new Date(Date.UTC(
    Number(lookup.year),
    Number(lookup.month) - 1,
    Number(lookup.day) + 1,
    12,
  ));
}

function formatCourierRescheduledDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(value);
}

function buildAdminCourierPresentation(request) {
  const events = request.historyEvents || [];
  const displayEvents = [];
  let scheduledDate = null;

  for (const event of events) {
    displayEvents.push(event);
    if (!/\bno (?:entregado|recibido)\b/i.test(String(event.label || ""))) continue;

    const attemptMatch = String(event.label || "").match(/^(Primer|Segundo|Tercer) intento/i);
    const reprogrammedFor = nextMexicoCalendarDay(event.at);
    if (!attemptMatch || !reprogrammedFor) continue;

    scheduledDate = reprogrammedFor;
    displayEvents.push({
      id: `${event.id}-reprogrammed`,
      label: `${attemptMatch[1]} intento reprogramado para el ${formatCourierRescheduledDate(reprogrammedFor)}`,
      at: event.at,
      atMs: parseEventMs(event.at),
    });
  }

  return { events: displayEvents, scheduledDate };
}

function pickParentTransaction(transactions) {
  const success = transactions.filter((tx) => String(tx.status || "").toUpperCase() === "SUCCESS");
  return (
    success.find((tx) => ["CAPTURE", "SALE"].includes(String(tx.kind || "").toUpperCase())) ||
    success[0] ||
    null
  );
}

async function fetchOrderSnapshot(admin, orderId) {
  const response = await admin.graphql(
    `#graphql
    query OrderForRefund($id: ID!) {
      order(id: $id) {
        id
        lineItems(first: 100) {
          edges {
            node {
              id
              title
              quantity
              variant { id }
              product { id }
              originalUnitPriceSet {
                shopMoney { amount currencyCode }
              }
            }
          }
        }
        transactions {
          id
          kind
          status
          gateway
        }
      }
    }`,
    { variables: { id: orderId } },
  );
  const payload = await response.json();
  const errors = payload?.errors || [];
  if (errors.length) {
    throw new Error(errors[0]?.message || "No se pudo consultar la orden en Shopify.");
  }
  const order = payload?.data?.order;
  if (!order) throw new Error("No se encontro la orden en Shopify.");
  return {
    orderId: order.id,
    lineItems: (order.lineItems?.edges || []).map(({ node }) => ({
      id: node.id,
      title: node.title,
      quantity: Number(node.quantity || 0),
      variantId: node.variant?.id || "",
      productId: node.product?.id || "",
      unitPrice: Number(node.originalUnitPriceSet?.shopMoney?.amount || 0),
    })),
    transactions: (order.transactions || []).map((transaction) => ({
      id: transaction.id,
      kind: transaction.kind,
      status: transaction.status,
      gateway: transaction.gateway || "",
    })),
  };
}

function putImageCandidate(map, key, imageUrl, imageAlt, variantSummary = "") {
  if (!key) return;
  const current = map[key] || {};
  map[key] = {
    imageUrl: current.imageUrl || imageUrl || "",
    imageAlt: current.imageAlt || imageAlt || "",
    variantSummary: current.variantSummary || variantSummary || "",
  };
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

async function fetchOrderItemImageMaps(admin, orderIds) {
  const uniqueIds = Array.from(new Set(orderIds.filter(Boolean)));
  if (!uniqueIds.length) return {};

  try {
    const response = await admin.graphql(
      `#graphql
      query OrdersForReturnImages($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Order {
            id
            lineItems(first: 100) {
              edges {
                node {
                  id
                  title
                  variant {
                    id
                    title
                    selectedOptions { name value }
                    image {
                      url
                      altText
                    }
                  }
                  product {
                    id
                    featuredImage {
                      url
                      altText
                    }
                  }
                }
              }
            }
          }
        }
      }`,
      { variables: { ids: uniqueIds } },
    );
    const payload = await response.json();
    const nodes = payload?.data?.nodes || [];
    const byOrder = {};

    for (const order of nodes) {
      if (!order?.id) continue;
      const imageMap = {};
      const lines = order?.lineItems?.edges || [];
      for (const edge of lines) {
        const line = edge?.node;
        if (!line) continue;
        const imageUrl = line?.variant?.image?.url || line?.product?.featuredImage?.url || "";
        const imageAlt = line?.variant?.image?.altText || line?.product?.featuredImage?.altText || "";
        const variantSummary = formatVariantSummary(line?.variant);

        putImageCandidate(imageMap, itemKeyFromRecord({ lineItemId: line.id }), imageUrl, imageAlt, variantSummary);
        putImageCandidate(imageMap, itemKeyFromRecord({ variantId: line?.variant?.id }), imageUrl, imageAlt, variantSummary);
        putImageCandidate(imageMap, itemKeyFromRecord({ productId: line?.product?.id }), imageUrl, imageAlt, variantSummary);
        putImageCandidate(imageMap, itemKeyFromRecord({ title: line.title }), imageUrl, imageAlt, variantSummary);
      }
      byOrder[order.id] = imageMap;
    }

    return byOrder;
  } catch {
    return {};
  }
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

function buildViewWhere(shop, viewMode) {
  if (viewMode === VIEW_MODE.PICKUP) {
    return {
      shop,
      returnMethod: "pickup",
      status: { in: Array.from(METHOD_QUEUE_STATUSES) },
    };
  }

  if (viewMode === VIEW_MODE.BRANCH) {
    return {
      shop,
      returnMethod: { not: "pickup" },
      status: { in: Array.from(METHOD_QUEUE_STATUSES) },
    };
  }

  if (viewMode === VIEW_MODE.REVIEW) {
    return {
      shop,
      status: "en_revision",
    };
  }

  if (viewMode === VIEW_MODE.REFUNDS) {
    return {
      shop,
      status: { in: Array.from(REFUND_QUEUE_STATUSES) },
    };
  }

  if (viewMode === VIEW_MODE.TO_RETURN) {
    return {
      shop,
      status: { in: Array.from(RETURN_TO_CUSTOMER_STATUSES) },
    };
  }

  if (viewMode === VIEW_MODE.HISTORY) {
    return {
      shop,
      status: { in: Array.from(HISTORY_STATUSES) },
    };
  }

  return { shop };
}

function shouldIncludeEvidencePhotos(viewMode) {
  return (
    viewMode === VIEW_MODE.REVIEW ||
    viewMode === VIEW_MODE.REFUNDS ||
    viewMode === VIEW_MODE.TO_RETURN
  );
}

function shouldLoadOrderCatalogImages(viewMode) {
  return (
    viewMode === VIEW_MODE.REVIEW ||
    viewMode === VIEW_MODE.REFUNDS ||
    viewMode === VIEW_MODE.TO_RETURN
  );
}

function mapRequestItemsToRefundLineItems(requestItems, orderLineItems) {
  const requestedQtyByLineId = new Map();

  const byLine = new Map(orderLineItems.map((line) => [line.id, line]));
  const byVariant = new Map(orderLineItems.map((line) => [line.variantId, line]).filter(([k]) => k));
  const byProduct = new Map(orderLineItems.map((line) => [line.productId, line]).filter(([k]) => k));

  for (const item of requestItems) {
    let line = null;
    const lineItemId = String(item.lineItemId || "").trim();
    if (lineItemId && byLine.has(lineItemId)) {
      line = byLine.get(lineItemId);
    }
    if (!line) {
      const variantId = String(item.variantId || "").trim();
      if (variantId && byVariant.has(variantId)) line = byVariant.get(variantId);
    }
    if (!line) {
      const productId = String(item.productId || "").trim();
      if (productId && byProduct.has(productId)) line = byProduct.get(productId);
    }
    if (!line) {
      const title = String(item.title || "").trim().toLowerCase();
      line =
        orderLineItems.find(
          (candidate) => String(candidate.title || "").trim().toLowerCase() === title,
        ) || null;
    }

    if (!line) {
      throw new Error(`No se pudo mapear el producto "${item.title}" a una linea de la orden.`);
    }

    const itemQuantity = Math.max(1, Number(item.quantity || 1));
    const prevRequested = Number(requestedQtyByLineId.get(line.id) || 0);
    const nextRequested = prevRequested + itemQuantity;
    const maxLineQuantity = Math.max(1, Number(line.quantity || 1));
    if (nextRequested > maxLineQuantity) {
      throw new Error(`La cantidad a devolver para "${item.title}" excede la cantidad comprada.`);
    }
    requestedQtyByLineId.set(line.id, nextRequested);
  }

  const refundableLines = [];
  let subtotal = 0;
  for (const [lineId, quantity] of requestedQtyByLineId.entries()) {
    const line = byLine.get(lineId);
    if (!line) continue;
    subtotal += Number(line.unitPrice || 0) * Number(quantity || 0);
    refundableLines.push({
      lineItemId: lineId,
      quantity: Number(quantity || 0),
      restockType: "NO_RESTOCK",
    });
  }

  return { refundLineItems: refundableLines, subtotal };
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const requestedViewMode = normalizeViewMode(url.searchParams.get("tipo"));
  const pathViewMode = normalizeViewMode(viewModeFromPathname(url.pathname));
  const viewMode = pathViewMode || requestedViewMode;
  const where = buildViewWhere(session.shop, viewMode);
  const includeEvidencePhotos = shouldIncludeEvidencePhotos(viewMode);
  const itemSelect = {
    id: true,
    lineItemId: true,
    productId: true,
    variantId: true,
    title: true,
    quantity: true,
    reason: true,
    details: true,
    ...(includeEvidencePhotos ? { photoDataUrl: true } : {}),
  };

  let rawRequests =
    viewMode === VIEW_MODE.COURIER ||
    viewMode === VIEW_MODE.COURIER_HISTORY ||
    viewMode === VIEW_MODE.BRANCH_PICKUP ||
    viewMode === VIEW_MODE.COURIERS
      ? []
      : await prisma.returnRequest.findMany({
          where,
          include: { items: { select: itemSelect } },
          orderBy: { createdAt: "desc" },
        });

  if (viewMode === VIEW_MODE.BRANCH && rawRequests.length > 0) {
    const orderNumbers = [
      ...new Set(rawRequests.map((requestRow) => String(requestRow.orderNumber || "").trim()).filter(Boolean)),
    ];
    const comparableRequests = await prisma.returnRequest.findMany({
      where: {
        shop: session.shop,
        orderNumber: { in: orderNumbers },
      },
      include: {
        items: {
          select: {
            lineItemId: true,
            productId: true,
            variantId: true,
            title: true,
            quantity: true,
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const latestRequestIdByItemsSignature = new Map();
    for (const requestRow of comparableRequests) {
      const signature = returnRequestItemsSignature(requestRow);
      if (!latestRequestIdByItemsSignature.has(signature)) {
        latestRequestIdByItemsSignature.set(signature, requestRow.id);
      }
    }
    rawRequests = rawRequests.filter(
      (requestRow) => latestRequestIdByItemsSignature.get(returnRequestItemsSignature(requestRow)) === requestRow.id,
    );
  }

  const courierOrdersRaw =
    viewMode === VIEW_MODE.COURIER
      ? [
          ...(await fetchCourierOrders(admin)).map((requestRow) => ({
            ...requestRow,
            courierLabel: "Entrega",
          })),
          ...(await fetchPickupCourierOrders(session.shop)).map((requestRow) => ({
            ...requestRow,
            courierLabel: "Devolución",
          })),
        ]
      : viewMode === VIEW_MODE.BRANCH_PICKUP
        ? (await fetchBranchPickupCourierOrders(admin)).map((requestRow) => ({
            ...requestRow,
            courierLabel: "Entrega",
          }))
      : viewMode === VIEW_MODE.COURIER_HISTORY
        ? [
            ...new Map(
              [
                ...(await fetchCourierOrders(admin)).map((requestRow) => ({
                  ...requestRow,
                  courierLabel: "Entrega",
                })),
                ...(await fetchPickupCourierOrders(session.shop)).map((requestRow) => ({
                  ...requestRow,
                  courierLabel: "Devolución",
                })),
                ...(await fetchCourierHistoryOrders(admin)).map((requestRow) => ({
                  ...requestRow,
                  courierLabel: "Entrega",
                })),
                ...(await fetchPickupCourierHistoryOrders(session.shop)).map((requestRow) => ({
                  ...requestRow,
                  courierLabel: "Devolución",
                })),
              ].map((requestRow) => [String(requestRow.id || ""), requestRow]),
            ).values(),
          ]
      : [];

  const deliveryRequestIds = courierOrdersRaw
    .filter((requestRow) => requestRow.courierLabel === "Entrega")
    .map((requestRow) => String(requestRow.id || "").trim())
    .filter(Boolean);
  let deliveryHistoryEvents = [];
  if (deliveryRequestIds.length) {
    try {
      deliveryHistoryEvents = await prisma.courierEvent.findMany({
        where: {
          shop: session.shop,
          requestId: { in: deliveryRequestIds },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
    } catch (error) {
      console.error("Courier event history is not available yet", error);
    }
  }
  const deliveryHistoryByRequestId = new Map();
  for (const event of deliveryHistoryEvents) {
    const current = deliveryHistoryByRequestId.get(event.requestId) || [];
    current.push(event);
    deliveryHistoryByRequestId.set(event.requestId, current);
  }

  const shouldLoadImages = shouldLoadOrderCatalogImages(viewMode);
  const imagesByOrder = shouldLoadImages
    ? await fetchOrderItemImageMaps(
        admin,
        rawRequests.map((requestRow) => requestRow.shopifyOrderId),
      )
    : {};

  const requests = rawRequests.map((requestRow) => {
    const imageMap = imagesByOrder[requestRow.shopifyOrderId] || {};
    const status = String(requestRow.status || "").toLowerCase();
    const reasonEntries = parseReasonEntries(requestRow.rejectionReason);
    const visibleReasonEntries = reasonEntries.filter((entry) => !isSystemProgressEntry(entry));
    const wasReturnedToCustomer = reasonEntries.some((entry) => isReturnedToCustomerEntry(entry));
    const returnedToCustomerAt = latestReturnedToCustomerAtFromRaw(requestRow.rejectionReason);
    const requiresPickupDeadline = ["por_devolver", "no_devuelto", "reembolso_denegado", "denegada"].includes(status);
    const pendingPickupSinceAt = requiresPickupDeadline
      ? latestEntryAtFromKinds(requestRow.rejectionReason, ["denied_after_received"]) ||
        requestRow.updatedAt?.toISOString?.() ||
        ""
      : "";
    const pickupDeadlineDate = requiresPickupDeadline ? addDays(pendingPickupSinceAt, PICKUP_DEADLINE_DAYS) : null;
    const pickupDeadlineAt = pickupDeadlineDate ? pickupDeadlineDate.toISOString() : "";
    const isPickupDeadlineExpired =
      Boolean(pickupDeadlineDate) && new Date().getTime() > pickupDeadlineDate.getTime();
    const branchDeliveryDeadlineDate =
      requestRow.returnMethod !== "pickup" && requestRow.limitDate ? new Date(requestRow.limitDate) : null;
    const hasValidBranchDeliveryDeadline =
      Boolean(branchDeliveryDeadlineDate) && Number.isFinite(branchDeliveryDeadlineDate.getTime());
    const branchDeliveryDeadlineAt = hasValidBranchDeliveryDeadline
      ? branchDeliveryDeadlineDate.toISOString()
      : "";
    const isBranchDeliveryDeadlineExpired =
      hasValidBranchDeliveryDeadline && new Date().getTime() > branchDeliveryDeadlineDate.getTime();
    return {
      ...requestRow,
      rejectionReason: latestReasonFromRaw(requestRow.rejectionReason),
      timelineEntries: reasonEntries,
      reasonEntries: visibleReasonEntries,
      wasReturnedToCustomer,
      returnedToCustomerAt,
      pickupDeadlineAt,
      isPickupDeadlineExpired,
      branchDeliveryDeadlineAt,
      isBranchDeliveryDeadlineExpired,
      items: requestRow.items.map((item) => {
        const image = imageMap[itemKeyFromRecord(item)] || null;
        return {
          ...item,
          imageUrl: image?.imageUrl || "",
          imageAlt: image?.imageAlt || "",
          variantSummary: image?.variantSummary || "",
        };
      }),
    };
  });

  const courierOrders = courierOrdersRaw
    .map((requestRow) => ({
      ...requestRow,
      historyEvents: buildCourierHistoryEvents({
        ...requestRow,
        persistedHistoryEvents: deliveryHistoryByRequestId.get(String(requestRow.id || "").trim()) || [],
      }),
    }))
    .sort((a, b) =>
      viewMode === VIEW_MODE.COURIER_HISTORY
        ? courierOrderTimestampMs(b) - courierOrderTimestampMs(a)
        : courierOrderTimestampMs(a) - courierOrderTimestampMs(b),
    );

  const couriers =
    viewMode === VIEW_MODE.COURIERS || viewMode === VIEW_MODE.COURIER_HISTORY
      ? await prisma.courier.findMany({
          where: { shop: session.shop },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        })
      : [];

  const courierActivities =
    viewMode === VIEW_MODE.COURIER_HISTORY
      ? await prisma.courierActivity.findMany({
          where: { shop: session.shop },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        })
      : [];

  const courierRouteSnapshots =
    viewMode === VIEW_MODE.COURIER_HISTORY
      ? await prisma.courierRouteSnapshot.findMany({
          where: { shop: session.shop },
          orderBy: [{ finishedAt: "desc" }, { id: "desc" }],
        })
      : [];

  return {
    requests,
    courierOrders,
    couriers,
    courierActivities,
    courierRouteSnapshots,
    viewMode,
    shop: session.shop,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const id = Number(formData.get("id") || 0);

  if (intent === "create_courier") {
    const name = String(formData.get("name") || "").trim();
    const code = String(formData.get("code") || "").trim();
    if (!name) return { ok: false, error: "Escribe el nombre del repartidor." };
    if (!/^\d{6}$/.test(code)) {
      return { ok: false, error: "Genera un codigo numerico de 6 digitos." };
    }
    const existingCourier = await prisma.courier.findFirst({
      where: { shop: session.shop, code },
      select: { id: true },
    });
    if (existingCourier) {
      return { ok: false, error: "Ese codigo ya existe. Genera uno nuevo." };
    }
    await prisma.courier.create({
      data: { shop: session.shop, name, code },
    });
    return { ok: true, message: "Repartidor guardado correctamente." };
  }

  if (intent === "delete_courier") {
    const courierId = Number(formData.get("courierId") || 0);
    if (!courierId) return { ok: false, error: "Repartidor invalido." };
    const deletedCourier = await prisma.courier.deleteMany({
      where: { id: courierId, shop: session.shop },
    });
    if (!deletedCourier.count) {
      return { ok: false, error: "No se encontro el repartidor." };
    }
    return { ok: true, message: "Repartidor dado de baja correctamente." };
  }

  if (intent === "load_request_media") {
    if (!id) return { ok: false, intent, error: "Solicitud invalida." };
    const mediaRequestRow = await prisma.returnRequest.findFirst({
      where: { id, shop: session.shop },
      select: {
        id: true,
        shopifyOrderId: true,
        items: {
          select: {
            id: true,
            lineItemId: true,
            productId: true,
            variantId: true,
            title: true,
            photoDataUrl: true,
          },
        },
      },
    });
    if (!mediaRequestRow) return { ok: false, intent, error: "No se encontro la solicitud." };

    const imagesByOrder = await fetchOrderItemImageMaps(admin, [mediaRequestRow.shopifyOrderId]);
    const imageMap = imagesByOrder[mediaRequestRow.shopifyOrderId] || {};
    const mediaItems = mediaRequestRow.items.map((item) => {
      const image = imageMap[itemKeyFromRecord(item)] || null;
      return {
        id: item.id,
        imageUrl: image?.imageUrl || "",
        imageAlt: image?.imageAlt || "",
        variantSummary: image?.variantSummary || "",
        photoDataUrl: item.photoDataUrl || "",
      };
    });
    return { ok: true, intent, mediaItems };
  }

  if (!id) return { ok: false, error: "Solicitud invalida." };

  const requestRow = await prisma.returnRequest.findFirst({
    where: { id, shop: session.shop },
    include: { items: true },
  });
  if (!requestRow) return { ok: false, error: "No se encontro la solicitud." };

  if (intent === "approve_request") {
    const approvedMessage =
      requestRow.returnMethod === "pickup"
        ? "Tu solicitud fue aprobada. Recogeremos tu producto en el domicilio y fecha indicados."
        : "Tu solicitud fue aprobada. Lleva tu producto a la sucursal de devoluciones.";
    await prisma.returnRequest.update({
      where: { id },
      data: {
        status: "aprobada",
        rejectionReason: appendTimelineMetaEntry(requestRow.rejectionReason, {
          kind: STATUS_APPROVED_KIND,
          reason: approvedMessage,
        }),
      },
    });
    await emitReturnNotificationEvent({
      shopDomain: session.shop,
      requestRow,
      intent,
      note: approvedMessage,
    });
    return { ok: true, message: "Solicitud aprobada." };
  }

  if (intent === "reject_request") {
    const rejectionReason = String(formData.get("rejectionReason") || "").trim();
    if (!rejectionReason) {
      return { ok: false, error: "Escribe el motivo de rechazo." };
    }
    await prisma.returnRequest.update({
      where: { id },
      data: {
        status: "rechazada",
        rejectionReason: appendReasonEntry(requestRow.rejectionReason, {
          kind: "review_rejected",
          reason: rejectionReason,
        }),
      },
    });
    await emitReturnNotificationEvent({
      shopDomain: session.shop,
      requestRow,
      intent,
      note: rejectionReason,
    });
    return { ok: true, message: "Solicitud rechazada." };
  }

  if (intent === "mark_in_route") {
    if (String(requestRow.returnMethod || "").toLowerCase() !== "pickup") {
      return { ok: false, error: "Solo aplica a solicitudes de recoleccion a domicilio." };
    }
    const currentStatus = String(requestRow.status || "").toLowerCase();
    if (currentStatus !== "aprobada" && currentStatus !== "en_ruta" && !currentStatus.startsWith("en_ruta_")) {
      return { ok: false, error: "Solo puedes marcar en ruta una solicitud aprobada." };
    }
    const routeNote = "Tu recoleccion ya va en ruta hacia tu domicilio. Nuestro equipo se dirige para continuar el proceso.";
    await prisma.returnRequest.update({
      where: { id },
      data: {
        status: currentStatus.startsWith("en_ruta_") ? currentStatus : "en_ruta",
        rejectionReason: appendTimelineMetaEntry(requestRow.rejectionReason, {
          kind: STATUS_IN_ROUTE_KIND,
          reason: routeNote,
        }),
      },
    });
    await emitOrderStatusNotification({
      shopDomain: session.shop,
      requestRow,
      status: "en_ruta",
      note: routeNote,
    });
    return { ok: true, message: "Solicitud marcada como en ruta y notificada al cliente." };
  }

  if (intent === "mark_received") {
    const currentStatus = String(requestRow.status || "").toLowerCase();
    const canMarkReceived =
      currentStatus === "aprobada" ||
      currentStatus === "en_ruta" ||
      currentStatus.startsWith("en_ruta_") ||
      isPickupFailedAttemptStatus(currentStatus);
    if (!canMarkReceived) {
      return {
        ok: false,
        error: "Solo puedes marcar como recibida una solicitud aprobada o con intento fallido.",
      };
    }
    await prisma.returnRequest.update({
      where: { id },
      data: {
        status: "recibida",
        receivedAt: new Date(),
        rejectionReason: appendTimelineMetaEntry(requestRow.rejectionReason, {
          kind: STATUS_RECEIVED_KIND,
          reason: "Producto recibido. 📦 Hemos recibido tu devolución y nuestro equipo ya se encuentra revisando tu producto. Una vez finalizado el proceso de verificación, realizaremos tu reembolso correspondiente. 💰",
        }),
      },
    });
    await emitReturnNotificationEvent({
      shopDomain: session.shop,
      requestRow,
      intent,
      note: "Recibimos tu producto para validar la devolucion.",
    });
    return { ok: true, message: "Solicitud marcada como recibida." };
  }

  if (intent === "mark_never_arrived") {
    if (String(requestRow.returnMethod || "").toLowerCase() === "pickup") {
      return { ok: false, error: "Solo aplica a solicitudes de entrega en sucursal." };
    }
    if (String(requestRow.status || "").toLowerCase() !== "aprobada") {
      return { ok: false, error: "Solo puedes marcar como nunca llego una solicitud aprobada." };
    }
    const branchDeliveryDeadlineDate = requestRow.limitDate ? new Date(requestRow.limitDate) : null;
    const isBranchDeliveryDeadlineExpired =
      Boolean(branchDeliveryDeadlineDate) &&
      Number.isFinite(branchDeliveryDeadlineDate.getTime()) &&
      new Date().getTime() > branchDeliveryDeadlineDate.getTime();
    if (!isBranchDeliveryDeadlineExpired) {
      return { ok: false, error: "Aun no vence la fecha limite de entrega para marcar esta solicitud como nunca llego." };
    }
    await prisma.returnRequest.update({
      where: { id },
      data: {
        status: "no_devuelto",
        rejectionReason: appendReasonEntry(requestRow.rejectionReason, {
          kind: "never_arrived_branch",
          reason: NEVER_ARRIVED_BRANCH_REASON,
        }),
      },
    });
    await emitReturnNotificationEvent({
      shopDomain: session.shop,
      requestRow,
      intent,
      note: NEVER_ARRIVED_BRANCH_REASON,
    });
    return { ok: true, message: "Solicitud marcada como nunca llego y enviada al historial." };
  }
  if (intent === "pickup_attempt_failed") {
    const currentStatus = String(requestRow.status || "").toLowerCase();
    if (requestRow.returnMethod !== "pickup") {
      return { ok: false, error: "Solo aplica a solicitudes de recoleccion a domicilio." };
    }
    if (
      currentStatus !== "aprobada" &&
      currentStatus !== "en_ruta" &&
      !currentStatus.startsWith("en_ruta_") &&
      currentStatus !== "intento_fallido_1" &&
      currentStatus !== "intento_fallido_2"
    ) {
      return { ok: false, error: "Ya no puedes registrar mas intentos fallidos para esta solicitud." };
    }
    const rejectionReason = String(formData.get("rejectionReason") || "").trim();
    if (!rejectionReason) {
      return { ok: false, error: "Escribe la descripcion obligatoria del intento fallido." };
    }
    const currentRouteAttempt = Number(currentStatus.match(/^en_ruta_(\d+)$/)?.[1] || 0);
    const nextStatus =
      currentStatus === "aprobada" || currentStatus === "en_ruta" || currentRouteAttempt <= 1
        ? "intento_fallido_1"
        : currentStatus === "intento_fallido_1" || currentRouteAttempt === 2
          ? "intento_fallido_2"
          : "intento_fallido_3";
    await prisma.returnRequest.update({
      where: { id },
      data: {
        status: nextStatus,
        rejectionReason: appendReasonEntry(requestRow.rejectionReason, {
          kind: `attempt_failed_${nextStatus.replace("intento_fallido_", "")}`,
          reason: rejectionReason,
        }),
      },
    });
    await emitReturnNotificationEvent({
      shopDomain: session.shop,
      requestRow,
      intent,
      note: rejectionReason,
    });
    return {
      ok: true,
      message:
        nextStatus === "intento_fallido_1"
          ? "Intento de recoleccion fallido registrado (1 de 2)."
          : "Intento de recoleccion fallido registrado (2 de 2). Ahora puedes rechazar la devolucion.",
    };
  }

  if (intent === "reject_after_failed_pickups") {
    if (String(requestRow.status || "").toLowerCase() !== "intento_fallido_2") {
      return { ok: false, error: "Solo puedes rechazar despues de dos intentos fallidos." };
    }
    const rejectionReason = String(formData.get("rejectionReason") || "").trim();
    if (!rejectionReason) {
      return { ok: false, error: "Escribe el motivo obligatorio de rechazo." };
    }
    await prisma.returnRequest.update({
      where: { id },
      data: {
        status: "rechazada",
        rejectionReason: appendReasonEntry(requestRow.rejectionReason, {
          kind: "rejected_after_attempts",
          reason: rejectionReason,
        }),
        refundError: null,
      },
    });
    await emitReturnNotificationEvent({
      shopDomain: session.shop,
      requestRow,
      intent,
      note: rejectionReason,
    });
    return { ok: true, message: "Solicitud rechazada por intentos de recoleccion fallidos." };
  }

  if (intent === "deny_received") {
    if (String(requestRow.status || "").toLowerCase() !== "recibida") {
      return { ok: false, error: "Solo puedes denegar una solicitud marcada como recibida." };
    }
    const rejectionReason = String(formData.get("rejectionReason") || "").trim();
    if (!rejectionReason) {
      return { ok: false, error: "Escribe el motivo de denegacion." };
    }
    await prisma.returnRequest.update({
      where: { id },
      data: {
        status: "por_devolver",
        rejectionReason: appendReasonEntry(requestRow.rejectionReason, {
          kind: "denied_after_received",
          reason: rejectionReason,
        }),
        refundError: null,
      },
    });
    await emitReturnNotificationEvent({
      shopDomain: session.shop,
      requestRow,
      intent,
      note: rejectionReason,
    });
    return { ok: true, message: "Reembolso denegado y enviado a devoluciones pendientes por recoger." };
  }

  if (intent === "mark_returned_to_customer") {
    if (String(requestRow.status || "").toLowerCase() !== "por_devolver") {
      return { ok: false, error: "Solo puedes confirmar devoluciones pendientes por recoger." };
    }
    await prisma.returnRequest.update({
      where: { id },
      data: {
        status: "reembolso_denegado",
        rejectionReason: appendReasonEntry(requestRow.rejectionReason, {
          kind: RETURNED_TO_CUSTOMER_KIND,
          reason: RETURNED_TO_CUSTOMER_MESSAGE,
        }),
      },
    });
    await emitReturnNotificationEvent({
      shopDomain: session.shop,
      requestRow,
      intent,
      note: RETURNED_TO_CUSTOMER_MESSAGE,
    });
    return { ok: true, message: "Devolucion marcada como devuelta al cliente y enviada al historial." };
  }

  if (intent === "mark_not_returned") {
    if (String(requestRow.status || "").toLowerCase() !== "por_devolver") {
      return { ok: false, error: "Solo aplica a solicitudes pendientes por recoger." };
    }
    const pendingPickupSinceAt =
      latestEntryAtFromKinds(requestRow.rejectionReason, ["denied_after_received"]) ||
      requestRow.updatedAt?.toISOString?.() ||
      "";
    const pickupDeadlineDate = addDays(pendingPickupSinceAt, PICKUP_DEADLINE_DAYS);
    if (!pickupDeadlineDate || new Date().getTime() <= pickupDeadlineDate.getTime()) {
      return {
        ok: false,
        error: "Aun no se cumplen los 30 dias para marcar esta solicitud como no devuelta.",
      };
    }
    await prisma.returnRequest.update({
      where: { id },
      data: {
        status: "no_devuelto",
        rejectionReason: appendReasonEntry(requestRow.rejectionReason, {
          kind: NOT_RETURNED_KIND,
          reason: NOT_RETURNED_REASON,
        }),
      },
    });
    await emitReturnNotificationEvent({
      shopDomain: session.shop,
      requestRow,
      intent,
      note: NOT_RETURNED_REASON,
    });
    return { ok: true, message: "Solicitud marcada como no devuelta y enviada al historial." };
  }

  if (intent === "process_refund") {
    if (String(requestRow.status || "").toLowerCase() !== "recibida") {
      return { ok: false, error: "Primero marca la solicitud como recibida." };
    }

    try {
      const snapshot = await fetchOrderSnapshot(admin, requestRow.shopifyOrderId);
      const { refundLineItems, subtotal } = mapRequestItemsToRefundLineItems(
        requestRow.items,
        snapshot.lineItems,
      );
      if (!refundLineItems.length) {
        return { ok: false, error: "No hay lineas para reembolsar." };
      }

      const returnCost = requestRow.returnMethod === "pickup" ? Number(requestRow.returnCost || 0) : 0;
      const finalRefund = subtotal - returnCost;
      if (finalRefund <= 0) {
        return {
          ok: false,
          error:
            "No se puede procesar este reembolso: el costo de recoleccion es mayor o igual al subtotal.",
        };
      }

      const parentTransaction = pickParentTransaction(snapshot.transactions);
      if (!parentTransaction?.id || !parentTransaction?.gateway) {
        return {
          ok: false,
          error:
            "No se encontro una transaccion de pago valida para reembolsar al metodo original.",
        };
      }

      const response = await admin.graphql(
        `#graphql
        mutation RefundRequest($input: RefundInput!) {
          refundCreate(input: $input) {
            refund { id }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            input: {
              orderId: requestRow.shopifyOrderId,
              note: `Devolucion #${requestRow.id} desde Portal de devoluciones`,
              notify: false,
              refundLineItems,
              transactions: [
                {
                  orderId: requestRow.shopifyOrderId,
                  kind: "REFUND",
                  gateway: parentTransaction.gateway,
                  parentId: parentTransaction.id,
                  amount: Number(finalRefund).toFixed(2),
                },
              ],
            },
          },
        },
      );
      const payload = await response.json();
      const topErrors = payload?.errors || [];
      const userErrors = payload?.data?.refundCreate?.userErrors || [];
      if (topErrors.length || userErrors.length) {
        const first = topErrors[0]?.message || userErrors[0]?.message || "No se pudo procesar el reembolso.";
        await prisma.returnRequest.update({
          where: { id },
          data: { refundError: first },
        });
        return { ok: false, error: first };
      }

      const refundId = String(payload?.data?.refundCreate?.refund?.id || "");
      await prisma.returnRequest.update({
        where: { id },
        data: {
          status: "reembolsada",
          refundedAt: new Date(),
          rejectionReason: appendTimelineMetaEntry(requestRow.rejectionReason, {
            kind: STATUS_REFUNDED_KIND,
            reason: "💸 Tu reembolso ya fue procesado correctamente. Dependiendo de tu banco, el monto podrá verse reflejado en tu cuenta dentro de 5 a 10 días hábiles. Gracias por confiar en Cariana. 💙",
          }),
          shopifyRefundId: refundId || null,
          refundedSubtotal: subtotal,
          finalRefund,
          refundError: null,
        },
      });
      await emitReturnNotificationEvent({
        shopDomain: session.shop,
        requestRow,
        intent,
        note: "💸 Tu reembolso ya fue procesado correctamente. Dependiendo de tu banco, el monto podrá verse reflejado en tu cuenta dentro de 5 a 10 días hábiles. Gracias por confiar en Cariana. 💙",
      });
      return { ok: true, message: "Reembolso procesado al metodo de pago original." };
    } catch (error) {
      const message = String(error?.message || error || "No se pudo procesar el reembolso.");
      await prisma.returnRequest.update({
        where: { id },
        data: { refundError: message },
      });
      return { ok: false, error: message };
    }
  }

  return { ok: false, error: "Accion no valida." };
};

function formatPickupDateHeading(pickupDate) {
  const raw = String(pickupDate || "").trim();
  if (!raw) return "sin fecha definida";
  const date = new Date(`${raw}T00:00:00`);
  if (!Number.isFinite(date.getTime())) return "sin fecha definida";
  return date.toLocaleDateString("es-MX", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function buildPickupGroups(requests) {
  const groups = new Map();
  for (const request of requests) {
    const key = String(request.pickupDate || "").trim() || "sin_fecha";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(request);
  }

  const keys = Array.from(groups.keys()).sort((a, b) => {
    if (a === "sin_fecha") return 1;
    if (b === "sin_fecha") return -1;
    const aMs = new Date(`${a}T00:00:00`).getTime();
    const bMs = new Date(`${b}T00:00:00`).getTime();
    return aMs - bMs;
  });

  return keys.map((key) => ({
    key,
    heading: key === "sin_fecha" ? "sin fecha definida" : formatPickupDateHeading(key),
    requests: groups.get(key) || [],
  }));
}

function normalizeCourierAttrKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function getCourierCustomAttribute(orderNode, candidateKeys) {
  const attributes = Array.isArray(orderNode?.customAttributes) ? orderNode.customAttributes : [];
  const normalizedKeys = new Set((candidateKeys || []).map((key) => normalizeCourierAttrKey(key)));
  const match = attributes.find((attribute) => normalizedKeys.has(normalizeCourierAttrKey(attribute?.key)));
  return String(match?.value || "").trim();
}

function getCourierScheduledDate(orderNode) {
  const candidate = getCourierCustomAttribute(orderNode, [
    "programado",
    "pickupDate",
    "pickup_date",
    "delivery_date",
    "deliveryDate",
    "scheduled_date",
    "scheduledDate",
    "preferred_delivery_date",
  ]);
  return candidate;
}

function parseCourierDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const date = raw.includes("T") ? new Date(raw) : new Date(`${raw}T00:00:00`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function isCourierLocalDeliveryOrder(orderNode) {
  const shippingLines = Array.isArray(orderNode?.shippingLines?.nodes) ? orderNode.shippingLines.nodes : [];
  return shippingLines.some((line) => {
    const title = String(line?.title || "").toLowerCase();
    const code = String(line?.code || "").toLowerCase();
    const category = String(line?.deliveryCategory || "").toLowerCase();
    return title.includes("local") || code.includes("local") || category.includes("local");
  });
}

function getCourierStatusLabel(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (
    ["no_entregado", "reintento_pendiente", "no_recibido", "intento_fallido_1", "intento_fallido_2"].includes(
      normalized,
    )
  ) {
    return "reprogramado";
  }
  if (normalized.startsWith("en_ruta")) return "en ruta";
  return STATUS_LABEL[normalized] || normalized.replace(/_/g, " ");
}

async function fetchCourierOrders(admin) {
  const response = await admin.graphql(
    `#graphql
    query CourierOrders {
      orders(first: 250, query: "fulfillment_status:unfulfilled", sortKey: UPDATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            createdAt
            updatedAt
            displayFulfillmentStatus
            tags
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
            billingAddress {
              name
              phone
            }
            customAttributes {
              key
              value
            }
            shippingLines(first: 5) {
              nodes {
                title
                code
                deliveryCategory
              }
            }
          }
        }
      }
    }`,
  );
  const payload = await response.json();
  const errors = payload?.errors || [];
  if (errors.length) {
    throw new Error(errors[0]?.message || "No se pudieron cargar las ordenes repartidor.");
  }

  const nodes = payload?.data?.orders?.edges?.map((edge) => edge?.node).filter(Boolean) || [];
  return nodes
    .filter((orderNode) => {
      const status = String(orderNode?.displayFulfillmentStatus || "").toUpperCase();
      const courierStatus = getCourierRouteStatusFromTags(orderNode?.tags);
      return (
        isCourierLocalDeliveryOrder(orderNode) &&
        !["FULFILLED", "RESTOCKED"].includes(status) &&
        courierStatus !== "recoger_en_sucursal"
      );
    })
    .map((orderNode) => {
      const shipping = orderNode.shippingAddress || null;
      const billing = orderNode.billingAddress || null;
      return {
        id: orderNode.id,
        orderNumber: String(orderNode.name || "").replace("#", ""),
        customerName: String(shipping?.name || billing?.name || "Cliente").trim(),
        customerPhone: String(shipping?.phone || billing?.phone || "-").trim() || "-",
        pickupDate: getCourierScheduledDate(orderNode) || String(orderNode.createdAt || ""),
        pickupAddress: String(shipping?.address1 || "").trim(),
        pickupNeighborhood: String(shipping?.address2 || "").trim(),
        pickupCity: String(shipping?.city || "").trim(),
        pickupState: String(shipping?.province || "").trim(),
        pickupPostalCode: String(shipping?.zip || "").trim(),
        pickupCountry: String(shipping?.country || "Mexico").trim() || "Mexico",
        createdAt: orderNode.createdAt,
        updatedAt: orderNode.updatedAt || orderNode.createdAt,
        status: getCourierRouteStatusFromTags(orderNode.tags),
      };
    })
    .sort((a, b) => courierOrderTimestampMs(a) - courierOrderTimestampMs(b));
}

async function fetchBranchPickupCourierOrders(admin) {
  const response = await admin.graphql(
    `#graphql
    query BranchPickupCourierOrders {
      orders(first: 250, query: "tag:'recoger en sucursal'", sortKey: UPDATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            createdAt
            updatedAt
            displayFulfillmentStatus
            tags
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
            billingAddress {
              name
              phone
            }
            customAttributes {
              key
              value
            }
            shippingLines(first: 5) {
              nodes {
                title
                code
                deliveryCategory
              }
            }
          }
        }
      }
    }`,
  );
  const payload = await response.json();
  const errors = payload?.errors || [];
  if (errors.length) {
    throw new Error(errors[0]?.message || "No se pudieron cargar las ordenes para recoger en sucursal.");
  }

  const nodes = payload?.data?.orders?.edges?.map((edge) => edge?.node).filter(Boolean) || [];
  return nodes
    .filter((orderNode) => {
      const status = String(orderNode?.displayFulfillmentStatus || "").toUpperCase();
      const courierStatus = getCourierRouteStatusFromTags(orderNode?.tags);
      return (
        isCourierLocalDeliveryOrder(orderNode) &&
        !["FULFILLED", "RESTOCKED"].includes(status) &&
        courierStatus === "recoger_en_sucursal"
      );
    })
    .map((orderNode) => {
      const shipping = orderNode.shippingAddress || null;
      const billing = orderNode.billingAddress || null;
      return {
        id: orderNode.id,
        orderNumber: String(orderNode.name || "").replace("#", ""),
        customerName: String(shipping?.name || billing?.name || "Cliente").trim(),
        customerPhone: String(shipping?.phone || billing?.phone || "-").trim() || "-",
        pickupDate: getCourierScheduledDate(orderNode) || String(orderNode.createdAt || ""),
        pickupAddress: String(shipping?.address1 || "").trim(),
        pickupNeighborhood: String(shipping?.address2 || "").trim(),
        pickupCity: String(shipping?.city || "").trim(),
        pickupState: String(shipping?.province || "").trim(),
        pickupPostalCode: String(shipping?.zip || "").trim(),
        pickupCountry: String(shipping?.country || "Mexico").trim() || "Mexico",
        createdAt: orderNode.createdAt,
        updatedAt: orderNode.updatedAt || orderNode.createdAt,
        status: getCourierRouteStatusFromTags(orderNode.tags),
      };
    })
    .sort((a, b) => courierOrderTimestampMs(a) - courierOrderTimestampMs(b));
}

async function fetchCourierHistoryOrders(admin) {
  const response = await admin.graphql(
    `#graphql
    query CourierHistoryOrders {
      orders(first: 250, query: "updated_at:>=2026-06-10", sortKey: UPDATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            createdAt
            updatedAt
            displayFulfillmentStatus
            tags
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
            billingAddress {
              name
              phone
            }
            customAttributes {
              key
              value
            }
            shippingLines(first: 5) {
              nodes {
                title
                code
                deliveryCategory
              }
            }
          }
        }
      }
    }`,
  );
  const payload = await response.json();
  const errors = payload?.errors || [];
  if (errors.length) {
    throw new Error(errors[0]?.message || "No se pudo cargar el historial repartidor.");
  }

  const nodes = payload?.data?.orders?.edges?.map((edge) => edge?.node).filter(Boolean) || [];
  return nodes
    .filter(
      (orderNode) =>
        isCourierLocalDeliveryOrder(orderNode) &&
        getCourierRouteStatusFromTags(orderNode?.tags) === "entregado" &&
        new Date(orderNode.updatedAt || orderNode.createdAt).getTime() >= COURIER_HISTORY_SINCE.getTime(),
    )
    .map((orderNode) => {
      const shipping = orderNode.shippingAddress || null;
      const billing = orderNode.billingAddress || null;
      return {
        id: orderNode.id,
        orderNumber: String(orderNode.name || "").replace("#", ""),
        customerName: String(shipping?.name || billing?.name || "Cliente").trim(),
        customerPhone: String(shipping?.phone || billing?.phone || "-").trim() || "-",
        pickupDate: getCourierScheduledDate(orderNode) || String(orderNode.createdAt || ""),
        pickupAddress: String(shipping?.address1 || "").trim(),
        pickupNeighborhood: String(shipping?.address2 || "").trim(),
        pickupCity: String(shipping?.city || "").trim(),
        pickupState: String(shipping?.province || "").trim(),
        pickupPostalCode: String(shipping?.zip || "").trim(),
        pickupCountry: String(shipping?.country || "Mexico").trim() || "Mexico",
        createdAt: orderNode.createdAt,
        updatedAt: orderNode.updatedAt || orderNode.createdAt,
        status: "entregado",
      };
    });
}

async function fetchPickupCourierHistoryOrders(shop) {
  const requestRows = await prisma.returnRequest.findMany({
    where: {
      shop,
      OR: [
        {
          returnMethod: "pickup",
          status: { in: ["recibida", "rechazada"] },
          updatedAt: { gte: COURIER_HISTORY_SINCE },
        },
        {
          returnMethod: { not: "pickup" },
        },
        {
          status: { in: Array.from(BRANCH_PICKUP_STATUSES) },
        },
      ],
    },
    include: { items: true },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 1000,
  });

  return excludePickupRequestsSupersededByBranch(requestRows).map((requestRow) => ({
    id: `pickup-${requestRow.id}`,
    orderNumber: String(requestRow.orderNumber || "").replace("#", ""),
    customerName: String(requestRow.customerName || "Cliente").trim(),
    customerPhone: String(requestRow.customerPhone || "-").trim() || "-",
    pickupDate: String(requestRow.pickupDate || requestRow.createdAt || "").trim(),
    pickupAddress: String(requestRow.pickupAddress || "").trim(),
    pickupNeighborhood: String(requestRow.pickupNeighborhood || "").trim(),
    pickupCity: String(requestRow.pickupCity || "").trim(),
    pickupState: String(requestRow.pickupState || "").trim(),
    pickupPostalCode: String(requestRow.pickupPostalCode || "").trim(),
    pickupCountry: "Mexico",
    createdAt: requestRow.createdAt,
    updatedAt: requestRow.updatedAt,
    rejectionReason: requestRow.rejectionReason,
    status: String(requestRow.status || "").trim().toLowerCase(),
  }));
}

async function fetchPickupCourierOrders(shop) {
  const requestRows = await prisma.returnRequest.findMany({
    where: {
      shop,
      OR: [
        {
          returnMethod: "pickup",
          status: { in: Array.from(METHOD_QUEUE_STATUSES) },
        },
        {
          returnMethod: { not: "pickup" },
        },
        {
          status: { in: Array.from(BRANCH_PICKUP_STATUSES) },
        },
      ],
    },
    select: {
      id: true,
      shopifyOrderId: true,
      orderNumber: true,
      returnMethod: true,
      customerName: true,
      customerPhone: true,
      pickupDate: true,
      pickupAddress: true,
      pickupNeighborhood: true,
      pickupCity: true,
      pickupState: true,
      pickupPostalCode: true,
      createdAt: true,
      updatedAt: true,
      status: true,
      rejectionReason: true,
      items: {
        select: {
          lineItemId: true,
          productId: true,
          variantId: true,
          title: true,
          quantity: true,
        },
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 1000,
  });

  return excludePickupRequestsSupersededByBranch(requestRows)
    .map((requestRow) => ({
    id: `pickup-${requestRow.id}`,
    orderNumber: String(requestRow.orderNumber || "").replace("#", ""),
    customerName: String(requestRow.customerName || "Cliente").trim(),
    customerPhone: String(requestRow.customerPhone || "-").trim() || "-",
    pickupDate: String(requestRow.pickupDate || requestRow.createdAt || "").trim(),
    pickupAddress: String(requestRow.pickupAddress || "").trim(),
    pickupNeighborhood: String(requestRow.pickupNeighborhood || "").trim(),
    pickupCity: String(requestRow.pickupCity || "").trim(),
    pickupState: String(requestRow.pickupState || "").trim(),
    pickupPostalCode: String(requestRow.pickupPostalCode || "").trim(),
    pickupCountry: "Mexico",
    createdAt: requestRow.createdAt,
    updatedAt: requestRow.updatedAt,
    rejectionReason: requestRow.rejectionReason,
    status: String(requestRow.status || "pendiente").trim() || "pendiente",
    }))
    .sort((a, b) => courierOrderTimestampMs(a) - courierOrderTimestampMs(b));
}

function courierOrderTimestampMs(request) {
  const date =
    parseCourierDate(request?.pickupDate) ||
    parseCourierDate(request?.updatedAt) ||
    parseCourierDate(request?.createdAt);
  return date ? date.getTime() : 0;
}

function formatCourierScheduledDate(pickupDate) {
  const date = parseCourierDate(pickupDate);
  if (!date) return "-";

  const parts = new Intl.DateTimeFormat("es-MX", {
    weekday: "short",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = String(lookup.weekday || "").replace(/\./g, "").toLowerCase();
  const day = String(lookup.day || "").trim();
  const month = String(lookup.month || "").toLowerCase();
  const year = String(lookup.year || "").trim();
  return [weekday, day, month, year].filter(Boolean).join(" ");
}

function formatCourierAddress(request) {
  const parts = [
    request?.pickupAddress,
    request?.pickupNeighborhood,
    request?.pickupCity,
    request?.pickupState,
    request?.pickupPostalCode,
    request?.pickupCountry || "Mexico",
  ]
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(", ") : "-";
}

function historyTimestampMs(request) {
  const status = String(request?.status || "").toLowerCase();
  const sourceDate =
    status === "reembolsada" && request?.refundedAt ? request.refundedAt : request?.updatedAt || request?.createdAt;
  const ms = new Date(sourceDate).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export default function ReturnsRequests() {
  const {
    requests,
    courierOrders,
    couriers = [],
    courierActivities = [],
    courierRouteSnapshots = [],
    viewMode,
    shop,
  } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const location = useLocation();
  const isSubmitting = navigation.state === "submitting";

  const reviewRequests = requests.filter(
    (requestRow) => String(requestRow.status || "").toLowerCase() === "en_revision",
  );
  const activeRequests = requests.filter((requestRow) => {
    const status = String(requestRow.status || "").toLowerCase();
    return METHOD_QUEUE_STATUSES.has(status);
  });
  const refundQueueRequests = requests.filter((requestRow) =>
    REFUND_QUEUE_STATUSES.has(String(requestRow.status || "").toLowerCase()),
  );
  const returnToCustomerQueueRequests = requests.filter((requestRow) =>
    RETURN_TO_CUSTOMER_STATUSES.has(String(requestRow.status || "").toLowerCase()),
  );
  const pickupRequests = activeRequests.filter((request) => request.returnMethod === "pickup");
  const branchRequests = activeRequests.filter((request) => request.returnMethod !== "pickup");
  const historyRequests = requests
    .filter((requestRow) => HISTORY_STATUSES.has(String(requestRow.status || "").toLowerCase()))
    .sort((a, b) => historyTimestampMs(b) - historyTimestampMs(a));
  const pickupGroups = buildPickupGroups(pickupRequests);

  const pageHeading =
    viewMode === VIEW_MODE.PICKUP
      ? "Recoleccion a domicilio"
      : viewMode === VIEW_MODE.REVIEW
        ? "Ordenes en revision"
      : viewMode === VIEW_MODE.REFUNDS
          ? "Procesar reembolsos"
        : viewMode === VIEW_MODE.TO_RETURN
          ? "Devoluciones a devolver"
        : viewMode === VIEW_MODE.HISTORY
          ? "Historial"
        : viewMode === VIEW_MODE.COURIER
          ? "Ordenes repartidor"
        : viewMode === VIEW_MODE.COURIER_HISTORY
          ? "Historial repartidor"
        : viewMode === VIEW_MODE.BRANCH_PICKUP
          ? "Recoger en sucursal"
        : viewMode === VIEW_MODE.COURIERS
          ? "Repartidores"
        : "Entrega en sucursal";

  return (
    <s-page heading={pageHeading}>
      {actionData?.error ? <p className={styles.errorMsg}>{actionData.error}</p> : null}
      {actionData?.message ? <p className={styles.successMsg}>{actionData.message}</p> : null}

      {viewMode === VIEW_MODE.BRANCH ? (
        <s-section heading="Entregas en sucursal">
          {branchRequests.length === 0 ? (
            <p>No hay solicitudes de entrega en sucursal.</p>
          ) : (
            <div className={`${styles.wrap} ${styles.reqGrid}`}>
              {branchRequests.map((request) => (
                <RequestCard
                  key={request.id}
                  request={request}
                  isSubmitting={isSubmitting}
                  enableLazyMedia
                />
              ))}
            </div>
          )}
        </s-section>
      ) : null}

      {viewMode === VIEW_MODE.PICKUP ? (
        <s-section heading="Recolecciones a domicilio">
          {pickupGroups.length === 0 ? (
            <p>No hay solicitudes de recoleccion a domicilio.</p>
          ) : (
            <div className={`${styles.wrap} ${styles.reqGrid}`}>
              {pickupGroups.map((group) => (
                <div key={group.key} className={styles.card}>
                  <h3 className={styles.reqTitle}>
                    Ordenes de devolucion para recoger el {group.heading}
                  </h3>
                  <div className={styles.divider} />
                  <div className={styles.reqGrid}>
                    {group.requests.map((request) => (
                      <RequestCard
                        key={request.id}
                        request={request}
                        isSubmitting={isSubmitting}
                        enableLazyMedia
                        hideCourierProgress
                        hidePickupActions
                        showPickupRescheduleStatus
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </s-section>
      ) : null}

      {viewMode === VIEW_MODE.REVIEW ? (
        <s-section heading="Ordenes en revision">
          {reviewRequests.length === 0 ? (
            <p>No hay ordenes en revision.</p>
          ) : (
            <div className={`${styles.wrap} ${styles.reqGrid}`}>
              {reviewRequests.map((request) => (
                <RequestCard key={request.id} request={request} isSubmitting={isSubmitting} />
              ))}
            </div>
          )}
        </s-section>
      ) : null}

      {viewMode === VIEW_MODE.REFUNDS ? (
        <s-section heading="Solicitudes listas para procesar reembolsos">
          {refundQueueRequests.length === 0 ? (
            <p>No hay solicitudes listas para procesar reembolsos.</p>
          ) : (
            <div className={`${styles.wrap} ${styles.reqGrid}`}>
              {refundQueueRequests.map((request) => (
                <RequestCard key={request.id} request={request} isSubmitting={isSubmitting} />
              ))}
            </div>
          )}
        </s-section>
      ) : null}

      {viewMode === VIEW_MODE.TO_RETURN ? (
        <s-section heading="Solicitudes pendientes por recoger en sucursal">
          {returnToCustomerQueueRequests.length === 0 ? (
            <p>No hay solicitudes pendientes por recoger.</p>
          ) : (
            <div className={`${styles.wrap} ${styles.reqGrid}`}>
              {returnToCustomerQueueRequests.map((request) => (
                <RequestCard key={request.id} request={request} isSubmitting={isSubmitting} />
              ))}
            </div>
          )}
        </s-section>
      ) : null}

      {viewMode === VIEW_MODE.HISTORY ? (
        <>
          <s-section heading="Historial de devoluciones">
            {historyRequests.length === 0 ? (
              <p>No hay ordenes en historial.</p>
            ) : (
              <div className={`${styles.wrap} ${styles.reqGrid}`}>
                {historyRequests.map((request) => (
                  <RequestCard
                    key={request.id}
                    request={request}
                    isSubmitting={isSubmitting}
                    enableLazyMedia
                    hideCourierProgress
                  />
                ))}
              </div>
            )}
          </s-section>
        </>
      ) : null}

      {viewMode === VIEW_MODE.COURIER ? (
        <s-section heading="Ordenes repartidor">
          <div className={styles.courierOrdersHeader}>
            <span className={styles.courierOrdersCount}>Numero de ordenes: {courierOrders.length}</span>
          </div>
          {courierOrders.length === 0 ? (
            <p>No hay ordenes pendientes por entregar.</p>
          ) : (
            <div className={styles.courierGrid}>
              {courierOrders.map((request) => (
                <CourierOrderCard key={request.id} request={request} adminCourierView />
              ))}
            </div>
          )}
        </s-section>
      ) : null}

      {viewMode === VIEW_MODE.COURIER_HISTORY ? (
        <s-section heading="Historial repartidor">
          {courierOrders.length === 0 ? (
            <p>No hay ordenes finalizadas desde el 10 de junio de 2026.</p>
          ) : (
            <CourierHistoryDirectory
              couriers={couriers}
              activities={courierActivities}
              snapshots={courierRouteSnapshots}
              orders={courierOrders}
              search={location.search}
              shop={shop}
            />
          )}
        </s-section>
      ) : null}

      {viewMode === VIEW_MODE.BRANCH_PICKUP ? (
        <s-section heading="Recoger en sucursal">
          {courierOrders.length === 0 ? (
            <p>No hay ordenes para recoger en sucursal.</p>
          ) : (
            <div className={styles.courierGrid}>
              {courierOrders.map((request) => (
                <CourierOrderCard key={request.id} request={request} />
              ))}
            </div>
          )}
        </s-section>
      ) : null}

      {viewMode === VIEW_MODE.COURIERS ? (
        <CouriersSection couriers={couriers} isSubmitting={isSubmitting} />
      ) : null}
    </s-page>
  );
}

function mexicoActivityDateKey(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function CourierHistoryDirectory({ couriers, activities, snapshots = [], orders, search, shop }) {
  const orderByRequestId = new Map(orders.map((order) => [String(order.id || ""), order]));
  const searchParams = new URLSearchParams(search);
  const historyView = String(searchParams.get("historyView") || "").trim();
  const selectedCourierId = Number(searchParams.get("courierId") || 0);
  const selectedDate = String(searchParams.get("date") || "").trim();
  const selectedRouteId = String(searchParams.get("routeId") || "").trim();
  const baseHref = "/app/devoluciones/solicitudes/courier_history";
  const buildHistoryHref = ({ view = "", courierId = "", date = "", routeId = "" } = {}) => {
    const nextParams = new URLSearchParams(searchParams);
    if (!nextParams.get("shop") && shop) nextParams.set("shop", shop);
    if (view) nextParams.set("historyView", view);
    else nextParams.delete("historyView");
    if (courierId) nextParams.set("courierId", String(courierId));
    else nextParams.delete("courierId");
    if (date) nextParams.set("date", date);
    else nextParams.delete("date");
    if (routeId) nextParams.set("routeId", routeId);
    else nextParams.delete("routeId");
    return `${baseHref}?${nextParams.toString()}`;
  };

  if (historyView === "all") {
    return (
      <div className={styles.courierHistoryDirectoryList}>
        <Link className={styles.courierHistoryBackLink} to={buildHistoryHref()}>← Regresar</Link>
        <h3>Historial de todas las ordenes</h3>
        <div className={styles.courierGrid}>
          {orders.map((request) => (
            <CourierOrderCard key={request.id} request={request} showFinalAttemptBadge />
          ))}
        </div>
      </div>
    );
  }

  if (["courier", "courier_day"].includes(historyView) && selectedCourierId) {
    const courier = couriers.find((item) => Number(item.id) === selectedCourierId);
    const courierActivities = activities.filter((activity) => Number(activity.courierId) === selectedCourierId);
    const courierSnapshots = snapshots.filter((snapshot) => Number(snapshot.courierId) === selectedCourierId);
    const snapshotByRouteId = new Map(
      courierSnapshots.map((snapshot) => [String(snapshot.routeId || "").trim(), snapshot]),
    );
    const routeStarts = courierActivities.filter(
      (activity) => activity.action === "courier_route_started" && activity.routeId,
    );
    const routeOrderIdsByRouteId = new Map();
    for (const activity of courierActivities) {
      if (!activity.routeId || activity.action === "courier_route_started" || activity.action === "courier_route_finished") {
        continue;
      }
      const requestId = String(activity.requestId || "").trim();
      if (!requestId || !orderByRequestId.has(requestId)) continue;
      const current = routeOrderIdsByRouteId.get(activity.routeId) || new Set();
      current.add(requestId);
      routeOrderIdsByRouteId.set(activity.routeId, current);
    }
    const uniqueRouteHistoryBlocks = [];
    const routeHistorySignatures = new Set();
    for (const activity of routeStarts
      .filter((activity) => (routeOrderIdsByRouteId.get(activity.routeId)?.size || 0) > 0)
      .sort(
        (firstActivity, secondActivity) =>
          new Date(secondActivity.createdAt || "").getTime() -
          new Date(firstActivity.createdAt || "").getTime(),
      )) {
      const dateKey = mexicoActivityDateKey(activity.createdAt);
      const orderSignature = Array.from(routeOrderIdsByRouteId.get(activity.routeId) || [])
        .sort()
        .join("|");
      const routeSignature = `${dateKey}:${orderSignature}`;
      if (routeHistorySignatures.has(routeSignature)) continue;
      routeHistorySignatures.add(routeSignature);
      uniqueRouteHistoryBlocks.push(activity);
    }
    const snapshotRouteHistoryBlocks = courierSnapshots
      .filter((snapshot) => String(snapshot.routeId || "").trim() && Array.isArray(snapshot.orders) && snapshot.orders.length)
      .map((snapshot) => ({
        ...snapshot,
        createdAt: snapshot.finishedAt || snapshot.createdAt,
        isSnapshot: true,
      }));
    const routeHistoryBlocks = [
      ...snapshotRouteHistoryBlocks,
      ...uniqueRouteHistoryBlocks.filter((activity) => !snapshotByRouteId.has(String(activity.routeId || "").trim())),
    ].sort(
      (firstItem, secondItem) =>
        new Date(secondItem.createdAt || secondItem.finishedAt || "").getTime() -
        new Date(firstItem.createdAt || firstItem.finishedAt || "").getTime(),
    );
    const todayDateKey = mexicoActivityDateKey(new Date());
    const currentOrders = orders.filter((order) => !isCourierHistoryStatus(order.status));
    const todayActivityOrders = courierActivities
      .filter((activity) => mexicoActivityDateKey(activity.createdAt) === todayDateKey)
      .map((activity) => orderByRequestId.get(String(activity.requestId || "")))
      .filter(Boolean);
    const todayOrders = [
      ...new Map(
        [...currentOrders, ...todayActivityOrders].map((order) => [String(order.id || ""), order]),
      ).values(),
    ];
    const dates = [
      ...new Set([
        todayDateKey,
        ...courierSnapshots.map((snapshot) => snapshot.dateKey || mexicoActivityDateKey(snapshot.finishedAt)),
        ...courierActivities.map((activity) => mexicoActivityDateKey(activity.createdAt)),
      ]),
    ].filter(Boolean).sort().reverse();

    if (historyView === "courier_day" && selectedDate) {
      const selectedSnapshot = selectedRouteId ? snapshotByRouteId.get(selectedRouteId) : null;
      if (selectedSnapshot) {
        const selectedSnapshotOrders = (Array.isArray(selectedSnapshot.orders) ? selectedSnapshot.orders : [])
          .map((order, index) => {
            const id = String(order?.id || "");
            const sourceOrder = orderByRequestId.get(id) || {};
            const historyEvents = Array.isArray(order?.historyEvents) && order.historyEvents.length
              ? order.historyEvents
              : sourceOrder.historyEvents || [];
            return {
              ...sourceOrder,
              ...order,
              id,
              historyEvents,
              sequenceNumber: Number(order?.sequenceNumber || index + 1),
            };
          })
          .sort((firstOrder, secondOrder) => Number(firstOrder.sequenceNumber || 0) - Number(secondOrder.sequenceNumber || 0));
        const selectedDayLabel = new Intl.DateTimeFormat("es-MX", {
          dateStyle: "full",
          timeZone: "UTC",
        }).format(new Date(`${selectedDate}T12:00:00Z`));

        return (
          <div className={styles.courierHistoryDirectoryList}>
            <Link
              className={styles.courierHistoryBackLink}
              to={buildHistoryHref({ view: "courier", courierId: selectedCourierId })}
            >
              ← Regresar al calendario
            </Link>
            <div className={styles.courierHistoryHeader}>
              <div>
                <h3>{courier ? `Historial del repartidor ${courier.name}` : "Historial del repartidor"}</h3>
                <p className={styles.courierHistoryDateTitle}>{selectedDayLabel}</p>
              </div>
              <div className={styles.courierHistoryCounters}>
                <span className={styles.courierHistoryCounter}>Ordenes {selectedSnapshotOrders.length}</span>
                <span className={styles.courierHistoryCounter}>
                  Restantes {Number(selectedSnapshot.remainingCount || 0)}
                </span>
              </div>
            </div>
            {selectedSnapshotOrders.length ? (
              <div className={styles.courierGrid}>
                {selectedSnapshotOrders.map((order, index) => (
                  <CourierOrderCard
                    key={`${selectedSnapshot.routeId}:${order.id || index}`}
                    request={order}
                    sequenceNumber={Number(order.sequenceNumber || index + 1)}
                    showFinalAttemptBadge
                  />
                ))}
              </div>
            ) : (
              <p>No hay ordenes registradas para este dia.</p>
            )}
          </div>
        );
      }
      const currentOrderIds = new Set(currentOrders.map((order) => String(order.id || "")));
      const selectedDayActivities = courierActivities.filter((activity) => {
        if (mexicoActivityDateKey(activity.createdAt) !== selectedDate) return false;
        if (selectedRouteId) return activity.routeId === selectedRouteId;
        return !activity.routeId;
      });
      const latestFinalActivityByOrderId = new Map();
      const finalActivityAtByOrderId = new Map();
      for (const activity of [...selectedDayActivities].sort(
        (firstActivity, secondActivity) =>
          new Date(firstActivity.createdAt || "").getTime() -
          new Date(secondActivity.createdAt || "").getTime(),
      )) {
        const requestId = String(activity.requestId || "");
        if (!requestId) continue;
        if (isCourierFinalActivityAction(activity.action)) {
          latestFinalActivityByOrderId.set(requestId, activity);
          finalActivityAtByOrderId.set(requestId, new Date(activity.createdAt || "").getTime());
        }
      }
      const selectedActivityOrders = [
        ...new Map(
          selectedDayActivities
            .map((activity) => orderByRequestId.get(String(activity.requestId || "")))
            .filter(Boolean)
          .map((order) => [String(order.id || ""), order]),
        ).values(),
      ];
      const baseDayOrders = (!selectedRouteId && selectedDate === todayDateKey
        ? todayOrders
        : selectedActivityOrders
      ).sort(compareCourierDisplayOrder);
      const selectedDayOrders = [...baseDayOrders].sort((firstOrder, secondOrder) => {
        const firstId = String(firstOrder.id || "");
        const secondId = String(secondOrder.id || "");
        const firstIsFinalized = finalActivityAtByOrderId.has(firstId);
        const secondIsFinalized = finalActivityAtByOrderId.has(secondId);
        if (firstIsFinalized !== secondIsFinalized) return firstIsFinalized ? 1 : -1;
        if (!firstIsFinalized) return compareCourierDisplayOrder(firstOrder, secondOrder);

        const firstFinishedAt = finalActivityAtByOrderId.get(firstId) || 0;
        const secondFinishedAt = finalActivityAtByOrderId.get(secondId) || 0;
        if (firstFinishedAt !== secondFinishedAt) return firstFinishedAt - secondFinishedAt;
        return compareCourierDisplayOrder(firstOrder, secondOrder);
      });
      const sequenceByOrderId = new Map(
        [...baseDayOrders]
          .sort(compareCourierDisplayOrder)
          .map((order, index) => [String(order.id || ""), index + 1]),
      );
      const selectedDayLabel = new Intl.DateTimeFormat("es-MX", {
        dateStyle: "full",
        timeZone: "UTC",
      }).format(new Date(`${selectedDate}T12:00:00Z`));

      return (
        <div className={styles.courierHistoryDirectoryList}>
          <Link
            className={styles.courierHistoryBackLink}
            to={buildHistoryHref({ view: "courier", courierId: selectedCourierId })}
          >
            ← Regresar al calendario
          </Link>
          <div className={styles.courierHistoryHeader}>
            <div>
              <h3>{courier ? `Historial del repartidor ${courier.name}` : "Historial del repartidor"}</h3>
              <p className={styles.courierHistoryDateTitle}>{selectedDayLabel}</p>
            </div>
            <div className={styles.courierHistoryCounters}>
              <span className={styles.courierHistoryCounter}>Ordenes {selectedDayOrders.length}</span>
              <span className={styles.courierHistoryCounter}>Restantes {currentOrders.length}</span>
            </div>
          </div>
          {selectedDayOrders.length ? (
            <div className={styles.courierGrid}>
              {selectedDayOrders.map((order, index) => (
                <CourierOrderCard
                  key={order.id}
                  request={order}
                  sequenceNumber={sequenceByOrderId.get(String(order.id || "")) || index + 1}
                  statusOverride={
                    latestFinalActivityByOrderId.has(String(order.id || ""))
                      ? courierStatusFromActivityAction(
                          latestFinalActivityByOrderId.get(String(order.id || "")).action,
                          currentOrderIds.has(String(order.id || "")) && !isCourierRouteStatus(order.status)
                            ? "pendiente"
                            : order.status,
                        )
                      : currentOrderIds.has(String(order.id || "")) && !isCourierRouteStatus(order.status)
                        ? "pendiente"
                        : ""
                  }
                  showFinalAttemptBadge
                />
              ))}
            </div>
          ) : (
            <p>No hay ordenes registradas para este dia.</p>
          )}
        </div>
      );
    }

    return (
      <div className={styles.courierHistoryDirectoryList}>
        <Link className={styles.courierHistoryBackLink} to={buildHistoryHref()}>← Regresar</Link>
        <h3>{courier ? `Historial del repartidor ${courier.name}` : "Historial del repartidor"}</h3>
        {dates.length || routeHistoryBlocks.length ? (
          <div className={styles.courierCalendar}>
            {routeHistoryBlocks.map((activity) => {
              const dateKey = activity.dateKey || mexicoActivityDateKey(activity.createdAt || activity.finishedAt);
              return (
                <Link
                  key={`${activity.isSnapshot ? "snapshot" : "activity"}:${activity.routeId}`}
                  className={styles.courierCalendarDay}
                  to={buildHistoryHref({
                    view: "courier_day",
                    courierId: selectedCourierId,
                    date: dateKey,
                    routeId: activity.routeId,
                  })}
                >
                  {new Intl.DateTimeFormat("es-MX", { dateStyle: "full", timeZone: "UTC" }).format(new Date(`${dateKey}T12:00:00Z`))}
                </Link>
              );
            })}
            {dates.map((dateKey) => {
              const hasLegacyActivities = courierActivities.some(
                (activity) => !activity.routeId && mexicoActivityDateKey(activity.createdAt) === dateKey,
              );
              if (!hasLegacyActivities && routeHistoryBlocks.some((activity) => mexicoActivityDateKey(activity.createdAt) === dateKey)) return null;
              return (
                <Link
                  key={dateKey}
                  className={styles.courierCalendarDay}
                  to={buildHistoryHref({
                    view: "courier_day",
                    courierId: selectedCourierId,
                    date: dateKey,
                  })}
                >
                  {new Intl.DateTimeFormat("es-MX", { dateStyle: "full", timeZone: "UTC" }).format(new Date(`${dateKey}T12:00:00Z`))}
                </Link>
              );
            })}
          </div>
        ) : (
          <p>No hay actividad registrada para este repartidor.</p>
        )}
      </div>
    );
  }

  return (
    <div className={styles.courierHistoryDirectoryList}>
      {couriers.map((courier) => {
        return (
          <Link
            key={courier.id}
            className={`${styles.btn} ${styles.courierHistoryDirectorySummary}`}
            to={buildHistoryHref({ view: "courier", courierId: courier.id })}
          >
              Historial del repartidor {courier.name}
          </Link>
        );
      })}
      <Link
        className={`${styles.btn} ${styles.btnPrimary} ${styles.courierHistoryDirectorySummary}`}
        to={buildHistoryHref({ view: "all" })}
      >
          Historial de todas las ordenes
      </Link>
    </div>
  );
}

function CouriersSection({ couriers, isSubmitting }) {
  const [showForm, setShowForm] = useState(false);
  const [code, setCode] = useState("");

  const generateCode = () => {
    setCode(String(Math.floor(100000 + Math.random() * 900000)));
  };

  return (
    <s-section heading="Repartidores">
      <div className={`${styles.wrap} ${styles.couriersLayout}`}>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          type="button"
          onClick={() => setShowForm((current) => !current)}
        >
          Agregar repartidor
        </button>

        {showForm ? (
          <Form method="post" className={`${styles.card} ${styles.courierCreateForm}`}>
            <input type="hidden" name="intent" value="create_courier" />
            <label className={styles.label}>
              Nombre del repartidor
              <input className={styles.input} name="name" required />
            </label>
            <div className={styles.courierCodeField}>
              <label className={styles.label}>
                Codigo unico
                <input
                  className={styles.input}
                  name="code"
                  value={code}
                  readOnly
                  required
                  placeholder="Genera un codigo de 6 digitos"
                />
              </label>
              <button className={styles.btn} type="button" onClick={generateCode}>
                Generar codigo
              </button>
            </div>
            <button
              className={`${styles.btn} ${styles.btnPrimary}`}
              type="submit"
              disabled={isSubmitting || !code}
            >
              Guardar
            </button>
          </Form>
        ) : null}

        <div className={styles.courierDirectory}>
          {couriers.map((courier) => (
            <details key={courier.id} className={styles.courierDirectoryCard}>
              <summary className={styles.courierDirectorySummary}>
                <span>Repartidor</span>
                <strong>{courier.name}</strong>
              </summary>
              <div className={styles.courierDirectoryCode}>
                <div>Codigo unico: <strong>{courier.code}</strong></div>
                <Form
                  method="post"
                  onSubmit={(event) => {
                    if (!window.confirm(`¿Deseas dar de baja a ${courier.name}?`)) {
                      event.preventDefault();
                    }
                  }}
                >
                  <input type="hidden" name="intent" value="delete_courier" />
                  <input type="hidden" name="courierId" value={courier.id} />
                  <button className={`${styles.btn} ${styles.btnDanger}`} type="submit" disabled={isSubmitting}>
                    Dar de baja
                  </button>
                </Form>
              </div>
            </details>
          ))}
        </div>
      </div>
    </s-section>
  );
}

function CourierOrderCard({
  request,
  sequenceNumber = 0,
  statusOverride = "",
  showFinalAttemptBadge = false,
  adminCourierView = false,
}) {
  const finalAttempt = courierAttemptFromHistoryEvents(request.historyEvents, request.attemptCount);
  const visibleStatus = statusOverride || request.status;
  const normalizedVisibleStatus = String(visibleStatus || "").trim().toLowerCase();
  const isAdminReprogrammed =
    adminCourierView && ["no_entregado", "no_recibido"].includes(normalizedVisibleStatus);
  const displayStatus = isAdminReprogrammed ? "reprogramado" : visibleStatus;
  const adminCourierPresentation = adminCourierView
    ? buildAdminCourierPresentation(request)
    : { events: request.historyEvents || [], scheduledDate: null };
  const displayHistoryEvents = adminCourierPresentation.events;
  const displayedScheduledDate = adminCourierPresentation.scheduledDate || request.pickupDate;
  const attemptBadgeClass = ["no_entregado", "rechazada", "no_recibido"].includes(normalizedVisibleStatus)
    ? normalizedVisibleStatus === "rechazada"
      ? styles.courierBadgeAttemptWarning
      : styles.courierBadgeStatusFailed
    : styles.courierBadgeAttempt;
  const statusBadgeClass = isAdminReprogrammed
    ? styles.courierBadgeStatusReprogrammed
    : ["no_entregado", "rechazada", "no_recibido"].includes(normalizedVisibleStatus)
      ? styles.courierBadgeStatusFailed
    : ["entregado", "recibido", "recibida"].includes(normalizedVisibleStatus)
      ? styles.courierBadgeStatusSuccess
      : normalizedVisibleStatus.startsWith("en_ruta")
        ? styles.courierBadgeStatusRoute
        : "";
  return (
    <article
      className={`${styles.courierCard} ${
        request.courierLabel === "Devolución" ? styles.courierCardReturn : styles.courierCardDelivery
      }`}
    >
      <div className={styles.courierHeader}>
        <div className={styles.courierOrderBadgeGroup}>
          {sequenceNumber > 0 ? (
            <span className={styles.courierOrderSequence}>{sequenceNumber}</span>
          ) : null}
          <span
            className={
              request.courierLabel === "Devolución"
                ? styles.courierBadgeReturn
                : styles.courierBadgeDelivery
            }
          >
            {request.courierLabel}
          </span>
        </div>
        <div className={styles.courierStatusGroup}>
          {showFinalAttemptBadge && finalAttempt > 0 ? (
            <span className={`${styles.courierBadgeStatus} ${attemptBadgeClass}`}>
              {courierAttemptCountLabel(finalAttempt)}
            </span>
          ) : null}
          <span className={`${styles.courierBadgeStatus} ${statusBadgeClass}`}>
            {isAdminReprogrammed ? displayStatus : courierHistoryStatusLabel(displayStatus)}
          </span>
        </div>
      </div>
      <h3 className={styles.courierOrderNumber}>#{request.orderNumber}</h3>
      <p className={styles.courierCustomerName}>{request.customerName}</p>
      <p className={styles.courierField}>
        <strong>Programado:</strong> {formatCourierScheduledDate(displayedScheduledDate)}
      </p>
      <p className={styles.courierAddress}>{formatCourierAddress(request)}</p>
      <p className={styles.courierField}>{request.customerPhone || "-"}</p>
      <details className={styles.courierHistoryDetails}>
        <summary className={styles.courierHistorySummary}>Ver más ↓</summary>
        <div className={styles.courierHistoryList}>
          {displayHistoryEvents.length ? (
            displayHistoryEvents.map((event) => (
              <div key={event.id} className={styles.courierHistoryItem}>
                <strong>{event.label}</strong>
                <span>{formatCourierHistoryDate(event.at)}</span>
              </div>
            ))
          ) : (
            <div className={styles.courierHistoryItem}>
              <strong>Sin acciones registradas todavía</strong>
            </div>
          )}
        </div>
      </details>
    </article>
  );
}

function RequestCard({
  request,
  isSubmitting,
  enableLazyMedia = false,
  hideCourierProgress = false,
  hidePickupActions = false,
  showPickupRescheduleStatus = false,
}) {
  const [viewerImage, setViewerImage] = useState(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [mediaRequested, setMediaRequested] = useState(false);
  const [lazyMediaByItemId, setLazyMediaByItemId] = useState({});
  const [pickupAttemptReason, setPickupAttemptReason] = useState("");
  const [isPickupReasonModalOpen, setIsPickupReasonModalOpen] = useState(false);
  const [rejectAfterFailedReason, setRejectAfterFailedReason] = useState("");
  const [isRejectAfterFailedReasonModalOpen, setIsRejectAfterFailedReasonModalOpen] = useState(false);
  const mediaFetcher = useFetcher();
  const location = useLocation();
  const currentFormAction = `${location.pathname}${location.search}`;
  const timelineEvents = detailsOpen ? buildStatusTimeline(request, hideCourierProgress) : [];
  const currentTimelineEvent = timelineEvents[0] || null;
  const olderTimelineEvents = timelineEvents.slice(1);
  const internalStatus = String(request.status || "").toLowerCase();
  const status = internalStatus === "en_ruta" || internalStatus.startsWith("en_ruta_") ? "aprobada" : internalStatus;
  const isPickupMethod = request.returnMethod === "pickup";
  const isPickupFailedAttempt = isPickupFailedAttemptStatus(status);
  const canMarkInRoute = isPickupMethod && status === "aprobada";
  const canMarkReceived = status === "aprobada" || status === "en_ruta" || isPickupFailedAttempt;
  const canMarkNeverArrived =
    !isPickupMethod && status === "aprobada" && Boolean(request.isBranchDeliveryDeadlineExpired);
  const canRegisterPickupFailedAttempt =
    isPickupMethod && (status === "aprobada" || status === "en_ruta" || status === "intento_fallido_1");
  const canRejectAfterFailedPickups = isPickupMethod && status === "intento_fallido_2";
  const canMarkReturnedToCustomer = status === "por_devolver";
  const canMarkNotReturned = status === "por_devolver" && Boolean(request.isPickupDeadlineExpired);
  const remainingPickupAttempts = status === "aprobada" ? 2 : status === "intento_fallido_1" ? 1 : 0;
  const failedAttemptButtonLabel =
    remainingPickupAttempts === 1
      ? "Intento de recoleccion fallido (te queda 1)"
      : `Intento de recoleccion fallido (te quedan ${remainingPickupAttempts})`;
  const statusClassName = styles[getStatusClassName(status)];
  const pickupRescheduleAttempt = showPickupRescheduleStatus ? pickupRescheduleAttemptLabel(status) : "";
  const isDeniedReturnedToCustomer = status === "reembolso_denegado" && request.wasReturnedToCustomer;
  const isHistoryStatus = HISTORY_STATUSES.has(status);
  const closedAt =
    status === "reembolsada" && request.refundedAt ? request.refundedAt : request.updatedAt || null;
  const renderedItems = request.items.map((item) => {
    const lazyMedia = lazyMediaByItemId[item.id] || {};
    return {
      ...item,
      imageUrl: lazyMedia.imageUrl || item.imageUrl || "",
      imageAlt: lazyMedia.imageAlt || item.imageAlt || "",
      variantSummary: lazyMedia.variantSummary || item.variantSummary || "",
      photoDataUrl: lazyMedia.photoDataUrl || item.photoDataUrl || "",
    };
  });

  useEffect(() => {
    if (!enableLazyMedia || !detailsOpen || mediaRequested) return;
    const hasMissingMedia = request.items.some((item) => !item.imageUrl || !item.photoDataUrl);
    if (!hasMissingMedia) return;
    const payload = new FormData();
    payload.set("intent", "load_request_media");
    payload.set("id", String(request.id));
    mediaFetcher.submit(payload, { method: "post" });
    setMediaRequested(true);
  }, [detailsOpen, enableLazyMedia, mediaFetcher, mediaRequested, request.id, request.items]);

  useEffect(() => {
    if (!mediaFetcher.data?.ok || mediaFetcher.data?.intent !== "load_request_media") return;
    const items = Array.isArray(mediaFetcher.data.mediaItems) ? mediaFetcher.data.mediaItems : [];
    const nextMediaById = {};
    for (const item of items) {
      nextMediaById[item.id] = {
        imageUrl: item.imageUrl || "",
        imageAlt: item.imageAlt || "",
        variantSummary: item.variantSummary || "",
        photoDataUrl: item.photoDataUrl || "",
      };
    }
    setLazyMediaByItemId(nextMediaById);
  }, [mediaFetcher.data]);

  useEffect(() => {
    // After submitting a failed-pickup attempt, request status/updatedAt changes.
    // Reset the field so the next attempt starts with a clean message.
    setPickupAttemptReason("");
    setIsPickupReasonModalOpen(false);
  }, [request.status, request.updatedAt, request.id]);

  return (
    <article className={styles.card}>
      <div className={styles.reqHeader}>
        <div>
          <h3 className={styles.reqTitle}>Pedido #{request.orderNumber}</h3>
          <p className={styles.meta}>
            {request.customerName} | {request.customerEmail} | {request.customerPhone || "-"}
          </p>
        </div>
        <span className={styles.pill}>
          Estado:{" "}
          <strong className={statusClassName}>
            {isDeniedReturnedToCustomer ? (
              <>
                reembolso denegado - <span className={styles.returnedToCustomerStatus}>devuelto al cliente</span>
              </>
            ) : pickupRescheduleAttempt ? (
              <>reprogramado · {pickupRescheduleAttempt}</>
            ) : (
              STATUS_LABEL[status] || status
            )}
          </strong>
        </span>
      </div>

      <details className={styles.details} onToggle={(event) => setDetailsOpen(event.currentTarget.open)}>
        <summary className={styles.summary}>Ver orden</summary>
        {detailsOpen ? (
          <>

        <div className={styles.kv}>
          <div className={styles.kvRow}>
            <span className={styles.kvKey}>Metodo</span>
            <span className={styles.kvVal}>
              {request.returnMethod === "pickup" ? "Recoleccion a domicilio" : "Entrega en sucursal"}
            </span>
          </div>
          <div className={styles.kvRow}>
            <span className={styles.kvKey}>Subtotal (sin impuestos)</span>
            <span className={styles.kvVal}>${toMoney(request.refundedSubtotal || request.estimatedRefund)} MXN</span>
          </div>
          <div className={styles.kvRow}>
            <span className={styles.kvKey}>Costo devolucion</span>
            <span className={styles.kvVal}>${toMoney(request.returnCost)} MXN</span>
          </div>
          <div className={styles.kvRow}>
            <span className={styles.kvKey}>Reembolso final</span>
            <span className={styles.kvVal}>${toMoney(request.finalRefund)} MXN</span>
          </div>
          <div className={styles.kvRow}>
            <span className={styles.kvKey}>Fecha solicitud</span>
            <span className={styles.kvVal}>{new Date(request.createdAt).toLocaleString("es-MX")}</span>
          </div>
          {!isPickupMethod && request.branchDeliveryDeadlineAt ? (
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Fecha limite de entrega</span>
              <span className={styles.kvVal}>{new Date(request.branchDeliveryDeadlineAt).toLocaleDateString("es-MX")}</span>
            </div>
          ) : null}
          {isHistoryStatus && closedAt ? (
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Fecha de cierre</span>
              <span className={styles.kvVal}>{new Date(closedAt).toLocaleString("es-MX")}</span>
            </div>
          ) : null}
          {request.receivedAt ? (
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Recibida</span>
              <span className={styles.kvVal}>{new Date(request.receivedAt).toLocaleString("es-MX")}</span>
            </div>
          ) : null}
          {request.returnedToCustomerAt ? (
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Devuelta al cliente</span>
              <span className={styles.kvVal}>{new Date(request.returnedToCustomerAt).toLocaleString("es-MX")}</span>
            </div>
          ) : null}
          {request.refundedAt ? (
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Reembolsada</span>
              <span className={styles.kvVal}>{new Date(request.refundedAt).toLocaleString("es-MX")}</span>
            </div>
          ) : null}
          {request.pickupDeadlineAt ? (
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Fecha limite para recoger</span>
              <span className={styles.kvVal}>{new Date(request.pickupDeadlineAt).toLocaleString("es-MX")}</span>
            </div>
          ) : null}
        </div>

        {currentTimelineEvent ? (
          <div className={styles.statusTimelineCurrent}>
            <p className={styles.statusTimelineTitle}>Estado actual</p>
            <p className={styles.statusTimelineCurrentLine}>
              <strong className={timelineToneClassName(currentTimelineEvent.tone)}>{currentTimelineEvent.label}</strong>{" "}
              <span>{new Date(currentTimelineEvent.at).toLocaleString("es-MX")}</span>
            </p>
            {currentTimelineEvent.note ? (
              <p className={styles.statusTimelineItemNote}>{currentTimelineEvent.note}</p>
            ) : null}
          </div>
        ) : null}
        {olderTimelineEvents.length ? (
          <div className={styles.statusTimelineList}>
            {olderTimelineEvents.map((event) => (
              <div key={event.id} className={styles.statusTimelineItem}>
                <p className={`${styles.statusTimelineItemTitle} ${timelineToneClassName(event.tone)}`}>{event.label}</p>
                <p className={styles.statusTimelineItemAt}>{new Date(event.at).toLocaleString("es-MX")}</p>
                {event.note ? <p className={styles.statusTimelineItemNote}>{event.note}</p> : null}
              </div>
            ))}
          </div>
        ) : null}

        {request.returnMethod === "pickup" ? (
          <p className={styles.meta}>
            Recoleccion:{" "}
            {[request.pickupAddress, request.pickupCity, request.pickupState, request.pickupPostalCode]
              .filter(Boolean)
              .join(", ") || "-"}
            {" | "}Dia: {request.pickupDate || "-"}
            {request.pickupNotes ? ` | Notas: ${request.pickupNotes}` : ""}
          </p>
        ) : (
          <p className={styles.meta}>
            Sucursal: {request.branchAddress || "-"} | Horarios: {request.branchHours || "-"}
          </p>
        )}

        {(!timelineEvents.length && request.reasonEntries?.length) ? (
          <div className={styles.reasonHistory}>
            <p className={styles.reasonHistoryTitle}>Historial de motivos enviados</p>
            <ul className={styles.reasonHistoryList}>
              {request.reasonEntries.map((entry, idx) => (
                <li key={`${request.id}_reason_${idx}`} className={styles.reasonHistoryItem}>
                  <strong>{reasonEntryLabel(entry)}:</strong>{" "}
                  <span className={styles.reasonHistoryMessage}>{entry.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {request.refundError ? (
          <p className={styles.errorMsg}>Error de reembolso: {request.refundError}</p>
        ) : null}
        {request.shopifyRefundId ? (
          <p className={styles.successMsg}>Refund ID: {request.shopifyRefundId}</p>
        ) : null}

        {detailsOpen && enableLazyMedia && mediaFetcher.state !== "idle" ? (
          <p className={styles.meta}>Cargando imagenes...</p>
        ) : null}

        <h4 className={styles.orderDetailTitle}>Productos, motivos, fotos y descripcion</h4>
        <ul className={styles.productList}>
          {renderedItems.map((item) => {
            const photos = parsePhotoUrls(item.photoDataUrl);
            return (
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
                      <img
                        src={item.imageUrl}
                        alt={item.imageAlt || item.title}
                        className={styles.productThumb}
                        loading="lazy"
                        decoding="async"
                      />
                    </button>
                  ) : (
                    <div className={styles.productThumbPlaceholder} />
                  )}
                  <div className={styles.productCopy}>
                    <p className={styles.productLineTitle}>
                      {item.title} x{item.quantity}
                    </p>
                    {item.variantSummary ? <p className={styles.productLineMeta}>Variante: {item.variantSummary}</p> : null}
                    <p className={styles.productLineMeta}>Motivo: {item.reason}</p>
                  </div>
                </div>
                {item.details ? <p className={styles.productLineMeta}>Descripcion: {item.details}</p> : null}
                {photos.length ? (
                  <div className={styles.evidencePhotos}>
                    {photos.map((src, idx) => (
                      <button
                        key={`${itemKeyFromRecord(item)}_${idx}`}
                        type="button"
                        className={styles.evidenceLink}
                        onClick={() =>
                          setViewerImage({
                            src,
                            alt: `Evidencia ${idx + 1}`,
                          })
                        }
                      >
                        <img
                          src={src}
                          alt={`Evidencia ${idx + 1}`}
                          className={styles.evidencePhoto}
                          loading="lazy"
                          decoding="async"
                        />
                        <span>Foto {idx + 1}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
          </>
        ) : null}
      </details>

      {status === "por_devolver" && request.pickupDeadlineAt ? (
        <p className={styles.meta}>
          Fecha limite para recoger en sucursal: {new Date(request.pickupDeadlineAt).toLocaleString("es-MX")}
        </p>
      ) : null}

      <div className={styles.actionRow}>
        {status === "en_revision" ? (
          <>
            <Form method="post" action={currentFormAction}>
              <input type="hidden" name="intent" value="approve_request" />
              <input type="hidden" name="id" value={request.id} />
              <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={isSubmitting}>
                Aprobar
              </button>
            </Form>
            <Form method="post" action={currentFormAction} className={styles.rejectForm}>
              <input type="hidden" name="intent" value="reject_request" />
              <input type="hidden" name="id" value={request.id} />
              <input
                className={styles.input}
                name="rejectionReason"
                placeholder="Motivo de rechazo (obligatorio)"
                defaultValue=""
              />
              <button className={`${styles.btn} ${styles.btnDanger}`} type="submit" disabled={isSubmitting}>
                Rechazar
              </button>
            </Form>
          </>
        ) : null}

        {canMarkInRoute ? (
          <Form method="post" action={currentFormAction}>
            <input type="hidden" name="intent" value="mark_in_route" />
            <input type="hidden" name="id" value={request.id} />
            <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={isSubmitting}>
              En ruta
            </button>
          </Form>
        ) : null}

        {canMarkReceived && !hidePickupActions ? (
          <Form method="post" action={currentFormAction}>
            <input type="hidden" name="intent" value="mark_received" />
            <input type="hidden" name="id" value={request.id} />
            <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={isSubmitting}>
              Marcar como recibida
            </button>
          </Form>
        ) : null}

        {canMarkNeverArrived ? (
          <Form method="post" action={currentFormAction} className={styles.actionRight}>
            <input type="hidden" name="intent" value="mark_never_arrived" />
            <input type="hidden" name="id" value={request.id} />
            <button className={`${styles.btn} ${styles.btnDanger}`} type="submit" disabled={isSubmitting}>
              Nunca llego
            </button>
          </Form>
        ) : null}
        {canRegisterPickupFailedAttempt && !hidePickupActions ? (
          <>
            <Form
              key={`pickup-attempt-${request.id}-${new Date(request.updatedAt).toISOString()}`}
              method="post" action={currentFormAction}
              className={styles.rejectForm}
            >
              <input type="hidden" name="intent" value="pickup_attempt_failed" />
              <input type="hidden" name="id" value={request.id} />
              <div className={styles.quickReasonActions}>
                <button
                  className={`${styles.btn} ${styles.quickReasonBtn} ${styles.quickReasonOpenBtn}`}
                  type="button"
                  onClick={() => setIsPickupReasonModalOpen(true)}
                  disabled={isSubmitting}
                >
                  Elegir mensaje
                </button>
              </div>
              <textarea
                className={styles.textarea}
                name="rejectionReason"
                placeholder="Descripcion del intento fallido (obligatoria)"
                value={pickupAttemptReason}
                onChange={(event) => setPickupAttemptReason(event.target.value)}
              />
              <button className={`${styles.btn} ${styles.btnWarning}`} type="submit" disabled={isSubmitting}>
                {failedAttemptButtonLabel}
              </button>
            </Form>

            {isPickupReasonModalOpen ? (
              <div className={styles.reasonModalOverlay} role="dialog" aria-modal="true" aria-label="Seleccion de mensaje">
                <div className={styles.reasonModal}>
                  <p className={styles.reasonModalTitle}>Selecciona un mensaje completo</p>
                  {PICKUP_FAILED_REASON_OPTIONS.map((option, index) => (
                    <button
                      key={`pickup_reason_${index}`}
                      type="button"
                      className={styles.reasonOptionCard}
                      onClick={() => {
                        setPickupAttemptReason(option);
                        setIsPickupReasonModalOpen(false);
                      }}
                      disabled={isSubmitting}
                    >
                      <span className={styles.reasonOptionLabel}>Mensaje automatico {index + 1}</span>
                      <span className={styles.reasonOptionText}>{option}</span>
                    </button>
                  ))}
                  <div className={styles.reasonModalActions}>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.quickReasonBtn}`}
                      onClick={() => setIsPickupReasonModalOpen(false)}
                    >
                      Cerrar
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {canRejectAfterFailedPickups && !hidePickupActions ? (
          <>
            <Form method="post" action={currentFormAction} className={styles.rejectForm}>
              <input type="hidden" name="intent" value="reject_after_failed_pickups" />
              <input type="hidden" name="id" value={request.id} />
              <div className={styles.quickReasonActions}>
                <button
                  className={`${styles.btn} ${styles.quickReasonBtn}`}
                  type="button"
                  onClick={() => setIsRejectAfterFailedReasonModalOpen(true)}
                  disabled={isSubmitting}
                >
                  Usar mensaje automatico
                </button>
              </div>
              <textarea
                className={styles.textarea}
                name="rejectionReason"
                placeholder="Motivo de rechazo (obligatorio)"
                value={rejectAfterFailedReason}
                onChange={(event) => setRejectAfterFailedReason(event.target.value)}
              />
              <button className={`${styles.btn} ${styles.btnDanger}`} type="submit" disabled={isSubmitting}>
                Rechazar devolucion
              </button>
            </Form>

            {isRejectAfterFailedReasonModalOpen ? (
              <div className={styles.reasonModalOverlay} role="dialog" aria-modal="true" aria-label="Seleccion de motivo de rechazo">
                <div className={styles.reasonModal}>
                  <p className={styles.reasonModalTitle}>Selecciona un mensaje completo</p>
                  {REJECT_AFTER_FAILED_REASON_OPTIONS.map((option, index) => (
                    <button
                      key={`reject_after_failed_reason_${index}`}
                      type="button"
                      className={styles.reasonOptionCard}
                      onClick={() => {
                        setRejectAfterFailedReason(option);
                        setIsRejectAfterFailedReasonModalOpen(false);
                      }}
                      disabled={isSubmitting}
                    >
                      <span className={styles.reasonOptionLabel}>Mensaje automatico {index + 1}</span>
                      <span className={styles.reasonOptionText}>{option}</span>
                    </button>
                  ))}
                  <div className={styles.reasonModalActions}>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.quickReasonBtn}`}
                      onClick={() => setIsRejectAfterFailedReasonModalOpen(false)}
                    >
                      Cerrar
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {status === "recibida" ? (
          <>
            <Form method="post" action={currentFormAction}>
              <input type="hidden" name="intent" value="process_refund" />
              <input type="hidden" name="id" value={request.id} />
              <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={isSubmitting}>
                Procesar reembolso
              </button>
            </Form>
            <Form method="post" action={currentFormAction} className={styles.rejectForm}>
              <input type="hidden" name="intent" value="deny_received" />
              <input type="hidden" name="id" value={request.id} />
              <input
                className={styles.input}
                name="rejectionReason"
                placeholder="Motivo de denegacion (obligatorio)"
                defaultValue=""
              />
              <button className={`${styles.btn} ${styles.btnDanger}`} type="submit" disabled={isSubmitting}>
                Denegar devolucion
              </button>
            </Form>
          </>
        ) : null}

        {canMarkReturnedToCustomer ? (
          <Form method="post" action={currentFormAction}>
            <input type="hidden" name="intent" value="mark_returned_to_customer" />
            <input type="hidden" name="id" value={request.id} />
            <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={isSubmitting}>
              Devuelto con exito
            </button>
          </Form>
        ) : null}

        {canMarkNotReturned ? (
          <Form method="post" action={currentFormAction}>
            <input type="hidden" name="intent" value="mark_not_returned" />
            <input type="hidden" name="id" value={request.id} />
            <button className={`${styles.btn} ${styles.btnDanger}`} type="submit" disabled={isSubmitting}>
              No devuelto
            </button>
          </Form>
        ) : null}
      </div>

      <ImageViewer image={viewerImage} onClose={() => setViewerImage(null)} />
    </article>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);

