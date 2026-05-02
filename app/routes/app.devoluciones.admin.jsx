import { Form, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const STATUS_OPTIONS = ["pendiente", "aprobada", "rechazada", "completada"];

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
};

export default function ReturnsAdmin() {
  const { requests, statusOptions } = useLoaderData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <s-page heading="Panel admin de devoluciones">
      <s-section heading="Solicitudes">
        {requests.length === 0 ? (
          <p>No hay solicitudes por ahora.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th align="left">Pedido</th>
                  <th align="left">Cliente</th>
                  <th align="left">Email</th>
                  <th align="left">Productos</th>
                  <th align="left">Metodo</th>
                  <th align="left">Costo</th>
                  <th align="left">Estado</th>
                  <th align="left">Fecha</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((request) => (
                  <tr key={request.id}>
                    <td>{request.orderNumber}</td>
                    <td>{request.customerName}</td>
                    <td>{request.customerEmail}</td>
                    <td>
                      {request.items.map((item) => `${item.title} (${item.reason})`).join(", ")}
                    </td>
                    <td>
                      {request.returnMethod === "pickup"
                        ? "Recoleccion a domicilio"
                        : "Entrega en sucursal"}
                    </td>
                    <td>${request.returnCost.toFixed(2)} MXN</td>
                    <td>
                      <Form method="post">
                        <input type="hidden" name="id" value={request.id} />
                        <select name="status" defaultValue={request.status}>
                          {statusOptions.map((status) => (
                            <option key={status} value={status}>
                              {status}
                            </option>
                          ))}
                        </select>
                        <button type="submit" disabled={isSubmitting}>
                          Guardar
                        </button>
                      </Form>
                    </td>
                    <td>{new Date(request.createdAt).toLocaleString("es-MX")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
