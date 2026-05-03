import {
  extension,
  BlockStack,
  Button,
  Text,
} from "@shopify/ui-extensions/customer-account";

const RETURN_PORTAL_URL = "https://gestion-devoluciones-pro.onrender.com/devoluciones";
const DEFAULT_SHOP_DOMAIN = "cariana-3.myshopify.com";

export default extension("customer-account.order-status.block.render", (root, api) => {
  const orderName =
    api?.order?.current?.name ||
    api?.target?.current?.order?.name ||
    "";

  const customerEmail =
    api?.buyerIdentity?.current?.email ||
    api?.target?.current?.customer?.emailAddress?.emailAddress ||
    "";

  const shopDomain =
    api?.shop?.myshopifyDomain ||
    api?.target?.current?.shop?.myshopifyDomain ||
    DEFAULT_SHOP_DOMAIN;

  const url = new URL(RETURN_PORTAL_URL);
  if (orderName) {
    url.searchParams.set("order", String(orderName).replace("#", ""));
  }
  if (customerEmail) {
    url.searchParams.set("email", String(customerEmail));
  }
  if (shopDomain) {
    url.searchParams.set("shop", String(shopDomain));
  }

  const stack = root.createComponent(BlockStack, {
    spacing: "tight",
    padding: "base",
  });

  const title = root.createComponent(Text, { emphasis: "bold" }, "Devoluciones");
  const description = root.createComponent(
    Text,
    {},
    "Inicia aqui la devolucion de este pedido.",
  );
  const button = root.createComponent(
    Button,
    { to: url.toString(), external: true },
    "Solicitar devolucion",
  );

  stack.appendChild(title);
  stack.appendChild(description);
  stack.appendChild(button);
  root.appendChild(stack);
});
