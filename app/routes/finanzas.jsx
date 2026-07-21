import { useEffect, useMemo, useState } from "react";
import { createCookie, Form, redirect, useActionData, useLoaderData, useRevalidator } from "react-router";
import prisma from "../db.server";
import styles from "../styles/finanzas.module.css";

const ADMIN_API_VERSION = "2025-10";
const FINANCE_TIME_ZONE = "America/Mexico_City";
const OPERATING_COST_PER_ITEM = 15;
const SHIPPING_COST_PER_ORDER = 35;
const SHOPIFY_FIXED_COMMISSION_PER_ITEM = 3;
const DEFAULT_PROFIT_MARGIN_RATE = 0.44;
const HIGH_ORDER_PROFIT_MARGIN_RATE = 0.34;
const VERY_HIGH_ORDER_PROFIT_MARGIN_RATE = 0.29;
const COST_RECOVERY_MARGIN_RATE = 0.44;
const PROFIT_TAX_RATE = 0.1;
const TRANSACTION_RATE = 0.03;
const INITIAL_TEST_ORDERS = [
  { name: "Orden 1", products: ["263", "340", ""] },
  { name: "Orden 2", products: ["936", "", ""] },
];

function financeAccessCookie() {
  return createCookie("finance_portal_access_v1", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 26,
    secrets: [process.env.SHOPIFY_API_SECRET || "finance-access"],
  });
}

const currencyFormatter = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
});

const wholeCurrencyFormatter = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  maximumFractionDigits: 0,
});

const emptyTotals = {
  salesTotal: 0,
  averageTicket: 0,
  operatingCostTotal: 0,
  shippingTotal: 0,
  taxesTotal: 0,
  recoveredCostTotal: 0,
  profitTotal: 0,
  orderCount: 0,
  itemCount: 0,
};

function cleanShop(value) {
  return String(value || "").trim().toLowerCase();
}

function isMyShopifyDomain(value) {
  return cleanShop(value).endsWith(".myshopify.com");
}

function configuredAccessCodes() {
  return String(process.env.FINANCE_ACCESS_CODES || process.env.FINANCE_ACCESS_CODE || process.env.FINANCE_PORTAL_CODE || "")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);
}

function getTimeZoneParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
    second: Number(lookup.second),
  };
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = getTimeZoneParts(date, timeZone);
  const utcFromParts = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return utcFromParts - date.getTime();
}

function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstOffset = getTimeZoneOffsetMs(new Date(utcGuess), timeZone);
  const firstUtc = utcGuess - firstOffset;
  const secondOffset = getTimeZoneOffsetMs(new Date(firstUtc), timeZone);
  return new Date(utcGuess - secondOffset);
}

function getTodayRangeInMexico() {
  const today = getTimeZoneParts(new Date(), FINANCE_TIME_ZONE);
  const start = zonedTimeToUtc({ year: today.year, month: today.month, day: today.day }, FINANCE_TIME_ZONE);
  const end = zonedTimeToUtc({ year: today.year, month: today.month, day: today.day + 1 }, FINANCE_TIME_ZONE);
  return { start, end };
}

async function hasFinanceAccess(request) {
  const accessCodes = configuredAccessCodes();
  if (!accessCodes.length) return false;
  const cookie = financeAccessCookie();
  const access = await cookie.parse(request.headers.get("Cookie"));
  return access?.ok === true && accessCodes.includes(String(access?.code || "").trim());
}

async function resolveFinanceSession(request) {
  const url = new URL(request.url);
  const incomingShop = cleanShop(url.searchParams.get("shop"));
  const configuredShop = cleanShop(process.env.SHOPIFY_SHOP_DOMAIN);
  const allSessions = await prisma.session.findMany({
    select: { id: true, shop: true, isOnline: true, accessToken: true },
  });
  const offlineSessions = allSessions.filter((session) => session.isOnline === false && session.accessToken);
  const candidateShops = Array.from(
    new Set([
      ...[incomingShop, configuredShop].filter(isMyShopifyDomain),
      ...offlineSessions.map((session) => cleanShop(session.shop)).filter(Boolean),
      ...allSessions.map((session) => cleanShop(session.shop)).filter(Boolean),
    ]),
  );

  for (const shop of candidateShops) {
    const canonicalOfflineId = `offline_${shop}`;
    const sessions = allSessions
      .filter((session) => cleanShop(session.shop) === shop && session.accessToken)
      .sort((first, second) => {
        if (first.id === canonicalOfflineId) return -1;
        if (second.id === canonicalOfflineId) return 1;
        if (first.isOnline === false && second.isOnline !== false) return -1;
        if (second.isOnline === false && first.isOnline !== false) return 1;
        return 0;
      });
    if (sessions[0]) return { shop, accessToken: sessions[0].accessToken };
  }

  return { shop: candidateShops[0] || incomingShop || configuredShop, accessToken: "" };
}

async function shopifyGraphql({ shop, accessToken, query, variables }) {
  const response = await fetch(`https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.errors?.length) {
    throw new Error(payload?.errors?.[0]?.message || `Error consultando Shopify Admin API (${response.status}).`);
  }
  return payload.data;
}

async function fetchOrdersForToday({ shop, accessToken, start, end }) {
  const orders = [];
  let cursor = null;
  let hasNextPage = true;
  const shopifyQuery = [`created_at:>=${start.toISOString()}`, `created_at:<${end.toISOString()}`, "status:any"].join(" ");

  while (hasNextPage) {
    const data = await shopifyGraphql({
      shop,
      accessToken,
      variables: { cursor, query: shopifyQuery },
      query: `#graphql
        query FinanceOrders($cursor: String, $query: String!) {
          orders(first: 250, after: $cursor, query: $query, sortKey: CREATED_AT) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              cancelledAt
              currentTotalPriceSet {
                shopMoney {
                  amount
                }
              }
              lineItems(first: 250) {
                nodes {
                  quantity
                  originalUnitPriceSet {
                    shopMoney {
                      amount
                    }
                  }
                }
              }
            }
          }
        }`,
    });
    const connection = data?.orders;
    orders.push(...(connection?.nodes || []));
    hasNextPage = Boolean(connection?.pageInfo?.hasNextPage);
    cursor = connection?.pageInfo?.endCursor || null;
  }

  return orders.filter((order) => !order.cancelledAt);
}

function calculateDayTotals(orders) {
  const orderCount = orders.length;
  const itemCount = orders.reduce(
    (sum, order) =>
      sum +
      (order?.lineItems?.nodes || []).reduce((itemSum, item) => itemSum + Math.max(0, Number(item?.quantity || 0)), 0),
    0,
  );
  const financeTotals = orders.reduce(
    (totals, order) => {
      const orderFinance = calculateOrderFinanceTotals(order);
      return {
        salesTotal: totals.salesTotal + orderFinance.salesTotal,
        recoveredCostTotal: totals.recoveredCostTotal + orderFinance.recoveredCostTotal,
        taxesTotal: totals.taxesTotal + orderFinance.taxesTotal,
        profitTotal: totals.profitTotal + orderFinance.profitTotal,
      };
    },
    { salesTotal: 0, recoveredCostTotal: 0, taxesTotal: 0, profitTotal: 0 },
  );

  return {
    ...emptyTotals,
    salesTotal: financeTotals.salesTotal,
    averageTicket: orderCount ? financeTotals.salesTotal / orderCount : 0,
    operatingCostTotal: itemCount * OPERATING_COST_PER_ITEM,
    shippingTotal: orderCount * SHIPPING_COST_PER_ORDER,
    recoveredCostTotal: financeTotals.recoveredCostTotal,
    taxesTotal: financeTotals.taxesTotal,
    profitTotal: financeTotals.profitTotal,
    orderCount,
    itemCount,
  };
}

function getProfitMarginRateForOrderTotal(orderTotal) {
  if (orderTotal >= 1000) return VERY_HIGH_ORDER_PROFIT_MARGIN_RATE;
  if (orderTotal >= 750) return HIGH_ORDER_PROFIT_MARGIN_RATE;
  return DEFAULT_PROFIT_MARGIN_RATE;
}

function calculateOrderFinanceTotals(order) {
  const lineItems = order?.lineItems?.nodes || [];
  const originalOrderTotal = lineItems.reduce((sum, item) => {
    const quantity = Math.max(0, Number(item?.quantity || 0));
    const unitPrice = Number(item?.originalUnitPriceSet?.shopMoney?.amount || 0);
    return sum + unitPrice * quantity;
  }, 0);
  const profitMarginRate = getProfitMarginRateForOrderTotal(originalOrderTotal);
  const totals = lineItems.reduce(
    (itemTotals, item) => {
      const quantity = Math.max(0, Number(item?.quantity || 0));
      const originalUnitPrice = Number(item?.originalUnitPriceSet?.shopMoney?.amount || 0);
      const recoveredUnitCost = Math.round(Math.max(0, calculateRecoveredUnitCost(originalUnitPrice)));
      const appliedUnitPrice = calculateAppliedUnitPrice(recoveredUnitCost, profitMarginRate);
      return {
        salesTotal: itemTotals.salesTotal + appliedUnitPrice * quantity,
        recoveredCostTotal: itemTotals.recoveredCostTotal + recoveredUnitCost * quantity,
      };
    },
    { salesTotal: 0, recoveredCostTotal: 0 },
  );
  const recoveredCostTotal = totals.recoveredCostTotal;
  const marginTotal = recoveredCostTotal * profitMarginRate;
  const taxesTotal = marginTotal * PROFIT_TAX_RATE;
  const profitTotal = marginTotal - taxesTotal;

  return { salesTotal: totals.salesTotal, recoveredCostTotal, taxesTotal, profitTotal };
}

function calculateRecoveredUnitCost(unitPrice) {
  const costRecoveryFactor = 1 + COST_RECOVERY_MARGIN_RATE + COST_RECOVERY_MARGIN_RATE * PROFIT_TAX_RATE;
  return (
    (Number(unitPrice || 0) * (1 - TRANSACTION_RATE) - SHOPIFY_FIXED_COMMISSION_PER_ITEM - OPERATING_COST_PER_ITEM) /
    costRecoveryFactor
  );
}

function calculateAppliedUnitPrice(recoveredUnitCost, profitMarginRate) {
  const margin = recoveredUnitCost * profitMarginRate;
  const taxes = margin * PROFIT_TAX_RATE;
  return Math.floor(
    (recoveredUnitCost + margin + taxes + SHOPIFY_FIXED_COMMISSION_PER_ITEM + OPERATING_COST_PER_ITEM) /
      (1 - TRANSACTION_RATE),
  );
}

function calculateTestTotals(testOrders) {
  const orders = testOrders
    .map((order) => {
      const prices = order.products.map((price) => Number(price || 0)).filter((price) => price > 0);
      return {
        cancelledAt: null,
        currentTotalPriceSet: {
          shopMoney: {
            amount: prices.reduce((sum, price) => sum + price, 0),
          },
        },
        lineItems: {
          nodes: prices.map((price) => ({
            quantity: 1,
            originalUnitPriceSet: {
              shopMoney: {
                amount: price,
              },
            },
          })),
        },
      };
    })
    .filter((order) => Number(order.currentTotalPriceSet.shopMoney.amount || 0) > 0);

  return calculateDayTotals(orders);
}

export const headers = () => ({
  "Cache-Control": "no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow",
});

export async function loader({ request }) {
  const accessCodes = configuredAccessCodes();
  if (!accessCodes.length) {
    return {
      isLoggedIn: false,
      needsConfiguration: true,
      totals: emptyTotals,
      error: "Falta configurar FINANCE_ACCESS_CODE en Render.",
    };
  }

  const isLoggedIn = await hasFinanceAccess(request);
  if (!isLoggedIn) {
    return { isLoggedIn: false, needsConfiguration: false, totals: emptyTotals, error: "" };
  }

  const { start, end } = getTodayRangeInMexico();
  try {
    const { shop, accessToken } = await resolveFinanceSession(request);
    if (!shop || !accessToken) {
      return {
        isLoggedIn: true,
        needsConfiguration: false,
        totals: emptyTotals,
        error: "No se encontro una sesion offline valida para consultar ventas.",
      };
    }
    const orders = await fetchOrdersForToday({ shop, accessToken, start, end });
    return {
      isLoggedIn: true,
      needsConfiguration: false,
      totals: calculateDayTotals(orders),
      error: "",
    };
  } catch (error) {
    console.error("Finance portal failed to load day totals", error);
    return {
      isLoggedIn: true,
      needsConfiguration: false,
      totals: emptyTotals,
      error: "No se pudieron cargar las ventas del dia.",
    };
  }
}

export async function action({ request }) {
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const url = new URL(request.url);
  const accessCodes = configuredAccessCodes();

  if (intent === "logout") {
    return redirect("/finanzas", {
      headers: {
        "Set-Cookie": await financeAccessCookie().serialize("", { maxAge: 0 }),
      },
    });
  }

  if (!accessCodes.length) return { ok: false, error: "Falta configurar FINANCE_ACCESS_CODE en Render." };
  const code = String(formData.get("code") || "").trim();
  if (!accessCodes.includes(code)) return { ok: false, error: "Codigo incorrecto." };

  return redirect(`/finanzas${url.search}`, {
    headers: {
      "Set-Cookie": await financeAccessCookie().serialize({ ok: true, code }),
    },
  });
}

export default function FinanzasPortal() {
  const { isLoggedIn, needsConfiguration, totals, error } = useLoaderData();
  const actionData = useActionData();
  const revalidator = useRevalidator();
  const [testOrders, setTestOrders] = useState(INITIAL_TEST_ORDERS);
  const testTotals = useMemo(() => calculateTestTotals(testOrders), [testOrders]);

  useEffect(() => {
    if (!isLoggedIn) return undefined;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") revalidator.revalidate();
    }, 60000);
    return () => window.clearInterval(interval);
  }, [isLoggedIn, revalidator]);

  function updateTestProduct(orderIndex, productIndex, value) {
    setTestOrders((currentOrders) =>
      currentOrders.map((order, currentOrderIndex) => {
        if (currentOrderIndex !== orderIndex) return order;
        return {
          ...order,
          products: order.products.map((price, currentProductIndex) =>
            currentProductIndex === productIndex ? value : price,
          ),
        };
      }),
    );
  }

  if (!isLoggedIn) {
    return (
      <main className={styles.publicShell}>
        <div className={styles.publicHeader}>
          <div className={styles.brand}>
            <span className={styles.brandMark}>CAR</span>
            <div>
              <strong>CARIANA</strong>
              <small>Finanzas</small>
            </div>
          </div>
        </div>

        <div className={styles.accessWrap}>
          <section className={styles.accessPanel}>
            <h1>Control financiero</h1>
            <p>Ingresa tu codigo para ver las ventas y costos del negocio.</p>
            {needsConfiguration ? <p className={styles.errorText}>{error}</p> : null}
            {actionData?.error ? <p className={styles.errorText}>{actionData.error}</p> : null}
            <Form method="post" className={styles.accessForm}>
              <input type="hidden" name="intent" value="login" />
              <label className={styles.label}>
                Codigo de acceso
                <input className={styles.input} name="code" type="password" inputMode="numeric" autoComplete="one-time-code" />
              </label>
              <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={needsConfiguration}>
                Entrar
              </button>
            </Form>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.publicShell}>
      <div className={styles.publicHeader}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>CAR</span>
          <div>
            <strong>CARIANA</strong>
            <small>Finanzas</small>
          </div>
        </div>
        <Form method="post">
          <input type="hidden" name="intent" value="logout" />
          <button className={styles.logoutButton} type="submit">
            Salir
          </button>
        </Form>
      </div>

      <div className={styles.wrap}>
        <section className={styles.hero}>
          <div>
            <h1>Control financiero</h1>
          </div>
        </section>

        <section className={styles.periodTabs} aria-label="Periodo financiero">
          <button className={`${styles.periodButton} ${styles.periodButtonActive}`} type="button">
            Dia
          </button>
          <button className={styles.periodButton} type="button">
            Semana
          </button>
          <button className={styles.periodButton} type="button">
            Historial
          </button>
        </section>

        {error ? <p className={styles.errorText}>{error}</p> : null}

        <section className={styles.testPanel} aria-label="Prueba temporal de calculos">
          <div className={styles.testHeader}>
            <h2>Prueba temporal</h2>
            <span>No afecta las ventas reales</span>
          </div>
          <div className={styles.testOrders}>
            {testOrders.map((order, orderIndex) => (
              <article className={styles.testOrder} key={order.name}>
                <h3>{order.name}</h3>
                <div className={styles.testGrid}>
                  {order.products.map((price, productIndex) => (
                    <label className={styles.label} key={`${order.name}-${productIndex}`}>
                      Producto {productIndex + 1}
                      <input
                        className={styles.input}
                        type="number"
                        min="0"
                        step="0.01"
                        inputMode="decimal"
                        value={price}
                        onChange={(event) => updateTestProduct(orderIndex, productIndex, event.target.value)}
                      />
                    </label>
                  ))}
                </div>
              </article>
            ))}
          </div>
          <div className={styles.testTotals}>
            <span>Ventas: <strong>{currencyFormatter.format(testTotals.salesTotal)}</strong></span>
            <span>Ticket: <strong>{currencyFormatter.format(testTotals.averageTicket)}</strong></span>
            <span>Costo operativo: <strong>{currencyFormatter.format(testTotals.operatingCostTotal)}</strong></span>
            <span>Paqueteria: <strong>{currencyFormatter.format(testTotals.shippingTotal)}</strong></span>
            <span>Impuestos: <strong>{currencyFormatter.format(testTotals.taxesTotal)}</strong></span>
            <span>Costo recuperado: <strong>{wholeCurrencyFormatter.format(testTotals.recoveredCostTotal)}</strong></span>
            <span>Ganancias: <strong>{currencyFormatter.format(testTotals.profitTotal)}</strong></span>
          </div>
        </section>

        <section className={styles.metrics} aria-label="Resumen financiero">
          <article className={`${styles.metric} ${styles.metricSales}`}>
            <span>Ventas</span>
            <strong>{currencyFormatter.format(totals.salesTotal)}</strong>
          </article>
          <article className={`${styles.metric} ${styles.metricTicket}`}>
            <span>Ticket promedio</span>
            <strong>{currencyFormatter.format(totals.averageTicket)}</strong>
          </article>
          <article className={`${styles.metric} ${styles.metricOperatingCost}`}>
            <span>Costo operativo</span>
            <strong>{currencyFormatter.format(totals.operatingCostTotal)}</strong>
          </article>
          <article className={`${styles.metric} ${styles.metricShipping}`}>
            <span>Paqueteria</span>
            <strong>{currencyFormatter.format(totals.shippingTotal)}</strong>
          </article>
          <article className={`${styles.metric} ${styles.metricTaxes}`}>
            <span>Impuestos</span>
            <strong>{currencyFormatter.format(totals.taxesTotal)}</strong>
          </article>
          <article className={`${styles.metric} ${styles.metricRecovered}`}>
            <span>Costo recuperado</span>
            <strong>{wholeCurrencyFormatter.format(totals.recoveredCostTotal)}</strong>
          </article>
          <article className={`${styles.metric} ${styles.metricProfit}`}>
            <span>Ganancias</span>
            <strong>{currencyFormatter.format(totals.profitTotal)}</strong>
          </article>
        </section>
      </div>
    </main>
  );
}
