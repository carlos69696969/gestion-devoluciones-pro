import { useEffect } from "react";
import { createCookie, Form, redirect, useActionData, useLoaderData, useRevalidator } from "react-router";
import prisma from "../db.server";
import styles from "../styles/finanzas.module.css";

const ADMIN_API_VERSION = "2025-10";
const FINANCE_TIME_ZONE = "America/Mexico_City";
const OPERATING_COST_PER_ITEM = 15;
const SHIPPING_COST_PER_ORDER = 35;

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

function configuredAccessCode() {
  return String(process.env.FINANCE_ACCESS_CODE || process.env.FINANCE_PORTAL_CODE || "").trim();
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
  const accessCode = configuredAccessCode();
  if (!accessCode) return false;
  const cookie = financeAccessCookie();
  const access = await cookie.parse(request.headers.get("Cookie"));
  return access?.ok === true;
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
  const salesTotal = orders.reduce(
    (sum, order) => sum + Number(order?.currentTotalPriceSet?.shopMoney?.amount || 0),
    0,
  );
  const itemCount = orders.reduce(
    (sum, order) =>
      sum +
      (order?.lineItems?.nodes || []).reduce((itemSum, item) => itemSum + Math.max(0, Number(item?.quantity || 0)), 0),
    0,
  );
  return {
    ...emptyTotals,
    salesTotal,
    averageTicket: orderCount ? salesTotal / orderCount : 0,
    operatingCostTotal: itemCount * OPERATING_COST_PER_ITEM,
    shippingTotal: orderCount * SHIPPING_COST_PER_ORDER,
    orderCount,
    itemCount,
  };
}

export const headers = () => ({
  "Cache-Control": "no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow",
});

export async function loader({ request }) {
  const accessCode = configuredAccessCode();
  if (!accessCode) {
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
  const accessCode = configuredAccessCode();

  if (intent === "logout") {
    return redirect("/finanzas", {
      headers: {
        "Set-Cookie": await financeAccessCookie().serialize("", { maxAge: 0 }),
      },
    });
  }

  if (!accessCode) return { ok: false, error: "Falta configurar FINANCE_ACCESS_CODE en Render." };
  const code = String(formData.get("code") || "").trim();
  if (code !== accessCode) return { ok: false, error: "Codigo incorrecto." };

  return redirect(`/finanzas${url.search}`, {
    headers: {
      "Set-Cookie": await financeAccessCookie().serialize({ ok: true }),
    },
  });
}

export default function FinanzasPortal() {
  const { isLoggedIn, needsConfiguration, totals, error } = useLoaderData();
  const actionData = useActionData();
  const revalidator = useRevalidator();

  useEffect(() => {
    if (!isLoggedIn) return undefined;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") revalidator.revalidate();
    }, 60000);
    return () => window.clearInterval(interval);
  }, [isLoggedIn, revalidator]);

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
            <strong>{currencyFormatter.format(totals.recoveredCostTotal)}</strong>
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
