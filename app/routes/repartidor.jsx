import { useState } from "react";
import { createCookie, Form, redirect, useActionData, useLoaderData, useSearchParams } from "react-router";
import adminStyles from "../styles/admin.module.css";
import styles from "../styles/repartidor.module.css";
import {
  compareCourierDisplayOrder,
  courierOrderTimestampMs,
  formatCourierAddress,
  formatCourierScheduledDate,
  getCourierRouteStatusLabel,
  isCourierHistoryStatus,
  isCourierRouteStatus,
  isCourierRouteTabStatus,
} from "../utils/courier.shared";

const courierDailyAccessCookie = createCookie("courier_daily_access_v2", {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 26,
  secrets: [process.env.SHOPIFY_API_SECRET || "courier-daily-access"],
});

const courierDeliveryConfirmationCookie = createCookie("courier_delivery_confirmation_v2", {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 26,
  secrets: [process.env.SHOPIFY_API_SECRET || "courier-daily-access"],
});

const PICKUP_FAILED_REASON_OPTIONS = [
  "No logramos completar la recolección. 🚚 Visitamos tu domicilio, pero no obtuvimos respuesta al tocar la puerta ni al comunicarnos contigo. Nuestro equipo volverá a intentarlo mañana. 📦✨",
  "Recolección reagendada. 📦✨ Nos comunicamos contigo y acordamos realizar un nuevo intento de recolección el día de mañana, ya que no te encontrabas en el domicilio indicado. 🚚",
];
const FINAL_PICKUP_REJECTION_REASON =
  "❌🚚 Después de 3 intentos de recolección en el domicilio registrado, no fue posible recibir el producto. Por esta razón, la solicitud de devolución fue rechazada automáticamente.";
const SECOND_PICKUP_FAILED_WARNING =
  "⚠️ Nota importante: Si mañana no logramos localizarte en tu domicilio por tercera ocasión, tu devolución será cancelada. 📦❌";

function getFailedPickupMessage(request, rejectionReason) {
  const normalizedStatus = String(request?.status || "").trim().toLowerCase();
  if (normalizedStatus !== "en_ruta_2") return rejectionReason;
  return `${rejectionReason}\n\n${SECOND_PICKUP_FAILED_WARNING}`;
}

export const headers = () => ({
  "Cache-Control": "no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow",
});

function getCourierStatusLabel(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "pendiente") return "pendiente";
  if (normalized === "reintento_pendiente") return "pendiente";
  return getCourierRouteStatusLabel(status);
}

function getFailedDeliveryAttemptCount(request) {
  const currentAttemptCount = Math.max(0, Number(request?.attemptCount || 0));
  if (currentAttemptCount > 0) return currentAttemptCount;
  const normalizedStatus = String(request?.status || "").trim().toLowerCase();
  return normalizedStatus === "no_entregado" ? 1 : 0;
}

function getDeliveryAttemptLabel(request, activeTab) {
  const failedAttemptCount = getFailedDeliveryAttemptCount(request);
  if (!failedAttemptCount) return "";

  const normalizedStatus = String(request?.status || "").trim().toLowerCase();
  if (["entregado", "no_entregado", "recoger_en_sucursal"].includes(normalizedStatus)) {
    return failedAttemptCount === 1 ? "1 intento" : `${failedAttemptCount} intentos`;
  }

  const currentAttemptNumber = isCourierRouteStatus(normalizedStatus)
    ? Math.min(failedAttemptCount, 3)
    : Math.min(failedAttemptCount + 1, 3);
  if (currentAttemptNumber === 1 && isCourierRouteStatus(normalizedStatus)) return "";
  if (activeTab === "pedidos" || activeTab === "en_ruta") {
    if (currentAttemptNumber === 1) return "Primer intento";
    if (currentAttemptNumber === 2) return "Segundo intento";
    return "Tercer intento";
  }
  return currentAttemptNumber === 1 ? "1 intento" : `${currentAttemptNumber} intentos`;
}

function courierAttemptLabel(attempt) {
  const attemptNumber = Math.min(Math.max(Number(attempt || 0), 1), 3);
  if (attemptNumber === 1) return "Primer intento";
  if (attemptNumber === 2) return "Segundo intento";
  return "Tercer intento";
}

function courierSnapshotEventLabel(event) {
  const normalizedStatus = String(event?.status || "").trim().toLowerCase();
  const attemptLabel = courierAttemptLabel(event?.attempt);
  if (normalizedStatus === "en_ruta" || normalizedStatus.startsWith("en_ruta_")) return `${attemptLabel} en ruta`;
  if (normalizedStatus === "no_entregado") return `${attemptLabel} no entregado`;
  if (normalizedStatus === "reintento_pendiente") return `${attemptLabel} reprogramado`;
  if (normalizedStatus === "recoger_en_sucursal") return "Enviado a recoger en sucursal";
  if (normalizedStatus === "entregado") return `${attemptLabel} entregado`;
  return normalizedStatus.replace(/_/g, " ");
}

function parseSnapshotReasonEntries(rawValue) {
  const text = String(rawValue || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed?.entries)) return parsed.entries.filter(Boolean);
  } catch {
    return [{ kind: "legacy", reason: text, at: "" }];
  }
  return [{ kind: "legacy", reason: text, at: "" }];
}

function buildPickupSnapshotHistoryEvents(order) {
  const entries = parseSnapshotReasonEntries(order?.rejectionReason);
  const finalAttempt = Math.max(
    1,
    entries.reduce((maxAttempt, entry) => {
      const match = String(entry?.kind || "").toLowerCase().match(/^(?:courier_en_route_|courier_retry_|attempt_failed_)(\d)$/);
      return match ? Math.max(maxAttempt, Number(match[1]) || 0) : maxAttempt;
    }, 0),
  );
  return entries
    .map((entry, index) => {
      const kind = String(entry?.kind || "").trim().toLowerCase();
      let label = "";
      const failedAttemptMatch = kind.match(/^attempt_failed_(\d)$/);
      const enRouteAttemptMatch = kind.match(/^courier_en_route_(\d)$/);
      if (failedAttemptMatch) label = `${courierAttemptLabel(failedAttemptMatch[1])} no recibido`;
      if (enRouteAttemptMatch) label = `${courierAttemptLabel(enRouteAttemptMatch[1])} en ruta`;
      if (kind === "status_received") label = `${courierAttemptLabel(finalAttempt)} recibido`;
      return {
        id: `${kind || "pickup-event"}-${entry?.at || index}-${index}`,
        label,
        at: entry?.at || order?.updatedAt || order?.createdAt || "",
      };
    })
    .filter((event) => event.label && event.at)
    .sort((firstEvent, secondEvent) => new Date(firstEvent.at).getTime() - new Date(secondEvent.at).getTime());
}

function courierHistoryTimestampMs(request) {
  const courierHistoryAtMs = new Date(request?.courierHistoryAt || "").getTime();
  if (Number.isFinite(courierHistoryAtMs)) return courierHistoryAtMs;
  if (String(request?.courierLabel || "").trim().toLowerCase() === "entrega") return 0;
  const updatedAtMs = new Date(request?.updatedAt || "").getTime();
  if (Number.isFinite(updatedAtMs)) return updatedAtMs;
  return courierOrderTimestampMs(request);
}

function courierMexicoDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function generateUniqueCourierCode(shop) {
  const { default: prisma } = await import("../db.server");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const existing = await prisma.courier.findFirst({
      where: { shop, code },
      select: { id: true },
    });
    if (!existing) return code;
  }
  throw new Error("No se pudo generar un nuevo codigo unico.");
}

async function getCourierDailyAccess(request, shop) {
  const { default: prisma } = await import("../db.server");
  const access = await courierDailyAccessCookie.parse(request.headers.get("Cookie"));
  if (
    String(access?.shop || "").trim().toLowerCase() !== String(shop || "").trim().toLowerCase() ||
    String(access?.dateKey || "") !== courierMexicoDateKey(new Date()) ||
    !Number(access?.courierId)
  ) {
    return null;
  }
  const courier = await prisma.courier.findFirst({
    where: {
      id: Number(access.courierId),
      shop: String(shop || "").trim().toLowerCase(),
    },
    select: { id: true, name: true, code: true },
  });
  if (!courier || String(access?.accessCode || "") !== courier.code) return null;
  access.courierName = courier.name;
  return access;
}

async function hasCourierDeliveryConfirmation(request, dailyAccess, shop) {
  const confirmation = await courierDeliveryConfirmationCookie.parse(
    request.headers.get("Cookie"),
  );
  return (
    String(confirmation?.shop || "").trim().toLowerCase() ===
      String(shop || "").trim().toLowerCase() &&
    String(confirmation?.dateKey || "") === courierMexicoDateKey(new Date()) &&
    Number(confirmation?.courierId) === Number(dailyAccess?.courierId) &&
    confirmation?.complete === true
  );
}

function isCourierHistoryFromToday(request) {
  const historyTimestamp = courierHistoryTimestampMs(request);
  if (!historyTimestamp) return false;
  return courierMexicoDateKey(historyTimestamp) === courierMexicoDateKey(new Date());
}

function isCourierWorkableForCurrentRoute(request) {
  const normalizedStatus = String(request?.status || "").trim().toLowerCase();
  if (normalizedStatus === "no_entregado") return true;
  return !isCourierHistoryStatus(normalizedStatus);
}

function shouldResetAssignedOrderForCurrentRoute(request, routeAction) {
  const normalizedStatus = String(request?.status || "").trim().toLowerCase();
  return routeAction === "courier_route_order_assigned" && normalizedStatus === "no_entregado";
}

function getReturnFailedAttemptCount(request) {
  const normalizedStatus = String(request?.status || "").trim().toLowerCase();
  const match = normalizedStatus.match(/^intento_fallido_(\d+)$/);
  if (match) return Math.max(1, Number(match[1]) || 1);
  return normalizedStatus === "rechazada" ? Math.max(3, Number(request?.attemptCount || 0)) : 0;
}

function getReturnFailedAttemptLabel(request) {
  const failedAttemptCount = getReturnFailedAttemptCount(request);
  if (!failedAttemptCount) return "";
  return failedAttemptCount === 1 ? "1 intento" : `${failedAttemptCount} intentos`;
}

function getReturnRetryAttemptLabel(request) {
  const normalizedStatus = String(request?.status || "").trim().toLowerCase();
  if (normalizedStatus !== "reintento_pendiente" && !normalizedStatus.startsWith("en_ruta_")) return "";
  const routeAttemptMatch = normalizedStatus.match(/^en_ruta_(\d+)$/);
  const routeAttemptNumber = routeAttemptMatch ? Number(routeAttemptMatch[1]) || 1 : 0;
  const nextAttemptNumber = Math.min(Math.max(Number(request?.attemptCount || 0) + 1, 1), 3);
  const attemptNumber = routeAttemptNumber || nextAttemptNumber;
  if (attemptNumber === 1) return "primer intento";
  if (attemptNumber === 2) return "segundo intento";
  return "tercer intento";
}

function getCourierSnapshotDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function courierStatusFromSnapshotAction(action, fallbackStatus = "pendiente") {
  const normalizedAction = String(action || "").trim();
  if (normalizedAction === "courier_mark_delivered" || normalizedAction === "courier_return_mark_received") {
    return "entregado";
  }
  if (normalizedAction === "courier_mark_not_delivered") return "no_entregado";
  if (normalizedAction === "courier_retry_delivery" || normalizedAction === "courier_return_for_retry") {
    return "reintento_pendiente";
  }
  return fallbackStatus || "pendiente";
}

function buildSnapshotFallbackOrder(requestId, activity, index = 0) {
  return {
    id: requestId,
    orderNumber: activity?.orderNumber || requestId,
    customerName: "",
    customerPhone: "",
    address: "",
    pickupDate: "",
    status: courierStatusFromSnapshotAction(activity?.action, "pendiente"),
    attemptCount: 0,
    courierLabel: String(requestId || "").startsWith("pickup-") ? "Devolucion" : "Entrega",
    historyEvents: [],
    sequenceNumber: index + 1,
  };
}

export const action = async ({ request }) => {
  const { default: prisma } = await import("../db.server");
  const {
    fetchCourierOrdersByIdsForShop,
    fetchPickupCourierOrders,
    markCourierOrderAsDelivered,
    markCourierOrderAsEnRoute,
    markCourierOrderAsNotDelivered,
    markCourierOrderForRetry,
    markCourierReturnAsReceived,
    markCourierReturnForRetry,
    markCourierReturnPickupAttemptFailed,
    rejectCourierReturnAfterFailedPickups,
    resolveCourierPortalShop,
  } = await import("../utils/courier.server");
  try {
    const url = new URL(request.url);
    const formData = await request.formData();
    const formShop = String(formData.get("shop") || "").trim().toLowerCase();
    const portalShop = await resolveCourierPortalShop(request);
    const shop = formShop || portalShop.shop;
    const intent = String(formData.get("intent") || "").trim();
    const requestId = String(formData.get("requestId") || "").trim();

    if (intent === "courier_finish_route") {
      const dailyAccess = await getCourierDailyAccess(request, shop);
      if (!dailyAccess) {
        return { ok: false, error: "Tu acceso vencio. Ingresa nuevamente tu codigo." };
      }
      const routeId = String(dailyAccess.routeId || "");
      const finishedAt = new Date();
      const routeActivities = routeId
        ? await prisma.courierActivity.findMany({
            where: {
              shop,
              courierId: Number(dailyAccess.courierId),
              routeId,
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          })
        : [];
      const routeStartedAt =
        routeActivities.find((activity) => activity.action === "courier_route_started")?.createdAt || null;
      const orderActivities = routeActivities.filter((activity) => {
        const activityRequestId = String(activity.requestId || "").trim();
        return (
          activityRequestId &&
          !activityRequestId.startsWith("route:") &&
          activity.action !== "courier_route_started" &&
          activity.action !== "courier_route_finished"
        );
      });
      const requestIds = [
        ...new Set(orderActivities.map((activity) => String(activity.requestId || "").trim()).filter(Boolean)),
      ];
      const latestActivityByRequestId = new Map();
      for (const activity of orderActivities) {
        latestActivityByRequestId.set(String(activity.requestId || "").trim(), activity);
      }
      const deliveryRequestIds = requestIds.filter((id) => !id.startsWith("pickup-"));
      const pickupRequestIds = new Set(requestIds.filter((id) => id.startsWith("pickup-")));
      const sessionCandidatesForSnapshot = portalShop.sessionCandidates || portalShop.allSessionCandidates || [];
      const deliveryOrders = deliveryRequestIds.length
        ? await fetchCourierOrdersByIdsForShop({
            shop,
            sessionCandidates: sessionCandidatesForSnapshot,
            orderIds: deliveryRequestIds,
          })
        : [];
      const pickupOrders = pickupRequestIds.size
        ? (await fetchPickupCourierOrders(shop)).filter((order) => pickupRequestIds.has(String(order.id || "")))
        : [];
      let deliveryHistoryEvents = [];
      if (deliveryRequestIds.length) {
        try {
          deliveryHistoryEvents = await prisma.courierEvent.findMany({
            where: {
              shop,
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
      const fetchedOrderById = new Map(
        [...deliveryOrders, ...pickupOrders].map((order) => [String(order.id || ""), order]),
      );
      const snapshotOrders = requestIds
        .map((id, index) => {
          const activity = latestActivityByRequestId.get(id);
          const fetchedOrder = fetchedOrderById.get(id) || buildSnapshotFallbackOrder(id, activity, index);
          const historyEvents = id.startsWith("pickup-")
            ? buildPickupSnapshotHistoryEvents(fetchedOrder)
            : (deliveryHistoryByRequestId.get(id) || []).map((event) => ({
                id: `delivery-event-${event.id}`,
                label: courierSnapshotEventLabel(event),
                at: event.createdAt,
              }));
          return {
            ...fetchedOrder,
            id,
            orderNumber: fetchedOrder.orderNumber || activity?.orderNumber || id,
            status: courierStatusFromSnapshotAction(activity?.action, fetchedOrder.status),
            historyEvents,
            sequenceNumber: 0,
          };
        })
        .sort(compareCourierDisplayOrder)
        .map((order, index) => ({ ...order, sequenceNumber: index + 1 }));
      const remainingCount = snapshotOrders.filter((order) => !isCourierHistoryStatus(order.status)).length;
      const snapshotData =
        routeId && snapshotOrders.length
          ? {
              shop,
              courierId: Number(dailyAccess.courierId),
              courierName: String(dailyAccess.courierName || ""),
              routeId,
              dateKey: getCourierSnapshotDateKey(finishedAt),
              startedAt: routeStartedAt,
              finishedAt,
              orders: snapshotOrders,
              remainingCount,
            }
          : null;
      const existingSnapshot = snapshotData
        ? await prisma.courierRouteSnapshot.findUnique({
            where: { shop_routeId: { shop, routeId } },
            select: { id: true },
          })
        : null;
      const newCode = await generateUniqueCourierCode(shop);
      const transactionSteps = [
        prisma.courier.update({
          where: { id: Number(dailyAccess.courierId) },
          data: { code: newCode },
        }),
        prisma.courierActivity.create({
          data: {
            shop,
            courierId: Number(dailyAccess.courierId),
            courierName: String(dailyAccess.courierName || ""),
            requestId: `route:${dailyAccess.routeId}`,
            action: "courier_route_finished",
            routeId: String(dailyAccess.routeId || ""),
          },
        }),
      ];
      if (snapshotData && !existingSnapshot) {
        transactionSteps.push(prisma.courierRouteSnapshot.create({ data: snapshotData }));
      }
      await prisma.$transaction(transactionSteps);
      url.searchParams.set("shop", shop);
      url.searchParams.delete("updated");
      url.searchParams.delete("overrideRequestId");
      url.searchParams.delete("overrideStatus");
      url.searchParams.delete("overrideAttemptCount");
      const headers = new Headers();
      headers.append(
        "Set-Cookie",
        await courierDailyAccessCookie.serialize("", { maxAge: 0 }),
      );
      headers.append(
        "Set-Cookie",
        await courierDeliveryConfirmationCookie.serialize("", { maxAge: 0 }),
      );
      return redirect(`${url.pathname}?${url.searchParams.toString()}`, { headers });
    }

    if (intent === "courier_daily_login") {
      const code = String(formData.get("code") || "").trim();
      if (!/^\d{6}$/.test(code)) {
        return { ok: false, loginError: "Ingresa un codigo valido de 6 digitos." };
      }
      const courier = await prisma.courier.findFirst({
        where: { shop, code },
        select: { id: true, name: true },
      });
      if (!courier) {
        return { ok: false, loginError: "El codigo ingresado no es valido." };
      }
      const routeId = crypto.randomUUID();
      await prisma.courierActivity.create({
        data: {
          shop,
          courierId: courier.id,
          courierName: courier.name,
          requestId: `route:${routeId}`,
          action: "courier_route_started",
          routeId,
        },
      });
      url.searchParams.set("shop", shop);
      url.searchParams.set("tab", "pedidos");
      const headers = new Headers();
      headers.append(
        "Set-Cookie",
        await courierDailyAccessCookie.serialize({
          shop,
          courierId: courier.id,
          courierName: courier.name,
          dateKey: courierMexicoDateKey(new Date()),
          routeId,
          accessCode: code,
        }),
      );
      headers.append(
        "Set-Cookie",
        await courierDeliveryConfirmationCookie.serialize("", { maxAge: 0 }),
      );
      return redirect(`${url.pathname}?${url.searchParams.toString()}`, {
        headers,
      });
    }

    const dailyAccess = await getCourierDailyAccess(request, shop);
    if (!dailyAccess) {
      return { ok: false, error: "Tu acceso diario vencio. Ingresa nuevamente tu codigo." };
    }

    if (
      [
        "courier_confirm_delivery_list",
        "courier_confirm_delivery",
        "courier_mark_delivery_missing",
        "courier_finish_delivery_confirmation",
      ].includes(intent)
    ) {
      const confirmedRequestIds = Array.isArray(dailyAccess.confirmedRequestIds)
        ? dailyAccess.confirmedRequestIds.map((value) => String(value || ""))
        : [];
      const missingOrderNumbers = Array.isArray(dailyAccess.missingOrderNumbers)
        ? dailyAccess.missingOrderNumbers.map((value) => String(value || ""))
        : [];

      if (intent === "courier_confirm_delivery_list") {
        const visibleRequestIds = formData
          .getAll("visibleRequestIds")
          .map((value) => String(value || "").trim())
          .filter(Boolean);
        const selectedRequestIds = formData
          .getAll("confirmedRequestIds")
          .map((value) => String(value || "").trim())
          .filter(Boolean);
        const visibleOrderNumbers = formData
          .getAll("visibleOrderNumbers")
          .map((value) => String(value || "").trim());

        if (!visibleRequestIds.length) {
          return { ok: false, confirmationError: "No se encontraron entregas para confirmar." };
        }

        for (const selectedRequestId of selectedRequestIds) {
          if (
            visibleRequestIds.includes(selectedRequestId) &&
            !confirmedRequestIds.includes(selectedRequestId)
          ) {
            confirmedRequestIds.push(selectedRequestId);
          }
        }

        dailyAccess.confirmedRequestIds = confirmedRequestIds;
        const missingRequestIds = visibleRequestIds.filter(
          (visibleRequestId) => !selectedRequestIds.includes(visibleRequestId),
        );
        dailyAccess.deliveryConfirmationComplete = missingRequestIds.length === 0;
        if (selectedRequestIds.length && dailyAccess.routeId) {
          const existingAssignments = await prisma.courierActivity.findMany({
            where: {
              shop,
              courierId: Number(dailyAccess.courierId),
              routeId: String(dailyAccess.routeId),
              requestId: { in: selectedRequestIds },
            },
            select: { requestId: true },
          });
          const assignedRequestIds = new Set(
            existingAssignments.map((activity) => String(activity.requestId || "").trim()),
          );
          const assignments = selectedRequestIds
            .map((selectedRequestId) => {
              if (assignedRequestIds.has(selectedRequestId)) return null;
              const visibleIndex = visibleRequestIds.indexOf(selectedRequestId);
              return {
                shop,
                courierId: Number(dailyAccess.courierId),
                courierName: String(dailyAccess.courierName || ""),
                requestId: selectedRequestId,
                orderNumber: String(visibleOrderNumbers[visibleIndex] || "").trim() || null,
                action: "courier_route_order_assigned",
                routeId: String(dailyAccess.routeId),
              };
            })
            .filter(Boolean);
          if (assignments.length) {
            await prisma.courierActivity.createMany({ data: assignments });
          }
        }
        if (missingRequestIds.length === 0) {
          dailyAccess.missingOrderNumbers = [];
        } else {
          dailyAccess.missingOrderNumbers = visibleRequestIds
            .map((visibleRequestId, index) =>
              missingRequestIds.includes(visibleRequestId) ? visibleOrderNumbers[index] : "",
            )
            .filter(Boolean);
        }
      } else if (intent === "courier_finish_delivery_confirmation") {
        dailyAccess.deliveryConfirmationComplete = true;
      } else {
        const orderNumber = String(formData.get("orderNumber") || "").trim();
        if (!requestId || !orderNumber) {
          return { ok: false, confirmationError: "No se pudo identificar la orden." };
        }
        if (intent === "courier_confirm_delivery" && formData.get("confirmed") !== "yes") {
          return { ok: false, confirmationError: "Marca la casilla antes de confirmar." };
        }
        if (!confirmedRequestIds.includes(requestId)) {
          confirmedRequestIds.push(requestId);
        }
        if (intent === "courier_mark_delivery_missing" && !missingOrderNumbers.includes(orderNumber)) {
          missingOrderNumbers.push(orderNumber);
        }
        dailyAccess.confirmedRequestIds = confirmedRequestIds;
        dailyAccess.missingOrderNumbers = missingOrderNumbers;
      }

      url.searchParams.set("shop", shop);
      url.searchParams.set("tab", "pedidos");
      url.searchParams.set("updated", String(Date.now()));
      const updatedDailyAccess = {
        ...dailyAccess,
        confirmedRequestIds: Array.isArray(dailyAccess.confirmedRequestIds)
          ? [...dailyAccess.confirmedRequestIds]
          : [],
        missingOrderNumbers: Array.isArray(dailyAccess.missingOrderNumbers)
          ? [...dailyAccess.missingOrderNumbers]
          : [],
        deliveryConfirmationComplete: Boolean(dailyAccess.deliveryConfirmationComplete),
      };
      const headers = new Headers();
      headers.append(
        "Set-Cookie",
        await courierDailyAccessCookie.serialize(updatedDailyAccess),
      );
      if (updatedDailyAccess.deliveryConfirmationComplete) {
        headers.append(
          "Set-Cookie",
          await courierDeliveryConfirmationCookie.serialize({
            shop,
            courierId: Number(dailyAccess.courierId),
            dateKey: courierMexicoDateKey(new Date()),
            complete: true,
          }),
        );
      }
      return redirect(`${url.pathname}?${url.searchParams.toString()}`, { headers });
    }

    if (
      ![
        "courier_mark_en_route",
        "courier_mark_not_delivered",
        "courier_mark_delivered",
        "courier_retry_delivery",
        "courier_return_mark_received",
        "courier_return_pickup_attempt_failed",
        "courier_return_retry_pickup",
        "courier_return_reject_after_failed_pickups",
      ].includes(intent) ||
      !requestId
    ) {
      return { ok: false, error: "Accion no valida." };
    }

    const actionHandler =
      intent === "courier_mark_delivered"
        ? markCourierOrderAsDelivered
        : intent === "courier_return_mark_received"
          ? markCourierReturnAsReceived
        : intent === "courier_return_retry_pickup"
          ? markCourierReturnForRetry
        : intent === "courier_return_pickup_attempt_failed"
          ? markCourierReturnPickupAttemptFailed
        : intent === "courier_return_reject_after_failed_pickups"
          ? rejectCourierReturnAfterFailedPickups
        : intent === "courier_mark_not_delivered"
        ? markCourierOrderAsNotDelivered
        : intent === "courier_retry_delivery"
          ? markCourierOrderForRetry
          : markCourierOrderAsEnRoute;
    const result = await actionHandler({
      shopDomain: shop,
      requestId,
      orderNumber: String(formData.get("orderNumber") || "").trim(),
      customerName: String(formData.get("customerName") || "").trim(),
      customerEmail: String(formData.get("customerEmail") || "").trim(),
      customerPhone: String(formData.get("customerPhone") || "").trim(),
      currentStatus: String(formData.get("currentStatus") || "").trim(),
      currentAttemptCount: String(formData.get("currentAttemptCount") || "").trim(),
      rejectionReason: String(formData.get("rejectionReason") || "").trim(),
    });
    if (!result.ok) {
      return result;
    }

    await prisma.courierActivity.create({
      data: {
        shop,
        courierId: Number(dailyAccess.courierId),
        courierName: String(dailyAccess.courierName || ""),
        requestId,
        orderNumber: String(formData.get("orderNumber") || "").trim() || null,
        action: intent,
        routeId: String(dailyAccess.routeId || "") || null,
      },
    });

    if (shop) {
      url.searchParams.set("shop", shop);
    }

    let nextOverrideRequestId = requestId;
    let nextOverrideStatus = String(
      result?.nextStatus ||
        (intent === "courier_mark_delivered"
          ? "entregado"
          : intent === "courier_mark_not_delivered"
            ? "no_entregado"
            : intent === "courier_retry_delivery"
              ? "reintento_pendiente"
              : "en_ruta"),
    );
    let nextOverrideAttemptCount = String(result?.attemptCount || formData.get("currentAttemptCount") || "0");
    const nextTab =
      intent === "courier_return_mark_received" ||
      intent === "courier_return_pickup_attempt_failed" ||
      intent === "courier_return_reject_after_failed_pickups"
        ? "historial"
        : "en_ruta";

    url.searchParams.set("tab", nextTab);
    url.searchParams.set("overrideRequestId", nextOverrideRequestId);
    url.searchParams.set("overrideStatus", nextOverrideStatus);
    url.searchParams.set("overrideAttemptCount", nextOverrideAttemptCount);
    url.searchParams.set("updated", String(Date.now()));
    return redirect(`${url.pathname}?${url.searchParams.toString()}`);
  } catch (error) {
    console.error("Courier route action failed", error);
    return {
      ok: false,
      error: String(error?.message || error || "No se pudo procesar la accion del repartidor."),
    };
  }
};
export const loader = async ({ request }) => {
  const { default: prisma } = await import("../db.server");
  const {
    fetchCourierOrdersByIdsForShop,
    fetchCourierOrdersForShop,
    fetchPickupCourierOrders,
    markCourierOrderReadyForBranchPickup,
    resolveCourierPortalShop,
  } = await import("../utils/courier.server");
  const url = new URL(request.url);
  const { shop, sessionCandidates, allSessionCandidates } = await resolveCourierPortalShop(request);
  const requestedTab = String(url.searchParams.get("tab") || "pedidos").trim().toLowerCase();
  const activeTab = ["pedidos", "en_ruta", "historial"].includes(requestedTab) ? requestedTab : "pedidos";
  const overrideRequestId = String(url.searchParams.get("overrideRequestId") || "").trim();
  const overrideStatus = String(url.searchParams.get("overrideStatus") || "").trim().toLowerCase();
  const overrideAttemptCount = Math.max(0, Number(url.searchParams.get("overrideAttemptCount") || "0"));

  const dailyAccess = shop ? await getCourierDailyAccess(request, shop) : null;
  if (!dailyAccess) {
    return {
      activeTab,
      shop: shop || "",
      courierOrders: [],
      requiresDailyAccess: true,
      courierName: "",
    };
  }

  if (!shop || !sessionCandidates?.length) {
    return {
      activeTab,
      shop: shop || "",
      courierOrders: [],
      error:
        "No se encontro una sesion valida para la tienda. Verifica que la app siga instalada y que exista una sesion offline.",
    };
  }
  const deliveryConfirmationComplete =
    Boolean(dailyAccess.deliveryConfirmationComplete) ||
    (await hasCourierDeliveryConfirmation(request, dailyAccess, shop));
  const currentRouteActivities = dailyAccess.routeId
    ? await prisma.courierActivity.findMany({
        where: {
          shop,
          courierId: Number(dailyAccess.courierId),
          routeId: String(dailyAccess.routeId),
          action: { notIn: ["courier_route_started", "courier_route_finished"] },
        },
        select: { requestId: true, action: true },
      })
    : [];
  const currentRouteRequestIds = new Set(
    currentRouteActivities.map((activity) => String(activity.requestId || "").trim()).filter(Boolean),
  );
  const currentRouteActionByRequestId = new Map(
    currentRouteActivities
      .map((activity) => [
        String(activity.requestId || "").trim(),
        String(activity.action || "").trim(),
      ])
      .filter(([requestId]) => requestId),
  );
  for (const activity of currentRouteActivities) {
    const activityRequestId = String(activity.requestId || "").trim();
    const activityAction = String(activity.action || "").trim();
    if (!activityRequestId || activityAction === "courier_route_order_assigned") continue;
    currentRouteActionByRequestId.set(activityRequestId, activityAction);
  }

  const sessionCandidatesByShop = new Map();
  for (const sessionCandidate of allSessionCandidates || sessionCandidates || []) {
    const candidateShop = String(sessionCandidate?.shop || "").trim().toLowerCase();
    if (!candidateShop) continue;
    const current = sessionCandidatesByShop.get(candidateShop) || [];
    current.push(sessionCandidate);
    sessionCandidatesByShop.set(candidateShop, current);
  }

  const shopCandidates = [
    shop,
    ...Array.from(sessionCandidatesByShop.keys()).filter((candidate) => candidate !== shop),
  ].filter(Boolean);

  let courierOrders = [];
  let resolvedShop = shop;

  for (const shopCandidate of shopCandidates) {
    const candidateSessions = sessionCandidatesByShop.get(shopCandidate) || [];
    if (!candidateSessions.length) continue;

    const [deliveryResult, pickupResult] = await Promise.allSettled([
      fetchCourierOrdersForShop({ shop: shopCandidate, sessionCandidates: candidateSessions }),
      fetchPickupCourierOrders(shopCandidate),
    ]);

    const deliveryOrders = deliveryResult.status === "fulfilled" ? deliveryResult.value : [];
    const pickupOrders = pickupResult.status === "fulfilled" ? pickupResult.value : [];
    const nextCourierOrders = [...deliveryOrders, ...pickupOrders].sort(
      (a, b) => courierOrderTimestampMs(a) - courierOrderTimestampMs(b),
    );

    if (deliveryOrders.length > 0) {
      courierOrders = nextCourierOrders;
      resolvedShop = shopCandidate;
      break;
    }

    if (!courierOrders.length && nextCourierOrders.length > 0) {
      courierOrders = nextCourierOrders;
      resolvedShop = shopCandidate;
    }
  }

  const overrideTargetOrder = courierOrders.find((requestRow) => String(requestRow?.id || "").trim() === overrideRequestId);
  if (overrideTargetOrder && overrideStatus) {
    courierOrders = courierOrders.map((requestRow) => {
      if (String(requestRow?.id || "").trim() !== overrideRequestId) {
        return requestRow;
      }

      const persistedStatus = String(requestRow?.status || "").trim().toLowerCase();
      const hasFinalPersistedStatus = ["rechazada", "recibida", "reembolsada", "completada", "denegada"].includes(
        persistedStatus,
      );
      if (hasFinalPersistedStatus) {
        return requestRow;
      }

      return {
        ...requestRow,
        status: overrideStatus,
        attemptCount: overrideAttemptCount || Number(requestRow?.attemptCount || 0),
      };
    });
  }

  if (
    overrideRequestId &&
    !overrideRequestId.startsWith("pickup-") &&
    overrideStatus === "no_entregado" &&
    overrideAttemptCount >= 3 &&
    String(overrideTargetOrder?.status || "").trim().toLowerCase() !== "recoger_en_sucursal"
  ) {
    await markCourierOrderReadyForBranchPickup({
      shopDomain: resolvedShop,
      requestId: overrideRequestId,
      orderNumber: overrideTargetOrder?.orderNumber || "",
    });
    courierOrders = courierOrders.map((requestRow) =>
      String(requestRow?.id || "").trim() === overrideRequestId
        ? {
            ...requestRow,
            status: "recoger_en_sucursal",
            attemptCount: Math.max(overrideAttemptCount, Number(requestRow?.attemptCount || 0), 3),
          }
        : requestRow,
    );
  }

  courierOrders = courierOrders.map((requestRow) => {
    const normalizedStatus = String(requestRow?.status || "").trim().toLowerCase();
    const normalizedLabel = String(requestRow?.courierLabel || "").trim().toLowerCase();
    if (
      normalizedLabel === "entrega" &&
      normalizedStatus === "no_entregado" &&
      !isCourierHistoryFromToday(requestRow)
    ) {
      return {
        ...requestRow,
        status: "pendiente",
        courierHistoryAt: "",
      };
    }
    return requestRow;
  });

  if (dailyAccess.routeId && courierOrders.length) {
    const assignedRequestIds = new Set(
      currentRouteActivities.map((activity) => String(activity.requestId || "").trim()).filter(Boolean),
    );
    const unassignedOrders = courierOrders.filter(
      (requestRow) =>
        isCourierWorkableForCurrentRoute(requestRow) &&
        !assignedRequestIds.has(String(requestRow?.id || "").trim()),
    );
    if (unassignedOrders.length) {
      await prisma.courierActivity.createMany({
        data: unassignedOrders.map((requestRow) => ({
          shop,
          courierId: Number(dailyAccess.courierId),
          courierName: String(dailyAccess.courierName || ""),
          requestId: String(requestRow.id || ""),
          orderNumber: String(requestRow.orderNumber || "").trim() || null,
          action: "courier_route_order_assigned",
          routeId: String(dailyAccess.routeId),
        })),
      });
      for (const requestRow of unassignedOrders) {
        currentRouteRequestIds.add(String(requestRow.id || "").trim());
      }
    }
  }

  if (dailyAccess.routeId && currentRouteRequestIds.size) {
    const loadedRequestIds = new Set(
      courierOrders.map((requestRow) => String(requestRow?.id || "").trim()).filter(Boolean),
    );
    const missingDeliveryRequestIds = Array.from(currentRouteRequestIds).filter(
      (requestId) =>
        requestId &&
        !requestId.startsWith("pickup-") &&
        !loadedRequestIds.has(requestId),
    );
    if (missingDeliveryRequestIds.length) {
      const recoveredOrders = await fetchCourierOrdersByIdsForShop({
        shop: resolvedShop,
        sessionCandidates: sessionCandidatesByShop.get(resolvedShop) || sessionCandidates,
        orderIds: missingDeliveryRequestIds,
      });
      if (recoveredOrders.length) {
        courierOrders = [...courierOrders, ...recoveredOrders].sort(
          (a, b) => courierOrderTimestampMs(a) - courierOrderTimestampMs(b),
        );
      }
    }
  }

  const routeCourierOrders = courierOrders.map((requestRow) => {
    const requestId = String(requestRow?.id || "").trim();
    if (currentRouteRequestIds.has(requestId)) {
      const routeAction = currentRouteActionByRequestId.get(requestId);
      if (shouldResetAssignedOrderForCurrentRoute(requestRow, routeAction)) {
        return {
          ...requestRow,
          status: "pendiente",
          courierHistoryAt: "",
        };
      }
      return requestRow;
    }
    if (!isCourierWorkableForCurrentRoute(requestRow)) return null;
    return {
      ...requestRow,
      status: "pendiente",
      courierHistoryAt: "",
    };
  }).filter(Boolean);

  return {
    activeTab,
    shop: resolvedShop,
    courierOrders: routeCourierOrders,
    requiresDailyAccess: false,
    courierName: dailyAccess.courierName || "",
    confirmedRequestIds: Array.isArray(dailyAccess.confirmedRequestIds)
      ? dailyAccess.confirmedRequestIds.map((value) => String(value || ""))
      : [],
    missingOrderNumbers: Array.isArray(dailyAccess.missingOrderNumbers)
      ? dailyAccess.missingOrderNumbers.map((value) => String(value || ""))
      : [],
    deliveryConfirmationComplete,
  };
};

export default function RepartidorPublicPortal() {
  const {
    shop,
    courierOrders,
    activeTab: initialActiveTab,
    requiresDailyAccess,
    courierName,
    confirmedRequestIds = [],
    missingOrderNumbers = [],
    deliveryConfirmationComplete = false,
  } = useLoaderData();
  const actionData = useActionData();
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState(initialActiveTab || "pedidos");
  const [failedPickupRequest, setFailedPickupRequest] = useState(null);
  if (requiresDailyAccess) {
    return (
      <main className={styles.page}>
        <div className={styles.accessContainer}>
          <section className={`${styles.card} ${styles.accessCard}`}>
            <p className={styles.eyebrow}>Portal del repartidor</p>
            <h1 className={styles.cardTitle}>Ingresa tu codigo</h1>
            <p className={styles.subtitle}>Tu codigo es necesario para acceder a las ordenes de hoy.</p>
            {actionData?.loginError ? (
              <p className={styles.accessError} role="alert">{actionData.loginError}</p>
            ) : null}
            <Form method="post" reloadDocument className={styles.accessForm}>
              <input type="hidden" name="intent" value="courier_daily_login" />
              <input type="hidden" name="shop" value={shop || ""} />
              <input
                className={styles.accessInput}
                name="code"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                placeholder="Codigo de 6 digitos"
                autoComplete="one-time-code"
                required
              />
              <button className={styles.accessButton} type="submit">Entrar</button>
            </Form>
          </section>
        </div>
      </main>
    );
  }
  const deliveryConfirmationOrders = courierOrders
    .filter(
      (request) =>
        String(request?.courierLabel || "").trim().toLowerCase() === "entrega" &&
        !isCourierRouteTabStatus(request?.status) &&
        !isCourierHistoryStatus(request?.status),
    )
    .sort(compareCourierDisplayOrder);
  const confirmedRequestIdSet = new Set(confirmedRequestIds);
  const unconfirmedDeliveryOrders = deliveryConfirmationOrders.filter(
    (request) => !confirmedRequestIdSet.has(String(request?.id || "")),
  );
  const isSecondConfirmationPass =
    missingOrderNumbers.length > 0 && unconfirmedDeliveryOrders.length > 0;
  const confirmationOrders = (
    isSecondConfirmationPass ? unconfirmedDeliveryOrders : deliveryConfirmationOrders
  ).slice().reverse();
  const requiresDeliveryConfirmation =
    !deliveryConfirmationComplete &&
    confirmationOrders.length > 0;

  if (requiresDeliveryConfirmation) {
    return (
      <main className={styles.page}>
        <div className={styles.accessContainer}>
          <section className={`${styles.card} ${styles.confirmationCard}`}>
            <p className={styles.eyebrow}>Cariana repartidores</p>
            <h1 className={styles.cardTitle}>Confirma tus entregas</h1>
            <p className={`${styles.subtitle} ${isSecondConfirmationPass ? styles.confirmationWarning : ""}`}>
              {isSecondConfirmationPass
                ? "Te faltan estas órdenes por confirmar. Revisa que sí las tengas."
                : "Revisa que tengas físicamente cada pedido antes de comenzar."}
            </p>

            {actionData?.confirmationError ? (
              <p className={styles.accessError} role="alert">{actionData.confirmationError}</p>
            ) : null}

            <Form
              method="post"
              reloadDocument
              className={styles.confirmationForm}
              onSubmit={(event) => {
                if (!window.confirm("¿Estás seguro de confirmar las órdenes marcadas?")) {
                  event.preventDefault();
                }
              }}
            >
              <input type="hidden" name="intent" value="courier_confirm_delivery_list" />
              <input type="hidden" name="shop" value={shop || ""} />
              <div className={styles.confirmationList}>
                {confirmationOrders.map((request) => {
                  const sequence =
                    deliveryConfirmationOrders.findIndex(
                      (deliveryOrder) => String(deliveryOrder?.id || "") === String(request?.id || ""),
                    ) + 1;
                  return (
                    <div className={styles.confirmationListItem} key={request.id}>
                      <input type="hidden" name="visibleRequestIds" value={request.id} />
                      <input type="hidden" name="visibleOrderNumbers" value={request.orderNumber} />
                      <input
                        aria-label={`Confirmar pedido ${request.orderNumber}`}
                        type="checkbox"
                        name="confirmedRequestIds"
                        value={request.id}
                      />
                      <span className={styles.orderSequenceBadge}>{sequence}</span>
                      <strong>Pedido #{request.orderNumber}</strong>
                    </div>
                  );
                })}
              </div>
              <button className={styles.accessButton} type="submit">Confirmar</button>
            </Form>
          </section>
        </div>
      </main>
    );
  }
  const overrideRequestId = String(searchParams.get("overrideRequestId") || "").trim();
  const overrideStatus = String(searchParams.get("overrideStatus") || "").trim().toLowerCase();
  const overrideAttemptCount = Math.max(0, Number(searchParams.get("overrideAttemptCount") || "0"));
  const effectiveCourierOrders = courierOrders.map((request) =>
    (() => {
      const isOverrideTarget = overrideRequestId && String(request?.id || "").trim() === overrideRequestId;
      const persistedStatus = String(request?.status || "").trim().toLowerCase();
      const hasFinalPersistedStatus = ["rechazada", "recibida", "reembolsada", "completada", "denegada"].includes(
        persistedStatus,
      );
      const canApplyOverride = isOverrideTarget && !hasFinalPersistedStatus;
      const attemptCount = canApplyOverride
        ? overrideAttemptCount || Number(request?.attemptCount || 0)
        : Number(request?.attemptCount || 0);
      const status = canApplyOverride ? overrideStatus || request?.status || "pendiente" : request?.status;
      return {
        ...request,
        status: status === "no_entregado" && attemptCount >= 3 ? "recoger_en_sucursal" : status,
        attemptCount,
      };
    })(),
  );
  const historyOrders = effectiveCourierOrders
    .filter((request) => isCourierHistoryStatus(request?.status) && isCourierHistoryFromToday(request))
    .sort((firstRequest, secondRequest) => courierHistoryTimestampMs(secondRequest) - courierHistoryTimestampMs(firstRequest));
  const routeOrders = effectiveCourierOrders
    .filter((request) => isCourierRouteTabStatus(request?.status))
    .sort(compareCourierDisplayOrder);
  const pendingOrders = effectiveCourierOrders
    .filter((request) => !isCourierRouteTabStatus(request?.status) && !isCourierHistoryStatus(request?.status))
    .sort(compareCourierDisplayOrder);
  const sequenceByOrderId = new Map(
    [...pendingOrders, ...routeOrders, ...historyOrders]
      .sort(compareCourierDisplayOrder)
      .map((request, index) => [String(request?.id || ""), index + 1]),
  );
  const activeOrdersCount = pendingOrders.length + routeOrders.length;
  const dailyOrdersCount = activeOrdersCount + historyOrders.length;
  const routeOrder = routeOrders[0] || null;
  const pendingPreviewOrder = pendingOrders[0] || null;
  const visibleOrders =
    activeTab === "en_ruta"
      ? routeOrder
        ? [routeOrder]
        : pendingPreviewOrder
          ? [pendingPreviewOrder]
          : []
      : activeTab === "historial"
        ? historyOrders
        : pendingOrders;
  const hasOrders = visibleOrders.length > 0;
  const emptyMessage =
    activeTab === "en_ruta"
      ? "No hay pedidos en ruta."
      : activeTab === "historial"
        ? "No hay ordenes en historial."
        : "No hay ordenes pendientes por entregar.";
  const isReturnOrder = (request) =>
    String(request?.courierLabel || "")
      .trim()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase() === "devolucion";
  const isRouteActionVisible = (request) => !isCourierRouteStatus(request?.status) && !isCourierHistoryStatus(request?.status);
  const isNotDeliveredStatus = (request) => String(request?.status || "").trim().toLowerCase() === "no_entregado";
  const isPickupReadyStatus = (request) => String(request?.status || "").trim().toLowerCase() === "recoger_en_sucursal";
  const isReturnRetryPendingStatus = (request) =>
    isReturnOrder(request) && String(request?.status || "").trim().toLowerCase() === "reintento_pendiente";
  const isReturnRetryRouteStatus = (request) =>
    isReturnOrder(request) && /^en_ruta_[23]$/.test(String(request?.status || "").trim().toLowerCase());
  const isReturnPickupFailedStatus = (request) =>
    ["intento_fallido_1", "intento_fallido_2", "intento_fallido_3"].includes(
      String(request?.status || "").trim().toLowerCase(),
    );
  const isReturnRejectedStatus = (request) =>
    isReturnOrder(request) && String(request?.status || "").trim().toLowerCase() === "rechazada";
  const canShowReturnResultActions = (request) =>
    isReturnOrder(request) &&
    activeTab === "en_ruta" &&
    isCourierRouteStatus(request?.status);
  const canShowDeliveryResultActions = (request) =>
    !isReturnOrder(request) &&
    activeTab === "en_ruta" &&
    isCourierRouteStatus(request?.status);
  const buildMapsUrl = (request) => {
    const address = formatCourierAddress(request);
    const query = encodeURIComponent(address);
    return `https://www.google.com/maps/search/?api=1&query=${query}`;
  };

  const buildPhoneUrl = (request) => {
    const phone = String(request?.customerPhone || "").trim();
    const safePhone = phone.replace(/[^\d+]/g, "");
    return safePhone ? `tel:${safePhone}` : "";
  };

  const handleTabChange = (nextTab) => {
    setActiveTab(nextTab);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("tab", nextTab);
    if (shop) {
      nextParams.set("shop", shop);
    }
    window.history.replaceState(null, "", `${window.location.pathname}?${nextParams.toString()}`);
  };

  const confirmCourierAction = (request, actionLabel, confirmNote = "Esta accion enviara una notificacion al cliente.") => {
    const orderNumber = String(request?.orderNumber || "").trim() || "-";
    const customerName = String(request?.customerName || "Cliente").trim();
    return window.confirm(
      `Seguro que quieres marcar el pedido #${orderNumber} como ${actionLabel}?\n\nCliente: ${customerName}\n\n${confirmNote}`,
    );
  };

  const renderCourierActionForm = (
    request,
    buttonLabel,
    intent,
    actionLabel = buttonLabel.toLowerCase(),
    buttonClassName = styles.actionButton,
    confirmNote = "Esta accion enviara una notificacion al cliente.",
  ) => (
    <Form
      method="post"
      className={styles.inlineActionForm}
      onSubmit={(event) => {
        if (!confirmCourierAction(request, actionLabel, confirmNote)) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="shop" value={shop || ""} />
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="requestId" value={String(request.id || "")} />
      <input type="hidden" name="orderNumber" value={String(request.orderNumber || "")} />
      <input type="hidden" name="customerName" value={String(request.customerName || "")} />
      <input type="hidden" name="customerEmail" value={String(request.customerEmail || "")} />
      <input type="hidden" name="customerPhone" value={String(request.customerPhone || "")} />
      <input type="hidden" name="currentStatus" value={String(request.status || "")} />
      <input type="hidden" name="currentAttemptCount" value={String(request.attemptCount || 0)} />
      <button type="submit" className={buttonClassName}>
        {buttonLabel}
      </button>
    </Form>
  );

  const renderFailedPickupReasonForm = (request, rejectionReason, index) => {
    const failedPickupMessage = getFailedPickupMessage(request, rejectionReason);
    return (
      <Form
      method="post"
      onSubmit={(event) => {
        if (!confirmCourierAction(request, "intento de devolucion fallido", "Se enviara el mensaje seleccionado al cliente.")) {
          event.preventDefault();
          return;
        }
        setFailedPickupRequest(null);
      }}
    >
      <input type="hidden" name="shop" value={shop || ""} />
      <input
        type="hidden"
        name="intent"
        value={String(request.status || "").toLowerCase() === "en_ruta_3"
          ? "courier_return_reject_after_failed_pickups"
          : "courier_return_pickup_attempt_failed"}
      />
      <input type="hidden" name="requestId" value={String(request.id || "")} />
      <input type="hidden" name="orderNumber" value={String(request.orderNumber || "")} />
      <input type="hidden" name="customerName" value={String(request.customerName || "")} />
      <input type="hidden" name="customerEmail" value={String(request.customerEmail || "")} />
      <input type="hidden" name="customerPhone" value={String(request.customerPhone || "")} />
      <input type="hidden" name="currentStatus" value={String(request.status || "")} />
      <input type="hidden" name="currentAttemptCount" value={String(request.attemptCount || 0)} />
        <input type="hidden" name="rejectionReason" value={failedPickupMessage} />
        <button type="submit" className={styles.reasonOptionButton}>
          <span className={styles.reasonOptionLabel}>Mensaje automatico {index + 1}</span>
          <span className={styles.reasonOptionText}>{failedPickupMessage}</span>
        </button>
      </Form>
    );
  };
  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>Cariana repartidores</h1>
            <p className={styles.subtitle}>
              {courierName ? `Repartidor: ${courierName}` : "Ordenes pendientes de entrega y devolucion."}
            </p>
          </div>
          <Form
            method="post"
            onSubmit={(event) => {
              if (!window.confirm("¿Estas seguro de finalizar la ruta? Tu codigo actual dejara de funcionar.")) {
                event.preventDefault();
              }
            }}
          >
            <input type="hidden" name="intent" value="courier_finish_route" />
            <input type="hidden" name="shop" value={shop || ""} />
            <button className={styles.logoutButton} type="submit">Finalizar ruta</button>
          </Form>
        </header>

        <section className={styles.card}>
          {actionData?.ok === false && actionData?.error ? (
            <p className={styles.empty} role="alert" aria-live="polite">
              {actionData.error}
            </p>
          ) : null}
          <div className={styles.cardHeader}>
            <h2 className={styles.cardTitle}>Ordenes repartidor</h2>
            <div className={styles.counterGroup} aria-label="Resumen de ordenes pendientes">
              <span className={styles.counterBadge}>Ordenes {dailyOrdersCount}</span>
              <span className={styles.counterBadge}>Restantes {activeOrdersCount}</span>
            </div>
          </div>
          <div className={styles.tabRow} role="tablist" aria-label="Secciones de repartidor">
            <button
              type="button"
              className={`${styles.tabButton} ${activeTab === "pedidos" ? styles.tabButtonActive : ""}`}
              onClick={() => handleTabChange("pedidos")}
            >
              Pedidos
            </button>
            <button
              type="button"
              className={`${styles.tabButton} ${activeTab === "en_ruta" ? styles.tabButtonActive : ""}`}
              onClick={() => handleTabChange("en_ruta")}
            >
              En ruta
            </button>
            <button
              type="button"
              className={`${styles.tabButton} ${activeTab === "historial" ? styles.tabButtonActive : ""}`}
              onClick={() => handleTabChange("historial")}
            >
              Historial
            </button>
          </div>

          {!hasOrders ? (
            <p className={styles.empty}>{emptyMessage}</p>
          ) : (
            <div className={adminStyles.courierGrid}>
              {visibleOrders.map((request, index) => (
                <article
                  key={request.id}
                  className={`${adminStyles.courierCard} ${
                    request.courierLabel === "Devolucion"
                      ? adminStyles.courierCardReturn
                      : adminStyles.courierCardDelivery
                  }`}
                >
                  <div className={adminStyles.courierHeader}>
                    <div className={styles.orderBadgeGroup}>
                      <span className={styles.orderSequenceBadge}>
                        {sequenceByOrderId.get(String(request?.id || "")) || index + 1}
                      </span>
                      <span
                        className={
                          request.courierLabel === "Devolucion"
                            ? adminStyles.courierBadgeReturn
                            : adminStyles.courierBadgeDelivery
                        }
                      >
                        {request.courierLabel}
                      </span>
                    </div>
                    <div className={styles.statusGroup}>
                      {!isReturnOrder(request) && getDeliveryAttemptLabel(request, activeTab) ? (
                        <span className={`${adminStyles.courierBadgeStatus} ${styles.statusBadgeFailed}`}>
                          {getDeliveryAttemptLabel(request, activeTab)}
                        </span>
                      ) : null}
                      {isReturnOrder(request) && isReturnPickupFailedStatus(request) ? (
                        <>
                          <span className={`${adminStyles.courierBadgeStatus} ${styles.statusBadgeAttempt}`}>
                            {getReturnFailedAttemptLabel(request)}
                          </span>
                          <span className={`${adminStyles.courierBadgeStatus} ${styles.statusBadgeFailed}`}>
                            no recibido
                          </span>
                        </>
                      ) : isReturnRejectedStatus(request) ? (
                        <>
                          <span className={`${adminStyles.courierBadgeStatus} ${styles.statusBadgeAttempt}`}>
                            3 intentos
                          </span>
                          <span className={`${adminStyles.courierBadgeStatus} ${styles.statusBadgeFailed}`}>
                            rechazada
                          </span>
                        </>
                      ) : (
                        <>
                          {isReturnOrder(request) &&
                          String(request.status || "").trim().toLowerCase() === "recibida" &&
                          Number(request.attemptCount || 0) >= 2 ? (
                            <span className={`${adminStyles.courierBadgeStatus} ${styles.statusBadgeAttempt}`}>
                              {`${Number(request.attemptCount)} intentos`}
                            </span>
                          ) : null}
                          {isReturnRetryPendingStatus(request) || isReturnRetryRouteStatus(request) ? (
                            <span className={`${adminStyles.courierBadgeStatus} ${styles.statusBadgeAttempt}`}>
                              {getReturnRetryAttemptLabel(request)}
                            </span>
                          ) : null}
                          <span
                            className={`${adminStyles.courierBadgeStatus} ${
                              isCourierRouteStatus(request.status)
                                ? styles.statusBadgeRoute
                                : ["recibida", "entregado"].includes(
                                    String(request.status || "").trim().toLowerCase(),
                                  )
                                  ? styles.statusBadgeReceived
                                : isPickupReadyStatus(request)
                                  ? styles.statusBadgeAttempt
                                : isNotDeliveredStatus(request)
                                  ? styles.statusBadgeFailed
                                  : ""
                            }`}
                        >
                            {activeTab === "pedidos" ||
                            (activeTab === "en_ruta" && !isCourierRouteStatus(request.status))
                              ? "pendiente"
                              : getCourierStatusLabel(request.status)}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <h3 className={adminStyles.courierOrderNumber}>#{request.orderNumber}</h3>
                  <p className={adminStyles.courierCustomerName}>{request.customerName}</p>
                  <p className={adminStyles.courierField}>
                    <strong>Programado:</strong> {formatCourierScheduledDate(request.pickupDate)}
                  </p>
                  <p className={adminStyles.courierAddress}>{formatCourierAddress(request)}</p>
                  <p className={adminStyles.courierField}>{request.customerPhone || "-"}</p>
                  {activeTab === "historial" && !isReturnOrder(request) && isNotDeliveredStatus(request) ? (
                    <div className={styles.historyActionRow}>
                      {renderCourierActionForm(
                        request,
                        "Reeintentar",
                        "courier_retry_delivery",
                        "reeintentar entrega",
                        `${styles.actionButton} ${styles.actionButtonRetry}`,
                        "Esta accion devolvera la orden al flujo de ruta para intentar la entrega nuevamente.",
                      )}
                    </div>
                  ) : null}
                  {activeTab === "historial" &&
                  isReturnOrder(request) &&
                  isReturnPickupFailedStatus(request) &&
                  String(request.status || "").toLowerCase() !== "intento_fallido_3" ? (
                    <div className={styles.historyActionRow}>
                      {renderCourierActionForm(
                        request,
                        "Reintentar",
                        "courier_return_retry_pickup",
                        "reintentar devolucion",
                        `${styles.actionButton} ${styles.actionButtonRetry}`,
                        "Esta accion devolvera la devolucion a En ruta como pendiente para que despues puedas marcarla en ruta manualmente.",
                      )}
                    </div>
                  ) : null}
                  {activeTab === "historial" &&
                  isReturnOrder(request) &&
                  String(request.status || "").toLowerCase() === "intento_fallido_3" ? (
                    <div className={styles.historyActionRow}>
                      {renderCourierActionForm(
                        request,
                        "Rechazar devolucion",
                        "courier_return_reject_after_failed_pickups",
                        "rechazada",
                        `${styles.actionButton} ${styles.actionButtonDanger}`,
                        "Esta accion rechazara definitivamente la devolucion y notificara al cliente.",
                      )}
                    </div>
                  ) : null}
                  {activeTab === "en_ruta" ? (
                    <div className={styles.actionRow}>
                      {isReturnOrder(request) ? (
                        <>
                          <a
                            className={`${styles.actionButton} ${styles.actionButtonPrimary}`}
                            href={buildMapsUrl(request)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Mapa
                          </a>
                          {buildPhoneUrl(request) ? (
                            <a
                              className={`${styles.actionButton} ${styles.actionButtonSecondary}`}
                              href={buildPhoneUrl(request)}
                            >
                              Telefono
                            </a>
                          ) : (
                            <button
                              type="button"
                              className={`${styles.actionButton} ${styles.actionButtonSecondary}`}
                              disabled
                            >
                              Telefono
                            </button>
                          )}
                          {isRouteActionVisible(request) ? renderCourierActionForm(request, "En ruta", "courier_mark_en_route", "en ruta") : null}
                          {canShowReturnResultActions(request) ? (
                            <>
                              {renderCourierActionForm(
                                request,
                                "Recibido",
                                "courier_return_mark_received",
                                "recibido",
                              )}
                              <button
                                type="button"
                                className={`${styles.actionButton} ${styles.actionButtonDanger}`}
                                onClick={() => setFailedPickupRequest(request)}
                              >
                                No recibido
                              </button>
                            </>
                          ) : null}
                        </>
                      ) : (
                        <>
                          <a
                            className={`${styles.actionButton} ${styles.actionButtonPrimary}`}
                            href={buildMapsUrl(request)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Mapa
                          </a>
                          {buildPhoneUrl(request) ? (
                            <a
                              className={`${styles.actionButton} ${styles.actionButtonSecondary}`}
                              href={buildPhoneUrl(request)}
                            >
                              Telefono
                            </a>
                          ) : (
                            <button
                              type="button"
                              className={`${styles.actionButton} ${styles.actionButtonSecondary}`}
                              disabled
                            >
                              Telefono
                            </button>
                          )}
                          {isRouteActionVisible(request) ? renderCourierActionForm(request, "En ruta", "courier_mark_en_route", "en ruta") : null}
                          {canShowDeliveryResultActions(request) ? (
                            <>
                              {renderCourierActionForm(request, "Entregado", "courier_mark_delivered", "entregado")}
                              {renderCourierActionForm(
                                request,
                                "No entregado",
                                "courier_mark_not_delivered",
                                "no entregado",
                                `${styles.actionButton} ${styles.actionButtonDanger}`,
                              )}
                            </>
                          ) : null}
                        </>
                      )}
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
      {failedPickupRequest ? (
        <div className={styles.modalBackdrop} role="presentation" onClick={() => setFailedPickupRequest(null)}>
          <section
            className={styles.reasonModal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="failed-pickup-reason-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="failed-pickup-reason-title" className={styles.reasonModalTitle}>
              Selecciona un mensaje completo
            </h2>
            <div className={styles.reasonOptionList}>
              {(String(failedPickupRequest.status || "").toLowerCase() === "en_ruta_3"
                ? [FINAL_PICKUP_REJECTION_REASON]
                : PICKUP_FAILED_REASON_OPTIONS
              ).map((option, index) => (
                <div key={option}>{renderFailedPickupReasonForm(failedPickupRequest, option, index)}</div>
              ))}
            </div>
            <div className={styles.reasonModalActions}>
              <button type="button" className={styles.actionButton} onClick={() => setFailedPickupRequest(null)}>
                Cerrar
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
