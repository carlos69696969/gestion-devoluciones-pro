/* eslint-disable react/prop-types */
import { useMemo, useState } from "react";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const REASONS = [
  "No era mi talla",
  "Producto defectuoso",
  "Me llego otro producto",
  "Ya no lo quiero",
  "Otro",
];

const PICKUP_COST = 100;

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return { reasons: REASONS, pickupCost: PICKUP_COST };
};

function normalizeOrder(orderNode) {
  return {
    id: orderNode.id,
    orderNumber: orderNode.name?.replace("#", "") || "",
    name: orderNode.name || "",
    customerName: orderNode.customer?.displayName || "Cliente",
    customerEmail: orderNode.email || "",
    items: orderNode.lineItems.edges.map(({ node }) => ({
      id: node.id,
      productId: node.product?.id || "",
      variantId: node.variant?.id || "",
      title: node.title,
      quantity: node.quantity,
    })),
  };
}

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "lookup") {
    try {
      const orderNumber = String(formData.get("orderNumber") || "").trim();
      const email = String(formData.get("email") || "").trim().toLowerCase();

      if (!orderNumber || !email) {
        return { ok: false, error: "Captura numero de pedido y correo." };
      }

      const response = await admin.graphql(
        `#graphql
        query FindOrders($query: String!) {
          orders(first: 5, query: $query) {
            edges {
              node {
                id
                name
                email
                customer { displayName }
                lineItems(first: 50) {
                  edges {
                    node {
                      id
                      title
                      quantity
                      product { id }
                      variant { id }
                    }
                  }
                }
              }
            }
          }
        }`,
        {
          variables: { query: `name:#${orderNumber}` },
        },
      );
      const data = await response.json();

      if (data?.errors?.length) {
        const hasAccessDenied = data.errors.some((error) =>
          String(error?.message || "").toLowerCase().includes("access denied"),
        );
        if (hasAccessDenied) {
          return {
            ok: false,
            error: "La app no tiene permisos de pedidos. Reinstala la app y acepta permisos.",
          };
        }
        return { ok: false, error: "Shopify devolvio un error al consultar el pedido." };
      }

      const match = data?.data?.orders?.edges
        ?.map((e) => e.node)
        ?.find((o) => (o.email || "").toLowerCase() === email);

      if (!match) {
        return { ok: false, error: "No encontramos un pedido con esos datos." };
      }

      return { ok: true, order: normalizeOrder(match) };
    } catch (error) {
      const raw = String(error?.message || error || "");
      const message = raw.toLowerCase();
      if (message.includes("access denied")) {
        return {
          ok: false,
          error: "La app no tiene permisos de pedidos. Reinstala la app y acepta permisos.",
          diagnostic: raw,
        };
      }
      if (message.includes("unauthorized") || message.includes("forbidden") || message.includes("401") || message.includes("403")) {
        return { ok: false, error: "Sesion/token invalido. Abre la app desde Admin para reautenticar.", diagnostic: raw };
      }
      return { ok: false, error: "No se pudo buscar el pedido en este momento.", diagnostic: raw };
    }
  }

  if (intent === "submit_return") {
    try {
      const payloadRaw = String(formData.get("payload") || "");
      if (!payloadRaw) {
        return { ok: false, error: "No hay informacion para guardar." };
      }

      const payload = JSON.parse(payloadRaw);
      if (!payload.items?.length) {
        return { ok: false, error: "Selecciona al menos un producto." };
      }

      if (payload.returnMethod === "pickup") {
        const required = [
          "pickupFullName",
          "pickupPhone",
          "pickupAddress",
          "pickupNeighborhood",
          "pickupCity",
          "pickupState",
          "pickupPostalCode",
        ];
        const missing = required.find((field) => !payload[field]);
        if (missing) {
          return { ok: false, error: "Completa todos los datos de recoleccion." };
        }
      }

      await prisma.returnRequest.create({
        data: {
          shop: session.shop,
          shopifyOrderId: payload.order.id,
          orderNumber: payload.order.orderNumber,
          customerName: payload.order.customerName,
          customerEmail: payload.order.customerEmail,
          returnMethod: payload.returnMethod,
          returnCost: payload.returnMethod === "pickup" ? PICKUP_COST : 0,
          pickupFullName: payload.pickupFullName || null,
          pickupPhone: payload.pickupPhone || null,
          pickupAddress: payload.pickupAddress || null,
          pickupNeighborhood: payload.pickupNeighborhood || null,
          pickupCity: payload.pickupCity || null,
          pickupState: payload.pickupState || null,
          pickupPostalCode: payload.pickupPostalCode || null,
          pickupReferences: payload.pickupReferences || null,
          items: {
            create: payload.items.map((item) => ({
              productId: item.productId || "",
              variantId: item.variantId || null,
              title: item.title,
              quantity: Number(item.quantity || 1),
              reason: item.reason,
            })),
          },
        },
      });

      return { ok: true, saved: true };
    } catch {
      return { ok: false, error: "No se pudo guardar la solicitud de devolucion." };
    }
  }

  return { ok: false, error: "Accion no valida." };
};

export default function ReturnsPortal() {
  const { reasons, pickupCost } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const order = actionData?.order;
  const diagnostic = actionData?.diagnostic;

  return (
    <s-page heading="Portal de devoluciones">
      <s-section heading="1) Buscar pedido">
        <Form method="post">
          <input type="hidden" name="intent" value="lookup" />
          <div style={{ display: "grid", gap: 12, maxWidth: 560 }}>
            <label>
              Numero de pedido
              <input name="orderNumber" required />
            </label>
            <label>
              Correo del pedido
              <input name="email" type="email" required />
            </label>
            <button type="submit" disabled={isSubmitting}>
              Buscar pedido
            </button>
            {actionData?.error ? <p style={{ color: "#b42318" }}>{actionData.error}</p> : null}
            {typeof diagnostic === "string" && diagnostic.trim() ? (
              <p style={{ color: "#475467", fontSize: 13 }}>{diagnostic}</p>
            ) : null}
          </div>
        </Form>
      </s-section>

      {order ? (
        <s-section heading="2) Selecciona productos y envia solicitud">
          <ReturnsRequestForm order={order} reasons={reasons} pickupCost={pickupCost} />
          {actionData?.saved ? (
            <p style={{ color: "#027a48", marginTop: 12 }}>Solicitud enviada correctamente.</p>
          ) : null}
        </s-section>
      ) : null}
    </s-page>
  );
}

function ReturnsRequestForm({ order, reasons, pickupCost }) {
  const [selected, setSelected] = useState({});
  const [reasonsByItem, setReasonsByItem] = useState(
    Object.fromEntries(order.items.map((item) => [item.id, reasons[0]])),
  );
  const [returnMethod, setReturnMethod] = useState("branch");
  const [pickup, setPickup] = useState({
    pickupFullName: "",
    pickupPhone: "",
    pickupAddress: "",
    pickupNeighborhood: "",
    pickupCity: "",
    pickupState: "",
    pickupPostalCode: "",
    pickupReferences: "",
  });

  const selectedItems = useMemo(
    () =>
      order.items
        .filter((item) => selected[item.id])
        .map((item) => ({
          ...item,
          reason: reasonsByItem[item.id] || reasons[0],
        })),
    [order.items, reasons, reasonsByItem, selected],
  );

  const payload = useMemo(
    () => ({
      order,
      items: selectedItems,
      returnMethod,
      ...pickup,
    }),
    [order, pickup, returnMethod, selectedItems],
  );

  return (
    <Form method="post">
      <input type="hidden" name="intent" value="submit_return" />
      <input type="hidden" name="payload" value={JSON.stringify(payload)} />
      <div style={{ display: "grid", gap: 14 }}>
        <h3>Pedido {order.name}</h3>
        {order.items.map((item) => (
          <div key={item.id} style={{ border: "1px solid #ddd", padding: 10, borderRadius: 6 }}>
            <label style={{ display: "block" }}>
              <input
                checked={Boolean(selected[item.id])}
                onChange={(event) =>
                  setSelected((prev) => ({ ...prev, [item.id]: event.target.checked }))
                }
                type="checkbox"
              />{" "}
              {item.title} (Cantidad: {item.quantity})
            </label>
            <label>
              Motivo
              <select
                value={reasonsByItem[item.id] || reasons[0]}
                onChange={(event) =>
                  setReasonsByItem((prev) => ({ ...prev, [item.id]: event.target.value }))
                }
              >
                {reasons.map((reason) => (
                  <option key={reason} value={reason}>
                    {reason}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ))}

        <h3>Metodo de devolucion</h3>
        <label>
          <input
            checked={returnMethod === "branch"}
            onChange={() => setReturnMethod("branch")}
            type="radio"
            name="returnMethodChoice"
            value="branch"
          />{" "}
          Entrega en sucursal ($0)
        </label>
        <label>
          <input
            checked={returnMethod === "pickup"}
            onChange={() => setReturnMethod("pickup")}
            type="radio"
            name="returnMethodChoice"
            value="pickup"
          />{" "}
          Recoleccion a domicilio (${pickupCost} MXN)
        </label>

        <h3>Datos para recoleccion</h3>
        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(2, minmax(220px, 1fr))" }}>
          <input
            value={pickup.pickupFullName}
            onChange={(event) => setPickup((prev) => ({ ...prev, pickupFullName: event.target.value }))}
            placeholder="Nombre completo"
          />
          <input
            value={pickup.pickupPhone}
            onChange={(event) => setPickup((prev) => ({ ...prev, pickupPhone: event.target.value }))}
            placeholder="Telefono"
          />
          <input
            value={pickup.pickupAddress}
            onChange={(event) => setPickup((prev) => ({ ...prev, pickupAddress: event.target.value }))}
            placeholder="Direccion completa"
          />
          <input
            value={pickup.pickupNeighborhood}
            onChange={(event) => setPickup((prev) => ({ ...prev, pickupNeighborhood: event.target.value }))}
            placeholder="Colonia"
          />
          <input
            value={pickup.pickupCity}
            onChange={(event) => setPickup((prev) => ({ ...prev, pickupCity: event.target.value }))}
            placeholder="Ciudad"
          />
          <input
            value={pickup.pickupState}
            onChange={(event) => setPickup((prev) => ({ ...prev, pickupState: event.target.value }))}
            placeholder="Estado"
          />
          <input
            value={pickup.pickupPostalCode}
            onChange={(event) => setPickup((prev) => ({ ...prev, pickupPostalCode: event.target.value }))}
            placeholder="Codigo postal"
          />
          <input
            value={pickup.pickupReferences}
            onChange={(event) => setPickup((prev) => ({ ...prev, pickupReferences: event.target.value }))}
            placeholder="Referencias"
          />
        </div>

        <h3>Resumen</h3>
        <p>Numero de pedido: {order.name}</p>
        <p>Productos seleccionados: {selectedItems.length}</p>
        <p>Metodo: {returnMethod === "pickup" ? "Recoleccion a domicilio" : "Entrega en sucursal"}</p>
        <p>Costo: ${returnMethod === "pickup" ? pickupCost : 0} MXN</p>
        <button type="submit">Enviar solicitud</button>
      </div>
    </Form>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
