/* global globalThis */
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

const RETURN_PORTAL_URL = "https://gestion-devoluciones-pro.onrender.com/devoluciones";
const FORCED_SHOP_DOMAIN = "cariana-3.myshopify.com";

function getRuntimeContext() {
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

  return { orderName, customerEmail, shopDomain };
}

function buildBaseUrl({ orderName, customerEmail, shopDomain }) {
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
  return url;
}

async function fetchEligibility({ orderName, customerEmail, shopDomain }) {
  try {
    const url = buildBaseUrl({ orderName, customerEmail, shopDomain });
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

function Extension() {
  const context = useMemo(getRuntimeContext, []);
  const [eligibility, setEligibility] = useState(null);

  const viewUrl = useMemo(() => {
    const url = buildBaseUrl(context);
    url.searchParams.set("mode", "summary");
    return url.toString();
  }, [context]);

  const newRequestUrl = useMemo(() => {
    const url = buildBaseUrl(context);
    url.searchParams.set("mode", "new");
    return url.toString();
  }, [context]);

  useEffect(() => {
    let active = true;
    fetchEligibility(context).then((value) => {
      if (!active) return;
      setEligibility(value);
    });
    return () => {
      active = false;
    };
  }, [context]);

  const hasExistingReturns = Boolean(eligibility?.hasExistingReturns);
  const hasEligibleItems = eligibility?.hasEligibleItems === undefined ? true : Boolean(eligibility?.hasEligibleItems);
  const showNoEligibleMessage = !hasExistingReturns && !hasEligibleItems;

  return (
    <s-stack padding="base" gap="base">
      <s-text appearance="strong">Devoluciones</s-text>
      <s-text>Inicia aqui la devolucion de este pedido.</s-text>

      <s-stack gap="small" direction="block">
        {hasExistingReturns ? (
          <s-button href={viewUrl} target="_blank">
            Ver mi devolucion
          </s-button>
        ) : null}
        {hasEligibleItems ? (
          <s-button href={newRequestUrl} target="_blank">
            Solicitar devolucion
          </s-button>
        ) : null}
      </s-stack>

      {showNoEligibleMessage ? (
        <s-text>Este pedido ya no tiene productos disponibles para devolucion.</s-text>
      ) : null}
    </s-stack>
  );
}

export default function extension() {
  render(<Extension />, document.body);
}

