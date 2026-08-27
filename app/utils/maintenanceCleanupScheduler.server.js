import prisma from "../db.server";
import {
  deleteExpiredArchivedStockProducts,
  ensureStockArchivedProductCleanupStorage,
  normalizeStockArchivedProductCleanupDays,
} from "./stockZeroInventoryArchive.server";

const ADMIN_API_VERSION = "2025-10";
const MEXICO_TIME_ZONE = "America/Mexico_City";
const HISTORY_STATUSES = ["reembolsada", "rechazada", "denegada", "reembolso_denegado", "no_devuelto"];
const DEFAULT_EVIDENCE_DAYS = 120;
const DEFAULT_PURGE_DAYS = 180;
const DEFAULT_BATCH_SIZE = 200;
const MAX_BATCH_SIZE = 500;
const COURIER_HISTORY_SINCE = new Date("2026-06-10T00:00:00-06:00");
const SCHEDULER_FLAG = Symbol.for("cariana.maintenanceCleanupScheduler.started");
const SCHEDULER_TIMER = Symbol.for("cariana.maintenanceCleanupScheduler.timer");

function normalize(value) {
  return String(value || "").trim();
}

function normalizeShop(value) {
  return normalize(value).toLowerCase();
}

function parsePositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.floor(parsed);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function normalizeMaintenanceInputs(settings = {}) {
  const evidenceDays = parsePositiveInt(settings.maintenanceEvidenceDays, DEFAULT_EVIDENCE_DAYS, 1, 2000);
  const purgeDays = parsePositiveInt(settings.maintenancePurgeDays, DEFAULT_PURGE_DAYS, evidenceDays + 1, 5000);
  const batchSize = parsePositiveInt(settings.maintenanceBatchSize, DEFAULT_BATCH_SIZE, 25, MAX_BATCH_SIZE);
  const archivedProductCleanupDays = normalizeStockArchivedProductCleanupDays(
    settings.stockArchivedProductCleanupDays,
  );
  return { evidenceDays, purgeDays, batchSize, archivedProductCleanupDays };
}

function cutoffDateFromDays(days) {
  const at = new Date();
  at.setHours(0, 0, 0, 0);
  at.setDate(at.getDate() - days);
  return at;
}

function mexicoDateKey(dateValue = new Date()) {
  if (!dateValue) return "";
  const rawValue = normalize(dateValue);
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

function addDaysToDateKey(dateKey, days) {
  const [year, month, day] = normalize(dateKey)
    .split("-")
    .map((value) => Number(value));
  if (!year || !month || !day) return "";
  const result = new Date(Date.UTC(year, month - 1, day + Number(days || 0), 12, 0, 0));
  return result.toISOString().slice(0, 10);
}

function msUntilNextMexicoMidnight(now = new Date()) {
  const todayKey = mexicoDateKey(now);
  const nextDateKey = addDaysToDateKey(todayKey, 1);
  const target = new Date(`${nextDateKey}T06:00:10.000Z`);
  const delay = target.getTime() - now.getTime();
  if (!Number.isFinite(delay) || delay < 1000 || delay > 36 * 60 * 60 * 1000) {
    return 60 * 60 * 1000;
  }
  return delay;
}

function parseCourierDate(value) {
  const raw = normalize(value);
  if (!raw) return null;
  const date = raw.includes("T") ? new Date(raw) : new Date(`${raw}T00:00:00`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function courierScheduledDateIsBeforeCutoff(value, cutoff) {
  const date = parseCourierDate(value);
  return Boolean(date && date.getTime() < cutoff.getTime());
}

function normalizeCourierAttrKey(value) {
  return normalize(value)
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function getCourierCustomAttribute(orderNode, candidateKeys) {
  const attributes = Array.isArray(orderNode?.customAttributes) ? orderNode.customAttributes : [];
  const normalizedKeys = new Set((candidateKeys || []).map((key) => normalizeCourierAttrKey(key)));
  const match = attributes.find((attribute) => normalizedKeys.has(normalizeCourierAttrKey(attribute?.key)));
  return normalize(match?.value);
}

function getCourierScheduledDate(orderNode) {
  return getCourierCustomAttribute(orderNode, [
    "programado",
    "pickupDate",
    "pickup_date",
    "delivery_date",
    "deliveryDate",
    "scheduled_date",
    "scheduledDate",
    "preferred_delivery_date",
  ]);
}

function getInitialCourierScheduledDate(orderNode) {
  const configuredDate = getCourierScheduledDate(orderNode);
  if (configuredDate) return configuredDate;
  const createdAt = new Date(orderNode?.createdAt);
  if (!Number.isFinite(createdAt.getTime())) return normalize(orderNode?.createdAt);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MEXICO_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(createdAt);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return new Date(Date.UTC(
    Number(lookup.year),
    Number(lookup.month) - 1,
    Number(lookup.day) + 1,
  )).toISOString().slice(0, 10);
}

function isCourierLocalDeliveryOrder(orderNode) {
  const shippingLines = Array.isArray(orderNode?.shippingLines?.nodes) ? orderNode.shippingLines.nodes : [];
  return shippingLines.some((line) => {
    const title = normalize(line?.title).toLowerCase();
    const code = normalize(line?.code).toLowerCase();
    const category = normalize(line?.deliveryCategory).toLowerCase();
    return title.includes("local") || code.includes("local") || category.includes("local");
  });
}

function getCourierRouteStatusFromTags(tags = []) {
  const normalizedTags = (Array.isArray(tags) ? tags : []).map((tag) => normalize(tag).toLowerCase());
  if (normalizedTags.includes("reembolsada")) return "reembolsada";
  if (normalizedTags.includes("entregado")) return "entregado";
  if (normalizedTags.includes("recoger en sucursal")) return "recoger_en_sucursal";
  return "";
}

function historyWhere(shop) {
  return {
    shop,
    status: { in: HISTORY_STATUSES },
  };
}

function isPurgeableCourierRequestId(value) {
  const requestId = normalize(value);
  return Boolean(requestId && !requestId.startsWith("route:") && !requestId.startsWith("session:"));
}

function snapshotOrderEntries(snapshot) {
  return (Array.isArray(snapshot?.orders) ? snapshot.orders : [])
    .map((order) => ({
      requestId: normalize(order?.id),
      orderNumber: normalize(order?.orderNumber).replace(/^#/, "") || null,
    }))
    .filter((entry) => isPurgeableCourierRequestId(entry.requestId));
}

async function resolveAllShopSessions() {
  const sessions = await prisma.session.findMany({
    select: { id: true, shop: true, isOnline: true, accessToken: true },
  });
  const sessionsByShop = new Map();
  for (const session of sessions) {
    const shop = normalizeShop(session.shop);
    const accessToken = normalize(session.accessToken);
    if (!shop || !accessToken) continue;
    const current = sessionsByShop.get(shop) || [];
    current.push({
      id: normalize(session.id),
      shop,
      isOnline: Boolean(session.isOnline),
      accessToken,
    });
    sessionsByShop.set(shop, current);
  }
  for (const [shop, shopSessions] of sessionsByShop.entries()) {
    shopSessions.sort((a, b) => {
      const aOffline = a.isOnline === false ? 0 : 1;
      const bOffline = b.isOnline === false ? 0 : 1;
      if (aOffline !== bOffline) return aOffline - bOffline;
      return normalize(a.id).localeCompare(normalize(b.id));
    });
    sessionsByShop.set(shop, shopSessions);
  }
  return sessionsByShop;
}

async function shopifyGraphql({ shop, session, query, variables = {} }) {
  const response = await fetch(`https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": session.accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json().catch(() => ({}));
  const errors = payload?.errors || [];
  if (!response.ok || errors.length) {
    throw new Error(errors[0]?.message || `Error consultando Shopify Admin API (${response.status}).`);
  }
  return payload;
}

async function fetchScheduledCourierHistoryOrderNodes({ shop, session, limit }) {
  const nodes = [];
  let cursor = null;
  let hasNextPage = true;
  while (hasNextPage && nodes.length < limit) {
    const payload = await shopifyGraphql({
      shop,
      session,
      query: `#graphql
        query ScheduledCourierHistoryOrders($cursor: String) {
          orders(first: 250, after: $cursor, query: "updated_at:>=2026-06-10", sortKey: UPDATED_AT, reverse: true) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id
                name
                createdAt
                updatedAt
                tags
                customAttributes { key value }
                shippingLines(first: 5) {
                  nodes { title code deliveryCategory }
                }
              }
            }
          }
        }`,
      variables: { cursor },
    });
    const orders = payload?.data?.orders;
    nodes.push(...((orders?.edges || []).map((edge) => edge?.node).filter(Boolean)));
    hasNextPage = Boolean(orders?.pageInfo?.hasNextPage);
    cursor = orders?.pageInfo?.endCursor || null;
    if (!cursor) break;
  }
  return nodes;
}

async function collectScheduledCourierHistoryPurgeEntries({ shop, session, purgeCutoff, batchSize, logger }) {
  const entriesByRequestId = new Map();

  if (session?.accessToken) {
    try {
      for (const orderNode of await fetchScheduledCourierHistoryOrderNodes({ shop, session, limit: batchSize * 3 })) {
        const requestId = normalize(orderNode?.id);
        if (!isPurgeableCourierRequestId(requestId)) continue;
        const status = getCourierRouteStatusFromTags(orderNode?.tags);
        const updatedAt = new Date(orderNode?.updatedAt || orderNode?.createdAt || 0);
        if (
          !isCourierLocalDeliveryOrder(orderNode) ||
          !["entregado", "reembolsada"].includes(status) ||
          !Number.isFinite(updatedAt.getTime()) ||
          updatedAt.getTime() < COURIER_HISTORY_SINCE.getTime()
        ) {
          continue;
        }
        const scheduledDate = getInitialCourierScheduledDate(orderNode);
        if (!courierScheduledDateIsBeforeCutoff(scheduledDate, purgeCutoff)) continue;
        entriesByRequestId.set(requestId, {
          shop,
          requestId,
          orderNumber: normalize(orderNode?.name).replace(/^#/, "") || null,
          cutoffAt: purgeCutoff,
        });
        if (entriesByRequestId.size >= batchSize) break;
      }
    } catch (error) {
      logger?.error?.("Automatic cleanup could not mark scheduled Shopify courier history", {
        shop,
        error: String(error?.message || error || "unknown"),
      });
    }
  }

  if (entriesByRequestId.size < batchSize) {
    const cutoffDateKey = purgeCutoff.toISOString().slice(0, 10);
    const pickupRows = await prisma.returnRequest.findMany({
      where: {
        shop,
        returnMethod: "pickup",
        status: { in: ["recibida", "rechazada", "reembolsada", "no_devuelto"] },
        updatedAt: { gte: COURIER_HISTORY_SINCE },
        OR: [
          { pickupDate: { lt: cutoffDateKey } },
          {
            pickupDate: null,
            createdAt: { lt: purgeCutoff },
          },
        ],
      },
      select: { id: true, orderNumber: true, pickupDate: true, createdAt: true },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: batchSize,
    });
    for (const requestRow of pickupRows) {
      const requestId = `pickup-${requestRow.id}`;
      const scheduledDate = normalize(requestRow.pickupDate || requestRow.createdAt);
      if (!courierScheduledDateIsBeforeCutoff(scheduledDate, purgeCutoff)) continue;
      entriesByRequestId.set(requestId, {
        shop,
        requestId,
        orderNumber: normalize(requestRow.orderNumber).replace(/^#/, "") || null,
        cutoffAt: purgeCutoff,
      });
      if (entriesByRequestId.size >= batchSize) break;
    }
  }

  return Array.from(entriesByRequestId.values());
}

async function cleanupEvidenceBatch(shop, inputs) {
  const evidenceCutoff = cutoffDateFromDays(inputs.evidenceDays);
  let touchedRequests = 0;
  let cleanedPhotos = 0;
  let keepRunning = true;

  while (keepRunning) {
    const batch = await prisma.returnRequest.findMany({
      where: {
        ...historyWhere(shop),
        updatedAt: { lt: evidenceCutoff },
        items: { some: { photoDataUrl: { not: null } } },
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: inputs.batchSize,
    });
    if (!batch.length) {
      keepRunning = false;
      continue;
    }

    const ids = batch.map((row) => row.id);
    const updated = await prisma.returnItem.updateMany({
      where: {
        returnRequestId: { in: ids },
        photoDataUrl: { not: null },
      },
      data: { photoDataUrl: null },
    });
    touchedRequests += ids.length;
    cleanedPhotos += Number(updated.count || 0);
  }

  return { touchedRequests, cleanedPhotos };
}

async function deleteCourierRouteSnapshotsForPurgedOrders(shop, purgedRequestIds, batchSize) {
  const purgedRequestIdSet = new Set(
    (Array.isArray(purgedRequestIds) ? purgedRequestIds : [])
      .map((requestId) => normalize(requestId))
      .filter(Boolean),
  );
  if (!purgedRequestIdSet.size) return 0;

  const snapshots = await prisma.courierRouteSnapshot.findMany({
    where: { shop },
    select: { id: true, orders: true },
    orderBy: { id: "asc" },
    take: batchSize,
  });
  const removableIds = snapshots
    .filter((snapshot) => {
      const entries = snapshotOrderEntries(snapshot);
      return entries.length > 0 && entries.every((entry) => purgedRequestIdSet.has(entry.requestId));
    })
    .map((snapshot) => snapshot.id);
  if (!removableIds.length) return 0;

  const result = await prisma.courierRouteSnapshot.deleteMany({
    where: { id: { in: removableIds } },
  });
  return Number(result.count || 0);
}

async function deleteCourierHistoryByAge(shop, purgeCutoff, batchSize) {
  let deletedActivities = 0;
  let deletedEvents = 0;
  let deletedSnapshots = 0;

  let keepDeletingActivities = true;
  while (keepDeletingActivities) {
    const rows = await prisma.courierActivity.findMany({
      where: { shop, createdAt: { lt: purgeCutoff } },
      select: { id: true },
      orderBy: { id: "asc" },
      take: batchSize,
    });
    if (!rows.length) {
      keepDeletingActivities = false;
      continue;
    }
    const result = await prisma.courierActivity.deleteMany({
      where: { id: { in: rows.map((row) => row.id) } },
    });
    deletedActivities += Number(result.count || 0);
  }

  let keepDeletingEvents = true;
  while (keepDeletingEvents) {
    const rows = await prisma.courierEvent.findMany({
      where: { shop, createdAt: { lt: purgeCutoff } },
      select: { id: true },
      orderBy: { id: "asc" },
      take: batchSize,
    });
    if (!rows.length) {
      keepDeletingEvents = false;
      continue;
    }
    const result = await prisma.courierEvent.deleteMany({
      where: { id: { in: rows.map((row) => row.id) } },
    });
    deletedEvents += Number(result.count || 0);
  }

  let keepDeletingSnapshots = true;
  while (keepDeletingSnapshots) {
    const rows = await prisma.courierRouteSnapshot.findMany({
      where: { shop, finishedAt: { lt: purgeCutoff } },
      select: { id: true },
      orderBy: { id: "asc" },
      take: batchSize,
    });
    if (!rows.length) {
      keepDeletingSnapshots = false;
      continue;
    }
    const result = await prisma.courierRouteSnapshot.deleteMany({
      where: { id: { in: rows.map((row) => row.id) } },
    });
    deletedSnapshots += Number(result.count || 0);
  }

  return { deletedActivities, deletedEvents, deletedSnapshots };
}

async function purgeCourierHistoryBatch({ shop, session, inputs, logger }) {
  const purgeCutoff = cutoffDateFromDays(inputs.purgeDays);
  let purgedOrderMarkers = 0;
  let purgedScheduledOrderMarkers = 0;
  let deletedActivities = 0;
  let deletedEvents = 0;
  let deletedSnapshots = 0;
  let deletedDeliveryCodes = 0;

  const scheduledPurgeEntries = await collectScheduledCourierHistoryPurgeEntries({
    shop,
    session,
    purgeCutoff,
    batchSize: inputs.batchSize,
    logger,
  });
  if (scheduledPurgeEntries.length) {
    const scheduledResult = await prisma.courierHistoryPurge.createMany({
      data: scheduledPurgeEntries,
      skipDuplicates: true,
    });
    purgedScheduledOrderMarkers += Number(scheduledResult.count || 0);
  }

  const purgedRequestIds = scheduledPurgeEntries
    .map((entry) => normalize(entry.requestId))
    .filter(Boolean);
  if (purgedRequestIds.length) {
    const [activityResult, eventResult] = await Promise.all([
      prisma.courierActivity.deleteMany({
        where: { shop, requestId: { in: purgedRequestIds } },
      }),
      prisma.courierEvent.deleteMany({
        where: { shop, requestId: { in: purgedRequestIds } },
      }),
    ]);
    deletedActivities += Number(activityResult.count || 0);
    deletedEvents += Number(eventResult.count || 0);
    deletedSnapshots += await deleteCourierRouteSnapshotsForPurgedOrders(shop, purgedRequestIds, inputs.batchSize);
  }

  const agedHistory = await deleteCourierHistoryByAge(shop, purgeCutoff, inputs.batchSize);
  deletedActivities += agedHistory.deletedActivities;
  deletedEvents += agedHistory.deletedEvents;
  deletedSnapshots += agedHistory.deletedSnapshots;

  const [deliveryCodeResult, markerResult] = await Promise.all([
    prisma.deliveryCodeAssignment.deleteMany({
      where: {
        shop,
        active: false,
        releasedAt: { lt: purgeCutoff },
      },
    }),
    prisma.courierHistoryPurge.deleteMany({
      where: {
        shop,
        cutoffAt: { lt: purgeCutoff },
      },
    }),
  ]);
  deletedDeliveryCodes += Number(deliveryCodeResult.count || 0);
  purgedOrderMarkers += Number(markerResult.count || 0);

  return {
    purgedOrderMarkers,
    purgedScheduledOrderMarkers,
    deletedActivities,
    deletedEvents,
    deletedSnapshots,
    deletedDeliveryCodes,
  };
}

async function purgeHistoryBatch({ shop, session, inputs, logger }) {
  const purgeCutoff = cutoffDateFromDays(inputs.purgeDays);
  let deletedRequests = 0;
  let keepRunning = true;

  while (keepRunning) {
    const batch = await prisma.returnRequest.findMany({
      where: {
        ...historyWhere(shop),
        updatedAt: { lt: purgeCutoff },
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: inputs.batchSize,
    });
    if (!batch.length) {
      keepRunning = false;
      continue;
    }
    const ids = batch.map((row) => row.id);
    const deleted = await prisma.returnRequest.deleteMany({
      where: { id: { in: ids } },
    });
    deletedRequests += Number(deleted.count || 0);
  }

  const courierHistory = await purgeCourierHistoryBatch({ shop, session, inputs, logger });
  return { deletedRequests, courierHistory };
}

export async function runMaintenanceCleanupForAllShops({ logger = console } = {}) {
  await ensureStockArchivedProductCleanupStorage();
  const [settingsRows, sessionsByShop] = await Promise.all([
    prisma.returnSettings.findMany({
      select: {
        shop: true,
        maintenanceEvidenceDays: true,
        maintenancePurgeDays: true,
        maintenanceBatchSize: true,
        stockArchivedProductCleanupDays: true,
      },
    }),
    resolveAllShopSessions(),
  ]);

  const settingsByShop = new Map(settingsRows.map((row) => [normalizeShop(row.shop), row]));
  for (const shop of sessionsByShop.keys()) {
    if (!settingsByShop.has(shop)) settingsByShop.set(shop, { shop });
  }

  const totals = {
    shopCount: 0,
    touchedRequests: 0,
    cleanedPhotos: 0,
    deletedRequests: 0,
    deletedActivities: 0,
    deletedEvents: 0,
    deletedSnapshots: 0,
    deletedDeliveryCodes: 0,
    purgedOrderMarkers: 0,
    purgedScheduledOrderMarkers: 0,
    deletedArchivedProducts: 0,
    skippedArchivedProducts: 0,
    deletedStockHistoryRecords: 0,
  };
  const shops = [];

  for (const [shop, settings] of settingsByShop.entries()) {
    if (!shop) continue;
    const inputs = normalizeMaintenanceInputs(settings);
    const session = sessionsByShop.get(shop)?.[0] || null;
    const evidenceResult = await cleanupEvidenceBatch(shop, inputs);
    const purgeResult = await purgeHistoryBatch({ shop, session, inputs, logger });
    const archivedProductCleanup = session
      ? await deleteExpiredArchivedStockProducts({
          shop,
          cleanupDays: inputs.archivedProductCleanupDays,
          batchSize: inputs.batchSize,
          graphqlRequest: async (query, variables) => {
            const payload = await shopifyGraphql({
              shop,
              session,
              query,
              variables,
            });
            return payload?.data || {};
          },
        }).catch((error) => {
          logger.error?.("No se pudo limpiar productos archivados de stock", {
            shop,
            error: String(error?.message || error || "unknown"),
          });
          return { deletedProducts: 0, skippedProducts: 0, deletedStockHistoryRecords: 0 };
        })
      : { deletedProducts: 0, skippedProducts: 0, deletedStockHistoryRecords: 0 };
    const shopResult = {
      shop,
      inputs,
      touchedRequests: evidenceResult.touchedRequests,
      cleanedPhotos: evidenceResult.cleanedPhotos,
      deletedRequests: purgeResult.deletedRequests,
      deletedArchivedProducts: archivedProductCleanup.deletedProducts || 0,
      skippedArchivedProducts: archivedProductCleanup.skippedProducts || 0,
      deletedStockHistoryRecords: archivedProductCleanup.deletedStockHistoryRecords || 0,
      ...purgeResult.courierHistory,
    };
    shops.push(shopResult);
    totals.shopCount += 1;
    totals.touchedRequests += shopResult.touchedRequests;
    totals.cleanedPhotos += shopResult.cleanedPhotos;
    totals.deletedRequests += shopResult.deletedRequests;
    totals.deletedActivities += shopResult.deletedActivities;
    totals.deletedEvents += shopResult.deletedEvents;
    totals.deletedSnapshots += shopResult.deletedSnapshots;
    totals.deletedDeliveryCodes += shopResult.deletedDeliveryCodes;
    totals.purgedOrderMarkers += shopResult.purgedOrderMarkers;
    totals.purgedScheduledOrderMarkers += shopResult.purgedScheduledOrderMarkers;
    totals.deletedArchivedProducts += shopResult.deletedArchivedProducts;
    totals.skippedArchivedProducts += shopResult.skippedArchivedProducts;
    totals.deletedStockHistoryRecords += shopResult.deletedStockHistoryRecords;
  }

  return { ...totals, shops };
}

export function startMaintenanceCleanupScheduler({ logger = console } = {}) {
  if (globalThis[SCHEDULER_FLAG]) return;
  globalThis[SCHEDULER_FLAG] = true;

  const runAndScheduleNext = async (reason) => {
    try {
      const result = await runMaintenanceCleanupForAllShops({ logger });
      logger.info?.("Maintenance cleanup scheduler completed", { reason, ...result });
    } catch (error) {
      logger.error?.("Maintenance cleanup scheduler failed", {
        reason,
        error: String(error?.message || error || "unknown"),
      });
    } finally {
      scheduleNext();
    }
  };

  const scheduleNext = () => {
    const delay = msUntilNextMexicoMidnight();
    globalThis[SCHEDULER_TIMER] = setTimeout(() => runAndScheduleNext("mexico_midnight"), delay);
    globalThis[SCHEDULER_TIMER]?.unref?.();
  };

  globalThis[SCHEDULER_TIMER] = setTimeout(() => runAndScheduleNext("startup_catchup"), 10000);
  globalThis[SCHEDULER_TIMER]?.unref?.();
}
