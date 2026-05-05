/* global globalThis */
import "@shopify/ui-extensions/customer-account";

const RETURN_PORTAL_URL = "https://gestion-devoluciones-pro.onrender.com/devoluciones";
const FORCED_SHOP_DOMAIN = "cariana-3.myshopify.com";

async function getEligibility({ shopDomain, orderNumber, customerEmail }) {
  try {
    const url = new URL(RETURN_PORTAL_URL);
    if (orderNumber) {
      url.searchParams.set("order", String(orderNumber).replace("#", ""));
    }
    if (customerEmail) {
      url.searchParams.set("email", String(customerEmail));
    }
    if (shopDomain && String(shopDomain).includes(".myshopify.com")) {
      url.searchParams.set("shop", String(shopDomain));
    }
    url.searchParams.set("probe", "1");
    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) return null;
    const data = await response.json();
    return {
      hasEligibleItems: Boolean(data?.hasEligibleItems),
      hasExistingReturns: Array.isArray(data?.completedRequests) && data.completedRequests.length > 0,
    };
  } catch {
    return null;
  }
}

export default async function extension() {
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
    FORCED_SHOP_DOMAIN ||
    targetValue?.shop?.myshopifyDomain ||
    shopifyObj?.shop?.myshopifyDomain ||
    "";

  const url = new URL(RETURN_PORTAL_URL);
  if (orderName) {
    url.searchParams.set("order", String(orderName).replace("#", ""));
  }
  if (customerEmail) {
    url.searchParams.set("email", String(customerEmail));
  }
  if (shopDomain && String(shopDomain).includes(".myshopify.com")) {
    url.searchParams.set("shop", String(shopDomain));
  }
  const viewUrl = new URL(url.toString());
  viewUrl.searchParams.set("mode", "summary");
  const newRequestUrl = new URL(url.toString());
  newRequestUrl.searchParams.set("mode", "new");

  const wrapper = document.createElement("s-stack");
  wrapper.setAttribute("padding", "base");
  wrapper.setAttribute("gap", "base");

  const title = document.createElement("s-text");
  title.setAttribute("appearance", "strong");
  title.textContent = "Devoluciones";

  const description = document.createElement("s-text");
  description.textContent = "Inicia aqui la devolucion de este pedido.";

  const viewButton = document.createElement("s-button");
  viewButton.textContent = "Ver mi devolucion";
  viewButton.setAttribute("href", viewUrl.toString());
  viewButton.setAttribute("target", "_blank");
  viewButton.style.width = "100%";

  const button = document.createElement("s-button");
  button.textContent = "Solicitar devolucion";
  button.setAttribute("href", newRequestUrl.toString());
  button.setAttribute("target", "_blank");
  button.style.width = "100%";

  const actions = document.createElement("s-stack");
  actions.setAttribute("gap", "small");
  actions.setAttribute("direction", "block");

  const eligibility = await getEligibility({ shopDomain, orderNumber: orderName, customerEmail });
  const hasExistingReturns = Boolean(eligibility?.hasExistingReturns);
  const hasEligibleItems =
    eligibility?.hasEligibleItems === undefined ? true : Boolean(eligibility?.hasEligibleItems);

  wrapper.appendChild(title);
  wrapper.appendChild(description);
  if (hasExistingReturns) {
    actions.appendChild(viewButton);
  }
  if (hasEligibleItems) {
    actions.appendChild(button);
  }
  if (!hasExistingReturns && !hasEligibleItems) {
    const noEligibleText = document.createElement("s-text");
    noEligibleText.textContent = "Este pedido ya no tiene productos disponibles para devolucion.";
    wrapper.appendChild(noEligibleText);
  } else {
    wrapper.appendChild(actions);
  }
  document.body.appendChild(wrapper);
}
