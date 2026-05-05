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

function buildPortalUrl({ orderName, customerEmail, shopDomain, mode }) {
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
  if (mode) url.searchParams.set("mode", mode);
  return url.toString();
}

export default function extension() {
  const shopifyObj = globalThis?.shopify || {};
  const targetValue =
    shopifyObj?.target?.value ||
    shopifyObj?.extension?.target?.value ||
    shopifyObj?.target?.current ||
    {};

  const orderName = targetValue?.order?.name || shopifyObj?.order?.current?.name || "";
  const customerEmail =
    targetValue?.customer?.emailAddress?.emailAddress || shopifyObj?.buyerIdentity?.current?.email || "";
  const shopDomain =
    FORCED_SHOP_DOMAIN || targetValue?.shop?.myshopifyDomain || shopifyObj?.shop?.myshopifyDomain || "";

  const wrapper = document.createElement("s-stack");
  wrapper.setAttribute("padding", "base");
  wrapper.setAttribute("gap", "small");

  const title = document.createElement("s-text");
  title.setAttribute("appearance", "strong");
  title.textContent = "Devoluciones";

  const description = document.createElement("s-text");
  description.textContent = "Inicia aqui la devolucion de este pedido.";

  const actions = document.createElement("s-stack");
  actions.setAttribute("gap", "small");

  const viewButton = document.createElement("s-button");
  viewButton.textContent = "Ver mi devolucion";
  viewButton.setAttribute(
    "href",
    buildPortalUrl({ orderName, customerEmail, shopDomain, mode: "summary" }),
  );
  viewButton.setAttribute("target", "_blank");

  const requestButton = document.createElement("s-button");
  requestButton.textContent = "Solicitar devolucion";
  requestButton.setAttribute(
    "href",
    buildPortalUrl({ orderName, customerEmail, shopDomain, mode: "new" }),
  );
  requestButton.setAttribute("target", "_blank");

  const noEligibleText = document.createElement("s-text");
  noEligibleText.textContent = "Este pedido ya no tiene productos disponibles para devolucion.";

  wrapper.appendChild(title);
  wrapper.appendChild(description);
  wrapper.appendChild(actions);
  document.body.appendChild(wrapper);

  getEligibility({ shopDomain, orderNumber: orderName, customerEmail }).then((eligibility) => {
    const hasExistingReturns = Boolean(eligibility?.hasExistingReturns);
    const hasEligibleItems =
      eligibility?.hasEligibleItems === undefined ? true : Boolean(eligibility?.hasEligibleItems);

    while (actions.firstChild) {
      actions.removeChild(actions.firstChild);
    }

    if (hasExistingReturns) {
      actions.appendChild(viewButton);
    }
    if (hasEligibleItems) {
      actions.appendChild(requestButton);
    }

    if (!hasExistingReturns && !hasEligibleItems) {
      if (!noEligibleText.parentNode) wrapper.appendChild(noEligibleText);
    } else if (noEligibleText.parentNode) {
      noEligibleText.parentNode.removeChild(noEligibleText);
    }
  });
}

