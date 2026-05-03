import { Form, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

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
          <div style={{ display: "grid", gap: 10, maxWidth: 900 }}>
            <label>
              Costo de recoleccion (MXN)
              <input name="pickupCost" type="number" step="0.01" defaultValue={settings.pickupCost} />
            </label>
            <label>
              Dias limite para devolucion
              <input name="returnWindowDays" type="number" defaultValue={settings.returnWindowDays} />
            </label>
            <label>
              Direccion de sucursal
              <input name="branchAddress" defaultValue={settings.branchAddress} />
            </label>
            <label>
              Instrucciones entrega en sucursal
              <textarea name="branchInstructions" defaultValue={settings.branchInstructions} />
            </label>
            <label>
              Horarios entrega en sucursal
              <input name="branchHours" defaultValue={settings.branchHours} />
            </label>
            <label>
              Instrucciones de recoleccion
              <textarea name="pickupInstructions" defaultValue={settings.pickupInstructions} />
            </label>
            <label>
              Horarios de recoleccion
              <input name="pickupHours" defaultValue={settings.pickupHours} />
            </label>
            <button type="submit" disabled={isSubmitting}>Guardar configuracion</button>
          </div>
        </Form>
      </s-section>

      <s-section heading="Solicitudes de devolucion">
        {requests.length === 0 ? (
          <p>No hay solicitudes por ahora.</p>
        ) : (
          <div style={{ display: "grid", gap: 16 }}>
            {requests.map((request) => (
              <article key={request.id} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
                <h3>Pedido #{request.orderNumber} - {request.customerName}</h3>
                <p>Email: {request.customerEmail}</p>
                <p>Telefono: {request.customerPhone || "-"}</p>
                <p>
                  Metodo: {request.returnMethod === "pickup" ? "Recoleccion a domicilio" : "Entrega en sucursal"}
                </p>
                <p>Estado actual: <strong>{request.status}</strong></p>
                <p>Costo devolucion: ${request.returnCost.toFixed(2)} MXN</p>
                <p>Reembolso estimado: ${request.estimatedRefund.toFixed(2)} MXN</p>
                <p>Reembolso final: ${request.finalRefund.toFixed(2)} MXN</p>
                <p>Fecha: {new Date(request.createdAt).toLocaleString("es-MX")}</p>

                {request.returnMethod === "pickup" ? (
                  <>
                    <p>
                      Recoleccion: {[request.pickupAddress, request.pickupNeighborhood, request.pickupCity, request.pickupState, request.pickupPostalCode]
                        .filter(Boolean)
                        .join(", ")}
                    </p>
                    <p>Dia/Horario: {request.pickupDate || "-"} / {request.pickupTimeSlot || "-"}</p>
                  </>
                ) : (
                  <>
                    <p>Sucursal: {request.branchAddress || "-"}</p>
                    <p>Horarios: {request.branchHours || "-"}</p>
                  </>
                )}

                <details>
                  <summary>Ver productos, motivos, fotos y descripcion</summary>
                  <ul>
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

                <Form method="post">
                  <input type="hidden" name="intent" value="update_status" />
                  <input type="hidden" name="id" value={request.id} />
                  <select name="status" defaultValue={request.status}>
                    {statusOptions.map((status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ))}
                  </select>
                  <button type="submit" disabled={isSubmitting}>Guardar estado</button>
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
