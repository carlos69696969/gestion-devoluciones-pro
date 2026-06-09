function parseCourierDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const date = raw.includes("T") ? new Date(raw) : new Date(`${raw}T00:00:00`);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function courierOrderTimestampMs(request) {
  const date =
    parseCourierDate(request?.pickupDate) ||
    parseCourierDate(request?.updatedAt) ||
    parseCourierDate(request?.createdAt);
  return date ? date.getTime() : 0;
}

export function formatCourierScheduledDate(pickupDate) {
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

export function formatCourierAddress(request) {
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

export function isCourierRouteStatus(status) {
  return String(status || "")
    .trim()
    .toLowerCase()
    .startsWith("en_ruta");
}

export function isCourierRetryPendingStatus(status) {
  return String(status || "").trim().toLowerCase() === "reintento_pendiente";
}

export function isCourierRouteTabStatus(status) {
  return isCourierRouteStatus(status) || isCourierRetryPendingStatus(status);
}

export function isCourierHistoryStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  return ["no_entregado", "entregado", "no_recibido", "recibido"].includes(normalized);
}

export function getCourierRouteStatusLabel(status) {
  return isCourierRouteStatus(status) ? "en ruta" : String(status || "pendiente").replace(/_/g, " ");
}

function normalizeCourierTag(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

export function getCourierRouteStepFromTags(tags) {
  const normalizedTags = new Set((Array.isArray(tags) ? tags : []).map(normalizeCourierTag));
  if (normalizedTags.has("en ruta 3")) return 3;
  if (normalizedTags.has("en ruta 2")) return 2;
  if (normalizedTags.has("en ruta")) return 1;
  return 0;
}

export function getCourierDeliveryAttemptCountFromTags(tags) {
  const normalizedTags = Array.isArray(tags) ? tags.map(normalizeCourierTag) : [];
  let attemptCount = 0;

  for (const tag of normalizedTags) {
    const match = tag.match(/^intento entrega (\d)$/);
    if (!match) continue;
    attemptCount = Math.max(attemptCount, Number(match[1]) || 0);
  }

  return attemptCount;
}

export function getCourierRouteStatusFromTags(tags) {
  const normalizedTags = new Set((Array.isArray(tags) ? tags : []).map(normalizeCourierTag));
  if (normalizedTags.has("no entregado")) return "no_entregado";
  if (normalizedTags.has("entregado")) return "entregado";
  if (normalizedTags.has("reintentar entrega")) return "reintento_pendiente";
  const step = getCourierRouteStepFromTags(tags);
  return step ? `en_ruta_${step}` : "pendiente";
}

export function dedupeCourierRequestsByOrderNumber(requests) {
  const byOrderNumber = new Map();

  for (const request of Array.isArray(requests) ? requests : []) {
    const orderNumber = String(request?.orderNumber || "").trim();
    if (!orderNumber) continue;

    const current = byOrderNumber.get(orderNumber);
    if (!current) {
      byOrderNumber.set(orderNumber, request);
      continue;
    }

    const currentTimestamp = courierOrderTimestampMs(current);
    const nextTimestamp = courierOrderTimestampMs(request);
    if (nextTimestamp >= currentTimestamp) {
      byOrderNumber.set(orderNumber, request);
    }
  }

  return Array.from(byOrderNumber.values());
}
