import { useEffect, useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import styles from "../styles/admin.module.css";
import {
  ensureFinancePriceSettingsStorage,
  saveFinancePriceSettingsVersion,
} from "../utils/financePriceSettings.server";
import {
  FINANCE_PRICE_SETTINGS_DEFAULTS,
  normalizeFinancePriceAmount,
  normalizeFinancePricePercent,
  normalizeFinancePriceSettings,
} from "../utils/financePrice.shared";
import {
  ensureStockArchivedProductCleanupStorage,
  normalizeStockArchivedProductCleanupDays,
} from "../utils/stockZeroInventoryArchive.server";
import {
  normalizeStockPriceAmount,
  normalizeStockPricePercent,
  normalizeStockPriceSettings,
  STOCK_PRICE_SETTINGS_DEFAULTS,
} from "../utils/stockPrice.shared";

const HISTORY_STATUSES = [
  "reembolsada",
  "rechazada",
  "denegada",
  "reembolso_denegado",
  "no_devuelto",
];
const COURIER_HISTORY_FINAL_ACTIONS = [
  "courier_mark_delivered",
  "courier_mark_not_delivered",
  "courier_route_order_not_located",
  "courier_return_mark_received",
  "courier_return_pickup_attempt_failed",
  "courier_return_reject_after_failed_pickups",
  "courier_branch_pickup_refunded",
  "courier_order_refund_detail",
];
const COURIER_HISTORY_FINAL_STATUSES = [
  "entregado",
  "recibido",
  "recibida",
  "rechazada",
  "no_recibido",
  "no_entregado",
  "reembolsada",
];
const DEFAULT_EVIDENCE_DAYS = 120;
const DEFAULT_PURGE_DAYS = 180;
const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_ARCHIVED_PRODUCT_CLEANUP_DAYS = 45;
const MAX_BATCH_SIZE = 500;
const COURIER_HISTORY_SINCE = new Date("2026-06-10T00:00:00-06:00");
const BRANCH_PICKUP_STATUSES = new Set([
  "por_devolver",
  "no_devuelto",
  "reembolso_denegado",
  "denegada",
]);
const NOTIFICATIONS_API_BASE_URL = String(
  process.env.NOTIFICATIONS_API_URL ||
    "https://centro-de-notificaciones-cariana.onrender.com",
).replace(/\/+$/, "");
const NOTIFICATIONS_API_KEYS = Array.from(
  new Set(
    [process.env.NOTIFICATIONS_API_KEY, process.env.APP_INTERNAL_API_KEY]
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  ),
);

async function ensureStockPriceSettingsStorage() {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "ReturnSettings" ADD COLUMN IF NOT EXISTS "stockProfitPercent" DOUBLE PRECISION NOT NULL DEFAULT 50`,
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "ReturnSettings" ADD COLUMN IF NOT EXISTS "stockTaxPercent" DOUBLE PRECISION NOT NULL DEFAULT 10`,
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "ReturnSettings" ADD COLUMN IF NOT EXISTS "stockShopifyCommission" DOUBLE PRECISION NOT NULL DEFAULT 3`,
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "ReturnSettings" ADD COLUMN IF NOT EXISTS "stockOperationalCost" DOUBLE PRECISION NOT NULL DEFAULT 15`,
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "ReturnSettings" ADD COLUMN IF NOT EXISTS "stockTransactionPercent" DOUBLE PRECISION NOT NULL DEFAULT 3`,
  );
}

function parsePositiveInt(
  value,
  fallback,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.floor(parsed);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function cutoffDateFromDays(days) {
  const at = new Date();
  at.setHours(0, 0, 0, 0);
  at.setDate(at.getDate() - days);
  return at;
}

function normalizeCourierAttrKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function getCourierCustomAttribute(orderNode, candidateKeys) {
  const attributes = Array.isArray(orderNode?.customAttributes)
    ? orderNode.customAttributes
    : [];
  const normalizedKeys = new Set(
    (candidateKeys || []).map((key) => normalizeCourierAttrKey(key)),
  );
  const match = attributes.find((attribute) =>
    normalizedKeys.has(normalizeCourierAttrKey(attribute?.key)),
  );
  return String(match?.value || "").trim();
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
  if (!Number.isFinite(createdAt.getTime()))
    return String(orderNode?.createdAt || "");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(createdAt);
  const lookup = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return new Date(
    Date.UTC(
      Number(lookup.year),
      Number(lookup.month) - 1,
      Number(lookup.day) + 1,
    ),
  )
    .toISOString()
    .slice(0, 10);
}

function parseCourierDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const date = raw.includes("T") ? new Date(raw) : new Date(`${raw}T00:00:00`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function courierScheduledDateIsBeforeCutoff(value, cutoff) {
  const date = parseCourierDate(value);
  return Boolean(date && date.getTime() < cutoff.getTime());
}

function isCourierLocalDeliveryOrder(orderNode) {
  const shippingLines = Array.isArray(orderNode?.shippingLines?.nodes)
    ? orderNode.shippingLines.nodes
    : [];
  return shippingLines.some((line) => {
    const title = String(line?.title || "").toLowerCase();
    const code = String(line?.code || "").toLowerCase();
    const category = String(line?.deliveryCategory || "").toLowerCase();
    return (
      title.includes("local") ||
      code.includes("local") ||
      category.includes("local")
    );
  });
}

function getCourierRouteStatusFromTags(tags = []) {
  const normalizedTags = (Array.isArray(tags) ? tags : []).map((tag) =>
    String(tag || "")
      .trim()
      .toLowerCase(),
  );
  if (normalizedTags.includes("reembolsada")) return "reembolsada";
  if (normalizedTags.includes("entregado")) return "entregado";
  if (normalizedTags.includes("recoger en sucursal"))
    return "recoger_en_sucursal";
  return "";
}

function normalizeMaintenanceInputs(formDataLike) {
  const evidenceDays = parsePositiveInt(
    formDataLike?.get?.("evidenceDays"),
    DEFAULT_EVIDENCE_DAYS,
    1,
    2000,
  );
  const purgeDays = parsePositiveInt(
    formDataLike?.get?.("purgeDays"),
    DEFAULT_PURGE_DAYS,
    evidenceDays + 1,
    5000,
  );
  const batchSize = parsePositiveInt(
    formDataLike?.get?.("batchSize"),
    DEFAULT_BATCH_SIZE,
    25,
    MAX_BATCH_SIZE,
  );
  const archivedProductCleanupRaw = String(
    formDataLike?.get?.("archivedProductCleanupDays") || "",
  ).trim();
  const archivedProductCleanupDays = /^no\s+eliminar/i.test(
    archivedProductCleanupRaw,
  )
    ? 0
    : normalizeStockArchivedProductCleanupDays(archivedProductCleanupRaw) ||
      DEFAULT_ARCHIVED_PRODUCT_CLEANUP_DAYS;
  return { evidenceDays, purgeDays, batchSize, archivedProductCleanupDays };
}

function maintenanceInputsFromSettings(settings) {
  return normalizeMaintenanceInputs({
    get(name) {
      if (name === "evidenceDays") return settings?.maintenanceEvidenceDays;
      if (name === "purgeDays") return settings?.maintenancePurgeDays;
      if (name === "batchSize") return settings?.maintenanceBatchSize;
      if (name === "archivedProductCleanupDays") {
        return normalizeStockArchivedProductCleanupDays(
          settings?.stockArchivedProductCleanupDays,
        )
          ? settings?.stockArchivedProductCleanupDays
          : "No eliminar automaticamente";
      }
      return "";
    },
  });
}

function historyWhere(shop) {
  return {
    shop,
    status: { in: HISTORY_STATUSES },
  };
}

async function getMaintenancePreview(shop, inputs) {
  await ensureStockArchivedProductCleanupStorage();
  const evidenceCutoff = cutoffDateFromDays(inputs.evidenceDays);
  const purgeCutoff = cutoffDateFromDays(inputs.purgeDays);
  const archivedProductCleanupCutoff = inputs.archivedProductCleanupDays
    ? cutoffDateFromDays(inputs.archivedProductCleanupDays)
    : null;
  const baseWhere = historyWhere(shop);
  const purgedCourierHistoryRows = await prisma.courierHistoryPurge.findMany({
    where: { shop },
    select: { requestId: true },
    take: inputs.batchSize,
  });
  const purgedCourierHistoryRequestIds = purgedCourierHistoryRows
    .map((row) => String(row.requestId || "").trim())
    .filter(Boolean);
  const purgedCourierWhere = purgedCourierHistoryRequestIds.length
    ? { shop, requestId: { in: purgedCourierHistoryRequestIds } }
    : null;

  const [
    historyTotal,
    purgeCandidates,
    oldestHistory,
    evidenceItemCandidates,
    courierActivityTotal,
    courierEventTotal,
    courierSnapshotTotal,
    courierActivityCandidates,
    courierEventCandidates,
    courierSnapshotCandidates,
    oldestCourierActivity,
    oldestCourierEvent,
    oldestCourierSnapshot,
    archivedProductTotal,
    archivedProductCandidates,
    oldestArchivedProduct,
  ] = await Promise.all([
    prisma.returnRequest.count({ where: baseWhere }),
    prisma.returnRequest.count({
      where: {
        ...baseWhere,
        updatedAt: { lt: purgeCutoff },
      },
    }),
    prisma.returnRequest.findFirst({
      where: baseWhere,
      orderBy: { updatedAt: "asc" },
      select: { updatedAt: true },
    }),
    prisma.returnItem.count({
      where: {
        photoDataUrl: { not: null },
        returnRequest: {
          ...baseWhere,
          updatedAt: { lt: evidenceCutoff },
        },
      },
    }),
    prisma.courierActivity.count({ where: { shop } }),
    prisma.courierEvent.count({ where: { shop } }),
    prisma.courierRouteSnapshot.count({ where: { shop } }),
    purgedCourierWhere
      ? prisma.courierActivity.count({ where: purgedCourierWhere })
      : Promise.resolve(0),
    purgedCourierWhere
      ? prisma.courierEvent.count({ where: purgedCourierWhere })
      : Promise.resolve(0),
    Promise.resolve(0),
    prisma.courierActivity.findFirst({
      where: { shop },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    prisma.courierEvent.findFirst({
      where: { shop },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    prisma.courierRouteSnapshot.findFirst({
      where: { shop },
      orderBy: { finishedAt: "asc" },
      select: { finishedAt: true },
    }),
    prisma.stockArchivedProduct.count({ where: { shop, deletedAt: null } }),
    archivedProductCleanupCutoff
      ? prisma.stockArchivedProduct.count({
          where: {
            shop,
            deletedAt: null,
            archivedAt: { lt: archivedProductCleanupCutoff },
          },
        })
      : Promise.resolve(0),
    prisma.stockArchivedProduct.findFirst({
      where: { shop, deletedAt: null },
      orderBy: { archivedAt: "asc" },
      select: { archivedAt: true },
    }),
  ]);

  const oldestCourierHistoryDates = [
    oldestCourierActivity?.createdAt,
    oldestCourierEvent?.createdAt,
    oldestCourierSnapshot?.finishedAt,
  ]
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((date) => Number.isFinite(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());

  return {
    historyTotal,
    purgeCandidates,
    evidenceItemCandidates,
    oldestHistoryAt: oldestHistory?.updatedAt
      ? oldestHistory.updatedAt.toISOString()
      : "",
    courierHistoryTotal:
      courierActivityTotal + courierEventTotal + courierSnapshotTotal,
    courierHistoryCandidates:
      courierActivityCandidates +
      courierEventCandidates +
      courierSnapshotCandidates,
    courierActivityCandidates,
    courierEventCandidates,
    courierSnapshotCandidates,
    oldestCourierHistoryAt: oldestCourierHistoryDates[0]?.toISOString?.() || "",
    evidenceCutoff: evidenceCutoff.toISOString(),
    purgeCutoff: purgeCutoff.toISOString(),
    archivedProductCleanupCutoff:
      archivedProductCleanupCutoff?.toISOString?.() || "",
    archivedProductTotal,
    archivedProductCandidates,
    oldestArchivedProductAt: oldestArchivedProduct?.archivedAt
      ? oldestArchivedProduct.archivedAt.toISOString()
      : "",
  };
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
      data: {
        photoDataUrl: null,
      },
    });

    touchedRequests += ids.length;
    cleanedPhotos += Number(updated.count || 0);
  }

  return { touchedRequests, cleanedPhotos };
}

function isPurgeableCourierRequestId(value) {
  const requestId = String(value || "").trim();
  return Boolean(
    requestId &&
    !requestId.startsWith("route:") &&
    !requestId.startsWith("session:"),
  );
}

function snapshotOrderEntries(snapshot) {
  return (Array.isArray(snapshot?.orders) ? snapshot.orders : [])
    .map((order) => ({
      requestId: String(order?.id || "").trim(),
      orderNumber:
        String(order?.orderNumber || "")
          .replace(/^#/, "")
          .trim() || null,
    }))
    .filter((entry) => isPurgeableCourierRequestId(entry.requestId));
}

async function fetchScheduledCourierHistoryOrderNodes(admin) {
  const response = await admin.graphql(
    `#graphql
    query ScheduledCourierHistoryOrders {
      orders(first: 250, query: "updated_at:>=2026-06-10", sortKey: UPDATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            createdAt
            updatedAt
            tags
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
    throw new Error(
      errors[0]?.message ||
        "No se pudo cargar el historial programado repartidor.",
    );
  }
  return (
    payload?.data?.orders?.edges?.map((edge) => edge?.node).filter(Boolean) ||
    []
  );
}

async function collectScheduledCourierHistoryPurgeEntries(
  admin,
  shop,
  purgeCutoff,
  batchSize,
) {
  const entriesByRequestId = new Map();

  try {
    for (const orderNode of await fetchScheduledCourierHistoryOrderNodes(
      admin,
    )) {
      const requestId = String(orderNode?.id || "").trim();
      if (!isPurgeableCourierRequestId(requestId)) continue;
      const status = getCourierRouteStatusFromTags(orderNode?.tags);
      const updatedAt = new Date(
        orderNode?.updatedAt || orderNode?.createdAt || 0,
      );
      if (
        !isCourierLocalDeliveryOrder(orderNode) ||
        !["entregado", "reembolsada"].includes(status) ||
        !Number.isFinite(updatedAt.getTime()) ||
        updatedAt.getTime() < COURIER_HISTORY_SINCE.getTime()
      ) {
        continue;
      }
      const scheduledDate = getInitialCourierScheduledDate(orderNode);
      if (!courierScheduledDateIsBeforeCutoff(scheduledDate, purgeCutoff))
        continue;
      entriesByRequestId.set(requestId, {
        shop,
        requestId,
        orderNumber:
          String(orderNode?.name || "")
            .replace(/^#/, "")
            .trim() || null,
        cutoffAt: purgeCutoff,
      });
      if (entriesByRequestId.size >= batchSize) break;
    }
  } catch (error) {
    console.error(
      "No se pudieron marcar ordenes Shopify programadas para purga",
      error,
    );
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
      select: {
        id: true,
        orderNumber: true,
        pickupDate: true,
        createdAt: true,
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: batchSize,
    });
    for (const requestRow of pickupRows) {
      const requestId = `pickup-${requestRow.id}`;
      const scheduledDate = String(
        requestRow.pickupDate || requestRow.createdAt || "",
      ).trim();
      if (!courierScheduledDateIsBeforeCutoff(scheduledDate, purgeCutoff))
        continue;
      entriesByRequestId.set(requestId, {
        shop,
        requestId,
        orderNumber:
          String(requestRow.orderNumber || "")
            .replace(/^#/, "")
            .trim() || null,
        cutoffAt: purgeCutoff,
      });
      if (entriesByRequestId.size >= batchSize) break;
    }
  }

  return Array.from(entriesByRequestId.values());
}

async function deleteCourierRouteSnapshotsForPurgedOrders(
  shop,
  purgedRequestIds,
  batchSize,
) {
  const purgedRequestIdSet = new Set(
    (Array.isArray(purgedRequestIds) ? purgedRequestIds : [])
      .map((requestId) => String(requestId || "").trim())
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
      return (
        entries.length > 0 &&
        entries.every((entry) => purgedRequestIdSet.has(entry.requestId))
      );
    })
    .map((snapshot) => snapshot.id);
  if (!removableIds.length) return 0;

  const result = await prisma.courierRouteSnapshot.deleteMany({
    where: { id: { in: removableIds } },
  });
  return Number(result.count || 0);
}

async function purgeCourierHistoryBatch(admin, shop, inputs) {
  const purgeCutoff = cutoffDateFromDays(inputs.purgeDays);
  let purgedOrderMarkers = 0;
  let purgedScheduledOrderMarkers = 0;
  let deletedActivities = 0;
  let deletedEvents = 0;
  let deletedSnapshots = 0;
  let deletedDeliveryCodes = 0;

  const scheduledPurgeEntries =
    await collectScheduledCourierHistoryPurgeEntries(
      admin,
      shop,
      purgeCutoff,
      inputs.batchSize,
    );
  if (scheduledPurgeEntries.length) {
    const scheduledResult = await prisma.courierHistoryPurge.createMany({
      data: scheduledPurgeEntries,
      skipDuplicates: true,
    });
    purgedScheduledOrderMarkers += Number(scheduledResult.count || 0);
  }

  const purgedRequestIds = scheduledPurgeEntries
    .map((entry) => String(entry.requestId || "").trim())
    .filter(Boolean);
  if (purgedRequestIds.length) {
    const [activityResult, eventResult, deliveryCodeResult] = await Promise.all(
      [
        prisma.courierActivity.deleteMany({
          where: { shop, requestId: { in: purgedRequestIds } },
        }),
        prisma.courierEvent.deleteMany({
          where: { shop, requestId: { in: purgedRequestIds } },
        }),
        prisma.deliveryCodeAssignment.deleteMany({
          where: {
            shop,
            active: false,
            releasedAt: { lt: purgeCutoff },
          },
        }),
      ],
    );
    deletedActivities += Number(activityResult.count || 0);
    deletedEvents += Number(eventResult.count || 0);
    deletedDeliveryCodes += Number(deliveryCodeResult.count || 0);
    deletedSnapshots += await deleteCourierRouteSnapshotsForPurgedOrders(
      shop,
      purgedRequestIds,
      inputs.batchSize,
    );
  }

  return {
    purgedOrderMarkers,
    purgedScheduledOrderMarkers,
    deletedActivities,
    deletedEvents,
    deletedSnapshots,
    deletedDeliveryCodes,
  };
}

async function purgeHistoryBatch(admin, shop, inputs) {
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

  const courierHistory = await purgeCourierHistoryBatch(admin, shop, inputs);

  return { deletedRequests, courierHistory };
}
async function getOrCreateSettings(shop) {
  const existing = await prisma.returnSettings.findUnique({ where: { shop } });
  if (existing) return existing;
  return prisma.returnSettings.create({ data: { shop } });
}

async function syncReturnSettingsToNotifications(shopDomain, settings) {
  if (
    !shopDomain ||
    !NOTIFICATIONS_API_BASE_URL ||
    !NOTIFICATIONS_API_KEYS.length
  )
    return;

  for (const apiKey of NOTIFICATIONS_API_KEYS) {
    try {
      const response = await fetch(
        `${NOTIFICATIONS_API_BASE_URL}/api/return-settings`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-shop-domain": shopDomain,
            "x-api-key": apiKey,
          },
          body: JSON.stringify({
            shopDomain,
            branchAddress: settings.branchAddress,
            branchHours: settings.branchHours,
            pickupHours: settings.pickupHours,
          }),
        },
      );
      if (response.ok) return;
      const detail = await response.text().catch(() => "");
      console.error(
        "No se pudo sincronizar la configuracion con notificaciones",
        {
          shopDomain,
          status: response.status,
          detail: String(detail || "").slice(0, 300),
        },
      );
    } catch (error) {
      console.error(
        "No se pudo sincronizar la configuracion con notificaciones",
        {
          shopDomain,
          error: String(error?.message || error || "unknown"),
        },
      );
    }
  }
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  await ensureStockArchivedProductCleanupStorage();
  await ensureStockPriceSettingsStorage();
  await ensureFinancePriceSettingsStorage();
  const settings = await getOrCreateSettings(session.shop);
  const inputs = maintenanceInputsFromSettings(settings);
  const preview = await getMaintenancePreview(session.shop, inputs);
  return { settings, maintenance: { inputs, preview } };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  await ensureStockArchivedProductCleanupStorage();
  await ensureStockPriceSettingsStorage();
  await ensureFinancePriceSettingsStorage();
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "update_settings") {
    const nextSettings = {
      pickupCost: Number(formData.get("pickupCost") || 0),
      returnWindowDays: Number(formData.get("returnWindowDays") || 30),
      returnReasons: String(formData.get("returnReasons") || ""),
      evidenceReasons: String(formData.get("evidenceReasons") || ""),
      branchInstructions: String(formData.get("branchInstructions") || ""),
      branchAddress: String(formData.get("branchAddress") || ""),
      branchHours: String(formData.get("branchHours") || ""),
      pickupInstructions: String(formData.get("pickupInstructions") || ""),
      pickupHours: String(formData.get("pickupHours") || ""),
    };
    await prisma.returnSettings.upsert({
      where: { shop: session.shop },
      update: nextSettings,
      create: {
        shop: session.shop,
        ...nextSettings,
      },
    });
    await syncReturnSettingsToNotifications(session.shop, nextSettings);
    return { ok: true, intent, message: "Configuracion guardada." };
  }

  if (intent === "update_stock_price_settings") {
    const nextSettings = {
      stockProfitPercent: normalizeStockPricePercent(
        formData.get("stockProfitPercent"),
        STOCK_PRICE_SETTINGS_DEFAULTS.profitPercent,
      ),
      stockTaxPercent: normalizeStockPricePercent(
        formData.get("stockTaxPercent"),
        STOCK_PRICE_SETTINGS_DEFAULTS.taxPercent,
      ),
      stockShopifyCommission: normalizeStockPriceAmount(
        formData.get("stockShopifyCommission"),
        STOCK_PRICE_SETTINGS_DEFAULTS.shopifyCommission,
      ),
      stockOperationalCost: normalizeStockPriceAmount(
        formData.get("stockOperationalCost"),
        STOCK_PRICE_SETTINGS_DEFAULTS.operationalCost,
      ),
      stockTransactionPercent: normalizeStockPricePercent(
        formData.get("stockTransactionPercent"),
        STOCK_PRICE_SETTINGS_DEFAULTS.transactionPercent,
      ),
    };
    await prisma.returnSettings.upsert({
      where: { shop: session.shop },
      update: nextSettings,
      create: {
        shop: session.shop,
        ...nextSettings,
      },
    });
    return { ok: true, intent, message: "Porcentajes del precio guardados." };
  }

  if (intent === "update_finance_price_settings") {
    const nextSettings = {
      profitPercent: normalizeFinancePricePercent(
        formData.get("financeProfitPercent"),
        FINANCE_PRICE_SETTINGS_DEFAULTS.profitPercent,
      ),
      taxPercent: normalizeFinancePricePercent(
        formData.get("financeTaxPercent"),
        FINANCE_PRICE_SETTINGS_DEFAULTS.taxPercent,
      ),
      shopifyCommission: normalizeFinancePriceAmount(
        formData.get("financeShopifyCommission"),
        FINANCE_PRICE_SETTINGS_DEFAULTS.shopifyCommission,
      ),
      operationalCost: normalizeFinancePriceAmount(
        formData.get("financeOperationalCost"),
        FINANCE_PRICE_SETTINGS_DEFAULTS.operationalCost,
      ),
      transactionPercent: normalizeFinancePricePercent(
        formData.get("financeTransactionPercent"),
        FINANCE_PRICE_SETTINGS_DEFAULTS.transactionPercent,
      ),
      highProfitThreshold: normalizeFinancePriceAmount(
        formData.get("financeHighProfitThreshold"),
        FINANCE_PRICE_SETTINGS_DEFAULTS.highProfitThreshold,
      ),
      highProfitPercent: normalizeFinancePricePercent(
        formData.get("financeHighProfitPercent"),
        FINANCE_PRICE_SETTINGS_DEFAULTS.highProfitPercent,
      ),
      veryHighProfitThreshold: normalizeFinancePriceAmount(
        formData.get("financeVeryHighProfitThreshold"),
        FINANCE_PRICE_SETTINGS_DEFAULTS.veryHighProfitThreshold,
      ),
      veryHighProfitPercent: normalizeFinancePricePercent(
        formData.get("financeVeryHighProfitPercent"),
        FINANCE_PRICE_SETTINGS_DEFAULTS.veryHighProfitPercent,
      ),
    };
    await saveFinancePriceSettingsVersion({
      shop: session.shop,
      settings: nextSettings,
    });
    return {
      ok: true,
      intent,
      message: "Porcentajes de finanzas guardados. Se aplicaran desde ahora en adelante.",
    };
  }

  if (
    intent !== "maintenance_preview" &&
    intent !== "maintenance_save_settings" &&
    intent !== "maintenance_cleanup_evidence" &&
    intent !== "maintenance_purge_history"
  ) {
    return { ok: false, intent, error: "Accion no valida." };
  }

  const inputs = normalizeMaintenanceInputs(formData);

  if (intent === "maintenance_preview") {
    const preview = await getMaintenancePreview(session.shop, inputs);
    return {
      ok: true,
      intent,
      message: "Vista previa actualizada.",
      maintenance: { inputs, preview },
    };
  }

  if (intent === "maintenance_save_settings") {
    await prisma.returnSettings.upsert({
      where: { shop: session.shop },
      update: {
        maintenanceEvidenceDays: inputs.evidenceDays,
        maintenancePurgeDays: inputs.purgeDays,
        maintenanceBatchSize: inputs.batchSize,
        stockArchivedProductCleanupDays: inputs.archivedProductCleanupDays,
      },
      create: {
        shop: session.shop,
        maintenanceEvidenceDays: inputs.evidenceDays,
        maintenancePurgeDays: inputs.purgeDays,
        maintenanceBatchSize: inputs.batchSize,
        stockArchivedProductCleanupDays: inputs.archivedProductCleanupDays,
      },
    });
    const preview = await getMaintenancePreview(session.shop, inputs);
    return {
      ok: true,
      intent,
      message: "Configuracion de limpieza guardada.",
      maintenance: { inputs, preview },
    };
  }

  if (intent === "maintenance_cleanup_evidence") {
    const result = await cleanupEvidenceBatch(session.shop, inputs);
    const preview = await getMaintenancePreview(session.shop, inputs);
    return {
      ok: true,
      intent,
      message: `Limpieza completada. Solicitudes revisadas: ${result.touchedRequests}. Fotos eliminadas: ${result.cleanedPhotos}.`,
      maintenance: { inputs, preview, result },
    };
  }

  const confirmPhrase = String(formData.get("confirmPhrase") || "")
    .trim()
    .toUpperCase();
  if (confirmPhrase !== "BORRAR") {
    const preview = await getMaintenancePreview(session.shop, inputs);
    return {
      ok: false,
      intent,
      error: 'Escribe "BORRAR" para confirmar la purga definitiva.',
      maintenance: { inputs, preview },
    };
  }

  const result = await purgeHistoryBatch(admin, session.shop, inputs);
  const preview = await getMaintenancePreview(session.shop, inputs);
  return {
    ok: true,
    intent,
    message: `Purga completada. Ordenes de devoluciones eliminadas: ${result.deletedRequests}. Historial repartidor eliminado: ${result.courierHistory.deletedActivities} actividades, ${result.courierHistory.deletedEvents} eventos, ${result.courierHistory.deletedSnapshots} cierres de ruta. Ordenes programadas antiguas ocultadas: ${result.courierHistory.purgedScheduledOrderMarkers}.`,
    maintenance: { inputs, preview, result },
  };
};

function formatDateLabel(isoValue) {
  if (!isoValue) return "-";
  const date = new Date(isoValue);
  if (!Number.isFinite(date.getTime())) return "-";
  return date.toLocaleString("es-MX");
}

export default function ReturnsAdmin() {
  const { settings, maintenance: initialMaintenance } = useLoaderData();
  const stockPriceSettings = normalizeStockPriceSettings(settings);
  const financePriceSettings = normalizeFinancePriceSettings(settings);
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const maintenance = actionData?.maintenance || initialMaintenance;
  const maintenanceInputs =
    maintenance?.inputs || initialMaintenance?.inputs || {};
  const maintenancePreview =
    maintenance?.preview || initialMaintenance?.preview || {};
  const maintenanceFeedback =
    actionData?.intent &&
    actionData.intent !== "update_settings" &&
    actionData.intent !== "update_stock_price_settings" &&
    actionData.intent !== "update_finance_price_settings"
      ? actionData?.message || actionData?.error || ""
      : "";
  const maintenanceFeedbackClassName = actionData?.ok
    ? styles.successMsg
    : styles.errorMsg;
  const settingsFeedback =
    actionData?.intent === "update_settings" ||
    actionData?.intent === "update_stock_price_settings" ||
    actionData?.intent === "update_finance_price_settings"
      ? actionData?.message || actionData?.error || ""
      : "";
  const settingsFeedbackClassName = actionData?.ok
    ? styles.successMsg
    : styles.errorMsg;
  const [activeAdminSection, setActiveAdminSection] = useState("returns");
  const [visibleSettingsFeedback, setVisibleSettingsFeedback] = useState("");

  useEffect(() => {
    if (actionData?.intent === "update_stock_price_settings") {
      setActiveAdminSection("price");
      return;
    }
    if (actionData?.intent === "update_finance_price_settings") {
      setActiveAdminSection("financePrice");
      return;
    }
    if (actionData?.intent === "update_settings") {
      setActiveAdminSection("returns");
      return;
    }
    if (actionData?.intent && actionData.intent !== "update_settings") {
      setActiveAdminSection("maintenance");
    }
  }, [actionData?.intent]);

  useEffect(() => {
    if (!settingsFeedback) return;
    setVisibleSettingsFeedback(settingsFeedback);
    const timeoutId = window.setTimeout(
      () => setVisibleSettingsFeedback(""),
      4000,
    );
    return () => window.clearTimeout(timeoutId);
  }, [settingsFeedback]);

  return (
    <s-page heading="Panel admin de devoluciones">
      <div className={styles.adminTabs} role="tablist" aria-label="Secciones del panel admin">
        <button
          className={`${styles.adminTab} ${activeAdminSection === "returns" ? styles.adminTabActive : ""}`}
          type="button"
          aria-selected={activeAdminSection === "returns"}
          onClick={() => setActiveAdminSection("returns")}
        >
          Configuracion de devoluciones
        </button>
        <button
          className={`${styles.adminTab} ${activeAdminSection === "price" ? styles.adminTabActive : ""}`}
          type="button"
          aria-selected={activeAdminSection === "price"}
          onClick={() => setActiveAdminSection("price")}
        >
          Porcentajes del precio del producto
        </button>
        <button
          className={`${styles.adminTab} ${activeAdminSection === "maintenance" ? styles.adminTabActive : ""}`}
          type="button"
          aria-selected={activeAdminSection === "maintenance"}
          onClick={() => setActiveAdminSection("maintenance")}
        >
          Mantenimiento y limpieza
        </button>
        <button
          className={`${styles.adminTab} ${activeAdminSection === "financePrice" ? styles.adminTabActive : ""}`}
          type="button"
          aria-selected={activeAdminSection === "financePrice"}
          onClick={() => setActiveAdminSection("financePrice")}
        >
          Porcentaje de la app de finanzas
        </button>
      </div>

      {activeAdminSection === "returns" ? (
      <s-section heading="Configuracion de devoluciones">
        <Form method="post">
          <input type="hidden" name="intent" value="update_settings" />
          <div className={styles.wrap}>
            <div className={`${styles.card} ${styles.grid}`}>
              <div className={styles.grid2}>
                <label className={styles.label}>
                  Costo de recoleccion (MXN)
                  <span className={styles.help}>
                    Costo que vera el cliente si elige recoleccion.
                  </span>
                  <input
                    className={styles.input}
                    name="pickupCost"
                    type="number"
                    step="0.01"
                    defaultValue={settings.pickupCost}
                  />
                </label>
                <label className={styles.label}>
                  Dias limite para devolucion
                  <span className={styles.help}>
                    Cuantos dias despues de la compra permites devolucion.
                  </span>
                  <input
                    className={styles.input}
                    name="returnWindowDays"
                    type="number"
                    defaultValue={settings.returnWindowDays}
                  />
                </label>
              </div>

              <label className={styles.label}>
                Direccion de sucursal
                <input
                  className={styles.input}
                  name="branchAddress"
                  defaultValue={settings.branchAddress}
                />
              </label>

              <div className={styles.grid2}>
                <label className={styles.label}>
                  Instrucciones entrega en sucursal
                  <textarea
                    className={styles.textarea}
                    name="branchInstructions"
                    defaultValue={settings.branchInstructions}
                  />
                </label>
                <label className={styles.label}>
                  Horarios entrega en sucursal
                  <input
                    className={styles.input}
                    name="branchHours"
                    defaultValue={settings.branchHours}
                  />
                </label>
              </div>

              <div className={styles.grid2}>
                <label className={styles.label}>
                  Instrucciones de recoleccion
                  <textarea
                    className={styles.textarea}
                    name="pickupInstructions"
                    defaultValue={settings.pickupInstructions}
                  />
                </label>
                <label className={styles.label}>
                  Horarios de recoleccion
                  <input
                    className={styles.input}
                    name="pickupHours"
                    defaultValue={settings.pickupHours}
                  />
                </label>
              </div>

              <div className={styles.grid2}>
                <label className={styles.label}>
                  Motivos de devolucion (uno por linea)
                  <span className={styles.help}>
                    Estos son los motivos que veran tus clientes al solicitar
                    devolucion.
                  </span>
                  <textarea
                    className={styles.textarea}
                    name="returnReasons"
                    defaultValue={settings.returnReasons || ""}
                    placeholder={
                      "Me quedo grande\nMe quedo chico\nNo era lo que pedi\nLlego danado\nOtro"
                    }
                  />
                </label>
                <label className={styles.label}>
                  Motivos que requieren evidencia (uno por linea)
                  <span className={styles.help}>
                    Si un motivo esta aqui, pediremos descripcion y al menos 1
                    foto.
                  </span>
                  <textarea
                    className={styles.textarea}
                    name="evidenceReasons"
                    defaultValue={settings.evidenceReasons || ""}
                    placeholder={"No era lo que pedi\nLlego danado"}
                  />
                </label>
              </div>


              <div className={styles.actions}>
                <button
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  type="submit"
                  disabled={isSubmitting}
                >
                  Guardar configuracion
                </button>
              </div>
              {visibleSettingsFeedback ? (
                <p
                  className={settingsFeedbackClassName}
                  role="status"
                  aria-live="polite"
                >
                  {visibleSettingsFeedback}
                </p>
              ) : null}
            </div>
          </div>
        </Form>
      </s-section>
      ) : null}

      {activeAdminSection === "price" ? (
      <s-section heading="Porcentajes del precio del producto">
        <Form method="post">
          <input type="hidden" name="intent" value="update_stock_price_settings" />
          <div className={styles.wrap}>
            <div className={`${styles.card} ${styles.grid}`}>
              <p className={styles.help}>
                Estos valores calculan el precio final que vera el publicador cuando stock marque un producto como listo.
              </p>
              <div className={styles.grid2}>
                <label className={styles.label}>
                  Ganancia (%)
                  <span className={styles.help}>Porcentaje que se suma sobre el costo base.</span>
                  <input
                    className={styles.input}
                    name="stockProfitPercent"
                    type="number"
                    min="0"
                    step="0.01"
                    defaultValue={stockPriceSettings.profitPercent}
                  />
                </label>
                <label className={styles.label}>
                  Impuestos (%)
                  <span className={styles.help}>Porcentaje que se suma sobre la ganancia.</span>
                  <input
                    className={styles.input}
                    name="stockTaxPercent"
                    type="number"
                    min="0"
                    step="0.01"
                    defaultValue={stockPriceSettings.taxPercent}
                  />
                </label>
              </div>
              <div className={styles.grid2}>
                <label className={styles.label}>
                  Comision de Shopify (MXN)
                  <span className={styles.help}>Cantidad fija en pesos que se suma al subtotal.</span>
                  <input
                    className={styles.input}
                    name="stockShopifyCommission"
                    type="number"
                    min="0"
                    step="0.01"
                    defaultValue={stockPriceSettings.shopifyCommission}
                  />
                </label>
                <label className={styles.label}>
                  Costo operativo (MXN)
                  <span className={styles.help}>Cantidad fija en pesos que se suma al subtotal.</span>
                  <input
                    className={styles.input}
                    name="stockOperationalCost"
                    type="number"
                    min="0"
                    step="0.01"
                    defaultValue={stockPriceSettings.operationalCost}
                  />
                </label>
              </div>
              <label className={styles.label}>
                Transaccion (%)
                <span className={styles.help}>Porcentaje aplicado despues de sumar ganancia, impuestos y costos fijos.</span>
                <input
                  className={styles.input}
                  name="stockTransactionPercent"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={stockPriceSettings.transactionPercent}
                />
              </label>
              <div className={styles.actions}>
                <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={isSubmitting}>
                  Guardar porcentajes
                </button>
              </div>
              {visibleSettingsFeedback ? (
                <p className={settingsFeedbackClassName} role="status" aria-live="polite">
                  {visibleSettingsFeedback}
                </p>
              ) : null}
            </div>
          </div>
        </Form>
      </s-section>
      ) : null}

      {activeAdminSection === "financePrice" ? (
      <s-section heading="Porcentaje de la app de finanzas">
        <Form method="post">
          <input type="hidden" name="intent" value="update_finance_price_settings" />
          <div className={styles.wrap}>
            <div className={`${styles.card} ${styles.grid}`}>
              <p className={styles.help}>
                Estos valores calculan las tarjetas del portal de finanzas. Al guardar, aplican solo desde ese momento en adelante.
              </p>
              <div className={styles.grid2}>
                <label className={styles.label}>
                  Ganancia (%)
                  <span className={styles.help}>Porcentaje base usado para calcular margen y costo recuperado.</span>
                  <input
                    className={styles.input}
                    name="financeProfitPercent"
                    type="number"
                    min="0"
                    step="0.01"
                    defaultValue={financePriceSettings.profitPercent}
                  />
                </label>
                <label className={styles.label}>
                  Impuestos (%)
                  <span className={styles.help}>Porcentaje aplicado sobre la ganancia.</span>
                  <input
                    className={styles.input}
                    name="financeTaxPercent"
                    type="number"
                    min="0"
                    step="0.01"
                    defaultValue={financePriceSettings.taxPercent}
                  />
                </label>
              </div>
              <div className={styles.grid2}>
                <label className={styles.label}>
                  Comision de Shopify (MXN)
                  <span className={styles.help}>Cantidad fija por producto.</span>
                  <input
                    className={styles.input}
                    name="financeShopifyCommission"
                    type="number"
                    min="0"
                    step="0.01"
                    defaultValue={financePriceSettings.shopifyCommission}
                  />
                </label>
                <label className={styles.label}>
                  Costo operativo (MXN)
                  <span className={styles.help}>Cantidad fija por producto.</span>
                  <input
                    className={styles.input}
                    name="financeOperationalCost"
                    type="number"
                    min="0"
                    step="0.01"
                    defaultValue={financePriceSettings.operationalCost}
                  />
                </label>
              </div>
              <label className={styles.label}>
                Transaccion (%)
                <span className={styles.help}>Porcentaje descontado al calcular el costo recuperado.</span>
                <input
                  className={styles.input}
                  name="financeTransactionPercent"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={financePriceSettings.transactionPercent}
                />
              </label>
              <div className={styles.financeTierRules}>
                <p className={styles.financeTierTitle}>Reglas de ganancia por monto</p>
                <label className={styles.financeTierRule}>
                  <span>Cantidad a llegar 1</span>
                  <span className={`${styles.financeTierInputGroup} ${styles.financeTierMoneyGroup}`}>
                    <span className={styles.financeTierAffix}>$</span>
                    <input
                      className={styles.input}
                      name="financeHighProfitThreshold"
                      type="number"
                      min="0"
                      step="0.01"
                      defaultValue={financePriceSettings.highProfitThreshold}
                    />
                  </span>
                  <span className={styles.financeTierEquals}>=</span>
                  <span className={`${styles.financeTierInputGroup} ${styles.financeTierPercentGroup}`}>
                    <input
                      className={styles.input}
                      name="financeHighProfitPercent"
                      type="number"
                      min="0"
                      step="0.01"
                      defaultValue={financePriceSettings.highProfitPercent}
                    />
                    <span className={styles.financeTierAffix}>%</span>
                  </span>
                </label>
                <label className={styles.financeTierRule}>
                  <span>Cantidad a llegar 2</span>
                  <span className={`${styles.financeTierInputGroup} ${styles.financeTierMoneyGroup}`}>
                    <span className={styles.financeTierAffix}>$</span>
                    <input
                      className={styles.input}
                      name="financeVeryHighProfitThreshold"
                      type="number"
                      min="0"
                      step="0.01"
                      defaultValue={financePriceSettings.veryHighProfitThreshold}
                    />
                  </span>
                  <span className={styles.financeTierEquals}>=</span>
                  <span className={`${styles.financeTierInputGroup} ${styles.financeTierPercentGroup}`}>
                    <input
                      className={styles.input}
                      name="financeVeryHighProfitPercent"
                      type="number"
                      min="0"
                      step="0.01"
                      defaultValue={financePriceSettings.veryHighProfitPercent}
                    />
                    <span className={styles.financeTierAffix}>%</span>
                  </span>
                </label>
              </div>
              <div className={styles.actions}>
                <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={isSubmitting}>
                  Guardar porcentajes de finanzas
                </button>
              </div>
              {visibleSettingsFeedback ? (
                <p className={settingsFeedbackClassName} role="status" aria-live="polite">
                  {visibleSettingsFeedback}
                </p>
              ) : null}
            </div>
          </div>
        </Form>
      </s-section>
      ) : null}

      {activeAdminSection === "maintenance" ? (
      <s-section heading="Mantenimiento y limpieza">
        <div className={styles.wrap}>
          <div className={`${styles.card} ${styles.grid}`}>
            <p className={styles.help}>
              Esta seccion elimina peso del historial sin tocar ordenes activas.
              Se ejecuta en lotes para evitar que la app se congele. La limpieza
              automatica usa los valores guardados aqui y corre cada madrugada.
            </p>

            <Form method="post" className={styles.grid}>
              <label className={styles.label}>
                Dias para eliminar despues de archivarse productos
                <span className={styles.help}>
                  Puedes poner el tiempo que necesites.
                </span>
                <input
                  className={styles.input}
                  name="archivedProductCleanupDays"
                  type="text"
                  inputMode="numeric"
                  list="archived-product-cleanup-options"
                  defaultValue={
                    maintenanceInputs.archivedProductCleanupDays
                      ? maintenanceInputs.archivedProductCleanupDays
                      : "No eliminar automaticamente"
                  }
                />
                <datalist id="archived-product-cleanup-options">
                  <option value="No eliminar automaticamente" />
                  <option value="10" />
                  <option value="20" />
                  <option value="30" />
                  <option value="45" />
                  <option value="60" />
                </datalist>
              </label>

              <div className={styles.grid2}>
                <label className={styles.label}>
                  Dias para limpiar evidencias
                  <span className={styles.help}>
                    Se borran solo fotos antiguas en historial (no elimina la
                    orden).
                  </span>
                  <input
                    className={styles.input}
                    name="evidenceDays"
                    type="number"
                    min="1"
                    defaultValue={
                      maintenanceInputs.evidenceDays || DEFAULT_EVIDENCE_DAYS
                    }
                  />
                </label>
                <label className={styles.label}>
                  Dias para purga definitiva
                  <span className={styles.help}>
                    Elimina por completo ordenes antiguas de historial y
                    registros antiguos del historial repartidor.
                  </span>
                  <input
                    className={styles.input}
                    name="purgeDays"
                    type="number"
                    min="2"
                    defaultValue={
                      maintenanceInputs.purgeDays || DEFAULT_PURGE_DAYS
                    }
                  />
                </label>
              </div>

              <label className={styles.label}>
                Tamano de lote
                <span className={styles.help}>
                  Recomendado: 100 a 300 para mantener buena velocidad.
                </span>
                <input
                  className={styles.input}
                  name="batchSize"
                  type="number"
                  min="25"
                  max={MAX_BATCH_SIZE}
                  defaultValue={
                    maintenanceInputs.batchSize || DEFAULT_BATCH_SIZE
                  }
                />
              </label>

              <div className={styles.maintenanceStats}>
                <p className={styles.statRow}>
                  Total de ordenes en historial:{" "}
                  {maintenancePreview.historyTotal || 0}
                </p>
                <p className={styles.statRow}>
                  Fotos de evidencia candidatas a limpieza:{" "}
                  {maintenancePreview.evidenceItemCandidates || 0}
                </p>
                <p className={styles.statRow}>
                  Ordenes candidatas a purga definitiva:{" "}
                  {maintenancePreview.purgeCandidates || 0}
                </p>
                <p className={styles.statRow}>
                  Registros en historial repartidor:{" "}
                  {maintenancePreview.courierHistoryTotal || 0}
                </p>
                <p className={styles.statRow}>
                  Registros de historial repartidor candidatos a purga:{" "}
                  {maintenancePreview.courierHistoryCandidates || 0}
                </p>
                <p className={styles.statRow}>
                  Actividades repartidor candidatas:{" "}
                  {maintenancePreview.courierActivityCandidates || 0}
                </p>
                <p className={styles.statRow}>
                  Eventos repartidor candidatos:{" "}
                  {maintenancePreview.courierEventCandidates || 0}
                </p>
                <p className={styles.statRow}>
                  Cierres de ruta candidatos:{" "}
                  {maintenancePreview.courierSnapshotCandidates || 0}
                </p>
                <p className={styles.statRow}>
                  Productos archivados rastreados:{" "}
                  {maintenancePreview.archivedProductTotal || 0}
                </p>
                <p className={styles.statRow}>
                  Productos archivados candidatos a eliminacion:{" "}
                  {maintenancePreview.archivedProductCandidates || 0}
                </p>
                <p className={styles.statRow}>
                  Limpieza de productos archivados:{" "}
                  {maintenanceInputs.archivedProductCleanupDays
                    ? `${maintenanceInputs.archivedProductCleanupDays} dias`
                    : "No eliminar automaticamente"}
                </p>
                <p className={styles.statRow}>
                  Corte de limpieza:{" "}
                  {formatDateLabel(maintenancePreview.evidenceCutoff)}
                </p>
                <p className={styles.statRow}>
                  Corte de purga:{" "}
                  {formatDateLabel(maintenancePreview.purgeCutoff)}
                </p>
                <p className={styles.statRow}>
                  Corte de productos archivados:{" "}
                  {formatDateLabel(
                    maintenancePreview.archivedProductCleanupCutoff,
                  )}
                </p>
                <p className={styles.statRow}>
                  Orden historica mas antigua:{" "}
                  {formatDateLabel(maintenancePreview.oldestHistoryAt)}
                </p>
                <p className={styles.statRow}>
                  Historial repartidor mas antiguo:{" "}
                  {formatDateLabel(maintenancePreview.oldestCourierHistoryAt)}
                </p>
                <p className={styles.statRow}>
                  Producto archivado mas antiguo:{" "}
                  {formatDateLabel(maintenancePreview.oldestArchivedProductAt)}
                </p>
              </div>

              <div className={styles.actions}>
                <button
                  className={styles.btn}
                  type="submit"
                  name="intent"
                  value="maintenance_preview"
                  disabled={isSubmitting}
                >
                  Actualizar vista previa
                </button>
                <button
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  type="submit"
                  name="intent"
                  value="maintenance_save_settings"
                  disabled={isSubmitting}
                >
                  Guardar configuracion de limpieza
                </button>
                <button
                  className={`${styles.btn} ${styles.btnWarning}`}
                  type="submit"
                  name="intent"
                  value="maintenance_cleanup_evidence"
                  disabled={isSubmitting}
                >
                  Limpiar evidencias antiguas
                </button>
              </div>

              <label className={styles.label}>
                Confirmacion de seguridad
                <span className={styles.help}>
                  Escribe BORRAR para confirmar la purga definitiva. Esta accion
                  no se puede deshacer.
                </span>
                <input
                  className={styles.input}
                  name="confirmPhrase"
                  placeholder="BORRAR"
                />
              </label>
              <div className={styles.actions}>
                <button
                  className={`${styles.btn} ${styles.btnDanger}`}
                  type="submit"
                  name="intent"
                  value="maintenance_purge_history"
                  disabled={isSubmitting}
                >
                  Purgar historial definitivamente
                </button>
              </div>
            </Form>

            {maintenanceFeedback ? (
              <p className={maintenanceFeedbackClassName}>
                {maintenanceFeedback}
              </p>
            ) : null}
          </div>
        </div>
      </s-section>
      ) : null}
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
