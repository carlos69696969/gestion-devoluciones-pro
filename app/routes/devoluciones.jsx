/* eslint-disable react/prop-types */
import { useMemo, useState } from "react";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";

const REASONS = [
  "Me quedo grande",
  "Me quedo chico",
  "Ya no lo quiero",
  "No era lo que pedi",
  "Llego danado",
  "Otro",
];

const MANUAL_REVIEW_REASONS = new Set(["No era lo que pedi", "Llego danado"]);

function normalizeOrder(orderNode) {
  return {
    id: orderNode.id,
    orderNumber: orderNode.name?.replace("#", "") || "",
    name: orderNode.name || "",
    customerName: orderNode.customer?.displayName || "Cliente",
    customerEmail: orderNode.email || "",
    customerPhone: orderNode.customer?.phone || "",
    createdAt: orderNode.createdAt,
    items: orderNode.lineItems.edges.map(({ node }) => ({
      id: node.id,
      productId: node.product?.id || "",
      variantId: node.variant?.id || "",
      title: node.title,
      quantity: node.quantity,
      unitPrice: Number(node.originalUnitPriceSet?.shopMoney?.amount || 0),
    })),
  };
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + Number(days || 0));
  return copy;
}

function toMXN(value) {
  return Number(value || 0).toFixed(2);
}

async function getOrCreateSettings(shop) {
  const existing = await prisma.returnSettings.findUnique({ where: { shop } });
  if (existing) return existing;

  return prisma.returnSettings.create({
    data: { shop },
  });
}

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const incomingShop = (url.searchParams.get("shop") || "").trim().toLowerCase();
  const configuredShop = (process.env.SHOPIFY_SHOP_DOMAIN || "").trim().toLowerCase();
  const defaultShop = configuredShop || "cariana-3.myshopify.com";
  const shop =
    incomingShop.endsWith("-ft.myshopify.com") && defaultShop
      ? defaultShop
      : incomingShop;
  const orderNumber = (url.searchParams.get("order") || "").trim();
  const email = (url.searchParams.get("email") || "").trim().toLowerCase();

  if (!shop) {
    return { error: "Falta el dominio de la tienda.", autoOrder: null, settings: null, reasons: REASONS };
  }

  const settings = await getOrCreateSettings(shop);

  if (!orderNumber) {
    return {
      reasons: REASONS,
      settings,
      autoOrder: null,
      shop,
      info:
        "Abre esta pagina desde el boton 'Solicitar devolucion' de tu pedido para reconocer tu orden automaticamente.",
    };
  }

  try {
    const { admin } = await unauthenticated.admin(shop);
    const response = await admin.graphql(
      `#graphql
      query FindOrder($query: String!) {
        orders(first: 5, query: $query) {
          edges {
            node {
              id
              name
              email
              createdAt
              customer { displayName phone }
              lineItems(first: 50) {
                edges {
                  node {
                    id
                    title
                    quantity
                    product { id }
                    variant { id }
                    originalUnitPriceSet { shopMoney { amount } }
                  }
                }
              }
            }
          }
        }
      }`,
      { variables: { query: `name:#${orderNumber}` } },
    );
    const data = await response.json();

    const candidates = data?.data?.orders?.edges?.map((e) => e.node) || [];
    const match = email
      ? candidates.find((o) => (o.email || "").toLowerCase() === email)
      : candidates[0];

    if (!match) {
      return {
        reasons: REASONS,
        settings,
        autoOrder: null,
        shop,
        error: "No encontramos un pedido con esos datos.",
      };
    }

    const order = normalizeOrder(match);
    const limitDate = addDays(order.createdAt, settings.returnWindowDays);
    const now = new Date();
    const isExpired = now > limitDate;

    return {
      reasons: REASONS,
      settings,
      autoOrder: order,
      shop,
      isExpired,
      limitDate: limitDate.toISOString(),
      message: isExpired
        ? `Tu periodo de devolucion vencio el ${limitDate.toLocaleDateString("es-MX")}.`
        : `Estas dentro del periodo de devolucion (${settings.returnWindowDays} dias). Fecha limite: ${limitDate.toLocaleDateString("es-MX")}.`,
    };
  } catch (err) {
    const rawMessage = String(err?.message || err || "");
    const isOrdersScopeError =
      rawMessage.toLowerCase().includes("orders") &&
      rawMessage.toLowerCase().includes("access denied");

    const diagnostic = [
      `Tienda recibida: ${shop || "-"}`,
      `Pedido recibido: ${orderNumber || "-"}`,
      `Email recibido: ${email || "-"}`,
    ].join(" | ");

    return {
      reasons: REASONS,
      settings,
      autoOrder: null,
      shop,
      error: isOrdersScopeError
        ? "La app no tiene permisos de pedidos (read_orders) para esta tienda."
        : "No se pudo cargar el pedido automaticamente.",
      diagnostic: `${diagnostic} | Shop original: ${incomingShop || "-"} | Error tecnico: ${rawMessage || "-"}`,
    };
  }
};

export const action = async ({ request }) => {
  const formData = await request.formData();
  const shop = String(formData.get("shop") || "").trim().toLowerCase();
  const payloadRaw = String(formData.get("payload") || "");

  if (!shop || !payloadRaw) {
    return { ok: false, error: "Informacion incompleta para enviar la devolucion." };
  }

  const settings = await getOrCreateSettings(shop);
  const payload = JSON.parse(payloadRaw);

  if (!payload.items?.length) {
    return { ok: false, error: "Selecciona al menos un producto." };
  }

  const requiresReview = payload.items.some((item) =>
    MANUAL_REVIEW_REASONS.has(String(item.reason || "")),
  );

  for (const item of payload.items) {
    if (MANUAL_REVIEW_REASONS.has(item.reason)) {
      if (!String(item.details || "").trim()) {
        return {
          ok: false,
          error: "Para 'Llego danado' o 'No era lo que pedi' debes escribir descripcion.",
        };
      }
      if (!String(item.photoDataUrl || "").trim()) {
        return {
          ok: false,
          error: "Para 'Llego danado' o 'No era lo que pedi' debes subir una foto.",
        };
      }
    }
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
      "pickupDate",
      "pickupTimeSlot",
    ];
    const missing = required.find((field) => !String(payload[field] || "").trim());
    if (missing) {
      return { ok: false, error: "Completa todos los datos de recoleccion." };
    }
  }

  const limitDate = addDays(payload.order.createdAt, settings.returnWindowDays);
  if (new Date() > limitDate) {
    return {
      ok: false,
      error: `Tu periodo de devolucion vencio el ${limitDate.toLocaleDateString("es-MX")}.`,
    };
  }

  const estimatedRefund = Number(payload.estimatedRefund || 0);
  const pickupCost = requiresReview ? 0 : Number(settings.pickupCost || 0);
  const returnCost = payload.returnMethod === "pickup" ? pickupCost : 0;
  const finalRefund = Math.max(0, estimatedRefund - returnCost);

  await prisma.returnRequest.create({
    data: {
      shop,
      shopifyOrderId: payload.order.id,
      orderNumber: payload.order.orderNumber,
      customerName: payload.customerName || payload.order.customerName,
      customerEmail: payload.customerEmail || payload.order.customerEmail,
      customerPhone: payload.customerPhone || payload.order.customerPhone || null,
      returnMethod: payload.returnMethod,
      returnCost,
      estimatedRefund,
      finalRefund,
      requiresReview,
      status: requiresReview ? "en_revision" : "aprobada",
      branchAddress: settings.branchAddress,
      branchInstructions: settings.branchInstructions,
      branchHours: settings.branchHours,
      pickupInstructions: settings.pickupInstructions,
      pickupHours: settings.pickupHours,
      pickupDate: payload.pickupDate || null,
      pickupTimeSlot: payload.pickupTimeSlot || null,
      limitDate,
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
          details: item.details || null,
          photoDataUrl: item.photoDataUrl || null,
        })),
      },
    },
  });

  return {
    ok: true,
    saved: true,
    requiresReview,
    message: requiresReview
      ? "Estamos revisando tu solicitud. Una vez que revisemos las fotos y aprobemos tu devolucion, te notificaremos por WhatsApp."
      : "Tu devolucion fue aprobada automaticamente.",
  };
};

export default function PublicReturnsPortal() {
  const {
    reasons,
    settings,
    autoOrder,
    shop,
    error,
    info,
    isExpired,
    limitDate,
    message,
    diagnostic,
  } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <main style={{ maxWidth: 980, margin: "30px auto", padding: "0 16px" }}>
      <h1>Portal de devoluciones</h1>
      {info ? <p>{info}</p> : null}
      {error ? <p style={{ color: "#b42318" }}>{error}</p> : null}
      {typeof diagnostic === "string" ? (
        <p style={{ color: "#475467", fontSize: 14 }}>{diagnostic}</p>
      ) : null}
      {message ? <p style={{ color: isExpired ? "#b42318" : "#027a48" }}>{message}</p> : null}

      {autoOrder && !isExpired ? (
        <ReturnsRequestForm
          order={autoOrder}
          reasons={reasons}
          settings={settings}
          shop={shop}
          isSubmitting={isSubmitting}
          actionData={actionData}
        />
      ) : null}

      {autoOrder && isExpired ? (
        <section style={{ border: "1px solid #ddd", borderRadius: 8, padding: 16 }}>
          <h2>Periodo vencido</h2>
          <p>No puedes continuar. Fecha limite: {new Date(limitDate).toLocaleDateString("es-MX")}.</p>
        </section>
      ) : null}
    </main>
  );
}

function ReturnsRequestForm({ order, reasons, settings, shop, isSubmitting, actionData }) {
  const [selected, setSelected] = useState({});
  const [reasonsByItem, setReasonsByItem] = useState(
    Object.fromEntries(order.items.map((item) => [item.id, reasons[0]])),
  );
  const [detailsByItem, setDetailsByItem] = useState({});
  const [photoByItem, setPhotoByItem] = useState({});
  const [returnMethod, setReturnMethod] = useState("branch");
  const [customerName, setCustomerName] = useState(order.customerName || "");
  const [customerPhone, setCustomerPhone] = useState(order.customerPhone || "");
  const [pickup, setPickup] = useState({
    pickupFullName: order.customerName || "",
    pickupPhone: order.customerPhone || "",
    pickupAddress: "",
    pickupNeighborhood: "",
    pickupCity: "",
    pickupState: "",
    pickupPostalCode: "",
    pickupReferences: "",
    pickupDate: "",
    pickupTimeSlot: "",
  });

  const selectedItems = useMemo(
    () =>
      order.items
        .filter((item) => selected[item.id])
        .map((item) => ({
          ...item,
          reason: reasonsByItem[item.id] || reasons[0],
          details: detailsByItem[item.id] || "",
          photoDataUrl: photoByItem[item.id] || "",
        })),
    [order.items, reasons, reasonsByItem, selected, detailsByItem, photoByItem],
  );

  const requiresReview = selectedItems.some((item) => MANUAL_REVIEW_REASONS.has(item.reason));
  const estimatedRefund = selectedItems.reduce(
    (sum, item) => sum + Number(item.unitPrice || 0) * Number(item.quantity || 1),
    0,
  );
  const pickupCost = requiresReview ? 0 : Number(settings.pickupCost || 0);
  const returnCost = returnMethod === "pickup" ? pickupCost : 0;
  const finalRefund = Math.max(0, estimatedRefund - returnCost);

  const payload = useMemo(
    () => ({
      order,
      customerName,
      customerEmail: order.customerEmail,
      customerPhone,
      items: selectedItems,
      returnMethod,
      estimatedRefund,
      ...pickup,
    }),
    [order, customerName, customerPhone, selectedItems, returnMethod, estimatedRefund, pickup],
  );

  return (
    <section style={{ border: "1px solid #ddd", padding: 16, borderRadius: 8 }}>
      <h2 style={{ marginTop: 0 }}>Solicitud para pedido {order.name}</h2>
      <p>Cliente: {order.customerName} | Email: {order.customerEmail}</p>
      <Form method="post">
        <input type="hidden" name="shop" value={shop} />
        <input type="hidden" name="payload" value={JSON.stringify(payload)} />
        <div style={{ display: "grid", gap: 16 }}>
          <div>
            <h3>1) Productos a devolver</h3>
            {order.items.map((item) => {
              const reason = reasonsByItem[item.id] || reasons[0];
              const needsEvidence = MANUAL_REVIEW_REASONS.has(reason);
              return (
                <div key={item.id} style={{ border: "1px solid #ddd", padding: 10, borderRadius: 6, marginBottom: 10 }}>
                  <label style={{ display: "block" }}>
                    <input
                      type="checkbox"
                      checked={Boolean(selected[item.id])}
                      onChange={(event) =>
                        setSelected((prev) => ({ ...prev, [item.id]: event.target.checked }))
                      }
                    />{" "}
                    {item.title} (x{item.quantity}) - ${toMXN(item.unitPrice)} c/u
                  </label>

                  {selected[item.id] ? (
                    <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                      <label>
                        Motivo
                        <select
                          value={reason}
                          onChange={(event) =>
                            setReasonsByItem((prev) => ({ ...prev, [item.id]: event.target.value }))
                          }
                        >
                          {reasons.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                      </label>

                      {needsEvidence ? (
                        <>
                          <label>
                            Descripcion del problema (obligatoria)
                            <textarea
                              value={detailsByItem[item.id] || ""}
                              onChange={(event) =>
                                setDetailsByItem((prev) => ({ ...prev, [item.id]: event.target.value }))
                              }
                            />
                          </label>
                          <label>
                            Foto del problema (obligatoria)
                            <input
                              type="file"
                              accept="image/*"
                              onChange={(event) => {
                                const file = event.target.files?.[0];
                                if (!file) return;
                                const reader = new FileReader();
                                reader.onload = () => {
                                  setPhotoByItem((prev) => ({
                                    ...prev,
                                    [item.id]: String(reader.result || ""),
                                  }));
                                };
                                reader.readAsDataURL(file);
                              }}
                            />
                          </label>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          <div>
            <h3>2) Metodo de devolucion</h3>
            <label>
              <input
                type="radio"
                name="returnMethodChoice"
                value="branch"
                checked={returnMethod === "branch"}
                onChange={() => setReturnMethod("branch")}
              />{" "}
              Entrega en sucursal (sin costo)
            </label>
            <br />
            <label>
              <input
                type="radio"
                name="returnMethodChoice"
                value="pickup"
                checked={returnMethod === "pickup"}
                onChange={() => setReturnMethod("pickup")}
              />{" "}
              Recoleccion a domicilio ({requiresReview ? "Gratis" : `$${toMXN(settings.pickupCost)} MXN`})
            </label>
          </div>

          <div>
            <h3>3) Datos de contacto</h3>
            <input
              placeholder="Nombre del cliente"
              value={customerName}
              onChange={(event) => setCustomerName(event.target.value)}
            />
            <br />
            <input
              placeholder="Telefono"
              value={customerPhone}
              onChange={(event) => setCustomerPhone(event.target.value)}
            />
          </div>

          {returnMethod === "branch" ? (
            <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 12 }}>
              <h3>Entrega en sucursal</h3>
              <p><strong>Direccion:</strong> {settings.branchAddress}</p>
              <p><strong>Instrucciones:</strong> {settings.branchInstructions}</p>
              <p><strong>Horarios:</strong> {settings.branchHours}</p>
            </div>
          ) : (
            <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
              <h3>Recoleccion a domicilio</h3>
              <p><strong>Instrucciones:</strong> {settings.pickupInstructions}</p>
              <p><strong>Horarios disponibles:</strong> {settings.pickupHours}</p>
              <input
                placeholder="Direccion completa"
                value={pickup.pickupAddress}
                onChange={(event) => setPickup((prev) => ({ ...prev, pickupAddress: event.target.value }))}
              />
              <input
                placeholder="Colonia"
                value={pickup.pickupNeighborhood}
                onChange={(event) => setPickup((prev) => ({ ...prev, pickupNeighborhood: event.target.value }))}
              />
              <input
                placeholder="Ciudad"
                value={pickup.pickupCity}
                onChange={(event) => setPickup((prev) => ({ ...prev, pickupCity: event.target.value }))}
              />
              <input
                placeholder="Estado"
                value={pickup.pickupState}
                onChange={(event) => setPickup((prev) => ({ ...prev, pickupState: event.target.value }))}
              />
              <input
                placeholder="Codigo postal"
                value={pickup.pickupPostalCode}
                onChange={(event) => setPickup((prev) => ({ ...prev, pickupPostalCode: event.target.value }))}
              />
              <input
                placeholder="Referencias"
                value={pickup.pickupReferences}
                onChange={(event) => setPickup((prev) => ({ ...prev, pickupReferences: event.target.value }))}
              />
              <input
                type="date"
                value={pickup.pickupDate}
                onChange={(event) => setPickup((prev) => ({ ...prev, pickupDate: event.target.value }))}
              />
              <input
                placeholder="Horario de recoleccion"
                value={pickup.pickupTimeSlot}
                onChange={(event) => setPickup((prev) => ({ ...prev, pickupTimeSlot: event.target.value }))}
              />
            </div>
          )}

          <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
            <h3>4) Confirmacion y resumen</h3>
            <p><strong>Nombre:</strong> {customerName || "-"}</p>
            <p><strong>Telefono:</strong> {customerPhone || "-"}</p>
            <p><strong>Productos:</strong> {selectedItems.map((x) => `${x.title} (${x.reason})`).join(", ") || "-"}</p>
            <p><strong>Monto estimado a reembolsar:</strong> ${toMXN(estimatedRefund)} MXN</p>
            {returnMethod === "branch" ? (
              <>
                <p><strong>Direccion sucursal:</strong> {settings.branchAddress}</p>
                <p><strong>Instrucciones:</strong> {settings.branchInstructions}</p>
                <p><strong>Horarios:</strong> {settings.branchHours}</p>
              </>
            ) : (
              <>
                <p>
                  <strong>Direccion recoleccion:</strong>{" "}
                  {[pickup.pickupAddress, pickup.pickupNeighborhood, pickup.pickupCity, pickup.pickupState, pickup.pickupPostalCode]
                    .filter(Boolean)
                    .join(", ") || "-"}
                </p>
                <p><strong>Dia:</strong> {pickup.pickupDate || "-"}</p>
                <p><strong>Horario:</strong> {pickup.pickupTimeSlot || "-"}</p>
                <p><strong>Instrucciones:</strong> {settings.pickupInstructions}</p>
                <p><strong>Costo recoleccion:</strong> ${toMXN(returnCost)} MXN</p>
                <p><strong>Total final a reembolsar:</strong> ${toMXN(finalRefund)} MXN</p>
              </>
            )}
          </div>

          {actionData?.error ? <p style={{ color: "#b42318" }}>{actionData.error}</p> : null}
          {actionData?.saved ? <p style={{ color: "#027a48" }}>{actionData.message}</p> : null}
          <button disabled={isSubmitting} type="submit">Confirmar devolucion</button>
        </div>
      </Form>
    </section>
  );
}
