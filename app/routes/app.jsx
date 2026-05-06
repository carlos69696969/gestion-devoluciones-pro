import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app/devoluciones/admin">Administrador del panel</s-link>
        <s-link href="/app/devoluciones/solicitudes?tipo=pickup">Recoleccion a domicilio</s-link>
        <s-link href="/app/devoluciones/solicitudes?tipo=branch">Entrega en sucursal</s-link>
        <s-link href="/app/devoluciones/solicitudes?tipo=review">Ordenes en revision</s-link>
        <s-link href="/app/devoluciones/solicitudes?tipo=history">Historial</s-link>
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
