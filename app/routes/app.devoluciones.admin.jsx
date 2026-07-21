import { useEffect, useState } from "react";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import styles from "../styles/admin.module.css";

const HISTORY_STATUSES = ["reembolsada", "rechazada", "denegada", "reembolso_denegado", "no_devuelto"];
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
const MAX_BATCH_SIZE = 500;
const NOTIFICATIONS_API_BASE_URL = String(
  process.env.NOTIFICATIONS_API_URL || "https://centro-de-notificaciones-cariana.onrender.com",
).replace(/\/+$/, "");
const NOTIFICATIONS_API_KEYS = Array.from(
  new Set(
    [process.env.NOTIFICATIONS_API_KEY, process.env.APP_INTERNAL_API_KEY]
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  ),
);

function parsePositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
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
  return { evidenceDays, purgeDays, batchSize };
}

function historyWhere(shop) {
  return {
    shop,
    status: { in: HISTORY_STATUSES },
  };
}

async function getMaintenancePreview(shop, inputs) {
  const evidenceCutoff = cutoffDateFromDays(inputs.evidenceDays);
  const purgeCutoff = cutoffDateFromDays(inputs.purgeDays);
  const baseWhere = historyWhere(shop);

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
    prisma.courierActivity.count({ where: { shop, createdAt: { lt: purgeCutoff } } }),
    prisma.courierEvent.count({ where: { shop, createdAt: { lt: purgeCutoff } } }),
    prisma.courierRouteSnapshot.count({ where: { shop, finishedAt: { lt: purgeCutoff } } }),
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
    oldestHistoryAt: oldestHistory?.updatedAt ? oldestHistory.updatedAt.toISOString() : "",
    courierHistoryTotal: courierActivityTotal + courierEventTotal + courierSnapshotTotal,
    courierHistoryCandidates: courierActivityCandidates + courierEventCandidates + courierSnapshotCandidates,
    courierActivityCandidates,
    courierEventCandidates,
    courierSnapshotCandidates,
    oldestCourierHistoryAt: oldestCourierHistoryDates[0]?.toISOString?.() || "",
    evidenceCutoff: evidenceCutoff.toISOString(),
    purgeCutoff: purgeCutoff.toISOString(),
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
  return Boolean(requestId && !requestId.startsWith("route:") && !requestId.startsWith("session:"));
}

function snapshotOrderEntries(snapshot) {
  return (Array.isArray(snapshot?.orders) ? snapshot.orders : [])
    .map((order) => ({
      requestId: String(order?.id || "").trim(),
      orderNumber: String(order?.orderNumber || "").replace(/^#/, "").trim() || null,
    }))
    .filter((entry) => isPurgeableCourierRequestId(entry.requestId));
}

async function collectCourierHistoryPurgeEntries(shop, purgeCutoff, batchSize) {
  const [activityRows, eventRows, snapshotRows] = await Promise.all([
    prisma.courierActivity.findMany({
      where: {
        shop,
        createdAt: { lt: purgeCutoff },
        action: { in: COURIER_HISTORY_FINAL_ACTIONS },
      },
      select: { requestId: true, orderNumber: true },
      orderBy: { id: "asc" },
      take: batchSize,
    }),
    prisma.courierEvent.findMany({
      where: {
        shop,
        createdAt: { lt: purgeCutoff },
        status: { in: COURIER_HISTORY_FINAL_STATUSES },
      },
      select: { requestId: true, orderNumber: true },
      orderBy: { id: "asc" },
      take: batchSize,
    }),
    prisma.courierRouteSnapshot.findMany({
      where: {
        shop,
        finishedAt: { lt: purgeCutoff },
      },
      select: { orders: true },
      orderBy: { id: "asc" },
      take: batchSize,
    }),
  ]);

  const entriesByRequestId = new Map();
  for (const row of [...activityRows, ...eventRows]) {
    const requestId = String(row.requestId || "").trim();
    if (!isPurgeableCourierRequestId(requestId)) continue;
    entriesByRequestId.set(requestId, {
      shop,
      requestId,
      orderNumber: String(row.orderNumber || "").replace(/^#/, "").trim() || null,
      cutoffAt: purgeCutoff,
    });
  }
  for (const snapshot of snapshotRows) {
    for (const entry of snapshotOrderEntries(snapshot)) {
      entriesByRequestId.set(entry.requestId, {
        shop,
        requestId: entry.requestId,
        orderNumber: entry.orderNumber,
        cutoffAt: purgeCutoff,
      });
    }
  }
  return Array.from(entriesByRequestId.values());
}

async function purgeCourierHistoryBatch(shop, inputs) {
  const purgeCutoff = cutoffDateFromDays(inputs.purgeDays);
  let purgedOrderMarkers = 0;
  let deletedActivities = 0;
  let deletedEvents = 0;
  let deletedSnapshots = 0;
  let deletedDeliveryCodes = 0;

  let keepRunning = true;
  while (keepRunning) {
    const purgeEntries = await collectCourierHistoryPurgeEntries(shop, purgeCutoff, inputs.batchSize);
    if (purgeEntries.length) {
      await prisma.courierHistoryPurge.createMany({
        data: purgeEntries,
        skipDuplicates: true,
      });
      purgedOrderMarkers += purgeEntries.length;
    }

    const [activityResult, eventResult, snapshotResult, deliveryCodeResult] = await Promise.all([
      prisma.courierActivity.deleteMany({
        where: { shop, createdAt: { lt: purgeCutoff } },
      }),
      prisma.courierEvent.deleteMany({
        where: { shop, createdAt: { lt: purgeCutoff } },
      }),
      prisma.courierRouteSnapshot.deleteMany({
        where: { shop, finishedAt: { lt: purgeCutoff } },
      }),
      prisma.deliveryCodeAssignment.deleteMany({
        where: {
          shop,
          active: false,
          releasedAt: { lt: purgeCutoff },
        },
      }),
    ]);

    deletedActivities += Number(activityResult.count || 0);
    deletedEvents += Number(eventResult.count || 0);
    deletedSnapshots += Number(snapshotResult.count || 0);
    deletedDeliveryCodes += Number(deliveryCodeResult.count || 0);

    keepRunning =
      purgeEntries.length >= inputs.batchSize ||
      Number(activityResult.count || 0) >= inputs.batchSize ||
      Number(eventResult.count || 0) >= inputs.batchSize ||
      Number(snapshotResult.count || 0) >= inputs.batchSize ||
      Number(deliveryCodeResult.count || 0) >= inputs.batchSize;
  }

  return { purgedOrderMarkers, deletedActivities, deletedEvents, deletedSnapshots, deletedDeliveryCodes };
}

async function purgeHistoryBatch(shop, inputs) {
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

  const courierHistory = await purgeCourierHistoryBatch(shop, inputs);

  return { deletedRequests, courierHistory };
}
async function getOrCreateSettings(shop) {
  const existing = await prisma.returnSettings.findUnique({ where: { shop } });
  if (existing) return existing;
  return prisma.returnSettings.create({ data: { shop } });
}

async function syncReturnSettingsToNotifications(shopDomain, settings) {
  if (!shopDomain || !NOTIFICATIONS_API_BASE_URL || !NOTIFICATIONS_API_KEYS.length) return;

  for (const apiKey of NOTIFICATIONS_API_KEYS) {
    try {
      const response = await fetch(`${NOTIFICATIONS_API_BASE_URL}/api/return-settings`, {
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
      });
      if (response.ok) return;
      const detail = await response.text().catch(() => "");
      console.error("No se pudo sincronizar la configuracion con notificaciones", {
        shopDomain,
        status: response.status,
        detail: String(detail || "").slice(0, 300),
      });
    } catch (error) {
      console.error("No se pudo sincronizar la configuracion con notificaciones", {
        shopDomain,
        error: String(error?.message || error || "unknown"),
      });
    }
  }
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const settings = await getOrCreateSettings(session.shop);
  const inputs = {
    evidenceDays: DEFAULT_EVIDENCE_DAYS,
    purgeDays: DEFAULT_PURGE_DAYS,
    batchSize: DEFAULT_BATCH_SIZE,
  };
  const preview = await getMaintenancePreview(session.shop, inputs);
  return { settings, maintenance: { inputs, preview } };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
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

  if (
    intent !== "maintenance_preview" &&
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

  const confirmPhrase = String(formData.get("confirmPhrase") || "").trim().toUpperCase();
  if (confirmPhrase !== "BORRAR") {
    const preview = await getMaintenancePreview(session.shop, inputs);
    return {
      ok: false,
      intent,
      error: 'Escribe "BORRAR" para confirmar la purga definitiva.',
      maintenance: { inputs, preview },
    };
  }

  const result = await purgeHistoryBatch(session.shop, inputs);
  const preview = await getMaintenancePreview(session.shop, inputs);
  return {
    ok: true,
    intent,
    message: `Purga completada. Ordenes de devoluciones eliminadas: ${result.deletedRequests}. Historial repartidor eliminado: ${result.courierHistory.deletedActivities} actividades, ${result.courierHistory.deletedEvents} eventos, ${result.courierHistory.deletedSnapshots} cierres de ruta.`,
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
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const maintenance = actionData?.maintenance || initialMaintenance;
  const maintenanceInputs = maintenance?.inputs || initialMaintenance?.inputs || {};
  const maintenancePreview = maintenance?.preview || initialMaintenance?.preview || {};
  const maintenanceFeedback =
    actionData?.intent && actionData.intent !== "update_settings" ? actionData?.message || actionData?.error || "" : "";
  const maintenanceFeedbackClassName = actionData?.ok ? styles.successMsg : styles.errorMsg;
  const settingsFeedback =
    actionData?.intent === "update_settings" ? actionData?.message || actionData?.error || "" : "";
  const settingsFeedbackClassName = actionData?.ok ? styles.successMsg : styles.errorMsg;
  const [visibleSettingsFeedback, setVisibleSettingsFeedback] = useState("");

  useEffect(() => {
    if (!settingsFeedback) return;
    setVisibleSettingsFeedback(settingsFeedback);
    const timeoutId = window.setTimeout(() => setVisibleSettingsFeedback(""), 4000);
    return () => window.clearTimeout(timeoutId);
  }, [settingsFeedback]);

  return (
    <s-page heading="Panel admin de devoluciones">
      <s-section heading="Configuracion de devoluciones">
        <Form method="post">
          <input type="hidden" name="intent" value="update_settings" />
          <div className={styles.wrap}>
            <div className={`${styles.card} ${styles.grid}`}>
              <div className={styles.grid2}>
                <label className={styles.label}>
                  Costo de recoleccion (MXN)
                  <span className={styles.help}>Costo que vera el cliente si elige recoleccion.</span>
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
                  <span className={styles.help}>Cuantos dias despues de la compra permites devolucion.</span>
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
                <input className={styles.input} name="branchAddress" defaultValue={settings.branchAddress} />
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
                  <input className={styles.input} name="branchHours" defaultValue={settings.branchHours} />
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
                  <input className={styles.input} name="pickupHours" defaultValue={settings.pickupHours} />
                </label>
              </div>

              <div className={styles.grid2}>
                <label className={styles.label}>
                  Motivos de devolucion (uno por linea)
                  <span className={styles.help}>Estos son los motivos que veran tus clientes al solicitar devolucion.</span>
                  <textarea
                    className={styles.textarea}
                    name="returnReasons"
                    defaultValue={settings.returnReasons || ""}
                    placeholder={"Me quedo grande\nMe quedo chico\nNo era lo que pedi\nLlego danado\nOtro"}
                  />
                </label>
                <label className={styles.label}>
                  Motivos que requieren evidencia (uno por linea)
                  <span className={styles.help}>Si un motivo esta aqui, pediremos descripcion y al menos 1 foto.</span>
                  <textarea
                    className={styles.textarea}
                    name="evidenceReasons"
                    defaultValue={settings.evidenceReasons || ""}
                    placeholder={"No era lo que pedi\nLlego danado"}
                  />
                </label>
              </div>

              <div className={styles.actions}>
                <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={isSubmitting}>
                  Guardar configuracion
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

      <s-section heading="Mantenimiento y limpieza">
        <div className={styles.wrap}>
          <div className={`${styles.card} ${styles.grid}`}>
            <p className={styles.help}>
              Esta seccion elimina peso del historial sin tocar ordenes activas. Se ejecuta en lotes para evitar que la app se congele.
            </p>

            <Form method="post" className={styles.grid}>
              <div className={styles.grid2}>
                <label className={styles.label}>
                  Dias para limpiar evidencias
                  <span className={styles.help}>Se borran solo fotos antiguas en historial (no elimina la orden).</span>
                  <input
                    className={styles.input}
                    name="evidenceDays"
                    type="number"
                    min="1"
                    defaultValue={maintenanceInputs.evidenceDays || DEFAULT_EVIDENCE_DAYS}
                  />
                </label>
                <label className={styles.label}>
                  Dias para purga definitiva
                  <span className={styles.help}>Elimina por completo ordenes antiguas de historial y registros antiguos del historial repartidor.</span>
                  <input
                    className={styles.input}
                    name="purgeDays"
                    type="number"
                    min="2"
                    defaultValue={maintenanceInputs.purgeDays || DEFAULT_PURGE_DAYS}
                  />
                </label>
              </div>

              <label className={styles.label}>
                Tamano de lote
                <span className={styles.help}>Recomendado: 100 a 300 para mantener buena velocidad.</span>
                <input
                  className={styles.input}
                  name="batchSize"
                  type="number"
                  min="25"
                  max={MAX_BATCH_SIZE}
                  defaultValue={maintenanceInputs.batchSize || DEFAULT_BATCH_SIZE}
                />
              </label>

              <div className={styles.maintenanceStats}>
                <p className={styles.statRow}>Total de ordenes en historial: {maintenancePreview.historyTotal || 0}</p>
                <p className={styles.statRow}>Fotos de evidencia candidatas a limpieza: {maintenancePreview.evidenceItemCandidates || 0}</p>
                <p className={styles.statRow}>Ordenes candidatas a purga definitiva: {maintenancePreview.purgeCandidates || 0}</p>
                <p className={styles.statRow}>Registros en historial repartidor: {maintenancePreview.courierHistoryTotal || 0}</p>
                <p className={styles.statRow}>Registros de historial repartidor candidatos a purga: {maintenancePreview.courierHistoryCandidates || 0}</p>
                <p className={styles.statRow}>Actividades repartidor candidatas: {maintenancePreview.courierActivityCandidates || 0}</p>
                <p className={styles.statRow}>Eventos repartidor candidatos: {maintenancePreview.courierEventCandidates || 0}</p>
                <p className={styles.statRow}>Cierres de ruta candidatos: {maintenancePreview.courierSnapshotCandidates || 0}</p>
                <p className={styles.statRow}>Corte de limpieza: {formatDateLabel(maintenancePreview.evidenceCutoff)}</p>
                <p className={styles.statRow}>Corte de purga: {formatDateLabel(maintenancePreview.purgeCutoff)}</p>
                <p className={styles.statRow}>Orden historica mas antigua: {formatDateLabel(maintenancePreview.oldestHistoryAt)}</p>
                <p className={styles.statRow}>Historial repartidor mas antiguo: {formatDateLabel(maintenancePreview.oldestCourierHistoryAt)}</p>
              </div>

              <div className={styles.actions}>
                <button className={styles.btn} type="submit" name="intent" value="maintenance_preview" disabled={isSubmitting}>
                  Actualizar vista previa
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
                  Escribe BORRAR para confirmar la purga definitiva. Esta accion no se puede deshacer.
                </span>
                <input className={styles.input} name="confirmPhrase" placeholder="BORRAR" />
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

            {maintenanceFeedback ? <p className={maintenanceFeedbackClassName}>{maintenanceFeedback}</p> : null}
          </div>
        </div>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
