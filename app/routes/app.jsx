import { Outlet, useLoaderData, useLocation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const METHOD_QUEUE_STATUSES = new Set([
  "aprobada",
  "intento_fallido_1",
  "intento_fallido_2",
  "intento_fallido_3",
  "en_ruta_1",
  "en_ruta_2",
  "en_ruta_3",
]);
const MENU_COUNT_STATUSES = [
  "en_revision",
  "aprobada",
  "intento_fallido_1",
  "intento_fallido_2",
  "intento_fallido_3",
  "en_ruta_1",
  "en_ruta_2",
  "en_ruta_3",
  "recibida",
  "por_devolver",
];

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const requests = await prisma.returnRequest.findMany({
    where: {
      shop: session.shop,
      status: { in: MENU_COUNT_STATUSES },
    },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      returnMethod: true,
    },
  });

  const uniqueOrders = {
    pickup: new Set(),
    branch: new Set(),
    review: new Set(),
    refunds: new Set(),
    toReturn: new Set(),
  };

  for (const row of requests) {
    const status = String(row.status || "").toLowerCase();
    const orderKey = String(row.orderNumber || "").trim() || `request-${row.id}`;

    if (status === "en_revision") uniqueOrders.review.add(orderKey);
    if (status === "recibida") uniqueOrders.refunds.add(orderKey);
    if (status === "por_devolver") uniqueOrders.toReturn.add(orderKey);

    if (METHOD_QUEUE_STATUSES.has(status)) {
      if (String(row.returnMethod || "").toLowerCase() === "pickup") uniqueOrders.pickup.add(orderKey);
      else uniqueOrders.branch.add(orderKey);
    }
  }

  const navCounts = Object.fromEntries(
    Object.entries(uniqueOrders).map(([key, orderNumbers]) => [key, orderNumbers.size]),
  );

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", navCounts };
};

export default function App() {
  const { apiKey, navCounts } = useLoaderData();
  const location = useLocation();
  const withCount = (label, count) => (count > 0 ? `${label} (${count})` : label);
  const navParams = new URLSearchParams(location.search || "");
  const shop = String(navParams.get("shop") || "").trim();
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
        <s-link href={withEmbedParams("/app/devoluciones/solicitudes/repartidor")}>Ordenes repartidor</s-link>
        <s-link href={withEmbedParams("/app/devoluciones/solicitudes/branch_pickup")}>Recoger en sucursal</s-link>
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
