import prisma from "../db.server";
import { fetchBranchPickupCourierOrdersForShop } from "./courier.server";
import { formatCourierScheduledDate, getCourierRouteStatusFromTags } from "./courier.shared";

const ADMIN_API_VERSION = "2025-10";
const MEXICO_TIME_ZONE = "America/Mexico_City";
const BRANCH_PICKUP_DEADLINE_DAYS = 30;
const NOTIFICATIONS_API_BASE_URL = String(
  process.env.NOTIFICATIONS_API_URL || "https://centro-de-notificaciones-cariana.onrender.com",
).replace(/\/+$/, "");
const NOTIFICATIONS_API_KEY = String(
  process.env.NOTIFICATIONS_API_KEY || process.env.APP_INTERNAL_API_KEY || "",
).trim();
const SCHEDULER_FLAG = Symbol.for("cariana.courierBranchPickupExpirationScheduler.started");
const SCHEDULER_TIMER = Symbol.for("cariana.courierBranchPickupExpirationScheduler.timer");
const COURIER_STATUS_TAGS = [
  "en ruta",
  "en ruta 2",
  "en ruta 3",
  "no entregado",
  "recoger en sucursal",
  "entregado",
  "reembolsada",
  "reprogramado",
  "RPFDT",
  "reintentar entrega",
  "intento entrega 1",
  "intento entrega 2",
  "intento entrega 3",
];

function normalize(value) {
  return String(value || "").trim();
}

function normalizeShop(value) {
  return normalize(value).toLowerCase();
}

function toMoney(value) {
  return Number(value || 0).toFixed(2);
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function roundMoneyValue(value) {
  return Math.round(toFiniteNumber(value, 0) * 100) / 100;
}

function shopMoneyAmount(moneySet) {
  return toFiniteNumber(moneySet?.shopMoney?.amount, 0);
}

function lineItemRefundUnitPrice(node, fallbackUnitPrice = 0) {
  const quantity = Math.max(1, toFiniteNumber(node?.quantity, 1));
  const originalTotal = shopMoneyAmount(node?.originalTotalSet) || toFiniteNumber(fallbackUnitPrice, 0) * quantity;
  const allocatedDiscount = (node?.discountAllocations || []).reduce(
    (sum, allocation) => sum + shopMoneyAmount(allocation?.allocatedAmountSet),
    0,
  );
  if (allocatedDiscount > 0 && originalTotal > 0) {
    return roundMoneyValue(Math.max(0, originalTotal - allocatedDiscount) / quantity);
  }

  const discountedTotal = shopMoneyAmount(node?.discountedTotalSet);
  if (discountedTotal > 0 && (!originalTotal || discountedTotal < originalTotal)) {
    return roundMoneyValue(discountedTotal / quantity);
  }

  return roundMoneyValue(fallbackUnitPrice);
}

function orderSubtotalDiscountRate(orderNode) {
  const currentSubtotal = shopMoneyAmount(orderNode?.currentSubtotalPriceSet);
  const originalCurrentSubtotal = (orderNode?.lineItems?.edges || []).reduce((sum, edge) => {
    const node = edge?.node || {};
    const unitPrice = shopMoneyAmount(node.originalUnitPriceSet);
    const quantity = Math.max(0, toFiniteNumber(node.currentQuantity ?? node.quantity, 0));
    return sum + unitPrice * quantity;
  }, 0);
  if (currentSubtotal > 0 && originalCurrentSubtotal > 0 && currentSubtotal < originalCurrentSubtotal) {
    return currentSubtotal / originalCurrentSubtotal;
  }
  return 1;
}

function orderDiscountedRefundUnitPrice(orderNode, node, fallbackUnitPrice = 0) {
  const directUnitPrice = lineItemRefundUnitPrice(node, fallbackUnitPrice);
  const originalUnitPrice = roundMoneyValue(fallbackUnitPrice);
  if (directUnitPrice > 0 && directUnitPrice < originalUnitPrice) return directUnitPrice;
  const discountRate = orderSubtotalDiscountRate(orderNode);
  if (discountRate > 0 && discountRate < 1) return roundMoneyValue(originalUnitPrice * discountRate);
  return directUnitPrice;
}

function parseCourierDate(value) {
  const raw = normalize(value);
  if (!raw) return null;
  const date = raw.includes("T") ? new Date(raw) : new Date(`${raw}T00:00:00`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function parseEventMs(value) {
  const date = parseCourierDate(value);
  return date ? date.getTime() : 0;
}

function mexicoDateKey(dateValue = new Date()) {
  if (!dateValue) return "";
  const rawValue = normalize(dateValue);
  const dateMatch = rawValue.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dateMatch) return `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;

  const date = new Date(dateValue);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MEXICO_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year && values.month && values.day ? `${values.year}-${values.month}-${values.day}` : "";
}

function addDaysToDateKey(dateKey, days) {
  const [year, month, day] = normalize(dateKey)
    .split("-")
    .map((value) => Number(value));
  if (!year || !month || !day) return "";
  const result = new Date(Date.UTC(year, month - 1, day + Number(days || 0), 12, 0, 0));
  return result.toISOString().slice(0, 10);
}

function msUntilNextMexicoMidnight(now = new Date()) {
  const todayKey = mexicoDateKey(now);
  const nextDateKey = addDaysToDateKey(todayKey, 1);
  const target = new Date(`${nextDateKey}T06:00:05.000Z`);
  const delay = target.getTime() - now.getTime();
  if (!Number.isFinite(delay) || delay < 1000 || delay > 36 * 60 * 60 * 1000) {
    return 60 * 60 * 1000;
  }
  return delay;
}

function branchPickupEventsForDeadline(request) {
  return [
    ...(Array.isArray(request?.historyEvents) ? request.historyEvents : []),
    ...(Array.isArray(request?.branchPickupHistoryEvents) ? request.branchPickupHistoryEvents : []),
    ...(Array.isArray(request?.unfilteredHistoryEvents) ? request.unfilteredHistoryEvents : []),
  ].filter((event) => normalize(event?.status).toLowerCase() === "recoger_en_sucursal");
}

function branchPickupDeadlineSourceDateKey(request, displayedScheduledDate) {
  const branchEvent = branchPickupEventsForDeadline(request).sort(
    (firstEvent, secondEvent) => parseEventMs(secondEvent?.at) - parseEventMs(firstEvent?.at),
  )[0];
  return (
    mexicoDateKey(branchEvent?.at) ||
    mexicoDateKey(displayedScheduledDate) ||
    mexicoDateKey(request?.updatedAt) ||
    mexicoDateKey(request?.createdAt)
  );
}

function branchPickupDeadlineLabelFromEvents(request) {
  const branchEvent = branchPickupEventsForDeadline(request).sort(
    (firstEvent, secondEvent) => parseEventMs(secondEvent?.at) - parseEventMs(firstEvent?.at),
  )[0];
  const note = normalize(branchEvent?.note);
  return note.match(/branch_pickup_deadline_label:([^;\n]+)/i)?.[1]?.trim() || "";
}

function branchPickupDeadlineDateKey(request, displayedScheduledDate) {
  const directDeadlineKey = mexicoDateKey(request?.branchPickupDeadlineAt) || mexicoDateKey(request?.pickupDeadlineAt);
  if (directDeadlineKey) return directDeadlineKey;
  const sourceDateKey = branchPickupDeadlineSourceDateKey(request, displayedScheduledDate);
  return sourceDateKey ? addDaysToDateKey(sourceDateKey, BRANCH_PICKUP_DEADLINE_DAYS) : "";
}

export function formatBranchPickupDeadlineDate(request, displayedScheduledDate) {
  const persistedDeadlineLabel = branchPickupDeadlineLabelFromEvents(request);
  if (persistedDeadlineLabel) return persistedDeadlineLabel;
  const deadlineKey = branchPickupDeadlineDateKey(request, displayedScheduledDate);
  return deadlineKey ? formatCourierScheduledDate(deadlineKey) : "-";
}

export function isBranchPickupDeadlineExpired(request, displayedScheduledDate, now = new Date()) {
  const deadlineKey = branchPickupDeadlineDateKey(request, displayedScheduledDate);
  const todayKey = mexicoDateKey(now);
  return Boolean(deadlineKey && todayKey) && todayKey > deadlineKey;
}

function buildBranchPickupRefundNotificationCopy(orderNumber, refundAmount, currencyCode = "MXN") {
  const cleanOrderNumber = normalize(orderNumber).replace(/^#/, "") || "****";
  const currency = normalize(currencyCode).toUpperCase() || "MXN";
  const amountLabel = `$${toMoney(refundAmount)} ${currency}`;
  return {
    title: "Reembolso procesado ✅",
    message: `💰 El reembolso de tu pedido #${cleanOrderNumber} ya fue procesado por la cantidad de ${amountLabel}, debido a que venció el plazo de 30 días para recoger tu pedido en nuestra sucursal. El reembolso se verá reflejado en tu cuenta en un plazo de 5 a 10 días hábiles, dependiendo de los tiempos de procesamiento de tu banco.\n\n¡Te agradecemos por confiar en Cariana! ✨`,
  };
}

async function resolveAllCourierShopSessions() {
  const sessions = await prisma.session.findMany({
    select: { id: true, shop: true, isOnline: true, accessToken: true },
  });
  const sessionsByShop = new Map();
  for (const session of sessions) {
    const shop = normalizeShop(session.shop);
    const accessToken = normalize(session.accessToken);
    if (!shop || !accessToken) continue;
    const current = sessionsByShop.get(shop) || [];
    current.push({
      id: normalize(session.id),
      shop,
      isOnline: Boolean(session.isOnline),
      accessToken,
    });
    sessionsByShop.set(shop, current);
  }
  for (const [shop, shopSessions] of sessionsByShop.entries()) {
    shopSessions.sort((a, b) => {
      const aOffline = a.isOnline === false ? 0 : 1;
      const bOffline = b.isOnline === false ? 0 : 1;
      if (aOffline !== bOffline) return aOffline - bOffline;
      return normalize(a.id).localeCompare(normalize(b.id));
    });
    sessionsByShop.set(shop, shopSessions);
  }
  return sessionsByShop;
}

async function shopifyGraphql({ shop, session, query, variables = {} }) {
  const response = await fetch(`https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": session.accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json().catch(() => ({}));
  const errors = payload?.errors || [];
  if (!response.ok || errors.length) {
    throw new Error(errors[0]?.message || `Error consultando Shopify Admin API (${response.status}).`);
  }
  return payload;
}

function formatVariantSummary(variantNode) {
  if (!variantNode) return "";
  const title = normalize(variantNode.title);
  if (title && title.toLowerCase() !== "default title") return title;
  const selectedOptions = Array.isArray(variantNode.selectedOptions) ? variantNode.selectedOptions : [];
  return selectedOptions
    .map((option) => normalize(option?.value))
    .filter((value) => value && value.toLowerCase() !== "default title")
    .join(" / ");
}

async function fetchOrderSnapshot({ shop, session, orderId }) {
  const payload = await shopifyGraphql({
    shop,
    session,
    query: `#graphql
      query OrderForRefund($id: ID!) {
        order(id: $id) {
          id
          currentTotalPriceSet { shopMoney { amount currencyCode } }
          currentSubtotalPriceSet { shopMoney { amount currencyCode } }
          lineItems(first: 100) {
            edges {
              node {
                id
                title
                quantity
                currentQuantity
                refundableQuantity
                variant { id title selectedOptions { name value } }
                product { id }
                originalUnitPriceSet { shopMoney { amount currencyCode } }
                originalTotalSet { shopMoney { amount currencyCode } }
                discountedTotalSet(withCodeDiscounts: true) { shopMoney { amount currencyCode } }
                discountAllocations {
                  allocatedAmountSet { shopMoney { amount currencyCode } }
                }
              }
            }
          }
          transactions { id kind status gateway }
        }
      }`,
    variables: { id: orderId },
  });
  const order = payload?.data?.order;
  if (!order) throw new Error("No se encontro la orden en Shopify.");
  return {
    orderId: order.id,
    currentTotalPrice: Number(order.currentTotalPriceSet?.shopMoney?.amount || 0),
    currentSubtotalPrice: Number(order.currentSubtotalPriceSet?.shopMoney?.amount || 0),
    currencyCode: normalize(order.currentTotalPriceSet?.shopMoney?.currencyCode) || "MXN",
    lineItems: (order.lineItems?.edges || []).map(({ node }) => ({
      id: node.id,
      title: node.title,
      quantity: Number(node.refundableQuantity ?? node.quantity ?? 0),
      variantId: node.variant?.id || "",
      productId: node.product?.id || "",
      variantSummary: formatVariantSummary(node.variant),
      unitPrice: orderDiscountedRefundUnitPrice(order, node, Number(node.originalUnitPriceSet?.shopMoney?.amount || 0)),
    })),
    transactions: (order.transactions || []).map((transaction) => ({
      id: transaction.id,
      kind: transaction.kind,
      status: transaction.status,
      gateway: transaction.gateway || "",
    })),
  };
}

function pickParentTransaction(transactions) {
  const success = (transactions || []).filter((tx) => normalize(tx.status).toUpperCase() === "SUCCESS");
  return (
    success.find((tx) => ["CAPTURE", "SALE"].includes(normalize(tx.kind).toUpperCase())) ||
    success[0] ||
    null
  );
}

function mapOrderItemsToFullRefundLineItems(orderLineItems) {
  const refundLineItems = [];
  const refundedItems = [];
  let subtotal = 0;
  for (const line of orderLineItems || []) {
    const quantity = Math.max(0, Number(line.quantity || 0));
    if (!line?.id || quantity <= 0) continue;
    subtotal += Number(line.unitPrice || 0) * quantity;
    refundLineItems.push({
      lineItemId: line.id,
      quantity,
      restockType: "NO_RESTOCK",
    });
    refundedItems.push({
      lineItemId: line.id,
      title: line.title || "Producto",
      variantSummary: normalize(line.variantSummary),
      quantity,
      unitPrice: Number(line.unitPrice || 0),
      total: Number(line.unitPrice || 0) * quantity,
      unitKeys: [],
    });
  }
  return { refundLineItems, refundedItems, subtotal, selectedAllLineItems: refundLineItems.length > 0 };
}

async function refundShopifyOrderToOriginalPayment({ shop, session, shopifyOrderId, notePrefix }) {
  const snapshot = await fetchOrderSnapshot({ shop, session, orderId: shopifyOrderId });
  const { refundLineItems, refundedItems, subtotal, selectedAllLineItems } = mapOrderItemsToFullRefundLineItems(
    snapshot.lineItems,
  );
  if (!refundLineItems.length) throw new Error("No hay lineas para reembolsar.");
  const finalRefund = Number(subtotal || 0);
  if (finalRefund <= 0) throw new Error("No se encontro un monto valido para reembolsar.");
  const parentTransaction = pickParentTransaction(snapshot.transactions);
  if (!parentTransaction?.id || !parentTransaction?.gateway) {
    throw new Error("No se encontro una transaccion de pago valida para reembolsar al metodo original.");
  }

  const payload = await shopifyGraphql({
    shop,
    session,
    query: `#graphql
      mutation RefundBranchPickupOrder($input: RefundInput!) {
        refundCreate(input: $input) {
          refund { id }
          userErrors { field message }
        }
      }`,
    variables: {
      input: {
        orderId: shopifyOrderId,
        note: notePrefix || "Reembolso por pedido no recogido en sucursal",
        notify: false,
        refundLineItems,
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
  });
  const userErrors = payload?.data?.refundCreate?.userErrors || [];
  if (userErrors.length) {
    throw new Error(userErrors[0]?.message || "No se pudo procesar el reembolso.");
  }
  return {
    refundId: normalize(payload?.data?.refundCreate?.refund?.id),
    finalRefund,
    refundedSubtotal: finalRefund,
    currencyCode: snapshot.currencyCode || "MXN",
    selectedAllLineItems,
    refundedItems,
  };
}

async function replaceShopifyOrderCourierStatusTag({ shop, session, shopifyOrderId, statusTag }) {
  const cleanStatusTag = normalize(statusTag);
  if (!shopifyOrderId || !cleanStatusTag) return;
  const payload = await shopifyGraphql({
    shop,
    session,
    query: `#graphql
      mutation ReplaceCourierStatusTags($id: ID!, $addTags: [String!]!, $removeTags: [String!]!) {
        tagsAdd(id: $id, tags: $addTags) { userErrors { field message } }
        tagsRemove(id: $id, tags: $removeTags) { userErrors { field message } }
      }`,
    variables: {
      id: shopifyOrderId,
      addTags: [cleanStatusTag],
      removeTags: COURIER_STATUS_TAGS.filter((tag) => tag !== cleanStatusTag),
    },
  });
  const userErrors = [
    ...(payload?.data?.tagsAdd?.userErrors || []),
    ...(payload?.data?.tagsRemove?.userErrors || []),
  ];
  if (userErrors.length) {
    throw new Error(userErrors[0]?.message || "No se pudo actualizar el estado de la orden.");
  }
}

async function emitBranchPickupRefundNotification({ shopDomain, requestId, orderNumber, refundAmount, currencyCode }) {
  if (!shopDomain || !requestId || !NOTIFICATIONS_API_BASE_URL) {
    return { ok: false, error: "No se pudo preparar la notificacion." };
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
      const result = responsePayload?.result || {};
      const totalRecipients = Number(result.total || 0) || 0;
      const sentRecipients = Number(result.sent || 0) || 0;
      if (response.ok && !result.skipped) {
        return { ok: true, endpoint: endpoint.url, totalRecipients, sentRecipients };
      }
      lastFailure = {
        endpoint: endpoint.url,
        status: response.status,
        totalRecipients,
        sentRecipients,
        detail: String(
          responsePayload?.error ||
            responsePayload?.detail ||
            result.reason ||
            (response.ok && totalRecipients <= 0 ? "No hay dispositivos activos para recibir la notificacion." : "") ||
            (response.ok && sentRecipients <= 0 ? "La notificacion no fue entregada a ningun dispositivo." : "") ||
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
  return {
    ok: false,
    error: lastFailure?.detail || lastFailure?.error || "No se pudo enviar la notificacion.",
    ...lastFailure,
  };
}

async function fetchCourierEventsForOrder({ shop, requestId }) {
  const events = await prisma.courierEvent.findMany({
    where: { shop, requestId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return events.map((event) => ({
    id: event.id,
    status: event.status,
    note: event.note,
    at: event.createdAt,
  }));
}

async function persistDeadlineLabel({ shop, requestId, displayedDeadline }) {
  const cleanDisplayedDeadline = normalize(displayedDeadline);
  if (!cleanDisplayedDeadline) return;
  const branchPickupEvent = await prisma.courierEvent.findFirst({
    where: { shop, requestId, status: "recoger_en_sucursal" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, note: true },
  });
  if (!branchPickupEvent) return;
  const existingNote = normalize(branchPickupEvent.note);
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

async function refundExpiredBranchPickupOrder({ shop, session, order, logger = console }) {
  const requestId = normalize(order?.id);
  if (!requestId) return { ok: false, error: "Accion no valida." };
  const courierStatus = getCourierRouteStatusFromTags(order?.tags || []);
  const orderStatus = normalize(order?.status).toLowerCase();
  if (courierStatus && courierStatus !== "recoger_en_sucursal" && orderStatus !== "recoger_en_sucursal") {
    return { ok: false, error: "Esta orden ya no esta pendiente por recoger en sucursal.", requestId };
  }

  const historyEvents = await fetchCourierEventsForOrder({ shop, requestId });
  const orderForDeadline = { ...order, historyEvents };
  const displayedScheduledDate = order.pickupDate;
  if (!isBranchPickupDeadlineExpired(orderForDeadline, displayedScheduledDate)) {
    return { ok: false, error: "Aun no vence la fecha limite para reembolsar esta orden.", requestId };
  }

  const orderNumber = normalize(order.orderNumber) || requestId.replace(/^gid:\/\/shopify\/Order\//, "");
  const displayedDeadline = formatBranchPickupDeadlineDate(orderForDeadline, displayedScheduledDate);
  const refundResult = await refundShopifyOrderToOriginalPayment({
    shop,
    session,
    shopifyOrderId: requestId,
    notePrefix: `Reembolso pedido #${orderNumber} no recogido en sucursal`,
  });
  await replaceShopifyOrderCourierStatusTag({ shop, session, shopifyOrderId: requestId, statusTag: "reembolsada" });
  await prisma.deliveryCodeAssignment.updateMany({
    where: { shop, shopifyOrderId: requestId, active: true },
    data: { code: null, active: false, releasedAt: new Date() },
  });

  const notificationResult = await emitBranchPickupRefundNotification({
    shopDomain: shop,
    requestId,
    orderNumber,
    refundAmount: refundResult.refundedSubtotal,
    currencyCode: refundResult.currencyCode,
  });
  if (!notificationResult.ok) {
    logger.warn?.("Branch pickup refund notification was not delivered", {
      shop,
      requestId,
      orderNumber,
      error: notificationResult.error,
      totalRecipients: notificationResult.totalRecipients,
      sentRecipients: notificationResult.sentRecipients,
    });
  }

  await persistDeadlineLabel({ shop, requestId, displayedDeadline });
  const latestCourierActivity = await prisma.courierActivity.findFirst({
    where: { shop, requestId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { courierId: true, courierName: true, routeId: true },
  });
  await prisma.courierActivity.create({
    data: {
      shop,
      courierId: Number(latestCourierActivity?.courierId || 0),
      courierName: normalize(latestCourierActivity?.courierName) || "Scheduler",
      requestId,
      orderNumber: orderNumber || null,
      action: "courier_branch_pickup_refunded",
      routeId: normalize(latestCourierActivity?.routeId) || null,
    },
  });

  return {
    ok: true,
    requestId,
    orderNumber,
    deadline: displayedDeadline,
    shopifyRefundId: refundResult.refundId,
    notification: notificationResult,
  };
}

export async function refundExpiredBranchPickupOrdersForShop({ shop, sessionCandidates, ordersForDeadlineCheck = null, logger = console } = {}) {
  const cleanShop = normalizeShop(shop);
  const sessions = Array.isArray(sessionCandidates) ? sessionCandidates : [];
  if (!cleanShop || !sessions.length) {
    return { refundedCount: 0, refundedRequestIds: [], checkedCount: 0, failedRefunds: [] };
  }

  const branchPickupOrders = Array.isArray(ordersForDeadlineCheck)
    ? ordersForDeadlineCheck
    : await fetchBranchPickupCourierOrdersForShop({ shop: cleanShop, sessionCandidates: sessions });
  let refundedCount = 0;
  const refundedRequestIds = [];
  const failedRefunds = [];
  const primarySession = sessions[0];

  for (const order of branchPickupOrders) {
    const historyEvents = await fetchCourierEventsForOrder({ shop: cleanShop, requestId: normalize(order.id) });
    const orderForDeadline = { ...order, historyEvents };
    if (!isBranchPickupDeadlineExpired(orderForDeadline, order.pickupDate)) continue;
    try {
      const result = await refundExpiredBranchPickupOrder({
        shop: cleanShop,
        session: primarySession,
        order: orderForDeadline,
        logger,
      });
      if (result.ok) {
        refundedCount += 1;
        refundedRequestIds.push(normalize(order.id));
      } else {
        failedRefunds.push({
          requestId: normalize(order.id),
          orderNumber: normalize(order.orderNumber),
          error: result.error || "No se pudo reembolsar automaticamente.",
        });
      }
    } catch (error) {
      failedRefunds.push({
        requestId: normalize(order.id),
        orderNumber: normalize(order.orderNumber),
        error: String(error?.message || error || "No se pudo reembolsar automaticamente."),
      });
      logger.error?.("No se pudo reembolsar automaticamente una orden vencida en sucursal", {
        shop: cleanShop,
        requestId: normalize(order.id),
        orderNumber: normalize(order.orderNumber),
        error: String(error?.message || error || "unknown"),
      });
    }
  }

  return { refundedCount, refundedRequestIds, checkedCount: branchPickupOrders.length, failedRefunds };
}

export async function refundExpiredBranchPickupOrdersForAllShops({ logger = console } = {}) {
  const sessionsByShop = await resolveAllCourierShopSessions();
  let refundedCount = 0;
  let checkedCount = 0;
  const shops = [];
  const failedRefunds = [];

  for (const [shop, sessionCandidates] of sessionsByShop.entries()) {
    const result = await refundExpiredBranchPickupOrdersForShop({ shop, sessionCandidates, logger });
    refundedCount += Number(result.refundedCount || 0);
    checkedCount += Number(result.checkedCount || 0);
    shops.push({ shop, refundedCount: result.refundedCount, checkedCount: result.checkedCount });
    failedRefunds.push(...(result.failedRefunds || []).map((failure) => ({ shop, ...failure })));
  }

  return { refundedCount, checkedCount, shopCount: sessionsByShop.size, shops, failedRefunds };
}

export function startCourierBranchPickupExpirationScheduler({ logger = console } = {}) {
  if (globalThis[SCHEDULER_FLAG]) return;
  globalThis[SCHEDULER_FLAG] = true;

  const runAndScheduleNext = async (reason) => {
    try {
      const result = await refundExpiredBranchPickupOrdersForAllShops({ logger });
      logger.info?.("Courier branch pickup expiration scheduler completed", { reason, ...result });
    } catch (error) {
      logger.error?.("Courier branch pickup expiration scheduler failed", {
        reason,
        error: String(error?.message || error || "unknown"),
      });
    } finally {
      scheduleNext();
    }
  };

  const scheduleNext = () => {
    const delay = msUntilNextMexicoMidnight();
    globalThis[SCHEDULER_TIMER] = setTimeout(() => runAndScheduleNext("mexico_midnight"), delay);
    globalThis[SCHEDULER_TIMER]?.unref?.();
  };

  globalThis[SCHEDULER_TIMER] = setTimeout(() => runAndScheduleNext("startup_catchup"), 5000);
  globalThis[SCHEDULER_TIMER]?.unref?.();
}
