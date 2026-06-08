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

export function getCourierRouteStatusLabel(status) {
  return isCourierRouteStatus(status) ? "en ruta" : String(status || "pendiente").replace(/_/g, " ");
}
