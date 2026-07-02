/* global globalThis */
import "@shopify/ui-extensions/customer-account";

const RETURN_PORTAL_URL = "https://gestion-devoluciones-pro.onrender.com/devoluciones";
const RETURN_PROBE_URL = "https://gestion-devoluciones-pro.onrender.com/devoluciones/probe";

async function fetchProbe({
  shopDomain,
  orderNumber,
  customerEmail,
  sessionToken,
  includeShop = true,
  includeEmail = true,
}) {
  const url = new URL(RETURN_PROBE_URL);
  if (orderNumber) {
    url.searchParams.set("order", String(orderNumber).replace("#", ""));
  }
  if (includeEmail && customerEmail) {
    url.searchParams.set("email", String(customerEmail));
  }
  if (includeShop && shopDomain && String(shopDomain).includes(".myshopify.com")) {
    url.searchParams.set("shop", String(shopDomain));
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {},
  });
  if (!response.ok) return null;
  return response.json();
}

async function getEligibility({ shopDomain, orderNumber, customerEmail, sessionToken }) {
  try {
    const primary = await fetchProbe({ shopDomain, orderNumber, customerEmail, sessionToken });
    if (!primary) return null;

    let effective = primary;
    let hasConfirmedReturnsFromProbe =
      typeof primary?.hasExistingReturns === "boolean"
        ? primary.hasExistingReturns
        : Array.isArray(primary?.completedRequests) && primary.completedRequests.length > 0;
    const hasCustomerOrderBlockData =
      Boolean(String(primary?.deliveryCode || "").trim()) ||
      Boolean(primary?.latestOrderNotification?.title || primary?.latestOrderNotification?.message);

    // Silent fallback: retry using only the order number in case shop/email aliases differ.
    if (
      orderNumber &&
      !hasCustomerOrderBlockData &&
      (!hasConfirmedReturnsFromProbe || !primary?.isDelivered || primary?.hasEligibleItems === undefined)
    ) {
      const fallback = await fetchProbe({
        shopDomain,
        orderNumber,
        customerEmail,
        sessionToken,
        includeShop: false,
        includeEmail: false,
      });
      if (fallback) {
        effective = {
          ...primary,
          ...fallback,
          limitDate: fallback?.limitDate || primary?.limitDate || "",
          isDelivered: Boolean(fallback?.isDelivered || primary?.isDelivered),
          isBranchPickup: Boolean(fallback?.isBranchPickup || primary?.isBranchPickup),
          hasEligibleItems:
            typeof fallback?.hasEligibleItems === "boolean"
              ? fallback.hasEligibleItems
              : primary?.hasEligibleItems,
        };
        const fallbackHasConfirmed =
          typeof fallback?.hasExistingReturns === "boolean"
            ? fallback.hasExistingReturns
            : Array.isArray(fallback?.completedRequests) && fallback.completedRequests.length > 0;
        hasConfirmedReturnsFromProbe = hasConfirmedReturnsFromProbe || fallbackHasConfirmed;
      }
    }

    return {
      hasEligibleItems:
        typeof effective?.hasEligibleItems === "boolean" ? effective.hasEligibleItems : undefined,
      hasConfirmedReturns: hasConfirmedReturnsFromProbe,
      limitDate: effective?.limitDate || "",
      isDelivered: Boolean(effective?.isDelivered),
      isBranchPickup: Boolean(effective?.isBranchPickup),
      deliveryCode: String(primary?.deliveryCode || effective?.deliveryCode || "").trim(),
      latestOrderNotification:
        primary?.latestOrderNotification ||
        effective?.latestOrderNotification ||
        null,
    };
  } catch {
    return null;
  }
}

function formatLimitDate(limitDateISO) {
  const raw = String(limitDateISO || "").trim();
  if (!raw) return "";
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return "";
  const day = date.getDate();
  const month = date.toLocaleDateString("es-MX", { month: "long" });
  const formattedMonth = month.charAt(0).toUpperCase() + month.slice(1);
  return `${day} / ${formattedMonth} / ${date.getFullYear()}`;
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

function isThirdDeliveryAttemptNotification(notification) {
  const title = String(notification?.title || "").trim();
  const message = String(notification?.message || "").trim();
  return /tercer intento de entrega/i.test(`${title} ${message}`);
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
    targetValue?.shop?.myshopifyDomain || shopifyObj?.shop?.myshopifyDomain || "";

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

  const deliveryCodeBlock = document.createElement("s-stack");
  deliveryCodeBlock.setAttribute("gap", "small");

  const latestOrderMessageBlock = document.createElement("s-stack");
  latestOrderMessageBlock.setAttribute("gap", "small");
  latestOrderMessageBlock.setAttribute("padding", "base");
  latestOrderMessageBlock.setAttribute("border", "base");
  latestOrderMessageBlock.setAttribute("borderRadius", "large");

  const latestOrderMessageTitle = document.createElement("s-text");
  latestOrderMessageTitle.setAttribute("appearance", "strong");

  const latestOrderMessageBody = document.createElement("s-text");

  const renderLatestOrderMessage = (notification) => {
    latestOrderMessageTitle.textContent = String(notification?.title || "").trim();
    latestOrderMessageBody.textContent = String(notification?.message || "").trim();
    while (latestOrderMessageBlock.firstChild) {
      latestOrderMessageBlock.removeChild(latestOrderMessageBlock.firstChild);
    }
    if (latestOrderMessageTitle.textContent) {
      latestOrderMessageBlock.appendChild(latestOrderMessageTitle);
    }
    if (latestOrderMessageBody.textContent) {
      latestOrderMessageBlock.appendChild(latestOrderMessageBody);
    }
  };

  const deliveryCodeTitle = document.createElement("s-heading");
  deliveryCodeTitle.textContent = "CLAVE DE ENTREGA";

  const deliveryCodeValue = document.createElement("s-stack");
  deliveryCodeValue.setAttribute("direction", "inline");
  deliveryCodeValue.setAttribute("gap", "small");
  const renderDeliveryCode = (code) => {
    while (deliveryCodeValue.firstChild) {
      deliveryCodeValue.removeChild(deliveryCodeValue.firstChild);
    }
    Array.from(String(code || "")).forEach((digit) => {
      const digitHeading = document.createElement("s-heading");
      digitHeading.textContent = digit;
      deliveryCodeValue.appendChild(digitHeading);
    });
  };

  const deliveryCodeDescription = document.createElement("s-text");
  deliveryCodeDescription.textContent = "Entrega esta clave al repartidor para recibir tu pedido.";

  deliveryCodeBlock.appendChild(deliveryCodeTitle);
  deliveryCodeBlock.appendChild(deliveryCodeValue);
  deliveryCodeBlock.appendChild(deliveryCodeDescription);

  const mountWrapper = () => {
    if (!wrapper.parentNode) document.body.appendChild(wrapper);
  };
  const unmountWrapper = () => {
    if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
  };

  const loadEligibility = async () => {
    const sessionToken = await Promise.resolve(shopifyObj?.sessionToken?.get?.()).catch(() => "");
    return getEligibility({
      shopDomain,
      orderNumber: orderName,
      customerEmail,
      sessionToken,
    });
  };

  loadEligibility().then((eligibility) => {
    if (!eligibility) {
      unmountWrapper();
      while (actions.firstChild) {
        actions.removeChild(actions.firstChild);
      }
      if (noEligibleText.parentNode) {
        noEligibleText.parentNode.removeChild(noEligibleText);
      }
      return;
    }

    const formattedLimitDate = formatLimitDate(eligibility?.limitDate);
    description.textContent = formattedLimitDate
      ? `Tienes hasta ${formattedLimitDate} para solicitar una devolucion.`
      : "Inicia aqui la devolucion de este pedido.";

    const hasConfirmedReturns = Boolean(eligibility?.hasConfirmedReturns);
    const hasEligibleItems =
      eligibility?.hasEligibleItems === undefined ? true : Boolean(eligibility?.hasEligibleItems);
    mountWrapper();

    while (actions.firstChild) {
      actions.removeChild(actions.firstChild);
    }

    const deliveryCode = String(eligibility?.deliveryCode || "").trim();
    if (!eligibility?.isDelivered) {
      [title, description, actions, noEligibleText].forEach((element) => {
        if (element.parentNode) element.parentNode.removeChild(element);
      });
      const latestOrderNotification = eligibility?.latestOrderNotification;
      if (latestOrderNotification?.title || latestOrderNotification?.message) {
        renderLatestOrderMessage(latestOrderNotification);
        if (!latestOrderMessageBlock.parentNode) wrapper.appendChild(latestOrderMessageBlock);
      } else if (latestOrderMessageBlock.parentNode) {
        latestOrderMessageBlock.parentNode.removeChild(latestOrderMessageBlock);
      }
      if (deliveryCode) {
        deliveryCodeDescription.textContent =
          Boolean(eligibility?.isBranchPickup) || isThirdDeliveryAttemptNotification(latestOrderNotification)
          ? "Entrega esta clave en sucursal para recibir tu pedido."
          : "Entrega esta clave al repartidor para recibir tu pedido.";
        renderDeliveryCode(deliveryCode);
        if (!deliveryCodeBlock.parentNode) wrapper.appendChild(deliveryCodeBlock);
      } else if (!latestOrderMessageBlock.parentNode) {
        unmountWrapper();
      }
      return;
    }

    if (deliveryCodeBlock.parentNode) {
      deliveryCodeBlock.parentNode.removeChild(deliveryCodeBlock);
    }
    if (latestOrderMessageBlock.parentNode) {
      latestOrderMessageBlock.parentNode.removeChild(latestOrderMessageBlock);
    }
    [description, actions].forEach((element) => {
      if (!element.parentNode) wrapper.appendChild(element);
    });

    if (hasConfirmedReturns) {
      actions.appendChild(viewButton);
    }
    if (eligibility?.isDelivered && hasEligibleItems) {
      actions.appendChild(requestButton);
    }

    if (!hasConfirmedReturns && !hasEligibleItems) {
      if (!noEligibleText.parentNode) wrapper.appendChild(noEligibleText);
    } else if (noEligibleText.parentNode) {
      noEligibleText.parentNode.removeChild(noEligibleText);
    }
  });
}
