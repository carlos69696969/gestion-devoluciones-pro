import {
  extension,
  BlockStack,
  Button,
  Text,
} from "@shopify/ui-extensions/customer-account";

const RETURN_PORTAL_URL =
  "https://gestion-devoluciones-pro.onrender.com/app/devoluciones";

export default extension(
  "customer-account.order-status.block.render",
  (root, api) => {
    const orderNumber = api?.order?.current?.name ?? "";
    const email = api?.buyerIdentity?.email?.current ?? "";

    const url = new URL(RETURN_PORTAL_URL);
    if (orderNumber) {
      url.searchParams.set("order", orderNumber.replace("#", ""));
    }
    if (email) {
      url.searchParams.set("email", email);
    }

    const stack = root.createComponent(BlockStack, {
      spacing: "tight",
      padding: "base",
    });

    const title = root.createComponent(
      Text,
      { emphasis: "bold" },
      "Devoluciones"
    );

    const subtitle = root.createComponent(
      Text,
      {},
      "Si necesitas devolver este pedido, inicia tu solicitud aqui."
    );

    const button = root.createComponent(
      Button,
      { to: url.toString() },
      "Solicitar devolucion"
    );

    stack.append(title);
    stack.append(subtitle);
    stack.append(button);
    root.append(stack);
  }
);
