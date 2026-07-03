import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import styles from "../styles/admin.module.css";

const HISTORY_STATUSES = ["reembolsada", "rechazada", "denegada", "reembolso_denegado", "no_devuelto"];
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

  const [historyTotal, purgeCandidates, oldestHistory, evidenceItemCandidates] = await Promise.all([
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
  ]);

  return {
    historyTotal,
    purgeCandidates,
    evidenceItemCandidates,
    oldestHistoryAt: oldestHistory?.updatedAt ? oldestHistory.updatedAt.toISOString() : "",
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

  return { deletedRequests };
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
    message: `Purga completada. Ordenes eliminadas definitivamente: ${result.deletedRequests}.`,
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
  const feedback = actionData?.message || actionData?.error || "";
  const feedbackClassName = actionData?.ok ? styles.successMsg : styles.errorMsg;

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
                  <span className={styles.help}>Elimina por completo ordenes antiguas de historial.</span>
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
                <p className={styles.statRow}>Corte de limpieza: {formatDateLabel(maintenancePreview.evidenceCutoff)}</p>
                <p className={styles.statRow}>Corte de purga: {formatDateLabel(maintenancePreview.purgeCutoff)}</p>
                <p className={styles.statRow}>Orden historica mas antigua: {formatDateLabel(maintenancePreview.oldestHistoryAt)}</p>
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

            {feedback ? <p className={feedbackClassName}>{feedback}</p> : null}
          </div>
        </div>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
