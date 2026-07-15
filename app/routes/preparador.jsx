import { randomBytes } from "node:crypto";
import { useEffect, useState } from "react";
import { createCookie, Form, redirect, useActionData, useLoaderData, useNavigation, useRevalidator, useSearchParams } from "react-router";
import prisma from "../db.server";
import styles from "../styles/repartidor.module.css";

const COURIER_ADMIN_REPROGRAM_ACTION = "courier_admin_order_reprogrammed";
const COURIER_REPROGRAM_ACTIONS = [
  COURIER_ADMIN_REPROGRAM_ACTION,
  "courier_route_delivery_reprogrammed",
  "courier_route_return_reprogrammed",
];
const ADMIN_COURIER_REPROGRAM_STATUSES = [
  "no_entregado",
  "no_recibido",
  "reintento_pendiente",
  "intento_fallido_1",
  "intento_fallido_2",
  "intento_fallido_3",
];

function preparerPortalCookies() {
  const options = {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 26,
    secrets: [process.env.SHOPIFY_API_SECRET || "preparer-daily-access"],
  };
  return {
    accessCookie: createCookie("preparer_daily_access_v1", options),
  };
}

function cleanShop(value) {
  return String(value || "").trim().toLowerCase();
}

function createPreparerAccessId() {
  return randomBytes(16).toString("hex");
}

function accessIdFromRequest(request) {
  const url = new URL(request.url);
  return String(url.searchParams.get("access") || "").trim();
}

function accessSearchParam(accessId) {
  return accessId ? `&access=${encodeURIComponent(accessId)}` : "";
}

function normalizedPreparerSessions(access = {}) {
  const sessions = access?.sessions && typeof access.sessions === "object" ? access.sessions : {};
  return Object.fromEntries(
    Object.entries(sessions)
      .map(([key, value]) => [
        String(key || "").trim(),
        {
          shop: cleanShop(value?.shop),
          preparerId: Number(value?.preparerId || 0),
          accessCode: String(value?.accessCode || "").trim(),
        },
      ])
      .filter(([key, value]) => key && value.shop && value.preparerId),
  );
}

function itemBaseKey(item) {
  return String(item?.lineItemId || item?.id || item?.title || "item").trim();
}

function itemUnitKey(item, index = 0) {
  return `${itemBaseKey(item)}::${Number(index || 0) + 1}`;
}

function itemUnitKeys(item) {
  const quantity = Math.max(1, Number(item?.quantity || 1));
  return Array.from({ length: quantity }, (_value, index) => itemUnitKey(item, index));
}

function normalizeOrderItemsWithPreparerStatus(orderData, readyUnitKeys = [], missingUnitKeys = []) {
  const readySet = new Set(readyUnitKeys.map((value) => String(value || "").trim()).filter(Boolean));
  const missingSet = new Set(missingUnitKeys.map((value) => String(value || "").trim()).filter(Boolean));
  const order = orderData && typeof orderData === "object" ? orderData : {};
  const items = Array.isArray(order.items) ? order.items : [];
  return {
    ...order,
    preparerReadyUnitKeys: [...readySet],
    preparerMissingUnitKeys: [...missingSet],
    preparerCompletedAt: new Date().toISOString(),
    items: items.map((item, itemIndex) => {
      const unitKeys = itemUnitKeys(item);
      const missingItemUnitKeys = unitKeys.filter((unitKey) => missingSet.has(unitKey));
      const readyItemUnitKeys = unitKeys.filter((unitKey) => readySet.has(unitKey));
      return {
        ...item,
        preparerItemKey: itemBaseKey(item) || `item-${itemIndex}`,
        preparerUnitKeys: unitKeys,
        preparerReadyUnitKeys: readyItemUnitKeys,
        preparerMissingUnitKeys: missingItemUnitKeys,
        preparerStatus: missingItemUnitKeys.length ? "not_located" : "ready",
      };
    }),
  };
}

function isReprogrammedPreparerOrder(orderData = {}) {
  const status = String(orderData?.status || "").trim().toLowerCase();
  const currentStatus = String(orderData?.currentStatus || "").trim().toLowerCase();
  const visibleStatus = String(orderData?.visibleStatus || orderData?.displayStatus || "").trim().toLowerCase();
  const courierActivityStatus = String(orderData?.courierActivityStatus || "").trim().toLowerCase();
  const normalizedTags = new Set(
    (Array.isArray(orderData?.tags) ? orderData.tags : [])
      .map((tag) => String(tag || "").trim().toLowerCase().replace(/[\s_-]+/g, " "))
      .filter(Boolean),
  );
  return (
    ADMIN_COURIER_REPROGRAM_STATUSES.includes(status) ||
    ADMIN_COURIER_REPROGRAM_STATUSES.includes(currentStatus) ||
    ADMIN_COURIER_REPROGRAM_STATUSES.includes(visibleStatus) ||
    ADMIN_COURIER_REPROGRAM_STATUSES.includes(courierActivityStatus) ||
    status === "reintento_pendiente" ||
    status === "reprogramado" ||
    status === "reprogramada" ||
    currentStatus === "reintento_pendiente" ||
    currentStatus === "reprogramado" ||
    currentStatus === "reprogramada" ||
    visibleStatus === "reprogramado" ||
    visibleStatus === "reprogramada" ||
    courierActivityStatus === "reintento_pendiente" ||
    courierActivityStatus === "reprogramado" ||
    normalizedTags.has("reprogramado") ||
    normalizedTags.has("rpfdt") ||
    normalizedTags.has("reintentar entrega")
  );
}

function preparerCourierStatusFromActivityAction(action, fallbackStatus = "") {
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
    courier_route_return_reprogrammed: "reintento_pendiente",
  };
  return statusByAction[normalizedAction] || fallbackStatus;
}

function isPreparerCourierFinalActivityAction(action) {
  return [
    "courier_mark_delivered",
    "courier_mark_not_delivered",
    "courier_route_order_not_located",
    "courier_return_mark_received",
    "courier_return_pickup_attempt_failed",
    "courier_return_reject_after_failed_pickups",
    "courier_branch_pickup_refunded",
    ...COURIER_REPROGRAM_ACTIONS,
  ].includes(String(action || "").trim().toLowerCase());
}

async function getPreparerAccess(request, expectedShop = "") {
  const { accessCookie } = preparerPortalCookies();
  const cookieHeader = request.headers.get("Cookie");
  const access = (await accessCookie.parse(cookieHeader)) || {};
  const requestedAccessId = accessIdFromRequest(request);
  const sessions = normalizedPreparerSessions(access);
  const sessionAccess = requestedAccessId ? sessions[requestedAccessId] : null;
  const legacyAccess = access?.shop && access?.preparerId
    ? { shop: cleanShop(access.shop), preparerId: Number(access.preparerId || 0) }
    : null;
  const selectedAccess = sessionAccess || (!requestedAccessId ? legacyAccess : null);
  if (!selectedAccess?.shop || !selectedAccess?.preparerId) return null;
  if (!selectedAccess.accessCode) return null;
  const accessShop = cleanShop(selectedAccess.shop);
  const requestedShop = cleanShop(expectedShop);
  if (requestedShop && accessShop !== requestedShop) return null;
  const preparer = await prisma.preparer.findFirst({
    where: {
      id: Number(selectedAccess.preparerId),
      shop: accessShop,
    },
    select: { id: true, shop: true, name: true, code: true },
  });
  if (preparer && selectedAccess.accessCode && String(preparer.code || "").trim() !== selectedAccess.accessCode) {
    return null;
  }
  return preparer ? { ...preparer, accessId: sessionAccess ? requestedAccessId : "" } : null;
}

async function getTransferredPreparerNotice(request, expectedShop = "") {
  const { accessCookie } = preparerPortalCookies();
  const cookieHeader = request.headers.get("Cookie");
  const access = (await accessCookie.parse(cookieHeader)) || {};
  const requestedAccessId = accessIdFromRequest(request);
  const sessions = normalizedPreparerSessions(access);
  const sessionAccess = requestedAccessId ? sessions[requestedAccessId] : null;
  const legacyAccess = access?.shop && access?.preparerId
    ? {
        shop: cleanShop(access.shop),
        preparerId: Number(access.preparerId || 0),
        accessCode: String(access.accessCode || "").trim(),
      }
    : null;
  const selectedAccess = sessionAccess || (!requestedAccessId ? legacyAccess : null);
  if (!selectedAccess?.shop || !selectedAccess?.preparerId || !selectedAccess.accessCode) return "";
  const accessShop = cleanShop(selectedAccess.shop);
  const requestedShop = cleanShop(expectedShop);
  if (requestedShop && accessShop !== requestedShop) return "";
  const preparer = await prisma.preparer.findFirst({
    where: {
      id: Number(selectedAccess.preparerId),
      shop: accessShop,
    },
    select: { id: true, code: true },
  });
  if (!preparer || String(preparer.code || "").trim() === selectedAccess.accessCode) return "";
  const assignments = await prisma.preparerAssignment.findMany({
    where: {
      shop: accessShop,
      preparerId: preparer.id,
    },
    select: { orderData: true },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
  const transferAssignments = assignments.map((assignment) => {
    const orderData = assignment.orderData && typeof assignment.orderData === "object" ? assignment.orderData : {};
    const transferredAt = new Date(orderData.preparerTransferredAt || "").getTime();
    const finishedAt = new Date(orderData.preparerSessionFinishedAt || "").getTime();
    return {
      transferredToName: String(orderData.preparerTransferredToName || "").trim(),
      transferredAtMs: Number.isFinite(transferredAt) ? transferredAt : 0,
      finishedAtMs: Number.isFinite(finishedAt) ? finishedAt : 0,
    };
  });
  const transferredToName =
    transferAssignments
      .map((assignment) => assignment.transferredToName)
      .find(Boolean) || "";
  const transferFinished = transferAssignments.some((assignment) =>
    assignment.transferredToName === transferredToName &&
    assignment.finishedAtMs > 0 &&
    (!assignment.transferredAtMs || assignment.finishedAtMs >= assignment.transferredAtMs)
  );
  if (transferFinished) return "";
  return transferredToName
    ? `Tu cuenta ha sido traspasada. Espera que ${transferredToName} termine de despachar todas las ordenes.`
    : "";
}

async function generateUniquePreparerCode(shop) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const existing = await prisma.preparer.findFirst({
      where: { shop, code },
      select: { id: true },
    });
    if (!existing) return code;
  }
  throw new Error("No se pudo generar un codigo unico para el preparador.");
}

async function hasActivePreparerAssignments({ shop, preparerId }) {
  const activeAssignment = await prisma.preparerAssignment.findFirst({
    where: {
      shop,
      preparerId,
      status: { notIn: ["ready", "not_located"] },
    },
    select: { id: true },
  });
  return Boolean(activeAssignment);
}

export const headers = () => ({
  "Cache-Control": "no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow",
});

export async function loader({ request }) {
  const url = new URL(request.url);
  const shop = cleanShop(url.searchParams.get("shop"));
  const access = await getPreparerAccess(request, shop);
  const transferNotice = access ? "" : await getTransferredPreparerNotice(request, shop);
  let assignments = access
    ? await prisma.preparerAssignment.findMany({
        where: {
          shop: access.shop,
          preparerId: access.id,
        },
        orderBy: [{ sequence: "asc" }, { id: "asc" }],
      })
    : [];
  const globalAssignments = access
    ? await prisma.preparerAssignment.findMany({
        where: { shop: access.shop },
        orderBy: [{ id: "asc" }],
      })
    : [];
  const sortedGlobalAssignments = [...globalAssignments].sort(
    (firstAssignment, secondAssignment) =>
      preparerOrderNumberValue(firstAssignment) - preparerOrderNumberValue(secondAssignment) ||
      Number(firstAssignment.id || 0) - Number(secondAssignment.id || 0),
  );
  const globalSequenceByRequestId = new Map();
  const globalSequenceByOrderNumber = new Map();
  sortedGlobalAssignments.forEach((assignment, index) => {
    const storedOrderData = assignment.orderData && typeof assignment.orderData === "object" ? assignment.orderData : {};
    const requestId = String(assignment.requestId || "").trim();
    const orderNumber = String(storedOrderData.orderNumber || assignment.orderNumber || "").replace(/\D/g, "");
    const sequence = index + 1;
    if (requestId && !globalSequenceByRequestId.has(requestId)) {
      globalSequenceByRequestId.set(requestId, sequence);
    }
    if (orderNumber && !globalSequenceByOrderNumber.has(orderNumber)) {
      globalSequenceByOrderNumber.set(orderNumber, sequence);
    }
  });
  const assignmentRequestIds = assignments
    .map((assignment) => String(assignment.requestId || "").trim())
    .filter(Boolean);
  let liveCourierOrderByRequestId = new Map();
  let liveCourierOrderByOrderNumber = new Map();
  if (access && assignmentRequestIds.length) {
    try {
      const { fetchCourierOrdersByIdsForShop, fetchCourierOrdersForShop, resolveCourierPortalShop } = await import("../utils/courier.server");
      const portalShop = await resolveCourierPortalShop(request);
      const sessionCandidatesByShop = new Map();
      for (const sessionCandidate of portalShop.allSessionCandidates || portalShop.sessionCandidates || []) {
        const candidateShop = String(sessionCandidate?.shop || "").trim().toLowerCase();
        if (!candidateShop) continue;
        const current = sessionCandidatesByShop.get(candidateShop) || [];
        current.push(sessionCandidate);
        sessionCandidatesByShop.set(candidateShop, current);
      }
      const liveShop = sessionCandidatesByShop.has(access.shop) ? access.shop : portalShop.shop || access.shop;
      const sessionCandidates = sessionCandidatesByShop.get(liveShop) || portalShop.sessionCandidates || [];
      const liveCourierOrders = await fetchCourierOrdersByIdsForShop({
        shop: liveShop,
        sessionCandidates,
        orderIds: assignmentRequestIds,
      });
      liveCourierOrderByRequestId = new Map(
        liveCourierOrders
          .map((order) => [String(order?.id || "").trim(), order])
          .filter(([requestId]) => requestId),
      );
      liveCourierOrderByOrderNumber = new Map(
        liveCourierOrders
          .map((order) => [String(order?.orderNumber || "").replace(/\D/g, ""), order])
          .filter(([orderNumber]) => orderNumber),
      );
      const assignmentOrderNumbers = assignments
        .map((assignment) => {
          const orderData = assignment.orderData && typeof assignment.orderData === "object" ? assignment.orderData : {};
          return String(orderData.orderNumber || assignment.orderNumber || "").replace(/\D/g, "");
        })
        .filter(Boolean);
      const missingLiveOrderNumbers = assignmentOrderNumbers.filter((orderNumber) => !liveCourierOrderByOrderNumber.has(orderNumber));
      if (missingLiveOrderNumbers.length || assignmentOrderNumbers.length) {
        const liveCourierRouteOrders = await fetchCourierOrdersForShop({
          shop: liveShop,
          sessionCandidates,
        });
        for (const order of liveCourierRouteOrders) {
          const requestId = String(order?.id || "").trim();
          const orderNumber = String(order?.orderNumber || "").replace(/\D/g, "");
          if (requestId && !liveCourierOrderByRequestId.has(requestId)) {
            liveCourierOrderByRequestId.set(requestId, order);
          }
          if (orderNumber && !liveCourierOrderByOrderNumber.has(orderNumber)) {
            liveCourierOrderByOrderNumber.set(orderNumber, order);
          }
        }
      }
    } catch (error) {
      console.error("No se pudieron sincronizar ordenes vivas para preparador", error);
    }
  }
  const activities = assignmentRequestIds.length
    ? await prisma.courierActivity.findMany({
        where: {
          shop: access.shop,
          requestId: { in: assignmentRequestIds },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    : [];
  const latestFinalActivityByRequestId = new Map();
  for (const activity of activities) {
    if (!isPreparerCourierFinalActivityAction(activity.action)) continue;
    const requestId = String(activity.requestId || "").trim();
    if (!requestId) continue;
    latestFinalActivityByRequestId.set(requestId, activity);
  }
  assignments = assignments.map((assignment) => {
    const requestId = String(assignment.requestId || "").trim();
    const storedOrderData = assignment.orderData && typeof assignment.orderData === "object" ? assignment.orderData : {};
    const orderNumber = String(storedOrderData.orderNumber || assignment.orderNumber || "").replace(/\D/g, "");
    const liveCourierOrder =
      liveCourierOrderByRequestId.get(requestId) ||
      liveCourierOrderByOrderNumber.get(orderNumber) ||
      null;
    const liveSequenceNumber = Number(liveCourierOrder?.sequenceNumber || 0) || 0;
    const assignmentSequenceNumber = Number(assignment.sequence || 0) || 0;
    const globalSequenceNumber =
      liveSequenceNumber ||
      assignmentSequenceNumber ||
      globalSequenceByRequestId.get(requestId) ||
      globalSequenceByOrderNumber.get(orderNumber) ||
      0;
    const activity = latestFinalActivityByRequestId.get(requestId);
    const activityStatus = activity ? preparerCourierStatusFromActivityAction(activity.action, "") : "";
    const liveStatus = String(liveCourierOrder?.status || "").trim().toLowerCase();
    const nextStatus = liveStatus || activityStatus;
    if (!nextStatus && !liveCourierOrder && !globalSequenceNumber) return assignment;
    return {
      ...assignment,
      globalSequenceNumber: globalSequenceNumber || preparerDisplaySequence(assignment),
      orderData: {
        ...storedOrderData,
        ...(liveCourierOrder || {}),
        sequenceNumber:
          globalSequenceNumber ||
          liveSequenceNumber ||
          assignmentSequenceNumber ||
          liveCourierOrder?.sequenceNumber ||
          storedOrderData.sequenceNumber ||
          assignment.sequence,
        items: storedOrderData.items || liveCourierOrder?.items || [],
        status: nextStatus || storedOrderData.status,
        courierActivityStatus: activityStatus || storedOrderData.courierActivityStatus || "",
      },
    };
  });
  return {
    shop: access?.shop || shop,
    preparerName: access?.name || "",
    transferredToName: assignments
      .map((assignment) => {
        const orderData = assignment.orderData && typeof assignment.orderData === "object" ? assignment.orderData : {};
        return String(orderData.preparerTransferredToName || "").trim();
      })
      .find(Boolean) || "",
    transferNotice,
    isLoggedIn: Boolean(access),
    assignments,
  };
}

export async function action({ request }) {
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const url = new URL(request.url);
  const shop = cleanShop(formData.get("shop") || url.searchParams.get("shop"));
  const { accessCookie } = preparerPortalCookies();
  const cookieHeader = request.headers.get("Cookie");
  const currentCookieAccess = (await accessCookie.parse(cookieHeader)) || {};
  const currentSessions = normalizedPreparerSessions(currentCookieAccess);
  const currentAccessId = accessIdFromRequest(request);

  if (intent === "logout") {
    const access = await getPreparerAccess(request, shop);
    if (access) {
      const finishedAt = new Date().toISOString();
      const assignments = await prisma.preparerAssignment.findMany({
        where: {
          shop: access.shop,
          preparerId: access.id,
        },
        select: { id: true, orderData: true },
      });
      await prisma.$transaction([
        prisma.preparer.update({
          where: { id: access.id },
          data: { code: await generateUniquePreparerCode(access.shop) },
        }),
        ...assignments.map((assignment) => {
          const orderData = assignment.orderData && typeof assignment.orderData === "object" ? assignment.orderData : {};
          return prisma.preparerAssignment.update({
            where: { id: assignment.id },
            data: {
              orderData: {
                ...orderData,
                preparerSessionFinishedAt: finishedAt,
              },
            },
          });
        }),
      ]);
    }
    if (currentAccessId) {
      delete currentSessions[currentAccessId];
    }
    const nextCookieValue = currentAccessId
      ? { sessions: currentSessions }
      : "";
    return redirect(`/preparador${shop ? `?shop=${encodeURIComponent(shop)}` : ""}`, {
      headers: {
        "Set-Cookie": currentAccessId
          ? await accessCookie.serialize(nextCookieValue)
          : await accessCookie.serialize("", { maxAge: 0 }),
      },
    });
  }

  if (intent === "preparer_mark_ready") {
    const access = await getPreparerAccess(request, shop);
    if (!access) return { ok: false, error: "Inicia sesion nuevamente." };
    const assignmentId = Number(formData.get("assignmentId") || 0);
    if (!assignmentId) return { ok: false, error: "Orden invalida." };
    const readyUnitKeys = formData
      .getAll("readyUnitKeys")
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    const missingUnitKeys = formData
      .getAll("missingUnitKeys")
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    const submitAction = String(formData.get("preparerSubmitAction") || "").trim().toLowerCase();
    const isReprogrammedOrder = String(formData.get("isReprogrammedOrder") || "").trim() === "1";
    const assignment = await prisma.preparerAssignment.findFirst({
      where: {
        id: assignmentId,
        shop: access.shop,
        preparerId: access.id,
      },
    });
    if (!assignment) return { ok: false, error: "Orden invalida." };
    const nextStatus = submitAction === "not_located" || missingUnitKeys.length ? "not_located" : "ready";
    const nextOrderData = normalizeOrderItemsWithPreparerStatus(assignment.orderData, readyUnitKeys, missingUnitKeys);
    if (isReprogrammedOrder || isReprogrammedPreparerOrder(assignment.orderData)) {
      nextOrderData.preparerReprogrammedHandledAt = new Date().toISOString();
    }
    await prisma.$transaction([
      prisma.preparerAssignment.update({
        where: { id: assignment.id },
        data: {
          status: nextStatus,
          orderData: nextOrderData,
          completedAt: new Date(),
        },
      }),
      ...(nextStatus === "not_located"
        ? [
            prisma.courierActivity.create({
              data: {
                shop: access.shop,
                courierId: 0,
                courierName: `Preparador: ${access.name}`,
                requestId: String(assignment.requestId || "").trim(),
                orderNumber: assignment.orderNumber || null,
                action: "courier_route_order_not_located",
                routeId: null,
              },
            }),
          ]
        : []),
    ]);
    return redirect(`/preparador?shop=${encodeURIComponent(access.shop)}${accessSearchParam(access.accessId)}&tab=despachar`);
  }

  const code = String(formData.get("code") || "").replace(/\D/g, "").trim();
  if (!/^\d{6}$/.test(code)) return { ok: false, error: "Ingresa tu codigo de 6 digitos." };

  const preparerCandidates = await prisma.preparer.findMany({
    where: shop ? { shop, code } : { code },
    select: { id: true, shop: true, name: true },
    take: 2,
  });
  if (!preparerCandidates.length) {
    return { ok: false, error: "Esta cuenta ya inicio sesion." };
  }
  if (!shop && preparerCandidates.length > 1) {
    return { ok: false, error: "Este codigo existe en mas de una tienda. Abre el enlace del preparador desde Shopify." };
  }
  const preparer = preparerCandidates[0];
  const hasAssignedOrders = await hasActivePreparerAssignments({
    shop: preparer.shop,
    preparerId: preparer.id,
  });
  if (!hasAssignedOrders) {
    return { ok: false, error: "Este preparador aun no tiene ordenes asignadas." };
  }

  const accessId = createPreparerAccessId();
  const nextCode = await generateUniquePreparerCode(preparer.shop);
  await prisma.preparer.update({
    where: { id: preparer.id },
    data: { code: nextCode },
  });

  currentSessions[accessId] = {
    shop: preparer.shop,
    preparerId: preparer.id,
    accessCode: nextCode,
  };

  return redirect(`/preparador?shop=${encodeURIComponent(preparer.shop)}&access=${encodeURIComponent(accessId)}`, {
    headers: {
      "Set-Cookie": await accessCookie.serialize({
        sessions: currentSessions,
      }),
    },
  });
}

function preparerStatusLabel(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "ready") return "listo";
  if (normalized === "partial") return "incompleto";
  if (normalized === "not_located") return "no localizado";
  return "pendiente";
}

function isPreparerAssignmentDone(status) {
  const normalized = String(status || "").trim().toLowerCase();
  return normalized === "ready" || normalized === "not_located";
}

function preparerAssignmentDisplayStatus(assignment) {
  const order = assignment?.orderData && typeof assignment.orderData === "object" ? assignment.orderData : {};
  const status = String(assignment?.status || "assigned").trim().toLowerCase();
  if (status === "ready") return "ready";
  if (status === "not_located") return preparerOrderCompletionStatus(order, status);
  return isReprogrammedPreparerOrder(order)
    ? "assigned"
    : status;
}

function preparerOrderCompletionStatus(order = {}, status = "") {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (normalizedStatus === "ready") return "ready";
  if (normalizedStatus !== "not_located") return normalizedStatus || "assigned";
  const items = Array.isArray(order?.items) ? order.items : [];
  const totalUnits = items.reduce((count, item) => count + Math.max(1, Number(item?.quantity || 1)), 0);
  const missingUnitKeys = new Set(
    [
      ...(Array.isArray(order?.preparerMissingUnitKeys) ? order.preparerMissingUnitKeys : []),
      ...items.flatMap((item) => (Array.isArray(item?.preparerMissingUnitKeys) ? item.preparerMissingUnitKeys : [])),
    ]
      .map((unitKey) => String(unitKey || "").trim())
      .filter(Boolean),
  );
  if (missingUnitKeys.size > 0 && totalUnits > 0 && missingUnitKeys.size < totalUnits) return "partial";
  return "not_located";
}

function formatPreparerAddress(order) {
  return [
    order?.pickupAddress,
    order?.pickupNeighborhood,
    order?.pickupCity,
    order?.pickupState,
    order?.pickupPostalCode,
    order?.pickupCountry,
  ]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(", ");
}

function preparerOrderMark(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "ready") return "✓";
  if (normalized === "partial") return "-";
  if (normalized === "not_located") return "x";
  return "";
}

function preparerDisplaySequence(assignment, fallback = 0) {
  const order = assignment?.orderData && typeof assignment.orderData === "object" ? assignment.orderData : {};
  return Number(order.sequenceNumber || assignment?.globalSequenceNumber || assignment?.sequence || fallback || 0) || 0;
}

function preparerOrderNumberValue(assignment) {
  const order = assignment?.orderData && typeof assignment.orderData === "object" ? assignment.orderData : {};
  const digits = String(order.orderNumber || assignment?.orderNumber || "").replace(/\D/g, "");
  return Number(digits || 0) || 0;
}

export default function PreparerPortal() {
  const { shop, preparerName, transferredToName = "", transferNotice = "", isLoggedIn, assignments = [] } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [searchParams] = useSearchParams();
  const [enlargedImage, setEnlargedImage] = useState(null);
  const [readyUnitKeys, setReadyUnitKeys] = useState([]);
  const [missingReviewOpen, setMissingReviewOpen] = useState(false);
  const [reviewUnitKeys, setReviewUnitKeys] = useState([]);
  const isSubmitting = navigation.state === "submitting";
  const initialTab = String(searchParams.get("tab") || "ordenes").trim().toLowerCase();
  const [activeTab, setActiveTab] = useState(initialTab === "despachar" ? "despachar" : "ordenes");
  const sortedAssignments = [...assignments].sort(
    (firstAssignment, secondAssignment) =>
      preparerDisplaySequence(firstAssignment) - preparerDisplaySequence(secondAssignment) ||
      preparerOrderNumberValue(firstAssignment) - preparerOrderNumberValue(secondAssignment) ||
      Number(firstAssignment.id || 0) - Number(secondAssignment.id || 0),
  );
  const visibleAssignments = sortedAssignments;
  const pendingAssignments = sortedAssignments.filter((assignment) => !isPreparerAssignmentDone(assignment?.status));
  const displaySequenceByAssignmentId = new Map(
    visibleAssignments.map((assignment, index) => [
      String(assignment.id),
      preparerDisplaySequence(assignment, index + 1),
    ]),
  );
  const dispatchAssignment = pendingAssignments[0] || null;

  useEffect(() => {
    setReadyUnitKeys([]);
    setMissingReviewOpen(false);
    setReviewUnitKeys([]);
  }, [dispatchAssignment?.id]);

  useEffect(() => {
    if (!isLoggedIn) return undefined;
    const revalidateAccess = () => {
      if (revalidator.state === "idle") {
        revalidator.revalidate();
      }
    };
    const intervalId = window.setInterval(revalidateAccess, 4000);
    const handleFocus = () => revalidateAccess();
    const handleVisibilityChange = () => {
      if (!document.hidden) revalidateAccess();
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isLoggedIn, revalidator]);

  const handleTabChange = (nextTab) => {
    setActiveTab(nextTab === "despachar" ? "despachar" : "ordenes");
  };

  if (isLoggedIn) {
    const remainingAssignments = pendingAssignments;
    const dispatchOrder = dispatchAssignment?.orderData || {};
    const dispatchItems = Array.isArray(dispatchOrder.items) ? dispatchOrder.items : [];
    const isDispatchReprogrammed = isReprogrammedPreparerOrder(dispatchOrder);
    const dispatchStatus = preparerAssignmentDisplayStatus(dispatchAssignment);
    const isDispatchCompleted = !isDispatchReprogrammed && isPreparerAssignmentDone(dispatchStatus);
    const dispatchAddress = formatPreparerAddress(dispatchOrder);
    const dispatchUnitKeys = dispatchItems.flatMap((item) => itemUnitKeys(item));
    const readyUnitKeySet = new Set(readyUnitKeys);
    const uncheckedUnitKeys = dispatchUnitKeys.filter((unitKey) => !readyUnitKeySet.has(unitKey));
    const activeReviewUnitKeys = missingReviewOpen && reviewUnitKeys.length ? reviewUnitKeys : uncheckedUnitKeys;
    const activeReviewUnitKeySet = new Set(activeReviewUnitKeys);
    const visibleDispatchItems = missingReviewOpen
      ? dispatchItems.filter((item) => itemUnitKeys(item).some((unitKey) => activeReviewUnitKeySet.has(unitKey)))
      : dispatchItems;
    const reviewItemCount = visibleDispatchItems.length;

    return (
      <main className={styles.page}>
        <div className={styles.container}>
          <header className={styles.header}>
            <div>
              <h1 className={styles.title}>Cariana preparadores</h1>
              <p className={styles.subtitle}>
                {preparerName ? `Preparador: ${preparerName}` : "Ordenes asignadas para preparacion."}
              </p>
              {transferredToName ? (
                <p className={styles.subtitle}>
                  Cuenta traspasada a {transferredToName}
                </p>
              ) : null}
            </div>
            <Form
              method="post"
              onSubmit={(event) => {
                if (!window.confirm("Deseas finalizar?")) {
                  event.preventDefault();
                }
              }}
            >
              <input type="hidden" name="intent" value="logout" />
              <input type="hidden" name="shop" value={shop || ""} />
              <button className={styles.accessButton} type="submit" disabled={isSubmitting}>
                Finalizar
              </button>
            </Form>
          </header>

          <div className={styles.preparerSummary}>
            <span className={styles.counterBadge}>Ordenes {visibleAssignments.length}</span>
            <span className={styles.counterBadge}>Restantes {remainingAssignments.length}</span>
          </div>

          {visibleAssignments.length ? (
            <section className={styles.card}>
              <div className={styles.tabRow} role="tablist" aria-label="Secciones de preparador">
                <button
                  type="button"
                  className={`${styles.tabButton} ${activeTab === "ordenes" ? styles.tabButtonActive : ""}`}
                  onClick={() => handleTabChange("ordenes")}
                >
                  Ordenes
                </button>
                <button
                  type="button"
                  className={`${styles.tabButton} ${activeTab === "despachar" ? styles.tabButtonActive : ""}`}
                  onClick={() => handleTabChange("despachar")}
                >
                  Despachar
                </button>
              </div>

              {activeTab === "ordenes" ? (
                <div className={styles.preparerOrderChecklist}>
                  {visibleAssignments.map((assignment) => {
                    const order = assignment.orderData || {};
                    const status = preparerAssignmentDisplayStatus(assignment);
                    return (
                      <div key={assignment.id} className={styles.preparerOrderCheckItem}>
                        <span className={styles.orderSequenceBadge}>
                          {displaySequenceByAssignmentId.get(String(assignment.id)) || ""}
                        </span>
                        <strong>Orden #{order.orderNumber || assignment.orderNumber || "-"}</strong>
                        <span
                          className={`${styles.preparerCheckBox} ${
                            status === "ready"
                              ? styles.preparerCheckBoxReady
                              : status === "partial"
                                ? styles.preparerCheckBoxPartial
                              : status === "not_located"
                                ? styles.preparerCheckBoxMissing
                                : ""
                          }`}
                          aria-label={`Estado ${preparerStatusLabel(status)}`}
                        >
                          {preparerOrderMark(status)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <article className={`${styles.card} ${styles.preparerDispatchCard}`}>
                  {dispatchAssignment ? (
                    <>
                      <div className={styles.cardHeader}>
                        <div>
                          <div className={styles.preparerDispatchTitleRow}>
                            <span className={styles.orderSequenceBadge}>
                              {displaySequenceByAssignmentId.get(String(dispatchAssignment.id)) || ""}
                            </span>
                            <h2 className={styles.preparerDispatchOrderNumber}>
                              #{dispatchOrder.orderNumber || dispatchAssignment.orderNumber || "-"}
                            </h2>
                          </div>
                          <h3 className={styles.cardTitle}>{dispatchOrder.customerName || "Cliente"}</h3>
                          {dispatchAddress ? <p className={styles.subtitle}>{dispatchAddress}</p> : null}
                        </div>
                        <span className={`${styles.counterBadge} ${styles.preparerStatusBadge}`}>
                          {preparerStatusLabel(dispatchStatus)}
                        </span>
                      </div>

                      <Form
                        method="post"
                        onSubmit={(event) => {
                          if (isDispatchCompleted) return;
                          const submitAction = event.nativeEvent?.submitter?.value || "";
                          if (submitAction === "not_located") {
                            const message = isDispatchReprogrammed
                              ? "Confirmas que esta orden no fue localizada?"
                              : "Confirmas que estos productos no fueron localizados?";
                            if (!window.confirm(message)) {
                              event.preventDefault();
                            }
                            return;
                          }
                          if (isDispatchReprogrammed) {
                            if (!window.confirm("Confirmas que esta orden esta lista?")) {
                              event.preventDefault();
                            }
                            return;
                          }
                          if (uncheckedUnitKeys.length) {
                            event.preventDefault();
                            if (!window.confirm("Hay productos sin palomita. Quieres revisarlos antes de guardar?")) {
                              return;
                            }
                            setReviewUnitKeys(uncheckedUnitKeys);
                            setMissingReviewOpen(true);
                            return;
                          }
                          if (!window.confirm("Confirmas que esta orden esta lista?")) {
                            event.preventDefault();
                          }
                        }}
                      >
                        <input type="hidden" name="intent" value="preparer_mark_ready" />
                        <input type="hidden" name="assignmentId" value={dispatchAssignment.id} />
                        <input type="hidden" name="isReprogrammedOrder" value={isDispatchReprogrammed ? "1" : ""} />
                        {readyUnitKeys.map((unitKey) => (
                          <input key={`ready:${unitKey}`} type="hidden" name="readyUnitKeys" value={unitKey} />
                        ))}
                        {missingReviewOpen
                          ? activeReviewUnitKeys
                              .filter((unitKey) => !readyUnitKeySet.has(unitKey))
                              .map((unitKey) => (
                              <input key={`missing:${unitKey}`} type="hidden" name="missingUnitKeys" value={unitKey} />
                            ))
                          : null}
                        {isDispatchReprogrammed ? (
                          <div className={styles.preparerReprogrammedNotice}>
                            Recoge esta orden en la seccion de reprogramados.
                          </div>
                        ) : missingReviewOpen ? (
                          <p className={styles.preparerInlineReviewMessage}>
                            {reviewItemCount === 1 ? "Revisa que tengas este producto." : "Revisa que tengas estos productos."}
                          </p>
                        ) : null}
                        {!isDispatchReprogrammed ? (
                        <div className={styles.preparerProductList}>
                          {visibleDispatchItems.length ? (
                            visibleDispatchItems.map((item, index) => {
                              const unitKeys = itemUnitKeys(item);
                              const checked = unitKeys.every((unitKey) => readyUnitKeySet.has(unitKey));
                              return (
                                <div key={`${item.lineItemId || item.id || item.title || "item"}-${index}`} className={styles.preparerProductItem}>
                                  {item.imageUrl ? (
                                    <button
                                      className={styles.preparerProductImageButton}
                                      type="button"
                                      onClick={() =>
                                        setEnlargedImage({
                                          src: item.imageUrl,
                                          alt: item.imageAlt || item.title || "Producto",
                                        })
                                      }
                                    >
                                      <img
                                        className={styles.preparerProductImage}
                                        src={item.imageUrl}
                                        alt={item.imageAlt || item.title || "Producto"}
                                      />
                                    </button>
                                  ) : (
                                    <span className={styles.preparerProductImagePlaceholder} />
                                  )}
                                  <div className={styles.preparerProductCopy}>
                                    <strong>{item.title || "Producto"}</strong>
                                    {item.variantSummary ? <span>Variante: {item.variantSummary}</span> : null}
                                    <span>Cantidad: {Math.max(1, Number(item.quantity || 1))}</span>
                                  </div>
                                  <label className={styles.preparerProductCheck}>
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      disabled={isDispatchCompleted}
                                      onChange={(event) => {
                                        setReadyUnitKeys((currentKeys) => {
                                          const nextKeys = new Set(currentKeys);
                                          for (const unitKey of unitKeys) {
                                            if (event.target.checked) nextKeys.add(unitKey);
                                            else nextKeys.delete(unitKey);
                                          }
                                          return [...nextKeys];
                                        });
                                      }}
                                    />
                                    <span>{checked ? "✓" : ""}</span>
                                  </label>
                                </div>
                              );
                            })
                          ) : (
                            <p className={styles.subtitle}>No hay productos registrados para esta orden.</p>
                          )}
                        </div>
                        ) : null}

                        <div className={styles.preparerActions}>
                          <button className={styles.accessButton} type="submit" disabled={isSubmitting || isDispatchCompleted}>
                            Listo
                          </button>
                          {isDispatchReprogrammed ? (
                            <button
                              className={styles.missingButton}
                              type="submit"
                              name="preparerSubmitAction"
                              value="not_located"
                              disabled={isSubmitting || isDispatchCompleted}
                            >
                              No localizado
                            </button>
                          ) : missingReviewOpen && activeReviewUnitKeys.some((unitKey) => !readyUnitKeySet.has(unitKey)) ? (
                            <>
                              <button
                                className={styles.missingButton}
                                type="submit"
                                name="preparerSubmitAction"
                                value="not_located"
                                disabled={isSubmitting || isDispatchCompleted}
                              >
                                No localizado
                              </button>
                              <button
                                className={styles.accessButton}
                                type="button"
                                disabled={isSubmitting || isDispatchCompleted}
                                onClick={() => {
                                  setMissingReviewOpen(false);
                                  setReviewUnitKeys([]);
                                }}
                              >
                                Regresar
                              </button>
                            </>
                          ) : null}
                        </div>
                      </Form>
                    </>
                  ) : (
                    <p className={styles.empty}>No hay ordenes para despachar.</p>
                  )}
                </article>
              )}
            </section>
          ) : (
            <section className={styles.card}>
              <p className={styles.error}>Este preparador aun no tiene ordenes asignadas.</p>
            </section>
          )}
          {enlargedImage ? (
            <div className={styles.modalBackdrop} role="presentation" onClick={() => setEnlargedImage(null)}>
              <div className={styles.preparerImageModal} role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
                <button className={styles.logoutButton} type="button" onClick={() => setEnlargedImage(null)}>
                  Cerrar
                </button>
                <img src={enlargedImage.src} alt={enlargedImage.alt} />
              </div>
            </div>
          ) : null}
          {actionData?.error ? <p className={styles.error}>{actionData.error}</p> : null}
        </div>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <div className={styles.accessContainer}>
        <section className={`${styles.card} ${styles.accessCard}`}>
          <p className={styles.eyebrow}>Portal del preparador</p>
          {transferNotice ? (
            <p className={styles.error}>{transferNotice}</p>
          ) : (
            <>
              <h1 className={styles.cardTitle}>Ingresa tu codigo</h1>
              <p className={styles.subtitle}>Tu codigo es necesario para acceder a tus ordenes de preparacion.</p>
              <Form method="post" className={styles.accessForm}>
                <input type="hidden" name="shop" value={shop || ""} />
                <input
                  className={styles.accessInput}
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="000000"
                  required
                />
                <button className={styles.accessButton} type="submit" disabled={isSubmitting}>
                  {isSubmitting ? "Validando..." : "Entrar"}
                </button>
              </Form>
              {actionData?.error ? <p className={styles.error}>{actionData.error}</p> : null}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
