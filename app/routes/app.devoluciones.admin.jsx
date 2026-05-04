import { Form, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import styles from "../styles/admin.module.css";

const STATUS_OPTIONS = ["pendiente", "en_revision", "aprobada", "rechazada", "completada"];

async function getOrCreateSettings(shop) {
  const existing = await prisma.returnSettings.findUnique({ where: { shop } });
  if (existing) return existing;
  return prisma.returnSettings.create({ data: { shop } });
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const [requests, settings] = await Promise.all([
    prisma.returnRequest.findMany({
      where: { shop: session.shop },
      include: { items: true },
      orderBy: { createdAt: "desc" },
    }),
    getOrCreateSettings(session.shop),
  ]);

  return { requests, statusOptions: STATUS_OPTIONS, settings };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "update_status") {
    const id = Number(formData.get("id"));
    const status = String(formData.get("status"));
    if (!id || !STATUS_OPTIONS.includes(status)) {
      return { ok: false };
    }
    await prisma.returnRequest.update({
      where: { id },
      data: { status },
    });
    return { ok: true };
  }

  if (intent === "update_settings") {
    await prisma.returnSettings.upsert({
      where: { shop: session.shop },
      update: {
        pickupCost: Number(formData.get("pickupCost") || 0),
        returnWindowDays: Number(formData.get("returnWindowDays") || 30),
        branchInstructions: String(formData.get("branchInstructions") || ""),
        branchAddress: String(formData.get("branchAddress") || ""),
        branchHours: String(formData.get("branchHours") || ""),
        pickupInstructions: String(formData.get("pickupInstructions") || ""),
        pickupHours: String(formData.get("pickupHours") || ""),
      },
      create: {
        shop: session.shop,
        pickupCost: Number(formData.get("pickupCost") || 0),
        returnWindowDays: Number(formData.get("returnWindowDays") || 30),
        branchInstructions: String(formData.get("branchInstructions") || ""),
        branchAddress: String(formData.get("branchAddress") || ""),
        branchHours: String(formData.get("branchHours") || ""),
        pickupInstructions: String(formData.get("pickupInstructions") || ""),
        pickupHours: String(formData.get("pickupHours") || ""),
      },
    });
    return { ok: true };
  }

  return { ok: false };
};

export default function ReturnsAdmin() {
  const { requests, statusOptions, settings } = useLoaderData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

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
                  <input className={styles.input} name="pickupCost" type="number" step="0.01" defaultValue={settings.pickupCost} />
                </label>
                <label className={styles.label}>
                  Dias limite para devolucion
                  <span className={styles.help}>Cuantos dias despues de la compra permites devolucion.</span>
                  <input className={styles.input} name="returnWindowDays" type="number" defaultValue={settings.returnWindowDays} />
                </label>
              </div>

              <label className={styles.label}>
                Direccion de sucursal
                <input className={styles.input} name="branchAddress" defaultValue={settings.branchAddress} />
              </label>

              <div className={styles.grid2}>
                <label className={styles.label}>
                  Instrucciones entrega en sucursal
                  <textarea className={styles.textarea} name="branchInstructions" defaultValue={settings.branchInstructions} />
                </label>
                <label className={styles.label}>
                  Horarios entrega en sucursal
                  <input className={styles.input} name="branchHours" defaultValue={settings.branchHours} />
                </label>
              </div>

              <div className={styles.grid2}>
                <label className={styles.label}>
                  Instrucciones de recoleccion
                  <textarea className={styles.textarea} name="pickupInstructions" defaultValue={settings.pickupInstructions} />
                </label>
                <label className={styles.label}>
                  Horarios de recoleccion
                  <input className={styles.input} name="pickupHours" defaultValue={settings.pickupHours} />
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

      <s-section heading="Solicitudes de devolucion">
        {requests.length === 0 ? (
          <p>No hay solicitudes por ahora.</p>
        ) : (
          <div className={`${styles.wrap} ${styles.reqGrid}`}>
            {requests.map((request) => (
              <article key={request.id} className={styles.card}>
                <div className={styles.reqHeader}>
                  <div>
                    <h3 className={styles.reqTitle}>Pedido #{request.orderNumber}</h3>
                    <p className={styles.meta}>
                      {request.customerName} · {request.customerEmail} · {request.customerPhone || "-"}
                    </p>
                  </div>
                  <span className={styles.pill}>Estado: <strong>{request.status}</strong></span>
                </div>

                <div className={styles.kv}>
                  <div className={styles.kvRow}>
                    <span className={styles.kvKey}>Metodo</span>
                    <span className={styles.kvVal}>
                      {request.returnMethod === "pickup" ? "Recoleccion a domicilio" : "Entrega en sucursal"}
                    </span>
                  </div>
                  <div className={styles.kvRow}>
                    <span className={styles.kvKey}>Reembolso</span>
                    <span className={styles.kvVal}>
                      ${request.finalRefund.toFixed(2)} MXN <span style={{ color: "#6d7175", fontWeight: 700 }}>(est. ${request.estimatedRefund.toFixed(2)})</span>
                    </span>
                  </div>
                  <div className={styles.kvRow}>
                    <span className={styles.kvKey}>Costo devolucion</span>
                    <span className={styles.kvVal}>${request.returnCost.toFixed(2)} MXN</span>
                  </div>
                  <div className={styles.kvRow}>
                    <span className={styles.kvKey}>Fecha</span>
                    <span className={styles.kvVal}>{new Date(request.createdAt).toLocaleString("es-MX")}</span>
                  </div>
                </div>

                {request.returnMethod === "pickup" ? (
                  <>
                    <p className={styles.meta}>
                      Recoleccion: {[request.pickupAddress, request.pickupNeighborhood, request.pickupCity, request.pickupState, request.pickupPostalCode]
                        .filter(Boolean)
                        .join(", ") || "-"}
                      {" · "}Dia/Horario: {request.pickupDate || "-"} / {request.pickupTimeSlot || "-"}
                    </p>
                  </>
                ) : (
                  <>
                    <p className={styles.meta}>Sucursal: {request.branchAddress || "-"} · Horarios: {request.branchHours || "-"}</p>
                  </>
                )}

                <details className={styles.details}>
                  <summary className={styles.summary}>Ver productos, motivos, fotos y descripcion</summary>
                  <ul className={styles.productList}>
                    {request.items.map((item) => (
                      <li key={item.id} style={{ marginBottom: 8 }}>
                        {item.title} x{item.quantity} - Motivo: {item.reason}
                        {item.details ? <div>Descripcion: {item.details}</div> : null}
                        {item.photoDataUrl ? (
                          <div>
                            <a href={item.photoDataUrl} target="_blank" rel="noreferrer">Ver foto</a>
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </details>

                <Form method="post" className={styles.statusForm}>
                  <input type="hidden" name="intent" value="update_status" />
                  <input type="hidden" name="id" value={request.id} />
                  <select className={styles.select} name="status" defaultValue={request.status}>
                    {statusOptions.map((status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ))}
                  </select>
                  <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={isSubmitting}>Guardar estado</button>
                </Form>
              </article>
            ))}
          </div>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
