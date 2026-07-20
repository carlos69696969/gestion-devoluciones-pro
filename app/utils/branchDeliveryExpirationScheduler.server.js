import prisma from "../db.server";

const MEXICO_TIME_ZONE = "America/Mexico_City";
const NEVER_ARRIVED_BRANCH_REASON = "Nunca llego a la sucursal para completar la devolucion.";
const NOTIFICATIONS_API_BASE_URL = String(
  process.env.NOTIFICATIONS_API_URL || "https://centro-de-notificaciones-cariana.onrender.com",
).replace(/\/+$/, "");
const NOTIFICATIONS_API_KEY = String(
  process.env.NOTIFICATIONS_API_KEY || process.env.APP_INTERNAL_API_KEY || "",
).trim();
const SCHEDULER_FLAG = Symbol.for("cariana.branchDeliveryExpirationScheduler.started");
const SCHEDULER_TIMER = Symbol.for("cariana.branchDeliveryExpirationScheduler.timer");

function mexicoDateKey(dateValue = new Date()) {
  if (!dateValue) return "";
  const rawValue = String(dateValue || "").trim();
  const dateMatch = rawValue.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dateMatch) return `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;

  const date = new Date(dateValue);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MEXICO_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year && values.month && values.day ? `${values.year}-${values.month}-${values.day}` : "";
}

function mexicoTimeParts(dateValue = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: MEXICO_TIME_ZONE,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(dateValue);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    hour: Number(values.hour || 0),
    minute: Number(values.minute || 0),
  };
}

function addDaysToDateKey(dateKey, days) {
  const [year, month, day] = String(dateKey || "")
    .split("-")
    .map((value) => Number(value));
  if (!year || !month || !day) return "";
  const result = new Date(Date.UTC(year, month - 1, day + Number(days || 0), 12, 0, 0));
  return result.toISOString().slice(0, 10);
}

function isBranchDeliveryExpired(limitDateValue, now = new Date()) {
  const limitDateKey = mexicoDateKey(limitDateValue);
  const expiresDateKey = limitDateKey ? addDaysToDateKey(limitDateKey, 1) : "";
  const nowDateKey = mexicoDateKey(now);
  return Boolean(expiresDateKey && nowDateKey) && nowDateKey >= expiresDateKey;
}

function msUntilNextMexicoMidnight(now = new Date()) {
  const todayKey = mexicoDateKey(now);
  const nextDateKey = addDaysToDateKey(todayKey, 1);
  const target = new Date(`${nextDateKey}T06:00:05.000Z`);
  const delay = target.getTime() - now.getTime();
  if (!Number.isFinite(delay) || delay < 1000 || delay > 36 * 60 * 60 * 1000) {
    return 60 * 60 * 1000;
  }
  return delay;
}

function parseReasonEntries(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.entries)) return parsed.entries;
  } catch {
    // Older records can contain plain text instead of timeline JSON.
  }
  return [{ kind: "legacy", reason: raw, at: "" }];
}

function appendReasonEntry(rawValue, entry) {
  const entries = parseReasonEntries(rawValue);
  entries.push({
    kind: String(entry?.kind || "legacy"),
    reason: String(entry?.reason || "").trim(),
    at: String(entry?.at || "").trim() || new Date().toISOString(),
  });
  return JSON.stringify({ entries });
}

function buildReturnReference(requestRow) {
  const orderNumber = String(requestRow?.orderNumber || "").trim();
  if (orderNumber) return orderNumber;
  const id = Number(requestRow?.id || 0);
  return id ? `DEV-${id}` : "";
}

function buildExpiredReturnEventPayload(requestRow) {
  const returnReference = buildReturnReference(requestRow);
  return {
    status: "return_expired",
    event: "return_expired",
    action: "mark_never_arrived",
    return_reference: returnReference,
    return_id: requestRow.id || null,
    return_request_id: requestRow.id || null,
    event_dedupe_key: requestRow.id ? `return:${requestRow.id}:return_expired` : null,
    order_number: requestRow.orderNumber || null,
    email: requestRow.customerEmail || null,
    customer_email: requestRow.customerEmail || null,
    customer: {
      email: requestRow.customerEmail || null,
      name: requestRow.customerName || null,
      phone: requestRow.customerPhone || null,
    },
    note: NEVER_ARRIVED_BRANCH_REASON,
    source: "portal_devoluciones_scheduler",
    return_method: requestRow.returnMethod || null,
  };
}

async function emitExpiredReturnNotification({ shopDomain, requestRow }) {
  if (!shopDomain || !requestRow || !NOTIFICATIONS_API_BASE_URL) return;

  const endpoint = NOTIFICATIONS_API_KEY
    ? `${NOTIFICATIONS_API_BASE_URL}/api/returns/events`
    : `${NOTIFICATIONS_API_BASE_URL}/proxy/returns/events`;
  const headers = {
    "Content-Type": "application/json",
    "x-shop-domain": shopDomain,
  };
  if (NOTIFICATIONS_API_KEY) headers["x-api-key"] = NOTIFICATIONS_API_KEY;

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      shopDomain,
      event: buildExpiredReturnEventPayload(requestRow),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`return notification failed ${response.status}: ${String(detail || "").slice(0, 200)}`);
  }
}

export async function expireBranchDeliveryRequestsForAllShops({ now = new Date(), logger = console } = {}) {
  const candidates = await prisma.returnRequest.findMany({
    where: {
      returnMethod: { not: "pickup" },
      status: "aprobada",
      limitDate: { not: null },
    },
    include: { items: true },
    orderBy: [{ limitDate: "asc" }, { id: "asc" }],
  });

  let expiredCount = 0;
  for (const requestRow of candidates) {
    if (!isBranchDeliveryExpired(requestRow.limitDate, now)) continue;

    const updateResult = await prisma.returnRequest.updateMany({
      where: { id: requestRow.id, status: "aprobada" },
      data: {
        status: "no_devuelto",
        rejectionReason: appendReasonEntry(requestRow.rejectionReason, {
          kind: "never_arrived_branch",
          reason: NEVER_ARRIVED_BRANCH_REASON,
        }),
      },
    });
    if (!updateResult.count) continue;

    const updatedRequest = await prisma.returnRequest.findUnique({
      where: { id: requestRow.id },
      include: { items: true },
    });
    try {
      await emitExpiredReturnNotification({
        shopDomain: updatedRequest?.shop || requestRow.shop,
        requestRow: updatedRequest || requestRow,
      });
    } catch (error) {
      logger.error?.("Failed to emit scheduled branch delivery expiration notification", {
        requestId: requestRow.id,
        shop: requestRow.shop,
        error: String(error?.message || error || "unknown"),
      });
    }
    expiredCount += 1;
  }

  return expiredCount;
}

export function startBranchDeliveryExpirationScheduler({ logger = console } = {}) {
  if (globalThis[SCHEDULER_FLAG]) return;
  globalThis[SCHEDULER_FLAG] = true;

  const scheduleNext = () => {
    const delay = msUntilNextMexicoMidnight();
    globalThis[SCHEDULER_TIMER] = setTimeout(async () => {
      try {
        const expiredCount = await expireBranchDeliveryRequestsForAllShops({ logger });
        logger.info?.("Branch delivery expiration scheduler completed", { expiredCount });
      } catch (error) {
        logger.error?.("Branch delivery expiration scheduler failed", {
          error: String(error?.message || error || "unknown"),
        });
      } finally {
        scheduleNext();
      }
    }, delay);
    globalThis[SCHEDULER_TIMER]?.unref?.();
  };

  const currentMexicoTime = mexicoTimeParts();
  if (currentMexicoTime.hour === 0 && currentMexicoTime.minute <= 15) {
    globalThis[SCHEDULER_TIMER] = setTimeout(async () => {
      try {
        const expiredCount = await expireBranchDeliveryRequestsForAllShops({ logger });
        logger.info?.("Branch delivery expiration scheduler completed after startup", { expiredCount });
      } catch (error) {
        logger.error?.("Branch delivery expiration scheduler failed after startup", {
          error: String(error?.message || error || "unknown"),
        });
      } finally {
        scheduleNext();
      }
    }, 5000);
    globalThis[SCHEDULER_TIMER]?.unref?.();
    return;
  }

  scheduleNext();
}
