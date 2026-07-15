/* eslint-disable react/prop-types */
import { useEffect, useRef, useState } from "react";
import { Form, Link, useActionData, useFetcher, useLoaderData, useLocation, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  getLatestCourierDeliveryDate,
  markCourierOrderAsDelivered,
  reprogramCourierDeliveryForNextRoute,
} from "../utils/courier.server";
import {
  compareCourierDisplayOrder,
  getCourierRouteStatusFromTags,
  isCourierHistoryStatus,
  isCourierRouteStatus,
} from "../utils/courier.shared";
import { geocodeAddressWithCache, haversineDistanceMeters } from "../utils/googleMaps.server";
import styles from "../styles/admin.module.css";

const STATUS_LABEL = {
  pendiente: "pendiente",
  en_revision: "en revision",
  aprobada: "aprobada",
  en_ruta: "en ruta",
  reintento_pendiente: "reprogramado",
  intento_fallido_1: "intento de devolucion fallido",
  intento_fallido_2: "segundo intento de devolucion fallido",
  por_devolver: "pendiente por recoger",
  no_devuelto: "no devuelto",
  rechazada: "rechazada",
  denegada: "reembolso denegado",
  reembolso_denegado: "reembolso denegado",
  recibida: "recibida",
  reembolsada: "reembolsada",
  completada: "completada",
};

const COURIER_STATUS_TAGS_FOR_ADMIN = [
  "en ruta",
  "en ruta 2",
  "en ruta 3",
  "no entregado",
  "recoger en sucursal",
  "entregado",
  "reembolsada",
  "reprogramado",
  "RPFDT",
];

const VIEW_MODE = {
  PICKUP: "pickup",
  BRANCH: "branch",
  REVIEW: "review",
  REFUNDS: "refunds",
  TO_RETURN: "to_return",
  HISTORY: "history",
  COURIER: "courier",
  COURIER_HISTORY: "courier_history",
  BRANCH_PICKUP: "branch_pickup",
  COURIERS: "couriers",
  PREPARERS: "preparers",
};
const COURIER_HISTORY_SINCE = new Date("2026-06-10T00:00:00-06:00");
const COURIER_ROUTE_PLANNED_ACTION = "courier_route_planned";
const COURIER_ADMIN_REPROGRAM_ACTION = "courier_admin_order_reprogrammed";
const COURIER_ORDER_REFUND_DETAIL_ACTION = "courier_order_refund_detail";
const COURIER_REFUND_DETAIL_ROUTE_PREFIX = "refund:";
const COURIER_ROUTE_REPROGRAM_ACTIONS = new Set([
  "courier_route_delivery_reprogrammed",
  "courier_route_return_reprogrammed",
  COURIER_ADMIN_REPROGRAM_ACTION,
]);
const COURIER_ADMIN_NOT_LOCATED_REPROGRAM_NOTE = "admin_not_located_reprogram:1";

const METHOD_QUEUE_STATUSES = new Set([
  "aprobada",
  "en_ruta",
  "en_ruta_1",
  "en_ruta_2",
  "en_ruta_3",
  "reintento_pendiente",
  "intento_fallido_1",
  "intento_fallido_2",
  "no_recibido",
]);
const REFUND_QUEUE_STATUSES = new Set(["recibida"]);
const RETURN_TO_CUSTOMER_STATUSES = new Set(["por_devolver"]);
const BRANCH_PICKUP_STATUSES = new Set([
  "por_devolver",
  "no_devuelto",
  "reembolso_denegado",
  "denegada",
]);
const HISTORY_STATUSES = new Set(["reembolsada", "rechazada", "denegada", "reembolso_denegado", "no_devuelto"]);
const RETURNED_TO_CUSTOMER_NOTIFICATION_TITLE = "Devolución entregada ✅";
const RETURNED_TO_CUSTOMER_MESSAGE = "Te regresamos tu devolución con éxito en nuestra sucursal. Agradecemos tu comprensión.";
const RETURNED_TO_CUSTOMER_KIND = "returned_to_customer";
const NOT_RETURNED_KIND = "not_returned_after_30_days";
const REQUEST_CREATED_KIND = "request_created";
const STATUS_REVIEW_KIND = "status_review";
const STATUS_APPROVED_KIND = "status_approved";
const STATUS_RECEIVED_KIND = "status_received";
const STATUS_IN_ROUTE_KIND = "status_in_route";
const STATUS_REFUNDED_KIND = "status_refunded";
const TIMELINE_META_KINDS = new Set([
  REQUEST_CREATED_KIND,
  STATUS_REVIEW_KIND,
  STATUS_APPROVED_KIND,
  STATUS_RECEIVED_KIND,
  STATUS_IN_ROUTE_KIND,
  STATUS_REFUNDED_KIND,
  RETURNED_TO_CUSTOMER_KIND,
  NOT_RETURNED_KIND,
]);
const NOT_RETURNED_REASON = "El cliente no recogió su paquete de devolución en sucursal en 60 días.";
const PICKUP_DEADLINE_DAYS = 30;
const NOT_RETURNED_ACTION_DEADLINE_DAYS = 60;
const NOTIFICATIONS_API_BASE_URL = String(
  process.env.NOTIFICATIONS_API_URL || "https://centro-de-notificaciones-cariana.onrender.com",
).replace(/\/+$/, "");
const NOTIFICATIONS_API_KEY = String(
  process.env.NOTIFICATIONS_API_KEY || process.env.APP_INTERNAL_API_KEY || "",
).trim();

const RETURN_EVENT_BY_INTENT = {
  approve_request: "return_approved",
  reject_request: "return_rejected",
  mark_received: "return_picked_up",
  pickup_attempt_failed: "return_pickup_scheduled",
  reject_after_failed_pickups: "return_rejected",
  deny_received: "return_rejected",
  mark_returned_to_customer: "return_rejected",
  mark_not_returned: "return_rejected",
  mark_never_arrived: "return_expired",
  process_refund: "refund_completed",
};

function buildReturnReference(requestRow) {
  if (!requestRow) return "";
  const orderNumber = String(requestRow.orderNumber || "").trim();
  if (orderNumber) return orderNumber;
  const id = Number(requestRow.id || 0);
  return id ? `DEV-${id}` : "";
}

function buildReturnEventPayload({ requestRow, intent, note, title = "", message = "" }) {
  const mappedStatus = RETURN_EVENT_BY_INTENT[intent];
  if (!mappedStatus || !requestRow) return null;

  const returnReference = buildReturnReference(requestRow);
  const cleanMessage = String(message || "").trim();
  return {
    status: mappedStatus,
    event: mappedStatus,
    action: intent,
    title: String(title || "").trim(),
    message: cleanMessage,
    portal_status_message: cleanMessage || String(note || "").trim(),
    current_status_message: cleanMessage || String(note || "").trim(),
    return_reference: returnReference,
    return_id: requestRow.id || null,
    order_number: requestRow.orderNumber || null,
    email: requestRow.customerEmail || null,
    customer_email: requestRow.customerEmail || null,
    customer: {
      email: requestRow.customerEmail || null,
      name: requestRow.customerName || null,
      phone: requestRow.customerPhone || null,
    },
    note: note || "",
    source: "portal_devoluciones",
    return_method: requestRow.returnMethod || null,
  };
}

function buildReturnedToCustomerMessage(requestRow) {
  const orderNumber = String(requestRow?.orderNumber || "").replace(/^#/, "").trim() || "****";
  return `📦 Pedido #${orderNumber}. ${RETURNED_TO_CUSTOMER_MESSAGE}`;
}

async function emitReturnNotificationEvent({ shopDomain, requestRow, intent, note = "", title = "", message = "" }) {
  if (!shopDomain || !NOTIFICATIONS_API_BASE_URL) {
    return;
  }
  const eventPayload = buildReturnEventPayload({ requestRow, intent, note, title, message });
  if (!eventPayload) return;

  const endpoints = NOTIFICATIONS_API_KEY
    ? [
        `${NOTIFICATIONS_API_BASE_URL}/api/returns/events`,
        `${NOTIFICATIONS_API_BASE_URL}/proxy/returns/events`,
      ]
    : [`${NOTIFICATIONS_API_BASE_URL}/proxy/returns/events`];

  let lastFailure = null;
  for (const endpoint of endpoints) {
    const headers = {
      "Content-Type": "application/json",
      "x-shop-domain": shopDomain,
    };
    if (NOTIFICATIONS_API_KEY) {
      headers["x-api-key"] = NOTIFICATIONS_API_KEY;
    }

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          shopDomain,
          event: eventPayload,
        }),
      });

      if (response.ok) {
        return;
      }

      const detail = await response.text().catch(() => "");
      lastFailure = {
        endpoint,
        status: response.status,
        detail: String(detail || "").slice(0, 300),
      };
    } catch (error) {
      lastFailure = {
        endpoint,
        error: String(error?.message || error || "unknown"),
      };
    }
  }

  console.error("Failed to emit return notification event", {
    shopDomain,
    intent,
    ...lastFailure,
  });
}

async function loadBranchReturnSettings(shopDomain) {
  const latestSettings = await prisma.returnSettings.findFirst({
    where: {
      OR: [
        { branchAddress: { not: "" } },
        { branchHours: { not: "" } },
        { pickupHours: { not: "" } },
      ],
    },
    select: {
      branchAddress: true,
      branchHours: true,
      pickupHours: true,
    },
    orderBy: { updatedAt: "desc" },
  });
  const exactSettings = shopDomain
    ? await prisma.returnSettings.findUnique({
        where: { shop: shopDomain },
        select: {
          branchAddress: true,
          branchHours: true,
          pickupHours: true,
        },
      })
    : null;
  return exactSettings || latestSettings || {};
}

function formatDeniedRefundPickupDeadline(rawValue) {
  const date = new Date(rawValue);
  if (!Number.isFinite(date.getTime())) return "-";
  const parts = new Intl.DateTimeFormat("es-MX", {
    timeZone: "America/Mexico_City",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.day} de ${String(values.month || "").toLowerCase()} de ${values.year}`;
}

function buildDeniedRefundPickupMessage({ requestRow, reason, pickupDeadlineAt, branchAddress, branchHours }) {
  const orderNumber = String(requestRow?.orderNumber || "").replace(/^#/, "").trim() || "****";
  const cleanReason = String(reason || "").trim();
  const reasonText = cleanReason ? `${cleanReason} ` : "";
  return [
    `📦 Pedido #${orderNumber}. ${reasonText}por ese motivo se denego tu reembolso. Tienes 30 dias para recoger tu devolucion, tienes hasta el ${formatDeniedRefundPickupDeadline(pickupDeadlineAt)} para recoger tu devolución en nuestra sucursal.`,
    `📍 Dirección de la sucursal: ${String(branchAddress || "-").trim() || "-"}`,
    `🕒 Horario de la sucursal: ${String(branchHours || "-").trim() || "-"}`,
    "Para recoger tu devolución, será necesario presentar:",
    "✅ Número de pedido.",
    "✅ Nombre del comprador.",
    "Agradecemos tu comprensión.",
  ].join("\n");
}

async function emitOrderStatusNotification({ shopDomain, requestRow, status, note = "" }) {
  if (!shopDomain || !requestRow || !NOTIFICATIONS_API_BASE_URL || !NOTIFICATIONS_API_KEY) {
    return;
  }

  const latestSettings = await prisma.returnSettings.findFirst({
    where: {
      OR: [
        { branchAddress: { not: "" } },
        { branchHours: { not: "" } },
        { pickupHours: { not: "" } },
      ],
    },
    select: {
      branchAddress: true,
      branchHours: true,
      pickupHours: true,
    },
    orderBy: { updatedAt: "desc" },
  });
  const exactSettings = await prisma.returnSettings.findUnique({
    where: { shop: shopDomain },
    select: {
      branchAddress: true,
      branchHours: true,
      pickupHours: true,
    },
  });
  const settings = exactSettings || latestSettings;
  const endpoint = `${NOTIFICATIONS_API_BASE_URL}/api/orders/manual-status`;
  const headers = {
    "Content-Type": "application/json",
    "x-shop-domain": shopDomain,
    "x-api-key": NOTIFICATIONS_API_KEY,
  };

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        shopDomain,
        orderNumber: requestRow.orderNumber || null,
        customerEmail: requestRow.customerEmail || null,
        status,
        branchAddress: settings?.branchAddress || null,
        branchHours: settings?.branchHours || null,
        pickupHours: settings?.pickupHours || null,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error("Failed to emit order status notification", {
        shopDomain,
        orderNumber: requestRow.orderNumber || null,
        status,
        note,
        endpoint,
        responseStatus: response.status,
        detail: String(detail || "").slice(0, 300),
      });
    }
  } catch (error) {
    console.error("Failed to emit order status notification", {
      shopDomain,
      orderNumber: requestRow.orderNumber || null,
      status,
      note,
      endpoint,
      error: String(error?.message || error || "unknown"),
    });
  }
}

function formatBranchPickupRefundAmount(amount, currencyCode = "MXN") {
  const numeric = Number(amount || 0);
  const normalizedAmount = Number.isFinite(numeric) ? numeric : 0;
  const formattedAmount = new Intl.NumberFormat("es-ES", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(normalizedAmount);
  const currency = String(currencyCode || "MXN").trim().toUpperCase() || "MXN";
  return `${formattedAmount} ${currency}$`;
}

function buildBranchPickupRefundNotificationCopy(orderNumber, refundAmount, currencyCode = "MXN") {
  const cleanOrderNumber = String(orderNumber || "").replace(/^#/, "").trim() || "****";
  const amountLabel = formatBranchPickupRefundAmount(refundAmount, currencyCode);
  return {
    title: "Reembolso procesado ✅",
    message: `💰 El reembolso de tu pedido #${cleanOrderNumber} ya fue procesado por la cantidad de ${amountLabel}, debido a que venció el plazo de 30 días para recoger tu pedido en nuestra sucursal. El reembolso se verá reflejado en tu cuenta en un plazo de 5 a 10 días hábiles, dependiendo de los tiempos de procesamiento de tu banco.\n\n¡Te agradecemos por confiar en Cariana! ✨`,
  };
}

function buildCourierOrderRefundNotificationCopy({
  orderNumber,
  refundAmount,
  currencyCode = "MXN",
  selectedAllLineItems = false,
  refundedItems = [],
}) {
  const cleanOrderNumber = String(orderNumber || "").replace(/^#/, "").trim() || "****";
  const currency = String(currencyCode || "MXN").trim().toUpperCase() || "MXN";
  const amountLabel = `$${toMoney(refundAmount)} ${currency}`;
  if (selectedAllLineItems) {
    return {
      title: "Reembolso realizado 💰",
      message: `📦 Pedido #${cleanOrderNumber}. Durante la preparación de tu pedido detectamos que el producto ya no estaba disponible. Para evitar cualquier demora, procesamos el reembolso de tu compra por la cantidad de ${amountLabel}. El monto se reflejará en tu cuenta de 5 a 10 días hábiles, dependiendo de tu banco. Lamentamos este inconveniente y esperamos poder atenderte nuevamente pronto. Att Cariana. ✨`,
    };
  }

  const itemLines = (refundedItems || [])
    .filter((item) => String(item?.title || "").trim())
    .map((item) => {
      const quantity = Math.max(1, Number(item.quantity || 1));
      const title = String(item.title || "").trim();
      const quantitySuffix = quantity > 1 ? ` x${quantity}` : "";
      const itemTotal = Number(item.total || 0);
      return `• ${title}${quantitySuffix} — $${toMoney(itemTotal)} ${currency}`;
    });
  const refundedItemCount = (refundedItems || []).reduce(
    (sum, item) => sum + Math.max(1, Number(item?.quantity || 1)),
    0,
  );
  const refundIntro =
    refundedItemCount === 1
      ? "Hemos procesado el reembolso del siguiente producto debido a que ya no se encuentra disponible:"
      : "Hemos procesado el reembolso de los siguientes productos debido a que ya no se encuentran disponibles:";

  return {
    title: "Reembolso parcial procesado 💰",
    message: [
      `📦 Pedido #${cleanOrderNumber}. ${refundIntro}`,
      ...(itemLines.length ? itemLines : [`• Productos seleccionados — ${amountLabel}`]),
      `Total reembolsado: ${amountLabel} 💰`,
      "El monto se reflejará en tu cuenta de 5 a 10 días hábiles, dependiendo de tu banco. Los demás artículos de tu pedido sí serán enviados y recibirás una notificación cuando vayan en camino. Agradecemos tu comprensión y la confianza que has depositado en Cariana. ✨",
    ].join("\n"),
  };
}

function buildRefundProcessedMessage(requestRow, finalRefund) {
  const orderNumber = String(requestRow?.orderNumber || "").replace(/^#/, "").trim() || "****";
  return `Pedido #${orderNumber}. 💸 Tu reembolso ya fue procesado correctamente por la cantidad de $${toMoney(finalRefund)} MXN. Dependiendo de tu banco, el monto podrá verse reflejado en tu cuenta dentro de 5 a 10 días hábiles. Gracias por confiar en Cariana. 💙`;
}

async function emitBranchPickupRefundNotification({ shopDomain, requestId, orderNumber, refundAmount, currencyCode }) {
  if (!shopDomain || !requestId || !NOTIFICATIONS_API_BASE_URL) {
    return;
  }
  const copy = buildBranchPickupRefundNotificationCopy(orderNumber, refundAmount, currencyCode);
  const endpoints = NOTIFICATIONS_API_KEY
    ? [
        {
          url: `${NOTIFICATIONS_API_BASE_URL}/api/orders/manual-status`,
          headers: {
            "Content-Type": "application/json",
            "x-shop-domain": shopDomain,
            "x-api-key": NOTIFICATIONS_API_KEY,
          },
        },
        {
          url: `${NOTIFICATIONS_API_BASE_URL}/proxy/orders/manual-status`,
          headers: {
            "Content-Type": "application/json",
            "x-shop-domain": shopDomain,
          },
        },
      ]
    : [
        {
          url: `${NOTIFICATIONS_API_BASE_URL}/proxy/orders/manual-status`,
          headers: {
            "Content-Type": "application/json",
            "x-shop-domain": shopDomain,
          },
        },
      ];

  let lastFailure = null;
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: endpoint.headers,
        body: JSON.stringify({
          shopDomain,
          orderId: requestId,
          orderNumber,
          status: "refund_processed",
          title: copy.title,
          message: copy.message,
        }),
      });
      const responsePayload = await response.json().catch(() => null);
      if (response.ok && !responsePayload?.result?.skipped) {
        return;
      }
      lastFailure = {
        endpoint: endpoint.url,
        status: response.status,
        detail: String(
          responsePayload?.error ||
            responsePayload?.detail ||
            responsePayload?.result?.reason ||
            "No se pudo enviar la notificacion de reembolso.",
        ).slice(0, 300),
      };
    } catch (error) {
      lastFailure = {
        endpoint: endpoint.url,
        error: String(error?.message || error || "unknown"),
      };
    }
  }

  console.error("Failed to emit branch pickup refund notification", {
    shopDomain,
    orderNumber,
    requestId,
    ...lastFailure,
  });
}

async function emitCourierOrderRefundNotification({
  shopDomain,
  requestId,
  orderNumber,
  refundAmount,
  currencyCode,
  selectedAllLineItems,
  refundedItems,
  refundId,
}) {
  if (!shopDomain || !requestId || !NOTIFICATIONS_API_BASE_URL) {
    return;
  }
  const copy = buildCourierOrderRefundNotificationCopy({
    orderNumber,
    refundAmount,
    currencyCode,
    selectedAllLineItems,
    refundedItems,
  });
  const endpoints = NOTIFICATIONS_API_KEY
    ? [
        {
          url: `${NOTIFICATIONS_API_BASE_URL}/api/orders/manual-status`,
          headers: {
            "Content-Type": "application/json",
            "x-shop-domain": shopDomain,
            "x-api-key": NOTIFICATIONS_API_KEY,
          },
        },
        {
          url: `${NOTIFICATIONS_API_BASE_URL}/proxy/orders/manual-status`,
          headers: {
            "Content-Type": "application/json",
            "x-shop-domain": shopDomain,
          },
        },
      ]
    : [
        {
          url: `${NOTIFICATIONS_API_BASE_URL}/proxy/orders/manual-status`,
          headers: {
            "Content-Type": "application/json",
            "x-shop-domain": shopDomain,
          },
        },
      ];

  let lastFailure = null;
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: endpoint.headers,
        body: JSON.stringify({
          shopDomain,
          orderId: requestId,
          orderNumber,
          status: "refund_processed",
          title: copy.title,
          message: copy.message,
          source: "courier_order_refund",
          notificationSource: "courier_order_refund",
          refundKind: selectedAllLineItems ? "full" : "partial",
          refundId: refundId || "",
          suppressRefundWebhook: true,
          suppressOrderInTransitWebhook: true,
        }),
      });
      const responsePayload = await response.json().catch(() => null);
      if (response.ok && !responsePayload?.result?.skipped) {
        return;
      }
      lastFailure = {
        endpoint: endpoint.url,
        status: response.status,
        detail: String(
          responsePayload?.error ||
            responsePayload?.detail ||
            responsePayload?.result?.reason ||
            "No se pudo enviar la notificacion de reembolso de orden del repartidor.",
        ).slice(0, 300),
      };
    } catch (error) {
      lastFailure = {
        endpoint: endpoint.url,
        error: String(error?.message || error || "unknown"),
      };
    }
  }

  console.error("Failed to emit courier order refund notification", {
    shopDomain,
    orderNumber,
    requestId,
    ...lastFailure,
  });
}

function encodeCourierRefundDetailRouteId(detail) {
  try {
    return `${COURIER_REFUND_DETAIL_ROUTE_PREFIX}${JSON.stringify(detail || {})}`;
  } catch {
    return "";
  }
}

function parseCourierRefundDetailActivity(activity) {
  if (String(activity?.action || "").trim() !== COURIER_ORDER_REFUND_DETAIL_ACTION) return null;
  const rawRouteId = String(activity?.routeId || "").trim();
  if (!rawRouteId.startsWith(COURIER_REFUND_DETAIL_ROUTE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(rawRouteId.slice(COURIER_REFUND_DETAIL_ROUTE_PREFIX.length));
    const amount = Number(parsed?.amount || 0);
    return {
      id: activity.id,
      orderNumber: parsed?.orderNumber || activity.orderNumber || "",
      amount: Number.isFinite(amount) ? amount : 0,
      currencyCode: String(parsed?.currencyCode || "MXN").trim().toUpperCase() || "MXN",
      fullRefund: Boolean(parsed?.fullRefund),
      items: Array.isArray(parsed?.items) ? parsed.items : [],
      notificationTitle: String(parsed?.notificationTitle || "").trim(),
      notificationMessage: String(parsed?.notificationMessage || "").trim(),
      notificationSentAt: parsed?.notificationSentAt || activity.createdAt || "",
      refundedAt: parsed?.refundedAt || activity.createdAt || "",
      createdAt: activity.createdAt || "",
    };
  } catch {
    return null;
  }
}

function latestCourierRefundDetail(activities = []) {
  return [...(activities || [])]
    .map(parseCourierRefundDetailActivity)
    .filter(Boolean)
    .sort((first, second) => parseEventMs(second.refundedAt || second.createdAt) - parseEventMs(first.refundedAt || first.createdAt))[0] || null;
}

function courierRefundDetailsFromActivities(activities = []) {
  return [...(activities || [])]
    .map(parseCourierRefundDetailActivity)
    .filter(Boolean)
    .sort((first, second) => parseEventMs(first.refundedAt || first.createdAt) - parseEventMs(second.refundedAt || second.createdAt));
}

function courierRefundedUnitKeySetFromDetails(details = []) {
  const refundedCountsByLineId = new Map();
  const explicitKeys = new Set();
  for (const detail of details || []) {
    for (const item of detail?.items || []) {
      const lineItemId = String(item?.lineItemId || "").trim();
      if (!lineItemId) continue;
      const itemUnitKeys = Array.isArray(item?.unitKeys) ? item.unitKeys : [];
      if (itemUnitKeys.length) {
        for (const unitKey of itemUnitKeys) {
          const cleanUnitKey = String(unitKey || "").trim();
          if (cleanUnitKey) explicitKeys.add(cleanUnitKey);
        }
        refundedCountsByLineId.set(lineItemId, Number(refundedCountsByLineId.get(lineItemId) || 0) + itemUnitKeys.length);
      } else {
        refundedCountsByLineId.set(
          lineItemId,
          Number(refundedCountsByLineId.get(lineItemId) || 0) + Math.max(1, Number(item?.quantity || 1)),
        );
      }
    }
  }
  for (const [lineItemId, count] of refundedCountsByLineId.entries()) {
    for (let index = 1; index <= Number(count || 0); index += 1) {
      explicitKeys.add(`${lineItemId}::${index}`);
    }
  }
  return explicitKeys;
}

function courierRefundedUnitKeySetFromActivities(activities = []) {
  return courierRefundedUnitKeySetFromDetails(courierRefundDetailsFromActivities(activities));
}

function courierRefundUnitKeyFromItem(item, index = 0) {
  return `${String(item?.lineItemId || item?.id || item?.title || "item")}::${Number(index || 0) + 1}`;
}

function preparerMissingUnitKeySetFromOrder(order = {}) {
  const explicitKeys = new Set(
    (Array.isArray(order?.preparerMissingUnitKeys) ? order.preparerMissingUnitKeys : [])
      .map((unitKey) => String(unitKey || "").trim())
      .filter(Boolean),
  );
  for (const item of Array.isArray(order?.items) ? order.items : []) {
    for (const unitKey of Array.isArray(item?.preparerMissingUnitKeys) ? item.preparerMissingUnitKeys : []) {
      const cleanUnitKey = String(unitKey || "").trim();
      if (cleanUnitKey) explicitKeys.add(cleanUnitKey);
    }
  }
  return explicitKeys;
}

function preparerMissingRefundUnitKeysFromOrder(order = {}) {
  return [...preparerMissingUnitKeySetFromOrder(order)];
}

function orderUnitCount(items = []) {
  return (Array.isArray(items) ? items : []).reduce(
    (count, item) => count + Math.max(1, Number(item?.quantity || 1)),
    0,
  );
}

function preparerNotLocatedScopeFromOrder(order = {}, fallbackItems = []) {
  const items = Array.isArray(order?.items) && order.items.length ? order.items : fallbackItems;
  const totalUnits = orderUnitCount(items);
  const missingCount = preparerMissingUnitKeySetFromOrder(order).size;
  if (missingCount > 0 && totalUnits > 0 && missingCount < totalUnits) return "partial";
  return "full";
}

const PICKUP_FAILED_REASON_OPTIONS = [
  "No logramos completar la recolección. 🚚 Visitamos tu domicilio, pero no obtuvimos respuesta al tocar la puerta ni al comunicarnos contigo. Nuestro equipo volverá a intentarlo mañana. 📦✨",
  "Recolección reagendada. 📦✨ Nos comunicamos contigo y acordamos realizar un nuevo intento de recolección el día de mañana, ya que no te encontrabas en el domicilio indicado. 🚚",
];
const REJECT_AFTER_FAILED_AUTO_REASON =
  "❌🚚 Después de 3 intentos de recolección en el domicilio registrado, no fue posible recibir el producto. Por esta razón, la solicitud de devolución fue rechazada automáticamente.";
const REJECT_AFTER_FAILED_REASON_OPTIONS = [
  REJECT_AFTER_FAILED_AUTO_REASON,
];
const NEVER_ARRIVED_BRANCH_REASON = "Nunca llego a la sucursal para completar la devolucion.";


function getStatusClassName(status) {
  if (status === "en_revision") return "statusReview";
  if (status === "aprobada") return "statusApproved";
  if (status === "en_ruta") return "statusApproved";
  if (status === "reintento_pendiente") return "statusReprogrammed";
  if (status === "intento_fallido_1" || status === "intento_fallido_2") return "statusAttemptFailed";
  if (status === "por_devolver") return "statusPendingReturn";
  if (status === "rechazada") return "statusRejected";
  if (status === "reembolso_denegado") return "statusDenied";
  if (status === "no_devuelto") return "statusDenied";
  if (status === "no_localizado") return "statusNotLocated";
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
  if (value === VIEW_MODE.COURIER) return VIEW_MODE.COURIER;
  if (value === VIEW_MODE.COURIER_HISTORY) return VIEW_MODE.COURIER_HISTORY;
  if (value === VIEW_MODE.BRANCH_PICKUP) return VIEW_MODE.BRANCH_PICKUP;
  if (value === VIEW_MODE.COURIERS) return VIEW_MODE.COURIERS;
  if (value === VIEW_MODE.PREPARERS) return VIEW_MODE.PREPARERS;
  return VIEW_MODE.BRANCH;
}

function viewModeFromPathname(pathname) {
  const path = String(pathname || "")
    .toLowerCase()
    .replace(/\/+$/, "");
  if (path.endsWith("/pickup")) return VIEW_MODE.PICKUP;
  if (path.endsWith("/branch")) return VIEW_MODE.BRANCH;
  if (path.endsWith("/review")) return VIEW_MODE.REVIEW;
  if (path.endsWith("/refunds")) return VIEW_MODE.REFUNDS;
  if (path.endsWith("/to_return")) return VIEW_MODE.TO_RETURN;
  if (path.endsWith("/history")) return VIEW_MODE.HISTORY;
  if (path.endsWith("/courier_history")) return VIEW_MODE.COURIER_HISTORY;
  if (path.endsWith("/repartidor")) return VIEW_MODE.COURIER;
  if (path.endsWith("/branch_pickup")) return VIEW_MODE.BRANCH_PICKUP;
  if (path.endsWith("/couriers")) return VIEW_MODE.COURIERS;
  if (path.endsWith("/preparers")) return VIEW_MODE.PREPARERS;
  return "";
}

function toMoney(value) {
  return Number(value || 0).toFixed(2);
}

function nextIsoDate(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const date = match
    ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12))
    : new Date(raw);
  if (!Number.isFinite(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
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

function returnRequestItemsSignature(requestRow) {
  const itemParts = (requestRow?.items || [])
    .map((item) => `${itemKeyFromRecord(item)}:${Math.max(1, Number(item?.quantity || 1))}`)
    .sort();
  if (!itemParts.length) return `request:${requestRow?.id || ""}`;
  const orderReference =
    String(requestRow?.shopifyOrderId || "").trim() ||
    String(requestRow?.orderNumber || "").trim();
  return `${orderReference}|${itemParts.join(",")}`;
}

function returnRequestOrderReferences(requestRow) {
  const references = new Set();
  const shopifyOrderId = String(requestRow?.shopifyOrderId || "").trim();
  const orderNumber = String(requestRow?.orderNumber || "").replace(/^#/, "").trim();
  const shopifyOrderNumericId = shopifyOrderId.match(/(\d+)$/)?.[1] || "";

  if (shopifyOrderId) references.add(`shopify:${shopifyOrderId}`);
  if (shopifyOrderNumericId) references.add(`shopify-numeric:${shopifyOrderNumericId}`);
  if (orderNumber) references.add(`order-number:${orderNumber}`);

  return Array.from(references);
}

function requestWasCreatedAfter(candidate, reference) {
  const candidateCreatedAt = new Date(candidate?.createdAt || 0).getTime();
  const referenceCreatedAt = new Date(reference?.createdAt || 0).getTime();
  if (candidateCreatedAt !== referenceCreatedAt) {
    return candidateCreatedAt > referenceCreatedAt;
  }
  return Number(candidate?.id || 0) > Number(reference?.id || 0);
}

function excludePickupRequestsSupersededByBranch(requestRows) {
  const rows = Array.isArray(requestRows) ? requestRows : [];
  const latestBranchRequestBySignature = new Map();
  const branchPickupOrderReferences = new Set();

  for (const requestRow of rows) {
    const returnMethod = String(requestRow?.returnMethod || "").trim().toLowerCase();
    const status = String(requestRow?.status || "").trim().toLowerCase();
    if (BRANCH_PICKUP_STATUSES.has(status)) {
      for (const orderReference of returnRequestOrderReferences(requestRow)) {
        branchPickupOrderReferences.add(orderReference);
      }
    }
    if (returnMethod !== "pickup") {
      const signature = returnRequestItemsSignature(requestRow);
      const current = latestBranchRequestBySignature.get(signature);
      if (!current || requestWasCreatedAfter(requestRow, current)) {
        latestBranchRequestBySignature.set(signature, requestRow);
      }
    }
  }

  return rows.filter((requestRow) => {
    if (String(requestRow?.returnMethod || "").trim().toLowerCase() !== "pickup") return false;
    if (BRANCH_PICKUP_STATUSES.has(String(requestRow?.status || "").trim().toLowerCase())) return false;
    if (
      returnRequestOrderReferences(requestRow).some((orderReference) =>
        branchPickupOrderReferences.has(orderReference),
      )
    ) {
      return false;
    }
    const branchRequest = latestBranchRequestBySignature.get(returnRequestItemsSignature(requestRow));
    return !branchRequest || !requestWasCreatedAfter(branchRequest, requestRow);
  });
}

function formatVariantSummary(variantNode) {
  const options = Array.isArray(variantNode?.selectedOptions) ? variantNode.selectedOptions : [];
  const labels = options
    .map((option) => {
      const name = String(option?.name || "").trim();
      const value = String(option?.value || "").trim();
      if (!name || !value) return "";
      return `${name}: ${value}`;
    })
    .filter(Boolean);
  if (labels.length) return labels.join(" | ");
  const fallback = String(variantNode?.title || "").trim();
  if (!fallback || fallback.toLowerCase() === "default title") return "";
  return fallback;
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

function normalizeDisplayedReasonText(rawValue) {
  const text = String(rawValue || "").trim();
  if (!text) return "";
  const compact = text.replace(/\s+/g, " ").trim();
  const lowered = compact.toLowerCase();
  if (lowered === "tu reembolso fue procesado al metodo de pago original.") {
    return "💸 Tu reembolso ya fue procesado correctamente. Dependiendo de tu banco, el monto podrá verse reflejado en tu cuenta dentro de 5 a 10 días hábiles. Gracias por confiar en Cariana. 💙";
  }
  if (lowered === "recibimos tu producto. estamos validando para finalizar el proceso.") {
    return "Producto recibido. 📦 Hemos recibido tu devolución y nuestro equipo ya se encuentra revisando tu producto. Una vez finalizado el proceso de verificación, realizaremos tu reembolso correspondiente. 💰 Regresa mas tarde para ver el estado de tu devolucion.";
  }
  if (
    lowered.includes("devolucion fue regresada con ecxito") ||
    lowered.includes("devolucion fue regresada con éxito") ||
    lowered.includes("devoluciã³n fue regresada con ã©xito")
  ) {
    return RETURNED_TO_CUSTOMER_MESSAGE;
  }
  return compact
    .replace(/ecxito/gi, "éxito")
    .replace(/devoluciã³n/gi, "devolución")
    .replace(/ã©xito/gi, "éxito");
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
        reason: normalizeDisplayedReasonText(entry?.reason),
        at: entry?.at ? String(entry.at) : "",
      }))
      .filter((entry) => entry.reason);
  } catch {
    return [{ kind: "legacy", reason: normalizeDisplayedReasonText(text), at: "" }];
  }
}

function isReturnedToCustomerEntry(entry) {
  return String(entry?.kind || "").toLowerCase() === RETURNED_TO_CUSTOMER_KIND;
}

function isSystemProgressEntry(entry) {
  const kind = String(entry?.kind || "").toLowerCase();
  return TIMELINE_META_KINDS.has(kind);
}

function latestReturnedToCustomerAtFromRaw(rawValue) {
  const entries = parseReasonEntries(rawValue);
  for (let idx = entries.length - 1; idx >= 0; idx -= 1) {
    if (!isReturnedToCustomerEntry(entries[idx])) continue;
    return String(entries[idx]?.at || "").trim();
  }
  return "";
}

function latestEntryAtFromKinds(rawValue, kinds) {
  const kindSet = new Set((kinds || []).map((kind) => String(kind || "").toLowerCase()));
  if (!kindSet.size) return "";
  const entries = parseReasonEntries(rawValue);
  for (let idx = entries.length - 1; idx >= 0; idx -= 1) {
    const kind = String(entries[idx]?.kind || "").toLowerCase();
    if (!kindSet.has(kind)) continue;
    return String(entries[idx]?.at || "").trim();
  }
  return "";
}

function formatReturnRescheduleDate(rawValue) {
  const text = String(rawValue || "").trim();
  const slashMatch = text.match(/^(\d{1,2})\/([^/]+)\/(\d{4})$/);
  if (slashMatch) {
    const month = slashMatch[2].trim();
    const capitalizedMonth = month ? `${month.charAt(0).toUpperCase()}${month.slice(1)}` : "";
    return `${slashMatch[1]}/${capitalizedMonth}/${slashMatch[3]}`;
  }
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!isoMatch) return text;
  const date = new Date(Date.UTC(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3])));
  const parts = new Intl.DateTimeFormat("es-MX", {
    timeZone: "UTC",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const month = String(values.month || "").trim();
  const capitalizedMonth = month ? `${month.charAt(0).toUpperCase()}${month.slice(1)}` : "";
  return `${values.day}/${capitalizedMonth}/${values.year}`;
}

function formatRefundQueueDate(rawValue) {
  const isoDateMatch = String(rawValue || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDateMatch) {
    const date = new Date(
      Date.UTC(Number(isoDateMatch[1]), Number(isoDateMatch[2]) - 1, Number(isoDateMatch[3]), 12),
    );
    const parts = new Intl.DateTimeFormat("es-MX", {
      timeZone: "UTC",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.day}/${String(values.month || "").toLowerCase()}/${values.year}`;
  }
  const date = new Date(rawValue);
  if (!Number.isFinite(date.getTime())) return "-";
  const parts = new Intl.DateTimeFormat("es-MX", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.day}/${String(values.month || "").toLowerCase()}/${values.year}`;
}

function formatRefundQueueDateTime(rawValue) {
  const date = new Date(rawValue);
  if (!Number.isFinite(date.getTime())) return "-";
  return `${formatRefundQueueDate(rawValue)}, ${new Intl.DateTimeFormat("es-MX", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date)}`;
}

function latestRouteTimeRescheduleDate(requestRow) {
  const entries = parseReasonEntries(requestRow?.rejectionReason);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (String(entry?.kind || "").toLowerCase() !== "courier_route_time_reprogrammed") continue;
    const dateLabel = String(entry?.reason || "").match(/Reprogramado para el ([^.\n]+)/i)?.[1] || "";
    if (dateLabel) return formatReturnRescheduleDate(dateLabel);
  }
  return formatReturnRescheduleDate(requestRow?.pickupDate);
}

function routeTimeRescheduleDateFromReason(reason) {
  const dateLabel = String(reason || "").match(/Reprogramado para el ([^.\n]+)/i)?.[1] || "";
  return dateLabel ? formatReturnRescheduleDate(dateLabel) : "";
}

function buildReturnRouteTimeRescheduleMessage(requestRow, dateOverride = "") {
  const orderNumber = String(requestRow?.orderNumber || "").replace(/^#/, "").trim() || "****";
  const dateLabel = dateOverride || latestRouteTimeRescheduleDate(requestRow);
  const pickupHours = String(requestRow?.pickupHours || "").trim();
  const pickupHoursText = pickupHours ? ` en un horario de ${pickupHours}` : "";
  return (
    `🚚 Pedido #${orderNumber}. Tu devolución no pudo ser recogida el día de hoy debido a ajustes operativos en la ruta de recolección, ` +
    `tu devolución ha sido reprogramada para mañana${dateLabel ? ` ${dateLabel}` : ""}${pickupHoursText}.\n` +
    "Agradecemos tu comprensión y por confiar siempre en Cariana . ✨"
  );
}

function addDays(dateValue, days) {
  const base = new Date(dateValue);
  if (!Number.isFinite(base.getTime())) return null;
  const result = new Date(base);
  result.setDate(result.getDate() + Number(days || 0));
  return result;
}

function branchDeliveryExpirationDate(limitDateValue) {
  const limitDate = new Date(limitDateValue);
  if (!Number.isFinite(limitDate.getTime())) return null;
  const expiresAt = new Date(limitDate);
  expiresAt.setHours(0, 0, 0, 0);
  expiresAt.setDate(expiresAt.getDate() + 1);
  return expiresAt;
}

function isBranchDeliveryExpired(limitDateValue, now = new Date()) {
  const expiresAt = branchDeliveryExpirationDate(limitDateValue);
  return Boolean(expiresAt) && now.getTime() >= expiresAt.getTime();
}

function appendReasonEntry(rawValue, entry) {
  const entries = parseReasonEntries(rawValue);
  entries.push({
    kind: String(entry?.kind || "legacy"),
    reason: String(entry?.reason || "").trim(),
    at: String(entry?.at || "").trim() || new Date().toISOString(),
  });
  return JSON.stringify({ entries });
}

function appendTimelineMetaEntry(rawValue, entry) {
  const kind = String(entry?.kind || "").trim().toLowerCase();
  if (!kind) return rawValue || "";
  const entries = parseReasonEntries(rawValue);
  if (entries.some((item) => String(item?.kind || "").toLowerCase() === kind)) {
    return JSON.stringify({ entries });
  }
  entries.push({
    kind,
    reason: String(entry?.reason || "").trim(),
    at: new Date().toISOString(),
  });
  return JSON.stringify({ entries });
}

function latestReasonFromRaw(rawValue) {
  const entries = parseReasonEntries(rawValue);
  for (let idx = entries.length - 1; idx >= 0; idx -= 1) {
    if (isSystemProgressEntry(entries[idx])) continue;
    return entries[idx]?.reason || "";
  }
  return "";
}

function reasonEntryLabel(entry) {
  const kind = String(entry?.kind || "").toLowerCase();
  if (kind === "attempt_failed_1") return "Primer intento";
  if (kind === "attempt_failed_2") return "Segundo intento";
  if (kind === "attempt_failed_3") return "Tercer intento";
  if (kind === "rejected_after_attempts") return "Motivo de rechazo final";
  if (kind === "review_rejected") return "Motivo de rechazo";
  if (kind === "denied_after_received") return "Motivo de denegacion";
  if (kind === RETURNED_TO_CUSTOMER_KIND) return "Devuelto al cliente";
  if (kind === NOT_RETURNED_KIND) return "No devuelto";
  return "Motivo";
}

function timelineLabelFromStatus(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "en_revision") return "Solicitud en revision";
  if (normalized === "aprobada") return "Devolucion aprobada";
  if (normalized === "en_ruta") return "En ruta";
  if (normalized === "reintento_pendiente") return "Reprogramado";
  if (normalized === "intento_fallido_1") return "Primer intento";
  if (normalized === "intento_fallido_2") return "Segundo intento";
  if (normalized === "rechazada") return "Devolucion rechazada";
  if (normalized === "recibida") return "Recibimos tu producto";
  if (normalized === "por_devolver") return "Pendiente por recoger";
  if (normalized === "no_devuelto") return "No devuelto";
  if (normalized === "denegada" || normalized === "reembolso_denegado") return "Reembolso denegado";
  if (normalized === "reembolsada" || normalized === "completada") return "Reembolso procesado";
  return "Estado actualizado";
}

function timelineLabelFromReasonEntry(entry) {
  const kind = String(entry?.kind || "").toLowerCase();
  const courierRouteMatch = kind.match(/^courier_en_route_(\d)$/);
  if (courierRouteMatch) return `${courierAttemptLabel(courierRouteMatch[1])} en ruta`;
  const courierRetryMatch = kind.match(/^courier_retry_(\d)$/);
  if (courierRetryMatch) return `${courierAttemptLabel(courierRetryMatch[1])} reprogramado`;
  if (kind === "courier_route_time_reprogrammed") return "Reprogramado";
  if (kind === STATUS_REVIEW_KIND) return "Solicitud en revision";
  if (kind === STATUS_APPROVED_KIND) return "Devolucion aprobada";
  if (kind === STATUS_IN_ROUTE_KIND) return "En ruta";
  if (kind === STATUS_RECEIVED_KIND) return "Recibimos tu producto";
  if (kind === STATUS_REFUNDED_KIND) return "Reembolso procesado";
  if (kind === "attempt_failed_1") return "Primer intento";
  if (kind === "attempt_failed_2") return "Segundo intento";
  if (kind === "review_rejected" || kind === "rejected_after_attempts") return "Devolucion rechazada";
  if (kind === "denied_after_received") return "Reembolso denegado";
  if (kind === "never_arrived_branch") return "No devuelto";
  if (kind === NOT_RETURNED_KIND) return "No devuelto";
  if (kind === RETURNED_TO_CUSTOMER_KIND) return "Devolucion devuelta al cliente";
  return "";
}

function timelineToneFromStatus(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "en_revision") return "review";
  if (normalized === "aprobada") return "approved";
  if (normalized === "en_ruta") return "approved";
  if (normalized === "reintento_pendiente") return "reprogrammed";
  if (normalized === "intento_fallido_1" || normalized === "intento_fallido_2" || normalized === "intento_fallido_3") return "attempt";
  if (normalized === "rechazada") return "rejected";
  if (normalized === "recibida") return "received";
  if (normalized === "por_devolver") return "pending";
  if (normalized === "denegada" || normalized === "reembolso_denegado" || normalized === "no_devuelto") return "denied";
  if (normalized === "reembolsada" || normalized === "completada") return "refunded";
  return "default";
}

function timelineToneFromReasonEntry(entry) {
  const kind = String(entry?.kind || "").toLowerCase();
  if (kind === REQUEST_CREATED_KIND) return "default";
  if (kind === STATUS_REVIEW_KIND) return "review";
  if (kind === STATUS_APPROVED_KIND) return "approved";
  if (kind === STATUS_IN_ROUTE_KIND) return "approved";
  if (kind === "courier_route_time_reprogrammed") return "reprogrammed";
  if (kind === STATUS_RECEIVED_KIND) return "received";
  if (kind === STATUS_REFUNDED_KIND) return "refunded";
  if (kind === "attempt_failed_1" || kind === "attempt_failed_2" || kind === "attempt_failed_3") return "attempt";
  if (kind === "review_rejected" || kind === "rejected_after_attempts") return "rejected";
  if (kind === "denied_after_received") return "denied";
  if (kind === "never_arrived_branch") return "denied";
  if (kind === RETURNED_TO_CUSTOMER_KIND) return "returnedToCustomer";
  if (kind === NOT_RETURNED_KIND) return "denied";
  return "default";
}

function branchApprovedPortalMessage(requestRow) {
  const orderNumber = String(requestRow?.orderNumber || "").replace(/^#/, "").trim();
  const prefix = orderNumber ? `📦Pedido #${orderNumber}. ` : "📦";
  return `${prefix}Tu solicitud de devolución fue aprobada. Por favor, lleva tu producto a la sucursal de devoluciones antes de la fecha limite de entrega siguiendo las instrucciones de entrega.`;
}

function receivedReturnPortalMessage(requestRow) {
  const orderNumber = String(requestRow?.orderNumber || "").replace(/^#/, "").trim();
  const prefix = orderNumber ? `📦Pedido #${orderNumber}. ` : "📦";
  return `${prefix}Producto recibido. Hemos recibido tu devolución y nuestro equipo ya se encuentra revisando tu producto. Una vez finalizado el proceso de verificación, realizaremos tu reembolso correspondiente. 💰 Regresa mas tarde para ver el estado de tu devolucion.`;
}

function reviewReturnPortalMessage(requestRow) {
  const orderNumber = String(requestRow?.orderNumber || "").replace(/^#/, "").trim() || "****";
  return `📦 Pedido #${orderNumber}. Nuestro equipo ya comenzó el proceso de verificación de tu producto. Revisaremos la descripción y las fotografías del problema reportado. Una vez que validemos tu solicitud, te notificaremos el resultado. Regresa más tarde para consultar el estado de tu devolución.`;
}

function pickupApprovedPortalMessage(requestRow) {
  const orderNumber = String(requestRow?.orderNumber || "").replace(/^#/, "").trim() || "****";
  return `📦Pedido #${orderNumber}. Tu solicitud fue aprobada exitosamente. Nuestro equipo recogerá tu pedido en el domicilio y fecha indicados por ti. 🚚 Gracias por confiar y ser parte de Cariana. 💙`;
}

function expiredReturnPortalMessage(requestRow) {
  const orderNumber = String(requestRow?.orderNumber || "").replace(/^#/, "").trim() || "****";
  return `Pedido #${orderNumber}. Estimado cliente, la fecha límite para entregar tu devolución ha expirado. Lamentablemente, ya no podremos aceptar el producto.`;
}

function timelineStatusDescription(status, requestRow) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "en_revision") {
    return reviewReturnPortalMessage(requestRow);
  }
  if (normalized === "aprobada") {
    return requestRow.returnMethod === "pickup"
      ? pickupApprovedPortalMessage(requestRow)
      : branchApprovedPortalMessage(requestRow);
  }
  if (normalized === "en_ruta") {
    return "Tu recoleccion ya va en ruta hacia tu domicilio. Nuestro equipo se dirige para continuar el proceso.";
  }
  if (normalized === "reintento_pendiente") {
    return buildReturnRouteTimeRescheduleMessage(requestRow);
  }
  if (normalized === "recibida") {
    return receivedReturnPortalMessage(requestRow);
  }
  if (normalized === "reembolsada" || normalized === "completada") {
    return "Tu reembolso ya fue procesado al metodo de pago original.";
  }
  if (normalized === "por_devolver") {
    return "Tu paquete esta pendiente por recoger en sucursal.";
  }
  if (normalized === "reembolso_denegado" || normalized === "denegada") {
    const denialReason = String(requestRow?.rejectionReason || "").trim();
    return denialReason || "El reembolso fue denegado. Revisa el motivo de denegacion.";
  }
  if (normalized === "rechazada") {
    const rejectionReason = String(requestRow?.rejectionReason || "").trim();
    return rejectionReason || "Tu solicitud fue rechazada. Revisa el motivo para mas detalle.";
  }
  if (normalized === "no_devuelto") {
    return expiredReturnPortalMessage(requestRow);
  }
  return "";
}

function timelineKindFromStatus(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "en_revision") return STATUS_REVIEW_KIND;
  if (normalized === "aprobada") return STATUS_APPROVED_KIND;
  if (normalized === "en_ruta") return STATUS_IN_ROUTE_KIND;
  if (normalized === "recibida") return STATUS_RECEIVED_KIND;
  if (normalized === "reembolsada" || normalized === "completada") return STATUS_REFUNDED_KIND;
  return "";
}

function hasReachedApprovedPhase(status) {
  const normalized = String(status || "").toLowerCase();
  return [
    "aprobada",
    "en_ruta",
    "intento_fallido_1",
    "intento_fallido_2",
    "recibida",
    "por_devolver",
    "no_devuelto",
    "denegada",
    "reembolso_denegado",
    "reembolsada",
    "completada",
  ].includes(normalized);
}

function parseEventMs(value) {
  const text = String(value || "").trim();
  if (!text) return 0;
  const ms = new Date(text).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function buildStatusTimeline(
  requestRow,
  hideCourierProgress = false,
  { hideCourierRouteStarts = false, hidePendingReturnStatus = false } = {},
) {
  const events = [];
  const entryKinds = new Set(
    (requestRow.timelineEntries || []).map((entry) => String(entry?.kind || "").toLowerCase()).filter(Boolean),
  );
  const pushEvent = (label, at, note = "", tone = "default") => {
    const atMs = parseEventMs(at);
    if (!label || !atMs) return;
    events.push({
      id: `${label}-${atMs}-${events.length}`,
      label,
      at,
      atMs,
      note,
      tone,
    });
  };

  if (requestRow.requiresReview && !entryKinds.has(STATUS_REVIEW_KIND)) {
    pushEvent("Solicitud en revision", requestRow.createdAt, reviewReturnPortalMessage(requestRow), "review");
  }
  if (requestRow.requiresReview && !entryKinds.has(STATUS_APPROVED_KIND) && hasReachedApprovedPhase(requestRow.status)) {
    pushEvent(
      "Devolucion aprobada",
      requestRow.receivedAt || requestRow.updatedAt || requestRow.createdAt,
      requestRow.returnMethod === "pickup"
        ? pickupApprovedPortalMessage(requestRow)
        : branchApprovedPortalMessage(requestRow),
      "approved",
    );
  }
  if (!requestRow.requiresReview && !entryKinds.has(STATUS_APPROVED_KIND)) {
    pushEvent(
      "Devolucion aprobada",
      requestRow.createdAt,
      requestRow.returnMethod === "pickup"
        ? pickupApprovedPortalMessage(requestRow)
        : branchApprovedPortalMessage(requestRow),
      "approved",
    );
  }
  if (!entryKinds.has(STATUS_RECEIVED_KIND)) {
    pushEvent(
      "Recibimos tu producto",
      requestRow.receivedAt,
      receivedReturnPortalMessage(requestRow),
      "received",
    );
  }
  if (!entryKinds.has(STATUS_REFUNDED_KIND)) {
    pushEvent(
      "Reembolso procesado",
      requestRow.refundedAt,
      buildRefundProcessedMessage(requestRow, requestRow.finalRefund),
      "refunded",
    );
  }
  if (!entryKinds.has(RETURNED_TO_CUSTOMER_KIND)) {
    pushEvent("Devolucion devuelta al cliente", requestRow.returnedToCustomerAt, RETURNED_TO_CUSTOMER_MESSAGE, "returnedToCustomer");
  }

  for (const entry of requestRow.timelineEntries || []) {
    const kind = String(entry?.kind || "").toLowerCase();
    if (hideCourierRouteStarts && kind.startsWith("courier_en_route_")) continue;
    if (hideCourierProgress && (kind.startsWith("courier_en_route_") || kind.startsWith("courier_retry_"))) continue;
    const label = timelineLabelFromReasonEntry(entry);
    if (!label) continue;
    const note = kind === STATUS_APPROVED_KIND
      ? requestRow.returnMethod === "pickup"
        ? pickupApprovedPortalMessage(requestRow)
        : branchApprovedPortalMessage(requestRow)
      : kind === STATUS_REVIEW_KIND
      ? reviewReturnPortalMessage(requestRow)
      : kind === STATUS_RECEIVED_KIND
      ? receivedReturnPortalMessage(requestRow)
      : kind === STATUS_REFUNDED_KIND
      ? buildRefundProcessedMessage(requestRow, requestRow.finalRefund)
      : kind === "courier_route_time_reprogrammed"
      ? buildReturnRouteTimeRescheduleMessage(requestRow, routeTimeRescheduleDateFromReason(entry.reason))
      : kind === "never_arrived_branch"
      ? expiredReturnPortalMessage(requestRow)
      : kind === RETURNED_TO_CUSTOMER_KIND
        ? normalizeDisplayedReasonText(entry.reason) || RETURNED_TO_CUSTOMER_MESSAGE
        : normalizeDisplayedReasonText(entry.reason);
    pushEvent(label, entry.at, note, timelineToneFromReasonEntry(entry));
  }

  const currentStatusKind = timelineKindFromStatus(requestRow.status);
  const hasExplicitNotReturnedStatus = ["never_arrived_branch", NOT_RETURNED_KIND].some((kind) => entryKinds.has(kind));
  const shouldSkipReturnedToCustomerDeniedFallback =
    String(requestRow.status || "").toLowerCase() === "reembolso_denegado" && entryKinds.has(RETURNED_TO_CUSTOMER_KIND);
  const shouldSkipPendingReturnStatus =
    hidePendingReturnStatus && String(requestRow.status || "").toLowerCase() === "por_devolver";
  const shouldSkipCurrentStatusFallback =
    shouldSkipReturnedToCustomerDeniedFallback ||
    shouldSkipPendingReturnStatus ||
    (String(requestRow.status || "").toLowerCase() === "no_devuelto" && hasExplicitNotReturnedStatus);
  if (!shouldSkipCurrentStatusFallback && (!currentStatusKind || !entryKinds.has(currentStatusKind))) {
    pushEvent(
      timelineLabelFromStatus(requestRow.status),
      requestRow.updatedAt,
      timelineStatusDescription(requestRow.status, requestRow),
      timelineToneFromStatus(requestRow.status),
    );
  }

  const dedup = new Map();
  for (const event of events) {
    const key = `${event.label}|${event.atMs}`;
    if (!dedup.has(key)) dedup.set(key, event);
  }

  return Array.from(dedup.values()).sort((a, b) => b.atMs - a.atMs);
}

function courierAttemptLabel(attempt) {
  const attemptNumber = Number(attempt || 0);
  if (attemptNumber === 1) return "Primer intento";
  if (attemptNumber === 2) return "Segundo intento";
  if (attemptNumber === 3) return "Tercer intento";
  return "Intento";
}

function courierAttemptCountLabel(attempt) {
  const attemptNumber = Number(attempt || 0);
  if (attemptNumber <= 0) return "";
  return attemptNumber === 1 ? "1 intento" : `${attemptNumber} intentos`;
}

function getReturnFailedAttemptCountFromReason(rawValue) {
  return parseReasonEntries(rawValue).reduce((maxAttempt, entry) => {
    const match = String(entry?.kind || "").trim().toLowerCase().match(/^attempt_failed_(\d)$/);
    return match ? Math.max(maxAttempt, Number(match[1]) || 0) : maxAttempt;
  }, 0);
}

function returnRetryAttemptNumber(request, status) {
  const normalized = String(status || request?.status || "").trim().toLowerCase();
  const routeAttemptMatch = normalized.match(/^en_ruta_(\d)$/);
  if (routeAttemptMatch) return Math.min(Math.max(Number(routeAttemptMatch[1]) || 1, 1), 3);
  if (normalized !== "reintento_pendiente") return 0;
  const failedAttemptCount = Math.max(
    Number(request?.attemptCount || 0),
    getReturnFailedAttemptCountFromReason(request?.rejectionReason),
    1,
  );
  return Math.min(failedAttemptCount + 1, 3);
}

function courierAttemptBadgeLabel(attempt) {
  return courierAttemptLabel(attempt).toLowerCase();
}

function isReturnCourierLabel(value) {
  return String(value || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase() === "devolucion";
}

function pickupRescheduleAttemptLabel(status) {
  const match = String(status || "").trim().toLowerCase().match(/^intento_fallido_(\d)$/);
  if (!match) return "";
  const attempt = Number(match[1]) || 0;
  return `${attempt} ${attempt === 1 ? "intento" : "intentos"}`;
}

function courierEventLabel(status, attempt) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "reintento_pendiente" && Number(attempt || 0) <= 0) return "Reprogramado";
  const attemptLabel = courierAttemptLabel(attempt);
  if (normalized === "en_ruta" || normalized.startsWith("en_ruta_")) return `${attemptLabel} en ruta`;
  if (normalized === "no_entregado") return `${attemptLabel} no entregado`;
  if (normalized === "reintento_pendiente") return `${attemptLabel} reprogramado`;
  if (normalized === "recoger_en_sucursal") return "Enviado a recoger en sucursal";
  if (normalized === "entregado") return `${attemptLabel} entregado`;
  if (normalized === "reembolsada") return "Reembolsado";
  return normalized.replace(/_/g, " ");
}

function courierHistoryEventLabel(event) {
  const note = String(event?.note || "").trim();
  const routeTimeMatch = note.match(/route_time_rescheduled:([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
  if (routeTimeMatch) {
    const dateLabel = formatCourierRescheduledDate(new Date(`${routeTimeMatch[1]}T12:00:00.000Z`));
    if (isAdminNotLocatedReprogramNote(note)) {
      return dateLabel
        ? `Reprogramada por no localizado para el ${dateLabel}`
        : "Reprogramada por no localizado";
    }
    return dateLabel
      ? `Reprogramada por falta de tiempo para el ${dateLabel}`
      : "Reprogramada por falta de tiempo";
  }
  const label = courierEventLabel(event.status, event.attempt);
  if (String(event.status || "").trim().toLowerCase() !== "reintento_pendiente") return label;
  const eventDate = new Date(event.createdAt);
  if (!Number.isFinite(eventDate.getTime())) return label;
  const mexicoDateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(eventDate);
  const mexicoDateLookup = Object.fromEntries(mexicoDateParts.map((part) => [part.type, part.value]));
  const reprogrammedDate = new Date(Date.UTC(
    Number(mexicoDateLookup.year),
    Number(mexicoDateLookup.month) - 1,
    Number(mexicoDateLookup.day) + 1,
  ));
  const formattedDate = new Intl.DateTimeFormat("es-MX", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(reprogrammedDate);
  return `${label} para el ${formattedDate}`;
}

function isAdminNotLocatedReprogramNote(value) {
  return String(value || "").includes(COURIER_ADMIN_NOT_LOCATED_REPROGRAM_NOTE);
}

function isAdminNotLocatedReprogramActivity(activity) {
  return String(activity?.action || "").trim().toLowerCase() === COURIER_ADMIN_REPROGRAM_ACTION;
}

function isAdminNotLocatedReprogramEvent(event) {
  return isAdminNotLocatedReprogramNote(event?.note) || Boolean(event?.adminNotLocatedReprogram);
}

function insertMissingRouteSequenceIdsByOrderNumber(primaryIds, missingIds, orderNumberByRequestId) {
  const sequenceIds = [...new Set((Array.isArray(primaryIds) ? primaryIds : []).filter(Boolean))];
  const missingSequenceIds = [...new Set((Array.isArray(missingIds) ? missingIds : []).filter(Boolean))]
    .filter((requestId) => !sequenceIds.includes(requestId))
    .sort((firstId, secondId) =>
      String(orderNumberByRequestId.get(firstId) || "").localeCompare(
        String(orderNumberByRequestId.get(secondId) || ""),
        "es",
        { numeric: true, sensitivity: "base" },
      ),
    );

  for (const missingId of missingSequenceIds) {
    const missingOrderNumber = String(orderNumberByRequestId.get(missingId) || "").trim();
    if (!missingOrderNumber) {
      sequenceIds.push(missingId);
      continue;
    }
    const insertIndex = sequenceIds.findIndex((requestId) => {
      const orderNumber = String(orderNumberByRequestId.get(requestId) || "").trim();
      return (
        orderNumber &&
        missingOrderNumber.localeCompare(orderNumber, "es", { numeric: true, sensitivity: "base" }) < 0
      );
    });
    if (insertIndex >= 0) sequenceIds.splice(insertIndex, 0, missingId);
    else sequenceIds.push(missingId);
  }

  return sequenceIds;
}

function routeTimeReprogramLabel(dateLabel, event) {
  if (isAdminNotLocatedReprogramEvent(event)) {
    return dateLabel
      ? `Reprogramada por no localizado para el ${dateLabel}`
      : "Reprogramada por no localizado";
  }
  return dateLabel
    ? `Reprogramada por falta de tiempo para el ${dateLabel}`
    : "Reprogramada por falta de tiempo";
}

function returnCourierHistoryLabel(entry, finalAttempt) {
  const kind = String(entry?.kind || "").trim().toLowerCase();
  if (kind === STATUS_APPROVED_KIND) return "";
  if (kind.startsWith("courier_retry_") || kind === "rejected_after_attempts") return "";
  if (kind === "courier_route_time_reprogrammed") {
    const dateLabel = normalizeCourierRescheduledDateLabel(
      String(entry?.reason || "").match(/Reprogramado para el ([^.\n]+)/i)?.[1] || "",
    );
    return dateLabel
      ? `Reprogramada por falta de tiempo para el ${dateLabel}`
      : "Reprogramada por falta de tiempo";
  }
  const failedAttemptMatch = kind.match(/^attempt_failed_(\d)$/);
  if (failedAttemptMatch) return `${courierAttemptLabel(failedAttemptMatch[1])} no recibido`;
  if (kind === STATUS_RECEIVED_KIND) return `${courierAttemptLabel(finalAttempt)} recibido`;
  return timelineLabelFromReasonEntry(entry);
}

function returnCourierHistoryDedupeKey(event) {
  const label = String(event?.label || "").trim().toLowerCase();
  const attemptMatch = label.match(/^(primer|segundo|tercer) intento/i);
  if (!attemptMatch) return `${label}|${event.atMs}`;
  const action = /\ben ruta\b/i.test(label)
    ? "route"
    : /\bno (?:entregado|recibido)\b/i.test(label)
      ? "failed"
      : label.replace(attemptMatch[0], "").trim();
  return `${attemptMatch[1]}|${action}`;
}

function dedupeReturnCourierHistoryEvents(events) {
  const eventByKey = new Map();
  for (const event of events) {
    const key = returnCourierHistoryDedupeKey(event);
    const existingEvent = eventByKey.get(key);
    if (!existingEvent || /\bno recibido\b/i.test(String(event.label || ""))) {
      eventByKey.set(key, event);
    }
  }
  return Array.from(eventByKey.values());
}

function normalizeReturnCourierHistoryEvents(events) {
  return dedupeReturnCourierHistoryEvents((events || []).map((event) => ({
    ...event,
    label: String(event?.label || "").replace(
      /^(Primer|Segundo|Tercer) intento no entregado$/i,
      "$1 intento no recibido",
    ),
  })));
}

function courierAttemptFromHistoryEvents(historyEvents, fallbackAttempt = 0) {
  const historyAttempt = (historyEvents || []).reduce((maxAttempt, event) => {
    const match = String(event?.label || "").match(/^(Primer|Segundo|Tercer) intento/i);
    if (!match) return maxAttempt;
    const attempt = match[1].toLowerCase() === "primer" ? 1 : match[1].toLowerCase() === "segundo" ? 2 : 3;
    return Math.max(maxAttempt, attempt);
  }, 0);
  return Math.max(historyAttempt, Number(fallbackAttempt || 0));
}

function courierAttemptFromHistoryLabel(label) {
  const match = String(label || "").match(/^(Primer|Segundo|Tercer) intento/i);
  if (!match) return 0;
  const attemptLabel = match[1].toLowerCase();
  if (attemptLabel === "primer") return 1;
  if (attemptLabel === "segundo") return 2;
  return 3;
}

function courierAttemptHeading(attempt) {
  const attemptNumber = Number(attempt || 0);
  if (attemptNumber === 1) return "Primer intento";
  if (attemptNumber === 2) return "Segundo intento";
  if (attemptNumber === 3) return "Tercer intento";
  return "";
}

function courierActivityAttempt(action) {
  const normalizedAction = String(action || "").trim().toLowerCase();
  if (normalizedAction === "courier_retry_delivery" || normalizedAction === "courier_return_for_retry") return 0;
  const routeMatch = normalizedAction.match(/^courier_return_(?:en_route|retry)_(\d)$/);
  if (routeMatch) return Number(routeMatch[1]) || 0;
  const attemptMatch = normalizedAction.match(/_(\d)$/);
  if (attemptMatch) return Number(attemptMatch[1]) || 0;
  return 0;
}

function activityForCourierHistoryEvent(event, activities = []) {
  const eventAttempt = courierAttemptFromHistoryLabel(event?.label);
  const eventMs = parseEventMs(event?.at);
  const sameAttemptActivities = activities.filter((activity) => {
    const activityAttempt = courierActivityAttempt(activity.action);
    return !eventAttempt || !activityAttempt || activityAttempt === eventAttempt;
  });
  const candidates = sameAttemptActivities.length ? sameAttemptActivities : activities;
  const sortedCandidates = [...candidates].sort(
    (firstActivity, secondActivity) =>
      Math.abs(parseEventMs(firstActivity.createdAt) - eventMs) -
      Math.abs(parseEventMs(secondActivity.createdAt) - eventMs),
  );
  return sortedCandidates[0] || null;
}

function activityCourierNameForEvent(event, activities = []) {
  const activity = activityForCourierHistoryEvent(event, activities);
  return String(activity?.courierName || "").trim();
}

function transferredCourierNameForEvent(event, activities = [], transferActivityByRouteId) {
  const activity = activityForCourierHistoryEvent(event, activities);
  const routeId = String(activity?.routeId || "").trim();
  if (!routeId) return "";
  const transferActivity = transferActivityByRouteId?.get(routeId);
  if (!transferActivity) return "";
  const activityMs = parseEventMs(activity?.createdAt);
  const transferMs = parseEventMs(transferActivity?.createdAt);
  if (!activityMs || !transferMs || activityMs < transferMs) return "";
  return String(transferActivity?.courierName || "").trim();
}

function isBranchPickupHistoryEvent(event) {
  const status = String(event?.status || "").trim().toLowerCase();
  const action = String(event?.action || "").trim().toLowerCase();
  const label = String(event?.label || "").trim();
  return (
    status === "recoger_en_sucursal" ||
    Boolean(event?.branchPickupFinal) ||
    action === "courier_branch_pickup_refunded" ||
    action === "courier_branch_pickup_delivered" ||
    /enviado a recoger en sucursal/i.test(label)
  );
}

function isBranchPickupHistoryOrder(request, events = []) {
  if (isReturnCourierLabel(request?.courierLabel)) return false;
  return [
    ...(events || []),
    ...(Array.isArray(request?.branchPickupHistoryEvents) ? request.branchPickupHistoryEvents : []),
    ...(Array.isArray(request?.unfilteredHistoryEvents) ? request.unfilteredHistoryEvents : []),
  ].some((event) => isBranchPickupHistoryEvent(event));
}

function isBranchPickupHistoryAttemptCandidate(request, events = []) {
  if (isReturnCourierLabel(request?.courierLabel)) return false;
  const status = String(request?.status || request?.currentStatus || "").trim().toLowerCase();
  const attemptCount = Math.max(
    Number(request?.attemptCount || 0),
    courierAttemptFromHistoryEvents(events, 0),
    courierAttemptFromHistoryEvents(request?.historyEvents || [], 0),
  );
  const labels = [
    ...(events || []),
    ...(Array.isArray(request?.historyEvents) ? request.historyEvents : []),
    ...(Array.isArray(request?.branchPickupHistoryEvents) ? request.branchPickupHistoryEvents : []),
    ...(Array.isArray(request?.unfilteredHistoryEvents) ? request.unfilteredHistoryEvents : []),
  ]
    .map((event) => String(event?.label || "").trim())
    .join(" ");
  return (
    attemptCount >= 3 &&
    (
      ["no_entregado", "no_recibido", "recoger_en_sucursal", "reembolsada"].includes(status) ||
      /\btercer intento\b/i.test(labels) ||
      /\b3 intentos?\b/i.test(labels)
    )
  );
}

function branchPickupFinalStatusLabel(request, events = []) {
  const normalizedStatus = String(request?.status || request?.currentStatus || "").trim().toLowerCase();
  const allEvents = [
    ...(events || []),
    ...(Array.isArray(request?.historyEvents) ? request.historyEvents : []),
    ...(Array.isArray(request?.branchPickupHistoryEvents) ? request.branchPickupHistoryEvents : []),
    ...(Array.isArray(request?.unfilteredHistoryEvents) ? request.unfilteredHistoryEvents : []),
  ];
  if (
    normalizedStatus === "reembolsada" ||
    allEvents.some((event) => {
      const action = String(event?.action || "").trim().toLowerCase();
      const status = String(event?.status || "").trim().toLowerCase();
      const label = String(event?.label || "").trim();
      return action === "courier_branch_pickup_refunded" || status === "reembolsada" || /\breembolsad[ao]\b/i.test(label);
    })
  ) {
    return "reembolsado";
  }
  if (
    normalizedStatus === "entregado" ||
    allEvents.some((event) => {
      const action = String(event?.action || "").trim().toLowerCase();
      const status = String(event?.status || "").trim().toLowerCase();
      const label = String(event?.label || "").trim();
      return action === "courier_mark_delivered" || status === "entregado" || /entregado en sucursal/i.test(label);
    })
  ) {
    return "entregado en sucursal";
  }
  return "";
}

function enrichCourierHistoryEvents({ events, request, activitiesByRequestId, transferActivityByRouteId }) {
  const requestId = String(request?.id || "").trim();
  const activities = activitiesByRequestId?.get(requestId) || [];
  const branchPickupOrder = isBranchPickupHistoryOrder(request, events);
  const enrichedEvents = (events || []).map((event) => {
    const activityCourierName = activityCourierNameForEvent(event, activities);
    return {
      ...event,
      courierName: activityCourierName || String(event?.courierName || "").trim(),
      transferredCourierName: String(event?.transferredCourierName || "").trim() ||
        transferredCourierNameForEvent(event, activities, transferActivityByRouteId),
    };
  });
  const branchFinalEvents = activities
    .filter((activity) => {
      const action = String(activity?.action || "").trim().toLowerCase();
      return action === "courier_branch_pickup_refunded" || (branchPickupOrder && action === "courier_mark_delivered");
    })
    .map((activity) => {
      const action = String(activity?.action || "").trim().toLowerCase();
      return {
        id: `branch-pickup-final-${activity.id || activity.createdAt || action}`,
        label: action === "courier_branch_pickup_refunded" ? "Reembolsado" : "Entregado en sucursal",
        at: activity.createdAt,
        atMs: parseEventMs(activity.createdAt),
        note: "",
        status: action === "courier_branch_pickup_refunded" ? "reembolsada" : "entregado",
        action,
        courierName: String(activity?.courierName || "").trim(),
        branchPickupFinal: true,
      };
    })
    .filter((event) => event.atMs);
  const branchFinalActions = new Set(branchFinalEvents.map((event) => event.action));
  const filteredEnrichedEvents = branchPickupOrder
    ? enrichedEvents.filter((event) => {
        const status = String(event?.status || "").trim().toLowerCase();
        const label = String(event?.label || "").trim();
        if (branchFinalActions.has("courier_mark_delivered") && status === "entregado") return false;
        if (
          branchFinalActions.has("courier_mark_delivered") &&
          /\b(?:primer|segundo|tercer)?\s*intento\s+entregado\b/i.test(label)
        ) {
          return false;
        }
        return true;
      })
    : enrichedEvents;
  return mergeCourierHistoryEvents(filteredEnrichedEvents, branchFinalEvents);
}

function buildCourierHistoryDisplayItems(events, request, { hideTransferDetails = false } = {}) {
  const items = [];
  const shownAttemptKeys = new Set();
  const shownRouteTimeKeys = new Set();
  const dedupedEvents = dedupeCourierHistoryEvents(events) || [];
  const transferredCourierNameByAttempt = new Map();
  for (const event of dedupedEvents) {
    const attempt = courierAttemptFromHistoryLabel(event?.label);
    const transferredCourierName = String(event?.transferredCourierName || "").trim();
    if (attempt && transferredCourierName) {
      transferredCourierNameByAttempt.set(attempt, transferredCourierName);
    }
  }
  for (const event of dedupedEvents) {
    const isRouteTimeRescheduledEvent =
      Boolean(event?.routeTimeRescheduled) ||
      /falta de tiempo/i.test(String(event?.label || "")) ||
      /route_time_rescheduled/i.test(String(event?.note || ""));
    const routeTimeKey = String(event?.id || `${event?.at || ""}:${event?.label || ""}`);
    if (isRouteTimeRescheduledEvent && !shownRouteTimeKeys.has(routeTimeKey)) {
      shownRouteTimeKeys.add(routeTimeKey);
      const courierName = String(event?.courierName || "").trim();
      const transferredCourierName = String(
        event?.transferredCourierName || request?.transferredCourierName || "",
      ).trim();
      const routeTransferredAtMs = parseEventMs(request?.routeTransferredAt);
      const wasHandledAfterTransfer =
        !hideTransferDetails &&
        transferredCourierName &&
        (Boolean(event?.transferredCourierName) ||
          (routeTransferredAtMs && parseEventMs(event?.at) >= routeTransferredAtMs));
      items.push({
        id: `route-time-heading-${routeTimeKey}`,
        type: "heading",
        label: isAdminNotLocatedReprogramEvent(event)
          ? "Reprogramado por administrador"
          : `${courierName ? `Reprogramado por repartidor ${courierName}` : "Reprogramado por repartidor"}${
              wasHandledAfterTransfer ? ` · traspasado a ${transferredCourierName}` : ""
            }`,
      });
    }
    const attempt = courierAttemptFromHistoryLabel(event?.label);
    if (attempt && !shownAttemptKeys.has(attempt)) {
      shownAttemptKeys.add(attempt);
      const heading = courierAttemptHeading(attempt);
      const courierName = String(event?.courierName || "").trim();
      const transferredCourierName = String(
        transferredCourierNameByAttempt.get(attempt) ||
          event?.transferredCourierName ||
          request?.transferredCourierName ||
          "",
      ).trim();
      const routeTransferredAtMs = parseEventMs(request?.routeTransferredAt);
      const wasHandledAfterTransfer =
        !hideTransferDetails &&
        transferredCourierName &&
        (transferredCourierNameByAttempt.has(attempt) ||
          Boolean(event?.transferredCourierName) ||
          (routeTransferredAtMs && parseEventMs(event?.at) >= routeTransferredAtMs));
      items.push({
        id: `attempt-heading-${attempt}-${event.id}`,
        type: "heading",
        label: `${courierName ? `${heading} repartidor ${courierName}` : `${heading} repartidor`}${
          wasHandledAfterTransfer ? ` · traspasado a ${transferredCourierName}` : ""
        }`,
      });
    }
    items.push({ ...event, type: "event" });
  }
  return items;
}

function filterCourierSnapshotHistoryEvents(events, snapshot) {
  const cutoffMs = parseEventMs(snapshot?.finishedAt || snapshot?.createdAt);
  if (!cutoffMs) return events || [];
  return (events || []).filter((event) => {
    const eventMs = parseEventMs(event?.at || event?.createdAt);
    return !eventMs || eventMs <= cutoffMs;
  });
}

function isRouteTimeHistoryEvent(event) {
  return (
    Boolean(event?.routeTimeRescheduled) ||
    /falta de tiempo/i.test(String(event?.label || "")) ||
    /route_time_rescheduled/i.test(String(event?.note || ""))
  );
}

function courierHistoryMinuteKey(value) {
  const ms = parseEventMs(value);
  if (!ms) return String(value || "").trim().toLowerCase();
  return String(Math.floor(ms / 60000));
}

function normalizeCourierHistoryKeyText(value) {
  const normalizedDateText = String(value || "").replace(
    /\b(\d{1,2})\/([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+)\/(\d{4})\b/g,
    (_match, day, month, year) => `${Number(day)} de ${month} de ${year}`,
  );
  return normalizedDateText
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function courierFinalHistoryEventKey(event, eventTimeKey) {
  const label = String(event?.label || "").trim();
  const status = String(event?.status || "").trim().toLowerCase();
  const action = String(event?.action || "").trim().toLowerCase();
  if (
    action === "courier_branch_pickup_refunded" ||
    status === "reembolsada" ||
    /\breembolsad[ao]\b/i.test(label)
  ) {
    return [eventTimeKey, "final", "reembolsado"].map(normalizeCourierHistoryKeyText).join(":");
  }
  if (
    action === "courier_mark_delivered" ||
    status === "entregado" ||
    /\bentregad[ao]\b/i.test(label)
  ) {
    return [eventTimeKey, "final", "entregado"].map(normalizeCourierHistoryKeyText).join(":");
  }
  return "";
}

function courierRouteTimeHistoryDateKey(event) {
  const noteDate = String(event?.note || "").match(/route_time_rescheduled:(\d{4}-\d{2}-\d{2})/i)?.[1] || "";
  if (noteDate) return noteDate;
  const labelDate = String(event?.label || "").match(/para el ([^.\n]+)/i)?.[1] || "";
  return normalizeCourierHistoryKeyText(normalizeCourierRescheduledDateLabel(labelDate));
}

function courierRouteTimeAdminConflictKey(event) {
  if (!isRouteTimeHistoryEvent(event)) return "";
  const eventTimeValue = event?.at || event?.createdAt || "";
  return [
    courierHistoryMinuteKey(eventTimeValue),
    courierRouteTimeHistoryDateKey(event),
  ].map(normalizeCourierHistoryKeyText).join(":");
}

function normalizeAdminRouteTimeHistoryEvent(event) {
  if (!isRouteTimeHistoryEvent(event) || !isAdminNotLocatedReprogramEvent(event)) return event;
  const noteDate = String(event?.note || "").match(/route_time_rescheduled:(\d{4}-\d{2}-\d{2})/i)?.[1] || "";
  const labelDate = String(event?.label || "").match(/para el ([^.\n]+)/i)?.[1] || "";
  const dateLabel = noteDate
    ? formatCourierRescheduledDate(new Date(`${noteDate}T12:00:00Z`))
    : normalizeCourierRescheduledDateLabel(labelDate);
  return {
    ...event,
    label: routeTimeReprogramLabel(dateLabel, { adminNotLocatedReprogram: true }),
    routeTimeRescheduled: true,
    adminNotLocatedReprogram: true,
  };
}

function mergeCourierHistoryEvents(...eventLists) {
  const seen = new Set();
  const routeTimeAdminKeys = new Set();
  const routeTimeNormalIndexByKey = new Map();
  const merged = [];
  for (const events of eventLists) {
    for (const event of events || []) {
      const normalizedEvent = normalizeAdminRouteTimeHistoryEvent(event);
      const eventTimeValue = normalizedEvent?.at || normalizedEvent?.createdAt || "";
      const eventTimeKey = isRouteTimeHistoryEvent(normalizedEvent)
        ? courierHistoryMinuteKey(eventTimeValue)
        : courierHistoryMinuteKey(eventTimeValue) || parseEventMs(eventTimeValue) || String(eventTimeValue).trim().toLowerCase();
      const finalEventKey = courierFinalHistoryEventKey(normalizedEvent, eventTimeKey);
      const contentKeyParts = isRouteTimeHistoryEvent(normalizedEvent)
        ? [eventTimeKey, normalizedEvent?.label || ""]
        : [
            eventTimeKey,
            normalizedEvent?.label || "",
            normalizedEvent?.note || "",
            normalizedEvent?.status || "",
          ];
      const contentKey = contentKeyParts.map(normalizeCourierHistoryKeyText).join(":");
      const key = finalEventKey || contentKey || String(normalizedEvent?.id || "");
      if (seen.has(key)) continue;
      const routeTimeConflictKey = courierRouteTimeAdminConflictKey(normalizedEvent);
      if (routeTimeConflictKey && isAdminNotLocatedReprogramEvent(normalizedEvent)) {
        routeTimeAdminKeys.add(routeTimeConflictKey);
        const normalIndex = routeTimeNormalIndexByKey.get(routeTimeConflictKey);
        if (normalIndex !== undefined) {
          const removedEvent = merged[normalIndex];
          const removedKey = isRouteTimeHistoryEvent(removedEvent)
            ? [
                courierHistoryMinuteKey(removedEvent?.at || removedEvent?.createdAt || ""),
                removedEvent?.label || "",
              ].map(normalizeCourierHistoryKeyText).join(":")
            : "";
          if (removedKey) seen.delete(removedKey);
          merged.splice(normalIndex, 1);
          routeTimeNormalIndexByKey.delete(routeTimeConflictKey);
          for (const [storedKey, storedIndex] of routeTimeNormalIndexByKey.entries()) {
            if (storedIndex > normalIndex) routeTimeNormalIndexByKey.set(storedKey, storedIndex - 1);
          }
        }
      } else if (routeTimeConflictKey && routeTimeAdminKeys.has(routeTimeConflictKey)) {
        continue;
      }
      seen.add(key);
      if (routeTimeConflictKey && !isAdminNotLocatedReprogramEvent(normalizedEvent)) {
        routeTimeNormalIndexByKey.set(routeTimeConflictKey, merged.length);
      }
      merged.push(normalizedEvent);
    }
  }
  return merged.sort((firstEvent, secondEvent) =>
    parseEventMs(firstEvent?.at || firstEvent?.createdAt) - parseEventMs(secondEvent?.at || secondEvent?.createdAt),
  );
}

function dedupeCourierHistoryEvents(events = []) {
  return mergeCourierHistoryEvents(events);
}

function courierSnapshotRouteTimeFallbackEvents(order, snapshot) {
  const events = Array.isArray(order?.historyEvents) ? order.historyEvents : [];
  if (events.some((event) => isRouteTimeHistoryEvent(event))) return events;
  const status = String(order?.status || order?.currentStatus || "").trim().toLowerCase();
  if (status !== "reintento_pendiente") return events;
  const scheduledDate = String(order?.pickupDate || "").trim();
  const scheduledDateValue = scheduledDate ? new Date(`${scheduledDate}T12:00:00Z`) : null;
  const scheduledDateLabel = scheduledDateValue && Number.isFinite(scheduledDateValue.getTime())
    ? formatCourierRescheduledDate(scheduledDateValue)
    : "";
  const eventAt = snapshot?.finishedAt || snapshot?.createdAt || order?.updatedAt || order?.createdAt || "";
  if (!eventAt) return events;
  return [{
    id: `snapshot-route-time-${snapshot?.routeId || "route"}-${order?.id || order?.orderNumber || "order"}`,
    label: routeTimeReprogramLabel(scheduledDateLabel, order),
    at: eventAt,
    atMs: parseEventMs(eventAt),
    courierName: String(order?.courierName || snapshot?.courierName || "").trim(),
    note: scheduledDate ? `route_time_rescheduled:${scheduledDate}` : "route_time_rescheduled",
    routeTimeRescheduled: true,
    adminNotLocatedReprogram: Boolean(order?.adminNotLocatedReprogram),
  }];
}

function courierStatusFromActivityAction(action, fallbackStatus = "") {
  const normalizedAction = String(action || "").trim().toLowerCase();
  const statusByAction = {
    courier_mark_delivered: "entregado",
    courier_mark_not_delivered: "no_entregado",
    courier_route_order_not_located: "no_localizado",
    courier_return_mark_received: "recibida",
    courier_return_pickup_attempt_failed: "no_recibido",
    courier_return_reject_after_failed_pickups: "rechazada",
    courier_branch_pickup_refunded: "reembolsada",
    [COURIER_ADMIN_REPROGRAM_ACTION]: "reintento_pendiente",
    courier_route_delivery_reprogrammed: "reintento_pendiente",
  };
  return statusByAction[normalizedAction] || fallbackStatus;
}

function courierHistoryStatusLabel(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "no_localizado") return "no localizado";
  if (normalized === "no_entregado") return "no entregado";
  if (normalized === "no_recibido") return "no recibido";
  if (normalized === "reintento_pendiente") return "reprogramado";
  return getCourierStatusLabel(status);
}

function hasCourierReprogrammedHistoryEvent(historyEvents = []) {
  return (historyEvents || []).some((event) =>
    /\bintento reprogramado\b/i.test(String(event?.label || "")),
  );
}

function latestCourierReprogrammingEvent(historyEvents = []) {
  return [...(historyEvents || [])]
    .filter((event) => {
      const label = String(event?.label || "").trim();
      const note = String(event?.note || "").trim();
      return (
        Boolean(event?.routeTimeRescheduled) ||
        /\breprogramad[ao]\b/i.test(label) ||
        /route_time_rescheduled|scheduled_date/i.test(note)
      );
    })
    .sort((firstEvent, secondEvent) => parseEventMs(secondEvent?.at) - parseEventMs(firstEvent?.at))[0] || null;
}

function isAttemptReprogrammingEvent(event) {
  const label = String(event?.label || "").trim();
  const normalizedLabel = label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const note = String(event?.note || "").trim();
  return (
    /\bintento reprogramado\b/i.test(normalizedLabel) &&
    !event?.routeTimeRescheduled &&
    !/falta de tiempo/i.test(normalizedLabel) &&
    !/route_time_rescheduled/i.test(note)
  );
}

function latestCourierResultEventFromHistoryEvents(historyEvents = []) {
  const events = [...(historyEvents || [])].reverse();
  for (const event of events) {
    const label = String(event?.label || "").trim().toLowerCase();
    if (/\bno (?:recibido|entregado)\b/.test(label)) return { status: "no_recibido", event };
    if (/\bentregado\b/.test(label)) return { status: "entregado", event };
    if (/\brecibido\b/.test(label)) return { status: "recibida", event };
    if (/\brechazad[ao]\b/.test(label)) return { status: "rechazada", event };
  }
  return null;
}

function courierResultStatusFromHistoryEvents(historyEvents = []) {
  const resultEvent = latestCourierResultEventFromHistoryEvents(historyEvents);
  if (resultEvent) return resultEvent.status;
  return "";
}

function courierHistoryPendingStatusOverride(order) {
  const normalizedStatus = String(order?.status || "").trim().toLowerCase();
  const normalizedCurrentStatus = String(order?.currentStatus || "").trim().toLowerCase();
  const historyResultEvent = latestCourierResultEventFromHistoryEvents(order?.historyEvents);
  const historyResultStatus = historyResultEvent?.status || "";
  const routeTimeReprogrammedEvent = latestCourierReprogrammingEvent(order?.historyEvents);
  const isRouteTimeReprogrammed =
    Boolean(routeTimeReprogrammedEvent?.routeTimeRescheduled) ||
    /falta de tiempo/i.test(String(routeTimeReprogrammedEvent?.label || "")) ||
    /route_time_rescheduled/i.test(String(routeTimeReprogrammedEvent?.note || ""));
  const routeTimeReprogrammedMs = parseEventMs(routeTimeReprogrammedEvent?.at || routeTimeReprogrammedEvent?.createdAt);
  const historyResultMs = parseEventMs(historyResultEvent?.event?.at || historyResultEvent?.event?.createdAt);
  if (
    isRouteTimeReprogrammed &&
    (!historyResultStatus || routeTimeReprogrammedMs >= historyResultMs)
  ) {
    return "reintento_pendiente";
  }
  if (
    ["entregado", "recibida", "rechazada"].includes(historyResultStatus) ||
    (isReturnCourierLabel(order?.courierLabel) && historyResultStatus === "no_recibido")
  ) {
    return historyResultStatus;
  }
  if (
    ["no_entregado", "no_recibido"].includes(normalizedStatus) &&
    (
      normalizedCurrentStatus === "reintento_pendiente" ||
      hasCourierReprogrammedHistoryEvent(order?.historyEvents)
    )
  ) {
    return "pendiente";
  }
  if (historyResultStatus) return historyResultStatus;
  return "";
}

function isCourierFinalActivityAction(action) {
  return [
    "courier_mark_delivered",
    "courier_mark_not_delivered",
    "courier_route_order_not_located",
    "courier_return_mark_received",
    "courier_return_pickup_attempt_failed",
    "courier_return_reject_after_failed_pickups",
    "courier_branch_pickup_refunded",
    COURIER_ADMIN_REPROGRAM_ACTION,
  ].includes(String(action || "").trim().toLowerCase());
}

function buildCourierHistoryEvents(request) {
  if (isReturnCourierLabel(request.courierLabel)) {
    const entries = parseReasonEntries(request.rejectionReason);
    const finalAttempt = Math.max(
      1,
      entries.reduce((maxAttempt, entry) => {
        const kind = String(entry?.kind || "").trim().toLowerCase();
        const match = kind.match(/^(?:courier_en_route_|courier_retry_|attempt_failed_)(\d)$/);
        return match ? Math.max(maxAttempt, Number(match[1]) || 0) : maxAttempt;
      }, 0),
    );
    return dedupeReturnCourierHistoryEvents(entries
      .map((entry, index) => ({
        id: `${entry.kind}-${entry.at}-${index}`,
        label: returnCourierHistoryLabel(entry, finalAttempt),
        at: entry.at,
        atMs: parseEventMs(entry.at),
        note: entry.reason || "",
        routeTimeRescheduled: String(entry?.kind || "").trim().toLowerCase() === "courier_route_time_reprogrammed",
      }))
      .filter((entry) => entry.label && entry.atMs))
      .sort((a, b) => a.atMs - b.atMs);
  }

  if (request.persistedHistoryEvents?.length) {
    return request.persistedHistoryEvents.map((event) => ({
      id: `delivery-event-${event.id}`,
      label: courierHistoryEventLabel(event),
      at: event.createdAt,
      atMs: parseEventMs(event.createdAt),
      note: event.note || "",
      status: String(event.status || "").trim().toLowerCase(),
      attempt: event.attempt,
    }));
  }

  const status = String(request.status || "").trim().toLowerCase();
  if (status === "pendiente") return [];
  return [{
    id: `delivery-${status}`,
    label: courierEventLabel(status, request.attemptCount),
    at: request.courierHistoryAt || request.updatedAt,
    atMs: parseEventMs(request.courierHistoryAt || request.updatedAt),
  }].filter((entry) => entry.atMs);
}

function formatCourierHistoryDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("es-MX", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function nextMexicoCalendarDay(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return new Date(Date.UTC(
    Number(lookup.year),
    Number(lookup.month) - 1,
    Number(lookup.day) + 1,
    12,
  ));
}

function formatCourierRescheduledDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(value);
}

function normalizeCourierRescheduledDateLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return formatCourierRescheduledDate(new Date(`${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}T12:00:00Z`));
  }
  const slashMatch = raw.match(/^(\d{1,2})\/([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+)\/(\d{4})$/);
  if (!slashMatch) return raw;
  const monthNames = {
    enero: 0,
    febrero: 1,
    marzo: 2,
    abril: 3,
    mayo: 4,
    junio: 5,
    julio: 6,
    agosto: 7,
    septiembre: 8,
    setiembre: 8,
    octubre: 9,
    noviembre: 10,
    diciembre: 11,
  };
  const monthKey = slashMatch[2].normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const monthIndex = monthNames[monthKey];
  if (monthIndex === undefined) return raw;
  return formatCourierRescheduledDate(new Date(Date.UTC(Number(slashMatch[3]), monthIndex, Number(slashMatch[1]), 12)));
}

function buildAdminCourierPresentation(request) {
  const events = request.historyEvents || [];
  const routeTimeActivities = (request.courierActivities || []).filter((activity) =>
    COURIER_ROUTE_REPROGRAM_ACTIONS.has(String(activity?.action || "").trim().toLowerCase()),
  );
  const latestRouteTimeActivity = routeTimeActivities[routeTimeActivities.length - 1] || null;
  const displayEvents = [];
  let scheduledDate = null;
  let hasRouteTimeEvent = false;

  for (const event of events) {
    const routeTimeIsoDate = String(event.note || "").match(/route_time_rescheduled:(\d{4}-\d{2}-\d{2})/i)?.[1] || "";
    const isRouteTimeEvent =
      Boolean(event?.routeTimeRescheduled) ||
      Boolean(routeTimeIsoDate) ||
      /reprogramad[ao] por falta de tiempo/i.test(String(event.label || ""));
    if (isRouteTimeEvent) {
      hasRouteTimeEvent = true;
      const adminNotLocatedReprogram = isAdminNotLocatedReprogramEvent(event);
      const requestScheduledDate = request.courierLabel === "Entrega" && request.pickupDate
        ? new Date(`${request.pickupDate}T12:00:00Z`)
        : null;
      const noteDate = routeTimeIsoDate ? new Date(`${routeTimeIsoDate}T12:00:00Z`) : null;
      const reprogrammedFor =
        noteDate &&
        requestScheduledDate &&
        Number.isFinite(requestScheduledDate.getTime()) &&
        requestScheduledDate.getTime() > noteDate.getTime()
          ? requestScheduledDate
          : noteDate;
      const labelDateMatch = String(event.label || "").match(/para el ([^.\n]+)$/i);
      const reprogrammedDateLabel = reprogrammedFor
        ? formatCourierRescheduledDate(reprogrammedFor)
        : normalizeCourierRescheduledDateLabel(labelDateMatch?.[1] || "");
      if (reprogrammedFor) scheduledDate = reprogrammedFor;
      displayEvents.push({
        ...event,
        label: routeTimeReprogramLabel(reprogrammedDateLabel, event),
        routeTimeRescheduled: true,
        adminNotLocatedReprogram,
      });
      continue;
    }

    displayEvents.push(event);
    if (!/\bno (?:entregado|recibido)\b/i.test(String(event.label || ""))) continue;

    const attemptMatch = String(event.label || "").match(/^(Primer|Segundo|Tercer) intento/i);
    if (!attemptMatch) continue;
    if (attemptMatch[1].toLowerCase() === "tercer") continue;
    const persistedIsoDate = String(event.note || "").match(/scheduled_date:(\d{4}-\d{2}-\d{2})/i)?.[1] || "";
    const persistedDateMatch = String(event.note || "").match(/Reprogramado para el ([^.\n]+)/i);
    const persistedDateLabel = persistedIsoDate
      ? formatCourierRescheduledDate(new Date(`${persistedIsoDate}T12:00:00Z`))
      : String(persistedDateMatch?.[1] || "").trim();
    const reprogrammedFor = persistedIsoDate
      ? new Date(`${persistedIsoDate}T12:00:00Z`)
      : persistedDateLabel
        ? null
        : nextMexicoCalendarDay(event.at);
    const reprogrammedDateLabel =
      persistedDateLabel || (reprogrammedFor ? formatCourierRescheduledDate(reprogrammedFor) : "");
    if (!reprogrammedDateLabel) continue;

    scheduledDate = reprogrammedFor || scheduledDate;
    displayEvents.push({
      id: `${event.id}-reprogrammed`,
      label: `${attemptMatch[1]} intento reprogramado para el ${reprogrammedDateLabel}`,
      at: event.at,
      atMs: parseEventMs(event.at),
    });
  }

  if (!hasRouteTimeEvent && latestRouteTimeActivity) {
    const adminNotLocatedReprogram = isAdminNotLocatedReprogramActivity(latestRouteTimeActivity);
    const fallbackDate = request.pickupDate ? new Date(`${request.pickupDate}T12:00:00Z`) : null;
    const fallbackDateLabel = fallbackDate && Number.isFinite(fallbackDate.getTime())
      ? formatCourierRescheduledDate(fallbackDate)
      : "";
    if (fallbackDateLabel && fallbackDate) scheduledDate = fallbackDate;
    displayEvents.push({
      id: `route-time-activity-${latestRouteTimeActivity.id || latestRouteTimeActivity.createdAt}`,
      label: routeTimeReprogramLabel(fallbackDateLabel, { adminNotLocatedReprogram }),
      at: latestRouteTimeActivity.createdAt,
      atMs: parseEventMs(latestRouteTimeActivity.createdAt),
      courierName: String(latestRouteTimeActivity.courierName || "").trim(),
      routeTimeRescheduled: true,
      adminNotLocatedReprogram,
    });
  }

  return { events: displayEvents, scheduledDate };
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
        currentTotalPriceSet {
          shopMoney { amount currencyCode }
        }
        currentSubtotalPriceSet {
          shopMoney { amount currencyCode }
        }
        lineItems(first: 100) {
          edges {
            node {
              id
              title
              quantity
              variant {
                id
                title
                selectedOptions {
                  name
                  value
                }
              }
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
    currentTotalPrice: Number(order.currentTotalPriceSet?.shopMoney?.amount || 0),
    currentSubtotalPrice: Number(order.currentSubtotalPriceSet?.shopMoney?.amount || 0),
    currencyCode: String(order.currentTotalPriceSet?.shopMoney?.currencyCode || "MXN"),
    lineItems: (order.lineItems?.edges || []).map(({ node }) => ({
      id: node.id,
      title: node.title,
      quantity: Number(node.quantity || 0),
      variantId: node.variant?.id || "",
      productId: node.product?.id || "",
      variantSummary: formatVariantSummary(node.variant),
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

function putImageCandidate(map, key, imageUrl, imageAlt, variantSummary = "") {
  if (!key) return;
  const current = map[key] || {};
  map[key] = {
    imageUrl: current.imageUrl || imageUrl || "",
    imageAlt: current.imageAlt || imageAlt || "",
    variantSummary: current.variantSummary || variantSummary || "",
  };
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
                    title
                    selectedOptions { name value }
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
        const variantSummary = formatVariantSummary(line?.variant);

        putImageCandidate(imageMap, itemKeyFromRecord({ lineItemId: line.id }), imageUrl, imageAlt, variantSummary);
        putImageCandidate(imageMap, itemKeyFromRecord({ variantId: line?.variant?.id }), imageUrl, imageAlt, variantSummary);
        putImageCandidate(imageMap, itemKeyFromRecord({ productId: line?.product?.id }), imageUrl, imageAlt, variantSummary);
        putImageCandidate(imageMap, itemKeyFromRecord({ title: line.title }), imageUrl, imageAlt, variantSummary);
      }
      byOrder[order.id] = imageMap;
    }

    return byOrder;
  } catch {
    return {};
  }
}

function timelineToneClassName(tone) {
  if (tone === "review") return styles.timelineToneReview;
  if (tone === "approved") return styles.timelineToneApproved;
  if (tone === "attempt") return styles.timelineToneAttempt;
  if (tone === "rejected") return styles.timelineToneRejected;
  if (tone === "received") return styles.timelineToneReceived;
  if (tone === "pending") return styles.timelineTonePending;
  if (tone === "returnedToCustomer") return styles.timelineToneReturnedToCustomer;
  if (tone === "reprogrammed") return styles.timelineToneReprogrammed;
  if (tone === "denied") return styles.timelineToneDenied;
  if (tone === "refunded") return styles.timelineToneRefunded;
  return "";
}

function buildViewWhere(shop, viewMode) {
  if (viewMode === VIEW_MODE.PICKUP) {
    return {
      shop,
      returnMethod: "pickup",
      status: { in: Array.from(METHOD_QUEUE_STATUSES) },
    };
  }

  if (viewMode === VIEW_MODE.BRANCH) {
    return {
      shop,
      returnMethod: { not: "pickup" },
      status: { in: Array.from(METHOD_QUEUE_STATUSES) },
    };
  }

  if (viewMode === VIEW_MODE.REVIEW) {
    return {
      shop,
      status: "en_revision",
    };
  }

  if (viewMode === VIEW_MODE.REFUNDS) {
    return {
      shop,
      status: { in: Array.from(REFUND_QUEUE_STATUSES) },
    };
  }

  if (viewMode === VIEW_MODE.TO_RETURN) {
    return {
      shop,
      status: { in: Array.from(RETURN_TO_CUSTOMER_STATUSES) },
    };
  }

  if (viewMode === VIEW_MODE.HISTORY) {
    return {
      shop,
      status: { in: Array.from(HISTORY_STATUSES) },
    };
  }

  return { shop };
}

function shouldIncludeEvidencePhotos(viewMode) {
  return (
    viewMode === VIEW_MODE.REVIEW ||
    viewMode === VIEW_MODE.REFUNDS ||
    viewMode === VIEW_MODE.TO_RETURN
  );
}

function shouldLoadOrderCatalogImages(viewMode) {
  return (
    viewMode === VIEW_MODE.REVIEW ||
    viewMode === VIEW_MODE.REFUNDS ||
    viewMode === VIEW_MODE.TO_RETURN
  );
}

function mapRequestItemsToRefundLineItems(requestItems, orderLineItems) {
  const requestedQtyByLineId = new Map();

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
          (candidate) => String(candidate.title || "").trim().toLowerCase() === title,
        ) || null;
    }

    if (!line) {
      throw new Error(`No se pudo mapear el producto "${item.title}" a una linea de la orden.`);
    }

    const itemQuantity = Math.max(1, Number(item.quantity || 1));
    const prevRequested = Number(requestedQtyByLineId.get(line.id) || 0);
    const nextRequested = prevRequested + itemQuantity;
    const maxLineQuantity = Math.max(1, Number(line.quantity || 1));
    if (nextRequested > maxLineQuantity) {
      throw new Error(`La cantidad a devolver para "${item.title}" excede la cantidad comprada.`);
    }
    requestedQtyByLineId.set(line.id, nextRequested);
  }

  const refundableLines = [];
  let subtotal = 0;
  for (const [lineId, quantity] of requestedQtyByLineId.entries()) {
    const line = byLine.get(lineId);
    if (!line) continue;
    subtotal += Number(line.unitPrice || 0) * Number(quantity || 0);
    refundableLines.push({
      lineItemId: lineId,
      quantity: Number(quantity || 0),
      restockType: "NO_RESTOCK",
    });
  }

  return { refundLineItems: refundableLines, subtotal };
}

function parseSelectedLineItemUnitCounts(selectedLineItemUnitKeys = []) {
  const counts = new Map();
  for (const rawKey of selectedLineItemUnitKeys || []) {
    const key = String(rawKey || "").trim();
    if (!key) continue;
    const [lineItemId] = key.split("::");
    const cleanLineItemId = String(lineItemId || "").trim();
    if (!cleanLineItemId) continue;
    counts.set(cleanLineItemId, Number(counts.get(cleanLineItemId) || 0) + 1);
  }
  return counts;
}

function mapOrderItemsToFullRefundLineItems(orderLineItems, selectedLineItemUnitKeys = []) {
  const selectedUnitCountsByLineId = parseSelectedLineItemUnitCounts(selectedLineItemUnitKeys);
  const selectedUnitKeysByLineId = new Map();
  for (const unitKey of selectedLineItemUnitKeys || []) {
    const cleanUnitKey = String(unitKey || "").trim();
    const [lineItemId] = cleanUnitKey.split("::");
    const cleanLineItemId = String(lineItemId || "").trim();
    if (!cleanLineItemId || !cleanUnitKey) continue;
    const current = selectedUnitKeysByLineId.get(cleanLineItemId) || [];
    current.push(cleanUnitKey);
    selectedUnitKeysByLineId.set(cleanLineItemId, current);
  }
  const refundLineItems = [];
  const refundedItems = [];
  let subtotal = 0;
  let totalRefundableQuantity = 0;
  let selectedRefundQuantity = 0;
  for (const line of orderLineItems || []) {
    const quantity = Math.max(0, Number(line.quantity || 0));
    if (!line?.id || quantity <= 0) continue;
    totalRefundableQuantity += quantity;
    const selectedQuantity = Math.min(quantity, Math.max(0, Number(selectedUnitCountsByLineId.get(String(line.id)) || 0)));
    if (selectedQuantity <= 0) continue;
    selectedRefundQuantity += selectedQuantity;
    subtotal += Number(line.unitPrice || 0) * selectedQuantity;
    refundLineItems.push({
      lineItemId: line.id,
      quantity: selectedQuantity,
      restockType: "NO_RESTOCK",
    });
    refundedItems.push({
      lineItemId: line.id,
      title: line.title || "Producto",
      variantSummary: String(line.variantSummary || "").trim(),
      quantity: selectedQuantity,
      unitPrice: Number(line.unitPrice || 0),
      total: Number(line.unitPrice || 0) * selectedQuantity,
      unitKeys: (selectedUnitKeysByLineId.get(String(line.id)) || []).slice(0, selectedQuantity),
    });
  }
  const selectedAllLineItems = selectedRefundQuantity > 0 && selectedRefundQuantity === totalRefundableQuantity;
  return { refundLineItems, refundedItems, subtotal, selectedAllLineItems };
}

async function replaceShopifyOrderCourierStatusTag(admin, shopifyOrderId, statusTag) {
  const cleanStatusTag = String(statusTag || "").trim();
  if (!shopifyOrderId || !cleanStatusTag) return;
  const response = await admin.graphql(
    `#graphql
    mutation ReplaceCourierStatusTags($id: ID!, $addTags: [String!]!, $removeTags: [String!]!) {
      tagsAdd(id: $id, tags: $addTags) { userErrors { field message } }
      tagsRemove(id: $id, tags: $removeTags) { userErrors { field message } }
    }`,
    {
      variables: {
        id: shopifyOrderId,
        addTags: [cleanStatusTag],
        removeTags: COURIER_STATUS_TAGS_FOR_ADMIN.filter((tag) => tag !== cleanStatusTag),
      },
    },
  );
  const payload = await response.json();
  const topErrors = payload?.errors || [];
  const userErrors = [
    ...(payload?.data?.tagsAdd?.userErrors || []),
    ...(payload?.data?.tagsRemove?.userErrors || []),
  ];
  if (topErrors.length || userErrors.length) {
    throw new Error(topErrors[0]?.message || userErrors[0]?.message || "No se pudo actualizar el estado de la orden.");
  }
}

async function refundShopifyOrderToOriginalPayment({
  admin,
  shopifyOrderId,
  notePrefix,
  includeShipping = false,
  selectedLineItemUnitKeys = [],
}) {
  const snapshot = await fetchOrderSnapshot(admin, shopifyOrderId);
  const { refundLineItems, refundedItems, subtotal, selectedAllLineItems } = mapOrderItemsToFullRefundLineItems(
    snapshot.lineItems,
    selectedLineItemUnitKeys,
  );
  if (!refundLineItems.length) {
    throw new Error("No hay lineas para reembolsar.");
  }
  const shouldRefundShipping = includeShipping && selectedAllLineItems;
  const finalRefund = shouldRefundShipping
    ? Number(snapshot.currentTotalPrice || snapshot.currentSubtotalPrice || subtotal || 0)
    : Number(subtotal || 0);
  if (finalRefund <= 0) {
    throw new Error("No se encontro un monto valido para reembolsar.");
  }
  const parentTransaction = pickParentTransaction(snapshot.transactions);
  if (!parentTransaction?.id || !parentTransaction?.gateway) {
    throw new Error("No se encontro una transaccion de pago valida para reembolsar al metodo original.");
  }
  const response = await admin.graphql(
    `#graphql
    mutation RefundBranchPickupOrder($input: RefundInput!) {
      refundCreate(input: $input) {
        refund { id }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        input: {
          orderId: shopifyOrderId,
          note: notePrefix || "Reembolso por pedido no recogido en sucursal",
          notify: false,
          refundLineItems,
          ...(shouldRefundShipping ? { shipping: { fullRefund: true } } : {}),
          transactions: [
            {
              orderId: shopifyOrderId,
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
    throw new Error(topErrors[0]?.message || userErrors[0]?.message || "No se pudo procesar el reembolso.");
  }
  return {
    refundId: String(payload?.data?.refundCreate?.refund?.id || ""),
    finalRefund,
    refundedSubtotal: finalRefund,
    currencyCode: snapshot.currencyCode || "MXN",
    selectedAllLineItems,
    refundedItems,
  };
}

async function fetchBranchPickupOrderForDeadline(admin, shopifyOrderId) {
  const response = await admin.graphql(
    `#graphql
    query BranchPickupOrderForDeadline($id: ID!) {
      order(id: $id) {
        id
        name
        createdAt
        updatedAt
        displayFulfillmentStatus
        tags
        customAttributes {
          key
          value
        }
        shippingLines(first: 5) {
          nodes {
            title
            code
            deliveryCategory
          }
        }
      }
    }`,
    { variables: { id: shopifyOrderId } },
  );
  const payload = await response.json();
  const errors = payload?.errors || [];
  if (errors.length) throw new Error(errors[0]?.message || "No se pudo consultar la orden en Shopify.");
  return payload?.data?.order || null;
}

async function markBranchDeliveryNeverArrived({ shopDomain, requestRow, force = false }) {
  if (!requestRow?.id) return { ok: false, skipped: true, reason: "missing_request" };
  if (String(requestRow.returnMethod || "").toLowerCase() === "pickup") {
    return { ok: false, skipped: true, reason: "not_branch_delivery" };
  }
  if (String(requestRow.status || "").toLowerCase() !== "aprobada") {
    return { ok: false, skipped: true, reason: "not_approved" };
  }
  if (!force && !isBranchDeliveryExpired(requestRow.limitDate)) {
    return { ok: false, skipped: true, reason: "not_expired" };
  }

  const updatedRequest = await prisma.returnRequest.update({
    where: { id: requestRow.id },
    data: {
      status: "no_devuelto",
      rejectionReason: appendReasonEntry(requestRow.rejectionReason, {
        kind: "never_arrived_branch",
        reason: NEVER_ARRIVED_BRANCH_REASON,
      }),
    },
  });
  await emitReturnNotificationEvent({
    shopDomain,
    requestRow: updatedRequest,
    intent: "mark_never_arrived",
    note: NEVER_ARRIVED_BRANCH_REASON,
  });
  return { ok: true, requestId: requestRow.id };
}

async function expireBranchDeliveryRequestsForShop(shopDomain, { force = false } = {}) {
  const where = {
    shop: shopDomain,
    returnMethod: { not: "pickup" },
    status: "aprobada",
    ...(force ? {} : { limitDate: { not: null } }),
  };
  const candidates = await prisma.returnRequest.findMany({
    where,
    include: { items: true },
    orderBy: [{ limitDate: "asc" }, { id: "asc" }],
  });
  let expiredCount = 0;
  for (const requestRow of candidates) {
    if (!force && !isBranchDeliveryExpired(requestRow.limitDate)) continue;
    const result = await markBranchDeliveryNeverArrived({ shopDomain, requestRow, force });
    if (result.ok) expiredCount += 1;
  }
  return expiredCount;
}

async function refundExpiredBranchPickupOrder({
  admin,
  shopDomain,
  requestId,
  orderNumber = "",
  displayedDeadline = "",
  orderSnapshot = null,
  force = false,
}) {
  const cleanRequestId = String(requestId || "").trim();
  const cleanOrderNumber = String(orderNumber || "").trim();
  const cleanDisplayedDeadline = String(displayedDeadline || "").trim();
  if (!cleanRequestId) return { ok: false, error: "Accion no valida." };

  const branchOrder = await fetchBranchPickupOrderForDeadline(admin, cleanRequestId);
  if (!branchOrder || !isCourierLocalDeliveryOrder(branchOrder)) {
    return { ok: false, error: "No se encontro la orden para recoger en sucursal.", requestId: cleanRequestId };
  }
  const branchOrderStatus = getCourierRouteStatusFromTags(branchOrder.tags);
  if (branchOrderStatus !== "recoger_en_sucursal") {
    return { ok: false, error: "Esta orden ya no esta pendiente por recoger en sucursal.", requestId: cleanRequestId };
  }
  const deadlineSourceOrder = orderSnapshot || branchOrder;
  const displayedScheduledDate = orderSnapshot?.pickupDate || getInitialCourierScheduledDate(branchOrder);
  if (!force && !isBranchPickupDeadlineExpired(deadlineSourceOrder, displayedScheduledDate)) {
    return { ok: false, error: "Aun no vence la fecha limite para reembolsar esta orden.", requestId: cleanRequestId };
  }

  const resolvedOrderNumber = cleanOrderNumber || String(branchOrder?.name || "").replace("#", "").trim();
  const refundResult = await refundShopifyOrderToOriginalPayment({
    admin,
    shopifyOrderId: cleanRequestId,
    notePrefix: `Reembolso pedido #${resolvedOrderNumber || cleanRequestId.replace(/^gid:\/\/shopify\/Order\//, "")} no recogido en sucursal`,
  });
  await replaceShopifyOrderCourierStatusTag(admin, cleanRequestId, "reembolsada");
  await prisma.deliveryCodeAssignment.updateMany({
    where: {
      shop: shopDomain,
      shopifyOrderId: cleanRequestId,
      active: true,
    },
    data: {
      code: null,
      active: false,
      releasedAt: new Date(),
    },
  });
  await emitBranchPickupRefundNotification({
    shopDomain,
    requestId: cleanRequestId,
    orderNumber: resolvedOrderNumber,
    refundAmount: refundResult.refundedSubtotal,
    currencyCode: refundResult.currencyCode,
  });
  if (cleanDisplayedDeadline) {
    try {
      const branchPickupEvent = await prisma.courierEvent.findFirst({
        where: {
          shop: shopDomain,
          requestId: cleanRequestId,
          status: "recoger_en_sucursal",
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true, note: true },
      });
      if (branchPickupEvent) {
        const existingNote = String(branchPickupEvent.note || "").trim();
        const deadlineNote = `branch_pickup_deadline_label:${cleanDisplayedDeadline}`;
        await prisma.courierEvent.update({
          where: { id: branchPickupEvent.id },
          data: {
            note: existingNote
              ? `${existingNote.replace(/;?branch_pickup_deadline_label:[^;\n]+/i, "")};${deadlineNote}`
              : deadlineNote,
          },
        });
      }
    } catch (error) {
      console.error("Branch pickup deadline event note could not be saved", error);
    }
  }

  const latestCourierActivity = await prisma.courierActivity.findFirst({
    where: {
      shop: shopDomain,
      requestId: cleanRequestId,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      courierId: true,
      courierName: true,
      routeId: true,
    },
  });
  await prisma.courierActivity.create({
    data: {
      shop: shopDomain,
      courierId: Number(latestCourierActivity?.courierId || 0),
      courierName: String(latestCourierActivity?.courierName || "Administrador").trim(),
      requestId: cleanRequestId,
      orderNumber: resolvedOrderNumber || null,
      action: "courier_branch_pickup_refunded",
      routeId: String(latestCourierActivity?.routeId || "") || null,
    },
  });

  return {
    ok: true,
    message: `Pedido #${resolvedOrderNumber || cleanRequestId.replace(/^gid:\/\/shopify\/Order\//, "")} reembolsado por ${toMoney(refundResult.finalRefund)} ${refundResult.currencyCode || "MXN"}.`,
    refundedBranchPickupRequestId: cleanRequestId,
    deadline: cleanDisplayedDeadline,
    shopifyRefundId: refundResult.refundId,
  };
}

async function refundExpiredBranchPickupOrdersForShop(admin, shopDomain, ordersForDeadlineCheck = null) {
  const branchPickupOrders = Array.isArray(ordersForDeadlineCheck)
    ? ordersForDeadlineCheck
    : await fetchBranchPickupCourierOrders(admin);
  let refundedCount = 0;
  const refundedRequestIds = [];
  const failedRefunds = [];
  for (const order of branchPickupOrders) {
    const displayedScheduledDate = order.pickupDate;
    if (!isBranchPickupDeadlineExpired(order, displayedScheduledDate)) continue;
    const displayedDeadline = formatBranchPickupDeadlineDate(order, displayedScheduledDate);
    try {
      const result = await refundExpiredBranchPickupOrder({
        admin,
        shopDomain,
        requestId: order.id,
        orderNumber: order.orderNumber,
        displayedDeadline,
        orderSnapshot: order,
      });
      if (result.ok) {
        refundedCount += 1;
        refundedRequestIds.push(String(order.id || "").trim());
      } else {
        failedRefunds.push({
          requestId: String(order.id || "").trim(),
          orderNumber: String(order.orderNumber || "").trim(),
          error: String(result.error || "No se pudo reembolsar automaticamente."),
        });
      }
    } catch (error) {
      failedRefunds.push({
        requestId: String(order.id || "").trim(),
        orderNumber: String(order.orderNumber || "").trim(),
        error: String(error?.message || error || "No se pudo reembolsar automaticamente."),
      });
      console.error("No se pudo reembolsar automaticamente una orden vencida en sucursal", error);
    }
  }
  if (failedRefunds.length) {
    console.warn("Ordenes vencidas en sucursal no reembolsadas automaticamente", failedRefunds);
  }
  return { refundedCount, refundedRequestIds, failedRefunds };
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const requestedViewMode = normalizeViewMode(url.searchParams.get("tipo"));
  const pathViewMode = normalizeViewMode(viewModeFromPathname(url.pathname));
  const viewMode = pathViewMode || requestedViewMode;
  const requestedHistoryView = String(url.searchParams.get("historyView") || "").trim();
  const requestedHistoryDate = String(url.searchParams.get("date") || "").trim();
  const requestedHistoryRouteId = String(url.searchParams.get("routeId") || "").trim();
  const requestedHistoryCourierId = Number(url.searchParams.get("courierId") || 0);
  const shouldLoadCourierHistoryActivity = viewMode === VIEW_MODE.COURIER_HISTORY && Boolean(requestedHistoryView);
  const shouldLoadCourierHistoryOrders =
    viewMode === VIEW_MODE.COURIER_HISTORY &&
    (requestedHistoryView === "all" ||
      requestedHistoryView === "courier_day" ||
      (Boolean(requestedHistoryDate) && !requestedHistoryRouteId));
  const where = buildViewWhere(session.shop, viewMode);
  const includeEvidencePhotos = shouldIncludeEvidencePhotos(viewMode);
  const itemSelect = {
    id: true,
    lineItemId: true,
    productId: true,
    variantId: true,
    title: true,
    quantity: true,
    reason: true,
    details: true,
    ...(includeEvidencePhotos ? { photoDataUrl: true } : {}),
  };

  if (viewMode === VIEW_MODE.BRANCH) {
    await expireBranchDeliveryRequestsForShop(session.shop);
  }

  let rawRequests =
    viewMode === VIEW_MODE.COURIER ||
    viewMode === VIEW_MODE.COURIER_HISTORY ||
    viewMode === VIEW_MODE.BRANCH_PICKUP ||
    viewMode === VIEW_MODE.COURIERS ||
    viewMode === VIEW_MODE.PREPARERS
      ? []
      : await prisma.returnRequest.findMany({
          where,
          include: { items: { select: itemSelect } },
          orderBy: { createdAt: "desc" },
        });

  if (viewMode === VIEW_MODE.BRANCH && rawRequests.length > 0) {
    const orderNumbers = [
      ...new Set(rawRequests.map((requestRow) => String(requestRow.orderNumber || "").trim()).filter(Boolean)),
    ];
    const comparableRequests = await prisma.returnRequest.findMany({
      where: {
        shop: session.shop,
        orderNumber: { in: orderNumbers },
      },
      include: {
        items: {
          select: {
            lineItemId: true,
            productId: true,
            variantId: true,
            title: true,
            quantity: true,
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const latestRequestIdByItemsSignature = new Map();
    for (const requestRow of comparableRequests) {
      const signature = returnRequestItemsSignature(requestRow);
      if (!latestRequestIdByItemsSignature.has(signature)) {
        latestRequestIdByItemsSignature.set(signature, requestRow.id);
      }
    }
    rawRequests = rawRequests.filter(
      (requestRow) => latestRequestIdByItemsSignature.get(returnRequestItemsSignature(requestRow)) === requestRow.id,
    );
  }

  const courierOrdersRaw =
    viewMode === VIEW_MODE.COURIER || viewMode === VIEW_MODE.PREPARERS
      ? [
          ...(await fetchCourierOrders(admin)).map((requestRow) => ({
            ...requestRow,
            courierLabel: "Entrega",
          })),
          ...(await fetchPickupCourierOrders(session.shop)).map((requestRow) => ({
            ...requestRow,
            courierLabel: "Devolución",
          })),
        ]
      : viewMode === VIEW_MODE.BRANCH_PICKUP
        ? (await fetchBranchPickupCourierOrders(admin)).map((requestRow) => ({
            ...requestRow,
            courierLabel: "Entrega",
          }))
      : shouldLoadCourierHistoryOrders
        ? [
            ...new Map(
              [
                ...(await fetchCourierOrders(admin)).map((requestRow) => ({
                  ...requestRow,
                  courierLabel: "Entrega",
                })),
                ...(await fetchPickupCourierOrders(session.shop)).map((requestRow) => ({
                  ...requestRow,
                  courierLabel: "Devolución",
                })),
                ...(await fetchCourierHistoryOrders(admin)).map((requestRow) => ({
                  ...requestRow,
                  courierLabel: "Entrega",
                })),
                ...(await fetchBranchPickupCourierOrders(admin)).map((requestRow) => ({
                  ...requestRow,
                  courierLabel: "Entrega",
                })),
                ...(await fetchPickupCourierHistoryOrders(session.shop)).map((requestRow) => ({
                  ...requestRow,
                  courierLabel: "Devolución",
                })),
              ].map((requestRow) => [String(requestRow.id || ""), requestRow]),
            ).values(),
          ]
      : [];
  const routeSettings =
    viewMode === VIEW_MODE.COURIER
      ? await prisma.returnSettings.findUnique({
          where: { shop: session.shop },
          select: { branchAddress: true },
        })
      : null;
  const routeStartAddress = String(routeSettings?.branchAddress || "").trim();

  const deliveryRequestIds = courierOrdersRaw
    .filter((requestRow) => requestRow.courierLabel === "Entrega")
    .map((requestRow) => String(requestRow.id || "").trim())
    .filter(Boolean);
  let deliveryHistoryEvents = [];
  if (deliveryRequestIds.length) {
    try {
      deliveryHistoryEvents = await prisma.courierEvent.findMany({
        where: {
          shop: session.shop,
          requestId: { in: deliveryRequestIds },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
    } catch (error) {
      console.error("Courier event history is not available yet", error);
    }
  }
  const deliveryHistoryByRequestId = new Map();
  for (const event of deliveryHistoryEvents) {
    const current = deliveryHistoryByRequestId.get(event.requestId) || [];
    current.push(event);
    deliveryHistoryByRequestId.set(event.requestId, current);
  }
  const courierRequestIds = courierOrdersRaw
    .map((requestRow) => String(requestRow.id || "").trim())
    .filter(Boolean);
  const courierActivitiesForCards =
    courierRequestIds.length
      ? await prisma.courierActivity.findMany({
          where: {
            shop: session.shop,
            requestId: { in: courierRequestIds },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        })
      : [];
  const courierActivitiesByRequestId = new Map();
  for (const activity of courierActivitiesForCards) {
    const requestId = String(activity.requestId || "").trim();
    if (!requestId) continue;
    const current = courierActivitiesByRequestId.get(requestId) || [];
    current.push(activity);
    courierActivitiesByRequestId.set(requestId, current);
  }
  const preparerAssignmentsForCourierOrders =
    courierRequestIds.length && (viewMode === VIEW_MODE.COURIER || viewMode === VIEW_MODE.COURIER_HISTORY)
      ? await prisma.preparerAssignment.findMany({
          where: {
            shop: session.shop,
            requestId: { in: courierRequestIds },
          },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        })
      : [];
  const preparerAssignmentByRequestId = new Map();
  for (const assignment of preparerAssignmentsForCourierOrders) {
    const requestId = String(assignment.requestId || "").trim();
    if (requestId && !preparerAssignmentByRequestId.has(requestId)) {
      preparerAssignmentByRequestId.set(requestId, assignment);
    }
  }
  const courierRouteIdsForCards = [
    ...new Set(
      courierActivitiesForCards
        .map((activity) => String(activity.routeId || "").trim())
        .filter((routeId) => routeId && !routeId.startsWith(COURIER_REFUND_DETAIL_ROUTE_PREFIX)),
    ),
  ];
  const transferActivitiesForCards = courierRouteIdsForCards.length
    ? await prisma.courierActivity.findMany({
        where: {
          shop: session.shop,
          routeId: { in: courierRouteIdsForCards },
          action: { startsWith: "courier_route_transferred_from:" },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    : [];
  const transferActivityByRouteId = new Map();
  for (const activity of transferActivitiesForCards) {
    transferActivityByRouteId.set(String(activity.routeId || "").trim(), activity);
  }

  const shouldLoadImages = shouldLoadOrderCatalogImages(viewMode);
  const imagesByOrder = shouldLoadImages
    ? await fetchOrderItemImageMaps(
        admin,
        rawRequests.map((requestRow) => requestRow.shopifyOrderId),
      )
    : {};

  const requests = rawRequests.map((requestRow) => {
    const imageMap = imagesByOrder[requestRow.shopifyOrderId] || {};
    const status = String(requestRow.status || "").toLowerCase();
    const reasonEntries = parseReasonEntries(requestRow.rejectionReason);
    const visibleReasonEntries = reasonEntries.filter((entry) => !isSystemProgressEntry(entry));
    const wasReturnedToCustomer = reasonEntries.some((entry) => isReturnedToCustomerEntry(entry));
    const returnedToCustomerAt = latestReturnedToCustomerAtFromRaw(requestRow.rejectionReason);
    const requiresPickupDeadline = ["por_devolver", "no_devuelto", "reembolso_denegado", "denegada"].includes(status);
    const pendingPickupSinceAt = requiresPickupDeadline
      ? latestEntryAtFromKinds(requestRow.rejectionReason, ["denied_after_received"]) ||
        requestRow.updatedAt?.toISOString?.() ||
        ""
      : "";
    const pickupDeadlineDate = requiresPickupDeadline ? addDays(pendingPickupSinceAt, PICKUP_DEADLINE_DAYS) : null;
    const pickupDeadlineAt = pickupDeadlineDate ? pickupDeadlineDate.toISOString() : "";
    const isPickupDeadlineExpired =
      Boolean(pickupDeadlineDate) && new Date().getTime() > pickupDeadlineDate.getTime();
    const branchDeliveryDeadlineDate =
      requestRow.returnMethod !== "pickup" && requestRow.limitDate ? new Date(requestRow.limitDate) : null;
    const hasValidBranchDeliveryDeadline =
      Boolean(branchDeliveryDeadlineDate) && Number.isFinite(branchDeliveryDeadlineDate.getTime());
    const branchDeliveryDeadlineAt = hasValidBranchDeliveryDeadline
      ? branchDeliveryDeadlineDate.toISOString()
      : "";
    const isBranchDeliveryDeadlineExpired =
      hasValidBranchDeliveryDeadline && isBranchDeliveryExpired(requestRow.limitDate);
    return {
      ...requestRow,
      rejectionReason: latestReasonFromRaw(requestRow.rejectionReason),
      timelineEntries: reasonEntries,
      reasonEntries: visibleReasonEntries,
      wasReturnedToCustomer,
      returnedToCustomerAt,
      returnToCustomerSortAt: pendingPickupSinceAt || requestRow.updatedAt?.toISOString?.() || requestRow.createdAt?.toISOString?.() || "",
      pickupDeadlineAt,
      isPickupDeadlineExpired,
      branchDeliveryDeadlineAt,
      isBranchDeliveryDeadlineExpired,
      items: requestRow.items.map((item) => {
        const image = imageMap[itemKeyFromRecord(item)] || null;
        return {
          ...item,
          imageUrl: image?.imageUrl || "",
          imageAlt: image?.imageAlt || "",
          variantSummary: image?.variantSummary || "",
        };
      }),
    };
  });

  const courierOrders = courierOrdersRaw
    .map((requestRow) => {
      const attemptCount = isReturnCourierLabel(requestRow.courierLabel)
        ? Math.max(Number(requestRow.attemptCount || 0), getReturnFailedAttemptCountFromReason(requestRow.rejectionReason))
        : requestRow.attemptCount;
      const requestWithAttemptCount = { ...requestRow, attemptCount };
      const requestActivities = courierActivitiesByRequestId.get(String(requestRow.id || "").trim()) || [];
      const requestRouteId = String(
        [...requestActivities].reverse().find((activity) => {
          const routeId = String(activity.routeId || "").trim();
          return routeId && !routeId.startsWith(COURIER_REFUND_DETAIL_ROUTE_PREFIX);
        })?.routeId || "",
      ).trim();
      const transferActivity = transferActivityByRouteId.get(requestRouteId);
      const transferAtMs = transferActivity ? new Date(transferActivity.createdAt || "").getTime() : 0;
      const handledAfterTransfer =
        transferActivity &&
        requestActivities.some(
          (activity) =>
            String(activity.routeId || "").trim() === requestRouteId &&
            new Date(activity.createdAt || "").getTime() >= transferAtMs,
        );
      const historyEvents = buildCourierHistoryEvents({
        ...requestWithAttemptCount,
        persistedHistoryEvents: deliveryHistoryByRequestId.get(String(requestRow.id || "").trim()) || [],
      });
      const latestFinalActivity = [...requestActivities]
        .reverse()
        .find((activity) => isCourierFinalActivityAction(activity.action));
      const activityStatus = latestFinalActivity
        ? courierStatusFromActivityAction(latestFinalActivity.action, "")
        : "";
      const requestId = String(requestRow.id || "").trim();
      const preparerAssignment = preparerAssignmentByRequestId.get(requestId) || null;
      const preparerOrderData =
        preparerAssignment?.orderData && typeof preparerAssignment.orderData === "object"
          ? preparerAssignment.orderData
          : null;
      const preparerMissingUnitKeySet = preparerMissingUnitKeySetFromOrder(preparerOrderData || {});
      const preparerItemByKey = new Map(
        (Array.isArray(preparerOrderData?.items) ? preparerOrderData.items : [])
          .map((item) => [String(item?.lineItemId || item?.id || item?.title || "item"), item]),
      );
      const hasPreparerMissingItems =
        String(preparerAssignment?.status || "").trim().toLowerCase() === "not_located" ||
        preparerMissingUnitKeySet.size > 0;
      const preparerNotLocatedScope = hasPreparerMissingItems
        ? preparerNotLocatedScopeFromOrder(preparerOrderData || {}, requestWithAttemptCount.items || [])
        : "";
      const preparerReprogrammedNotLocated =
        hasPreparerMissingItems && Boolean(preparerOrderData?.preparerReprogrammedHandledAt);
      const itemsWithPreparerStatus = (requestWithAttemptCount.items || []).map((item) => {
        const itemKey = String(item?.lineItemId || item?.id || item?.title || "item");
        const preparerItem = preparerItemByKey.get(itemKey) || {};
        const quantity = Math.max(1, Number(item?.quantity || 1));
        const itemMissingUnitKeys = Array.from({ length: quantity }, (_value, index) =>
          courierRefundUnitKeyFromItem(item, index),
        ).filter((unitKey) => preparerMissingUnitKeySet.has(unitKey));
        return {
          ...item,
          preparerStatus: preparerItem.preparerStatus || (itemMissingUnitKeys.length ? "not_located" : ""),
          preparerMissingUnitKeys: itemMissingUnitKeys.length
            ? itemMissingUnitKeys
            : Array.isArray(preparerItem.preparerMissingUnitKeys)
              ? preparerItem.preparerMissingUnitKeys
              : [],
        };
      });
      return {
        ...requestWithAttemptCount,
        status: activityStatus || (hasPreparerMissingItems ? "no_localizado" : requestWithAttemptCount.status),
        items: itemsWithPreparerStatus,
        preparerName: preparerAssignment?.preparerName || "",
        preparedAt:
          preparerAssignment?.completedAt ||
          (["ready", "not_located"].includes(String(preparerAssignment?.status || "").trim().toLowerCase())
            ? preparerAssignment?.updatedAt || preparerAssignment?.assignedAt
            : null),
        preparerMissingUnitKeys: [...preparerMissingUnitKeySet],
        preparerNotLocatedScope,
        preparerReprogrammedNotLocated,
        preparerAssignmentStatus: preparerAssignment?.status || "",
        courierActivities: requestActivities,
        historyEvents: enrichCourierHistoryEvents({
          events: dedupeCourierHistoryEvents(historyEvents),
          request: { ...requestWithAttemptCount, items: itemsWithPreparerStatus },
          activitiesByRequestId: courierActivitiesByRequestId,
          transferActivityByRouteId,
        }),
        ...(handledAfterTransfer
          ? {
              transferredCourierName: String(transferActivity.courierName || "").trim(),
              routeTransferredAt: transferActivity.createdAt,
            }
          : {}),
      };
    })
    .sort((a, b) =>
      viewMode === VIEW_MODE.COURIER_HISTORY
        ? courierOrderTimestampMs(b) - courierOrderTimestampMs(a)
        : courierOrderTimestampMs(a) - courierOrderTimestampMs(b),
    );
  let visibleCourierOrders =
    viewMode === VIEW_MODE.COURIER || viewMode === VIEW_MODE.PREPARERS
      ? await sortCourierRouteOrdersByProximity(session.shop, courierOrders, routeStartAddress)
      : courierOrders;

  if (viewMode === VIEW_MODE.BRANCH_PICKUP) {
    const automaticRefundResult = await refundExpiredBranchPickupOrdersForShop(admin, session.shop, visibleCourierOrders);
    if (automaticRefundResult.refundedRequestIds.length) {
      const refundedIds = new Set(automaticRefundResult.refundedRequestIds);
      visibleCourierOrders = visibleCourierOrders.filter((order) => !refundedIds.has(String(order.id || "").trim()));
    }
  }

  let couriers =
    viewMode === VIEW_MODE.COURIER || viewMode === VIEW_MODE.COURIERS || viewMode === VIEW_MODE.COURIER_HISTORY
      ? await prisma.courier.findMany({
          where: { shop: session.shop },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        })
      : [];
  const preparers =
    viewMode === VIEW_MODE.PREPARERS
      ? await prisma.preparer.findMany({
          where: { shop: session.shop },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        })
      : [];
  const preparerAssignments =
    viewMode === VIEW_MODE.PREPARERS
      ? await prisma.preparerAssignment.findMany({
          where: { shop: session.shop },
          orderBy: [{ sequence: "asc" }, { id: "asc" }],
        })
      : [];
  if (
    (viewMode === VIEW_MODE.COURIERS || shouldLoadCourierHistoryActivity) &&
    couriers.length
  ) {
    const transferEvents = await prisma.courierActivity.findMany({
      where: {
        shop: session.shop,
        courierId: { in: couriers.map((courier) => courier.id) },
        action: { startsWith: "courier_route_transferred_from:" },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const originalNameByCourierId = new Map();
    for (const event of transferEvents) {
      if (originalNameByCourierId.has(event.courierId)) continue;
      originalNameByCourierId.set(
        event.courierId,
        String(event.action || "").replace("courier_route_transferred_from:", "").trim(),
      );
    }
    couriers = couriers.map((courier) => ({
      ...courier,
      name: originalNameByCourierId.get(courier.id) || courier.name,
    }));
  }

  const courierActivities =
    shouldLoadCourierHistoryActivity
      ? await prisma.courierActivity.findMany({
          where: {
            shop: session.shop,
            ...(!requestedHistoryRouteId && requestedHistoryView !== "all" && requestedHistoryCourierId
              ? { courierId: requestedHistoryCourierId }
              : {}),
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        })
      : [];

  const courierRouteSnapshots =
    shouldLoadCourierHistoryActivity
      ? await prisma.courierRouteSnapshot.findMany({
          where: {
            shop: session.shop,
            ...(requestedHistoryRouteId
              ? { routeId: requestedHistoryRouteId }
              : requestedHistoryView !== "all" && requestedHistoryCourierId
                ? { courierId: requestedHistoryCourierId }
                : {}),
          },
          orderBy: [{ finishedAt: "desc" }, { id: "desc" }],
        })
      : [];
  const plannedCourierRoutes =
    viewMode === VIEW_MODE.COURIER
      ? await plannedCourierRouteSummary(
          session.shop,
          couriers.map((courier) => courier.id),
        )
      : [];

  return {
    requests,
    courierOrders: visibleCourierOrders,
    couriers,
    preparers,
    preparerAssignments,
    courierActivities,
    courierRouteSnapshots,
    plannedCourierRoutes,
    viewMode,
    shop: session.shop,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const id = Number(formData.get("id") || 0);

  if (intent === "expire_branch_delivery_requests") {
    const expiredCount = await expireBranchDeliveryRequestsForShop(session.shop, { force: true });
    return {
      ok: true,
      message: expiredCount
        ? `${expiredCount} solicitud(es) vencidas se enviaron al historial.`
        : "No hay solicitudes aprobadas de entrega en sucursal para vencer.",
    };
  }

  if (intent === "branch_pickup_mark_delivered") {
    const requestId = String(formData.get("requestId") || "").trim();
    const orderNumber = String(formData.get("orderNumber") || "").trim();
    const submittedDeliveryCode = String(formData.get("deliveryCode") || "")
      .replace(/\D/g, "")
      .slice(0, 6);
    const deliveryCodeAssignment = await prisma.deliveryCodeAssignment.findUnique({
      where: {
        shop_shopifyOrderId: {
          shop: session.shop,
          shopifyOrderId: requestId,
        },
      },
      select: {
        code: true,
        active: true,
      },
    });
    if (
      submittedDeliveryCode.length !== 6 ||
      !deliveryCodeAssignment?.active ||
      String(deliveryCodeAssignment.code || "") !== submittedDeliveryCode
    ) {
      return {
        ok: false,
        error: "Clave incorrecta",
        deliveryCodeError: true,
        requestId,
      };
    }

    const result = await markCourierOrderAsDelivered({
      shopDomain: session.shop,
      requestId,
      orderNumber,
      customerName: String(formData.get("customerName") || "").trim(),
      customerEmail: String(formData.get("customerEmail") || "").trim(),
      customerPhone: String(formData.get("customerPhone") || "").trim(),
      currentAttemptCount: String(formData.get("currentAttemptCount") || "").trim(),
    });
    if (!result.ok) return result;

    const latestCourierActivity = await prisma.courierActivity.findFirst({
      where: {
        shop: session.shop,
        requestId,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        courierId: true,
        courierName: true,
        routeId: true,
      },
    });
    await prisma.courierActivity.create({
      data: {
        shop: session.shop,
        courierId: Number(latestCourierActivity?.courierId || 0),
        courierName: String(latestCourierActivity?.courierName || "Administrador").trim(),
        requestId,
        orderNumber: orderNumber || null,
        action: "courier_mark_delivered",
        routeId: String(latestCourierActivity?.routeId || "") || null,
      },
    });

    return {
      ok: true,
      message: `Pedido #${orderNumber || requestId.replace(/^gid:\/\/shopify\/Order\//, "")} marcado como entregado.`,
      deliveredRequestId: requestId,
    };
  }

  if (intent === "branch_pickup_refund_expired") {
    const requestId = String(formData.get("requestId") || "").trim();
    const orderNumber = String(formData.get("orderNumber") || "").trim();
    const displayedDeadline = String(formData.get("deadline") || "").trim();
    const isRefundTestMode = String(formData.get("branchPickupRefundTestMode") || "").trim() === "1";

    try {
      return await refundExpiredBranchPickupOrder({
        admin,
        shopDomain: session.shop,
        requestId,
        orderNumber,
        displayedDeadline,
        force: isRefundTestMode,
      });
    } catch (error) {
      return {
        ok: false,
        error: String(error?.message || error || "No se pudo procesar el reembolso."),
        requestId,
      };
    }
  }

  if (intent === "courier_bulk_refund" || intent === "courier_bulk_reprogram") {
    const selectedOrderIds = formData
      .getAll("courierBulkOrderIds")
      .map((orderId) => String(orderId || "").trim())
      .filter(Boolean);
    if (!selectedOrderIds.length) {
      return { ok: false, error: "Selecciona al menos una orden." };
    }
    let visibleRouteOrders = [];
    try {
      const parsedRouteOrders = JSON.parse(String(formData.get("routeOrdersJson") || "[]"));
      visibleRouteOrders = Array.isArray(parsedRouteOrders) ? parsedRouteOrders : [];
    } catch {
      visibleRouteOrders = [];
    }
    const fetchedDeliveryOrders = (await fetchCourierOrders(admin)).map((requestRow) => ({
      ...requestRow,
      courierLabel: "Entrega",
    }));
    const orderById = new Map();
    for (const order of [...visibleRouteOrders, ...fetchedDeliveryOrders]) {
      const orderId = String(order?.id || "").trim();
      if (orderId) orderById.set(orderId, order);
    }
    const selectedOrders = selectedOrderIds.map((orderId) => orderById.get(orderId)).filter(Boolean);
    if (selectedOrders.length !== selectedOrderIds.length) {
      return { ok: false, error: "Una o mas ordenes seleccionadas ya no estan disponibles." };
    }
    if (selectedOrders.some((order) => String(order?.id || "").startsWith("pickup-"))) {
      return { ok: false, error: "Esta accion solo aplica para ordenes de entrega." };
    }

    if (intent === "courier_bulk_refund") {
      try {
        const selectedLineItemUnitKeys = formData
          .getAll("courierRefundLineItemUnitKeys")
          .map((lineItemUnitKey) => String(lineItemUnitKey || "").trim())
          .filter(Boolean);
        if (!selectedLineItemUnitKeys.length) {
          return { ok: false, error: "Selecciona al menos un producto para reembolsar." };
        }
        const refundedOrders = [];
        for (const order of selectedOrders) {
          const requestId = String(order.id || "").trim();
          const orderNumber = String(order.orderNumber || "").trim();
          const latestCourierActivity = await prisma.courierActivity.findFirst({
            where: {
              shop: session.shop,
              requestId,
              action: { not: COURIER_ORDER_REFUND_DETAIL_ACTION },
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: {
              courierId: true,
              courierName: true,
              routeId: true,
            },
          });
          const existingRefundActivities = await prisma.courierActivity.findMany({
            where: {
              shop: session.shop,
              requestId,
              action: COURIER_ORDER_REFUND_DETAIL_ACTION,
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          });
          const alreadyRefundedUnitKeys = courierRefundedUnitKeySetFromActivities(existingRefundActivities);
          const refundableSelectedLineItemUnitKeys = selectedLineItemUnitKeys.filter(
            (unitKey) => !alreadyRefundedUnitKeys.has(String(unitKey || "").trim()),
          );
          if (!refundableSelectedLineItemUnitKeys.length) {
            return { ok: false, error: "Los productos seleccionados ya fueron reembolsados." };
          }
          const refundResult = await refundShopifyOrderToOriginalPayment({
            admin,
            shopifyOrderId: requestId,
            notePrefix: `Reembolso pedido #${orderNumber || requestId.replace(/^gid:\/\/shopify\/Order\//, "")} desde ordenes repartidor`,
            includeShipping: true,
            selectedLineItemUnitKeys: refundableSelectedLineItemUnitKeys,
          });
          const refundNotificationCopy = buildCourierOrderRefundNotificationCopy({
            orderNumber: orderNumber || requestId.replace(/^gid:\/\/shopify\/Order\//, ""),
            refundAmount: refundResult.finalRefund,
            currencyCode: refundResult.currencyCode || "MXN",
            selectedAllLineItems: Boolean(refundResult.selectedAllLineItems),
            refundedItems: refundResult.refundedItems || [],
          });
          const refundNotificationSentAt = new Date();
          await emitCourierOrderRefundNotification({
            shopDomain: session.shop,
            requestId,
            orderNumber: orderNumber || requestId.replace(/^gid:\/\/shopify\/Order\//, ""),
            refundAmount: refundResult.finalRefund,
            currencyCode: refundResult.currencyCode || "MXN",
            selectedAllLineItems: Boolean(refundResult.selectedAllLineItems),
            refundedItems: refundResult.refundedItems || [],
            refundId: refundResult.refundId || "",
          });
          await prisma.courierActivity.create({
            data: {
              shop: session.shop,
              courierId: Number(latestCourierActivity?.courierId || 0),
              courierName: String(latestCourierActivity?.courierName || "Administrador").trim(),
              requestId,
              orderNumber: orderNumber || null,
              action: COURIER_ORDER_REFUND_DETAIL_ACTION,
              routeId: encodeCourierRefundDetailRouteId({
                orderNumber: orderNumber || requestId.replace(/^gid:\/\/shopify\/Order\//, ""),
                amount: refundResult.finalRefund,
                currencyCode: refundResult.currencyCode || "MXN",
                fullRefund: Boolean(refundResult.selectedAllLineItems),
                items: refundResult.refundedItems || [],
                notificationTitle: refundNotificationCopy.title,
                notificationMessage: refundNotificationCopy.message,
                notificationSentAt: refundNotificationSentAt.toISOString(),
                refundedAt: refundNotificationSentAt.toISOString(),
              }),
            },
          });
          if (refundResult.selectedAllLineItems) {
            await replaceShopifyOrderCourierStatusTag(admin, requestId, "reembolsada");
            await prisma.deliveryCodeAssignment.updateMany({
              where: {
                shop: session.shop,
                shopifyOrderId: requestId,
                active: true,
              },
              data: {
                code: null,
                active: false,
                releasedAt: new Date(),
              },
            });
            await clearCourierRoutesForOrders(session.shop, [requestId]);
            await prisma.courierActivity.create({
              data: {
                shop: session.shop,
                courierId: Number(latestCourierActivity?.courierId || 0),
                courierName: String(latestCourierActivity?.courierName || "Administrador").trim(),
                requestId,
                orderNumber: orderNumber || null,
                action: "courier_branch_pickup_refunded",
                routeId: String(latestCourierActivity?.routeId || "") || null,
              },
            });
          }
          refundedOrders.push({
            requestId,
            orderNumber: orderNumber || requestId.replace(/^gid:\/\/shopify\/Order\//, ""),
            amount: refundResult.finalRefund,
            currencyCode: refundResult.currencyCode || "MXN",
            fullRefund: Boolean(refundResult.selectedAllLineItems),
          });
        }
        const totalRefunded = refundedOrders.reduce((sum, order) => sum + Number(order.amount || 0), 0);
        const currencyCode = refundedOrders[0]?.currencyCode || "MXN";
        const fullRefundCount = refundedOrders.filter((order) => order.fullRefund).length;
        return {
          ok: true,
          message: `Artículos reembolsados correctamente por ${toMoney(totalRefunded)} ${currencyCode}.${
            fullRefundCount ? ` ${fullRefundCount} orden(es) enviada(s) al historial.` : ""
          }`,
          courierBulkAction: "refund",
          courierBulkRequestIds: refundedOrders.map((order) => order.requestId).filter(Boolean),
        };
      } catch (error) {
        return {
          ok: false,
          error: String(error?.message || error || "No se pudo procesar el reembolso."),
        };
      }
    }

    try {
      const reprogrammedOrders = [];
      for (const order of selectedOrders) {
        const requestId = String(order.id || "").trim();
        const orderNumber = String(order.orderNumber || "").trim();
        const currentScheduledDate = String(
          await getLatestCourierDeliveryDate({
            shopDomain: session.shop,
            requestId,
            orderNumber,
            fallbackDate: order.pickupDate || "",
          }) || order.pickupDate || "",
        ).trim();
        const rescheduledDate = nextIsoDate(currentScheduledDate);
        const result = await reprogramCourierDeliveryForNextRoute({
          shopDomain: session.shop,
          requestId,
          orderNumber,
          customerName: String(order.customerName || "Cliente").trim(),
          customerPhone: String(order.customerPhone || "-").trim(),
          currentAttemptCount: Number(order.attemptCount || 0),
          currentScheduledDate,
          ...(rescheduledDate ? { rescheduledDate } : {}),
        });
        if (!result?.ok) {
          return {
            ok: false,
            error: result?.error || `No se pudo reprogramar el pedido #${orderNumber || requestId}.`,
          };
        }
        const finalRescheduledDate = String(result.rescheduledDate || rescheduledDate || "").trim();
        const latestReprogramEvent = await prisma.courierEvent.findFirst({
          where: {
            shop: session.shop,
            requestId,
            status: "reintento_pendiente",
            ...(finalRescheduledDate
              ? { note: { contains: `route_time_rescheduled:${finalRescheduledDate}` } }
              : {}),
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { id: true, note: true },
        });
        if (latestReprogramEvent) {
          const currentNote = String(latestReprogramEvent.note || "").trim();
          await prisma.courierEvent.update({
            where: { id: latestReprogramEvent.id },
            data: {
              note: currentNote.includes(COURIER_ADMIN_NOT_LOCATED_REPROGRAM_NOTE)
                ? currentNote
                : [currentNote, COURIER_ADMIN_NOT_LOCATED_REPROGRAM_NOTE].filter(Boolean).join(";"),
            },
          });
        }
        await prisma.courierActivity.create({
          data: {
            shop: session.shop,
            courierId: 0,
            courierName: "Administrador",
            requestId,
            orderNumber: orderNumber || null,
            action: COURIER_ADMIN_REPROGRAM_ACTION,
            routeId: null,
          },
        });
        reprogrammedOrders.push({
          requestId,
          orderNumber: orderNumber || requestId.replace(/^gid:\/\/shopify\/Order\//, ""),
        });
      }
      return {
        ok: true,
        message: `${reprogrammedOrders.length} orden(es) reprogramada(s) para el siguiente dia.`,
        courierBulkAction: "reprogram",
        courierBulkRequestIds: reprogrammedOrders.map((order) => order.requestId).filter(Boolean),
      };
    } catch (error) {
      return {
        ok: false,
        error: String(error?.message || error || "No se pudo reprogramar la orden."),
      };
    }
  }

  if (intent === "plan_courier_routes") {
    const selectedCourierIds = formData
      .getAll("courierIds")
      .map((courierId) => Number(courierId))
      .filter((courierId) => Number.isInteger(courierId) && courierId > 0);
    const selectedRouteOrderIds = formData
      .getAll("routeOrderIds")
      .map((routeOrderId) => String(routeOrderId || "").trim())
      .filter(Boolean);
    const selectedRouteOrderIdSet = new Set(selectedRouteOrderIds);
    let visibleRouteOrders = [];
    try {
      const parsedRouteOrders = JSON.parse(String(formData.get("routeOrdersJson") || "[]"));
      visibleRouteOrders = Array.isArray(parsedRouteOrders) ? parsedRouteOrders : [];
    } catch {
      visibleRouteOrders = [];
    }
    const couriers = await prisma.courier.findMany({
      where: selectedCourierIds.length
        ? { shop: session.shop, id: { in: selectedCourierIds } }
        : { shop: session.shop, id: { in: [] } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (!couriers.length) {
      return { ok: false, error: "Selecciona al menos un repartidor para distribuir las rutas." };
    }
    const fetchedRouteOrders = [
      ...(await fetchCourierOrders(admin)).map((requestRow) => ({
        ...requestRow,
        courierLabel: "Entrega",
      })),
      ...(await fetchPickupCourierOrders(session.shop)).map((requestRow) => ({
        ...requestRow,
        courierLabel: "Devolución",
      })),
    ];
    const routeOrderById = new Map();
    for (const order of [...fetchedRouteOrders, ...visibleRouteOrders]) {
      const orderId = String(order?.id || "").trim();
      if (orderId && !routeOrderById.has(orderId)) routeOrderById.set(orderId, order);
    }
    const routeOrders = (selectedRouteOrderIds.length
      ? selectedRouteOrderIds.map((orderId) => routeOrderById.get(orderId)).filter(Boolean)
      : fetchedRouteOrders
    ).filter((order) => {
      if (selectedRouteOrderIdSet.size && !selectedRouteOrderIdSet.has(String(order?.id || "").trim())) return false;
      if (selectedRouteOrderIdSet.size) return true;
      const status = String(order?.status || "").trim().toLowerCase();
      return !isCourierHistoryStatus(status) && status !== "recoger_en_sucursal";
    });
    if (!routeOrders.length) {
      return { ok: false, error: "No hay ordenes pendientes para distribuir." };
    }

    await clearCourierRoutesForOrders(
      session.shop,
      routeOrders.map((order) => String(order?.id || "").trim()).filter(Boolean),
    );
    await clearUnstartedCourierRoutePlans(session.shop);
    const routeSettings = await prisma.returnSettings.findUnique({
      where: { shop: session.shop },
      select: { branchAddress: true },
    });
    const routeGroups = (await distributeCourierRouteOrdersByZone(
      session.shop,
      routeOrders,
      couriers,
      String(routeSettings?.branchAddress || "").trim(),
    )).filter(
      (group) => group.orders.length,
    );
    const activities = [];
    for (const group of routeGroups) {
      const routeId = crypto.randomUUID();
      activities.push({
        shop: session.shop,
        courierId: group.courier.id,
        courierName: group.courier.name,
        requestId: `route:${routeId}`,
        action: COURIER_ROUTE_PLANNED_ACTION,
        routeId,
      });
      for (const order of group.orders) {
        activities.push({
          shop: session.shop,
          courierId: group.courier.id,
          courierName: group.courier.name,
          requestId: String(order.id || ""),
          orderNumber: String(order.orderNumber || "").trim() || null,
          action: "courier_route_order_assigned",
          routeId,
        });
      }
    }
    if (activities.length) {
      await prisma.courierActivity.createMany({ data: activities });
    }
    return {
      ok: true,
      message: `Rutas distribuidas automaticamente para ${routeGroups.length} repartidor(es).`,
    };
  }

  if (intent === "create_courier") {
    const name = String(formData.get("name") || "").trim();
    const code = String(formData.get("code") || "").trim();
    if (!name) return { ok: false, error: "Escribe el nombre del repartidor." };
    if (!/^\d{6}$/.test(code)) {
      return { ok: false, error: "Genera un codigo numerico de 6 digitos." };
    }
    const existingCourier = await prisma.courier.findFirst({
      where: { shop: session.shop, code },
      select: { id: true },
    });
    if (existingCourier) {
      return { ok: false, error: "Ese codigo ya existe. Genera uno nuevo." };
    }
    await prisma.courier.create({
      data: { shop: session.shop, name, code },
    });
    return { ok: true, message: "Repartidor guardado correctamente." };
  }

  if (intent === "delete_courier") {
    const courierId = Number(formData.get("courierId") || 0);
    if (!courierId) return { ok: false, error: "Repartidor invalido." };
    const deletedCourier = await prisma.courier.deleteMany({
      where: { id: courierId, shop: session.shop },
    });
    if (!deletedCourier.count) {
      return { ok: false, error: "No se encontro el repartidor." };
    }
    return { ok: true, message: "Repartidor dado de baja correctamente." };
  }

  if (intent === "create_preparer") {
    const name = String(formData.get("name") || "").trim();
    const code = String(formData.get("code") || "").trim();
    if (!name) return { ok: false, error: "Escribe el nombre del preparador." };
    if (!/^\d{6}$/.test(code)) {
      return { ok: false, error: "Genera un codigo numerico de 6 digitos." };
    }
    const existingPreparer = await prisma.preparer.findFirst({
      where: { shop: session.shop, code },
      select: { id: true },
    });
    if (existingPreparer) {
      return { ok: false, error: "Ese codigo ya existe. Genera uno nuevo." };
    }
    await prisma.preparer.create({
      data: { shop: session.shop, name, code },
    });
    return { ok: true, intent: "create_preparer", message: "Preparador guardado correctamente." };
  }

  if (intent === "delete_preparer") {
    const preparerId = Number(formData.get("preparerId") || 0);
    if (!preparerId) return { ok: false, error: "Preparador invalido." };
    const deletedPreparer = await prisma.preparer.deleteMany({
      where: { id: preparerId, shop: session.shop },
    });
    if (!deletedPreparer.count) {
      return { ok: false, error: "No se encontro el preparador." };
    }
    return { ok: true, message: "Preparador dado de baja correctamente." };
  }

  if (intent === "transfer_preparer_account") {
    const preparerId = Number(formData.get("preparerId") || 0);
    const newPreparerName = String(formData.get("newPreparerName") || "").trim();
    if (!preparerId) return { ok: false, error: "Preparador invalido." };
    if (!newPreparerName) return { ok: false, error: "Escribe el nombre del nuevo preparador." };
    const preparer = await prisma.preparer.findFirst({
      where: { id: preparerId, shop: session.shop },
      select: { id: true, name: true },
    });
    if (!preparer) return { ok: false, error: "No se encontro el preparador." };
    let nextCode = "";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidateCode = String(Math.floor(100000 + Math.random() * 900000));
      const existingPreparer = await prisma.preparer.findFirst({
        where: { shop: session.shop, code: candidateCode },
        select: { id: true },
      });
      if (!existingPreparer) {
        nextCode = candidateCode;
        break;
      }
    }
    if (!nextCode) return { ok: false, error: "No se pudo generar un codigo nuevo para transferir la cuenta." };
    const preparerAssignmentsToTransfer = await prisma.preparerAssignment.findMany({
      where: { shop: session.shop, preparerId: preparer.id },
      select: { id: true, orderData: true },
    });
    await prisma.$transaction([
      prisma.preparer.update({
        where: { id: preparer.id },
        data: { code: nextCode },
      }),
      ...preparerAssignmentsToTransfer.map((assignment) => {
        const orderData = assignment.orderData && typeof assignment.orderData === "object" ? assignment.orderData : {};
        return prisma.preparerAssignment.update({
          where: { id: assignment.id },
          data: {
            orderData: {
              ...orderData,
              preparerOriginalName: orderData.preparerOriginalName || preparer.name,
              preparerTransferredToName: newPreparerName,
              preparerTransferredAt: new Date().toISOString(),
              preparerSessionFinishedAt: null,
            },
          },
        });
      }),
    ]);
    return {
      ok: true,
      message: `Cuenta de ${preparer.name} transferida a ${newPreparerName}. Usa el codigo ${nextCode} para entrar.`,
    };
  }

  if (intent === "plan_preparer_orders") {
    const selectedPreparerIds = formData
      .getAll("preparerIds")
      .map((preparerId) => Number(preparerId))
      .filter((preparerId) => Number.isInteger(preparerId) && preparerId > 0);
    const selectedOrderIds = formData
      .getAll("routeOrderIds")
      .map((orderId) => String(orderId || "").trim())
      .filter(Boolean);
    let visibleOrders = [];
    try {
      const parsedOrders = JSON.parse(String(formData.get("routeOrdersJson") || "[]"));
      visibleOrders = Array.isArray(parsedOrders) ? parsedOrders : [];
    } catch {
      visibleOrders = [];
    }
    const preparers = await prisma.preparer.findMany({
      where: selectedPreparerIds.length
        ? { shop: session.shop, id: { in: selectedPreparerIds } }
        : { shop: session.shop, id: { in: [] } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (!preparers.length) {
      return { ok: false, error: "Selecciona al menos un preparador para distribuir las ordenes." };
    }
    const orderById = new Map();
    for (const order of visibleOrders) {
      const orderId = String(order?.id || "").trim();
      if (orderId && !orderById.has(orderId)) orderById.set(orderId, order);
    }
    const orderSortValue = (order) => {
      const sequence = Number(order?.sequenceNumber || 0) || 0;
      const orderNumber = Number(String(order?.orderNumber || "").replace(/\D/g, "") || 0) || 0;
      return { sequence, orderNumber };
    };
    const orders = (selectedOrderIds.length
      ? selectedOrderIds.map((orderId) => orderById.get(orderId)).filter(Boolean)
      : visibleOrders
    )
      .filter((order) => String(order?.id || "").trim())
      .filter((order) => !isReturnCourierLabel(order?.courierLabel))
      .sort((firstOrder, secondOrder) => {
        const first = orderSortValue(firstOrder);
        const second = orderSortValue(secondOrder);
        return first.sequence - second.sequence || first.orderNumber - second.orderNumber;
      })
      .map((order, index) => {
        const sequenceNumber = Number(order?.sequenceNumber || 0) || index + 1;
        return { ...order, sequenceNumber };
      });
    if (!orders.length) {
      return { ok: false, error: "No hay ordenes pendientes para distribuir." };
    }

    const baseCount = Math.floor(orders.length / preparers.length);
    const remainder = orders.length % preparers.length;
    let orderIndex = 0;
    const assignments = [];
    for (const [preparerIndex, preparer] of preparers.entries()) {
      const countForPreparer = baseCount + (preparerIndex >= preparers.length - remainder ? 1 : 0);
      const assignedOrders = orders.slice(orderIndex, orderIndex + countForPreparer);
      orderIndex += countForPreparer;
      for (const order of assignedOrders) {
        const sequence = Number(order.sequenceNumber || 0) || assignments.length + 1;
        assignments.push({
          shop: session.shop,
          preparerId: preparer.id,
          preparerName: preparer.name,
          requestId: String(order.id || "").trim(),
          orderNumber: String(order.orderNumber || "").trim() || null,
          sequence,
          status: "assigned",
          orderData: order,
          completedAt: null,
        });
      }
    }

    await prisma.$transaction([
      prisma.preparerAssignment.deleteMany({
        where: { shop: session.shop },
      }),
      ...(assignments.length ? [prisma.preparerAssignment.createMany({ data: assignments })] : []),
    ]);

    return {
      ok: true,
      message: `${assignments.length} orden(es) distribuidas entre ${preparers.length} preparador(es).`,
    };
  }

  if (intent === "transfer_courier_route") {
    const courierId = Number(formData.get("courierId") || 0);
    const newCourierName = String(formData.get("newCourierName") || "").trim();
    if (!courierId) return { ok: false, error: "Repartidor invalido." };
    if (!newCourierName) return { ok: false, error: "Escribe el nombre del nuevo repartidor." };

    const courier = await prisma.courier.findFirst({
      where: { id: courierId, shop: session.shop },
      select: { id: true, name: true },
    });
    if (!courier) return { ok: false, error: "No se encontro el repartidor." };

    const latestRouteStart = await prisma.courierActivity.findFirst({
      where: {
        shop: session.shop,
        courierId,
        action: "courier_route_started",
        routeId: { not: null },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (!latestRouteStart?.routeId) {
      return { ok: false, error: "Este repartidor no tiene una ruta activa para transferir." };
    }
    const finishedRoute = await prisma.courierActivity.findFirst({
      where: {
        shop: session.shop,
        courierId,
        routeId: latestRouteStart.routeId,
        action: "courier_route_finished",
      },
      select: { id: true },
    });
    if (finishedRoute) {
      return { ok: false, error: "La ultima ruta de este repartidor ya fue finalizada." };
    }

    const previousTransfer = await prisma.courierActivity.findFirst({
      where: {
        shop: session.shop,
        courierId,
        action: { startsWith: "courier_route_transferred_from:" },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const originalCourierName = previousTransfer
      ? String(previousTransfer.action || "").replace("courier_route_transferred_from:", "").trim()
      : courier.name;
    if (originalCourierName.toLowerCase() === newCourierName.toLowerCase()) {
      return { ok: false, error: "Escribe un nombre diferente para transferir la ruta." };
    }

    await prisma.$transaction([
      ...(courier.name !== originalCourierName
        ? [
            prisma.courier.update({
              where: { id: courierId },
              data: { name: originalCourierName },
            }),
          ]
        : []),
      prisma.courierActivity.create({
        data: {
          shop: session.shop,
          courierId,
          courierName: newCourierName,
          requestId: `route:${latestRouteStart.routeId}`,
          action: `courier_route_transferred_from:${originalCourierName}`,
          routeId: latestRouteStart.routeId,
        },
      }),
    ]);
    return {
      ok: true,
      message: `Ruta transferida de ${originalCourierName} a ${newCourierName}.`,
    };
  }

  if (intent === "load_request_media") {
    if (!id) return { ok: false, intent, error: "Solicitud invalida." };
    const mediaRequestRow = await prisma.returnRequest.findFirst({
      where: { id, shop: session.shop },
      select: {
        id: true,
        shopifyOrderId: true,
        items: {
          select: {
            id: true,
            lineItemId: true,
            productId: true,
            variantId: true,
            title: true,
            photoDataUrl: true,
          },
        },
      },
    });
    if (!mediaRequestRow) return { ok: false, intent, error: "No se encontro la solicitud." };

    const imagesByOrder = await fetchOrderItemImageMaps(admin, [mediaRequestRow.shopifyOrderId]);
    const imageMap = imagesByOrder[mediaRequestRow.shopifyOrderId] || {};
    const mediaItems = mediaRequestRow.items.map((item) => {
      const image = imageMap[itemKeyFromRecord(item)] || null;
      return {
        id: item.id,
        imageUrl: image?.imageUrl || "",
        imageAlt: image?.imageAlt || "",
        variantSummary: image?.variantSummary || "",
        photoDataUrl: item.photoDataUrl || "",
      };
    });
    return { ok: true, intent, mediaItems };
  }

  if (!id) return { ok: false, error: "Solicitud invalida." };

  const requestRow = await prisma.returnRequest.findFirst({
    where: { id, shop: session.shop },
    include: { items: true },
  });
  if (!requestRow) return { ok: false, error: "No se encontro la solicitud." };

  if (intent === "approve_request") {
    const approvedMessage =
      requestRow.returnMethod === "pickup"
        ? pickupApprovedPortalMessage(requestRow)
        : branchApprovedPortalMessage(requestRow);
    await prisma.returnRequest.update({
      where: { id },
      data: {
        status: "aprobada",
        rejectionReason: appendTimelineMetaEntry(requestRow.rejectionReason, {
          kind: STATUS_APPROVED_KIND,
          reason: approvedMessage,
        }),
      },
    });
    await emitReturnNotificationEvent({
      shopDomain: session.shop,
      requestRow,
      intent,
      note: approvedMessage,
    });
    return { ok: true, message: "Solicitud aprobada correctamente." };
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
    await emitReturnNotificationEvent({
      shopDomain: session.shop,
      requestRow,
      intent,
      note: rejectionReason,
    });
    return { ok: true, message: "Devolucion rechazada correctamente." };
  }

  if (intent === "mark_in_route") {
    if (String(requestRow.returnMethod || "").toLowerCase() !== "pickup") {
      return { ok: false, error: "Solo aplica a solicitudes de recoleccion a domicilio." };
    }
    const currentStatus = String(requestRow.status || "").toLowerCase();
    if (currentStatus !== "aprobada" && currentStatus !== "en_ruta" && !currentStatus.startsWith("en_ruta_")) {
      return { ok: false, error: "Solo puedes marcar en ruta una solicitud aprobada." };
    }
    const routeNote = "Tu recoleccion ya va en ruta hacia tu domicilio. Nuestro equipo se dirige para continuar el proceso.";
    await prisma.returnRequest.update({
      where: { id },
      data: {
        status: currentStatus.startsWith("en_ruta_") ? currentStatus : "en_ruta",
        rejectionReason: appendTimelineMetaEntry(requestRow.rejectionReason, {
          kind: STATUS_IN_ROUTE_KIND,
          reason: routeNote,
        }),
      },
    });
    await emitOrderStatusNotification({
      shopDomain: session.shop,
      requestRow,
      status: "en_ruta",
      note: routeNote,
    });
    return { ok: true, message: "Solicitud marcada como en ruta y notificada al cliente." };
  }

  if (intent === "mark_received") {
    const currentStatus = String(requestRow.status || "").toLowerCase();
    const canMarkReceived =
      currentStatus === "aprobada" ||
      currentStatus === "en_ruta" ||
      currentStatus.startsWith("en_ruta_") ||
      isPickupFailedAttemptStatus(currentStatus);
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
        rejectionReason: appendTimelineMetaEntry(requestRow.rejectionReason, {
          kind: STATUS_RECEIVED_KIND,
          reason: receivedReturnPortalMessage(requestRow),
        }),
      },
    });
    await emitReturnNotificationEvent({
      shopDomain: session.shop,
      requestRow,
      intent,
      note: receivedReturnPortalMessage(requestRow),
    });
    return { ok: true, message: "Solicitud marcada como recibida." };
  }

  if (intent === "mark_never_arrived") {
    const isBranchDeliveryTestMode = String(formData.get("branchDeliveryTestMode") || "").trim() === "1";
    if (String(requestRow.returnMethod || "").toLowerCase() === "pickup") {
      return { ok: false, error: "Solo aplica a solicitudes de entrega en sucursal." };
    }
    if (String(requestRow.status || "").toLowerCase() !== "aprobada") {
      return { ok: false, error: "Solo puedes marcar como nunca llego una solicitud aprobada." };
    }
    const isBranchDeliveryDeadlineExpired = isBranchDeliveryExpired(requestRow.limitDate);
    if (!isBranchDeliveryTestMode && !isBranchDeliveryDeadlineExpired) {
      return { ok: false, error: "Aun no vence la fecha limite de entrega para marcar esta solicitud como nunca llego." };
    }
    await markBranchDeliveryNeverArrived({
      shopDomain: session.shop,
      requestRow,
      force: isBranchDeliveryTestMode,
    });
    return { ok: true, message: "Solicitud marcada como nunca llego y enviada al historial." };
  }
  if (intent === "pickup_attempt_failed") {
    const currentStatus = String(requestRow.status || "").toLowerCase();
    if (requestRow.returnMethod !== "pickup") {
      return { ok: false, error: "Solo aplica a solicitudes de recoleccion a domicilio." };
    }
    if (
      currentStatus !== "aprobada" &&
      currentStatus !== "en_ruta" &&
      !currentStatus.startsWith("en_ruta_") &&
      currentStatus !== "intento_fallido_1" &&
      currentStatus !== "intento_fallido_2"
    ) {
      return { ok: false, error: "Ya no puedes registrar mas intentos fallidos para esta solicitud." };
    }
    const rejectionReason = String(formData.get("rejectionReason") || "").trim();
    if (!rejectionReason) {
      return { ok: false, error: "Escribe la descripcion obligatoria del intento fallido." };
    }
    const currentRouteAttempt = Number(currentStatus.match(/^en_ruta_(\d+)$/)?.[1] || 0);
    const nextStatus =
      currentStatus === "aprobada" || currentStatus === "en_ruta" || currentRouteAttempt <= 1
        ? "intento_fallido_1"
        : currentStatus === "intento_fallido_1" || currentRouteAttempt === 2
          ? "intento_fallido_2"
          : "intento_fallido_3";
    await prisma.returnRequest.update({
      where: { id },
      data: {
        status: nextStatus,
        rejectionReason: appendReasonEntry(requestRow.rejectionReason, {
          kind: `attempt_failed_${nextStatus.replace("intento_fallido_", "")}`,
          reason: rejectionReason,
        }),
      },
    });
    await emitReturnNotificationEvent({
      shopDomain: session.shop,
      requestRow,
      intent,
      note: rejectionReason,
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
    await emitReturnNotificationEvent({
      shopDomain: session.shop,
      requestRow,
      intent,
      note: rejectionReason,
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
    const deniedAt = new Date();
    const pickupDeadlineDate = addDays(deniedAt.toISOString(), PICKUP_DEADLINE_DAYS);
    const branchSettings = await loadBranchReturnSettings(session.shop);
    const deniedRefundMessage = buildDeniedRefundPickupMessage({
      requestRow,
      reason: rejectionReason,
      pickupDeadlineAt: pickupDeadlineDate?.toISOString?.() || "",
      branchAddress: branchSettings?.branchAddress,
      branchHours: branchSettings?.branchHours,
    });
    await prisma.returnRequest.update({
      where: { id },
      data: {
        status: "por_devolver",
        rejectionReason: appendReasonEntry(requestRow.rejectionReason, {
          kind: "denied_after_received",
          reason: deniedRefundMessage,
          at: deniedAt.toISOString(),
        }),
        refundError: null,
      },
    });
    await emitReturnNotificationEvent({
      shopDomain: session.shop,
      requestRow,
      intent,
      note: deniedRefundMessage,
      title: "Reembolso denegado ❌",
      message: deniedRefundMessage,
    });
    return { ok: true, message: "Devolucion denegada correctamente.", refundActionRequestId: id };
  }

  if (intent === "mark_returned_to_customer") {
    if (String(requestRow.status || "").toLowerCase() !== "por_devolver") {
      return { ok: false, error: "Solo puedes confirmar devoluciones pendientes por recoger." };
    }
    const returnedToCustomerMessage = buildReturnedToCustomerMessage(requestRow);
    await prisma.returnRequest.update({
      where: { id },
      data: {
        status: "reembolso_denegado",
        rejectionReason: appendReasonEntry(requestRow.rejectionReason, {
          kind: RETURNED_TO_CUSTOMER_KIND,
          reason: returnedToCustomerMessage,
        }),
      },
    });
    await emitReturnNotificationEvent({
      shopDomain: session.shop,
      requestRow,
      intent,
      note: returnedToCustomerMessage,
      title: RETURNED_TO_CUSTOMER_NOTIFICATION_TITLE,
      message: returnedToCustomerMessage,
    });
    return {
      ok: true,
      message: "Devolucion marcada como devuelta al cliente y enviada al historial.",
      returnToCustomerActionRequestId: id,
    };
  }

  if (intent === "mark_not_returned") {
    if (String(requestRow.status || "").toLowerCase() !== "por_devolver") {
      return { ok: false, error: "Solo aplica a solicitudes pendientes por recoger." };
    }
    const isNotReturnedTestMode = String(formData.get("notReturnedTestMode") || "").trim() === "1";
    const pendingPickupSinceAt =
      latestEntryAtFromKinds(requestRow.rejectionReason, ["denied_after_received"]) ||
      requestRow.updatedAt?.toISOString?.() ||
      "";
    const notReturnedDeadlineDate = addDays(pendingPickupSinceAt, NOT_RETURNED_ACTION_DEADLINE_DAYS);
    if (!isNotReturnedTestMode && (!notReturnedDeadlineDate || new Date().getTime() <= notReturnedDeadlineDate.getTime())) {
      return {
        ok: false,
        error: "Aun no se cumplen los 60 dias para marcar esta solicitud como no devuelta.",
      };
    }
    await prisma.returnRequest.update({
      where: { id },
      data: {
        status: "no_devuelto",
        rejectionReason: appendReasonEntry(requestRow.rejectionReason, {
          kind: NOT_RETURNED_KIND,
          reason: NOT_RETURNED_REASON,
        }),
      },
    });
    return {
      ok: true,
      message: "Solicitud marcada como no devuelta y enviada al historial.",
      returnToCustomerActionRequestId: id,
    };
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
      const refundProcessedMessage = buildRefundProcessedMessage(requestRow, finalRefund);
      await prisma.returnRequest.update({
        where: { id },
        data: {
          status: "reembolsada",
          refundedAt: new Date(),
          rejectionReason: appendTimelineMetaEntry(requestRow.rejectionReason, {
            kind: STATUS_REFUNDED_KIND,
            reason: refundProcessedMessage,
          }),
          shopifyRefundId: refundId || null,
          refundedSubtotal: subtotal,
          finalRefund,
          refundError: null,
        },
      });
      await emitReturnNotificationEvent({
        shopDomain: session.shop,
        requestRow,
        intent,
        note: refundProcessedMessage,
        title: "Reembolso procesado ✅",
        message: refundProcessedMessage,
      });
      return { ok: true, message: "Reembolso procesado correctamente.", refundActionRequestId: id };
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

function normalizeCourierAttrKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function getCourierCustomAttribute(orderNode, candidateKeys) {
  const attributes = Array.isArray(orderNode?.customAttributes) ? orderNode.customAttributes : [];
  const normalizedKeys = new Set((candidateKeys || []).map((key) => normalizeCourierAttrKey(key)));
  const match = attributes.find((attribute) => normalizedKeys.has(normalizeCourierAttrKey(attribute?.key)));
  return String(match?.value || "").trim();
}

function getCourierScheduledDate(orderNode) {
  const candidate = getCourierCustomAttribute(orderNode, [
    "programado",
    "pickupDate",
    "pickup_date",
    "delivery_date",
    "deliveryDate",
    "scheduled_date",
    "scheduledDate",
    "preferred_delivery_date",
  ]);
  return candidate;
}

function getInitialCourierScheduledDate(orderNode) {
  const configuredDate = getCourierScheduledDate(orderNode);
  if (configuredDate) return configuredDate;
  const createdAt = new Date(orderNode?.createdAt);
  if (!Number.isFinite(createdAt.getTime())) return String(orderNode?.createdAt || "");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(createdAt);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return new Date(Date.UTC(
    Number(lookup.year),
    Number(lookup.month) - 1,
    Number(lookup.day) + 1,
  )).toISOString().slice(0, 10);
}

function parseCourierDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const date = raw.includes("T") ? new Date(raw) : new Date(`${raw}T00:00:00`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function isCourierLocalDeliveryOrder(orderNode) {
  const shippingLines = Array.isArray(orderNode?.shippingLines?.nodes) ? orderNode.shippingLines.nodes : [];
  return shippingLines.some((line) => {
    const title = String(line?.title || "").toLowerCase();
    const code = String(line?.code || "").toLowerCase();
    const category = String(line?.deliveryCategory || "").toLowerCase();
    return title.includes("local") || code.includes("local") || category.includes("local");
  });
}

function getCourierStatusLabel(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (
    ["no_entregado", "reintento_pendiente", "no_recibido", "intento_fallido_1", "intento_fallido_2"].includes(
      normalized,
    )
  ) {
    return "reprogramado";
  }
  if (normalized.startsWith("en_ruta")) return "en ruta";
  return STATUS_LABEL[normalized] || normalized.replace(/_/g, " ");
}

async function fetchCourierOrders(admin) {
  const response = await admin.graphql(
    `#graphql
    query CourierOrders {
      orders(first: 250, query: "fulfillment_status:unfulfilled", sortKey: UPDATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            createdAt
            updatedAt
            displayFulfillmentStatus
            tags
            currentTotalPriceSet {
              shopMoney { amount currencyCode }
            }
            shippingAddress {
              name
              phone
              address1
              address2
              city
              province
              zip
              country
            }
            billingAddress {
              name
              phone
            }
            customAttributes {
              key
              value
            }
            shippingLines(first: 5) {
              nodes {
                title
                code
                deliveryCategory
              }
            }
            lineItems(first: 100) {
              edges {
                node {
                  id
                  title
                  quantity
                  originalUnitPriceSet {
                    shopMoney { amount currencyCode }
                  }
                  variant {
                    id
                    title
                    selectedOptions {
                      name
                      value
                    }
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
      }
    }`,
  );
  const payload = await response.json();
  const errors = payload?.errors || [];
  if (errors.length) {
    throw new Error(errors[0]?.message || "No se pudieron cargar las ordenes repartidor.");
  }

  const nodes = payload?.data?.orders?.edges?.map((edge) => edge?.node).filter(Boolean) || [];
  return nodes
    .filter((orderNode) => {
      const status = String(orderNode?.displayFulfillmentStatus || "").toUpperCase();
      const courierStatus = getCourierRouteStatusFromTags(orderNode?.tags);
      return (
        isCourierLocalDeliveryOrder(orderNode) &&
        !["FULFILLED", "RESTOCKED"].includes(status) &&
        !["recoger_en_sucursal", "reembolsada", "entregado"].includes(courierStatus)
      );
    })
    .map((orderNode) => {
      const shipping = orderNode.shippingAddress || null;
      const billing = orderNode.billingAddress || null;
      const lineItems = (orderNode.lineItems?.edges || []).map(({ node }) => ({
        id: node.id,
        lineItemId: node.id,
        title: String(node.title || "").trim(),
        quantity: Math.max(1, Number(node.quantity || 1)),
        unitPrice: Number(node.originalUnitPriceSet?.shopMoney?.amount || 0),
        currencyCode: String(node.originalUnitPriceSet?.shopMoney?.currencyCode || orderNode.currentTotalPriceSet?.shopMoney?.currencyCode || "MXN"),
        variantId: node.variant?.id || "",
        productId: node.product?.id || "",
        variantSummary: formatVariantSummary(node.variant),
        imageUrl: node.variant?.image?.url || node.product?.featuredImage?.url || "",
        imageAlt: node.variant?.image?.altText || node.product?.featuredImage?.altText || node.title || "",
      }));
      return {
        id: orderNode.id,
        orderNumber: String(orderNode.name || "").replace("#", ""),
        customerName: String(shipping?.name || billing?.name || "Cliente").trim(),
        customerPhone: String(shipping?.phone || billing?.phone || "-").trim() || "-",
        estimatedRefund: Number(orderNode.currentTotalPriceSet?.shopMoney?.amount || 0),
        currencyCode: String(orderNode.currentTotalPriceSet?.shopMoney?.currencyCode || "MXN"),
        pickupDate: getInitialCourierScheduledDate(orderNode),
        pickupAddress: String(shipping?.address1 || "").trim(),
        pickupNeighborhood: String(shipping?.address2 || "").trim(),
        pickupCity: String(shipping?.city || "").trim(),
        pickupState: String(shipping?.province || "").trim(),
        pickupPostalCode: String(shipping?.zip || "").trim(),
        pickupCountry: String(shipping?.country || "Mexico").trim() || "Mexico",
        createdAt: orderNode.createdAt,
        updatedAt: orderNode.updatedAt || orderNode.createdAt,
        status: getCourierRouteStatusFromTags(orderNode.tags),
        items: lineItems,
      };
    })
    .sort((a, b) => courierOrderTimestampMs(a) - courierOrderTimestampMs(b));
}

async function fetchBranchPickupCourierOrders(admin) {
  const response = await admin.graphql(
    `#graphql
    query BranchPickupCourierOrders {
      orders(first: 250, query: "tag:'recoger en sucursal'", sortKey: UPDATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            createdAt
            updatedAt
            displayFulfillmentStatus
            tags
            currentTotalPriceSet {
              shopMoney { amount currencyCode }
            }
            currentSubtotalPriceSet {
              shopMoney { amount currencyCode }
            }
            shippingAddress {
              name
              phone
              address1
              address2
              city
              province
              zip
              country
            }
            billingAddress {
              name
              phone
            }
            customAttributes {
              key
              value
            }
            shippingLines(first: 5) {
              nodes {
                title
                code
                deliveryCategory
              }
            }
            lineItems(first: 100) {
              edges {
                node {
                  id
                  title
                  quantity
                  originalUnitPriceSet {
                    shopMoney { amount currencyCode }
                  }
                  variant {
                    id
                    title
                    selectedOptions {
                      name
                      value
                    }
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
      }
    }`,
  );
  const payload = await response.json();
  const errors = payload?.errors || [];
  if (errors.length) {
    throw new Error(errors[0]?.message || "No se pudieron cargar las ordenes para recoger en sucursal.");
  }

  const nodes = payload?.data?.orders?.edges?.map((edge) => edge?.node).filter(Boolean) || [];
  return nodes
    .filter((orderNode) => {
      const status = String(orderNode?.displayFulfillmentStatus || "").toUpperCase();
      const courierStatus = getCourierRouteStatusFromTags(orderNode?.tags);
      return (
        isCourierLocalDeliveryOrder(orderNode) &&
        !["FULFILLED", "RESTOCKED"].includes(status) &&
        courierStatus === "recoger_en_sucursal"
      );
    })
    .map((orderNode) => {
      const shipping = orderNode.shippingAddress || null;
      const billing = orderNode.billingAddress || null;
      const lineItems = (orderNode.lineItems?.edges || []).map(({ node }) => ({
        id: node.id,
        lineItemId: node.id,
        title: String(node.title || "").trim(),
        quantity: Math.max(1, Number(node.quantity || 1)),
        unitPrice: Number(node.originalUnitPriceSet?.shopMoney?.amount || 0),
        currencyCode: String(node.originalUnitPriceSet?.shopMoney?.currencyCode || "MXN"),
        variantId: node.variant?.id || "",
        productId: node.product?.id || "",
        variantSummary: formatVariantSummary(node.variant),
        imageUrl: node.variant?.image?.url || node.product?.featuredImage?.url || "",
        imageAlt: node.variant?.image?.altText || node.product?.featuredImage?.altText || node.title || "",
      }));
      return {
        id: orderNode.id,
        orderNumber: String(orderNode.name || "").replace("#", ""),
        customerName: String(shipping?.name || billing?.name || "Cliente").trim(),
        customerPhone: String(shipping?.phone || billing?.phone || "-").trim() || "-",
        estimatedRefund: Number(
          orderNode.currentSubtotalPriceSet?.shopMoney?.amount ||
            orderNode.currentTotalPriceSet?.shopMoney?.amount ||
            0,
        ),
        currencyCode: String(orderNode.currentTotalPriceSet?.shopMoney?.currencyCode || "MXN"),
        pickupDate: getInitialCourierScheduledDate(orderNode),
        pickupAddress: String(shipping?.address1 || "").trim(),
        pickupNeighborhood: String(shipping?.address2 || "").trim(),
        pickupCity: String(shipping?.city || "").trim(),
        pickupState: String(shipping?.province || "").trim(),
        pickupPostalCode: String(shipping?.zip || "").trim(),
        pickupCountry: String(shipping?.country || "Mexico").trim() || "Mexico",
        createdAt: orderNode.createdAt,
        updatedAt: orderNode.updatedAt || orderNode.createdAt,
        status: getCourierRouteStatusFromTags(orderNode.tags),
      };
    })
    .sort((a, b) => courierOrderTimestampMs(a) - courierOrderTimestampMs(b));
}

async function fetchCourierHistoryOrders(admin) {
  const response = await admin.graphql(
    `#graphql
    query CourierHistoryOrders {
      orders(first: 250, query: "updated_at:>=2026-06-10", sortKey: UPDATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            createdAt
            updatedAt
            displayFulfillmentStatus
            tags
            shippingAddress {
              name
              phone
              address1
              address2
              city
              province
              zip
              country
            }
            billingAddress {
              name
              phone
            }
            customAttributes {
              key
              value
            }
            shippingLines(first: 5) {
              nodes {
                title
                code
                deliveryCategory
              }
            }
            lineItems(first: 100) {
              edges {
                node {
                  id
                  title
                  quantity
                  originalUnitPriceSet {
                    shopMoney { amount currencyCode }
                  }
                  variant {
                    id
                    title
                    selectedOptions {
                      name
                      value
                    }
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
      }
    }`,
  );
  const payload = await response.json();
  const errors = payload?.errors || [];
  if (errors.length) {
    throw new Error(errors[0]?.message || "No se pudo cargar el historial repartidor.");
  }

  const nodes = payload?.data?.orders?.edges?.map((edge) => edge?.node).filter(Boolean) || [];
  return nodes
    .filter(
      (orderNode) =>
        isCourierLocalDeliveryOrder(orderNode) &&
        ["entregado", "reembolsada"].includes(getCourierRouteStatusFromTags(orderNode?.tags)) &&
        new Date(orderNode.updatedAt || orderNode.createdAt).getTime() >= COURIER_HISTORY_SINCE.getTime(),
    )
    .map((orderNode) => {
      const shipping = orderNode.shippingAddress || null;
      const billing = orderNode.billingAddress || null;
      const lineItems = (orderNode.lineItems?.edges || []).map(({ node }) => ({
        id: node.id,
        lineItemId: node.id,
        title: String(node.title || "").trim(),
        quantity: Math.max(1, Number(node.quantity || 1)),
        unitPrice: Number(node.originalUnitPriceSet?.shopMoney?.amount || 0),
        currencyCode: String(node.originalUnitPriceSet?.shopMoney?.currencyCode || "MXN"),
        variantId: node.variant?.id || "",
        productId: node.product?.id || "",
        variantSummary: formatVariantSummary(node.variant),
        imageUrl: node.variant?.image?.url || node.product?.featuredImage?.url || "",
        imageAlt: node.variant?.image?.altText || node.product?.featuredImage?.altText || node.title || "",
      }));
      return {
        id: orderNode.id,
        orderNumber: String(orderNode.name || "").replace("#", ""),
        customerName: String(shipping?.name || billing?.name || "Cliente").trim(),
        customerPhone: String(shipping?.phone || billing?.phone || "-").trim() || "-",
        pickupDate: getInitialCourierScheduledDate(orderNode),
        pickupAddress: String(shipping?.address1 || "").trim(),
        pickupNeighborhood: String(shipping?.address2 || "").trim(),
        pickupCity: String(shipping?.city || "").trim(),
        pickupState: String(shipping?.province || "").trim(),
        pickupPostalCode: String(shipping?.zip || "").trim(),
        pickupCountry: String(shipping?.country || "Mexico").trim() || "Mexico",
        createdAt: orderNode.createdAt,
        updatedAt: orderNode.updatedAt || orderNode.createdAt,
        status: getCourierRouteStatusFromTags(orderNode.tags),
        items: lineItems,
      };
    });
}

async function fetchPickupCourierHistoryOrders(shop) {
  const settings = await prisma.returnSettings.findUnique({
    where: { shop },
    select: { pickupHours: true },
  });
  const pickupHours = String(settings?.pickupHours || "").trim();
  const requestRows = await prisma.returnRequest.findMany({
    where: {
      shop,
      OR: [
        {
          returnMethod: "pickup",
          status: { in: ["recibida", "rechazada"] },
          updatedAt: { gte: COURIER_HISTORY_SINCE },
        },
        {
          returnMethod: { not: "pickup" },
        },
        {
          status: { in: Array.from(BRANCH_PICKUP_STATUSES) },
        },
      ],
    },
    include: { items: true },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 1000,
  });

  return excludePickupRequestsSupersededByBranch(requestRows).map((requestRow) => ({
    id: `pickup-${requestRow.id}`,
    orderNumber: String(requestRow.orderNumber || "").replace("#", ""),
    customerName: String(requestRow.customerName || "Cliente").trim(),
    customerPhone: String(requestRow.customerPhone || "-").trim() || "-",
    pickupDate: String(requestRow.pickupDate || requestRow.createdAt || "").trim(),
    pickupAddress: String(requestRow.pickupAddress || "").trim(),
    pickupNeighborhood: String(requestRow.pickupNeighborhood || "").trim(),
    pickupCity: String(requestRow.pickupCity || "").trim(),
    pickupState: String(requestRow.pickupState || "").trim(),
    pickupPostalCode: String(requestRow.pickupPostalCode || "").trim(),
    pickupCountry: "Mexico",
    createdAt: requestRow.createdAt,
    updatedAt: requestRow.updatedAt,
    receivedAt: requestRow.receivedAt,
    refundedAt: requestRow.refundedAt,
    rejectionReason: requestRow.rejectionReason,
    pickupHours,
    status: String(requestRow.status || "").trim().toLowerCase(),
  }));
}

async function fetchPickupCourierOrders(shop) {
  const settings = await prisma.returnSettings.findUnique({
    where: { shop },
    select: { pickupHours: true },
  });
  const pickupHours = String(settings?.pickupHours || "").trim();
  const requestRows = await prisma.returnRequest.findMany({
    where: {
      shop,
      OR: [
        {
          returnMethod: "pickup",
          status: { in: Array.from(METHOD_QUEUE_STATUSES) },
        },
        {
          returnMethod: { not: "pickup" },
        },
        {
          status: { in: Array.from(BRANCH_PICKUP_STATUSES) },
        },
      ],
    },
    select: {
      id: true,
      shopifyOrderId: true,
      orderNumber: true,
      returnMethod: true,
      customerName: true,
      customerPhone: true,
      pickupDate: true,
      pickupAddress: true,
      pickupNeighborhood: true,
      pickupCity: true,
      pickupState: true,
      pickupPostalCode: true,
      createdAt: true,
      updatedAt: true,
      status: true,
      rejectionReason: true,
      items: {
        select: {
          lineItemId: true,
          productId: true,
          variantId: true,
          title: true,
          quantity: true,
        },
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 1000,
  });

  return excludePickupRequestsSupersededByBranch(requestRows)
    .map((requestRow) => ({
    id: `pickup-${requestRow.id}`,
    orderNumber: String(requestRow.orderNumber || "").replace("#", ""),
    customerName: String(requestRow.customerName || "Cliente").trim(),
    customerPhone: String(requestRow.customerPhone || "-").trim() || "-",
    pickupDate: String(requestRow.pickupDate || requestRow.createdAt || "").trim(),
    pickupAddress: String(requestRow.pickupAddress || "").trim(),
    pickupNeighborhood: String(requestRow.pickupNeighborhood || "").trim(),
    pickupCity: String(requestRow.pickupCity || "").trim(),
    pickupState: String(requestRow.pickupState || "").trim(),
    pickupPostalCode: String(requestRow.pickupPostalCode || "").trim(),
    pickupCountry: "Mexico",
    createdAt: requestRow.createdAt,
    updatedAt: requestRow.updatedAt,
    rejectionReason: requestRow.rejectionReason,
    pickupHours,
    status: String(requestRow.status || "pendiente").trim() || "pendiente",
    }))
    .sort((a, b) => courierOrderTimestampMs(a) - courierOrderTimestampMs(b));
}

function courierOrderTimestampMs(request) {
  const date =
    parseCourierDate(request?.pickupDate) ||
    parseCourierDate(request?.updatedAt) ||
    parseCourierDate(request?.createdAt);
  return date ? date.getTime() : 0;
}

function formatCourierScheduledDate(pickupDate) {
  const date = parseCourierDate(pickupDate);
  if (!date) return "-";

  const parts = new Intl.DateTimeFormat("es-MX", {
    weekday: "short",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = String(lookup.weekday || "").replace(/\./g, "").toLowerCase();
  const day = String(lookup.day || "").trim();
  const month = String(lookup.month || "").toLowerCase();
  const year = String(lookup.year || "").trim();
  return [weekday, day, month, year].filter(Boolean).join(" ");
}

function branchPickupDeadlineSourceDate(request, displayedScheduledDate) {
  const branchEvent = [
    ...(Array.isArray(request?.historyEvents) ? request.historyEvents : []),
    ...(Array.isArray(request?.branchPickupHistoryEvents) ? request.branchPickupHistoryEvents : []),
    ...(Array.isArray(request?.unfilteredHistoryEvents) ? request.unfilteredHistoryEvents : []),
  ]
    .filter((event) => String(event?.status || "").trim().toLowerCase() === "recoger_en_sucursal")
    .sort((firstEvent, secondEvent) => parseEventMs(secondEvent?.at) - parseEventMs(firstEvent?.at))[0];
  return (
    parseCourierDate(branchEvent?.at) ||
    parseCourierDate(displayedScheduledDate) ||
    parseCourierDate(request?.updatedAt) ||
    parseCourierDate(request?.createdAt)
  );
}

function branchPickupDeadlineLabelFromEvents(request) {
  const branchEvent = [
    ...(Array.isArray(request?.historyEvents) ? request.historyEvents : []),
    ...(Array.isArray(request?.branchPickupHistoryEvents) ? request.branchPickupHistoryEvents : []),
    ...(Array.isArray(request?.unfilteredHistoryEvents) ? request.unfilteredHistoryEvents : []),
  ]
    .filter((event) => String(event?.status || "").trim().toLowerCase() === "recoger_en_sucursal")
    .sort((firstEvent, secondEvent) => parseEventMs(secondEvent?.at) - parseEventMs(firstEvent?.at))[0];
  const note = String(branchEvent?.note || "");
  return note.match(/branch_pickup_deadline_label:([^;\n]+)/i)?.[1]?.trim() || "";
}

function branchPickupDeadlineFromValue(request) {
  return parseCourierDate(request?.branchPickupDeadlineAt) || parseCourierDate(request?.pickupDeadlineAt);
}

function formatBranchPickupDeadlineDate(request, displayedScheduledDate) {
  const persistedDeadlineLabel = branchPickupDeadlineLabelFromEvents(request);
  if (persistedDeadlineLabel) return persistedDeadlineLabel;
  const directDeadlineDate = branchPickupDeadlineFromValue(request);
  if (directDeadlineDate) return formatCourierScheduledDate(directDeadlineDate.toISOString());
  const sourceDate = branchPickupDeadlineSourceDate(request, displayedScheduledDate);
  if (!sourceDate) return "-";
  const deadlineDate = new Date(sourceDate);
  deadlineDate.setDate(deadlineDate.getDate() + 30);
  return formatCourierScheduledDate(deadlineDate.toISOString());
}

function branchPickupDeadlineDateValue(request, displayedScheduledDate) {
  const directDeadlineDate = branchPickupDeadlineFromValue(request);
  if (directDeadlineDate) {
    directDeadlineDate.setHours(23, 59, 59, 999);
    return directDeadlineDate;
  }
  const sourceDate = branchPickupDeadlineSourceDate(request, displayedScheduledDate);
  if (!sourceDate) return null;
  const deadlineDate = new Date(sourceDate);
  deadlineDate.setDate(deadlineDate.getDate() + 30);
  deadlineDate.setHours(23, 59, 59, 999);
  return deadlineDate;
}

function isBranchPickupDeadlineExpired(request, displayedScheduledDate) {
  const deadlineDate = branchPickupDeadlineDateValue(request, displayedScheduledDate);
  return Boolean(deadlineDate) && Date.now() > deadlineDate.getTime();
}

function formatCourierAddress(request) {
  const parts = [
    request?.pickupAddress,
    request?.pickupNeighborhood,
    request?.pickupCity,
    request?.pickupState,
    request?.pickupPostalCode,
    request?.pickupCountry || "Mexico",
  ]
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(", ") : "-";
}

function historyTimestampMs(request) {
  const status = String(request?.status || "").toLowerCase();
  const sourceDate =
    status === "reembolsada" && request?.refundedAt ? request.refundedAt : request?.updatedAt || request?.createdAt;
  const ms = new Date(sourceDate).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export default function ReturnsRequests() {
  const {
    requests,
    courierOrders,
    couriers = [],
    preparers = [],
    preparerAssignments = [],
    courierActivities = [],
    courierRouteSnapshots = [],
    plannedCourierRoutes = [],
    viewMode,
    shop,
  } = useLoaderData();
  const actionData = useActionData();
  const courierRouteFetcher = useFetcher();
  const branchPickupDeliveryFetcher = useFetcher();
  const branchPickupRefundFetcher = useFetcher();
  const branchDeliveryExpirationFetcher = useFetcher();
  const navigation = useNavigation();
  const location = useLocation();
  const isSubmitting = navigation.state === "submitting";
  const isBranchPickupDeliverySubmitting = branchPickupDeliveryFetcher.state !== "idle";
  const isBranchPickupRefundSubmitting = branchPickupRefundFetcher.state !== "idle";
  const isCourierRouteSubmitting = courierRouteFetcher.state !== "idle";
  const [showCourierRouteModal, setShowCourierRouteModal] = useState(false);
  const [showCourierMoreActions, setShowCourierMoreActions] = useState(false);
  const [selectedCourierIds, setSelectedCourierIds] = useState([]);
  const [courierBulkMode, setCourierBulkMode] = useState("");
  const [selectedCourierBulkOrderIds, setSelectedCourierBulkOrderIds] = useState([]);
  const [courierRefundRequest, setCourierRefundRequest] = useState(null);
  const [selectedCourierRefundUnitKeys, setSelectedCourierRefundUnitKeys] = useState([]);
  const [showOnlyNotLocatedCourierOrders, setShowOnlyNotLocatedCourierOrders] = useState(false);
  const [branchPickupDeliveryRequest, setBranchPickupDeliveryRequest] = useState(null);
  const [branchPickupDeliveryCode, setBranchPickupDeliveryCode] = useState("");
  const [branchPickupRefundRequest, setBranchPickupRefundRequest] = useState(null);
  const [branchPickupRefundTestMode, setBranchPickupRefundTestMode] = useState(false);
  const [notReturnedTestMode, setNotReturnedTestMode] = useState(false);
  const isExpiringBranchDeliveryRequests = branchDeliveryExpirationFetcher.state !== "idle";
  const selectedCourierIdSet = new Set(selectedCourierIds.map((courierId) => String(courierId)));
  const selectedCourierBulkOrderIdSet = new Set(selectedCourierBulkOrderIds.map((orderId) => String(orderId)));
  const selectedCourierBulkOrders = courierOrders.filter((order) =>
    selectedCourierBulkOrderIdSet.has(String(order.id || "")),
  );
  const selectedCourierBulkTotal = selectedCourierBulkOrders.reduce(
    (sum, order) => sum + Number(order.estimatedRefund || 0),
    0,
  );
  const selectedCourierBulkCurrency = selectedCourierBulkOrders[0]?.currencyCode || "MXN";
  const courierRefundItems = Array.isArray(courierRefundRequest?.items) ? courierRefundRequest.items : [];
  const preparerMissingCourierRefundUnitKeySet = preparerMissingUnitKeySetFromOrder(courierRefundRequest || {});
  const courierRefundUnitItems = courierRefundItems.flatMap((item) => {
    const quantity = Math.max(1, Number(item.quantity || 1));
    return Array.from({ length: quantity }, (_value, index) => ({
      ...item,
      quantity: 1,
      unitIndex: index + 1,
      unitKey: courierRefundUnitKeyFromItem(item, index),
      preparerMissing: preparerMissingCourierRefundUnitKeySet.has(courierRefundUnitKeyFromItem(item, index)),
    }));
  });
  const alreadyRefundedCourierUnitKeySet = courierRefundedUnitKeySetFromActivities(
    courierRefundRequest?.courierActivities || [],
  );
  const availableCourierRefundUnitItems = courierRefundUnitItems.filter(
    (item) => !alreadyRefundedCourierUnitKeySet.has(String(item.unitKey || "")),
  );
  const selectedCourierRefundUnitKeySet = new Set(
    selectedCourierRefundUnitKeys.map((unitKey) => String(unitKey)),
  );
  const selectedCourierRefundItems = availableCourierRefundUnitItems.filter((item) =>
    selectedCourierRefundUnitKeySet.has(String(item.unitKey || "")),
  );
  const selectedCourierRefundSubtotal = selectedCourierRefundItems.reduce(
    (sum, item) => sum + Number(item.unitPrice || 0),
    0,
  );
  const selectedCourierRefundIsFull =
    courierRefundUnitItems.length > 0 &&
    alreadyRefundedCourierUnitKeySet.size === 0 &&
    selectedCourierRefundUnitKeys.length === courierRefundUnitItems.length;
  const selectedCourierRefundTotal = selectedCourierRefundIsFull
    ? Number(courierRefundRequest?.estimatedRefund || selectedCourierRefundSubtotal || 0)
    : selectedCourierRefundSubtotal;
  const selectedCourierRefundCurrency =
    courierRefundRequest?.currencyCode || selectedCourierRefundItems[0]?.currencyCode || "MXN";
  const canConfirmCourierRoutePlan =
    selectedCourierIds.length > 0 && courierOrders.length > 0 && !isSubmitting && !isCourierRouteSubmitting;
  const canConfirmCourierBulkAction =
    selectedCourierBulkOrderIds.length > 0 && !isSubmitting && !isCourierRouteSubmitting;
  const notLocatedCourierOrders = courierOrders.filter(
    (order) => String(order.status || "").trim().toLowerCase() === "no_localizado",
  );
  const courierDeliveryOrders = courierOrders.filter((order) => !isReturnCourierLabel(order.courierLabel));
  const courierReturnOrders = courierOrders.filter((order) => isReturnCourierLabel(order.courierLabel));
  const visibleCourierOrders = showOnlyNotLocatedCourierOrders ? notLocatedCourierOrders : courierOrders;
  const courierRouteActionData = courierRouteFetcher.data || null;
  const branchPickupDeliveryActionData = branchPickupDeliveryFetcher.data || null;
  const branchPickupRefundActionData = branchPickupRefundFetcher.data || null;
  const pageErrorMessage =
    branchPickupDeliveryActionData?.error ||
    branchPickupRefundActionData?.error ||
    courierRouteActionData?.error ||
    actionData?.error ||
    "";
  const pageSuccessMessage =
    branchPickupDeliveryActionData?.message ||
    branchPickupRefundActionData?.message ||
    courierRouteActionData?.message ||
    actionData?.message ||
    "";
  const [visiblePageSuccessMessage, setVisiblePageSuccessMessage] = useState("");
  const [visibleRefundCardSuccess, setVisibleRefundCardSuccess] = useState(null);
  const [visibleCourierCardSuccessMessages, setVisibleCourierCardSuccessMessages] = useState({});
  const refundSuccessTimeoutRef = useRef(null);
  const courierCardSuccessTimeoutRef = useRef(null);

  const showRefundActionSuccess = (requestId, message) => {
    if (refundSuccessTimeoutRef.current) {
      window.clearTimeout(refundSuccessTimeoutRef.current);
    }
    setVisiblePageSuccessMessage("");
    setVisibleRefundCardSuccess({
      requestId: String(requestId || ""),
      message: String(message || "").trim(),
    });
    refundSuccessTimeoutRef.current = window.setTimeout(() => {
      setVisibleRefundCardSuccess(null);
      refundSuccessTimeoutRef.current = null;
    }, 4000);
  };

  const showCourierCardActionSuccess = (requestIds, message) => {
    const cleanRequestIds = (Array.isArray(requestIds) ? requestIds : [requestIds])
      .map((requestId) => String(requestId || "").trim())
      .filter(Boolean);
    if (!cleanRequestIds.length || !message) return;
    if (courierCardSuccessTimeoutRef.current) {
      window.clearTimeout(courierCardSuccessTimeoutRef.current);
    }
    const nextMessages = {};
    for (const requestId of cleanRequestIds) {
      nextMessages[requestId] = String(message || "").trim();
    }
    setVisiblePageSuccessMessage("");
    setVisibleCourierCardSuccessMessages(nextMessages);
    courierCardSuccessTimeoutRef.current = window.setTimeout(() => {
      setVisibleCourierCardSuccessMessages({});
      courierCardSuccessTimeoutRef.current = null;
    }, 4000);
  };

  useEffect(() => {
    return () => {
      if (refundSuccessTimeoutRef.current) {
        window.clearTimeout(refundSuccessTimeoutRef.current);
      }
      if (courierCardSuccessTimeoutRef.current) {
        window.clearTimeout(courierCardSuccessTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (actionData?.ok || courierRouteActionData?.ok || branchPickupDeliveryActionData?.ok || branchPickupRefundActionData?.ok) {
      setShowCourierRouteModal(false);
      setSelectedCourierIds([]);
    }
    if (courierRouteActionData?.ok && courierRouteActionData?.courierBulkAction) {
      setCourierBulkMode("");
      setSelectedCourierBulkOrderIds([]);
      setCourierRefundRequest(null);
      setSelectedCourierRefundUnitKeys([]);
      setShowCourierMoreActions(false);
    }
    if (
      (actionData?.ok && actionData?.deliveredRequestId) ||
      (branchPickupDeliveryActionData?.ok && branchPickupDeliveryActionData?.deliveredRequestId)
    ) {
      setBranchPickupDeliveryRequest(null);
      setBranchPickupDeliveryCode("");
    }
    if (
      (actionData?.ok && actionData?.refundedBranchPickupRequestId) ||
      (branchPickupRefundActionData?.ok && branchPickupRefundActionData?.refundedBranchPickupRequestId)
    ) {
      setBranchPickupRefundRequest(null);
    }
  }, [actionData, courierRouteActionData, branchPickupDeliveryActionData, branchPickupRefundActionData]);

  useEffect(() => {
    if (showOnlyNotLocatedCourierOrders && notLocatedCourierOrders.length === 0) {
      setShowOnlyNotLocatedCourierOrders(false);
    }
  }, [showOnlyNotLocatedCourierOrders, notLocatedCourierOrders.length]);

  useEffect(() => {
    if (!pageSuccessMessage) return;
    if (actionData?.ok && (actionData?.refundActionRequestId || actionData?.returnToCustomerActionRequestId)) {
      showRefundActionSuccess(
        actionData.refundActionRequestId || actionData.returnToCustomerActionRequestId,
        pageSuccessMessage,
      );
      return;
    }
    if (
      courierRouteActionData?.ok &&
      courierRouteActionData?.courierBulkAction &&
      Array.isArray(courierRouteActionData?.courierBulkRequestIds)
    ) {
      showCourierCardActionSuccess(courierRouteActionData.courierBulkRequestIds, pageSuccessMessage);
      return;
    }
    setVisiblePageSuccessMessage(pageSuccessMessage);
    const timeoutId = window.setTimeout(() => setVisiblePageSuccessMessage(""), 4000);
    return () => window.clearTimeout(timeoutId);
  }, [pageSuccessMessage, actionData, courierRouteActionData]);

  const reviewRequests = requests.filter(
    (requestRow) => String(requestRow.status || "").toLowerCase() === "en_revision",
  );
  const activeRequests = requests.filter((requestRow) => {
    const status = String(requestRow.status || "").toLowerCase();
    return METHOD_QUEUE_STATUSES.has(status);
  });
  const refundQueueRequests = requests.filter((requestRow) =>
    REFUND_QUEUE_STATUSES.has(String(requestRow.status || "").toLowerCase()),
  );
  const hasVisibleRefundSuccessCard =
    Boolean(visibleRefundCardSuccess?.requestId) &&
    refundQueueRequests.some((requestRow) => String(requestRow.id) === visibleRefundCardSuccess.requestId);
  const visibleRefundSectionSuccessMessage =
    visibleRefundCardSuccess && !hasVisibleRefundSuccessCard ? visibleRefundCardSuccess.message : "";
  const returnToCustomerQueueRequests = requests
    .filter((requestRow) => RETURN_TO_CUSTOMER_STATUSES.has(String(requestRow.status || "").toLowerCase()))
    .sort((a, b) => {
      const bMs = new Date(b.returnToCustomerSortAt || b.updatedAt || b.createdAt || 0).getTime();
      const aMs = new Date(a.returnToCustomerSortAt || a.updatedAt || a.createdAt || 0).getTime();
      return (Number.isFinite(bMs) ? bMs : 0) - (Number.isFinite(aMs) ? aMs : 0);
    });
  const pickupRequests = activeRequests.filter((request) => request.returnMethod === "pickup");
  const branchRequests = activeRequests.filter((request) => request.returnMethod !== "pickup");
  const historyRequests = requests
    .filter((requestRow) => HISTORY_STATUSES.has(String(requestRow.status || "").toLowerCase()))
    .sort((a, b) => historyTimestampMs(b) - historyTimestampMs(a));
  const pickupGroups = buildPickupGroups(pickupRequests);
  const courierRouteSearchParams = new URLSearchParams(location.search);
  const selectedRouteCourierId = Number(courierRouteSearchParams.get("routeCourierId") || 0);
  const selectedRouteId = String(courierRouteSearchParams.get("routeId") || "").trim();
  const selectedCourierRoutePlan =
    selectedRouteCourierId && selectedRouteId
      ? plannedCourierRoutes.find(
          (plan) =>
            Number(plan.courierId) === selectedRouteCourierId &&
            String(plan.routeId || "") === selectedRouteId,
        )
      : null;
  const selectedCourierRouteCourier = selectedCourierRoutePlan
    ? couriers.find((courier) => Number(courier.id) === Number(selectedCourierRoutePlan.courierId))
    : null;
  const selectedCourierRouteRequestIds = new Set(
    (selectedCourierRoutePlan?.requestIds || []).map((requestId) => String(requestId)),
  );
  const selectedCourierRouteOrderNumbers = new Set(
    (selectedCourierRoutePlan?.orderNumbers || []).map((orderNumber) => String(orderNumber)),
  );
  const selectedCourierRouteOrders = selectedCourierRoutePlan
    ? courierOrders.filter(
        (order) =>
          selectedCourierRouteRequestIds.has(String(order.id || "")) ||
          selectedCourierRouteOrderNumbers.has(String(order.orderNumber || "")),
      )
    : [];
  const buildCourierRouteHref = ({ courierId = "", routeId = "" } = {}) => {
    const nextParams = new URLSearchParams(location.search);
    if (courierId && routeId) {
      nextParams.set("routeCourierId", String(courierId));
      nextParams.set("routeId", String(routeId));
    } else {
      nextParams.delete("routeCourierId");
      nextParams.delete("routeId");
    }
    const query = nextParams.toString();
    return query ? `${location.pathname}?${query}` : location.pathname;
  };
  const courierRouteOrdersPayload = courierOrders.map((order, index) => ({
    id: order.id,
    orderNumber: order.orderNumber,
    courierLabel: order.courierLabel,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    pickupDate: order.pickupDate,
    pickupAddress: order.pickupAddress,
    pickupNeighborhood: order.pickupNeighborhood,
    pickupCity: order.pickupCity,
    pickupState: order.pickupState,
    pickupPostalCode: order.pickupPostalCode,
    pickupCountry: order.pickupCountry,
    estimatedRefund: order.estimatedRefund,
    currencyCode: order.currencyCode,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    status: order.status,
    sequenceNumber: Number(order.sequenceNumber || 0) || index + 1,
    attemptCount: order.attemptCount,
    items: order.items || [],
  }));
  const preparerCourierOrders = courierDeliveryOrders;
  const preparerRouteOrdersPayload = courierRouteOrdersPayload.filter((order) => !isReturnCourierLabel(order.courierLabel));

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
        : viewMode === VIEW_MODE.COURIER
          ? "Ordenes repartidor"
        : viewMode === VIEW_MODE.COURIER_HISTORY
          ? "Historial repartidor"
        : viewMode === VIEW_MODE.BRANCH_PICKUP
          ? "Recoger en sucursal"
        : viewMode === VIEW_MODE.COURIERS
          ? "Repartidores"
        : viewMode === VIEW_MODE.PREPARERS
          ? "Preparadores"
        : "Entrega en sucursal";

  return (
    <s-page heading={pageHeading}>
      {pageErrorMessage ? <p className={styles.errorMsg}>{pageErrorMessage}</p> : null}
      {visiblePageSuccessMessage && !visibleRefundCardSuccess ? (
        <p className={styles.successMsg}>{visiblePageSuccessMessage}</p>
      ) : null}

      {viewMode === VIEW_MODE.BRANCH ? (
        <s-section heading="Entregas en sucursal">
          <div className={styles.branchPickupTestHeader}>
            <branchDeliveryExpirationFetcher.Form method="post">
              <input type="hidden" name="intent" value="expire_branch_delivery_requests" />
              <label className={styles.branchPickupTestSwitch}>
                <input
                  type="checkbox"
                  checked={isExpiringBranchDeliveryRequests}
                  disabled={isExpiringBranchDeliveryRequests || branchRequests.length === 0}
                  onChange={(event) => {
                    if (event.target.checked) event.currentTarget.form?.requestSubmit();
                  }}
                />
                <span className={styles.branchPickupTestSlider} aria-hidden="true" />
                Vencio el tiempo
              </label>
            </branchDeliveryExpirationFetcher.Form>
          </div>
          {branchRequests.length === 0 ? (
            <p>No hay solicitudes de entrega en sucursal.</p>
          ) : (
            <div className={`${styles.wrap} ${styles.reqGrid}`}>
              {branchRequests.map((request) => (
                <RequestCard
                  key={request.id}
                  request={request}
                  isSubmitting={isSubmitting}
                  enableLazyMedia
                  useRefundQueueDateFormat
                />
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
                      <RequestCard
                        key={request.id}
                        request={request}
                        isSubmitting={isSubmitting}
                        enableLazyMedia
                        hideCourierProgress
                        hideInRouteAction
                        hidePickupActions
                        showPickupRescheduleStatus
                        showPickupDateSummary
                        useRefundQueueDateFormat
                        useRefundQueueDateTimeSummary
                      />
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
          {visibleRefundSectionSuccessMessage ? (
            <p className={styles.successMsg}>{visibleRefundSectionSuccessMessage}</p>
          ) : null}
          {refundQueueRequests.length === 0 ? (
            <p>No hay solicitudes listas para procesar reembolsos.</p>
          ) : (
            <div className={`${styles.wrap} ${styles.reqGrid}`}>
              {refundQueueRequests.map((request) => (
                <RequestCard
                  key={request.id}
                  request={request}
                  isSubmitting={isSubmitting}
                  hideCourierRouteStarts
                  useRefundQueueDateFormat
                  cardSuccessMessage={
                    visibleRefundCardSuccess?.requestId === String(request.id)
                      ? visibleRefundCardSuccess.message
                      : ""
                  }
                  onRefundActionSuccess={showRefundActionSuccess}
                />
              ))}
            </div>
          )}
        </s-section>
      ) : null}

      {viewMode === VIEW_MODE.TO_RETURN ? (
        <s-section heading="Solicitudes pendientes por recoger en sucursal">
          <div className={styles.branchPickupTestHeader}>
            <label className={styles.branchPickupTestSwitch}>
              <input
                type="checkbox"
                checked={notReturnedTestMode}
                onChange={(event) => setNotReturnedTestMode(event.target.checked)}
              />
              <span className={styles.branchPickupTestSlider} aria-hidden="true" />
              Modo prueba No devuelto
            </label>
          </div>
          {returnToCustomerQueueRequests.length === 0 ? (
            <p>No hay solicitudes pendientes por recoger.</p>
          ) : (
            <div className={`${styles.wrap} ${styles.reqGrid}`}>
              {returnToCustomerQueueRequests.map((request) => (
                <RequestCard
                  key={request.id}
                  request={request}
                  isSubmitting={isSubmitting}
                  hideCourierRouteStarts
                  hidePendingReturnStatus
                  forceShowNotReturnedAction={notReturnedTestMode}
                  useRefundQueueDateFormat
                  cardSuccessMessage={
                    visibleRefundCardSuccess?.requestId === String(request.id)
                      ? visibleRefundCardSuccess.message
                      : ""
                  }
                  onRefundActionSuccess={showRefundActionSuccess}
                />
              ))}
            </div>
          )}
        </s-section>
      ) : null}

      {viewMode === VIEW_MODE.HISTORY ? (
        <>
          <s-section heading="Historial de devoluciones">
            {historyRequests.length === 0 ? (
              <p>No hay ordenes en historial.</p>
            ) : (
              <div className={`${styles.wrap} ${styles.reqGrid}`}>
                {historyRequests.map((request) => (
                  <RequestCard
                    key={request.id}
                    request={request}
                    isSubmitting={isSubmitting}
                    enableLazyMedia
                    hideCourierProgress
                    useRefundQueueDateFormat
                    useRefundQueueDateTimeSummary
                  />
                ))}
              </div>
            )}
          </s-section>
        </>
      ) : null}

      {viewMode === VIEW_MODE.COURIER ? (
        <s-section heading="Ordenes repartidor">
          {selectedCourierRoutePlan ? (
            <div className={styles.courierRouteDetail}>
              <Link className={styles.courierHistoryBackLink} to={buildCourierRouteHref()}>
                ← Regresar
              </Link>
              <div className={styles.courierHistoryHeader}>
                <div>
                  <h3>{selectedCourierRouteCourier?.name || "Repartidor"}</h3>
                  <p className={styles.courierHistoryDateTitle}>
                    Ordenes asignadas: {selectedCourierRouteOrders.length}
                  </p>
                </div>
              </div>
              {selectedCourierRouteOrders.length ? (
                <div className={styles.courierGrid}>
                  {selectedCourierRouteOrders.map((request) => (
                    <CourierOrderCard
                      key={`${selectedCourierRoutePlan.routeId}-${request.id}`}
                      request={request}
                      sequenceNumber={Number(request.sequenceNumber || 0)}
                      adminCourierView
                      hideTransferredCourierBadge
                    />
                  ))}
                </div>
              ) : (
                <p>No se encontraron ordenes en esta ruta.</p>
              )}
            </div>
          ) : (
            <>
              <div className={styles.courierOrdersHeader}>
                <div>
                  <div className={styles.courierOrdersCountGroup}>
                    <span className={styles.courierOrdersCount}>Numero de ordenes de entrega: {courierDeliveryOrders.length}</span>
                    <span className={styles.courierOrdersCount}>Numero de devoluciones: {courierReturnOrders.length}</span>
                  </div>
                  {plannedCourierRoutes.length ? (
                    <div className={styles.courierRoutePlanSummary}>
                      {plannedCourierRoutes.map((plan) => {
                        const courier = couriers.find((item) => Number(item.id) === Number(plan.courierId));
                        return (
                          <Link
                            key={plan.routeId}
                            className={styles.courierRoutePlanBadge}
                            to={buildCourierRouteHref({ courierId: plan.courierId, routeId: plan.routeId })}
                          >
                            {courier?.name || "Repartidor"}: {plan.count} orden(es)
                          </Link>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
                <div className={styles.courierOrdersActions}>
                  <div className={styles.courierMoreActions}>
                    <button
                      className={`${styles.btn} ${styles.courierMoreActionsButton}`}
                      type="button"
                      aria-expanded={showCourierMoreActions}
                      onClick={() => setShowCourierMoreActions((current) => !current)}
                    >
                      Más acciones
                    </button>
                    {showCourierMoreActions ? (
                      <div className={styles.courierMoreActionsMenu}>
                        <button
                          className={`${styles.btn} ${styles.courierMoreActionRefund}`}
                          type="button"
                          onClick={() => {
                            setCourierBulkMode("refund");
                            setSelectedCourierBulkOrderIds([]);
                            setShowCourierMoreActions(false);
                          }}
                        >
                          Reembolsar
                        </button>
                        <button
                          className={`${styles.btn} ${styles.courierMoreActionReprogram}`}
                          type="button"
                          onClick={() => {
                            setCourierBulkMode("reprogram");
                            setSelectedCourierBulkOrderIds([]);
                            setShowCourierMoreActions(false);
                          }}
                        >
                          Reprogramar
                        </button>
                      </div>
                    ) : null}
                  </div>
                  {notLocatedCourierOrders.length > 0 ? (
                    <button
                      className={`${styles.btn} ${styles.courierNotLocatedFilterButton} ${
                        showOnlyNotLocatedCourierOrders ? styles.courierNotLocatedFilterButtonActive : ""
                      }`}
                      type="button"
                      aria-pressed={showOnlyNotLocatedCourierOrders}
                      onClick={() => {
                        setShowOnlyNotLocatedCourierOrders((current) => !current);
                        setCourierBulkMode("");
                        setSelectedCourierBulkOrderIds([]);
                        setCourierRefundRequest(null);
                        setSelectedCourierRefundUnitKeys([]);
                      }}
                    >
                      No localizados ({notLocatedCourierOrders.length})
                    </button>
                  ) : null}
                  <button
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    type="button"
                    disabled={isSubmitting || couriers.length === 0 || courierOrders.length === 0}
                    onClick={() => {
                      setCourierBulkMode("");
                      setSelectedCourierBulkOrderIds([]);
                      setCourierRefundRequest(null);
                      setSelectedCourierRefundUnitKeys([]);
                      setSelectedCourierIds([]);
                      setShowCourierRouteModal(true);
                    }}
                  >
                    Distribuir rutas automaticamente
                  </button>
                </div>
              </div>
              {courierBulkMode ? (
                <courierRouteFetcher.Form
                  method="post"
                  action={buildCourierRouteHref()}
                  className={styles.courierBulkActionBar}
                  onSubmit={(event) => {
                    if (courierBulkMode === "refund") {
                      event.preventDefault();
                      return;
                    }
                    if (!selectedCourierBulkOrderIds.length) {
                      event.preventDefault();
                      return;
                    }
                    const orderLabel =
                      selectedCourierBulkOrders.length === 1
                        ? `la orden #${selectedCourierBulkOrders[0]?.orderNumber || ""}`
                        : `${selectedCourierBulkOrders.length} ordenes`;
                    const message =
                      courierBulkMode === "refund"
                        ? `¿Quieres reembolsar ${orderLabel} por la cantidad de ${toMoney(
                            selectedCourierBulkTotal,
                          )} ${selectedCourierBulkCurrency}, incluyendo envio?`
                        : `¿Quieres reprogramar ${orderLabel} para el dia siguiente de su fecha programada?`;
                    if (!window.confirm(message)) {
                      event.preventDefault();
                    }
                  }}
                >
                  {courierBulkMode === "reprogram" ? (
                    <>
                      <input type="hidden" name="intent" value="courier_bulk_reprogram" />
                      <input type="hidden" name="routeOrdersJson" value={JSON.stringify(courierRouteOrdersPayload)} />
                      {selectedCourierBulkOrderIds.map((orderId) => (
                        <input key={orderId} type="hidden" name="courierBulkOrderIds" value={orderId} />
                      ))}
                    </>
                  ) : null}
                  <span className={styles.courierBulkActionText}>
                    {courierBulkMode === "refund"
                      ? "Reembolsar: selecciona una orden"
                      : `Reprogramar: ${selectedCourierBulkOrderIds.length} seleccionada(s)`}
                  </span>
                  <div className={styles.courierBulkActionControls}>
                    <button
                      className={styles.btn}
                      type="button"
                      disabled={isSubmitting || isCourierRouteSubmitting}
                      onClick={() => {
                        setCourierBulkMode("");
                        setSelectedCourierBulkOrderIds([]);
                        setCourierRefundRequest(null);
                        setSelectedCourierRefundUnitKeys([]);
                      }}
                    >
                      Cancelar
                    </button>
                    {courierBulkMode === "reprogram" ? (
                      <button
                        className={`${styles.btn} ${styles.btnPrimary}`}
                        type="submit"
                        disabled={!canConfirmCourierBulkAction}
                      >
                        Confirmar
                      </button>
                    ) : null}
                  </div>
                </courierRouteFetcher.Form>
              ) : null}
            </>
          )}
          {showCourierRouteModal ? (
            <div className={styles.courierRouteModalBackdrop} role="presentation">
              <div
                className={styles.courierRouteModal}
                role="dialog"
                aria-modal="true"
                aria-labelledby="courier-route-modal-title"
              >
                <div className={styles.courierRouteModalHeader}>
                  <h3 id="courier-route-modal-title">Selecciona repartidores</h3>
                  <button
                    className={styles.courierRouteModalClose}
                    type="button"
                    aria-label="Cerrar"
                    onClick={() => setShowCourierRouteModal(false)}
                  >
                    x
                  </button>
                </div>
                <p className={styles.courierRouteModalText}>
                  Marca los repartidores que recibiran las rutas pendientes.
                </p>
                <courierRouteFetcher.Form
                  method="post"
                  action={buildCourierRouteHref()}
                  className={styles.courierRouteModalForm}
                >
                  <input type="hidden" name="intent" value="plan_courier_routes" />
                  <input
                    type="hidden"
                    name="routeOrdersJson"
                    value={JSON.stringify(courierRouteOrdersPayload)}
                  />
                  {courierOrders.map((order) => (
                    <input key={order.id} type="hidden" name="routeOrderIds" value={String(order.id || "")} />
                  ))}
                  <div className={styles.courierRouteCourierList}>
                    {couriers.map((courier) => {
                      const courierId = String(courier.id);
                      const isChecked = selectedCourierIdSet.has(courierId);
                      return (
                        <label key={courier.id} className={styles.courierRouteCourierOption}>
                          <input
                            type="checkbox"
                            name="courierIds"
                            value={courierId}
                            checked={isChecked}
                            onChange={(event) => {
                              setSelectedCourierIds((currentIds) =>
                                event.target.checked
                                  ? [...currentIds, courierId]
                                  : currentIds.filter((currentId) => String(currentId) !== courierId),
                              );
                            }}
                          />
                          <span>{courier.name}</span>
                        </label>
                      );
                    })}
                  </div>
                  <div className={styles.courierRouteModalActions}>
                    <button
                      className={styles.btn}
                      type="button"
                      onClick={() => setShowCourierRouteModal(false)}
                      disabled={isSubmitting || isCourierRouteSubmitting}
                    >
                      Cancelar
                    </button>
                    <button
                      className={`${styles.btn} ${styles.btnPrimary}`}
                      type="submit"
                      disabled={!canConfirmCourierRoutePlan}
                    >
                      Confirmar distribucion
                    </button>
                  </div>
                </courierRouteFetcher.Form>
              </div>
            </div>
          ) : null}
          {!selectedCourierRoutePlan && visibleCourierOrders.length === 0 ? (
            <p>No hay ordenes pendientes por entregar.</p>
          ) : !selectedCourierRoutePlan ? (
            <div className={styles.courierGrid}>
              {visibleCourierOrders.map((request) => {
                const requestId = String(request.id || "");
                const isBulkSelected = selectedCourierBulkOrderIdSet.has(requestId);
                return (
                  <div
                    key={request.id}
                    className={`${styles.courierBulkSelectable} ${
                      isBulkSelected ? styles.courierBulkSelectableSelected : ""
                    }`}
                  >
                    {courierBulkMode ? (
                      <label className={styles.courierBulkCheckbox}>
                        <input
                          type="checkbox"
                          checked={isBulkSelected}
                          onChange={(event) => {
                            if (courierBulkMode === "refund") {
                              setSelectedCourierBulkOrderIds(event.target.checked ? [requestId] : []);
                              setCourierRefundRequest(event.target.checked ? request : null);
                              setSelectedCourierRefundUnitKeys(
                                event.target.checked ? preparerMissingRefundUnitKeysFromOrder(request) : [],
                              );
                              return;
                            }
                            setSelectedCourierBulkOrderIds((currentIds) =>
                              event.target.checked
                                ? [...new Set([...currentIds, requestId])]
                                : currentIds.filter((currentId) => String(currentId) !== requestId),
                            );
                          }}
                        />
                        <span>Seleccionar</span>
                      </label>
                    ) : null}
                    <CourierOrderCard
                      request={request}
                      sequenceNumber={Number(request.sequenceNumber || 0)}
                      adminCourierView
                      hideTransferredCourierBadge
                      cardSuccessMessage={visibleCourierCardSuccessMessages[requestId] || ""}
                    />
                  </div>
                );
              })}
            </div>
          ) : null}
        </s-section>
      ) : null}

      {viewMode === VIEW_MODE.COURIER && courierBulkMode === "refund" && courierRefundRequest ? (
        <div className={styles.reasonModalOverlay} role="dialog" aria-modal="true" aria-label="Confirmar reembolso">
          <section className={`${styles.reasonModal} ${styles.deliveryCodeAdminModal}`}>
            <p className={styles.reasonModalTitle}>Confirmar reembolso</p>
            <p className={styles.deliveryCodeDescription}>
              Selecciona los productos del pedido #{courierRefundRequest.orderNumber} que quieres reembolsar.
            </p>
            <div className={styles.courierRefundProductList}>
              {courierRefundUnitItems.map((item) => {
                const unitKey = String(item.unitKey || "");
                const checked = selectedCourierRefundUnitKeySet.has(unitKey);
                const alreadyRefunded = alreadyRefundedCourierUnitKeySet.has(unitKey);
                const itemTotal = Number(item.unitPrice || 0);
                return (
                  <label
                    key={unitKey || `${item.title}-${item.unitIndex}`}
                    className={`${styles.courierRefundProductOption} ${
                      checked ? styles.courierRefundProductOptionSelected : ""
                    } ${checked && item.preparerMissing ? styles.courierRefundProductOptionPreparerMissing : ""} ${
                      alreadyRefunded ? styles.courierRefundProductOptionDisabled : ""
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={alreadyRefunded}
                      onChange={(event) => {
                        if (alreadyRefunded) return;
                        setSelectedCourierRefundUnitKeys((currentIds) =>
                          event.target.checked
                            ? [...new Set([...currentIds, unitKey])]
                            : currentIds.filter((currentId) => String(currentId) !== unitKey),
                        );
                      }}
                    />
                    {item.imageUrl ? (
                      <img
                        src={item.imageUrl}
                        alt={item.imageAlt || item.title}
                        className={styles.courierRefundProductImage}
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <span className={styles.courierRefundProductImagePlaceholder} />
                    )}
                    <span className={styles.courierRefundProductCopy}>
                      <strong>{item.title}</strong>
                      {item.variantSummary ? <span>Variante: {item.variantSummary}</span> : null}
                      <span>Unidad {item.unitIndex} de {Math.max(1, Number(
                        courierRefundItems.find((sourceItem) =>
                          String(sourceItem.lineItemId || sourceItem.id || "") === String(item.lineItemId || item.id || ""),
                        )?.quantity || 1,
                      ))}</span>
                      {item.preparerMissing ? <span className={styles.courierRefundAlreadyRefunded}>No localizado por preparador</span> : null}
                      {alreadyRefunded ? <span className={styles.courierRefundAlreadyRefunded}>Ya reembolsado</span> : null}
                    </span>
                    <strong className={styles.courierRefundProductPrice}>
                      ${toMoney(itemTotal)} {item.currencyCode || courierRefundRequest.currencyCode || "MXN"}
                    </strong>
                  </label>
                );
              })}
            </div>
            <p className={styles.branchPickupRefundAmount}>
              Monto a reembolsar:{" "}
              <strong>
                ${toMoney(selectedCourierRefundTotal)} {selectedCourierRefundCurrency}
              </strong>
              {selectedCourierRefundIsFull ? " (incluye envio)" : ""}
            </p>
            <courierRouteFetcher.Form method="post" action={buildCourierRouteHref()} className={styles.deliveryCodeForm}>
              <input type="hidden" name="intent" value="courier_bulk_refund" />
              <input type="hidden" name="routeOrdersJson" value={JSON.stringify(courierRouteOrdersPayload)} />
              <input type="hidden" name="courierBulkOrderIds" value={String(courierRefundRequest.id || "")} />
              {selectedCourierRefundUnitKeys.map((unitKey) => (
                <input key={unitKey} type="hidden" name="courierRefundLineItemUnitKeys" value={unitKey} />
              ))}
              <div className={styles.reasonModalActions}>
                <button
                  className={styles.btn}
                  type="button"
                  onClick={() => {
                    setCourierRefundRequest(null);
                    setSelectedCourierBulkOrderIds([]);
                    setSelectedCourierRefundUnitKeys([]);
                  }}
                  disabled={isSubmitting || isCourierRouteSubmitting}
                >
                  Cancelar
                </button>
                <button
                  className={`${styles.btn} ${styles.btnDanger}`}
                  type="submit"
                  disabled={
                    isSubmitting ||
                    isCourierRouteSubmitting ||
                    selectedCourierRefundUnitKeys.length === 0
                  }
                  onClick={(event) => {
                    if (
                      !window.confirm(
                        `¿Reconfirmas reembolsar el pedido #${courierRefundRequest.orderNumber} por ${toMoney(
                          selectedCourierRefundTotal,
                        )} ${selectedCourierRefundCurrency} al metodo de pago original?${
                          selectedCourierRefundIsFull ? " La orden se enviara al historial del repartidor." : ""
                        }`,
                      )
                    ) {
                      event.preventDefault();
                    }
                  }}
                >
                  Reconfirmar reembolso
                </button>
              </div>
            </courierRouteFetcher.Form>
          </section>
        </div>
      ) : null}

      {viewMode === VIEW_MODE.COURIER_HISTORY ? (
        <s-section heading="Historial repartidor">
          <CourierHistoryDirectory
            couriers={couriers}
            activities={courierActivities}
            snapshots={courierRouteSnapshots}
            orders={courierOrders}
            search={location.search}
            shop={shop}
          />
        </s-section>
      ) : null}

      {viewMode === VIEW_MODE.BRANCH_PICKUP ? (
        <s-section heading="Recoger en sucursal">
          <div className={styles.branchPickupTestHeader}>
            <label className={styles.branchPickupTestSwitch}>
              <input
                type="checkbox"
                checked={branchPickupRefundTestMode}
                onChange={(event) => setBranchPickupRefundTestMode(event.target.checked)}
              />
              <span className={styles.branchPickupTestSlider} aria-hidden="true" />
              <span>Modo prueba reembolso</span>
            </label>
          </div>
          {courierOrders.length === 0 ? (
            <p>No hay ordenes para recoger en sucursal.</p>
          ) : (
            <div className={styles.courierGrid}>
              {[...courierOrders].sort(
                (a, b) =>
                  (parseEventMs(b?.updatedAt || b?.createdAt) || courierOrderTimestampMs(b)) -
                  (parseEventMs(a?.updatedAt || a?.createdAt) || courierOrderTimestampMs(a)),
              ).map((request) => (
                <CourierOrderCard
                  key={request.id}
                  request={request}
                  branchPickupView
                  branchPickupRefundTestMode={branchPickupRefundTestMode}
                  hideTransferredCourierBadge
                  isSubmitting={isSubmitting}
                  onBranchPickupDeliver={(selectedRequest) => {
                    setBranchPickupDeliveryRequest(selectedRequest);
                    setBranchPickupDeliveryCode("");
                  }}
                  onBranchPickupRefund={(selectedRequest) => {
                    setBranchPickupRefundRequest(selectedRequest);
                  }}
                />
              ))}
            </div>
          )}
        </s-section>
      ) : null}

      {viewMode === VIEW_MODE.BRANCH_PICKUP && branchPickupDeliveryRequest ? (
        <div className={styles.reasonModalOverlay} role="dialog" aria-modal="true" aria-label="Clave de entrega">
          <section className={`${styles.reasonModal} ${styles.deliveryCodeAdminModal}`}>
            <p className={styles.reasonModalTitle}>Introduce la clave de entrega</p>
            <p className={styles.deliveryCodeDescription}>
              Solicita al cliente la clave de seis digitos del pedido #{branchPickupDeliveryRequest.orderNumber}.
            </p>
            <branchPickupDeliveryFetcher.Form method="post" className={styles.deliveryCodeForm}>
              <input type="hidden" name="intent" value="branch_pickup_mark_delivered" />
              <input type="hidden" name="requestId" value={String(branchPickupDeliveryRequest.id || "")} />
              <input type="hidden" name="orderNumber" value={String(branchPickupDeliveryRequest.orderNumber || "")} />
              <input type="hidden" name="customerName" value={String(branchPickupDeliveryRequest.customerName || "")} />
              <input type="hidden" name="customerEmail" value={String(branchPickupDeliveryRequest.customerEmail || "")} />
              <input type="hidden" name="customerPhone" value={String(branchPickupDeliveryRequest.customerPhone || "")} />
              <input
                type="hidden"
                name="currentAttemptCount"
                value={String(branchPickupDeliveryRequest.attemptCount || 0)}
              />
              <input
                className={styles.deliveryCodeInput}
                name="deliveryCode"
                value={branchPickupDeliveryCode}
                onChange={(event) => setBranchPickupDeliveryCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                pattern="[0-9]{6}"
                aria-label="Clave de entrega de seis digitos"
                required
              />
              {branchPickupDeliveryActionData?.deliveryCodeError &&
              branchPickupDeliveryActionData?.requestId === String(branchPickupDeliveryRequest.id || "") ? (
                <p className={styles.errorMsg} role="alert">Clave incorrecta</p>
              ) : null}
              <div className={styles.reasonModalActions}>
                <button
                  className={styles.btn}
                  type="button"
                  onClick={() => {
                    setBranchPickupDeliveryRequest(null);
                    setBranchPickupDeliveryCode("");
                  }}
                >
                  Cancelar
                </button>
                <button
                  className={`${styles.btn} ${styles.btnSuccess}`}
                  type="submit"
                  disabled={isSubmitting || isBranchPickupDeliverySubmitting || branchPickupDeliveryCode.length !== 6}
                  onClick={(event) => {
                    if (!window.confirm(`¿Confirmas entregar el pedido #${branchPickupDeliveryRequest.orderNumber}?`)) {
                      event.preventDefault();
                    }
                  }}
                >
                  Confirmar entrega
                </button>
              </div>
            </branchPickupDeliveryFetcher.Form>
          </section>
        </div>
      ) : null}

      {viewMode === VIEW_MODE.BRANCH_PICKUP && branchPickupRefundRequest ? (
        <div className={styles.reasonModalOverlay} role="dialog" aria-modal="true" aria-label="Confirmar reembolso">
          <section className={`${styles.reasonModal} ${styles.deliveryCodeAdminModal}`}>
            <p className={styles.reasonModalTitle}>Confirmar reembolso</p>
            <p className={styles.deliveryCodeDescription}>
              El pedido #{branchPickupRefundRequest.orderNumber} venció para recoger en sucursal.
            </p>
            <p className={styles.branchPickupRefundAmount}>
              Monto a reembolsar:{" "}
              <strong>
                ${toMoney(branchPickupRefundRequest.estimatedRefund || 0)}{" "}
                {branchPickupRefundRequest.currencyCode || "MXN"}
              </strong>
            </p>
            <branchPickupRefundFetcher.Form method="post" action={`${location.pathname}${location.search}`} className={styles.deliveryCodeForm}>
              <input type="hidden" name="intent" value="branch_pickup_refund_expired" />
              <input type="hidden" name="requestId" value={String(branchPickupRefundRequest.id || "")} />
              <input type="hidden" name="orderNumber" value={String(branchPickupRefundRequest.orderNumber || "")} />
              <input
                type="hidden"
                name="branchPickupRefundTestMode"
                value={branchPickupRefundTestMode ? "1" : "0"}
              />
              <input
                type="hidden"
                name="deadline"
                value={String(branchPickupRefundRequest.branchPickupDeadlineLabel || "")}
              />
              <div className={styles.reasonModalActions}>
                <button
                  className={styles.btn}
                  type="button"
                  onClick={() => setBranchPickupRefundRequest(null)}
                >
                  Cancelar
                </button>
                <button
                  className={`${styles.btn} ${styles.btnDanger}`}
                  type="submit"
                  disabled={isSubmitting || isBranchPickupRefundSubmitting}
                  onClick={(event) => {
                    if (!window.confirm(`¿Confirmas reembolsar el pedido #${branchPickupRefundRequest.orderNumber} al metodo de pago original?`)) {
                      event.preventDefault();
                    }
                  }}
                >
                  Confirmar reembolso
                </button>
              </div>
            </branchPickupRefundFetcher.Form>
          </section>
        </div>
      ) : null}

      {viewMode === VIEW_MODE.COURIERS ? (
        <CouriersSection couriers={couriers} isSubmitting={isSubmitting} />
      ) : null}

      {viewMode === VIEW_MODE.PREPARERS ? (
        <PreparersSection
          preparers={preparers}
          preparerAssignments={preparerAssignments}
          courierOrders={preparerCourierOrders}
          routeOrdersPayload={preparerRouteOrdersPayload}
          isSubmitting={isSubmitting}
        />
      ) : null}
    </s-page>
  );
}

function mexicoActivityDateKey(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function courierHistoryOrderLocation(order) {
  const status = String(order?.status || "").trim().toLowerCase();
  if (status === "recoger_en_sucursal") return "Recoger en sucursal";
  if (["entregado", "recibido", "recibida", "reembolsada"].includes(status)) return "Historial repartidor";
  if (
    isReturnCourierLabel(order?.courierLabel) &&
    status === "rechazada" &&
    getReturnFailedAttemptCountFromReason(order?.rejectionReason) >= 3
  ) {
    return "Historial repartidor";
  }
  if (["reembolsada", "completada", "rechazada", "denegada", "reembolso_denegado", "no_devuelto"].includes(status)) {
    return "Historial";
  }
  return "Ordenes repartidor";
}

function courierHistoryOrderUpdatedMs(order) {
  const finalDeliveryActions = new Set([
    "courier_mark_delivered",
    "courier_mark_not_delivered",
    "courier_route_order_not_located",
    "courier_return_mark_received",
    "courier_return_pickup_attempt_failed",
    "courier_return_reject_after_failed_pickups",
    "courier_branch_pickup_refunded",
    COURIER_ORDER_REFUND_DETAIL_ACTION,
  ]);
  const finalActivityMs = (order?.courierActivities || []).reduce((latestMs, activity) => {
    const action = String(activity?.action || "").trim().toLowerCase();
    return finalDeliveryActions.has(action)
      ? Math.max(latestMs, parseEventMs(activity?.createdAt))
      : latestMs;
  }, 0);
  if (finalActivityMs) return finalActivityMs;

  const finalHistoryStatuses = new Set([
    "entregado",
    "recibida",
    "recibido",
    "rechazada",
    "no_recibido",
    "no_entregado",
    "reembolsada",
  ]);
  const finalHistoryEventMs = [
    ...(Array.isArray(order?.historyEvents) ? order.historyEvents : []),
    ...(Array.isArray(order?.branchPickupHistoryEvents) ? order.branchPickupHistoryEvents : []),
    ...(Array.isArray(order?.unfilteredHistoryEvents) ? order.unfilteredHistoryEvents : []),
  ].reduce((latestMs, event) => {
    const status = String(event?.status || "").trim().toLowerCase();
    const label = String(event?.label || "").trim();
    const isFinalEvent =
      finalHistoryStatuses.has(status) ||
      /\b(?:recibid[ao]|entregad[ao]|rechazad[ao]|reembolsad[ao]|no recibido|no entregado)\b/i.test(label);
    return isFinalEvent ? Math.max(latestMs, parseEventMs(event?.at || event?.createdAt)) : latestMs;
  }, 0);
  if (finalHistoryEventMs) return finalHistoryEventMs;

  return Math.max(
    parseEventMs(order?.refundedAt),
    parseEventMs(order?.receivedAt),
    parseEventMs(order?.finishedAt),
    parseEventMs(order?.courierHistoryAt),
    parseEventMs(order?.updatedAt),
    parseEventMs(order?.createdAt),
    courierOrderTimestampMs(order),
  );
}

function isCourierCompletedHistoryOrder(order) {
  const status = String(order?.status || "").trim().toLowerCase();
  if (latestCourierRefundDetail(order?.courierActivities)?.fullRefund) return true;
  if (["entregado", "recibido", "recibida", "reembolsada"].includes(status)) return true;
  return (
    isReturnCourierLabel(order?.courierLabel) &&
    status === "rechazada" &&
    getReturnFailedAttemptCountFromReason(order?.rejectionReason) >= 3
  );
}

function normalizeRouteAddressText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function routeAddressTokens(value) {
  const ignoredTokens = new Set([
    "av",
    "avenida",
    "calle",
    "blvd",
    "boulevard",
    "col",
    "colonia",
    "cp",
    "mexico",
    "ags",
    "aguascalientes",
  ]);
  return normalizeRouteAddressText(value)
    .split(" ")
    .filter((token) => token.length > 2 && !ignoredTokens.has(token));
}

function postalCodeFromRouteAddress(value) {
  const match = String(value || "").match(/\b\d{5}\b/);
  return match ? Number(match[0]) : 0;
}

function routeAddressTextFromOrder(order) {
  return [
    order?.pickupAddress,
    order?.pickupNeighborhood,
    order?.pickupCity,
    order?.pickupState,
    order?.pickupPostalCode,
    order?.pickupCountry || "Mexico",
  ]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ");
}

function routeAddressSignature(value) {
  return {
    normalized: normalizeRouteAddressText(value),
    postalCode: postalCodeFromRouteAddress(value),
    tokens: routeAddressTokens(value),
  };
}

function routeAddressDistance(firstAddress, secondAddress) {
  if (!firstAddress?.normalized || !secondAddress?.normalized) return Number.MAX_SAFE_INTEGER;
  const firstTokenSet = new Set(firstAddress.tokens || []);
  const secondTokens = secondAddress.tokens || [];
  const sharedTokenCount = secondTokens.filter((token) => firstTokenSet.has(token)).length;
  const postalDifference =
    firstAddress.postalCode && secondAddress.postalCode
      ? Math.abs(firstAddress.postalCode - secondAddress.postalCode)
      : 50000;
  return postalDifference * 10 - sharedTokenCount * 1000 + Math.abs(firstAddress.normalized.length - secondAddress.normalized.length);
}

async function sortCourierRouteOrdersByGoogleMapsProximity(shop, orders, routeStartAddress = "") {
  const cleanShop = String(shop || "").trim();
  if (!cleanShop || !String(process.env.GOOGLE_MAPS_API_KEY || "").trim()) return null;

  const startPoint = await geocodeAddressWithCache(cleanShop, routeStartAddress);
  if (!startPoint) return null;

  const geocodedOrders = [];
  for (const order of Array.isArray(orders) ? orders : []) {
    const orderId = String(order?.id || "").trim();
    if (!orderId) continue;
    const address = routeAddressTextFromOrder(order);
    const point = await geocodeAddressWithCache(cleanShop, address);
    if (!point) return null;
    geocodedOrders.push({ order, point });
  }
  if (!geocodedOrders.length) return [];

  const sortedOrders = [];
  const pendingOrders = [...geocodedOrders];
  let currentPoint = startPoint;

  while (pendingOrders.length) {
    let nearestIndex = 0;
    let nearestDistance = Number.MAX_SAFE_INTEGER;
    for (let index = 0; index < pendingOrders.length; index += 1) {
      const distance = haversineDistanceMeters(currentPoint, pendingOrders[index].point);
      if (
        distance < nearestDistance ||
        (distance === nearestDistance &&
          String(pendingOrders[index].order?.orderNumber || "").localeCompare(
            String(pendingOrders[nearestIndex].order?.orderNumber || ""),
            "es",
            { numeric: true, sensitivity: "base" },
          ) < 0)
      ) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    }
    const [nextOrder] = pendingOrders.splice(nearestIndex, 1);
    sortedOrders.push(nextOrder.order);
    currentPoint = nextOrder.point;
  }

  return sortedOrders.map((order, index) => ({
    ...order,
    sequenceNumber: index + 1,
    routeSortSource: "google_maps",
  }));
}

function sortCourierRouteOrdersByProximityFallback(orders, routeStartAddress = "") {
  const pendingOrders = (Array.isArray(orders) ? orders : [])
    .filter((order) => String(order?.id || "").trim())
    .map((order) => ({
      order,
      signature: routeAddressSignature(routeAddressTextFromOrder(order)),
    }));
  const sortedOrders = [];
  let currentSignature = routeAddressSignature(routeStartAddress);
  if (!currentSignature.normalized && pendingOrders.length) {
    currentSignature = pendingOrders[0].signature;
  }

  while (pendingOrders.length) {
    let nearestIndex = 0;
    let nearestDistance = Number.MAX_SAFE_INTEGER;
    for (let index = 0; index < pendingOrders.length; index += 1) {
      const distance = routeAddressDistance(currentSignature, pendingOrders[index].signature);
      if (
        distance < nearestDistance ||
        (distance === nearestDistance &&
          String(pendingOrders[index].order?.orderNumber || "").localeCompare(
            String(pendingOrders[nearestIndex].order?.orderNumber || ""),
            "es",
            { numeric: true, sensitivity: "base" },
          ) < 0)
      ) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    }
    const [nextOrder] = pendingOrders.splice(nearestIndex, 1);
    sortedOrders.push(nextOrder.order);
    currentSignature = nextOrder.signature;
  }

  return sortedOrders.map((order, index) => ({
    ...order,
    sequenceNumber: index + 1,
    routeSortSource: "text_fallback",
  }));
}

async function sortCourierRouteOrdersByProximity(shop, orders, routeStartAddress = "") {
  const googleSortedOrders = await sortCourierRouteOrdersByGoogleMapsProximity(shop, orders, routeStartAddress);
  return googleSortedOrders || sortCourierRouteOrdersByProximityFallback(orders, routeStartAddress);
}

async function distributeCourierRouteOrdersByZone(shop, orders, couriers, routeStartAddress = "") {
  const cleanCouriers = (Array.isArray(couriers) ? couriers : []).filter((courier) => Number(courier?.id));
  if (!cleanCouriers.length) return [];
  const sortedOrders = await sortCourierRouteOrdersByProximity(shop, orders, routeStartAddress);
  const baseSize = Math.floor(sortedOrders.length / cleanCouriers.length);
  const extraCount = sortedOrders.length % cleanCouriers.length;
  let offset = 0;

  return cleanCouriers.map((courier, index) => {
    const size = baseSize + (index < extraCount ? 1 : 0);
    const courierOrders = sortedOrders.slice(offset, offset + size);
    offset += size;
    return {
      courier,
      orders: courierOrders,
    };
  });
}

async function clearUnstartedCourierRoutePlans(shop) {
  const plannedActivities = await prisma.courierActivity.findMany({
    where: {
      shop,
      action: COURIER_ROUTE_PLANNED_ACTION,
      routeId: { not: null },
    },
    select: { routeId: true },
  });
  const plannedRouteIds = [
    ...new Set(plannedActivities.map((activity) => String(activity.routeId || "").trim()).filter(Boolean)),
  ];
  if (!plannedRouteIds.length) return;

  const startedActivities = await prisma.courierActivity.findMany({
    where: {
      shop,
      routeId: { in: plannedRouteIds },
      action: "courier_route_started",
    },
    select: { routeId: true },
  });
  const startedRouteIds = new Set(startedActivities.map((activity) => String(activity.routeId || "").trim()));
  const unstartedRouteIds = plannedRouteIds.filter((routeId) => !startedRouteIds.has(routeId));
  if (!unstartedRouteIds.length) return;

  await prisma.courierActivity.deleteMany({
    where: {
      shop,
      routeId: { in: unstartedRouteIds },
      action: {
        in: [COURIER_ROUTE_PLANNED_ACTION, "courier_route_order_assigned"],
      },
    },
  });
}

async function clearCourierRoutesForOrders(shop, requestIds = []) {
  const cleanRequestIds = [...new Set(
    (Array.isArray(requestIds) ? requestIds : [])
      .map((requestId) => String(requestId || "").trim())
      .filter(Boolean),
  )];
  if (!shop || !cleanRequestIds.length) return;

  const assignments = await prisma.courierActivity.findMany({
    where: {
      shop,
      requestId: { in: cleanRequestIds },
      action: "courier_route_order_assigned",
      routeId: { not: null },
    },
    select: { routeId: true },
  });
  const routeIds = [...new Set(assignments.map((activity) => String(activity.routeId || "").trim()).filter(Boolean))];
  if (!routeIds.length) return;

  const finishedRoutes = await prisma.courierActivity.findMany({
    where: {
      shop,
      routeId: { in: routeIds },
      action: "courier_route_finished",
    },
    select: { routeId: true },
  });
  const finishedRouteIds = new Set(finishedRoutes.map((activity) => String(activity.routeId || "").trim()));
  const activeRouteIds = routeIds.filter((routeId) => !finishedRouteIds.has(routeId));
  if (!activeRouteIds.length) return;

  await prisma.courierActivity.deleteMany({
    where: {
      shop,
      routeId: { in: activeRouteIds },
      requestId: { in: cleanRequestIds },
      action: "courier_route_order_assigned",
    },
  });

  const remainingAssignments = await prisma.courierActivity.findMany({
    where: {
      shop,
      routeId: { in: activeRouteIds },
      action: "courier_route_order_assigned",
    },
    select: { routeId: true },
  });
  const routesWithRemainingOrders = new Set(
    remainingAssignments.map((activity) => String(activity.routeId || "").trim()),
  );
  const emptyRouteIds = activeRouteIds.filter((routeId) => !routesWithRemainingOrders.has(routeId));
  if (!emptyRouteIds.length) return;

  const routePlans = await prisma.courierActivity.findMany({
    where: {
      shop,
      routeId: { in: emptyRouteIds },
      action: COURIER_ROUTE_PLANNED_ACTION,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const latestPlanByRouteId = new Map();
  for (const plan of routePlans) {
    const routeId = String(plan.routeId || "").trim();
    if (routeId && !latestPlanByRouteId.has(routeId)) latestPlanByRouteId.set(routeId, plan);
  }
  await prisma.$transaction([
    prisma.courierActivity.deleteMany({
      where: {
        shop,
        routeId: { in: emptyRouteIds },
        action: COURIER_ROUTE_PLANNED_ACTION,
      },
    }),
    ...emptyRouteIds.map((routeId) => {
      const plan = latestPlanByRouteId.get(routeId);
      return prisma.courierActivity.create({
        data: {
          shop,
          courierId: Number(plan?.courierId || 0),
          courierName: String(plan?.courierName || ""),
          requestId: `route:${routeId}`,
          action: "courier_route_finished",
          routeId,
        },
      });
    }).filter((operation, index) => Number(latestPlanByRouteId.get(emptyRouteIds[index])?.courierId || 0)),
  ]);
}

async function plannedCourierRouteSummary(shop, courierIds) {
  const ids = (Array.isArray(courierIds) ? courierIds : []).map(Number).filter(Boolean);
  if (!ids.length) return [];
  const plannedActivities = await prisma.courierActivity.findMany({
    where: {
      shop,
      courierId: { in: ids },
      action: COURIER_ROUTE_PLANNED_ACTION,
      routeId: { not: null },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const latestPlanByCourierId = new Map();
  for (const activity of plannedActivities) {
    if (latestPlanByCourierId.has(activity.courierId)) continue;
    latestPlanByCourierId.set(activity.courierId, activity);
  }
  const routeIds = [...new Set([...latestPlanByCourierId.values()].map((activity) => activity.routeId).filter(Boolean))];
  if (!routeIds.length) return [];
  const finishedRoutes = await prisma.courierActivity.findMany({
    where: { shop, routeId: { in: routeIds }, action: "courier_route_finished" },
    select: { routeId: true },
  });
  const finishedRouteIds = new Set(finishedRoutes.map((activity) => String(activity.routeId || "")));
  const activeRouteIds = routeIds.filter((routeId) => !finishedRouteIds.has(String(routeId || "")));
  const assignments = await prisma.courierActivity.findMany({
    where: {
      shop,
      routeId: { in: activeRouteIds },
      action: "courier_route_order_assigned",
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const orderNumbersByRouteId = new Map();
  const requestIdsByRouteId = new Map();
  for (const assignment of assignments) {
    const routeId = String(assignment.routeId || "");
    const requestId = String(assignment.requestId || "").trim();
    const orderNumber = String(assignment.orderNumber || "").trim();
    if (!orderNumbersByRouteId.has(routeId)) orderNumbersByRouteId.set(routeId, []);
    if (!requestIdsByRouteId.has(routeId)) requestIdsByRouteId.set(routeId, []);
    if (requestId) requestIdsByRouteId.get(routeId).push(requestId);
    if (orderNumber) orderNumbersByRouteId.get(routeId).push(orderNumber);
  }
  return [...latestPlanByCourierId.values()]
    .filter((activity) => !finishedRouteIds.has(String(activity.routeId || "")))
    .map((activity) => {
      const routeId = String(activity.routeId || "");
      const requestIds = requestIdsByRouteId.get(routeId) || [];
      return {
        courierId: activity.courierId,
        routeId: activity.routeId,
        requestIds,
        orderNumbers: orderNumbersByRouteId.get(routeId) || [],
        count: Number(requestIds.length),
      };
    });
}

function isCourierBranchReturnOrder(order, routeAction = "") {
  const normalizedAction = String(routeAction || "").trim().toLowerCase();
  const status = String(order?.status || order?.currentStatus || "").trim().toLowerCase();
  if (!isReturnCourierLabel(order?.courierLabel) && ["entregado", "recibido", "recibida", "reembolsada"].includes(status)) {
    return false;
  }
  if (normalizedAction) {
    return [
      "courier_mark_not_delivered",
      "courier_return_mark_received",
      "courier_route_delivery_reprogrammed",
      COURIER_ADMIN_REPROGRAM_ACTION,
    ].includes(normalizedAction);
  }
  if (isReturnCourierLabel(order?.courierLabel)) {
    return ["entregado", "recibido", "recibida"].includes(status);
  }

  const historyLabels = (order?.historyEvents || [])
    .map((event) => String(event?.label || "").trim())
    .join(" ");
  const historyNotes = (order?.historyEvents || [])
    .map((event) => String(event?.note || "").trim())
    .join(" ");
  return (
    ["no_entregado", "no entregado", "reintento_pendiente"].includes(status) ||
    /\bno entregado\b/i.test(historyLabels) ||
    /falta de tiempo|route_time_rescheduled/i.test(`${historyLabels} ${historyNotes}`)
  );
}

function CourierHistoryDirectory({ couriers, activities, snapshots = [], orders, search, shop }) {
  const [orderSearch, setOrderSearch] = useState("");
  const [showBranchReturnOrders, setShowBranchReturnOrders] = useState(false);
  const orderByRequestId = new Map(orders.map((order) => [String(order.id || ""), order]));
  const activitiesByRequestId = new Map();
  for (const activity of activities || []) {
    const requestId = String(activity.requestId || "").trim();
    if (!requestId || requestId.startsWith("route:")) continue;
    const current = activitiesByRequestId.get(requestId) || [];
    current.push(activity);
    activitiesByRequestId.set(requestId, current);
  }
  const searchParams = new URLSearchParams(search);
  const historyView = String(searchParams.get("historyView") || "").trim();
  const selectedCourierId = Number(searchParams.get("courierId") || 0);
  const selectedDate = String(searchParams.get("date") || "").trim();
  const selectedRouteId = String(searchParams.get("routeId") || "").trim();
  useEffect(() => {
    setShowBranchReturnOrders(false);
  }, [selectedCourierId, selectedDate, selectedRouteId]);
  const baseHref = "/app/devoluciones/solicitudes/courier_history";
  const buildHistoryHref = ({ view = "", courierId = "", date = "", routeId = "" } = {}) => {
    const nextParams = new URLSearchParams(searchParams);
    if (!nextParams.get("shop") && shop) nextParams.set("shop", shop);
    if (view) nextParams.set("historyView", view);
    else nextParams.delete("historyView");
    if (courierId) nextParams.set("courierId", String(courierId));
    else nextParams.delete("courierId");
    if (date) nextParams.set("date", date);
    else nextParams.delete("date");
    if (routeId) nextParams.set("routeId", routeId);
    else nextParams.delete("routeId");
    return `${baseHref}?${nextParams.toString()}`;
  };

  if (historyView === "all") {
    const normalizedSearch = String(orderSearch || "").replace(/^#/, "").trim().toLowerCase();
    const completedOrders = orders
      .filter(isCourierCompletedHistoryOrder)
      .sort((firstOrder, secondOrder) => {
        const updatedDifference = courierHistoryOrderUpdatedMs(secondOrder) - courierHistoryOrderUpdatedMs(firstOrder);
        if (updatedDifference !== 0) return updatedDifference;
        return Number(secondOrder?.orderNumber || 0) - Number(firstOrder?.orderNumber || 0);
      });
    const searchResults = normalizedSearch
      ? orders.filter((order) =>
          String(order?.orderNumber || "").replace(/^#/, "").trim().toLowerCase().includes(normalizedSearch),
        )
      : [];
    const visibleOrders = normalizedSearch ? searchResults : completedOrders;
    return (
      <div className={styles.courierHistoryDirectoryList}>
        <Link className={styles.courierHistoryBackLink} to={buildHistoryHref()}>← Regresar</Link>
        <h3>Historial de todas las ordenes</h3>
        <label className={styles.courierHistorySearch}>
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            value={orderSearch}
            onChange={(event) => setOrderSearch(event.target.value)}
            placeholder="Buscar por numero de orden"
            aria-label="Buscar por numero de orden"
          />
        </label>
        <div className={styles.courierGrid}>
          {visibleOrders.length ? (
            visibleOrders.map((request) => (
              <div key={request.id} className={styles.courierHistorySearchResult}>
                {normalizedSearch ? (
                  <div className={styles.courierHistoryLocation}>
                    Seccion: <strong>{courierHistoryOrderLocation(request)}</strong>
                  </div>
                ) : null}
                <CourierOrderCard
                  request={request}
                  statusOverride={courierHistoryPendingStatusOverride(request)}
                  showFinalAttemptBadge
                  adminCourierView
                  courierHistoryView
                  hideTransferredCourierBadge
                />
              </div>
            ))
          ) : (
            <p>{normalizedSearch ? "No se encontro una orden con ese numero." : "No hay ordenes entregadas o devoluciones recibidas."}</p>
          )}
        </div>
      </div>
    );
  }

  if (["courier", "courier_day"].includes(historyView) && selectedCourierId) {
    const courier = couriers.find((item) => Number(item.id) === selectedCourierId);
    const courierActivities = activities.filter((activity) => Number(activity.courierId) === selectedCourierId);
    const transferActivities = courierActivities
      .filter((activity) => String(activity.action || "").startsWith("courier_route_transferred_from:"))
      .sort(
        (firstActivity, secondActivity) =>
          new Date(firstActivity.createdAt || "").getTime() -
          new Date(secondActivity.createdAt || "").getTime(),
      );
    const transferActivityByRouteIdForHistory = new Map(
      transferActivities.map((activity) => [String(activity.routeId || "").trim(), activity]),
    );
    const transferActivityForRoute = (routeId, dateKey) =>
      transferActivities.find((activity) => {
        if (routeId && String(activity.routeId || "") !== String(routeId)) return false;
        return mexicoActivityDateKey(activity.createdAt) === dateKey;
      });
    const orderTransferDetails = (order, transferActivity, routeId = "") => {
      if (!transferActivity) return {};
      const requestId = String(order?.id || "").trim();
      const transferAtMs = new Date(transferActivity.createdAt || "").getTime();
      const handledAfterTransfer = courierActivities.some((activity) => {
        if (String(activity.requestId || "").trim() !== requestId) return false;
        if (routeId && String(activity.routeId || "") !== String(routeId)) return false;
        return new Date(activity.createdAt || "").getTime() >= transferAtMs;
      });
      return handledAfterTransfer
        ? {
            transferredCourierName: String(transferActivity.courierName || "").trim(),
            routeTransferredAt: transferActivity.createdAt,
          }
        : {};
    };
    const courierSnapshots = snapshots.filter((snapshot) => Number(snapshot.courierId) === selectedCourierId);
    const snapshotByRouteId = new Map(
      courierSnapshots.map((snapshot) => [String(snapshot.routeId || "").trim(), snapshot]),
    );
    const compareActivitiesAscending = (firstActivity, secondActivity) => {
      const timeDifference =
        new Date(firstActivity.createdAt || "").getTime() -
        new Date(secondActivity.createdAt || "").getTime();
      if (timeDifference !== 0) return timeDifference;
      return Number(firstActivity.id || 0) - Number(secondActivity.id || 0);
    };
    const buildRouteAssignmentSequenceByOrderId = (routeId) => {
      const cleanRouteId = String(routeId || "").trim();
      if (!cleanRouteId) return new Map();

      const routePlan = [...activities]
        .filter(
          (activity) =>
            String(activity.routeId || "").trim() === cleanRouteId &&
            String(activity.action || "").trim().toLowerCase() === COURIER_ROUTE_PLANNED_ACTION,
        )
        .sort(
          (firstActivity, secondActivity) =>
            new Date(secondActivity.createdAt || "").getTime() -
              new Date(firstActivity.createdAt || "").getTime() ||
            Number(secondActivity.id || 0) - Number(firstActivity.id || 0),
        )[0];
      const planStartedAt = routePlan?.createdAt ? new Date(routePlan.createdAt) : null;
      const batchRouteIds = planStartedAt
        ? [
            ...new Set(
              [...activities]
                .filter((activity) => {
                  if (String(activity.action || "").trim().toLowerCase() !== COURIER_ROUTE_PLANNED_ACTION) {
                    return false;
                  }
                  if (!String(activity.routeId || "").trim()) return false;
                  const activityTime = new Date(activity.createdAt || "").getTime();
                  if (!Number.isFinite(activityTime)) return false;
                  return Math.abs(activityTime - planStartedAt.getTime()) <= 15000;
                })
                .sort(compareActivitiesAscending)
                .map((activity) => String(activity.routeId || "").trim())
                .filter(Boolean),
            ),
          ]
        : [];
      const finishedBatchRouteIds = new Set(
        [...activities]
          .filter(
            (activity) =>
              batchRouteIds.includes(String(activity.routeId || "").trim()) &&
              String(activity.action || "").trim().toLowerCase() === "courier_route_finished",
          )
          .map((activity) => String(activity.routeId || "").trim()),
      );
      const activeBatchRouteIds = batchRouteIds.filter((id) => !finishedBatchRouteIds.has(id));
      const sequenceRouteIds = activeBatchRouteIds.length ? activeBatchRouteIds : [cleanRouteId];
      const sequenceActivities = [...activities]
        .filter(
          (activity) =>
            sequenceRouteIds.includes(String(activity.routeId || "").trim()) &&
            String(activity.action || "").trim().toLowerCase() !== COURIER_ROUTE_PLANNED_ACTION &&
            String(activity.action || "").trim().toLowerCase() !== "courier_route_started" &&
            String(activity.action || "").trim().toLowerCase() !== "courier_route_finished",
        )
        .sort(compareActivitiesAscending);
      const orderNumberByRequestId = new Map();
      for (const activity of sequenceActivities) {
        const requestId = String(activity.requestId || "").trim();
        const orderNumber = String(activity.orderNumber || "").trim();
        if (requestId && orderNumber && !orderNumberByRequestId.has(requestId)) {
          orderNumberByRequestId.set(requestId, orderNumber);
        }
      }
      const assignedSequenceIds = [
        ...new Set(
          sequenceActivities
            .filter((activity) => String(activity.action || "").trim().toLowerCase() === "courier_route_order_assigned")
            .sort(compareActivitiesAscending)
            .map((activity) => String(activity.requestId || "").trim())
            .filter(
              (requestId) =>
                requestId &&
                !requestId.startsWith("route:") &&
                !requestId.startsWith("session:"),
            ),
        ),
      ];
      const missingSequenceIds = sequenceActivities
        .map((activity) => String(activity.requestId || "").trim())
        .filter(
          (requestId) =>
            requestId &&
            !requestId.startsWith("route:") &&
            !requestId.startsWith("session:") &&
            !assignedSequenceIds.includes(requestId),
        );
      const sequenceIds = insertMissingRouteSequenceIdsByOrderNumber(
        assignedSequenceIds,
        missingSequenceIds,
        orderNumberByRequestId,
      );

      return new Map(sequenceIds.map((requestId, index) => [requestId, index + 1]));
    };
    const routeStarts = courierActivities.filter(
      (activity) => activity.action === "courier_route_started" && activity.routeId,
    );
    const routeOrderIdsByRouteId = new Map();
    for (const activity of courierActivities) {
      if (!activity.routeId || activity.action === "courier_route_started" || activity.action === "courier_route_finished") {
        continue;
      }
      const requestId = String(activity.requestId || "").trim();
      if (!requestId) continue;
      const current = routeOrderIdsByRouteId.get(activity.routeId) || new Set();
      current.add(requestId);
      routeOrderIdsByRouteId.set(activity.routeId, current);
    }
    const uniqueRouteHistoryBlocks = [];
    const routeHistorySignatures = new Set();
    for (const activity of routeStarts
      .filter((activity) => (routeOrderIdsByRouteId.get(activity.routeId)?.size || 0) > 0)
      .sort(
        (firstActivity, secondActivity) =>
          new Date(secondActivity.createdAt || "").getTime() -
          new Date(firstActivity.createdAt || "").getTime(),
      )) {
      const dateKey = mexicoActivityDateKey(activity.createdAt);
      const orderSignature = Array.from(routeOrderIdsByRouteId.get(activity.routeId) || [])
        .sort()
        .join("|");
      const routeSignature = `${dateKey}:${orderSignature}`;
      if (routeHistorySignatures.has(routeSignature)) continue;
      routeHistorySignatures.add(routeSignature);
      uniqueRouteHistoryBlocks.push(activity);
    }
    const snapshotRouteHistoryBlocks = courierSnapshots
      .filter((snapshot) => String(snapshot.routeId || "").trim() && Array.isArray(snapshot.orders) && snapshot.orders.length)
      .map((snapshot) => ({
        ...snapshot,
        createdAt: snapshot.finishedAt || snapshot.createdAt,
        isSnapshot: true,
      }));
    const routeHistoryBlocks = [
      ...snapshotRouteHistoryBlocks,
      ...uniqueRouteHistoryBlocks.filter((activity) => !snapshotByRouteId.has(String(activity.routeId || "").trim())),
    ].sort(
      (firstItem, secondItem) =>
        new Date(secondItem.createdAt || secondItem.finishedAt || "").getTime() -
        new Date(firstItem.createdAt || firstItem.finishedAt || "").getTime(),
    );
    const todayDateKey = mexicoActivityDateKey(new Date());
    const currentOrders = orders.filter((order) => !isCourierHistoryStatus(order.status));
    const todayActivityOrders = courierActivities
      .filter((activity) => mexicoActivityDateKey(activity.createdAt) === todayDateKey)
      .map((activity) => orderByRequestId.get(String(activity.requestId || "")))
      .filter(Boolean);
    const todayOrders = [
      ...new Map(
        [...currentOrders, ...todayActivityOrders].map((order) => [String(order.id || ""), order]),
      ).values(),
    ];
    const legacyDates = [
      ...new Set([
        ...courierActivities
          .filter((activity) => {
            const requestId = String(activity.requestId || "").trim();
            return !activity.routeId && requestId && !requestId.startsWith("route:");
          })
          .map((activity) => mexicoActivityDateKey(activity.createdAt)),
      ]),
    ].filter(Boolean).sort().reverse();
    const calendarItems = [
      ...routeHistoryBlocks.map((activity) => {
        const dateKey = activity.dateKey || mexicoActivityDateKey(activity.createdAt || activity.finishedAt);
        return {
          key: `${activity.isSnapshot ? "snapshot" : "activity"}:${activity.routeId}`,
          dateKey,
          routeId: activity.routeId,
          sortAt: new Date(activity.createdAt || activity.finishedAt || `${dateKey}T12:00:00Z`).getTime(),
          transferActivity: transferActivityForRoute(activity.routeId, dateKey),
        };
      }),
      ...legacyDates
        .filter((dateKey) => !routeHistoryBlocks.some((activity) => mexicoActivityDateKey(activity.createdAt || activity.finishedAt) === dateKey))
        .map((dateKey) => ({
          key: `legacy:${dateKey}`,
          dateKey,
          routeId: "",
          sortAt: new Date(`${dateKey}T12:00:00Z`).getTime(),
          transferActivity: transferActivityForRoute("", dateKey),
        })),
    ].sort((firstItem, secondItem) => secondItem.sortAt - firstItem.sortAt);

    if (historyView === "courier_day" && selectedDate) {
      const selectedSnapshot = selectedRouteId ? snapshotByRouteId.get(selectedRouteId) : null;
      if (selectedSnapshot) {
        const selectedSnapshotCutoff = selectedSnapshot;
        const selectedTransferActivity = transferActivityForRoute(selectedRouteId, selectedDate);
        const routeReprogramActivityByRequestId = new Map(
          courierActivities
            .filter(
              (activity) =>
                String(activity.routeId || "").trim() === selectedRouteId &&
                COURIER_ROUTE_REPROGRAM_ACTIONS.has(String(activity.action || "").trim().toLowerCase()),
            )
            .map((activity) => [String(activity.requestId || "").trim(), activity]),
        );
        const notLocatedSnapshotOrderIds = new Set(
          courierActivities
            .filter(
              (activity) =>
                String(activity.routeId || "").trim() === selectedRouteId &&
                String(activity.action || "").trim().toLowerCase() === "courier_route_order_not_located",
            )
            .map((activity) => String(activity.requestId || "").trim())
            .filter(Boolean),
        );
        const snapshotRouteAssignmentSequenceByOrderId = buildRouteAssignmentSequenceByOrderId(selectedRouteId);
        const snapshotOrders = Array.isArray(selectedSnapshotCutoff.orders) ? selectedSnapshotCutoff.orders : [];
        const hiddenSnapshotOrderIds = new Set(
          snapshotOrders
            .map((order) => String(order?.id || "").trim())
            .filter((id) => id && notLocatedSnapshotOrderIds.has(id)),
        );
        const selectedSnapshotOrders = snapshotOrders
          .filter((order) => !hiddenSnapshotOrderIds.has(String(order?.id || "").trim()))
          .map((order, index) => {
            const id = String(order?.id || "");
            const sourceOrder = orderByRequestId.get(id) || {};
            const storedSnapshotHistoryEvents = mergeCourierHistoryEvents(
              Array.isArray(order?.historyEvents) ? order.historyEvents : [],
              Array.isArray(sourceOrder?.historyEvents) ? sourceOrder.historyEvents : [],
            );
            const routeReprogramActivity = routeReprogramActivityByRequestId.get(id);
            const scheduledDate = String(order?.pickupDate || sourceOrder?.pickupDate || "").trim();
            const scheduledDateLabel = scheduledDate
              ? formatCourierRescheduledDate(new Date(`${scheduledDate}T12:00:00Z`))
              : "";
            const snapshotHistoryEvents = routeReprogramActivity
              ? [
                  ...storedSnapshotHistoryEvents,
                  {
                    id: `snapshot-route-activity-${selectedRouteId}-${id}`,
                    label: routeTimeReprogramLabel(scheduledDateLabel, {
                      adminNotLocatedReprogram: isAdminNotLocatedReprogramActivity(routeReprogramActivity),
                    }),
                    at: routeReprogramActivity.createdAt || selectedSnapshotCutoff.finishedAt,
                    courierName: String(
                      routeReprogramActivity.courierName || selectedSnapshotCutoff.courierName || "",
                    ).trim(),
                    note: scheduledDate ? `route_time_rescheduled:${scheduledDate}` : "route_time_rescheduled",
                    routeTimeRescheduled: true,
                    adminNotLocatedReprogram: isAdminNotLocatedReprogramActivity(routeReprogramActivity),
                  },
                ]
              : storedSnapshotHistoryEvents;
            const orderWithCourierName = {
              customerName: sourceOrder.customerName || "",
              customerPhone: sourceOrder.customerPhone || "",
              pickupAddress: sourceOrder.pickupAddress || "",
              pickupNeighborhood: sourceOrder.pickupNeighborhood || "",
              pickupCity: sourceOrder.pickupCity || "",
              pickupState: sourceOrder.pickupState || "",
              pickupPostalCode: sourceOrder.pickupPostalCode || "",
              pickupCountry: sourceOrder.pickupCountry || "Mexico",
              ...order,
              courierName: String(order?.courierName || selectedSnapshotCutoff.courierName || sourceOrder.courierName || "").trim(),
              currentStatus: order.currentStatus || order.status,
            };
            const historyEvents = filterCourierSnapshotHistoryEvents(
              courierSnapshotRouteTimeFallbackEvents(
                { ...orderWithCourierName, historyEvents: snapshotHistoryEvents },
                selectedSnapshotCutoff,
              ),
              selectedSnapshotCutoff,
            );
            const enrichedSnapshotHistoryEvents = enrichCourierHistoryEvents({
              events: historyEvents,
              request: {
                ...orderWithCourierName,
                branchPickupHistoryEvents: storedSnapshotHistoryEvents,
                unfilteredHistoryEvents: snapshotHistoryEvents,
              },
              activitiesByRequestId,
              transferActivityByRouteId: transferActivityByRouteIdForHistory,
            });
            return {
              ...orderWithCourierName,
              id,
              historyEvents: enrichedSnapshotHistoryEvents,
              branchPickupHistoryEvents: storedSnapshotHistoryEvents,
              unfilteredHistoryEvents: snapshotHistoryEvents,
              sequenceNumber: Number(
                snapshotRouteAssignmentSequenceByOrderId.get(id) || order?.sequenceNumber || index + 1,
              ),
            };
          })
          .sort((firstOrder, secondOrder) => Number(firstOrder.sequenceNumber || 0) - Number(secondOrder.sequenceNumber || 0));
        const selectedSnapshotRemainingCount = Math.max(
          0,
          Number(selectedSnapshot.remainingCount || 0) - hiddenSnapshotOrderIds.size,
        );
        const selectedDayLabel = new Intl.DateTimeFormat("es-MX", {
          dateStyle: "full",
          timeZone: "UTC",
        }).format(new Date(`${selectedDate}T12:00:00Z`));
        const branchReturnOrders = selectedSnapshotOrders.filter((order) =>
          isCourierBranchReturnOrder(order),
        );

        return (
          <div className={styles.courierHistoryDirectoryList}>
            <Link
              className={styles.courierHistoryBackLink}
              to={buildHistoryHref({ view: "courier", courierId: selectedCourierId })}
            >
              ← Regresar al calendario
            </Link>
            <div className={styles.courierHistoryHeader}>
              <div>
                <h3>{courier ? `Historial del repartidor ${courier.name}` : "Historial del repartidor"}</h3>
                <p className={styles.courierHistoryDateTitle}>{selectedDayLabel}</p>
              </div>
              <div className={styles.courierHistoryCounters}>
                {branchReturnOrders.length ? (
                  <button
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    type="button"
                    onClick={() => setShowBranchReturnOrders((current) => !current)}
                  >
                    Regresar a sucursal
                  </button>
                ) : null}
                <span className={styles.courierHistoryCounter}>Ordenes {selectedSnapshotOrders.length}</span>
                <span className={styles.courierHistoryCounter}>
                  Restantes {selectedSnapshotRemainingCount}
                </span>
              </div>
            </div>
            {showBranchReturnOrders && branchReturnOrders.length ? (
              <div className={styles.courierBranchReturnPanel}>
                <h4>Paquetes para regresar a sucursal</h4>
                <div className={styles.courierBranchReturnList}>
                  {branchReturnOrders.map((order) => (
                    <div className={styles.courierBranchReturnItem} key={`branch-return:${order.id}`}>
                      <strong>{isReturnCourierLabel(order.courierLabel) ? "Devolución" : "Entrega"} #{order.orderNumber}</strong>
                      <span>{order.customerName || "Cliente"}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {selectedSnapshotOrders.length ? (
              <div className={styles.courierGrid}>
                {selectedSnapshotOrders.map((order, index) => (
                  <CourierOrderCard
                    key={`${selectedSnapshot.routeId}:${order.id || index}`}
                    request={{
                      ...order,
                      ...orderTransferDetails(order, selectedTransferActivity, selectedRouteId),
                    }}
                    sequenceNumber={Number(order.sequenceNumber || index + 1)}
                    statusOverride={courierHistoryPendingStatusOverride(order)}
                    showFinalAttemptBadge
                    courierHistoryView
                  />
                ))}
              </div>
            ) : (
              <p>No hay ordenes registradas para este dia.</p>
            )}
          </div>
        );
      }
      const currentOrderIds = new Set(currentOrders.map((order) => String(order.id || "")));
      const selectedTransferActivity = transferActivityForRoute(selectedRouteId, selectedDate);
      const selectedDayActivities = courierActivities.filter((activity) => {
        if (mexicoActivityDateKey(activity.createdAt) !== selectedDate) return false;
        if (selectedRouteId) return activity.routeId === selectedRouteId;
        return !activity.routeId;
      });
      const latestFinalActivityByOrderId = new Map();
      const finalActivityAtByOrderId = new Map();
      const latestRouteActivityByOrderId = new Map();
      for (const activity of [...selectedDayActivities].sort(
        (firstActivity, secondActivity) =>
          new Date(firstActivity.createdAt || "").getTime() -
          new Date(secondActivity.createdAt || "").getTime(),
      )) {
        const requestId = String(activity.requestId || "");
        if (!requestId) continue;
        latestRouteActivityByOrderId.set(requestId, activity);
        if (isCourierFinalActivityAction(activity.action)) {
          latestFinalActivityByOrderId.set(requestId, activity);
          finalActivityAtByOrderId.set(requestId, new Date(activity.createdAt || "").getTime());
        }
      }
      const notLocatedOrderIds = new Set(
        selectedDayActivities
          .filter((activity) => String(activity.action || "").trim().toLowerCase() === "courier_route_order_not_located")
          .map((activity) => String(activity.requestId || "").trim())
          .filter(Boolean),
      );
      const routeAssignmentSequenceByOrderId = buildRouteAssignmentSequenceByOrderId(selectedRouteId);
      const selectedActivityOrders = [
        ...new Map(
          selectedDayActivities
            .map((activity) => orderByRequestId.get(String(activity.requestId || "")))
            .filter(Boolean)
          .map((order) => [String(order.id || ""), order]),
        ).values(),
      ];
      const baseDayOrders = (!selectedRouteId && selectedDate === todayDateKey
        ? todayOrders
        : selectedActivityOrders
      )
        .sort(compareCourierDisplayOrder);
      const routeSequenceOrders = [...baseDayOrders].sort((firstOrder, secondOrder) => {
        const firstId = String(firstOrder.id || "");
        const secondId = String(secondOrder.id || "");
        const firstIsFinalized = finalActivityAtByOrderId.has(firstId);
        const secondIsFinalized = finalActivityAtByOrderId.has(secondId);
        if (firstIsFinalized !== secondIsFinalized) return firstIsFinalized ? -1 : 1;
        if (!firstIsFinalized) return compareCourierDisplayOrder(firstOrder, secondOrder);

        const firstFinishedAt = finalActivityAtByOrderId.get(firstId) || 0;
        const secondFinishedAt = finalActivityAtByOrderId.get(secondId) || 0;
        if (firstFinishedAt !== secondFinishedAt) return firstFinishedAt - secondFinishedAt;
        return compareCourierDisplayOrder(firstOrder, secondOrder);
      });
      const sequenceByOrderId = new Map(
        routeSequenceOrders.map((order, index) => {
          const orderId = String(order.id || "");
          return [orderId, routeAssignmentSequenceByOrderId.get(orderId) || index + 1];
        }),
      );
      const selectedDayOrders = routeSequenceOrders
        .filter((order) => !notLocatedOrderIds.has(String(order.id || "").trim()))
        .map((order, index) => ({
          ...order,
          sequenceNumber: sequenceByOrderId.get(String(order.id || "")) || index + 1,
        }));
      const remainingOrdersCount = selectedDayOrders.filter((order) => {
        const orderId = String(order.id || "");
        const status = String(order?.status || "").trim().toLowerCase();
        return status !== "recoger_en_sucursal" && !latestFinalActivityByOrderId.has(orderId);
      }).length;
      const selectedDayLabel = new Intl.DateTimeFormat("es-MX", {
        dateStyle: "full",
        timeZone: "UTC",
      }).format(new Date(`${selectedDate}T12:00:00Z`));
      const branchReturnOrders = selectedDayOrders.filter((order) =>
        isCourierBranchReturnOrder(
          order,
          latestRouteActivityByOrderId.get(String(order.id || ""))?.action,
        ),
      );

      return (
        <div className={styles.courierHistoryDirectoryList}>
          <Link
            className={styles.courierHistoryBackLink}
            to={buildHistoryHref({ view: "courier", courierId: selectedCourierId })}
          >
            ← Regresar al calendario
          </Link>
          <div className={styles.courierHistoryHeader}>
            <div>
              <h3>{courier ? `Historial del repartidor ${courier.name}` : "Historial del repartidor"}</h3>
              <p className={styles.courierHistoryDateTitle}>{selectedDayLabel}</p>
            </div>
            <div className={styles.courierHistoryCounters}>
              {branchReturnOrders.length ? (
                <button
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  type="button"
                  onClick={() => setShowBranchReturnOrders((current) => !current)}
                >
                  Regresar a sucursal
                </button>
              ) : null}
              <span className={styles.courierHistoryCounter}>Ordenes {selectedDayOrders.length}</span>
              <span className={styles.courierHistoryCounter}>Restantes {remainingOrdersCount}</span>
            </div>
          </div>
          {showBranchReturnOrders && branchReturnOrders.length ? (
            <div className={styles.courierBranchReturnPanel}>
              <h4>Paquetes para regresar a sucursal</h4>
              <div className={styles.courierBranchReturnList}>
                {branchReturnOrders.map((order) => (
                  <div className={styles.courierBranchReturnItem} key={`branch-return:${order.id}`}>
                    <strong>{isReturnCourierLabel(order.courierLabel) ? "Devolución" : "Entrega"} #{order.orderNumber}</strong>
                    <span>{order.customerName || "Cliente"}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {selectedDayOrders.length ? (
            <div className={styles.courierGrid}>
              {selectedDayOrders.map((order, index) => (
                <CourierOrderCard
                  key={order.id}
                  request={{
                    ...order,
                    ...orderTransferDetails(order, selectedTransferActivity, selectedRouteId),
                  }}
                  sequenceNumber={sequenceByOrderId.get(String(order.id || "")) || index + 1}
                  statusOverride={
                    latestRouteActivityByOrderId.get(String(order.id || ""))?.action === "courier_route_order_assigned"
                      ? "pendiente"
                      : latestFinalActivityByOrderId.has(String(order.id || ""))
                      ? courierStatusFromActivityAction(
                          latestFinalActivityByOrderId.get(String(order.id || "")).action,
                          currentOrderIds.has(String(order.id || "")) && !isCourierRouteStatus(order.status)
                            ? "pendiente"
                            : order.status,
                        )
                      : currentOrderIds.has(String(order.id || "")) && !isCourierRouteStatus(order.status)
                        ? "pendiente"
                        : courierHistoryPendingStatusOverride(order)
                  }
                  showFinalAttemptBadge
                  courierHistoryView
                />
              ))}
            </div>
          ) : (
            <p>No hay ordenes registradas para este dia.</p>
          )}
        </div>
      );
    }

    return (
      <div className={styles.courierHistoryDirectoryList}>
        <Link className={styles.courierHistoryBackLink} to={buildHistoryHref()}>← Regresar</Link>
        <h3>{courier ? `Historial del repartidor ${courier.name}` : "Historial del repartidor"}</h3>
        {calendarItems.length ? (
          <div className={styles.courierCalendar}>
            {calendarItems.map((item) => {
              return (
                <Link
                  key={item.key}
                  className={styles.courierCalendarDay}
                  to={buildHistoryHref({
                    view: "courier_day",
                    courierId: selectedCourierId,
                    date: item.dateKey,
                    routeId: item.routeId,
                  })}
                >
                  {new Intl.DateTimeFormat("es-MX", { dateStyle: "full", timeZone: "UTC" }).format(new Date(`${item.dateKey}T12:00:00Z`))}
                  {item.transferActivity ? " · Ruta traspasada" : ""}
                </Link>
              );
            })}
          </div>
        ) : (
          <p>No hay actividad registrada para este repartidor.</p>
        )}
      </div>
    );
  }

  return (
    <div className={styles.courierHistoryDirectoryList}>
      {couriers.map((courier) => {
        return (
          <Link
            key={courier.id}
            className={`${styles.btn} ${styles.courierHistoryDirectorySummary}`}
            to={buildHistoryHref({ view: "courier", courierId: courier.id })}
          >
              Historial del repartidor {courier.name}
          </Link>
        );
      })}
      <Link
        className={`${styles.btn} ${styles.btnPrimary} ${styles.courierHistoryDirectorySummary}`}
        to={buildHistoryHref({ view: "all" })}
      >
          Historial de todas las ordenes
      </Link>
    </div>
  );
}

function CouriersSection({ couriers, isSubmitting }) {
  const transferFetcher = useFetcher();
  const [showForm, setShowForm] = useState(false);
  const [code, setCode] = useState("");
  const [transferCourierId, setTransferCourierId] = useState(null);
  const [transferName, setTransferName] = useState("");
  const isTransferSubmitting = transferFetcher.state !== "idle";

  useEffect(() => {
    if (!transferFetcher.data?.ok) return;
    setTransferCourierId(null);
    setTransferName("");
  }, [transferFetcher.data]);

  const generateCode = () => {
    setCode(String(Math.floor(100000 + Math.random() * 900000)));
  };

  return (
    <s-section heading="Repartidores">
      <div className={`${styles.wrap} ${styles.couriersLayout}`}>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          type="button"
          onClick={() => setShowForm((current) => !current)}
        >
          Agregar repartidor
        </button>

        {showForm ? (
          <Form method="post" className={`${styles.card} ${styles.courierCreateForm}`}>
            <input type="hidden" name="intent" value="create_courier" />
            <label className={styles.label}>
              Nombre del repartidor
              <input className={styles.input} name="name" required />
            </label>
            <div className={styles.courierCodeField}>
              <label className={styles.label}>
                Codigo unico
                <input
                  className={styles.input}
                  name="code"
                  value={code}
                  readOnly
                  required
                  placeholder="Genera un codigo de 6 digitos"
                />
              </label>
              <button className={styles.btn} type="button" onClick={generateCode}>
                Generar codigo
              </button>
            </div>
            <button
              className={`${styles.btn} ${styles.btnPrimary}`}
              type="submit"
              disabled={isSubmitting || !code}
            >
              Guardar
            </button>
          </Form>
        ) : null}

        <div className={styles.courierDirectory}>
          {couriers.map((courier) => (
            <details key={courier.id} className={styles.courierDirectoryCard}>
              <summary className={styles.courierDirectorySummary}>
                <span>Repartidor</span>
                <strong>{courier.name}</strong>
              </summary>
              <div className={styles.courierDirectoryCode}>
                <div>Codigo unico: <strong>{courier.code}</strong></div>
                <div className={styles.courierDirectoryActions}>
                  <Form
                    method="post"
                    action="/app/devoluciones/solicitudes/couriers"
                    onSubmit={(event) => {
                      if (!window.confirm(`¿Deseas dar de baja a ${courier.name}?`)) {
                        event.preventDefault();
                      }
                    }}
                  >
                    <input type="hidden" name="intent" value="delete_courier" />
                    <input type="hidden" name="courierId" value={courier.id} />
                    <button className={`${styles.btn} ${styles.btnDanger}`} type="submit" disabled={isSubmitting}>
                      Dar de baja
                    </button>
                  </Form>
                  <button
                    className={styles.btn}
                    type="button"
                    onClick={() => {
                      setTransferCourierId(courier.id);
                      setTransferName("");
                    }}
                  >
                    Transferir ruta
                  </button>
                </div>
                {transferCourierId === courier.id ? (
                  <transferFetcher.Form
                    method="post"
                    className={styles.courierTransferForm}
                    onSubmit={(event) => {
                      if (
                        !window.confirm(
                          `¿Confirmas transferir la ruta de ${courier.name} a ${transferName.trim()}?`,
                        )
                      ) {
                        event.preventDefault();
                      }
                    }}
                  >
                    <input type="hidden" name="intent" value="transfer_courier_route" />
                    <input type="hidden" name="courierId" value={courier.id} />
                    <label className={styles.label}>
                      Nombre del nuevo repartidor
                      <input
                        className={styles.input}
                        name="newCourierName"
                        value={transferName}
                        onChange={(event) => setTransferName(event.target.value)}
                        required
                      />
                    </label>
                    <div className={styles.courierDirectoryActions}>
                      <button
                        className={`${styles.btn} ${styles.btnPrimary}`}
                        type="submit"
                        disabled={isSubmitting || isTransferSubmitting || !transferName.trim()}
                      >
                        {isTransferSubmitting ? "Transfiriendo..." : "Listo"}
                      </button>
                      <button
                        className={styles.btn}
                        type="button"
                        onClick={() => {
                          setTransferCourierId(null);
                        }}
                      >
                        Cancelar
                      </button>
                    </div>
                  </transferFetcher.Form>
                ) : null}
              </div>
            </details>
          ))}
        </div>
        {transferFetcher.data?.error ? (
          <p className={styles.errorMsg}>{transferFetcher.data.error}</p>
        ) : null}
        {transferFetcher.data?.message ? (
          <p className={styles.successMsg}>{transferFetcher.data.message}</p>
        ) : null}
      </div>
    </s-section>
  );
}

function PreparersSection({
  preparers,
  preparerAssignments = [],
  courierOrders = [],
  routeOrdersPayload = [],
  isSubmitting,
}) {
  const location = useLocation();
  const createPreparerFetcher = useFetcher();
  const distributeFetcher = useFetcher();
  const transferPreparerFetcher = useFetcher();
  const [showForm, setShowForm] = useState(false);
  const [code, setCode] = useState("");
  const [showDistributeModal, setShowDistributeModal] = useState(false);
  const [selectedPreparerIds, setSelectedPreparerIds] = useState([]);
  const [transferPreparerId, setTransferPreparerId] = useState(null);
  const [transferPreparerName, setTransferPreparerName] = useState("");
  const [selectedPreparerAssignmentSummary, setSelectedPreparerAssignmentSummary] = useState(null);
  const [selectedPreparerHistory, setSelectedPreparerHistory] = useState(null);
  const [showDistributionMessage, setShowDistributionMessage] = useState(false);
  const preparersAction = `${location.pathname}${location.search || ""}`;
  const isCreatePreparerSubmitting = createPreparerFetcher.state !== "idle";
  const isDistributing = distributeFetcher.state !== "idle";
  const isTransferPreparerSubmitting = transferPreparerFetcher.state !== "idle";
  const selectedPreparerIdSet = new Set(selectedPreparerIds.map((preparerId) => String(preparerId)));
  const canDistributeOrders = selectedPreparerIds.length > 0 && courierOrders.length > 0 && !isSubmitting && !isDistributing;
  const preparerAssignmentOrderNumberValue = (assignment) => {
    const order = assignment.orderData && typeof assignment.orderData === "object" ? assignment.orderData : {};
    const orderNumber = String(order.orderNumber || assignment.orderNumber || "").replace(/\D/g, "");
    return Number(orderNumber || 0) || 0;
  };
  const preparerAssignmentStoredSequence = (assignment) => {
    const order = assignment.orderData && typeof assignment.orderData === "object" ? assignment.orderData : {};
    return Number(assignment.sequence || order.sequenceNumber || 0) || 0;
  };
  const comparePreparerAssignmentsForPortal = (first, second) =>
    preparerAssignmentOrderNumberValue(first) - preparerAssignmentOrderNumberValue(second) ||
    preparerAssignmentStoredSequence(first) - preparerAssignmentStoredSequence(second) ||
    Number(first.id || 0) - Number(second.id || 0);
  const globalSequenceByOrderNumber = new Map();
  [...courierOrders]
    .sort((firstOrder, secondOrder) => {
      const firstSequence = Number(firstOrder?.sequenceNumber || 0) || 0;
      const secondSequence = Number(secondOrder?.sequenceNumber || 0) || 0;
      const firstOrderNumber = Number(String(firstOrder?.orderNumber || "").replace(/\D/g, "") || 0) || 0;
      const secondOrderNumber = Number(String(secondOrder?.orderNumber || "").replace(/\D/g, "") || 0) || 0;
      return firstSequence - secondSequence || firstOrderNumber - secondOrderNumber;
    })
    .forEach((order, index) => {
      const orderNumber = String(order?.orderNumber || "").replace(/\D/g, "");
      if (orderNumber && !globalSequenceByOrderNumber.has(orderNumber)) {
        globalSequenceByOrderNumber.set(orderNumber, Number(order?.sequenceNumber || 0) || index + 1);
      }
    });
  const preparerAssignmentDisplaySequence = (assignment) => {
    const order = assignment.orderData && typeof assignment.orderData === "object" ? assignment.orderData : {};
    const orderNumber = String(order.orderNumber || assignment.orderNumber || "").replace(/\D/g, "");
    return globalSequenceByOrderNumber.get(orderNumber) || preparerAssignmentStoredSequence(assignment);
  };
  const todayMexicoKey = mexicoActivityDateKey(new Date());
  const todayPreparerHistoryLabel = new Intl.DateTimeFormat("es-MX", {
    timeZone: "America/Mexico_City",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date());
  const preparerCompletionTimeLabel = (value) => {
    if (!value || !Number.isFinite(new Date(value).getTime())) return "";
    return new Intl.DateTimeFormat("es-MX", {
      timeZone: "America/Mexico_City",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(value));
  };
  const preparerAssignmentDetail = (assignment) => {
    const order = assignment.orderData && typeof assignment.orderData === "object" ? assignment.orderData : {};
    const status = String(assignment.status || "").trim().toLowerCase();
    const isCompleted = status === "ready" || status === "not_located";
    const completedAt = isCompleted ? assignment.completedAt || assignment.updatedAt || "" : "";
    const completedMs = Number.isFinite(new Date(completedAt).getTime()) ? new Date(completedAt).getTime() : 0;
    const transferredAt = order.preparerTransferredAt || "";
    const transferredMs = Number.isFinite(new Date(transferredAt).getTime()) ? new Date(transferredAt).getTime() : 0;
    const transferredToName = String(order.preparerTransferredToName || "").trim();
    const showTransferredToName = Boolean(transferredToName && completedMs && transferredMs && completedMs >= transferredMs);
    return {
      rawAssignment: assignment,
      id: assignment.id,
      preparerId: String(assignment.preparerId || ""),
      preparerName: String(assignment.preparerName || "").trim() || "Preparador",
      sequence: preparerAssignmentDisplaySequence(assignment),
      orderNumber: String(order.orderNumber || assignment.orderNumber || "").trim() || "-",
      completedTimeLabel: completedMs ? preparerCompletionTimeLabel(completedAt) : "",
      transferredToName: showTransferredToName ? transferredToName : "",
      status:
        status === "not_located" && preparerNotLocatedScopeFromOrder(order) === "partial"
          ? "partial"
          : status,
    };
  };
  const allPreparerAssignmentDetails = preparerAssignments
    .filter((assignment) => {
      const order = assignment.orderData && typeof assignment.orderData === "object" ? assignment.orderData : {};
      return !isReturnCourierLabel(order.courierLabel);
    })
    .map(preparerAssignmentDetail)
    .sort(
      (first, second) =>
        first.sequence - second.sequence ||
        comparePreparerAssignmentsForPortal(first.rawAssignment, second.rawAssignment),
    );
  const activePreparerSummary = [...allPreparerAssignmentDetails.reduce((groups, assignment) => {
    const key = String(assignment.preparerId || assignment.preparerName || "").trim();
    if (!key) return groups;
    const current = groups.get(key) || {
      id: key,
      preparerName: assignment.preparerName,
      count: 0,
      orders: [],
    };
    current.count += 1;
    current.orders.push(assignment);
    groups.set(key, current);
    return groups;
  }, new Map()).values()];
  const completedPreparerAssignments = preparerAssignments
    .filter((assignment) => {
      const status = String(assignment.status || "").trim().toLowerCase();
      if (status !== "ready" && status !== "not_located") return false;
      const order = assignment.orderData && typeof assignment.orderData === "object" ? assignment.orderData : {};
      if (isReturnCourierLabel(order.courierLabel)) return false;
      const finishedAt = order.preparerSessionFinishedAt || "";
      if (!finishedAt || !Number.isFinite(new Date(finishedAt).getTime())) return false;
      if (mexicoActivityDateKey(finishedAt) !== todayMexicoKey) return false;
      const completedAt = assignment.completedAt || assignment.updatedAt;
      if (!completedAt || !Number.isFinite(new Date(completedAt).getTime())) return false;
      return mexicoActivityDateKey(completedAt) === todayMexicoKey;
    })
    .sort(comparePreparerAssignmentsForPortal)
    .map(preparerAssignmentDetail);
  const preparerHistoryById = completedPreparerAssignments.reduce((groups, assignment) => {
    const key = assignment.preparerId || assignment.preparerName;
    const current = groups.get(key) || {
      id: key,
      preparerName: assignment.preparerName,
      startSequence: 0,
      endSequence: 0,
      orders: [],
    };
    current.orders.push(assignment);
    groups.set(key, current);
    return groups;
  }, new Map());
  const preparerHistory = [...preparerHistoryById.values()]
    .map((history) => {
      const orders = history.orders
        .sort(
          (first, second) =>
            first.sequence - second.sequence ||
            comparePreparerAssignmentsForPortal(first.rawAssignment, second.rawAssignment),
        );
      return {
        ...history,
        orders,
        orderCount: orders.length,
        startSequence: orders[0]?.sequence || 0,
        endSequence: orders[orders.length - 1]?.sequence || 0,
      };
    })
    .sort((first, second) => first.startSequence - second.startSequence || first.preparerName.localeCompare(second.preparerName));
  useEffect(() => {
    if (!distributeFetcher.data?.ok) return;
    setShowDistributeModal(false);
    setSelectedPreparerIds([]);
    setShowDistributionMessage(true);
  }, [distributeFetcher.data]);

  useEffect(() => {
    if (!showDistributionMessage) return undefined;
    const timeoutId = window.setTimeout(() => setShowDistributionMessage(false), 3500);
    return () => window.clearTimeout(timeoutId);
  }, [showDistributionMessage]);

  useEffect(() => {
    if (!createPreparerFetcher.data?.ok || createPreparerFetcher.data?.intent !== "create_preparer") return;
    setShowForm(false);
    setCode("");
  }, [createPreparerFetcher.data]);

  useEffect(() => {
    if (!transferPreparerFetcher.data?.ok) return;
    setTransferPreparerId(null);
    setTransferPreparerName("");
  }, [transferPreparerFetcher.data]);

  const generateCode = () => {
    setCode(String(Math.floor(100000 + Math.random() * 900000)));
  };

  return (
    <s-section heading="Preparadores">
      <div className={`${styles.wrap} ${styles.couriersLayout}`}>
        <div className={styles.courierOrdersHeader}>
          <button
            className={`${styles.btn} ${styles.btnPrimary}`}
            type="button"
            onClick={() => setShowForm((current) => !current)}
          >
            Agregar preparador
          </button>
          <button
            className={`${styles.btn} ${styles.btnPrimary}`}
            type="button"
            disabled={isSubmitting || isDistributing || preparers.length === 0 || courierOrders.length === 0}
            onClick={() => {
              setSelectedPreparerIds([]);
              setShowDistributeModal(true);
            }}
          >
            Distribuir órdenes
          </button>
        </div>

        {activePreparerSummary.length ? (
          <div className={styles.preparerAssignmentSummaryList}>
            {activePreparerSummary.map((summary) => (
              <button
                key={summary.id}
                className={styles.preparerAssignmentSummaryBadge}
                type="button"
                onClick={() => setSelectedPreparerAssignmentSummary(summary)}
              >
                {summary.preparerName}: {summary.count} orden(es)
              </button>
            ))}
          </div>
        ) : null}

        {showForm ? (
          <createPreparerFetcher.Form method="post" action={preparersAction} className={`${styles.card} ${styles.courierCreateForm}`}>
            <input type="hidden" name="intent" value="create_preparer" />
            <label className={styles.label}>
              Nombre del preparador
              <input className={styles.input} name="name" required />
            </label>
            <div className={styles.courierCodeField}>
              <label className={styles.label}>
                Codigo unico
                <input
                  className={styles.input}
                  name="code"
                  value={code}
                  readOnly
                  required
                  placeholder="Genera un codigo de 6 digitos"
                />
              </label>
              <button className={styles.btn} type="button" onClick={generateCode}>
                Generar codigo
              </button>
            </div>
            <button
              className={`${styles.btn} ${styles.btnPrimary}`}
              type="submit"
              disabled={isSubmitting || isCreatePreparerSubmitting || !code}
            >
              Guardar
            </button>
          </createPreparerFetcher.Form>
        ) : null}

        <div className={styles.courierDirectory}>
          {preparers.map((preparer) => (
            <details key={preparer.id} className={styles.courierDirectoryCard}>
              <summary className={styles.courierDirectorySummary}>
                <span>Preparador</span>
                <strong>{preparer.name}</strong>
              </summary>
              <div className={styles.courierDirectoryCode}>
                <div>Codigo unico: <strong>{preparer.code}</strong></div>
                <div className={styles.courierDirectoryActions}>
                  <Form
                    method="post"
                    action={preparersAction}
                    onSubmit={(event) => {
                      if (!window.confirm(`¿Deseas dar de baja a ${preparer.name}?`)) {
                        event.preventDefault();
                      }
                    }}
                  >
                    <input type="hidden" name="intent" value="delete_preparer" />
                    <input type="hidden" name="preparerId" value={preparer.id} />
                    <button className={`${styles.btn} ${styles.btnDanger}`} type="submit" disabled={isSubmitting}>
                      Dar de baja
                    </button>
                  </Form>
                  <button
                    className={styles.btn}
                    type="button"
                    onClick={() => {
                      setTransferPreparerId(preparer.id);
                      setTransferPreparerName("");
                    }}
                    disabled={isSubmitting || isTransferPreparerSubmitting}
                  >
                    Transferir cuenta
                  </button>
                </div>
                {transferPreparerId === preparer.id ? (
                  <transferPreparerFetcher.Form
                    method="post"
                    action={preparersAction}
                    className={styles.courierTransferForm}
                    onSubmit={(event) => {
                      if (
                        !window.confirm(
                          `¿Confirmas transferir la cuenta de ${preparer.name} a ${transferPreparerName.trim()}?`,
                        )
                      ) {
                        event.preventDefault();
                      }
                    }}
                  >
                    <input type="hidden" name="intent" value="transfer_preparer_account" />
                    <input type="hidden" name="preparerId" value={preparer.id} />
                    <label className={styles.label}>
                      Nombre del nuevo preparador
                      <input
                        className={styles.input}
                        name="newPreparerName"
                        value={transferPreparerName}
                        onChange={(event) => setTransferPreparerName(event.target.value)}
                        required
                      />
                    </label>
                    <div className={styles.courierDirectoryActions}>
                      <button
                        className={`${styles.btn} ${styles.btnPrimary}`}
                        type="submit"
                        disabled={isSubmitting || isTransferPreparerSubmitting || !transferPreparerName.trim()}
                      >
                        {isTransferPreparerSubmitting ? "Transfiriendo..." : "Listo"}
                      </button>
                      <button
                        className={styles.btn}
                        type="button"
                        onClick={() => {
                          setTransferPreparerId(null);
                          setTransferPreparerName("");
                        }}
                      >
                        Cancelar
                      </button>
                    </div>
                  </transferPreparerFetcher.Form>
                ) : null}
              </div>
            </details>
          ))}
        </div>
        {transferPreparerFetcher.data?.error ? (
          <p className={styles.errorMsg}>{transferPreparerFetcher.data.error}</p>
        ) : null}
        {transferPreparerFetcher.data?.message ? (
          <p className={styles.successMsg}>{transferPreparerFetcher.data.message}</p>
        ) : null}
        <div className={`${styles.card} ${styles.preparerHistoryPanel}`}>
          <div className={styles.preparerHistoryHeader}>
            <h3>Historial de preparadores</h3>
            <span>Hoy {todayPreparerHistoryLabel}</span>
          </div>
          {preparerHistory.length ? (
            <div className={styles.preparerHistorySummaryList}>
              {preparerHistory.map((history) => (
                <button
                  key={history.id}
                  className={styles.preparerHistoryButton}
                  type="button"
                  onClick={() => setSelectedPreparerHistory(history)}
                >
                  <span>Preparó {history.preparerName} de la {history.startSequence} a la {history.endSequence}</span>
                  <strong>{history.orderCount} orden(es)</strong>
                </button>
              ))}
            </div>
          ) : (
            <p className={styles.noticeMuted}>No hay preparaciones finalizadas hoy.</p>
          )}
        </div>
        {distributeFetcher.data?.error ? (
          <p className={styles.errorMsg}>{distributeFetcher.data.error}</p>
        ) : null}
        {showDistributionMessage && distributeFetcher.data?.message ? (
          <p className={styles.successMsg}>{distributeFetcher.data.message}</p>
        ) : null}
      </div>
      {showDistributeModal ? (
        <div className={styles.courierRouteModalBackdrop} role="presentation">
          <div
            className={styles.courierRouteModal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="preparer-route-modal-title"
          >
            <div className={styles.courierRouteModalHeader}>
              <h3 id="preparer-route-modal-title">Selecciona preparadores</h3>
              <button
                className={styles.courierRouteModalClose}
                type="button"
                aria-label="Cerrar"
                onClick={() => setShowDistributeModal(false)}
              >
                x
              </button>
            </div>
            <p className={styles.courierRouteModalText}>
              Se distribuirán {courierOrders.length} orden(es) de forma equitativa y por bloques consecutivos.
            </p>
            <distributeFetcher.Form method="post" action={preparersAction} className={styles.courierRouteModalForm}>
              <input type="hidden" name="intent" value="plan_preparer_orders" />
              <input type="hidden" name="routeOrdersJson" value={JSON.stringify(routeOrdersPayload)} />
              {courierOrders.map((order) => (
                <input key={order.id} type="hidden" name="routeOrderIds" value={String(order.id || "")} />
              ))}
              <div className={styles.courierRouteCourierList}>
                {preparers.map((preparer) => {
                  const preparerId = String(preparer.id);
                  const isChecked = selectedPreparerIdSet.has(preparerId);
                  return (
                    <label key={preparer.id} className={styles.courierRouteCourierOption}>
                      <input
                        type="checkbox"
                        name="preparerIds"
                        value={preparerId}
                        checked={isChecked}
                        onChange={(event) => {
                          setSelectedPreparerIds((currentIds) =>
                            event.target.checked
                              ? [...currentIds, preparerId]
                              : currentIds.filter((currentId) => String(currentId) !== preparerId),
                          );
                        }}
                      />
                      <span>{preparer.name}</span>
                    </label>
                  );
                })}
              </div>
              <div className={styles.courierRouteModalActions}>
                <button
                  className={styles.btn}
                  type="button"
                  onClick={() => setShowDistributeModal(false)}
                  disabled={isSubmitting || isDistributing}
                >
                  Cancelar
                </button>
                <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={!canDistributeOrders}>
                  Confirmar distribucion
                </button>
              </div>
            </distributeFetcher.Form>
          </div>
        </div>
      ) : null}
      {selectedPreparerAssignmentSummary ? (
        <div className={styles.reasonModalOverlay} role="dialog" aria-modal="true" aria-label="Ordenes del preparador">
          <section className={`${styles.reasonModal} ${styles.preparerHistoryModal}`}>
            <div className={styles.courierRouteModalHeader}>
              <h3 id="preparer-assignment-summary-title">
                {selectedPreparerAssignmentSummary.preparerName}: {selectedPreparerAssignmentSummary.orders.length} orden(es)
              </h3>
              <button
                className={styles.courierRouteModalClose}
                type="button"
                aria-label="Cerrar"
                onClick={() => setSelectedPreparerAssignmentSummary(null)}
              >
                x
              </button>
            </div>
            <div className={styles.preparerHistoryOrderList}>
              {selectedPreparerAssignmentSummary.orders.map((order) => (
                <div key={order.id} className={styles.preparerHistoryOrderItem}>
                  <span className={styles.courierOrderSequence}>{order.sequence}</span>
                  <div className={styles.preparerHistoryOrderDetails}>
                    <strong>Orden #{order.orderNumber}</strong>
                    {order.transferredToName ? (
                      <span className={styles.preparerHistoryTransferMeta}>Traspasado a {order.transferredToName}</span>
                    ) : null}
                  </div>
                  <span className={styles.preparerHistoryOrderMeta}>
                    {order.completedTimeLabel ? `Listo ${order.completedTimeLabel}` : ""}
                  </span>
                  <span
                    className={`${styles.preparerHistoryMark} ${
                      order.status === "partial"
                        ? styles.preparerHistoryMarkPartial
                        : order.status === "not_located"
                          ? styles.preparerHistoryMarkMissing
                          : order.status === "ready"
                            ? styles.preparerHistoryMarkReady
                            : ""
                    }`}
                  >
                    {order.status === "partial" ? "-" : order.status === "not_located" ? "x" : order.status === "ready" ? "✓" : ""}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : null}
      {selectedPreparerHistory ? (
        <div className={styles.reasonModalOverlay} role="dialog" aria-modal="true" aria-label="Detalle de preparacion">
          <section className={`${styles.reasonModal} ${styles.preparerHistoryModal}`}>
            <div className={styles.courierRouteModalHeader}>
              <h3 id="preparer-history-title">
                Preparó {selectedPreparerHistory.preparerName} de la {selectedPreparerHistory.startSequence} a la{" "}
                {selectedPreparerHistory.endSequence}
              </h3>
              <button
                className={styles.courierRouteModalClose}
                type="button"
                aria-label="Cerrar"
                onClick={() => setSelectedPreparerHistory(null)}
              >
                x
              </button>
            </div>
            <div className={styles.preparerHistoryOrderList}>
              {selectedPreparerHistory.orders.map((order) => (
                <div key={order.id} className={styles.preparerHistoryOrderItem}>
                  <span className={styles.courierOrderSequence}>{order.sequence}</span>
                  <div className={styles.preparerHistoryOrderDetails}>
                    <strong>Orden #{order.orderNumber}</strong>
                    {order.transferredToName ? (
                      <span className={styles.preparerHistoryTransferMeta}>Traspasado a {order.transferredToName}</span>
                    ) : null}
                  </div>
                  <span className={styles.preparerHistoryOrderMeta}>
                    {order.completedTimeLabel ? `Listo ${order.completedTimeLabel}` : ""}
                  </span>
                  <span
                    className={`${styles.preparerHistoryMark} ${
                      order.status === "partial"
                        ? styles.preparerHistoryMarkPartial
                        : order.status === "not_located"
                          ? styles.preparerHistoryMarkMissing
                          : styles.preparerHistoryMarkReady
                    }`}
                  >
                    {order.status === "partial" ? "-" : order.status === "not_located" ? "x" : "✓"}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </s-section>
  );
}

function CourierOrderCard({
  request,
  sequenceNumber = 0,
  statusOverride = "",
  showFinalAttemptBadge = false,
  adminCourierView = false,
  hideTransferredCourierBadge = false,
  courierHistoryView = false,
  branchPickupView = false,
  branchPickupRefundTestMode = false,
  isSubmitting = false,
  onBranchPickupDeliver = null,
  onBranchPickupRefund = null,
  cardSuccessMessage = "",
}) {
  const [refundDetailOpen, setRefundDetailOpen] = useState(false);
  const finalAttempt = courierAttemptFromHistoryEvents(request.historyEvents, request.attemptCount);
  const courierRefundDetail = courierHistoryView ? latestCourierRefundDetail(request.courierActivities) : null;
  const hasCourierFullRefund = Boolean(courierRefundDetail?.fullRefund);
  const hasCourierPartialRefund = Boolean(courierRefundDetail && !courierRefundDetail.fullRefund);
  const visibleStatus = statusOverride || request.status;
  const normalizedVisibleStatus = String(visibleStatus || "").trim().toLowerCase();
  const isAdminReprogrammed =
    adminCourierView &&
    !showFinalAttemptBadge &&
    [
      "no_entregado",
      "no_recibido",
      "reintento_pendiente",
      "intento_fallido_1",
      "intento_fallido_2",
      "intento_fallido_3",
    ].includes(normalizedVisibleStatus);
  const isAdminPendingReturn =
    adminCourierView &&
    isReturnCourierLabel(request.courierLabel) &&
    normalizedVisibleStatus === "aprobada";
  const displayStatus = isAdminReprogrammed
    ? "reprogramado"
    : isAdminPendingReturn
      ? "pendiente"
      : visibleStatus;
  const retryAttemptNumber =
    isReturnCourierLabel(request.courierLabel) ? returnRetryAttemptNumber(request, normalizedVisibleStatus) : 0;
  const showReturnRetryAttemptBadge = false;
  const adminCourierPresentation = adminCourierView || branchPickupView
    ? buildAdminCourierPresentation(request)
    : { events: request.historyEvents || [], scheduledDate: null };
  const displayHistoryEvents = dedupeCourierHistoryEvents(adminCourierPresentation.events);
  const initialBranchPickupHistoryOrder =
    courierHistoryView &&
    !hasCourierFullRefund &&
    (
      isBranchPickupHistoryOrder(request, displayHistoryEvents) ||
      isBranchPickupHistoryOrder(request, request.historyEvents || [])
    );
  const latestReprogrammingEvent = latestCourierReprogrammingEvent(displayHistoryEvents);
  const isRouteTimeReprogrammed =
    Boolean(latestReprogrammingEvent?.routeTimeRescheduled) ||
    /falta de tiempo/i.test(String(latestReprogrammingEvent?.label || "")) ||
    /route_time_rescheduled/i.test(String(latestReprogrammingEvent?.note || ""));
  const isCourierHistoryReprogrammed =
    courierHistoryView && normalizedVisibleStatus === "reintento_pendiente";
  const filteredHistoryEvents = branchPickupView
    ? displayHistoryEvents.filter((event) => {
        const label = String(event?.label || "").trim();
        const note = String(event?.note || "").trim();
        return !/ruta traspasada|traspasad[ao]/i.test(`${label} ${note}`);
      })
    : courierHistoryView
      ? displayHistoryEvents.filter((event) => !isAttemptReprogrammingEvent(event))
      : displayHistoryEvents;
  const needsCourierRouteTimeFallback =
    courierHistoryView &&
    normalizedVisibleStatus === "reintento_pendiente" &&
    !filteredHistoryEvents.some((event) => isRouteTimeHistoryEvent(event));
  const hasAdminNotLocatedReprogramActivity = (request.courierActivities || []).some((activity) =>
    isAdminNotLocatedReprogramActivity(activity),
  );
  const courierRouteTimeFallbackDate = request.pickupDate
    ? formatCourierRescheduledDate(new Date(`${request.pickupDate}T12:00:00Z`))
    : "";
  const effectiveHistoryEvents = needsCourierRouteTimeFallback
    ? [
        ...filteredHistoryEvents,
        {
          id: `courier-history-route-time-fallback-${request.id || request.orderNumber || "order"}`,
          label: routeTimeReprogramLabel(courierRouteTimeFallbackDate, {
            adminNotLocatedReprogram: hasAdminNotLocatedReprogramActivity,
          }),
          at: request.finishedAt || request.courierHistoryAt || request.updatedAt || request.createdAt,
          atMs: parseEventMs(request.finishedAt || request.courierHistoryAt || request.updatedAt || request.createdAt),
          courierName: String(request.courierName || request.assignedCourierName || "").trim(),
          note: request.pickupDate ? `route_time_rescheduled:${request.pickupDate}` : "route_time_rescheduled",
          routeTimeRescheduled: true,
          adminNotLocatedReprogram: hasAdminNotLocatedReprogramActivity,
        },
      ].filter((event) => event.atMs || event.at)
    : filteredHistoryEvents;
  const baseDisplayHistoryItems = buildCourierHistoryDisplayItems(
    courierHistoryView && isReturnCourierLabel(request.courierLabel)
      ? normalizeReturnCourierHistoryEvents(effectiveHistoryEvents)
      : effectiveHistoryEvents,
    request,
    { hideTransferDetails: branchPickupView },
  );
  const preparerName = String(request.preparerName || "").trim();
  const preparedAt = request.preparedAt || "";
  const preparedHistoryItem =
    preparerName && preparedAt
      ? {
          id: `preparer-ready-${request.id || request.orderNumber || preparerName}`,
          label: `Preparado por ${preparerName}`,
          at: preparedAt,
          type: "preparer",
        }
      : null;
  const displayHistoryItems = preparedHistoryItem
    ? [preparedHistoryItem, ...baseDisplayHistoryItems]
    : baseDisplayHistoryItems;
  const branchPickupHistoryOrder =
    !hasCourierFullRefund &&
    (
      initialBranchPickupHistoryOrder ||
      (
        courierHistoryView &&
        (
          isBranchPickupHistoryOrder(request, effectiveHistoryEvents) ||
          displayHistoryItems.some((item) => isBranchPickupHistoryEvent(item))
        )
      )
    );
  const displayedScheduledDate =
    request.courierLabel === "Devolución"
      ? request.pickupDate
      : adminCourierPresentation.scheduledDate || request.pickupDate;
  const scheduledFieldLabel = branchPickupView || branchPickupHistoryOrder
    ? "Programado por recoger antes de:"
    : "Programado:";
  const scheduledFieldValue = branchPickupView || branchPickupHistoryOrder
    ? formatBranchPickupDeadlineDate(request, displayedScheduledDate)
    : formatCourierScheduledDate(displayedScheduledDate);
  const branchPickupFinalStatus = branchPickupHistoryOrder
    ? branchPickupFinalStatusLabel(request, effectiveHistoryEvents)
    : "";
  const isBranchPickupExpired = branchPickupView && isBranchPickupDeadlineExpired(request, displayedScheduledDate);
  const shouldShowBranchPickupRefund = isBranchPickupExpired || (branchPickupView && branchPickupRefundTestMode);
  const branchPickupActionRequest = branchPickupView
    ? { ...request, branchPickupDeadlineLabel: scheduledFieldValue }
    : request;
  const attemptBadgeClass = ["no_entregado", "rechazada", "no_recibido"].includes(normalizedVisibleStatus)
    ? courierHistoryView
      ? styles.courierBadgeStatusFailed
      : normalizedVisibleStatus === "rechazada"
      ? styles.courierBadgeAttemptWarning
      : styles.courierBadgeStatusFailed
    : styles.courierBadgeAttempt;
  const shouldShowFinalAttemptBadge =
    showFinalAttemptBadge &&
    !(courierHistoryView && isCourierHistoryReprogrammed && isRouteTimeReprogrammed);
  const statusBadgeClass = courierHistoryView && normalizedVisibleStatus === "pendiente"
    ? styles.courierBadgeStatusPending
    : normalizedVisibleStatus === "no_localizado"
      ? request.preparerReprogrammedNotLocated
        ? styles.courierBadgeStatusNotLocatedReprogrammed
        : request.preparerNotLocatedScope === "partial"
          ? styles.courierBadgeStatusNotLocatedPartial
          : request.preparerNotLocatedScope === "full"
            ? styles.courierBadgeStatusNotLocatedFull
            : styles.courierBadgeStatusNotLocated
    : ["entregado", "recibido", "recibida", "reembolsada"].includes(normalizedVisibleStatus)
      ? styles.courierBadgeStatusSuccess
    : courierHistoryView && isCourierHistoryReprogrammed && isRouteTimeReprogrammed
      ? styles.courierBadgeStatusTimeReprogrammed
    : courierHistoryView && ["no_entregado", "rechazada", "no_recibido"].includes(normalizedVisibleStatus)
      ? styles.courierBadgeStatusFailed
    : courierHistoryView
      ? styles.courierBadgeStatusHistoryWarning
    : isAdminReprogrammed
      ? isRouteTimeReprogrammed
      ? styles.courierBadgeStatusTimeReprogrammed
      : styles.courierBadgeStatusReprogrammed
    : branchPickupView && normalizedVisibleStatus === "recoger_en_sucursal"
      ? styles.courierBadgeStatusBranchPickup
    : ["no_entregado", "rechazada", "no_recibido"].includes(normalizedVisibleStatus)
      ? courierHistoryView
        ? styles.courierBadgeStatusHistoryWarning
        : styles.courierBadgeStatusFailed
      : normalizedVisibleStatus.startsWith("en_ruta")
        ? styles.courierBadgeStatusRoute
        : "";
  return (
    <>
      {cardSuccessMessage ? <p className={styles.successMsg}>{cardSuccessMessage}</p> : null}
      <article
        className={`${styles.courierCard} ${
          isReturnCourierLabel(request.courierLabel) ? styles.courierCardReturn : styles.courierCardDelivery
        } ${courierHistoryView ? styles.courierCardCompactHistory : ""}`}
      >
      <div className={styles.courierHeader}>
        <div className={styles.courierOrderBadgeGroup}>
          {sequenceNumber > 0 ? (
            <span className={styles.courierOrderSequence}>{sequenceNumber}</span>
          ) : null}
          <span
            className={
              isReturnCourierLabel(request.courierLabel)
                ? styles.courierBadgeReturn
                : styles.courierBadgeDelivery
            }
          >
            {request.courierLabel}
          </span>
          {request.transferredCourierName && !hideTransferredCourierBadge ? (
            <span className={styles.courierBadgeAttempt}>
              Ruta traspasada a {request.transferredCourierName}
            </span>
          ) : null}
        </div>
        <div className={styles.courierStatusGroup}>
          {hasCourierPartialRefund ? (
            <button
              className={`${styles.courierBadgeStatus} ${styles.courierBadgeButton} ${styles.courierBadgeStatusPartialRefund}`}
              type="button"
              onClick={() => setRefundDetailOpen(true)}
            >
              parcialmente reembolsado
            </button>
          ) : null}
          {shouldShowFinalAttemptBadge && (finalAttempt > 0 || hasCourierFullRefund) ? (
            <span className={`${styles.courierBadgeStatus} ${attemptBadgeClass}`}>
              {hasCourierFullRefund ? "0 intentos" : courierAttemptCountLabel(finalAttempt)}
            </span>
          ) : null}
          {showReturnRetryAttemptBadge ? (
            <span className={`${styles.courierBadgeStatus} ${styles.courierBadgeAttempt}`}>
              {courierAttemptBadgeLabel(retryAttemptNumber)}
            </span>
          ) : null}
          {hasCourierFullRefund ? (
            <button
              className={`${styles.courierBadgeStatus} ${styles.courierBadgeButton} ${styles.courierBadgeStatusSuccess}`}
              type="button"
              onClick={() => setRefundDetailOpen(true)}
            >
              reembolsado
            </button>
          ) : (
            <span className={`${styles.courierBadgeStatus} ${statusBadgeClass}`}>
              {isAdminReprogrammed ? displayStatus : courierHistoryStatusLabel(displayStatus)}
            </span>
          )}
        </div>
      </div>
      {branchPickupFinalStatus ? (
        <div className={styles.courierFinalStatusRow}>
          <span className={`${styles.courierBadgeStatus} ${styles.courierBadgeStatusSuccess}`}>
            {branchPickupFinalStatus}
          </span>
        </div>
      ) : null}
      <h3 className={styles.courierOrderNumber}>#{request.orderNumber}</h3>
      <p className={styles.courierCustomerName}>{request.customerName}</p>
      <p className={styles.courierField}>
        <strong>{scheduledFieldLabel}</strong> {scheduledFieldValue}
      </p>
      <p className={styles.courierAddress}>{formatCourierAddress(request)}</p>
      {branchPickupView ? (
        <div className={styles.branchPickupPhoneRow}>
          <p className={styles.courierField}>{request.customerPhone || "-"}</p>
          <button
            className={`${styles.btn} ${
              shouldShowBranchPickupRefund ? styles.btnDanger : styles.btnSuccess
            } ${styles.branchPickupDeliverButton}`}
            type="button"
            disabled={isSubmitting}
            onClick={() =>
              shouldShowBranchPickupRefund
                ? onBranchPickupRefund?.(branchPickupActionRequest)
                : onBranchPickupDeliver?.(branchPickupActionRequest)
            }
          >
            {shouldShowBranchPickupRefund ? "Reembolsar" : "Entregar"}
          </button>
        </div>
      ) : (
        <p className={styles.courierField}>{request.customerPhone || "-"}</p>
      )}
      <details className={styles.courierHistoryDetails}>
        <summary className={styles.courierHistorySummary}>Ver más ↓</summary>
        <div className={styles.courierHistoryList}>
          {displayHistoryItems.length ? (
            displayHistoryItems.map((item) =>
              item.type === "heading" ? (
                <div key={item.id} className={styles.courierHistoryAttemptHeader}>
                  <strong>{item.label}</strong>
                </div>
              ) : (
                <div
                  key={item.id}
                  className={`${styles.courierHistoryItem} ${
                    item.type === "preparer" ? styles.courierHistoryPreparerItem : ""
                  }`}
                >
                  <strong>{item.label}</strong>
                  <span>{formatCourierHistoryDate(item.at)}</span>
                </div>
              ),
            )
          ) : (
            <div className={styles.courierHistoryItem}>
              <strong>Sin acciones registradas todavía</strong>
            </div>
          )}
        </div>
      </details>
      {refundDetailOpen && courierRefundDetail ? (
        <div className={styles.reasonModalOverlay} role="dialog" aria-modal="true">
          <div className={`${styles.reasonModal} ${styles.courierRefundDetailModal}`}>
            <h3 className={styles.reasonModalTitle}>
              {courierRefundDetail.fullRefund ? "Reembolso completo" : "Reembolso parcial"}
            </h3>
            <p className={styles.reasonOptionText}>
              Pedido #{courierRefundDetail.orderNumber || request.orderNumber} ·{" "}
              {formatCourierHistoryDate(courierRefundDetail.refundedAt || courierRefundDetail.createdAt)}
            </p>
            <div className={styles.courierRefundDetailList}>
              {(courierRefundDetail.items || []).length ? (
                courierRefundDetail.items.map((item, index) => {
                  const quantity = Math.max(1, Number(item.quantity || 1));
                  const currency = String(courierRefundDetail.currencyCode || "MXN").trim().toUpperCase() || "MXN";
                  const matchingRequestItem = (request.items || []).find((requestItem) => {
                    const itemLineId = String(item.lineItemId || "").trim();
                    const requestLineId = String(requestItem.lineItemId || "").trim();
                    if (itemLineId && requestLineId && itemLineId === requestLineId) return true;
                    return (
                      String(item.title || "").trim().toLowerCase() &&
                      String(item.title || "").trim().toLowerCase() ===
                        String(requestItem.title || "").trim().toLowerCase()
                    );
                  });
                  const variantSummary = String(item.variantSummary || matchingRequestItem?.variantSummary || "").trim();
                  return (
                    <div key={`${item.lineItemId || item.title || "item"}-${index}`} className={styles.courierRefundDetailItem}>
                      <span>
                        <strong>{item.title || "Producto"}</strong>
                        {quantity > 1 ? <em> x{quantity}</em> : null}
                        {variantSummary ? <small>{variantSummary}</small> : null}
                      </span>
                      <strong>${toMoney(item.total || item.unitPrice || 0)} {currency}</strong>
                    </div>
                  );
                })
              ) : (
                <div className={styles.courierRefundDetailItem}>
                  <span>Productos reembolsados</span>
                  <strong>${toMoney(courierRefundDetail.amount)} {courierRefundDetail.currencyCode || "MXN"}</strong>
                </div>
              )}
            </div>
            <div className={styles.courierRefundDetailTotal}>
              <span>Total reembolsado</span>
              <strong>${toMoney(courierRefundDetail.amount)} {courierRefundDetail.currencyCode || "MXN"}</strong>
            </div>
            <div className={styles.courierRefundNotificationBox}>
              <strong>Notificación enviada</strong>
              <span>{formatCourierHistoryDate(courierRefundDetail.notificationSentAt || courierRefundDetail.refundedAt)}</span>
              {courierRefundDetail.notificationTitle ? <p>{courierRefundDetail.notificationTitle}</p> : null}
              {courierRefundDetail.notificationMessage ? <pre>{courierRefundDetail.notificationMessage}</pre> : null}
            </div>
            <div className={styles.reasonModalActions}>
              <button className={styles.btn} type="button" onClick={() => setRefundDetailOpen(false)}>
                Cerrar
              </button>
            </div>
          </div>
        </div>
      ) : null}
      </article>
    </>
  );
}

function RequestCard({
  request,
  isSubmitting,
  enableLazyMedia = false,
  hideCourierProgress = false,
  hideCourierRouteStarts = false,
  hidePendingReturnStatus = false,
  useRefundQueueDateFormat = false,
  useRefundQueueDateTimeSummary = false,
  hideInRouteAction = false,
  hidePickupActions = false,
  showPickupRescheduleStatus = false,
  showPickupDateSummary = false,
  branchDeliveryTestMode = false,
  forceShowNotReturnedAction = false,
  cardSuccessMessage = "",
  onRefundActionSuccess = null,
}) {
  const [viewerImage, setViewerImage] = useState(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [mediaRequested, setMediaRequested] = useState(false);
  const [lazyMediaByItemId, setLazyMediaByItemId] = useState({});
  const [pickupAttemptReason, setPickupAttemptReason] = useState("");
  const [isPickupReasonModalOpen, setIsPickupReasonModalOpen] = useState(false);
  const [rejectAfterFailedReason, setRejectAfterFailedReason] = useState("");
  const [isRejectAfterFailedReasonModalOpen, setIsRejectAfterFailedReasonModalOpen] = useState(false);
  const mediaFetcher = useFetcher();
  const location = useLocation();
  const currentFormAction = `${location.pathname}${location.search}`;
  const timelineEvents = detailsOpen
    ? buildStatusTimeline(request, hideCourierProgress, { hideCourierRouteStarts, hidePendingReturnStatus })
    : [];
  const currentTimelineEvent = timelineEvents[0] || null;
  const olderTimelineEvents = timelineEvents.slice(1).filter((event) => String(event.note || "").trim());
  const internalStatus = String(request.status || "").toLowerCase();
  const status = internalStatus === "en_ruta" || internalStatus.startsWith("en_ruta_") ? "aprobada" : internalStatus;
  const isPickupMethod = request.returnMethod === "pickup";
  const isPickupFailedAttempt = isPickupFailedAttemptStatus(status);
  const canMarkInRoute = isPickupMethod && status === "aprobada" && !hideInRouteAction;
  const canMarkReceived = status === "aprobada" || status === "en_ruta" || isPickupFailedAttempt;
  const canMarkNeverArrived =
    !isPickupMethod && status === "aprobada" && (Boolean(request.isBranchDeliveryDeadlineExpired) || branchDeliveryTestMode);
  const canRegisterPickupFailedAttempt =
    isPickupMethod && (status === "aprobada" || status === "en_ruta" || status === "intento_fallido_1");
  const canRejectAfterFailedPickups = isPickupMethod && status === "intento_fallido_2";
  const canMarkReturnedToCustomer = status === "por_devolver";
  const pendingReturnSinceMs = new Date(request.returnToCustomerSortAt || request.updatedAt || request.createdAt || 0).getTime();
  const notReturnedDeadlineMs = Number.isFinite(pendingReturnSinceMs)
    ? pendingReturnSinceMs + NOT_RETURNED_ACTION_DEADLINE_DAYS * 24 * 60 * 60 * 1000
    : 0;
  const isNotReturnedActionAvailable =
    Boolean(notReturnedDeadlineMs) && new Date().getTime() > notReturnedDeadlineMs;
  const canMarkNotReturned =
    status === "por_devolver" && (Boolean(isNotReturnedActionAvailable) || Boolean(forceShowNotReturnedAction));
  const remainingPickupAttempts = status === "aprobada" ? 2 : status === "intento_fallido_1" ? 1 : 0;
  const failedAttemptButtonLabel =
    remainingPickupAttempts === 1
      ? "Intento de recoleccion fallido (te queda 1)"
      : `Intento de recoleccion fallido (te quedan ${remainingPickupAttempts})`;
  const statusClassName = styles[getStatusClassName(status)];
  const pickupRescheduleAttempt = showPickupRescheduleStatus ? pickupRescheduleAttemptLabel(status) : "";
  const isDeniedReturnedToCustomer = status === "reembolso_denegado" && request.wasReturnedToCustomer;
  const isHistoryStatus = HISTORY_STATUSES.has(status);
  const renderedItems = request.items.map((item) => {
    const lazyMedia = lazyMediaByItemId[item.id] || {};
    return {
      ...item,
      imageUrl: lazyMedia.imageUrl || item.imageUrl || "",
      imageAlt: lazyMedia.imageAlt || item.imageAlt || "",
      variantSummary: lazyMedia.variantSummary || item.variantSummary || "",
      photoDataUrl: lazyMedia.photoDataUrl || item.photoDataUrl || "",
    };
  });

  useEffect(() => {
    if (!enableLazyMedia || !detailsOpen || mediaRequested) return;
    const hasMissingMedia = request.items.some((item) => !item.imageUrl || !item.photoDataUrl);
    if (!hasMissingMedia) return;
    const payload = new FormData();
    payload.set("intent", "load_request_media");
    payload.set("id", String(request.id));
    mediaFetcher.submit(payload, { method: "post" });
    setMediaRequested(true);
  }, [detailsOpen, enableLazyMedia, mediaFetcher, mediaRequested, request.id, request.items]);

  useEffect(() => {
    if (!mediaFetcher.data?.ok || mediaFetcher.data?.intent !== "load_request_media") return;
    const items = Array.isArray(mediaFetcher.data.mediaItems) ? mediaFetcher.data.mediaItems : [];
    const nextMediaById = {};
    for (const item of items) {
      nextMediaById[item.id] = {
        imageUrl: item.imageUrl || "",
        imageAlt: item.imageAlt || "",
        variantSummary: item.variantSummary || "",
        photoDataUrl: item.photoDataUrl || "",
      };
    }
    setLazyMediaByItemId(nextMediaById);
  }, [mediaFetcher.data]);

  useEffect(() => {
    // After submitting a failed-pickup attempt, request status/updatedAt changes.
    // Reset the field so the next attempt starts with a clean message.
    setPickupAttemptReason("");
    setIsPickupReasonModalOpen(false);
  }, [request.status, request.updatedAt, request.id]);

  return (
    <>
      {cardSuccessMessage ? <p className={styles.successMsg}>{cardSuccessMessage}</p> : null}
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
            ) : pickupRescheduleAttempt ? (
              <>reprogramado · {pickupRescheduleAttempt}</>
            ) : (
              STATUS_LABEL[status] || status
            )}
          </strong>
        </span>
      </div>

      <details className={styles.details} onToggle={(event) => setDetailsOpen(event.currentTarget.open)}>
        <summary className={styles.summary}>Ver orden</summary>
        {detailsOpen ? (
          <>

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
            <span className={styles.kvVal}>
              {showPickupDateSummary && isPickupMethod
                ? formatRefundQueueDate(request.createdAt)
                : isHistoryStatus && useRefundQueueDateFormat
                ? formatRefundQueueDate(request.createdAt)
                : useRefundQueueDateTimeSummary
                ? formatRefundQueueDateTime(request.createdAt)
                : useRefundQueueDateFormat
                  ? formatRefundQueueDate(request.createdAt)
                  : new Date(request.createdAt).toLocaleString("es-MX")}
            </span>
          </div>
          {showPickupDateSummary && isPickupMethod ? (
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Dia de recoleccion</span>
              <span className={styles.kvVal}>
                {useRefundQueueDateFormat ? formatRefundQueueDate(request.pickupDate) : request.pickupDate || "-"}
              </span>
            </div>
          ) : null}
          {!isPickupMethod && request.branchDeliveryDeadlineAt ? (
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Fecha limite de entrega</span>
              <span className={styles.kvVal}>
                {useRefundQueueDateFormat
                  ? formatRefundQueueDate(request.branchDeliveryDeadlineAt)
                  : new Date(request.branchDeliveryDeadlineAt).toLocaleDateString("es-MX")}
              </span>
            </div>
          ) : null}
          {request.receivedAt ? (
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Recibida</span>
              <span className={styles.kvVal}>
                {isHistoryStatus && useRefundQueueDateFormat
                  ? formatRefundQueueDate(request.receivedAt)
                  : useRefundQueueDateTimeSummary
                  ? formatRefundQueueDateTime(request.receivedAt)
                  : useRefundQueueDateFormat
                    ? formatRefundQueueDate(request.receivedAt)
                    : new Date(request.receivedAt).toLocaleString("es-MX")}
              </span>
            </div>
          ) : null}
          {request.returnedToCustomerAt ? (
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Devuelta al cliente</span>
              <span className={styles.kvVal}>
                {isHistoryStatus && useRefundQueueDateFormat
                  ? formatRefundQueueDate(request.returnedToCustomerAt)
                  : useRefundQueueDateTimeSummary || useRefundQueueDateFormat
                  ? formatRefundQueueDateTime(request.returnedToCustomerAt)
                  : new Date(request.returnedToCustomerAt).toLocaleString("es-MX")}
              </span>
            </div>
          ) : null}
          {request.refundedAt ? (
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Reembolsado</span>
              <span className={styles.kvVal}>
                {useRefundQueueDateTimeSummary || useRefundQueueDateFormat
                  ? formatRefundQueueDateTime(request.refundedAt)
                  : new Date(request.refundedAt).toLocaleString("es-MX")}
              </span>
            </div>
          ) : null}
          {request.pickupDeadlineAt && status !== "no_devuelto" ? (
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Fecha limite para recoger</span>
              <span className={styles.kvVal}>
                {useRefundQueueDateFormat ? formatRefundQueueDate(request.pickupDeadlineAt) : new Date(request.pickupDeadlineAt).toLocaleString("es-MX")}
              </span>
            </div>
          ) : null}
        </div>

        {currentTimelineEvent ? (
          <div className={styles.statusTimelineCurrent}>
            <p className={styles.statusTimelineTitle}>Estado actual</p>
            <p className={styles.statusTimelineCurrentLine}>
              <strong className={timelineToneClassName(currentTimelineEvent.tone)}>{currentTimelineEvent.label}</strong>{" "}
              <span>
                {useRefundQueueDateFormat || isHistoryStatus
                  ? formatRefundQueueDateTime(currentTimelineEvent.at)
                  : new Date(currentTimelineEvent.at).toLocaleString("es-MX")}
              </span>
            </p>
            {currentTimelineEvent.note ? (
              <p className={styles.statusTimelineItemNote}>{currentTimelineEvent.note}</p>
            ) : null}
          </div>
        ) : null}
        {olderTimelineEvents.length ? (
          <div className={styles.statusTimelineList}>
            {olderTimelineEvents.map((event) => (
              <div key={event.id} className={styles.statusTimelineItem}>
                <p className={`${styles.statusTimelineItemTitle} ${timelineToneClassName(event.tone)}`}>{event.label}</p>
                <p className={styles.statusTimelineItemAt}>
                  {useRefundQueueDateFormat || isHistoryStatus
                    ? formatRefundQueueDateTime(event.at)
                    : new Date(event.at).toLocaleString("es-MX")}
                </p>
                {event.note ? <p className={styles.statusTimelineItemNote}>{event.note}</p> : null}
              </div>
            ))}
          </div>
        ) : null}

        {request.returnMethod === "pickup" ? (
          <p className={styles.meta}>
            Recoleccion:{" "}
            {[request.pickupAddress, request.pickupCity, request.pickupState, request.pickupPostalCode]
              .filter(Boolean)
              .join(", ") || "-"}
            {showPickupDateSummary ? "" : ` | Dia: ${useRefundQueueDateFormat ? formatRefundQueueDate(request.pickupDate) : request.pickupDate || "-"}`}
            {request.pickupNotes ? ` | Notas: ${request.pickupNotes}` : ""}
          </p>
        ) : (
          <p className={styles.meta}>
            Sucursal: {request.branchAddress || "-"} | Horarios: {request.branchHours || "-"}
          </p>
        )}

        {(!timelineEvents.length && request.reasonEntries?.length) ? (
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

        {detailsOpen && enableLazyMedia && mediaFetcher.state !== "idle" ? (
          <p className={styles.meta}>Cargando imagenes...</p>
        ) : null}

        <h4 className={styles.orderDetailTitle}>Productos, motivos, fotos y descripcion</h4>
        <ul className={styles.productList}>
          {renderedItems.map((item) => {
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
                        loading="lazy"
                        decoding="async"
                      />
                    </button>
                  ) : (
                    <div className={styles.productThumbPlaceholder} />
                  )}
                  <div className={styles.productCopy}>
                    <p className={styles.productLineTitle}>
                      {item.title} x{item.quantity}
                    </p>
                    {item.variantSummary ? <p className={styles.productLineMeta}>Variante: {item.variantSummary}</p> : null}
                    <p className={styles.productLineMeta}>Motivo: {item.reason}</p>
                  </div>
                </div>
                {item.details ? <p className={styles.productLineDetails}><strong>Descripcion:</strong> {item.details}</p> : null}
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
                          loading="lazy"
                          decoding="async"
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
          </>
        ) : null}
      </details>

      {status === "por_devolver" && request.pickupDeadlineAt ? (
        <p className={styles.meta}>
          Fecha limite para recoger en sucursal: {useRefundQueueDateFormat ? formatRefundQueueDate(request.pickupDeadlineAt) : new Date(request.pickupDeadlineAt).toLocaleString("es-MX")}
        </p>
      ) : null}

      <div className={styles.actionRow}>
        {status === "en_revision" ? (
          <>
            <Form
              method="post"
              action={currentFormAction}
              onSubmit={(event) => {
                const orderLabel = request.orderNumber ? ` #${request.orderNumber}` : "";
                const confirmed = window.confirm(
                  `Estas seguro de aprobar la solicitud del pedido${orderLabel}?`,
                );
                if (!confirmed) event.preventDefault();
              }}
            >
              <input type="hidden" name="intent" value="approve_request" />
              <input type="hidden" name="id" value={request.id} />
              <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={isSubmitting}>
                Aprobar
              </button>
            </Form>
            <Form
              method="post"
              action={currentFormAction}
              className={styles.rejectForm}
              onSubmit={(event) => {
                const orderLabel = request.orderNumber ? ` #${request.orderNumber}` : "";
                const confirmed = window.confirm(
                  `Estas seguro de rechazar la devolucion del pedido${orderLabel}?`,
                );
                if (!confirmed) event.preventDefault();
              }}
            >
              <input type="hidden" name="intent" value="reject_request" />
              <input type="hidden" name="id" value={request.id} />
              <textarea
                className={`${styles.textarea} ${styles.rejectReasonTextarea}`}
                name="rejectionReason"
                placeholder="Motivo de rechazo (obligatorio)"
                defaultValue=""
                rows={1}
                onInput={(event) => {
                  const field = event.currentTarget;
                  field.style.height = "auto";
                  field.style.height = `${Math.min(field.scrollHeight, 112)}px`;
                }}
              />
              <button className={`${styles.btn} ${styles.btnDanger}`} type="submit" disabled={isSubmitting}>
                Rechazar
              </button>
            </Form>
          </>
        ) : null}

        {canMarkInRoute ? (
          <Form method="post" action={currentFormAction}>
            <input type="hidden" name="intent" value="mark_in_route" />
            <input type="hidden" name="id" value={request.id} />
            <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={isSubmitting}>
              En ruta
            </button>
          </Form>
        ) : null}

        {canMarkReceived && !hidePickupActions ? (
          <Form
            method="post"
            action={currentFormAction}
            onSubmit={(event) => {
              if (!window.confirm(`¿Confirmas marcar como recibida la devolución del pedido #${request.orderNumber}?`)) {
                event.preventDefault();
              }
            }}
          >
            <input type="hidden" name="intent" value="mark_received" />
            <input type="hidden" name="id" value={request.id} />
            <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={isSubmitting}>
              Marcar como recibida
            </button>
          </Form>
        ) : null}

        {canMarkNeverArrived ? (
          <Form
            method="post"
            action={currentFormAction}
            className={styles.actionRight}
            onSubmit={(event) => {
              if (!window.confirm(`¿Confirmas marcar como nunca llegó el pedido #${request.orderNumber}?`)) {
                event.preventDefault();
              }
            }}
          >
            <input type="hidden" name="intent" value="mark_never_arrived" />
            <input type="hidden" name="id" value={request.id} />
            <input type="hidden" name="branchDeliveryTestMode" value={branchDeliveryTestMode ? "1" : "0"} />
            <button className={`${styles.btn} ${styles.btnDanger}`} type="submit" disabled={isSubmitting}>
              Nunca llego
            </button>
          </Form>
        ) : null}
        {canRegisterPickupFailedAttempt && !hidePickupActions ? (
          <>
            <Form
              key={`pickup-attempt-${request.id}-${new Date(request.updatedAt).toISOString()}`}
              method="post" action={currentFormAction}
              className={styles.rejectForm}
            >
              <input type="hidden" name="intent" value="pickup_attempt_failed" />
              <input type="hidden" name="id" value={request.id} />
              <div className={styles.quickReasonActions}>
                <button
                  className={`${styles.btn} ${styles.quickReasonBtn} ${styles.quickReasonOpenBtn}`}
                  type="button"
                  onClick={() => setIsPickupReasonModalOpen(true)}
                  disabled={isSubmitting}
                >
                  Elegir mensaje
                </button>
              </div>
              <textarea
                className={styles.textarea}
                name="rejectionReason"
                placeholder="Descripcion del intento fallido (obligatoria)"
                value={pickupAttemptReason}
                onChange={(event) => setPickupAttemptReason(event.target.value)}
              />
              <button className={`${styles.btn} ${styles.btnWarning}`} type="submit" disabled={isSubmitting}>
                {failedAttemptButtonLabel}
              </button>
            </Form>

            {isPickupReasonModalOpen ? (
              <div className={styles.reasonModalOverlay} role="dialog" aria-modal="true" aria-label="Seleccion de mensaje">
                <div className={styles.reasonModal}>
                  <p className={styles.reasonModalTitle}>Selecciona un mensaje completo</p>
                  {PICKUP_FAILED_REASON_OPTIONS.map((option, index) => (
                    <button
                      key={`pickup_reason_${index}`}
                      type="button"
                      className={styles.reasonOptionCard}
                      onClick={() => {
                        setPickupAttemptReason(option);
                        setIsPickupReasonModalOpen(false);
                      }}
                      disabled={isSubmitting}
                    >
                      <span className={styles.reasonOptionLabel}>Mensaje automatico {index + 1}</span>
                      <span className={styles.reasonOptionText}>{option}</span>
                    </button>
                  ))}
                  <div className={styles.reasonModalActions}>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.quickReasonBtn}`}
                      onClick={() => setIsPickupReasonModalOpen(false)}
                    >
                      Cerrar
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {canRejectAfterFailedPickups && !hidePickupActions ? (
          <>
            <Form method="post" action={currentFormAction} className={styles.rejectForm}>
              <input type="hidden" name="intent" value="reject_after_failed_pickups" />
              <input type="hidden" name="id" value={request.id} />
              <div className={styles.quickReasonActions}>
                <button
                  className={`${styles.btn} ${styles.quickReasonBtn}`}
                  type="button"
                  onClick={() => setIsRejectAfterFailedReasonModalOpen(true)}
                  disabled={isSubmitting}
                >
                  Usar mensaje automatico
                </button>
              </div>
              <textarea
                className={styles.textarea}
                name="rejectionReason"
                placeholder="Motivo de rechazo (obligatorio)"
                value={rejectAfterFailedReason}
                onChange={(event) => setRejectAfterFailedReason(event.target.value)}
              />
              <button className={`${styles.btn} ${styles.btnDanger}`} type="submit" disabled={isSubmitting}>
                Rechazar devolucion
              </button>
            </Form>

            {isRejectAfterFailedReasonModalOpen ? (
              <div className={styles.reasonModalOverlay} role="dialog" aria-modal="true" aria-label="Seleccion de motivo de rechazo">
                <div className={styles.reasonModal}>
                  <p className={styles.reasonModalTitle}>Selecciona un mensaje completo</p>
                  {REJECT_AFTER_FAILED_REASON_OPTIONS.map((option, index) => (
                    <button
                      key={`reject_after_failed_reason_${index}`}
                      type="button"
                      className={styles.reasonOptionCard}
                      onClick={() => {
                        setRejectAfterFailedReason(option);
                        setIsRejectAfterFailedReasonModalOpen(false);
                      }}
                      disabled={isSubmitting}
                    >
                      <span className={styles.reasonOptionLabel}>Mensaje automatico {index + 1}</span>
                      <span className={styles.reasonOptionText}>{option}</span>
                    </button>
                  ))}
                  <div className={styles.reasonModalActions}>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.quickReasonBtn}`}
                      onClick={() => setIsRejectAfterFailedReasonModalOpen(false)}
                    >
                      Cerrar
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {status === "recibida" ? (
          <>
            <Form
              method="post"
              action={currentFormAction}
              onSubmit={(event) => {
                if (!window.confirm(`¿Confirmas procesar el reembolso del pedido #${request.orderNumber}?`)) {
                  event.preventDefault();
                  return;
                }
                onRefundActionSuccess?.(request.id, "Reembolso procesado correctamente.");
              }}
            >
              <input type="hidden" name="intent" value="process_refund" />
              <input type="hidden" name="id" value={request.id} />
              <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={isSubmitting}>
                Procesar reembolso
              </button>
            </Form>
            <Form
              method="post"
              action={currentFormAction}
              className={styles.rejectForm}
              onSubmit={(event) => {
                if (!window.confirm(`¿Confirmas denegar la devolución del pedido #${request.orderNumber}?`)) {
                  event.preventDefault();
                  return;
                }
                const formData = new FormData(event.currentTarget);
                if (String(formData.get("rejectionReason") || "").trim()) {
                  onRefundActionSuccess?.(request.id, "Devolucion denegada correctamente.");
                }
              }}
            >
              <input type="hidden" name="intent" value="deny_received" />
              <input type="hidden" name="id" value={request.id} />
              <textarea
                className={`${styles.textarea} ${styles.rejectReasonTextarea}`}
                name="rejectionReason"
                placeholder="Motivo de denegacion (obligatorio)"
                defaultValue=""
                rows={1}
                onInput={(event) => {
                  const field = event.currentTarget;
                  field.style.height = "auto";
                  field.style.height = `${Math.min(field.scrollHeight, 112)}px`;
                }}
              />
              <button className={`${styles.btn} ${styles.btnDanger}`} type="submit" disabled={isSubmitting}>
                Denegar devolucion
              </button>
            </Form>
          </>
        ) : null}

        {canMarkReturnedToCustomer ? (
          <Form
            method="post"
            action={currentFormAction}
            onSubmit={(event) => {
              if (!window.confirm(`¿Confirmas marcar el pedido #${request.orderNumber} como devuelto con exito?`)) {
                event.preventDefault();
                return;
              }
              onRefundActionSuccess?.(request.id, "Devolucion marcada como devuelta con exito.");
            }}
          >
            <input type="hidden" name="intent" value="mark_returned_to_customer" />
            <input type="hidden" name="id" value={request.id} />
            <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={isSubmitting}>
              Devuelto con exito
            </button>
          </Form>
        ) : null}

        {canMarkNotReturned ? (
          <Form
            method="post"
            action={currentFormAction}
            onSubmit={(event) => {
              if (!window.confirm(`¿Confirmas marcar el pedido #${request.orderNumber} como no devuelto?`)) {
                event.preventDefault();
                return;
              }
              onRefundActionSuccess?.(request.id, "Solicitud marcada como no devuelta.");
            }}
          >
            <input type="hidden" name="intent" value="mark_not_returned" />
            <input type="hidden" name="id" value={request.id} />
            <input type="hidden" name="notReturnedTestMode" value={forceShowNotReturnedAction ? "1" : "0"} />
            <button className={`${styles.btn} ${styles.btnDanger}`} type="submit" disabled={isSubmitting}>
              No devuelto
            </button>
          </Form>
        ) : null}
      </div>

      <ImageViewer image={viewerImage} onClose={() => setViewerImage(null)} />
      </article>
    </>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);

