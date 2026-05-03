/* global globalThis */
import "@shopify/ui-extensions/customer-account";

const RETURN_PORTAL_URL = "https://gestion-devoluciones-pro.onrender.com/devoluciones";
const DEFAULT_SHOP_DOMAIN = "cariana-3.myshopify.com";

export default function extension() {
  const shopifyObj = globalThis?.shopify || {};
  const targetValue =
    shopifyObj?.target?.value ||
    shopifyObj?.extension?.target?.value ||
    shopifyObj?.target?.current ||
    {};

  const orderName =
    targetValue?.order?.name ||
    shopifyObj?.order?.current?.name ||
    "";

  const customerEmail =
    targetValue?.customer?.emailAddress?.emailAddress ||
    shopifyObj?.buyerIdentity?.current?.email ||
    "";

  const shopDomain =
    targetValue?.shop?.myshopifyDomain ||
    shopifyObj?.shop?.myshopifyDomain ||
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

  const wrapper = document.createElement("s-stack");
  wrapper.setAttribute("padding", "base");
  wrapper.setAttribute("gap", "tight");

  const title = document.createElement("s-text");
  title.setAttribute("appearance", "strong");
  title.textContent = "Devoluciones";

  const description = document.createElement("s-text");
  description.textContent = "Inicia aqui la devolucion de este pedido.";

  const button = document.createElement("s-button");
  button.textContent = "Solicitar devolucion";
  button.setAttribute("href", url.toString());
  button.setAttribute("target", "_blank");

  wrapper.appendChild(title);
  wrapper.appendChild(description);
  wrapper.appendChild(button);
  document.body.appendChild(wrapper);
}
