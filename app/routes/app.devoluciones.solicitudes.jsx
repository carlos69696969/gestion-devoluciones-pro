/* eslint-disable react/prop-types */
import { useEffect, useState } from "react";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import styles from "../styles/admin.module.css";

const STATUS_LABEL = {
  pendiente: "pendiente",
  en_revision: "en revision",
  aprobada: "aprobada",
  intento_fallido_1: "intento de devolucion fallido",
  intento_fallido_2: "segundo intento de devolucion fallido",
  por_devolver: "pendiente por devolver",
  rechazada: "rechazada",
  denegada: "reembolso denegado",
  reembolso_denegado: "reembolso denegado",
  recibida: "recibida",
  reembolsada: "reembolsada",
  completada: "completada",
};

const VIEW_MODE = {
  PICKUP: "pickup",
  BRANCH: "branch",
  REVIEW: "review",
  REFUNDS: "refunds",
  TO_RETURN: "to_return",
  HISTORY: "history",
};

const METHOD_QUEUE_STATUSES = new Set(["aprobada", "intento_fallido_1", "intento_fallido_2"]);
const REFUND_QUEUE_STATUSES = new Set(["recibida"]);
const RETURN_TO_CUSTOMER_STATUSES = new Set(["por_devolver"]);
const HISTORY_STATUSES = new Set(["reembolsada", "rechazada", "denegada", "reembolso_denegado"]);
const RETURNED_TO_CUSTOMER_MESSAGE = "Tu devolución fue regresada con éxito a tu domicilio.";
const RETURNED_TO_CUSTOMER_KIND = "returned_to_customer";

function getStatusClassName(status) {
  if (status === "en_revision") return "statusReview";
  if (status === "aprobada") return "statusApproved";
  if (status === "intento_fallido_1" || status === "intento_fallido_2") return "statusAttemptFailed";
  if (status === "por_devolver") return "statusPendingReturn";
  if (status === "rechazada") return "statusRejected";
  if (status === "reembolso_denegado") return "statusDenied";
  if (status === "recibida") return "statusReceived";
  if (status === "reembolsada") return "statusRefunded";
  if (status === "denegada") return "statusDenied";
  return "statusDefault";
}

function isPickupFailedAttemptStatus(status) {
  return status === "intento_fallido_1" || status === "intento_fallido_2";
}

function normalizeViewMode(rawValue) {
  const value = String(rawValue || "").trim().toLowerCase();
  if (value === VIEW_MODE.PICKUP) return VIEW_MODE.PICKUP;
  if (value === VIEW_MODE.REVIEW) return VIEW_MODE.REVIEW;
  if (value === VIEW_MODE.REFUNDS) return VIEW_MODE.REFUNDS;
  if (value === VIEW_MODE.TO_RETURN) return VIEW_MODE.TO_RETURN;
  if (value === VIEW_MODE.HISTORY) return VIEW_MODE.HISTORY;
  return VIEW_MODE.BRANCH;
}

function toMoney(value) {
  return Number(value || 0).toFixed(2);
}

function itemKeyFromRecord(item) {
  const lineItemId = String(item?.lineItemId || "").trim();
  if (lineItemId) return `line:${lineItemId}`;
  const variantId = String(item?.variantId || "").trim();
  if (variantId) return `variant:${variantId}`;
  const productId = String(item?.productId || "").trim();
  if (productId) return `product:${productId}`;
  return `title:${String(item?.title || "").trim().toLowerCase()}`;
}

function parsePhotoUrls(rawValue) {
  if (!rawValue) return [];
  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed.filter(Boolean).slice(0, 2) : [];
  } catch {
    return [String(rawValue)].filter(Boolean);
  }
}

function parseReasonEntries(rawValue) {
  const text = String(rawValue || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    return entries
      .map((entry) => ({
        kind: String(entry?.kind || "").trim() || "legacy",
        reason: String(entry?.reason || "").trim(),
        at: entry?.at ? String(entry.at) : "",
      }))
      .filter((entry) => entry.reason);
  } catch {
    return [{ kind: "legacy", reason: text, at: "" }];
  }
}

function isReturnedToCustomerEntry(entry) {
  return String(entry?.kind || "").toLowerCase() === RETURNED_TO_CUSTOMER_KIND;
}

function latestReturnedToCustomerAtFromRaw(rawValue) {
  const entries = parseReasonEntries(rawValue);
  for (let idx = entries.length - 1; idx >= 0; idx -= 1) {
    if (!isReturnedToCustomerEntry(entries[idx])) continue;
    return String(entries[idx]?.at || "").trim();
  }
  return "";
}

function appendReasonEntry(rawValue, entry) {
  const entries = parseReasonEntries(rawValue);
  entries.push({
    kind: String(entry?.kind || "legacy"),
    reason: String(entry?.reason || "").trim(),
    at: new Date().toISOString(),
  });
  return JSON.stringify({ entries });
}

function latestReasonFromRaw(rawValue) {
  const entries = parseReasonEntries(rawValue);
  for (let idx = entries.length - 1; idx >= 0; idx -= 1) {
    if (isReturnedToCustomerEntry(entries[idx])) continue;
    return entries[idx]?.reason || "";
  }
  return "";
}

function reasonEntryLabel(entry) {
  const kind = String(entry?.kind || "").toLowerCase();
  if (kind === "attempt_failed_1") return "Intento de recoleccion fallido (1 de 2)";
  if (kind === "attempt_failed_2") return "Intento de recoleccion fallido (2 de 2)";
  if (kind === "rejected_after_attempts") return "Motivo de rechazo final";
  if (kind === "review_rejected") return "Motivo de rechazo";
  if (kind === "denied_after_received") return "Motivo de denegacion";
  if (kind === RETURNED_TO_CUSTOMER_KIND) return "Devuelto al cliente";
  return "Motivo";
}

function pickParentTransaction(transactions) {
  const success = transactions.filter((tx) => String(tx.status || "").toUpperCase() === "SUCCESS");
  return (
    success.find((tx) => ["CAPTURE", "SALE"].includes(String(tx.kind || "").toUpperCase())) ||
    success[0] ||
    null
  );
}

async function fetchOrderSnapshot(admin, orderId) {
  const response = await admin.graphql(
    `#graphql
    query OrderForRefund($id: ID!) {
      order(id: $id) {
        id
        lineItems(first: 100) {
          edges {
            node {
              id
              title
              quantity
              variant { id }
              product { id }
              originalUnitPriceSet {
                shopMoney { amount currencyCode }
              }
            }
          }
        }
        transactions {
          id
          kind
          status
          gateway
        }
      }
    }`,
    { variables: { id: orderId } },
  );
  const payload = await response.json();
  const errors = payload?.errors || [];
  if (errors.length) {
    throw new Error(errors[0]?.message || "No se pudo consultar la orden en Shopify.");
  }
  const order = payload?.data?.order;
  if (!order) throw new Error("No se encontro la orden en Shopify.");
  return {
    orderId: order.id,
    lineItems: (order.lineItems?.edges || []).map(({ node }) => ({
      id: node.id,
      title: node.title,
      quantity: Number(node.quantity || 0),
      variantId: node.variant?.id || "",
      productId: node.product?.id || "",
      unitPrice: Number(node.originalUnitPriceSet?.shopMoney?.amount || 0),
    })),
    transactions: (order.transactions || []).map((transaction) => ({
      id: transaction.id,
      kind: transaction.kind,
      status: transaction.status,
      gateway: transaction.gateway || "",
    })),
  };
}

function putImageCandidate(map, key, imageUrl, imageAlt) {
  if (!key || !imageUrl || map[key]) return;
  map[key] = { imageUrl, imageAlt: imageAlt || "" };
}

function ImageViewer({ image, onClose }) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  useEffect(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setDragging(false);
  }, [image?.src]);

  if (!image?.src) return null;

  const applyZoom = (nextZoom) => {
    const clamped = Math.min(4, Math.max(1, Number(nextZoom || 1)));
    setZoom(clamped);
    if (clamped <= 1) setOffset({ x: 0, y: 0 });
  };

  const beginDrag = (event) => {
    if (zoom <= 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    setDragStart({
      x: event.clientX - offset.x,
      y: event.clientY - offset.y,
    });
  };

  const onDrag = (event) => {
    if (!dragging || zoom <= 1) return;
    setOffset({
      x: event.clientX - dragStart.x,
      y: event.clientY - dragStart.y,
    });
  };

  const finishDrag = (event) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
  };

  return (
    <div className={styles.imageViewerOverlay} onClick={onClose} role="presentation">
      <div className={styles.imageViewerDialog} onClick={(event) => event.stopPropagation()} role="presentation">
        <div className={styles.imageViewerToolbar}>
          <button type="button" className={styles.imageViewerBtn} onClick={() => applyZoom(zoom - 0.25)}>
            -
          </button>
          <span className={styles.imageViewerZoom}>{Math.round(zoom * 100)}%</span>
          <button type="button" className={styles.imageViewerBtn} onClick={() => applyZoom(zoom + 0.25)}>
            +
          </button>
          <button type="button" className={styles.imageViewerBtn} onClick={() => applyZoom(1)}>
            Reset
          </button>
          <button type="button" className={styles.imageViewerBtn} onClick={onClose}>
            Cerrar
          </button>
        </div>
        <div
          className={styles.imageViewerStage}
          onWheel={(event) => {
            event.preventDefault();
            applyZoom(zoom + (event.deltaY < 0 ? 0.2 : -0.2));
          }}
        >
          <img
            src={image.src}
            alt={image.alt || "Imagen"}
            className={styles.imageViewerImg}
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
              cursor: zoom > 1 ? (dragging ? "grabbing" : "grab") : "zoom-in",
            }}
            onDoubleClick={() => applyZoom(zoom > 1 ? 1 : 2)}
            onPointerDown={beginDrag}
            onPointerMove={onDrag}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
            draggable={false}
          />
        </div>
      </div>
    </div>
  );
}

async function fetchOrderItemImageMaps(admin, orderIds) {
  const uniqueIds = Array.from(new Set(orderIds.filter(Boolean)));
  if (!uniqueIds.length) return {};

  try {
    const response = await admin.graphql(
      `#graphql
      query OrdersForReturnImages($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Order {
            id
            lineItems(first: 100) {
              edges {
                node {
                  id
                  title
                  variant {
                    id
                    image {
                      url
                      altText
                    }
                  }
                  product {
                    id
                    featuredImage {
                      url
                      altText
                    }
                  }
                }
              }
            }
          }
        }
      }`,
      { variables: { ids: uniqueIds } },
    );
    const payload = await response.json();
    const nodes = payload?.data?.nodes || [];
    const byOrder = {};

    for (const order of nodes) {
      if (!order?.id) continue;
      const imageMap = {};
      const lines = order?.lineItems?.edges || [];
      for (const edge of lines) {
        const line = edge?.node;
        if (!line) continue;
        const imageUrl = line?.variant?.image?.url || line?.product?.featuredImage?.url || "";
        const imageAlt = line?.variant?.image?.altText || line?.product?.featuredImage?.altText || "";
        if (!imageUrl) continue;

        putImageCandidate(imageMap, itemKeyFromRecord({ lineItemId: line.id }), imageUrl, imageAlt);
        putImageCandidate(imageMap, itemKeyFromRecord({ variantId: line?.variant?.id }), imageUrl, imageAlt);
        putImageCandidate(imageMap, itemKeyFromRecord({ productId: line?.product?.id }), imageUrl, imageAlt);
        putImageCandidate(imageMap, itemKeyFromRecord({ title: line.title }), imageUrl, imageAlt);
      }
      byOrder[order.id] = imageMap;
    }

    return byOrder;
  } catch {
    return {};
  }
}

function mapRequestItemsToRefundLineItems(requestItems, orderLineItems) {
  const usedLineIds = new Set();
  const refundableLines = [];
  let subtotal = 0;

  const byLine = new Map(orderLineItems.map((line) => [line.id, line]));
  const byVariant = new Map(orderLineItems.map((line) => [line.variantId, line]).filter(([k]) => k));
  const byProduct = new Map(orderLineItems.map((line) => [line.productId, line]).filter(([k]) => k));

  for (const item of requestItems) {
    let line = null;
    const lineItemId = String(item.lineItemId || "").trim();
    if (lineItemId && byLine.has(lineItemId)) {
      line = byLine.get(lineItemId);
    }
    if (!line) {
      const variantId = String(item.variantId || "").trim();
      if (variantId && byVariant.has(variantId)) line = byVariant.get(variantId);
    }
    if (!line) {
      const productId = String(item.productId || "").trim();
      if (productId && byProduct.has(productId)) line = byProduct.get(productId);
    }
    if (!line) {
      const title = String(item.title || "").trim().toLowerCase();
      line =
        orderLineItems.find(
          (candidate) => !usedLineIds.has(candidate.id) && String(candidate.title || "").trim().toLowerCase() === title,
        ) || null;
    }

    if (!line || usedLineIds.has(line.id)) {
      throw new Error(`No se pudo mapear el producto "${item.title}" a una linea de la orden.`);
    }
    usedLineIds.add(line.id);

    const quantity = Math.max(1, Math.min(Number(item.quantity || 1), Number(line.quantity || 1)));
    subtotal += Number(line.unitPrice || 0) * quantity;
    refundableLines.push({
      lineItemId: line.id,
      quantity,
      restockType: "NO_RESTOCK",
    });
  }

  return { refundLineItems: refundableLines, subtotal };
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const viewMode = normalizeViewMode(url.searchParams.get("tipo"));
  const rawRequests = await prisma.returnRequest.findMany({
    where: { shop: session.shop },
    include: { items: true },
    orderBy: { createdAt: "desc" },
  });

  const imagesByOrder = await fetchOrderItemImageMaps(
    admin,
    rawRequests.map((requestRow) => requestRow.shopifyOrderId),
  );

  const requests = rawRequests.map((requestRow) => {
    const imageMap = imagesByOrder[requestRow.shopifyOrderId] || {};
    const reasonEntries = parseReasonEntries(requestRow.rejectionReason);
    const visibleReasonEntries = reasonEntries.filter((entry) => !isReturnedToCustomerEntry(entry));
    const wasReturnedToCustomer = reasonEntries.some((entry) => isReturnedToCustomerEntry(entry));
    const returnedToCustomerAt = latestReturnedToCustomerAtFromRaw(requestRow.rejectionReason);
    return {
      ...requestRow,
      rejectionReason: latestReasonFromRaw(requestRow.rejectionReason),
      reasonEntries: visibleReasonEntries,
      wasReturnedToCustomer,
      returnedToCustomerAt,
      items: requestRow.items.map((item) => {
        const image = imageMap[itemKeyFromRecord(item)] || null;
        return {
          ...item,
          imageUrl: image?.imageUrl || "",
          imageAlt: image?.imageAlt || "",
        };
      }),
    };
  });

  return { requests, viewMode };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const id = Number(formData.get("id") || 0);
  if (!id) return { ok: false, error: "Solicitud invalida." };

  const requestRow = await prisma.returnRequest.findFirst({
    where: { id, shop: session.shop },
    include: { items: true },
  });
  if (!requestRow) return { ok: false, error: "No se encontro la solicitud." };

  if (intent === "approve_request") {
    await prisma.returnRequest.update({
      where: { id },
      data: {
        status: "aprobada",
        rejectionReason: null,
      },
    });
    return { ok: true, message: "Solicitud aprobada." };
  }

  if (intent === "reject_request") {
    const rejectionReason = String(formData.get("rejectionReason") || "").trim();
    if (!rejectionReason) {
      return { ok: false, error: "Escribe el motivo de rechazo." };
    }
    await prisma.returnRequest.update({
      where: { id },
      data: {
        status: "rechazada",
        rejectionReason: appendReasonEntry(requestRow.rejectionReason, {
          kind: "review_rejected",
          reason: rejectionReason,
        }),
      },
    });
    return { ok: true, message: "Solicitud rechazada." };
  }

  if (intent === "mark_received") {
    const currentStatus = String(requestRow.status || "").toLowerCase();
    const canMarkReceived =
      currentStatus === "aprobada" || isPickupFailedAttemptStatus(currentStatus);
    if (!canMarkReceived) {
      return {
        ok: false,
        error: "Solo puedes marcar como recibida una solicitud aprobada o con intento fallido.",
      };
    }
    await prisma.returnRequest.update({
      where: { id },
      data: {
        status: "recibida",
        receivedAt: new Date(),
      },
    });
    return { ok: true, message: "Solicitud marcada como recibida." };
  }

  if (intent === "pickup_attempt_failed") {
    const currentStatus = String(requestRow.status || "").toLowerCase();
    if (requestRow.returnMethod !== "pickup") {
      return { ok: false, error: "Solo aplica a solicitudes de recoleccion a domicilio." };
    }
    if (currentStatus !== "aprobada" && currentStatus !== "intento_fallido_1") {
      return { ok: false, error: "Ya no puedes registrar mas intentos fallidos para esta solicitud." };
    }
    const rejectionReason = String(formData.get("rejectionReason") || "").trim();
    if (!rejectionReason) {
      return { ok: false, error: "Escribe la descripcion obligatoria del intento fallido." };
    }
    const nextStatus = currentStatus === "aprobada" ? "intento_fallido_1" : "intento_fallido_2";
    await prisma.returnRequest.update({
      where: { id },
      data: {
        status: nextStatus,
        rejectionReason: appendReasonEntry(requestRow.rejectionReason, {
          kind: nextStatus === "intento_fallido_1" ? "attempt_failed_1" : "attempt_failed_2",
          reason: rejectionReason,
        }),
      },
    });
    return {
      ok: true,
      message:
        nextStatus === "intento_fallido_1"
          ? "Intento de recoleccion fallido registrado (1 de 2)."
          : "Intento de recoleccion fallido registrado (2 de 2). Ahora puedes rechazar la devolucion.",
    };
  }

  if (intent === "reject_after_failed_pickups") {
    if (String(requestRow.status || "").toLowerCase() !== "intento_fallido_2") {
      return { ok: false, error: "Solo puedes rechazar despues de dos intentos fallidos." };
    }
    const rejectionReason = String(formData.get("rejectionReason") || "").trim();
    if (!rejectionReason) {
      return { ok: false, error: "Escribe el motivo obligatorio de rechazo." };
    }
    await prisma.returnRequest.update({
      where: { id },
      data: {
        status: "rechazada",
        rejectionReason: appendReasonEntry(requestRow.rejectionReason, {
          kind: "rejected_after_attempts",
          reason: rejectionReason,
        }),
        refundError: null,
      },
    });
    return { ok: true, message: "Solicitud rechazada por intentos de recoleccion fallidos." };
  }

  if (intent === "deny_received") {
    if (String(requestRow.status || "").toLowerCase() !== "recibida") {
      return { ok: false, error: "Solo puedes denegar una solicitud marcada como recibida." };
    }
    const rejectionReason = String(formData.get("rejectionReason") || "").trim();
    if (!rejectionReason) {
      return { ok: false, error: "Escribe el motivo de denegacion." };
    }
    await prisma.returnRequest.update({
      where: { id },
      data: {
        status: "por_devolver",
        rejectionReason: appendReasonEntry(requestRow.rejectionReason, {
          kind: "denied_after_received",
          reason: rejectionReason,
        }),
        refundError: null,
      },
    });
    return { ok: true, message: "Reembolso denegado y enviado a devoluciones por devolver." };
  }

  if (intent === "mark_returned_to_customer") {
    if (String(requestRow.status || "").toLowerCase() !== "por_devolver") {
      return { ok: false, error: "Solo puedes confirmar devoluciones pendientes por devolver." };
    }
    await prisma.returnRequest.update({
      where: { id },
      data: {
        status: "reembolso_denegado",
        rejectionReason: appendReasonEntry(requestRow.rejectionReason, {
          kind: RETURNED_TO_CUSTOMER_KIND,
          reason: RETURNED_TO_CUSTOMER_MESSAGE,
        }),
      },
    });
    return { ok: true, message: "Devolucion marcada como devuelta al cliente y enviada al historial." };
  }

  if (intent === "process_refund") {
    if (String(requestRow.status || "").toLowerCase() !== "recibida") {
      return { ok: false, error: "Primero marca la solicitud como recibida." };
    }

    try {
      const snapshot = await fetchOrderSnapshot(admin, requestRow.shopifyOrderId);
      const { refundLineItems, subtotal } = mapRequestItemsToRefundLineItems(
        requestRow.items,
        snapshot.lineItems,
      );
      if (!refundLineItems.length) {
        return { ok: false, error: "No hay lineas para reembolsar." };
      }

      const returnCost = requestRow.returnMethod === "pickup" ? Number(requestRow.returnCost || 0) : 0;
      const finalRefund = subtotal - returnCost;
      if (finalRefund <= 0) {
        return {
          ok: false,
          error:
            "No se puede procesar este reembolso: el costo de recoleccion es mayor o igual al subtotal.",
        };
      }

      const parentTransaction = pickParentTransaction(snapshot.transactions);
      if (!parentTransaction?.id || !parentTransaction?.gateway) {
        return {
          ok: false,
          error:
            "No se encontro una transaccion de pago valida para reembolsar al metodo original.",
        };
      }

      const response = await admin.graphql(
        `#graphql
        mutation RefundRequest($input: RefundInput!) {
          refundCreate(input: $input) {
            refund { id }
            userErrors { field message }
          }
        }`,
        {
          variables: {
            input: {
              orderId: requestRow.shopifyOrderId,
              note: `Devolucion #${requestRow.id} desde Portal de devoluciones`,
              notify: false,
              refundLineItems,
              transactions: [
                {
                  orderId: requestRow.shopifyOrderId,
                  kind: "REFUND",
                  gateway: parentTransaction.gateway,
                  parentId: parentTransaction.id,
                  amount: Number(finalRefund).toFixed(2),
                },
              ],
            },
          },
        },
      );
      const payload = await response.json();
      const topErrors = payload?.errors || [];
      const userErrors = payload?.data?.refundCreate?.userErrors || [];
      if (topErrors.length || userErrors.length) {
        const first = topErrors[0]?.message || userErrors[0]?.message || "No se pudo procesar el reembolso.";
        await prisma.returnRequest.update({
          where: { id },
          data: { refundError: first },
        });
        return { ok: false, error: first };
      }

      const refundId = String(payload?.data?.refundCreate?.refund?.id || "");
      await prisma.returnRequest.update({
        where: { id },
        data: {
          status: "reembolsada",
          refundedAt: new Date(),
          shopifyRefundId: refundId || null,
          refundedSubtotal: subtotal,
          finalRefund,
          refundError: null,
        },
      });
      return { ok: true, message: "Reembolso procesado al metodo de pago original." };
    } catch (error) {
      const message = String(error?.message || error || "No se pudo procesar el reembolso.");
      await prisma.returnRequest.update({
        where: { id },
        data: { refundError: message },
      });
      return { ok: false, error: message };
    }
  }

  return { ok: false, error: "Accion no valida." };
};

function formatPickupDateHeading(pickupDate) {
  const raw = String(pickupDate || "").trim();
  if (!raw) return "sin fecha definida";
  const date = new Date(`${raw}T00:00:00`);
  if (!Number.isFinite(date.getTime())) return "sin fecha definida";
  return date.toLocaleDateString("es-MX", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function buildPickupGroups(requests) {
  const groups = new Map();
  for (const request of requests) {
    const key = String(request.pickupDate || "").trim() || "sin_fecha";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(request);
  }

  const keys = Array.from(groups.keys()).sort((a, b) => {
    if (a === "sin_fecha") return 1;
    if (b === "sin_fecha") return -1;
    const aMs = new Date(`${a}T00:00:00`).getTime();
    const bMs = new Date(`${b}T00:00:00`).getTime();
    return aMs - bMs;
  });

  return keys.map((key) => ({
    key,
    heading: key === "sin_fecha" ? "sin fecha definida" : formatPickupDateHeading(key),
    requests: groups.get(key) || [],
  }));
}

function historyTimestampMs(request) {
  const status = String(request?.status || "").toLowerCase();
  const sourceDate =
    status === "reembolsada" && request?.refundedAt ? request.refundedAt : request?.updatedAt || request?.createdAt;
  const ms = new Date(sourceDate).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export default function ReturnsRequests() {
  const { requests, viewMode } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const reviewRequests = requests.filter(
    (requestRow) => String(requestRow.status || "").toLowerCase() === "en_revision",
  );
  const activeRequests = requests.filter((requestRow) =>
    METHOD_QUEUE_STATUSES.has(String(requestRow.status || "").toLowerCase()),
  );
  const refundQueueRequests = requests.filter((requestRow) =>
    REFUND_QUEUE_STATUSES.has(String(requestRow.status || "").toLowerCase()),
  );
  const returnToCustomerQueueRequests = requests.filter((requestRow) =>
    RETURN_TO_CUSTOMER_STATUSES.has(String(requestRow.status || "").toLowerCase()),
  );
  const pickupRequests = activeRequests.filter((request) => request.returnMethod === "pickup");
  const branchRequests = activeRequests.filter((request) => request.returnMethod !== "pickup");
  const historyRequests = requests
    .filter((requestRow) => HISTORY_STATUSES.has(String(requestRow.status || "").toLowerCase()))
    .sort((a, b) => historyTimestampMs(b) - historyTimestampMs(a));
  const pickupGroups = buildPickupGroups(pickupRequests);

  const pageHeading =
    viewMode === VIEW_MODE.PICKUP
      ? "Recoleccion a domicilio"
      : viewMode === VIEW_MODE.REVIEW
        ? "Ordenes en revision"
      : viewMode === VIEW_MODE.REFUNDS
          ? "Procesar reembolsos"
        : viewMode === VIEW_MODE.TO_RETURN
          ? "Devoluciones a devolver"
        : viewMode === VIEW_MODE.HISTORY
          ? "Historial"
        : "Entrega en sucursal";

  return (
    <s-page heading={pageHeading}>
      {actionData?.error ? <p className={styles.errorMsg}>{actionData.error}</p> : null}
      {actionData?.message ? <p className={styles.successMsg}>{actionData.message}</p> : null}

      {viewMode === VIEW_MODE.BRANCH ? (
        <s-section heading="Entregas en sucursal">
          {branchRequests.length === 0 ? (
            <p>No hay solicitudes de entrega en sucursal.</p>
          ) : (
            <div className={`${styles.wrap} ${styles.reqGrid}`}>
              {branchRequests.map((request) => (
                <RequestCard key={request.id} request={request} isSubmitting={isSubmitting} />
              ))}
            </div>
          )}
        </s-section>
      ) : null}

      {viewMode === VIEW_MODE.PICKUP ? (
        <s-section heading="Recolecciones a domicilio">
          {pickupGroups.length === 0 ? (
            <p>No hay solicitudes de recoleccion a domicilio.</p>
          ) : (
            <div className={`${styles.wrap} ${styles.reqGrid}`}>
              {pickupGroups.map((group) => (
                <div key={group.key} className={styles.card}>
                  <h3 className={styles.reqTitle}>
                    Ordenes de devolucion para recoger el {group.heading}
                  </h3>
                  <div className={styles.divider} />
                  <div className={styles.reqGrid}>
                    {group.requests.map((request) => (
                      <RequestCard key={request.id} request={request} isSubmitting={isSubmitting} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </s-section>
      ) : null}

      {viewMode === VIEW_MODE.REVIEW ? (
        <s-section heading="Ordenes en revision">
          {reviewRequests.length === 0 ? (
            <p>No hay ordenes en revision.</p>
          ) : (
            <div className={`${styles.wrap} ${styles.reqGrid}`}>
              {reviewRequests.map((request) => (
                <RequestCard key={request.id} request={request} isSubmitting={isSubmitting} />
              ))}
            </div>
          )}
        </s-section>
      ) : null}

      {viewMode === VIEW_MODE.REFUNDS ? (
        <s-section heading="Solicitudes listas para procesar reembolsos">
          {refundQueueRequests.length === 0 ? (
            <p>No hay solicitudes listas para procesar reembolsos.</p>
          ) : (
            <div className={`${styles.wrap} ${styles.reqGrid}`}>
              {refundQueueRequests.map((request) => (
                <RequestCard key={request.id} request={request} isSubmitting={isSubmitting} />
              ))}
            </div>
          )}
        </s-section>
      ) : null}

      {viewMode === VIEW_MODE.TO_RETURN ? (
        <s-section heading="Solicitudes pendientes por devolver al cliente">
          {returnToCustomerQueueRequests.length === 0 ? (
            <p>No hay solicitudes pendientes por devolver al cliente.</p>
          ) : (
            <div className={`${styles.wrap} ${styles.reqGrid}`}>
              {returnToCustomerQueueRequests.map((request) => (
                <RequestCard key={request.id} request={request} isSubmitting={isSubmitting} />
              ))}
            </div>
          )}
        </s-section>
      ) : null}

      {viewMode === VIEW_MODE.HISTORY ? (
        <s-section heading="Historial de devoluciones">
          {historyRequests.length === 0 ? (
            <p>No hay ordenes en historial.</p>
          ) : (
            <div className={`${styles.wrap} ${styles.reqGrid}`}>
              {historyRequests.map((request) => (
                <RequestCard key={request.id} request={request} isSubmitting={isSubmitting} />
              ))}
            </div>
          )}
        </s-section>
      ) : null}
    </s-page>
  );
}

function RequestCard({ request, isSubmitting }) {
  const [viewerImage, setViewerImage] = useState(null);
  const status = String(request.status || "").toLowerCase();
  const isPickupMethod = request.returnMethod === "pickup";
  const isPickupFailedAttempt = isPickupFailedAttemptStatus(status);
  const canMarkReceived = status === "aprobada" || isPickupFailedAttempt;
  const canRegisterPickupFailedAttempt =
    isPickupMethod && (status === "aprobada" || status === "intento_fallido_1");
  const canRejectAfterFailedPickups = isPickupMethod && status === "intento_fallido_2";
  const canMarkReturnedToCustomer = status === "por_devolver";
  const remainingPickupAttempts = status === "aprobada" ? 2 : status === "intento_fallido_1" ? 1 : 0;
  const failedAttemptButtonLabel =
    remainingPickupAttempts === 1
      ? "Intento de recoleccion fallido (te queda 1)"
      : `Intento de recoleccion fallido (te quedan ${remainingPickupAttempts})`;
  const statusClassName = styles[getStatusClassName(status)];
  const isDeniedReturnedToCustomer = status === "reembolso_denegado" && request.wasReturnedToCustomer;
  const isHistoryStatus = HISTORY_STATUSES.has(status);
  const closedAt =
    status === "reembolsada" && request.refundedAt ? request.refundedAt : request.updatedAt || null;
  return (
    <article className={styles.card}>
      <div className={styles.reqHeader}>
        <div>
          <h3 className={styles.reqTitle}>Pedido #{request.orderNumber}</h3>
          <p className={styles.meta}>
            {request.customerName} | {request.customerEmail} | {request.customerPhone || "-"}
          </p>
        </div>
        <span className={styles.pill}>
          Estado:{" "}
          <strong className={statusClassName}>
            {isDeniedReturnedToCustomer ? (
              <>
                reembolso denegado - <span className={styles.returnedToCustomerStatus}>devuelto al cliente</span>
              </>
            ) : (
              STATUS_LABEL[status] || status
            )}
          </strong>
        </span>
      </div>

      <details className={styles.details}>
        <summary className={styles.summary}>Ver orden</summary>

        <div className={styles.kv}>
          <div className={styles.kvRow}>
            <span className={styles.kvKey}>Metodo</span>
            <span className={styles.kvVal}>
              {request.returnMethod === "pickup" ? "Recoleccion a domicilio" : "Entrega en sucursal"}
            </span>
          </div>
          <div className={styles.kvRow}>
            <span className={styles.kvKey}>Subtotal (sin impuestos)</span>
            <span className={styles.kvVal}>${toMoney(request.refundedSubtotal || request.estimatedRefund)} MXN</span>
          </div>
          <div className={styles.kvRow}>
            <span className={styles.kvKey}>Costo devolucion</span>
            <span className={styles.kvVal}>${toMoney(request.returnCost)} MXN</span>
          </div>
          <div className={styles.kvRow}>
            <span className={styles.kvKey}>Reembolso final</span>
            <span className={styles.kvVal}>${toMoney(request.finalRefund)} MXN</span>
          </div>
          <div className={styles.kvRow}>
            <span className={styles.kvKey}>Fecha solicitud</span>
            <span className={styles.kvVal}>{new Date(request.createdAt).toLocaleString("es-MX")}</span>
          </div>
          {isHistoryStatus && closedAt ? (
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Fecha de cierre</span>
              <span className={styles.kvVal}>{new Date(closedAt).toLocaleString("es-MX")}</span>
            </div>
          ) : null}
          {request.receivedAt ? (
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Recibida</span>
              <span className={styles.kvVal}>{new Date(request.receivedAt).toLocaleString("es-MX")}</span>
            </div>
          ) : null}
          {request.returnedToCustomerAt ? (
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Devuelta al cliente</span>
              <span className={styles.kvVal}>{new Date(request.returnedToCustomerAt).toLocaleString("es-MX")}</span>
            </div>
          ) : null}
          {request.refundedAt ? (
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Reembolsada</span>
              <span className={styles.kvVal}>{new Date(request.refundedAt).toLocaleString("es-MX")}</span>
            </div>
          ) : null}
        </div>

        {request.returnMethod === "pickup" ? (
          <p className={styles.meta}>
            Recoleccion:{" "}
            {[request.pickupAddress, request.pickupCity, request.pickupState, request.pickupPostalCode]
              .filter(Boolean)
              .join(", ") || "-"}
            {" | "}Dia: {request.pickupDate || "-"}
            {request.pickupNotes ? ` | Notas: ${request.pickupNotes}` : ""}
          </p>
        ) : (
          <p className={styles.meta}>
            Sucursal: {request.branchAddress || "-"} | Horarios: {request.branchHours || "-"}
          </p>
        )}

        {request.reasonEntries?.length ? (
          <div className={styles.reasonHistory}>
            <p className={styles.reasonHistoryTitle}>Historial de motivos enviados</p>
            <ul className={styles.reasonHistoryList}>
              {request.reasonEntries.map((entry, idx) => (
                <li key={`${request.id}_reason_${idx}`} className={styles.reasonHistoryItem}>
                  <strong>{reasonEntryLabel(entry)}:</strong>{" "}
                  <span className={styles.reasonHistoryMessage}>{entry.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {request.refundError ? (
          <p className={styles.errorMsg}>Error de reembolso: {request.refundError}</p>
        ) : null}
        {request.shopifyRefundId ? (
          <p className={styles.successMsg}>Refund ID: {request.shopifyRefundId}</p>
        ) : null}

        <h4 className={styles.orderDetailTitle}>Productos, motivos, fotos y descripcion</h4>
        <ul className={styles.productList}>
          {request.items.map((item) => {
            const photos = parsePhotoUrls(item.photoDataUrl);
            return (
              <li key={item.id} className={styles.productItem}>
                <div className={styles.productItemHeader}>
                  {item.imageUrl ? (
                    <button
                      type="button"
                      className={styles.imageButton}
                      onClick={() =>
                        setViewerImage({
                          src: item.imageUrl,
                          alt: item.imageAlt || item.title,
                        })
                      }
                    >
                      <img
                        src={item.imageUrl}
                        alt={item.imageAlt || item.title}
                        className={styles.productThumb}
                      />
                    </button>
                  ) : (
                    <div className={styles.productThumbPlaceholder} />
                  )}
                  <div className={styles.productCopy}>
                    <p className={styles.productLineTitle}>
                      {item.title} x{item.quantity}
                    </p>
                    <p className={styles.productLineMeta}>Motivo: {item.reason}</p>
                  </div>
                </div>
                {item.details ? <p className={styles.productLineMeta}>Descripcion: {item.details}</p> : null}
                {photos.length ? (
                  <div className={styles.evidencePhotos}>
                    {photos.map((src, idx) => (
                      <button
                        key={`${itemKeyFromRecord(item)}_${idx}`}
                        type="button"
                        className={styles.evidenceLink}
                        onClick={() =>
                          setViewerImage({
                            src,
                            alt: `Evidencia ${idx + 1}`,
                          })
                        }
                      >
                        <img
                          src={src}
                          alt={`Evidencia ${idx + 1}`}
                          className={styles.evidencePhoto}
                        />
                        <span>Foto {idx + 1}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </details>

      <div className={styles.actionRow}>
        {status === "en_revision" ? (
          <>
            <Form method="post">
              <input type="hidden" name="intent" value="approve_request" />
              <input type="hidden" name="id" value={request.id} />
              <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={isSubmitting}>
                Aprobar
              </button>
            </Form>
            <Form method="post" className={styles.rejectForm}>
              <input type="hidden" name="intent" value="reject_request" />
              <input type="hidden" name="id" value={request.id} />
              <input
                className={styles.input}
                name="rejectionReason"
                placeholder="Motivo de rechazo (obligatorio)"
                defaultValue=""
              />
              <button className={styles.btn} type="submit" disabled={isSubmitting}>
                Rechazar
              </button>
            </Form>
          </>
        ) : null}

        {canMarkReceived ? (
          <Form method="post">
            <input type="hidden" name="intent" value="mark_received" />
            <input type="hidden" name="id" value={request.id} />
            <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={isSubmitting}>
              Marcar como recibida
            </button>
          </Form>
        ) : null}

        {canRegisterPickupFailedAttempt ? (
          <Form
            key={`pickup-attempt-${request.id}-${new Date(request.updatedAt).toISOString()}`}
            method="post"
            className={styles.rejectForm}
          >
            <input type="hidden" name="intent" value="pickup_attempt_failed" />
            <input type="hidden" name="id" value={request.id} />
            <input
              className={styles.input}
              name="rejectionReason"
              placeholder="Descripcion del intento fallido (obligatoria)"
              defaultValue=""
            />
            <button className={`${styles.btn} ${styles.btnWarning}`} type="submit" disabled={isSubmitting}>
              {failedAttemptButtonLabel}
            </button>
          </Form>
        ) : null}

        {canRejectAfterFailedPickups ? (
          <Form method="post" className={styles.rejectForm}>
            <input type="hidden" name="intent" value="reject_after_failed_pickups" />
            <input type="hidden" name="id" value={request.id} />
            <input
              className={styles.input}
              name="rejectionReason"
              placeholder="Motivo de rechazo (obligatorio)"
              defaultValue=""
            />
            <button className={`${styles.btn} ${styles.btnDanger}`} type="submit" disabled={isSubmitting}>
              Rechazar devolucion
            </button>
          </Form>
        ) : null}

        {status === "recibida" ? (
          <>
            <Form method="post">
              <input type="hidden" name="intent" value="process_refund" />
              <input type="hidden" name="id" value={request.id} />
              <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={isSubmitting}>
                Procesar reembolso
              </button>
            </Form>
            <Form method="post" className={styles.rejectForm}>
              <input type="hidden" name="intent" value="deny_received" />
              <input type="hidden" name="id" value={request.id} />
              <input
                className={styles.input}
                name="rejectionReason"
                placeholder="Motivo de denegacion (obligatorio)"
                defaultValue=""
              />
              <button className={`${styles.btn} ${styles.btnDanger}`} type="submit" disabled={isSubmitting}>
                Denegar devolucion
              </button>
            </Form>
          </>
        ) : null}

        {canMarkReturnedToCustomer ? (
          <Form method="post">
            <input type="hidden" name="intent" value="mark_returned_to_customer" />
            <input type="hidden" name="id" value={request.id} />
            <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={isSubmitting}>
              Devuelto con exito
            </button>
          </Form>
        ) : null}
      </div>

      <ImageViewer image={viewerImage} onClose={() => setViewerImage(null)} />
    </article>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
