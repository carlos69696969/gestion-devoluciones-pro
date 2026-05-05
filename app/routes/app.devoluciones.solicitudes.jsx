import { Form, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import styles from "../styles/admin.module.css";

const STATUS_OPTIONS = ["pendiente", "en_revision", "aprobada", "rechazada", "completada"];

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const requests = await prisma.returnRequest.findMany({
    where: { shop: session.shop },
    include: { items: true },
    orderBy: { createdAt: "desc" },
  });

  return { requests, statusOptions: STATUS_OPTIONS };
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
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

  return { ok: false };
};

export default function ReturnsRequests() {
  const { requests, statusOptions } = useLoaderData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <s-page heading="Solicitudes de devolucion">
      {requests.length === 0 ? (
        <s-section>
          <p>No hay solicitudes por ahora.</p>
        </s-section>
      ) : (
        <s-section>
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
                  <span className={styles.pill}>
                    Estado: <strong>{request.status}</strong>
                  </span>
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
                      ${request.finalRefund.toFixed(2)} MXN{" "}
                      <span style={{ color: "#6d7175", fontWeight: 700 }}>
                        (est. ${request.estimatedRefund.toFixed(2)})
                      </span>
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
                  <p className={styles.meta}>
                    Recoleccion:{" "}
                    {[request.pickupAddress, request.pickupCity, request.pickupState, request.pickupPostalCode]
                      .filter(Boolean)
                      .join(", ") || "-"}
                    {" · "}Dia: {request.pickupDate || "-"}
                    {request.pickupNotes ? ` · Notas: ${request.pickupNotes}` : ""}
                  </p>
                ) : (
                  <p className={styles.meta}>
                    Sucursal: {request.branchAddress || "-"} · Horarios: {request.branchHours || "-"}
                  </p>
                )}

                <details className={styles.details}>
                  <summary className={styles.summary}>Ver productos, motivos, fotos y descripcion</summary>
                  <ul className={styles.productList}>
                    {request.items.map((item) => {
                      let photos = [];
                      try {
                        photos = item.photoDataUrl ? JSON.parse(item.photoDataUrl) : [];
                        if (!Array.isArray(photos)) photos = [];
                      } catch {
                        photos = item.photoDataUrl ? [item.photoDataUrl] : [];
                      }

                      return (
                        <li key={item.id} style={{ marginBottom: 10 }}>
                          <div>
                            {item.title} x{item.quantity} - Motivo: {item.reason}
                          </div>
                          {item.details ? <div>Descripcion: {item.details}</div> : null}
                          {photos.length ? (
                            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 6 }}>
                              {photos.slice(0, 2).map((src, idx) => (
                                <a key={`${item.id}_${idx}`} href={src} target="_blank" rel="noreferrer">
                                  Ver foto {idx + 1}
                                </a>
                              ))}
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
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
                  <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={isSubmitting}>
                    Guardar estado
                  </button>
                </Form>
              </article>
            ))}
          </div>
        </s-section>
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);

