/* eslint-disable react/prop-types */
import { useEffect, useState } from "react";
import { Form, useActionData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import styles from "../styles/admin.module.css";

const STATUS_LABEL = {
  pendiente: "pendiente",
  en_revision: "en revision",
  aprobada: "aprobada",
  en_ruta: "en ruta",
  reintento_pendiente: "reprogramado",
  intento_fallido_1: "intento de devolucion fallido",
  intento_fallido_2: "segundo intento de devolucion fallido",
  por_devolver: "pendiente por devolver",
  no_devuelto: "no devuelto",
  rechazada: "rechazada",
  denegada: "reembolso denegado",
  reembolso_denegado: "reembolso denegado",
  recibida: "recibida",
  reembolsada: "reembolsada",
  completada: "completada",
};

const HISTORY_STATUSES = new Set(["reembolsada", "rechazada", "denegada", "reembolso_denegado", "no_devuelto"]);
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
const RETURNED_TO_CUSTOMER_MESSAGE = "Te regresamos tu devolución con éxito en nuestra sucursal. Agradecemos tu comprensión.";
const PICKUP_DEADLINE_DAYS = 30;

function normalizeOrderNumber(value) {
  return String(value || "")
    .trim()
    .replace(/^#/, "");
}

function toMoney(value) {
  return Number(value || 0).toFixed(2);
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
    return "Producto recibido. 📦 Hemos recibido tu devolución y nuestro equipo ya se encuentra revisando tu producto. Una vez finalizado el proceso de verificación, realizaremos tu reembolso correspondiente. 💰 Regresa mas tarde para ver el estado de tu devolucion.";
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

function latestReasonFromRaw(rawValue) {
  const entries = parseReasonEntries(rawValue);
  for (let idx = entries.length - 1; idx >= 0; idx -= 1) {
    if (isSystemProgressEntry(entries[idx])) continue;
    return entries[idx]?.reason || "";
  }
  return "";
}

function latestReturnedToCustomerAtFromRaw(rawValue) {
  const entries = parseReasonEntries(rawValue);
  for (let idx = entries.length - 1; idx >= 0; idx -= 1) {
    if (!isReturnedToCustomerEntry(entries[idx])) continue;
    return String(entries[idx]?.at || "").trim();
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

function formatReturnRescheduleDate(rawValue) {
  const text = String(rawValue || "").trim();
  const slashMatch = text.match(/^(\d{1,2})\/([^/]+)\/(\d{4})$/);
  if (slashMatch) {
    const month = slashMatch[2].trim();
    const capitalizedMonth = month ? `${month.charAt(0).toUpperCase()}${month.slice(1)}` : "";
    return `${slashMatch[1]}/${capitalizedMonth}/${slashMatch[3]}`;
  }
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!isoMatch) return text;
  const date = new Date(Date.UTC(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3])));
  const parts = new Intl.DateTimeFormat("es-MX", {
    timeZone: "UTC",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const month = String(values.month || "").trim();
  const capitalizedMonth = month ? `${month.charAt(0).toUpperCase()}${month.slice(1)}` : "";
  return `${values.day}/${capitalizedMonth}/${values.year}`;
}

function formatRefundQueueDate(rawValue) {
  const isoDateMatch = String(rawValue || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDateMatch) {
    const date = new Date(
      Date.UTC(Number(isoDateMatch[1]), Number(isoDateMatch[2]) - 1, Number(isoDateMatch[3]), 12),
    );
    const parts = new Intl.DateTimeFormat("es-MX", {
      timeZone: "UTC",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.day}/${String(values.month || "").toLowerCase()}/${values.year}`;
  }
  const date = new Date(rawValue);
  if (!Number.isFinite(date.getTime())) return "-";
  const parts = new Intl.DateTimeFormat("es-MX", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.day}/${String(values.month || "").toLowerCase()}/${values.year}`;
}

function formatRefundQueueDateTime(rawValue) {
  const date = new Date(rawValue);
  if (!Number.isFinite(date.getTime())) return "-";
  return `${formatRefundQueueDate(rawValue)}, ${new Intl.DateTimeFormat("es-MX", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date)}`;
}

function latestRouteTimeRescheduleDate(requestRow) {
  const entries = parseReasonEntries(requestRow?.rejectionReason);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (String(entry?.kind || "").toLowerCase() !== "courier_route_time_reprogrammed") continue;
    const dateLabel = String(entry?.reason || "").match(/Reprogramado para el ([^.\n]+)/i)?.[1] || "";
    if (dateLabel) return formatReturnRescheduleDate(dateLabel);
  }
  return formatReturnRescheduleDate(requestRow?.pickupDate);
}

function routeTimeRescheduleDateFromReason(reason) {
  const dateLabel = String(reason || "").match(/Reprogramado para el ([^.\n]+)/i)?.[1] || "";
  return dateLabel ? formatReturnRescheduleDate(dateLabel) : "";
}

function buildReturnRouteTimeRescheduleMessage(requestRow, dateOverride = "") {
  const orderNumber = String(requestRow?.orderNumber || "").replace(/^#/, "").trim() || "****";
  const dateLabel = dateOverride || latestRouteTimeRescheduleDate(requestRow);
  const pickupHours = String(requestRow?.pickupHours || "").trim();
  const pickupHoursText = pickupHours ? ` en un horario de ${pickupHours}` : "";
  return (
    `🚚 Pedido #${orderNumber}. Tu devolución no pudo ser recogida el día de hoy debido a ajustes operativos en la ruta de recolección, ` +
    `tu devolución ha sido reprogramada para mañana${dateLabel ? ` ${dateLabel}` : ""}${pickupHoursText}.\n` +
    "Agradecemos tu comprensión y por confiar siempre en Cariana . ✨"
  );
}

function buildRefundProcessedMessage(requestRow, finalRefund) {
  const orderNumber = String(requestRow?.orderNumber || "").replace(/^#/, "").trim() || "****";
  return `Pedido #${orderNumber}. 💸 Tu reembolso ya fue procesado correctamente por la cantidad de $${toMoney(finalRefund)} MXN. Dependiendo de tu banco, el monto podrá verse reflejado en tu cuenta dentro de 5 a 10 días hábiles. Gracias por confiar en Cariana. 💙`;
}

function timelineLabelFromStatus(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "en_revision") return "Solicitud en revision";
  if (normalized === "aprobada") return "Devolucion aprobada";
  if (normalized === "en_ruta") return "En ruta";
  if (normalized === "reintento_pendiente") return "Reprogramado";
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

function courierAttemptLabel(attempt) {
  const attemptNumber = Number(attempt || 0);
  if (attemptNumber === 1) return "Primer intento";
  if (attemptNumber === 2) return "Segundo intento";
  if (attemptNumber === 3) return "Tercer intento";
  return "Intento";
}

function timelineLabelFromReasonEntry(entry) {
  const kind = String(entry?.kind || "").toLowerCase();
  const courierRouteMatch = kind.match(/^courier_en_route_(\d)$/);
  if (courierRouteMatch) return `${courierAttemptLabel(courierRouteMatch[1])} en ruta`;
  const courierRetryMatch = kind.match(/^courier_retry_(\d)$/);
  if (courierRetryMatch) return `${courierAttemptLabel(courierRetryMatch[1])} reprogramado`;
  if (kind === "courier_route_time_reprogrammed") return "Reprogramado";
  if (kind === STATUS_REVIEW_KIND) return "Solicitud en revision";
  if (kind === STATUS_APPROVED_KIND) return "Devolucion aprobada";
  if (kind === STATUS_IN_ROUTE_KIND) return "En ruta";
  if (kind === STATUS_RECEIVED_KIND) return "Recibimos tu producto";
  if (kind === STATUS_REFUNDED_KIND) return "Reembolso procesado";
  if (kind === "attempt_failed_1") return "Primer intento";
  if (kind === "attempt_failed_2") return "Segundo intento";
  if (kind === "attempt_failed_3") return "Tercer intento";
  if (kind === "review_rejected" || kind === "rejected_after_attempts") return "Devolucion rechazada";
  if (kind === "denied_after_received") return "Reembolso denegado";
  if (kind === "never_arrived_branch") return "No devuelto";
  if (kind === NOT_RETURNED_KIND) return "No devuelto";
  if (kind === RETURNED_TO_CUSTOMER_KIND) return "Devolucion devuelta al cliente";
  return "";
}

function timelineToneFromStatus(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "en_revision") return "review";
  if (normalized === "aprobada") return "approved";
  if (normalized === "en_ruta") return "approved";
  if (normalized === "reintento_pendiente") return "reprogrammed";
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
  if (kind === "courier_route_time_reprogrammed") return "reprogrammed";
  if (kind === STATUS_RECEIVED_KIND) return "received";
  if (kind === STATUS_REFUNDED_KIND) return "refunded";
  if (kind === "attempt_failed_1" || kind === "attempt_failed_2" || kind === "attempt_failed_3") return "attempt";
  if (kind === "review_rejected" || kind === "rejected_after_attempts") return "rejected";
  if (kind === "denied_after_received") return "denied";
  if (kind === "never_arrived_branch") return "denied";
  if (kind === RETURNED_TO_CUSTOMER_KIND) return "pending";
  if (kind === NOT_RETURNED_KIND) return "denied";
  return "default";
}

function branchApprovedPortalMessage(requestRow) {
  const orderNumber = String(requestRow?.orderNumber || "").replace(/^#/, "").trim();
  const prefix = orderNumber ? `📦Pedido #${orderNumber}. ` : "📦";
  return `${prefix}Tu solicitud de devolución fue aprobada. Por favor, lleva tu producto a la sucursal de devoluciones antes de la fecha limite de entrega siguiendo las instrucciones de entrega.`;
}

function receivedReturnPortalMessage(requestRow) {
  const orderNumber = String(requestRow?.orderNumber || "").replace(/^#/, "").trim();
  const prefix = orderNumber ? `📦Pedido #${orderNumber}. ` : "📦";
  return `${prefix}Producto recibido. Hemos recibido tu devolución y nuestro equipo ya se encuentra revisando tu producto. Una vez finalizado el proceso de verificación, realizaremos tu reembolso correspondiente. 💰 Regresa mas tarde para ver el estado de tu devolucion.`;
}

function reviewReturnPortalMessage(requestRow) {
  const orderNumber = String(requestRow?.orderNumber || "").replace(/^#/, "").trim() || "****";
  return `📦 Pedido #${orderNumber}. Nuestro equipo ya comenzó el proceso de verificación de tu producto. Revisaremos la descripción y las fotografías del problema reportado. Una vez que validemos tu solicitud, te notificaremos el resultado. Regresa más tarde para consultar el estado de tu devolución.`;
}

function pickupApprovedPortalMessage(requestRow) {
  const orderNumber = String(requestRow?.orderNumber || "").replace(/^#/, "").trim() || "****";
  return `📦Pedido #${orderNumber}. Tu solicitud fue aprobada exitosamente. Nuestro equipo recogerá tu pedido en el domicilio y fecha indicados por ti. 🚚 Gracias por confiar y ser parte de Cariana. 💙`;
}

function expiredReturnPortalMessage(requestRow) {
  const orderNumber = String(requestRow?.orderNumber || "").replace(/^#/, "").trim() || "****";
  return `Pedido #${orderNumber}. Estimado cliente, la fecha límite para entregar tu devolución ha expirado. Lamentablemente, ya no podremos aceptar el producto.`;
}

function timelineStatusDescription(status, requestRow) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "en_revision") return reviewReturnPortalMessage(requestRow);
  if (normalized === "aprobada") {
    return requestRow.returnMethod === "pickup"
      ? pickupApprovedPortalMessage(requestRow)
      : branchApprovedPortalMessage(requestRow);
  }
  if (normalized === "en_ruta") {
    return "Tu recoleccion ya va en ruta hacia tu domicilio. Nuestro equipo se dirige para continuar el proceso.";
  }
  if (normalized === "reintento_pendiente") return buildReturnRouteTimeRescheduleMessage(requestRow);
  if (normalized === "recibida") return receivedReturnPortalMessage(requestRow);
  if (normalized === "reembolsada" || normalized === "completada") {
    return "Tu reembolso ya fue procesado al metodo de pago original.";
  }
  if (normalized === "por_devolver") return "Tu paquete esta pendiente por recoger en sucursal.";
  if (normalized === "reembolso_denegado" || normalized === "denegada") {
    const denialReason = String(requestRow?.rejectionReason || "").trim();
    return denialReason || "El reembolso fue denegado. Revisa el motivo de denegacion.";
  }
  if (normalized === "rechazada") {
    const rejectionReason = String(requestRow?.rejectionReason || "").trim();
    return rejectionReason || "Tu solicitud fue rechazada. Revisa el motivo para mas detalle.";
  }
  if (normalized === "no_devuelto") return expiredReturnPortalMessage(requestRow);
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

function buildStatusTimeline(requestRow) {
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
    pushEvent("Solicitud en revision", requestRow.createdAt, reviewReturnPortalMessage(requestRow), "review");
  }
  if (requestRow.requiresReview && !entryKinds.has(STATUS_APPROVED_KIND) && hasReachedApprovedPhase(requestRow.status)) {
    pushEvent(
      "Devolucion aprobada",
      requestRow.receivedAt || requestRow.updatedAt || requestRow.createdAt,
      requestRow.returnMethod === "pickup"
        ? pickupApprovedPortalMessage(requestRow)
        : branchApprovedPortalMessage(requestRow),
      "approved",
    );
  }
  if (!requestRow.requiresReview && !entryKinds.has(STATUS_APPROVED_KIND)) {
    pushEvent(
      "Devolucion aprobada",
      requestRow.createdAt,
      requestRow.returnMethod === "pickup"
        ? pickupApprovedPortalMessage(requestRow)
        : branchApprovedPortalMessage(requestRow),
      "approved",
    );
  }
  if (!entryKinds.has(STATUS_RECEIVED_KIND)) {
    pushEvent("Recibimos tu producto", requestRow.receivedAt, receivedReturnPortalMessage(requestRow), "received");
  }
  if (!entryKinds.has(STATUS_REFUNDED_KIND)) {
    pushEvent("Reembolso procesado", requestRow.refundedAt, buildRefundProcessedMessage(requestRow, requestRow.finalRefund), "refunded");
  }
  if (!entryKinds.has(RETURNED_TO_CUSTOMER_KIND)) {
    pushEvent("Devolucion devuelta al cliente", requestRow.returnedToCustomerAt, RETURNED_TO_CUSTOMER_MESSAGE, "pending");
  }

  for (const entry of requestRow.timelineEntries || []) {
    const kind = String(entry?.kind || "").toLowerCase();
    if (kind.startsWith("courier_en_route_")) continue;
    const label = timelineLabelFromReasonEntry(entry);
    if (!label) continue;
    const note = kind === STATUS_APPROVED_KIND
      ? requestRow.returnMethod === "pickup"
        ? pickupApprovedPortalMessage(requestRow)
        : branchApprovedPortalMessage(requestRow)
      : kind === STATUS_REVIEW_KIND
        ? reviewReturnPortalMessage(requestRow)
        : kind === STATUS_RECEIVED_KIND
          ? receivedReturnPortalMessage(requestRow)
          : kind === STATUS_REFUNDED_KIND
            ? buildRefundProcessedMessage(requestRow, requestRow.finalRefund)
            : kind === "courier_route_time_reprogrammed"
              ? buildReturnRouteTimeRescheduleMessage(requestRow, routeTimeRescheduleDateFromReason(entry.reason))
              : kind === "never_arrived_branch"
                ? expiredReturnPortalMessage(requestRow)
                : kind === RETURNED_TO_CUSTOMER_KIND
                  ? normalizeDisplayedReasonText(entry.reason) || RETURNED_TO_CUSTOMER_MESSAGE
                  : normalizeDisplayedReasonText(entry.reason);
    pushEvent(label, entry.at, note, timelineToneFromReasonEntry(entry));
  }

  const currentStatusKind = timelineKindFromStatus(requestRow.status);
  const hasExplicitNotReturnedStatus = ["never_arrived_branch", NOT_RETURNED_KIND].some((kind) => entryKinds.has(kind));
  const shouldSkipCurrentStatusFallback =
    String(requestRow.status || "").toLowerCase() === "no_devuelto" && hasExplicitNotReturnedStatus;
  if (!shouldSkipCurrentStatusFallback && (!currentStatusKind || !entryKinds.has(currentStatusKind))) {
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

function timelineToneClassName(tone) {
  if (tone === "review") return styles.timelineToneReview;
  if (tone === "approved") return styles.timelineToneApproved;
  if (tone === "attempt") return styles.timelineToneAttempt;
  if (tone === "rejected") return styles.timelineToneRejected;
  if (tone === "received") return styles.timelineToneReceived;
  if (tone === "pending") return styles.timelineTonePending;
  if (tone === "reprogrammed") return styles.timelineToneReprogrammed;
  if (tone === "denied") return styles.timelineToneDenied;
  if (tone === "refunded") return styles.timelineToneRefunded;
  return "";
}

function sectionLabelForRequest(request) {
  const status = String(request?.status || "").toLowerCase();
  if (status === "en_revision") return "Ordenes en revision";
  if (status === "recibida") return "Procesar reembolsos";
  if (status === "por_devolver") return "Devoluciones a devolver";
  if (HISTORY_STATUSES.has(status)) return "Historial";
  if (request?.returnMethod === "pickup") return "Recoleccion a domicilio";
  return "Entrega en sucursal";
}

function getStatusClassName(status) {
  if (status === "en_revision") return "statusReview";
  if (status === "aprobada") return "statusApproved";
  if (status === "en_ruta") return "statusApproved";
  if (status === "reintento_pendiente") return "statusReprogrammed";
  if (status === "intento_fallido_1" || status === "intento_fallido_2") return "statusAttemptFailed";
  if (status === "por_devolver") return "statusPendingReturn";
  if (status === "rechazada") return "statusRejected";
  if (status === "reembolso_denegado") return "statusDenied";
  if (status === "recibida") return "statusReceived";
  if (status === "reembolsada") return "statusRefunded";
  if (status === "denegada") return "statusDenied";
  return "statusDefault";
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

function putImageCandidate(map, key, imageUrl, imageAlt) {
  if (!key || !imageUrl || map[key]) return;
  map[key] = { imageUrl, imageAlt: imageAlt || "" };
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

    for (const orderNode of nodes) {
      const orderId = String(orderNode?.id || "").trim();
      if (!orderId) continue;
      const imageMap = {};
      const edges = Array.isArray(orderNode?.lineItems?.edges) ? orderNode.lineItems.edges : [];
      for (const edge of edges) {
        const lineNode = edge?.node;
        if (!lineNode) continue;
        const lineItemId = String(lineNode.id || "").trim();
        const lineTitle = String(lineNode.title || "").trim().toLowerCase();
        const variantId = String(lineNode?.variant?.id || "").trim();
        const productId = String(lineNode?.product?.id || "").trim();
        const variantImageUrl = String(lineNode?.variant?.image?.url || "").trim();
        const variantImageAlt = String(lineNode?.variant?.image?.altText || "").trim();
        const productImageUrl = String(lineNode?.product?.featuredImage?.url || "").trim();
        const productImageAlt = String(lineNode?.product?.featuredImage?.altText || "").trim();
        const chosenUrl = variantImageUrl || productImageUrl;
        const chosenAlt = variantImageAlt || productImageAlt;

        putImageCandidate(imageMap, lineItemId ? `line:${lineItemId}` : "", chosenUrl, chosenAlt);
        putImageCandidate(imageMap, variantId ? `variant:${variantId}` : "", chosenUrl, chosenAlt);
        putImageCandidate(imageMap, productId ? `product:${productId}` : "", chosenUrl, chosenAlt);
        putImageCandidate(imageMap, lineTitle ? `title:${lineTitle}` : "", chosenUrl, chosenAlt);
      }
      byOrder[orderId] = imageMap;
    }

    return byOrder;
  } catch (error) {
    console.error("Error loading product images for portal results", error);
    return {};
  }
}

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "lookup") {
    try {
      const orderNumber = normalizeOrderNumber(formData.get("orderNumber"));
      if (!orderNumber) {
        return { ok: false, error: "Captura el numero de pedido." };
      }

      const requests = await prisma.returnRequest.findMany({
        where: {
          shop: session.shop,
          orderNumber,
        },
        include: {
          items: true,
        },
        orderBy: {
          createdAt: "desc",
        },
      });

      if (!requests.length) {
        return { ok: false, error: "No hay pedidos con ese numero de orden" };
      }

      const imageMapsByOrder = await fetchOrderItemImageMaps(
        admin,
        requests.map((requestRow) => requestRow.shopifyOrderId),
      );

      return {
        ok: true,
        requests: requests.map((requestRow) => {
          const status = String(requestRow.status || "").toLowerCase();
          const reasonEntries = parseReasonEntries(requestRow.rejectionReason);
          const visibleReasonEntries = reasonEntries.filter((entry) => !isSystemProgressEntry(entry));
          const returnedToCustomerAt = latestReturnedToCustomerAtFromRaw(requestRow.rejectionReason);
          const requiresPickupDeadline = ["por_devolver", "no_devuelto", "reembolso_denegado", "denegada"].includes(status);
          const pendingPickupSinceAt = requiresPickupDeadline
            ? latestEntryAtFromKinds(requestRow.rejectionReason, ["denied_after_received"]) ||
              requestRow.updatedAt?.toISOString?.() ||
              ""
            : "";
          const pickupDeadlineDate = requiresPickupDeadline ? addDays(pendingPickupSinceAt, PICKUP_DEADLINE_DAYS) : null;
          const branchDeliveryDeadlineDate =
            requestRow.returnMethod !== "pickup" && requestRow.limitDate ? new Date(requestRow.limitDate) : null;
          const hasValidBranchDeliveryDeadline =
            Boolean(branchDeliveryDeadlineDate) && Number.isFinite(branchDeliveryDeadlineDate.getTime());
          const imageMap = imageMapsByOrder[String(requestRow.shopifyOrderId || "").trim()] || {};
          const mappedRequest = {
            id: requestRow.id,
            orderNumber: requestRow.orderNumber,
            customerName: requestRow.customerName,
            customerEmail: requestRow.customerEmail,
            customerPhone: requestRow.customerPhone || "",
            returnMethod: requestRow.returnMethod,
            returnCost: requestRow.returnCost,
            refundedSubtotal: requestRow.refundedSubtotal,
            estimatedRefund: requestRow.estimatedRefund,
            finalRefund: requestRow.finalRefund,
            status,
            requiresReview: Boolean(requestRow.requiresReview),
            createdAt: requestRow.createdAt?.toISOString() || null,
            updatedAt: requestRow.updatedAt?.toISOString() || null,
            receivedAt: requestRow.receivedAt?.toISOString() || null,
            refundedAt: requestRow.refundedAt?.toISOString() || null,
            pickupDeadlineAt: pickupDeadlineDate?.toISOString?.() || "",
            branchDeliveryDeadlineAt: hasValidBranchDeliveryDeadline
              ? branchDeliveryDeadlineDate.toISOString()
              : "",
            branchAddress: requestRow.branchAddress || "",
            branchHours: requestRow.branchHours || "",
            pickupAddress: requestRow.pickupAddress || "",
            pickupCity: requestRow.pickupCity || "",
            pickupState: requestRow.pickupState || "",
            pickupPostalCode: requestRow.pickupPostalCode || "",
            pickupDate: requestRow.pickupDate || "",
            pickupHours: requestRow.pickupHours || "",
            pickupNotes: requestRow.pickupNotes || "",
            timelineEntries: reasonEntries,
            reasonEntries: visibleReasonEntries,
            wasReturnedToCustomer: reasonEntries.some(isReturnedToCustomerEntry),
            returnedToCustomerAt: returnedToCustomerAt || null,
            rejectionReason: latestReasonFromRaw(requestRow.rejectionReason),
            items: requestRow.items.map((item) => ({
              id: item.id,
              lineItemId: item.lineItemId || "",
              productId: item.productId || "",
              variantId: item.variantId || "",
              title: item.title,
              quantity: item.quantity,
              reason: item.reason,
              details: item.details || "",
              photoDataUrl: item.photoDataUrl || "",
              imageUrl: imageMap[itemKeyFromRecord(item)]?.imageUrl || "",
              imageAlt: imageMap[itemKeyFromRecord(item)]?.imageAlt || "",
            })),
          };
          return {
            ...mappedRequest,
            sectionLabel: sectionLabelForRequest(mappedRequest),
          };
        }),
      };
    } catch (error) {
      console.error("Error searching return requests by order number", error);
      return { ok: false, error: "No se pudo buscar la devolucion en este momento." };
    }
  }

  return { ok: false, error: "Accion no valida." };
};

export default function ReturnsPortal() {
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const requests = Array.isArray(actionData?.requests) ? actionData.requests : [];
  const hasResults = requests.length > 0;
  const resultSections = Array.from(new Set(requests.map((request) => request.sectionLabel).filter(Boolean)));
  const resultSectionLabel =
    resultSections.length === 1 ? resultSections[0] : resultSections.length > 1 ? "Varias secciones" : "";

  return (
    <s-page heading="Portal de devoluciones">
      <s-section heading="Buscar devolucion por numero de pedido">
        <Form method="post">
          <input type="hidden" name="intent" value="lookup" />
          <div className={styles.grid}>
            <label className={styles.label}>
              Numero de pedido
              <input className={styles.input} name="orderNumber" required placeholder="Ejemplo: 1011" />
            </label>
            <div className={styles.actions}>
              <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Buscando..." : "Buscar pedido"}
              </button>
            </div>
            {actionData?.error ? <p className={styles.errorMsg}>{actionData.error}</p> : null}
          </div>
        </Form>
      </s-section>

      {hasResults ? (
        <s-section heading={`Seccion${requests.length > 1 ? "es" : ""}${resultSectionLabel ? ` - ${resultSectionLabel}` : ""}`}>
          <div className={`${styles.wrap} ${styles.reqGrid}`}>
            {requests.map((request) => (
              <ResultCard key={request.id} request={request} />
            ))}
          </div>
        </s-section>
      ) : null}
    </s-page>
  );
}

function ResultCard({ request }) {
  const [viewerImage, setViewerImage] = useState(null);
  const status = String(request.status || "").toLowerCase();
  const statusClassName = styles[getStatusClassName(status)];
  const isHistoryStatus = HISTORY_STATUSES.has(status);
  const closedAt =
    status === "reembolsada" && request.refundedAt ? request.refundedAt : request.updatedAt || null;
  const isDeniedReturnedToCustomer = status === "reembolso_denegado" && request.wasReturnedToCustomer;
  const timelineEvents = buildStatusTimeline(request);
  const currentTimelineEvent = timelineEvents[0] || null;
  const olderTimelineEvents = timelineEvents.slice(1).filter((event) => String(event.note || "").trim());

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
          {request.sectionLabel ? `${request.sectionLabel} · ` : ""}Estado:{" "}
          <strong className={statusClassName}>
            {isDeniedReturnedToCustomer ? (
              <>
                reembolso denegado - <span className={styles.returnedToCustomerStatus}>devuelto al cliente</span>
              </>
            ) : (
              STATUS_LABEL[status] || status
            )}
          </strong>
        </span>
      </div>

      <details className={styles.details}>
        <summary className={styles.summary}>Ver orden</summary>

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
            <span className={styles.kvVal}>{request.createdAt ? formatRefundQueueDateTime(request.createdAt) : "-"}</span>
          </div>
          {isHistoryStatus && closedAt ? (
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Fecha de cierre</span>
              <span className={styles.kvVal}>{formatRefundQueueDateTime(closedAt)}</span>
            </div>
          ) : null}
          {request.branchDeliveryDeadlineAt ? (
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Fecha limite de entrega</span>
              <span className={styles.kvVal}>{formatRefundQueueDate(request.branchDeliveryDeadlineAt)}</span>
            </div>
          ) : null}
          {request.receivedAt ? (
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Recibida</span>
              <span className={styles.kvVal}>{formatRefundQueueDateTime(request.receivedAt)}</span>
            </div>
          ) : null}
          {request.returnedToCustomerAt ? (
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Devuelta al cliente</span>
              <span className={styles.kvVal}>{formatRefundQueueDateTime(request.returnedToCustomerAt)}</span>
            </div>
          ) : null}
          {request.refundedAt ? (
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Reembolsado</span>
              <span className={styles.kvVal}>{formatRefundQueueDateTime(request.refundedAt)}</span>
            </div>
          ) : null}
          {request.pickupDeadlineAt && status !== "no_devuelto" ? (
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Fecha limite para recoger</span>
              <span className={styles.kvVal}>{formatRefundQueueDate(request.pickupDeadlineAt)}</span>
            </div>
          ) : null}
        </div>

        {currentTimelineEvent ? (
          <div className={styles.statusTimelineCurrent}>
            <p className={styles.statusTimelineTitle}>Estado actual</p>
            <p className={styles.statusTimelineCurrentLine}>
              <strong className={timelineToneClassName(currentTimelineEvent.tone)}>{currentTimelineEvent.label}</strong>{" "}
              <span>{formatRefundQueueDateTime(currentTimelineEvent.at)}</span>
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
                <p className={styles.statusTimelineItemAt}>{formatRefundQueueDateTime(event.at)}</p>
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
            {" | "}Dia: {request.pickupDate ? formatRefundQueueDate(request.pickupDate) : "-"}
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

        {!request.reasonEntries?.length && request.rejectionReason ? (
          <div className={styles.reasonHistory}>
            <p className={styles.reasonHistoryTitle}>Historial de motivos enviados</p>
            <ul className={styles.reasonHistoryList}>
              <li className={styles.reasonHistoryItem}>
                <strong>Motivo:</strong> <span className={styles.reasonHistoryMessage}>{request.rejectionReason}</span>
              </li>
            </ul>
          </div>
        ) : null}

        <h4 className={styles.orderDetailTitle}>Productos, motivos, fotos y descripcion</h4>
        <ul className={styles.productList}>
          {request.items.map((item) => {
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
                      />
                    </button>
                  ) : (
                    <div className={styles.productThumbPlaceholder} />
                  )}
                  <div className={styles.productCopy}>
                    <p className={styles.productLineTitle}>
                      {item.title} x{item.quantity}
                    </p>
                    <p className={styles.productLineMeta}>Motivo: {item.reason}</p>
                  </div>
                </div>
                {item.details ? <p className={styles.productLineMeta}>Descripcion: {item.details}</p> : null}
                {photos.length ? (
                  <div className={styles.evidencePhotos}>
                    {photos.map((src, idx) => (
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
            );
          })}
        </ul>
      </details>

      <ImageViewer image={viewerImage} onClose={() => setViewerImage(null)} />
    </article>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
