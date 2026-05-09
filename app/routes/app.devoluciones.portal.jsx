import { Form, useActionData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const STATUS_LABELS = {
  pendiente: "pendiente",
  en_revision: "en revision",
  aprobada: "aprobada",
  recibida: "recibida",
  por_devolver: "por devolver",
  reembolso_denegado: "reembolso denegado",
  rechazada: "rechazada",
  reembolsada: "reembolsada",
  completada: "completada",
};

const STATUS_BADGE_STYLES = {
  pendiente: { background: "#fff4e5", color: "#8a4b08" },
  en_revision: { background: "#eff6ff", color: "#1e40af" },
  aprobada: { background: "#ecfdf3", color: "#027a48" },
  recibida: { background: "#e0f2fe", color: "#075985" },
  por_devolver: { background: "#fff7ed", color: "#9a3412" },
  reembolso_denegado: { background: "#fee2e2", color: "#b42318" },
  rechazada: { background: "#fee2e2", color: "#b42318" },
  reembolsada: { background: "#dcfce7", color: "#166534" },
  completada: { background: "#dcfce7", color: "#166534" },
  default: { background: "#f2f4f7", color: "#344054" },
};

function normalizeOrderNumber(value) {
  return String(value || "")
    .trim()
    .replace(/^#/, "");
}

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "lookup") {
    try {
      const orderNumber = normalizeOrderNumber(formData.get("orderNumber"));

      if (!orderNumber) {
        return { ok: false, error: "Captura el numero de pedido." };
      }

      const requests = await prisma.returnRequest.findMany({
        where: {
          shop: session.shop,
          orderNumber,
        },
        include: {
          items: true,
        },
        orderBy: {
          createdAt: "desc",
        },
      });

      return {
        ok: true,
        queried: true,
        orderNumber,
        requests: requests.map((requestRow) => ({
          id: requestRow.id,
          orderNumber: requestRow.orderNumber,
          customerName: requestRow.customerName,
          customerEmail: requestRow.customerEmail,
          returnMethod: requestRow.returnMethod,
          status: String(requestRow.status || "").toLowerCase(),
          rejectionReason: requestRow.rejectionReason || "",
          createdAt: requestRow.createdAt?.toISOString() || null,
          updatedAt: requestRow.updatedAt?.toISOString() || null,
          receivedAt: requestRow.receivedAt?.toISOString() || null,
          refundedAt: requestRow.refundedAt?.toISOString() || null,
          items: requestRow.items.map((item) => ({
            id: item.id,
            title: item.title,
            quantity: item.quantity,
            reason: item.reason,
          })),
        })),
      };
    } catch (error) {
      console.error("Error searching return requests by order number", error);
      return { ok: false, error: "No se pudo buscar la devolucion en este momento." };
    }
  }

  return { ok: false, error: "Accion no valida." };
};

export default function ReturnsPortal() {
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const requests = Array.isArray(actionData?.requests) ? actionData.requests : [];
  const hasResults = requests.length > 0;

  return (
    <s-page heading="Portal de devoluciones">
      <s-section heading="Buscar devolucion por numero de pedido">
        <Form method="post">
          <input type="hidden" name="intent" value="lookup" />
          <div
            style={{
              display: "grid",
              gap: 12,
              maxWidth: 700,
              padding: 18,
              border: "1px solid #e4e7ec",
              borderRadius: 14,
              background: "linear-gradient(180deg, #ffffff 0%, #f9fafb 100%)",
            }}
          >
            <p style={{ margin: 0, fontSize: 14, color: "#475467" }}>
              Ingresa el numero del pedido. Solo se mostraran devoluciones ya registradas.
            </p>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <input
                name="orderNumber"
                required
                placeholder="Ejemplo: 1011"
                style={{
                  height: 42,
                  minWidth: 260,
                  padding: "0 12px",
                  borderRadius: 10,
                  border: "1px solid #d0d5dd",
                }}
              />
              <button
                type="submit"
                disabled={isSubmitting}
                style={{
                  height: 42,
                  padding: "0 18px",
                  borderRadius: 10,
                  border: "none",
                  fontWeight: 600,
                  color: "#ffffff",
                  background: isSubmitting ? "#98a2b3" : "#175cd3",
                  cursor: isSubmitting ? "not-allowed" : "pointer",
                }}
              >
                {isSubmitting ? "Buscando..." : "Buscar pedido"}
              </button>
            </div>
            {actionData?.error ? <p style={{ margin: 0, color: "#b42318" }}>{actionData.error}</p> : null}
          </div>
        </Form>
      </s-section>

      {hasResults ? (
        <s-section heading={`Resultado${requests.length > 1 ? "s" : ""}`}>
          <div style={{ display: "grid", gap: 12 }}>
            {requests.map((requestRow) => {
              const status = String(requestRow.status || "").toLowerCase();
              const badgeStyle = STATUS_BADGE_STYLES[status] || STATUS_BADGE_STYLES.default;
              return (
                <article
                  key={requestRow.id}
                  style={{
                    border: "1px solid #e4e7ec",
                    borderRadius: 14,
                    backgroundColor: "#ffffff",
                    padding: 16,
                    boxShadow: "0 1px 2px rgba(16, 24, 40, 0.05)",
                  }}
                >
                  <header
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 10,
                      flexWrap: "wrap",
                    }}
                  >
                    <strong style={{ fontSize: 20 }}>Pedido #{requestRow.orderNumber}</strong>
                    <span
                      style={{
                        ...badgeStyle,
                        borderRadius: 999,
                        padding: "6px 12px",
                        fontSize: 13,
                        fontWeight: 700,
                        textTransform: "capitalize",
                      }}
                    >
                      {STATUS_LABELS[status] || status || "sin estado"}
                    </span>
                  </header>

                  <div style={{ display: "grid", gap: 6, marginTop: 12, color: "#344054" }}>
                    <p style={{ margin: 0 }}>
                      <strong>Cliente:</strong> {requestRow.customerName} | {requestRow.customerEmail}
                    </p>
                    <p style={{ margin: 0 }}>
                      <strong>Metodo:</strong>{" "}
                      {requestRow.returnMethod === "pickup" ? "Recoleccion a domicilio" : "Entrega en sucursal"}
                    </p>
                    {requestRow.rejectionReason ? (
                      <p style={{ margin: 0 }}>
                        <strong>Motivo:</strong> {requestRow.rejectionReason}
                      </p>
                    ) : null}
                    <p style={{ margin: 0 }}>
                      <strong>Fecha solicitud:</strong>{" "}
                      {requestRow.createdAt ? new Date(requestRow.createdAt).toLocaleString("es-MX") : "-"}
                    </p>
                    {requestRow.receivedAt ? (
                      <p style={{ margin: 0 }}>
                        <strong>Fecha recibida:</strong> {new Date(requestRow.receivedAt).toLocaleString("es-MX")}
                      </p>
                    ) : null}
                    {requestRow.refundedAt ? (
                      <p style={{ margin: 0 }}>
                        <strong>Fecha reembolso:</strong> {new Date(requestRow.refundedAt).toLocaleString("es-MX")}
                      </p>
                    ) : null}
                  </div>

                  <div style={{ marginTop: 12 }}>
                    <strong style={{ display: "block", marginBottom: 8 }}>Productos</strong>
                    {requestRow.items?.length ? (
                      <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
                        {requestRow.items.map((item) => (
                          <li key={item.id}>
                            {item.title} x{item.quantity} - Motivo: {item.reason}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p style={{ margin: 0, color: "#667085" }}>Sin productos registrados.</p>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </s-section>
      ) : null}
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
