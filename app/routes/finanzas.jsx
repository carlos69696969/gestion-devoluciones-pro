import { useEffect, useMemo, useState } from "react";
import { createCookie, Form, Link, redirect, useActionData, useLoaderData, useRevalidator } from "react-router";
import prisma from "../db.server";
import styles from "../styles/finanzas.module.css";

const ADMIN_API_VERSION = "2025-10";
const FINANCE_TIME_ZONE = "America/Mexico_City";
const OPERATING_COST_PER_ITEM = 15;
const SHIPPING_COST_PER_ORDER = 35;
const SHOPIFY_FIXED_COMMISSION_PER_ITEM = 3;
const DEFAULT_PROFIT_MARGIN_RATE = 0.5;
const HIGH_ORDER_PROFIT_MARGIN_RATE = 0.4;
const VERY_HIGH_ORDER_PROFIT_MARGIN_RATE = 0.35;
const COST_RECOVERY_MARGIN_RATE = 0.5;
const PROFIT_TAX_RATE = 0.1;
const TRANSACTION_RATE = 0.03;
const HIGH_ORDER_DISCOUNT_RATE = 0.1;
const VERY_HIGH_ORDER_DISCOUNT_RATE = 0.15;
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

const dayNameFormatter = new Intl.DateTimeFormat("es-MX", {
  timeZone: FINANCE_TIME_ZONE,
  weekday: "long",
});

const datePartsFormatter = new Intl.DateTimeFormat("es-MX", {
  timeZone: FINANCE_TIME_ZONE,
  day: "numeric",
  month: "long",
  year: "numeric",
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

function capitalize(value) {
  const text = String(value || "");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

function padDatePart(value) {
  return String(value).padStart(2, "0");
}

function getLocalDateKey(date) {
  const parts = getTimeZoneParts(date, FINANCE_TIME_ZONE);
  return `${parts.year}-${padDatePart(parts.month)}-${padDatePart(parts.day)}`;
}

function formatFinanceDate(date, { includeYear = true } = {}) {
  const parts = Object.fromEntries(datePartsFormatter.formatToParts(date).map((part) => [part.type, part.value]));
  const month = capitalize(parts.month);
  return includeYear ? `${parts.day} de ${month} de ${parts.year}` : `${parts.day} de ${month}`;
}

function formatWeekLabel(start, end) {
  const lastDay = new Date(end.getTime() - 1000);
  return `Semana del ${formatFinanceDate(start, { includeYear: false })} al ${formatFinanceDate(lastDay)}`;
}

function buildWeekBreakdown(start, end, orders) {
  const ordersByDay = orders.reduce((groups, order) => {
    const createdAt = order?.createdAt ? new Date(order.createdAt) : null;
    if (!createdAt || Number.isNaN(createdAt.getTime())) return groups;
    const key = getLocalDateKey(createdAt);
    return {
      ...groups,
      [key]: [...(groups[key] || []), order],
    };
  }, {});

  return {
    label: formatWeekLabel(start, end),
    days: Array.from({ length: 7 }, (_, index) => {
      const dayDate = new Date(start.getTime() + index * 24 * 60 * 60 * 1000);
      const key = getLocalDateKey(dayDate);
      const dayOrders = ordersByDay[key] || [];
      return {
        key,
        dayName: capitalize(dayNameFormatter.format(dayDate)),
        dateLabel: formatFinanceDate(dayDate),
        totals: calculateDayTotals(dayOrders),
      };
    }),
  };
}

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

function getWeekRangeInMexico() {
  const today = getTimeZoneParts(new Date(), FINANCE_TIME_ZONE);
  const calendarDate = new Date(Date.UTC(today.year, today.month - 1, today.day));
  const mondayOffset = (calendarDate.getUTCDay() + 6) % 7;
  const start = zonedTimeToUtc(
    { year: today.year, month: today.month, day: today.day - mondayOffset },
    FINANCE_TIME_ZONE,
  );
  const end = zonedTimeToUtc(
    { year: today.year, month: today.month, day: today.day - mondayOffset + 7 },
    FINANCE_TIME_ZONE,
  );
  return { start, end };
}

function normalizeFinancePeriod(value) {
  return value === "week" ? "week" : "day";
}

function getFinanceRangeInMexico(period) {
  return period === "week" ? getWeekRangeInMexico() : getTodayRangeInMexico();
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
    select: { id: true, shop: true, isOnline: true, accessToken: true, scope: true },
  });
  const offlineSessions = allSessions.filter((session) => session.isOnline === false && session.accessToken);
  const candidateShops = Array.from(
    new Set([
      ...[incomingShop, configuredShop].filter(isMyShopifyDomain),
      ...offlineSessions.map((session) => cleanShop(session.shop)).filter(Boolean),
      ...allSessions.map((session) => cleanShop(session.shop)).filter(Boolean),
    ]),
  );
  const candidates = [];

  for (const shop of candidateShops) {
    const canonicalOfflineId = `offline_${shop}`;
    const sessions = allSessions
      .filter((session) => cleanShop(session.shop) === shop && session.accessToken)
      .sort((first, second) => {
        const firstHasOrdersScope = sessionHasScope(first, "read_orders");
        const secondHasOrdersScope = sessionHasScope(second, "read_orders");
        if (firstHasOrdersScope && !secondHasOrdersScope) return -1;
        if (secondHasOrdersScope && !firstHasOrdersScope) return 1;
        if (first.id === canonicalOfflineId) return -1;
        if (second.id === canonicalOfflineId) return 1;
        if (first.isOnline === false && second.isOnline !== false) return -1;
        if (second.isOnline === false && first.isOnline !== false) return 1;
        return 0;
      });
    for (const session of sessions) {
      candidates.push({ shop, accessToken: session.accessToken, sessionId: session.id });
    }
  }

  return { shop: candidateShops[0] || incomingShop || configuredShop, sessions: candidates };
}

function sessionHasScope(session, scope) {
  return String(session?.scope || "")
    .split(",")
    .map((value) => value.trim())
    .includes(scope);
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

async function fetchOrdersForRange({ shop, accessToken, start, end }) {
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
              createdAt
              cancelledAt
              currentTotalPriceSet {
                shopMoney {
                  amount
                }
              }
              subtotalPriceSet {
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

async function fetchOrdersForRangeWithSessions({ sessions, start, end }) {
  let lastError = null;
  for (const session of sessions) {
    try {
      return await fetchOrdersForRange({ shop: session.shop, accessToken: session.accessToken, start, end });
    } catch (error) {
      lastError = error;
      console.error("Finance portal failed with Shopify session", {
        shop: session.shop,
        sessionId: session.sessionId,
        message: error?.message || String(error),
      });
    }
  }
  throw lastError || new Error("No se encontro una sesion valida para consultar ventas.");
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
        originalSubtotalTotal: totals.originalSubtotalTotal + orderFinance.originalSubtotalTotal,
        recoveredCostTotal: totals.recoveredCostTotal + orderFinance.recoveredCostTotal,
        taxesTotal: totals.taxesTotal + orderFinance.taxesTotal,
        profitTotal: totals.profitTotal + orderFinance.profitTotal,
      };
    },
    { salesTotal: 0, originalSubtotalTotal: 0, recoveredCostTotal: 0, taxesTotal: 0, profitTotal: 0 },
  );

  return {
    ...emptyTotals,
    salesTotal: financeTotals.salesTotal,
    averageTicket: orderCount ? financeTotals.originalSubtotalTotal / orderCount : 0,
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

function getDiscountRateForOrderTotal(orderTotal) {
  if (orderTotal >= 1000) return VERY_HIGH_ORDER_DISCOUNT_RATE;
  if (orderTotal >= 750) return HIGH_ORDER_DISCOUNT_RATE;
  return 0;
}

function calculateOrderFinanceTotals(order) {
  const lineItems = order?.lineItems?.nodes || [];
  const lineItemsOriginalTotal = lineItems.reduce((sum, item) => {
    const quantity = Math.max(0, Number(item?.quantity || 0));
    const unitPrice = Number(item?.originalUnitPriceSet?.shopMoney?.amount || 0);
    return sum + unitPrice * quantity;
  }, 0);
  const originalOrderTotal = lineItemsOriginalTotal || Number(order?.subtotalPriceSet?.shopMoney?.amount || 0);
  const profitMarginRate = getProfitMarginRateForOrderTotal(originalOrderTotal);
  const discountRate = getDiscountRateForOrderTotal(originalOrderTotal);
  const totals = lineItems.reduce(
    (itemTotals, item) => {
      const quantity = Math.max(0, Number(item?.quantity || 0));
      const originalUnitPrice = Number(item?.originalUnitPriceSet?.shopMoney?.amount || 0);
      const recoveredUnitCost = Math.round(Math.max(0, calculateRecoveredUnitCost(originalUnitPrice)));
      return {
        salesTotal: itemTotals.salesTotal + originalUnitPrice * (1 - discountRate) * quantity,
        recoveredCostTotal: itemTotals.recoveredCostTotal + recoveredUnitCost * quantity,
      };
    },
    { salesTotal: 0, recoveredCostTotal: 0 },
  );
  const recoveredCostTotal = totals.recoveredCostTotal;
  const marginTotal = recoveredCostTotal * profitMarginRate;
  const taxesTotal = marginTotal * PROFIT_TAX_RATE;
  const profitTotal = marginTotal - taxesTotal;
  const actualSalesTotal = Number(order?.currentTotalPriceSet?.shopMoney?.amount || 0);
  const salesTotal = order?.useActualSalesTotal === false ? totals.salesTotal : actualSalesTotal;

  return { salesTotal, originalSubtotalTotal: originalOrderTotal, recoveredCostTotal, taxesTotal, profitTotal };
}

function calculateRecoveredUnitCost(unitPrice) {
  const costRecoveryFactor = 1 + COST_RECOVERY_MARGIN_RATE + COST_RECOVERY_MARGIN_RATE * PROFIT_TAX_RATE;
  return (
    (Number(unitPrice || 0) * (1 - TRANSACTION_RATE) - SHOPIFY_FIXED_COMMISSION_PER_ITEM - OPERATING_COST_PER_ITEM) /
    costRecoveryFactor
  );
}

function calculateTestTotals(testOrders) {
  const orders = testOrders
    .map((order) => {
      const prices = order.products.map((price) => Number(price || 0)).filter((price) => price > 0);
      return {
        useActualSalesTotal: false,
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
  const url = new URL(request.url);
  const period = normalizeFinancePeriod(url.searchParams.get("period"));
  const accessCodes = configuredAccessCodes();
  if (!accessCodes.length) {
    return {
      isLoggedIn: false,
      needsConfiguration: true,
      period,
      totals: emptyTotals,
      week: { label: "", days: [] },
      error: "Falta configurar FINANCE_ACCESS_CODE en Render.",
    };
  }

  const isLoggedIn = await hasFinanceAccess(request);
  if (!isLoggedIn) {
    return { isLoggedIn: false, needsConfiguration: false, period, totals: emptyTotals, week: { label: "", days: [] }, error: "" };
  }

  const { start, end } = getFinanceRangeInMexico(period);
  try {
    const { shop, sessions } = await resolveFinanceSession(request);
    if (!shop || !sessions?.length) {
      return {
        isLoggedIn: true,
        needsConfiguration: false,
        period,
        totals: emptyTotals,
        week: { label: "", days: [] },
        error: "No se encontro una sesion offline valida para consultar ventas.",
      };
    }
    const orders = await fetchOrdersForRangeWithSessions({ sessions, start, end });
    const week = period === "week" ? buildWeekBreakdown(start, end, orders) : { label: "", days: [] };
    return {
      isLoggedIn: true,
      needsConfiguration: false,
      period,
      totals: calculateDayTotals(orders),
      week,
      error: "",
    };
  } catch (error) {
    console.error("Finance portal failed to load day totals", error);
    return {
      isLoggedIn: true,
      needsConfiguration: false,
      period,
      totals: emptyTotals,
      week: { label: period === "week" ? formatWeekLabel(start, end) : "", days: [] },
      error: period === "week" ? "No se pudieron cargar las ventas de la semana." : "No se pudieron cargar las ventas del dia.",
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
  const { isLoggedIn, needsConfiguration, period, totals, week, error } = useLoaderData();
  const actionData = useActionData();
  const revalidator = useRevalidator();
  const [testOrders, setTestOrders] = useState(INITIAL_TEST_ORDERS);
  const [isTestOpen, setIsTestOpen] = useState(false);
  const [selectedWeekDayKey, setSelectedWeekDayKey] = useState("");
  const testTotals = useMemo(() => calculateTestTotals(testOrders), [testOrders]);
  const selectedWeekDay =
    period === "week"
      ? (week?.days || []).find((day) => day.key === selectedWeekDayKey) || null
      : null;

  useEffect(() => {
    if (period !== "week") setSelectedWeekDayKey("");
  }, [period, week?.days]);

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
          <Link className={`${styles.periodButton} ${period === "day" ? styles.periodButtonActive : ""}`} to="/finanzas?period=day">
            Dia
          </Link>
          <Link className={`${styles.periodButton} ${period === "week" ? styles.periodButtonActive : ""}`} to="/finanzas?period=week">
            Semana
          </Link>
          <button className={styles.periodButton} type="button" disabled>
            Historial
          </button>
        </section>

        {error ? <p className={styles.errorText}>{error}</p> : null}

        <section className={styles.testPanel} aria-label="Prueba temporal de calculos">
          <div className={styles.testHeader}>
            <div>
              <h2>Prueba temporal</h2>
              <span>No afecta las ventas reales</span>
            </div>
            <button className={styles.testToggle} type="button" onClick={() => setIsTestOpen((open) => !open)}>
              {isTestOpen ? "Cerrar prueba" : "Abrir prueba"}
            </button>
          </div>
          <div className={`${styles.testContent} ${isTestOpen ? styles.testContentOpen : ""}`}>
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
          </div>
        </section>

        {period === "week" ? (
          <section className={styles.weekPanel} aria-label="Resumen semanal">
            <h2>{week?.label || "Semana actual"}</h2>
            <article className={styles.weekSummaryCard}>
              <span>
                <strong>Resumen de la semana</strong>
                <small>Acumulado semanal</small>
              </span>
              <span>
                Ventas
                <strong>{currencyFormatter.format(totals.salesTotal)}</strong>
              </span>
              <span>
                Ganancias
                <strong>{currencyFormatter.format(totals.profitTotal)}</strong>
              </span>
            </article>
            <div className={styles.weekCards}>
              {(week?.days || []).map((day) => (
                <button
                  className={`${styles.weekCard} ${selectedWeekDay?.key === day.key ? styles.weekCardActive : ""}`}
                  type="button"
                  key={day.key}
                  onClick={() => setSelectedWeekDayKey(day.key)}
                >
                  <span>
                    <strong>{day.dayName}</strong>
                    <small>{day.dateLabel}</small>
                  </span>
                  <span>
                    Ventas
                    <strong>{currencyFormatter.format(day.totals.salesTotal)}</strong>
                  </span>
                  <span>
                    Ganancias
                    <strong>{currencyFormatter.format(day.totals.profitTotal)}</strong>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {period === "week" && selectedWeekDay ? (
          <section className={styles.dayDetailOverlay} aria-label="Detalle financiero del dia">
            <div className={styles.dayDetailCard}>
              <div className={styles.weekDetailHeader}>
                <div>
                  <h2>{selectedWeekDay.dayName}</h2>
                  <span>{selectedWeekDay.dateLabel}</span>
                </div>
                <button
                  className={styles.closeDetailButton}
                  type="button"
                  onClick={() => setSelectedWeekDayKey("")}
                  aria-label="Cerrar detalle"
                >
                  ×
                </button>
              </div>
              <div className={styles.metrics}>
                <article className={`${styles.metric} ${styles.metricSales}`}>
                  <span>Ventas</span>
                  <strong>{currencyFormatter.format(selectedWeekDay.totals.salesTotal)}</strong>
                </article>
                <article className={`${styles.metric} ${styles.metricTicket}`}>
                  <span>Ticket promedio</span>
                  <strong>{currencyFormatter.format(selectedWeekDay.totals.averageTicket)}</strong>
                </article>
                <article className={`${styles.metric} ${styles.metricOperatingCost}`}>
                  <span>Costo operativo</span>
                  <strong>{currencyFormatter.format(selectedWeekDay.totals.operatingCostTotal)}</strong>
                </article>
                <article className={`${styles.metric} ${styles.metricShipping}`}>
                  <span>Paqueteria</span>
                  <strong>{currencyFormatter.format(selectedWeekDay.totals.shippingTotal)}</strong>
                </article>
                <article className={`${styles.metric} ${styles.metricTaxes}`}>
                  <span>Impuestos</span>
                  <strong>{currencyFormatter.format(selectedWeekDay.totals.taxesTotal)}</strong>
                </article>
                <article className={`${styles.metric} ${styles.metricRecovered}`}>
                  <span>Costo recuperado</span>
                  <strong>{wholeCurrencyFormatter.format(selectedWeekDay.totals.recoveredCostTotal)}</strong>
                </article>
                <article className={`${styles.metric} ${styles.metricProfit}`}>
                  <span>Ganancias</span>
                  <strong>{currencyFormatter.format(selectedWeekDay.totals.profitTotal)}</strong>
                </article>
              </div>
            </div>
          </section>
        ) : null}

        {period !== "week" ? (
          <section aria-label="Detalle financiero">
          {period === "week" && selectedWeekDay ? (
            <div className={styles.weekDetailHeader}>
              <h2>{selectedWeekDay.dayName}</h2>
              <span>{selectedWeekDay.dateLabel}</span>
            </div>
          ) : null}
          <div className={styles.metrics}>
            <article className={`${styles.metric} ${styles.metricSales}`}>
              <span>Ventas</span>
              <strong>{currencyFormatter.format((selectedWeekDay?.totals || totals).salesTotal)}</strong>
            </article>
            <article className={`${styles.metric} ${styles.metricTicket}`}>
              <span>Ticket promedio</span>
              <strong>{currencyFormatter.format((selectedWeekDay?.totals || totals).averageTicket)}</strong>
            </article>
            <article className={`${styles.metric} ${styles.metricOperatingCost}`}>
              <span>Costo operativo</span>
              <strong>{currencyFormatter.format((selectedWeekDay?.totals || totals).operatingCostTotal)}</strong>
            </article>
            <article className={`${styles.metric} ${styles.metricShipping}`}>
              <span>Paqueteria</span>
              <strong>{currencyFormatter.format((selectedWeekDay?.totals || totals).shippingTotal)}</strong>
            </article>
            <article className={`${styles.metric} ${styles.metricTaxes}`}>
              <span>Impuestos</span>
              <strong>{currencyFormatter.format((selectedWeekDay?.totals || totals).taxesTotal)}</strong>
            </article>
            <article className={`${styles.metric} ${styles.metricRecovered}`}>
              <span>Costo recuperado</span>
              <strong>{wholeCurrencyFormatter.format((selectedWeekDay?.totals || totals).recoveredCostTotal)}</strong>
            </article>
            <article className={`${styles.metric} ${styles.metricProfit}`}>
              <span>Ganancias</span>
              <strong>{currencyFormatter.format((selectedWeekDay?.totals || totals).profitTotal)}</strong>
            </article>
          </div>
        </section>
        ) : null}
      </div>
    </main>
  );
}
