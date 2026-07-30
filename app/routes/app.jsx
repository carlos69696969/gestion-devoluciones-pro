import { Outlet, useLoaderData, useLocation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  fetchBranchPickupCourierOrdersForShop,
  fetchCourierOrdersByIdsForShop,
  fetchCourierOrdersForShop,
} from "../utils/courier.server";
import { getCourierRouteStatusFromTags } from "../utils/courier.shared";
import {
  archiveAllZeroInventoryProducts,
  ensureStockInventoryArchiveWebhooks,
} from "../utils/stockZeroInventoryArchive.server";

const METHOD_QUEUE_STATUSES = new Set([
  "aprobada",
  "en_ruta",
  "reintento_pendiente",
  "intento_fallido_1",
  "intento_fallido_2",
  "no_recibido",
  "en_ruta_1",
  "en_ruta_2",
  "en_ruta_3",
]);
const MENU_COUNT_STATUSES = [
  "en_revision",
  "aprobada",
  "en_ruta",
  "reintento_pendiente",
  "intento_fallido_1",
  "intento_fallido_2",
  "no_recibido",
  "en_ruta_1",
  "en_ruta_2",
  "en_ruta_3",
  "recibida",
  "por_devolver",
];
const COURIER_ROUTE_PLANNED_ACTION = "courier_route_planned";
const COURIER_ROUTE_ASSIGNED_ACTION = "courier_route_order_assigned";
const HIDDEN_COURIER_DELIVERY_STATUSES = new Set([
  "entregado",
  "recibido",
  "recibida",
  "reembolsada",
  "completada",
  "recoger_en_sucursal",
]);
const ZERO_INVENTORY_ARCHIVE_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const zeroInventoryArchiveSyncByShop = new Map();

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
  return `${String(requestRow?.orderNumber || "").trim()}|${itemParts.join(",")}`;
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

function shouldCountActiveCourierDeliveryOrder(order) {
  const status = String(order?.status || order?.currentStatus || "").trim().toLowerCase();
  return !HIDDEN_COURIER_DELIVERY_STATUSES.has(status);
}

async function syncZeroInventoryArchiveFromAdmin(admin, shop) {
  const normalizedShop = String(shop || "").trim().toLowerCase();
  if (!admin || !normalizedShop) return;
  const now = Date.now();
  const lastSyncAt = Number(zeroInventoryArchiveSyncByShop.get(normalizedShop) || 0);
  if (now - lastSyncAt < ZERO_INVENTORY_ARCHIVE_SYNC_INTERVAL_MS) return;
  zeroInventoryArchiveSyncByShop.set(normalizedShop, now);
  try {
    await ensureStockInventoryArchiveWebhooks(admin);
    await archiveAllZeroInventoryProducts({ admin, shop: normalizedShop });
  } catch (error) {
    zeroInventoryArchiveSyncByShop.delete(normalizedShop);
    console.error("No se pudo sincronizar el archivado de productos agotados", error);
  }
}

async function fetchCourierDeliveryCountFromAdmin(admin, queryString) {
  const response = await admin.graphql(
    `#graphql
    query CourierDeliveryCount {
      orders(first: 250, query: "${queryString}", sortKey: UPDATED_AT, reverse: true) {
        edges {
          node {
            id
            displayFulfillmentStatus
            tags
            shippingLines(first: 5) {
              nodes {
                title
                code
                deliveryCategory
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
    throw new Error(errors[0]?.message || "No se pudieron contar las ordenes repartidor.");
  }
  const orderIds = new Set();
  for (const orderNode of payload?.data?.orders?.edges?.map((edge) => edge?.node).filter(Boolean) || []) {
    const fulfillmentStatus = String(orderNode?.displayFulfillmentStatus || "").toUpperCase();
    const courierStatus = getCourierRouteStatusFromTags(orderNode?.tags);
    if (
      isCourierLocalDeliveryOrder(orderNode) &&
      !["FULFILLED", "RESTOCKED"].includes(fulfillmentStatus) &&
      !["recoger_en_sucursal", "reembolsada", "entregado"].includes(courierStatus)
    ) {
      orderIds.add(String(orderNode.id || ""));
    }
  }
  return orderIds;
}

async function fetchCourierDeliveryCount(admin) {
  const orderIds = new Set();
  const errors = [];
  for (const queryString of ["fulfillment_status:unfulfilled", "status:open"]) {
    try {
      for (const orderId of await fetchCourierDeliveryCountFromAdmin(admin, queryString)) {
        if (orderId) orderIds.add(orderId);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (!orderIds.size && errors.length) throw errors[0];
  return orderIds.size;
}

async function activePlannedCourierDeliveryCount(shop, sessionCandidates = []) {
  const routePlans = await prisma.courierActivity.findMany({
    where: {
      shop,
      action: COURIER_ROUTE_PLANNED_ACTION,
      routeId: { not: null },
    },
    select: { courierId: true, routeId: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const latestRouteIdByCourierId = new Map();
  for (const plan of routePlans) {
    if (latestRouteIdByCourierId.has(plan.courierId)) continue;
    const routeId = String(plan.routeId || "").trim();
    if (routeId) latestRouteIdByCourierId.set(plan.courierId, routeId);
  }
  const routeIds = [...new Set([...latestRouteIdByCourierId.values()])];
  if (!routeIds.length) return 0;

  const finishedRoutes = await prisma.courierActivity.findMany({
    where: { shop, routeId: { in: routeIds }, action: "courier_route_finished" },
    select: { routeId: true },
  });
  const finishedRouteIds = new Set(finishedRoutes.map((activity) => String(activity.routeId || "").trim()));
  const activeRouteIds = routeIds.filter((routeId) => !finishedRouteIds.has(routeId));
  if (!activeRouteIds.length) return 0;

  const assignments = await prisma.courierActivity.findMany({
    where: {
      shop,
      routeId: { in: activeRouteIds },
      action: COURIER_ROUTE_ASSIGNED_ACTION,
    },
    select: { requestId: true },
  });
  const assignedDeliveryRequestIds = Array.from(new Set(
    assignments
      .map((assignment) => String(assignment.requestId || "").trim())
      .filter((requestId) => requestId && !requestId.startsWith("pickup-")),
  ));
  if (!assignedDeliveryRequestIds.length) return 0;

  const assignedOrders = await fetchCourierOrdersByIdsForShop({
    shop,
    sessionCandidates,
    orderIds: assignedDeliveryRequestIds,
  });
  return assignedOrders.filter(shouldCountActiveCourierDeliveryOrder).length;
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  await syncZeroInventoryArchiveFromAdmin(admin, session.shop);

  const requests = await prisma.returnRequest.findMany({
    where: {
      shop: session.shop,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      orderNumber: true,
      status: true,
      returnMethod: true,
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
  });

  const latestRequestIdByItemsSignature = new Map();
  for (const row of requests) {
    const signature = returnRequestItemsSignature(row);
    if (!latestRequestIdByItemsSignature.has(signature)) {
      latestRequestIdByItemsSignature.set(signature, row.id);
    }
  }

  const uniqueRequests = {
    pickup: new Set(),
    branch: new Set(),
    review: new Set(),
    refunds: new Set(),
    toReturn: new Set(),
  };

  for (const row of requests) {
    const status = String(row.status || "").toLowerCase();
    if (!MENU_COUNT_STATUSES.includes(status)) continue;

    const signature = returnRequestItemsSignature(row);
    const isPickupRequest = String(row.returnMethod || "").toLowerCase() === "pickup";
    if (!isPickupRequest && latestRequestIdByItemsSignature.get(signature) !== row.id) continue;

    if (status === "en_revision") uniqueRequests.review.add(signature);
    if (status === "recibida") uniqueRequests.refunds.add(signature);
    if (status === "por_devolver") uniqueRequests.toReturn.add(signature);

    if (METHOD_QUEUE_STATUSES.has(status)) {
      if (isPickupRequest) {
        const requestKey = `request:${row.id}`;
        uniqueRequests.pickup.add(requestKey);
      } else {
        uniqueRequests.branch.add(signature);
      }
    }
  }

  const navCounts = Object.fromEntries(
    Object.entries(uniqueRequests).map(([key, signatures]) => [key, signatures.size]),
  );
  const deliveryCourierOrders = await fetchCourierOrdersForShop({
    shop: session.shop,
    sessionCandidates: [session],
  }).catch((error) => {
    console.error("No se pudieron contar las entregas del repartidor", error);
    return [];
  });
  const adminDeliveryCount = deliveryCourierOrders.length
    ? 0
    : await fetchCourierDeliveryCount(admin).catch((error) => {
        console.error("No se pudieron contar las entregas del repartidor desde admin", error);
        return 0;
      });
  const plannedDeliveryCount = deliveryCourierOrders.length || adminDeliveryCount
    ? 0
    : await activePlannedCourierDeliveryCount(session.shop, [session]).catch((error) => {
        console.error("No se pudieron contar las rutas activas del repartidor", error);
        return 0;
      });
  navCounts.courier = deliveryCourierOrders.length || adminDeliveryCount || plannedDeliveryCount;

  const branchPickupCourierOrders = await fetchBranchPickupCourierOrdersForShop({
    shop: session.shop,
    sessionCandidates: [session],
  }).catch((error) => {
    console.error("No se pudieron contar las ordenes para recoger en sucursal", error);
    return [];
  });
  navCounts.branchPickup = branchPickupCourierOrders.length;

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", navCounts, shop: session.shop };
};

export default function App() {
  const { apiKey, navCounts, shop: sessionShop } = useLoaderData();
  const location = useLocation();
  const withCount = (label, count) => (count > 0 ? `${label} (${count})` : label);
  const navParams = new URLSearchParams(location.search || "");
  const shop = String(navParams.get("shop") || sessionShop || "").trim();
  const host = String(navParams.get("host") || "").trim();
  const withEmbedParams = (pathname) => {
    const params = new URLSearchParams();
    if (shop) params.set("shop", shop);
    if (host) params.set("host", host);
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  };

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href={withEmbedParams("/app/devoluciones/admin")}>Administrador del panel</s-link>
        <s-link href={withEmbedParams("/app/devoluciones/solicitudes/pickup")}>
          {withCount("Recoleccion a domicilio", navCounts?.pickup || 0)}
        </s-link>
        <s-link href={withEmbedParams("/app/devoluciones/solicitudes/branch")}>
          {withCount("Entrega en sucursal", navCounts?.branch || 0)}
        </s-link>
        <s-link href={withEmbedParams("/app/devoluciones/solicitudes/review")}>
          {withCount("Ordenes en revision", navCounts?.review || 0)}
        </s-link>
        <s-link href={withEmbedParams("/app/devoluciones/solicitudes/refunds")}>
          {withCount("Procesar reembolsos", navCounts?.refunds || 0)}
        </s-link>
        <s-link href={withEmbedParams("/app/devoluciones/solicitudes/to_return")}>
          {withCount("Devoluciones a devolver", navCounts?.toReturn || 0)}
        </s-link>
        <s-link href={withEmbedParams("/app/devoluciones/solicitudes/history")}>Historial</s-link>
        <s-link href={withEmbedParams("/app/devoluciones/solicitudes/repartidor")}>
          {withCount("Ordenes repartidor", navCounts?.courier || 0)}
        </s-link>
        <s-link href={withEmbedParams("/app/devoluciones/solicitudes/courier_history")}>Historial repartidor</s-link>
        <s-link href={withEmbedParams("/app/devoluciones/solicitudes/branch_pickup")}>
          {withCount("Recoger en sucursal", navCounts?.branchPickup || 0)}
        </s-link>
        <s-link href={withEmbedParams("/app/devoluciones/solicitudes/couriers")}>Repartidores</s-link>
        <s-link href={withEmbedParams("/app/devoluciones/solicitudes/preparers")}>Preparadores</s-link>
        <s-link href={withEmbedParams("/app/devoluciones/solicitudes/stock")}>Stock</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
