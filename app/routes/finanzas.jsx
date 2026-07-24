import { useEffect, useState } from "react";
import {
  createCookie,
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useRevalidator,
  useSubmit,
} from "react-router";
import prisma from "../db.server";
import styles from "../styles/finanzas.module.css";

const ADMIN_API_VERSION = "2025-10";
const FINANCE_TIME_ZONE = "America/Mexico_City";
const OPERATING_COST_PER_ITEM = 15;
const SHOPIFY_FIXED_COMMISSION_PER_ITEM = 3;
const DEFAULT_PROFIT_MARGIN_RATE = 0.5;
const HIGH_ORDER_PROFIT_MARGIN_RATE = 0.4;
const VERY_HIGH_ORDER_PROFIT_MARGIN_RATE = 0.35;
const COST_RECOVERY_MARGIN_RATE = 0.5;
const PROFIT_TAX_RATE = 0.1;
const TRANSACTION_RATE = 0.03;
const HIGH_ORDER_DISCOUNT_RATE = 0.1;
const VERY_HIGH_ORDER_DISCOUNT_RATE = 0.15;
const FINANCE_RANGE_CACHE_TTL_MS = 45 * 1000;
const FINANCE_EXCLUSIVE_SESSION_TTL_MS = Number(process.env.FINANCE_SESSION_TTL_MINUTES || 480) * 60 * 1000;
const financeRangeCache = new Map();
const financeExclusiveSessionState = globalThis.__financeExclusiveSessionState || { active: null };
globalThis.__financeExclusiveSessionState = financeExclusiveSessionState;

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

async function readFinanceAccessCookie(request) {
  const cookie = financeAccessCookie();
  return (await cookie.parse(request.headers.get("Cookie"))) || null;
}

function pruneFinanceExclusiveSession() {
  const activeSession = financeExclusiveSessionState.active;
  if (activeSession && activeSession.expiresAt <= Date.now()) {
    financeExclusiveSessionState.active = null;
    return null;
  }
  return financeExclusiveSessionState.active;
}

function createFinanceSessionToken() {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function refreshFinanceExclusiveSession(token) {
  const activeSession = pruneFinanceExclusiveSession();
  if (!token || activeSession?.token !== token) return false;
  activeSession.lastSeenAt = Date.now();
  activeSession.expiresAt = Date.now() + FINANCE_EXCLUSIVE_SESSION_TTL_MS;
  return true;
}

function startFinanceExclusiveSession(currentToken) {
  const activeSession = pruneFinanceExclusiveSession();
  if (currentToken && activeSession?.token === currentToken) {
    refreshFinanceExclusiveSession(currentToken);
    return { ok: true, token: currentToken };
  }

  if (activeSession) {
    return {
      ok: false,
      error: "Ya hay un dispositivo con una sesion abierta. Cierra sesion en ese dispositivo para poder entrar aqui.",
    };
  }

  const token = createFinanceSessionToken();
  financeExclusiveSessionState.active = {
    token,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    expiresAt: Date.now() + FINANCE_EXCLUSIVE_SESSION_TTL_MS,
  };
  return { ok: true, token };
}

function releaseFinanceExclusiveSession(token) {
  const activeSession = pruneFinanceExclusiveSession();
  if (!activeSession) return;
  if (!token || activeSession.token === token) financeExclusiveSessionState.active = null;
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
  refundSalesTotal: 0,
  refundProfitTotal: 0,
  refundShippingTotal: 0,
  refundOperatingCostTotal: 0,
  refundTaxesTotal: 0,
  refundRecoveredCostTotal: 0,
  netSalesTotal: 0,
  netProfitTotal: 0,
  netShippingTotal: 0,
  netOperatingCostTotal: 0,
  netTaxesTotal: 0,
  netRecoveredCostTotal: 0,
  hasRefunds: false,
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

function formatMonthLabel(start) {
  const parts = Object.fromEntries(datePartsFormatter.formatToParts(start).map((part) => [part.type, part.value]));
  return `${capitalize(parts.month)} ${parts.year}`;
}

function groupOrdersByLocalDay(salesOrders) {
  return salesOrders.reduce((groups, order) => {
    const createdAt = order?.createdAt ? new Date(order.createdAt) : null;
    if (!createdAt || Number.isNaN(createdAt.getTime())) return groups;
    const key = getLocalDateKey(createdAt);
    return {
      ...groups,
      [key]: [...(groups[key] || []), order],
    };
  }, {});
}

function groupRefundsByLocalDay(refundEvents) {
  return refundEvents.reduce((groups, refundEvent) => {
    const createdAt = refundEvent?.createdAt ? new Date(refundEvent.createdAt) : null;
    if (!createdAt || Number.isNaN(createdAt.getTime())) return groups;
    const key = getLocalDateKey(createdAt);
    return {
      ...groups,
      [key]: [...(groups[key] || []), refundEvent],
    };
  }, {});
}

function buildFinanceDayEntry(dayDate, ordersByDay, refundsByDay) {
  const key = getLocalDateKey(dayDate);
  const dayOrders = ordersByDay[key] || [];
  const dayRefunds = refundsByDay[key] || [];
  return {
    key,
    dayName: capitalize(dayNameFormatter.format(dayDate)),
    dateLabel: formatFinanceDate(dayDate),
    refunds: dayRefunds,
    totals: calculateFinanceTotals(dayOrders, dayRefunds),
  };
}

function buildFinanceDayEntries(start, dayCount, salesOrders, refundEvents) {
  const ordersByDay = groupOrdersByLocalDay(salesOrders);
  const refundsByDay = groupRefundsByLocalDay(refundEvents);

  return Array.from({ length: dayCount }, (_, index) =>
    buildFinanceDayEntry(new Date(start.getTime() + index * 24 * 60 * 60 * 1000), ordersByDay, refundsByDay),
  );
}

function buildWeekBreakdown(start, end, salesOrders, refundEvents) {
  return {
    label: formatWeekLabel(start, end),
    days: buildFinanceDayEntries(start, 7, salesOrders, refundEvents),
  };
}

function buildChartBreakdown(start, end, salesOrders, refundEvents, monthKey) {
  const dayCount = Math.max(0, Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)));
  return {
    label: formatMonthLabel(start),
    days: buildFinanceDayEntries(start, dayCount, salesOrders, refundEvents),
    ...buildChartNavigation(monthKey),
  };
}

function buildMonthBreakdown(start, end, salesOrders, refundEvents) {
  const dayCount = Math.max(0, Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)));
  const ordersByDay = groupOrdersByLocalDay(salesOrders);
  const refundsByDay = groupRefundsByLocalDay(refundEvents);
  const entries = [];
  let weekStartDate = null;
  let weekOrders = [];
  let weekRefunds = [];

  for (let index = 0; index < dayCount; index += 1) {
    const dayDate = new Date(start.getTime() + index * 24 * 60 * 60 * 1000);
    const key = getLocalDateKey(dayDate);
    const dayEntry = buildFinanceDayEntry(dayDate, ordersByDay, refundsByDay);
    if (!weekStartDate) weekStartDate = dayDate;

    entries.push(dayEntry);
    weekOrders = [...weekOrders, ...(ordersByDay[key] || [])];
    weekRefunds = [...weekRefunds, ...(refundsByDay[key] || [])];

    if (dayNameFormatter.format(dayDate).toLowerCase() === "domingo") {
      entries.push({
        key: `${key}-cut`,
        dayName: "Corte",
        dateLabel: `Semana del ${formatFinanceDate(weekStartDate, { includeYear: false })} al ${formatFinanceDate(dayDate)}`,
        refunds: weekRefunds,
        totals: calculateFinanceTotals(weekOrders, weekRefunds),
        isCut: true,
      });
      weekStartDate = null;
      weekOrders = [];
      weekRefunds = [];
    }
  }

  return {
    label: formatMonthLabel(start),
    days: entries,
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

function getCurrentMonthKeyInMexico() {
  const today = getTimeZoneParts(new Date(), FINANCE_TIME_ZONE);
  return `${today.year}-${padDatePart(today.month)}`;
}

function parseMonthKey(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!year || month < 1 || month > 12) return null;
  return { year, month, key: `${year}-${padDatePart(month)}` };
}

function compareMonthKeys(firstKey, secondKey) {
  const first = parseMonthKey(firstKey);
  const second = parseMonthKey(secondKey);
  if (!first || !second) return 0;
  return first.year === second.year ? first.month - second.month : first.year - second.year;
}

function addMonthsToMonthKey(monthKey, monthOffset) {
  const parsed = parseMonthKey(monthKey) || parseMonthKey(getCurrentMonthKeyInMexico());
  const date = new Date(Date.UTC(parsed.year, parsed.month - 1 + monthOffset, 1));
  return `${date.getUTCFullYear()}-${padDatePart(date.getUTCMonth() + 1)}`;
}

function clampChartMonthKey(value) {
  const currentMonthKey = getCurrentMonthKeyInMexico();
  const parsed = parseMonthKey(value);
  if (!parsed) return currentMonthKey;
  return compareMonthKeys(parsed.key, currentMonthKey) > 0 ? currentMonthKey : parsed.key;
}

function buildChartMonthOptions(selectedMonthKey) {
  const currentMonthKey = getCurrentMonthKeyInMexico();
  const monthKeys = new Set([selectedMonthKey]);
  for (let index = 0; index < 12; index += 1) {
    monthKeys.add(addMonthsToMonthKey(currentMonthKey, -index));
  }
  return Array.from(monthKeys)
    .filter((monthKey) => compareMonthKeys(monthKey, currentMonthKey) <= 0)
    .sort((first, second) => compareMonthKeys(second, first))
    .map((monthKey) => {
      const parsed = parseMonthKey(monthKey);
      const monthStart = zonedTimeToUtc({ year: parsed.year, month: parsed.month, day: 1 }, FINANCE_TIME_ZONE);
      return { value: monthKey, label: formatMonthLabel(monthStart) };
    });
}

function buildChartNavigation(monthKey) {
  const selectedMonthKey = clampChartMonthKey(monthKey);
  const currentMonthKey = getCurrentMonthKeyInMexico();
  const nextMonthKey = addMonthsToMonthKey(selectedMonthKey, 1);
  return {
    monthKey: selectedMonthKey,
    previousMonthKey: addMonthsToMonthKey(selectedMonthKey, -1),
    nextMonthKey,
    canGoNext: compareMonthKeys(nextMonthKey, currentMonthKey) <= 0,
    monthOptions: buildChartMonthOptions(selectedMonthKey),
  };
}

function emptyChartData(monthKey = getCurrentMonthKeyInMexico()) {
  return {
    label: "",
    days: [],
    ...buildChartNavigation(monthKey),
  };
}

function getMonthRangeInMexico(monthKey = getCurrentMonthKeyInMexico()) {
  const selectedMonth = parseMonthKey(clampChartMonthKey(monthKey)) || parseMonthKey(getCurrentMonthKeyInMexico());
  const nextMonth = selectedMonth.month === 12 ? 1 : selectedMonth.month + 1;
  const nextMonthYear = selectedMonth.month === 12 ? selectedMonth.year + 1 : selectedMonth.year;
  const start = zonedTimeToUtc({ year: selectedMonth.year, month: selectedMonth.month, day: 1 }, FINANCE_TIME_ZONE);
  const end = zonedTimeToUtc({ year: nextMonthYear, month: nextMonth, day: 1 }, FINANCE_TIME_ZONE);
  return { start, end, monthKey: selectedMonth.key };
}

function normalizeFinancePeriod(value) {
  if (value === "week") return "week";
  if (value === "history") return "history";
  if (value === "chart") return "chart";
  return "day";
}

function getFinanceRangeInMexico(period, { chartMonthKey } = {}) {
  if (period === "week") return getWeekRangeInMexico();
  if (period === "chart") return getMonthRangeInMexico(chartMonthKey);
  if (period === "history") return getMonthRangeInMexico();
  return getTodayRangeInMexico();
}

async function hasFinanceAccess(request) {
  const accessCodes = configuredAccessCodes();
  if (!accessCodes.length) return false;
  const access = await readFinanceAccessCookie(request);
  const codeIsValid = access?.ok === true && accessCodes.includes(String(access?.code || "").trim());
  if (!codeIsValid) return false;
  return refreshFinanceExclusiveSession(access?.sessionToken);
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
    const error = new Error(payload?.errors?.[0]?.message || `Error consultando Shopify Admin API (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload.data;
}

function formatFinanceLoadError(error, period) {
  const base =
    period === "history"
      ? "No se pudieron cargar las ventas del historial."
      : period === "week"
        ? "No se pudieron cargar las ventas de la semana."
        : period === "chart"
          ? "No se pudieron cargar las graficas."
        : "No se pudieron cargar las ventas del dia.";
  const status = Number(error?.status || 0);
  if (status === 401) return `${base} Shopify rechazo la sesion guardada (401). Abre la app desde Shopify para regenerar la conexion.`;
  if (status === 403) return `${base} Faltan permisos de Shopify para leer pedidos.`;
  const message = String(error?.message || "").trim();
  return message ? `${base} Detalle: ${message}` : base;
}

async function fetchOrdersForRange({
  shop,
  accessToken,
  start,
  end,
  dateField = "created_at",
  sortKey = "CREATED_AT",
  includeRefundData = false,
}) {
  const orders = [];
  let cursor = null;
  let hasNextPage = true;
  const shopifyQuery = [`${dateField}:>=${start.toISOString()}`, `${dateField}:<${end.toISOString()}`, "status:any"].join(" ");

  while (hasNextPage) {
    const data = await shopifyGraphql({
      shop,
      accessToken,
      variables: { cursor, query: shopifyQuery },
      query: `#graphql
        query FinanceOrders($cursor: String, $query: String!) {
          orders(first: 250, after: $cursor, query: $query, sortKey: ${sortKey}) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              name
              createdAt
              cancelledAt
              currentTotalPriceSet {
                shopMoney {
                  amount
                }
              }
              totalReceivedSet {
                shopMoney {
                  amount
                }
              }
              subtotalPriceSet {
                shopMoney {
                  amount
                }
              }
              totalShippingPriceSet {
                shopMoney {
                  amount
                }
              }
              ${
                includeRefundData
                  ? `currentShippingPriceSet {
                shopMoney {
                  amount
                }
              }
              totalRefundedShippingSet {
                shopMoney {
                  amount
                }
              }`
                  : ""
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
              ${
                includeRefundData
                  ? `refunds {
                createdAt
                totalRefundedSet {
                  shopMoney {
                    amount
                  }
                }
                refundLineItems(first: 250) {
                  nodes {
                    quantity
                    subtotalSet {
                      shopMoney {
                        amount
                      }
                    }
                    lineItem {
                      originalUnitPriceSet {
                        shopMoney {
                          amount
                        }
                      }
                    }
                  }
                }
              }`
                  : ""
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

async function fetchUpdatedOrdersForRangeWithSessions({ sessions, start, end }) {
  let lastError = null;
  for (const session of sessions) {
    try {
      return await fetchOrdersForRange({
        shop: session.shop,
        accessToken: session.accessToken,
        start,
        end,
        dateField: "updated_at",
        sortKey: "UPDATED_AT",
        includeRefundData: true,
      });
    } catch (error) {
      lastError = error;
      console.error("Finance portal failed to load Shopify refunds with session", {
        shop: session.shop,
        sessionId: session.sessionId,
        message: error?.message || String(error),
      });
    }
  }
  throw lastError || new Error("No se encontro una sesion valida para consultar reembolsos.");
}

function getFinanceRangeCacheKey({ shop, start, end }) {
  return [cleanShop(shop), start.toISOString(), end.toISOString()].join("|");
}

function getCachedFinanceRangeData(cacheKey) {
  const cached = financeRangeCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > FINANCE_RANGE_CACHE_TTL_MS) {
    financeRangeCache.delete(cacheKey);
    return null;
  }
  return cached.data;
}

function setCachedFinanceRangeData(cacheKey, data) {
  financeRangeCache.set(cacheKey, { createdAt: Date.now(), data });
  if (financeRangeCache.size > 12) {
    const oldestKey = financeRangeCache.keys().next().value;
    if (oldestKey) financeRangeCache.delete(oldestKey);
  }
}

async function fetchFinanceRangeDataWithCache({ shop, sessions, start, end }) {
  const cacheKey = getFinanceRangeCacheKey({ shop, start, end });
  const cached = getCachedFinanceRangeData(cacheKey);
  if (cached) return cached;

  const orders = await fetchOrdersForRangeWithSessions({ sessions, start, end });
  let refundEvents = [];
  let loadedRefunds = true;
  try {
    const refundOrders = await fetchUpdatedOrdersForRangeWithSessions({ sessions, start, end });
    refundEvents = extractRefundEventsFromOrders(refundOrders, start, end);
  } catch (refundError) {
    loadedRefunds = false;
    console.error("Finance portal loaded sales but failed to load refunds", refundError);
  }

  const data = { orders, refundEvents };
  if (loadedRefunds) setCachedFinanceRangeData(cacheKey, data);
  return data;
}

function calculateFinanceTotals(orders, refundEvents = []) {
  const orderCount = orders.length;
  const orderIdentitySet = new Set(orders.flatMap((order) => [order?.id, order?.name].filter(Boolean)));
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
        shippingTotal: totals.shippingTotal + orderFinance.shippingTotal,
        recoveredCostTotal: totals.recoveredCostTotal + orderFinance.recoveredCostTotal,
        taxesTotal: totals.taxesTotal + orderFinance.taxesTotal,
        profitTotal: totals.profitTotal + orderFinance.profitTotal,
      };
    },
    { salesTotal: 0, originalSubtotalTotal: 0, shippingTotal: 0, recoveredCostTotal: 0, taxesTotal: 0, profitTotal: 0 },
  );
  const refundTotals = refundEvents.reduce(
    (totals, refundEvent) => ({
      refundSalesTotal: totals.refundSalesTotal + Number(refundEvent?.refundSalesTotal || 0),
      refundSalesTotalForNet:
        totals.refundSalesTotalForNet +
        (orderIdentitySet.has(refundEvent?.orderId) || orderIdentitySet.has(refundEvent?.orderName)
          ? 0
          : Number(refundEvent?.refundSalesTotal || 0)),
      refundProfitTotal: totals.refundProfitTotal + Number(refundEvent?.refundProfitTotal || 0),
      refundShippingTotal: totals.refundShippingTotal + Number(refundEvent?.refundShippingTotal || 0),
      refundOperatingCostTotal: totals.refundOperatingCostTotal + Number(refundEvent?.refundOperatingCostTotal || 0),
      refundTaxesTotal: totals.refundTaxesTotal + Number(refundEvent?.refundTaxesTotal || 0),
      refundRecoveredCostTotal: totals.refundRecoveredCostTotal + Number(refundEvent?.refundRecoveredCostTotal || 0),
    }),
    {
      refundSalesTotal: 0,
      refundSalesTotalForNet: 0,
      refundProfitTotal: 0,
      refundShippingTotal: 0,
      refundOperatingCostTotal: 0,
      refundTaxesTotal: 0,
      refundRecoveredCostTotal: 0,
    },
  );
  const shippingTotal = financeTotals.shippingTotal;
  const operatingCostTotal = itemCount * OPERATING_COST_PER_ITEM;
  const hasRefunds =
    refundTotals.refundSalesTotal > 0 ||
    refundTotals.refundProfitTotal > 0 ||
    refundTotals.refundShippingTotal > 0 ||
    refundTotals.refundOperatingCostTotal > 0 ||
    refundTotals.refundTaxesTotal > 0 ||
    refundTotals.refundRecoveredCostTotal > 0;

  return {
    ...emptyTotals,
    salesTotal: financeTotals.salesTotal,
    averageTicket: orderCount ? financeTotals.originalSubtotalTotal / orderCount : 0,
    operatingCostTotal,
    shippingTotal,
    recoveredCostTotal: financeTotals.recoveredCostTotal,
    taxesTotal: financeTotals.taxesTotal,
    profitTotal: financeTotals.profitTotal,
    refundSalesTotal: refundTotals.refundSalesTotal,
    refundProfitTotal: refundTotals.refundProfitTotal,
    refundShippingTotal: refundTotals.refundShippingTotal,
    refundOperatingCostTotal: refundTotals.refundOperatingCostTotal,
    refundTaxesTotal: refundTotals.refundTaxesTotal,
    refundRecoveredCostTotal: refundTotals.refundRecoveredCostTotal,
    netSalesTotal: financeTotals.salesTotal - refundTotals.refundSalesTotal,
    netProfitTotal: financeTotals.profitTotal - refundTotals.refundProfitTotal,
    netShippingTotal: Math.max(0, shippingTotal - refundTotals.refundShippingTotal),
    netOperatingCostTotal: Math.max(0, operatingCostTotal - refundTotals.refundOperatingCostTotal),
    netTaxesTotal: Math.max(0, financeTotals.taxesTotal - refundTotals.refundTaxesTotal),
    netRecoveredCostTotal: Math.max(0, financeTotals.recoveredCostTotal - refundTotals.refundRecoveredCostTotal),
    hasRefunds,
    orderCount,
    itemCount,
  };
}

function calculateDayTotals(orders) {
  return calculateFinanceTotals(orders);
}

function formatRefundAmount(value, formatter = currencyFormatter) {
  return `-${formatter.format(Number(value || 0))}`;
}

function formatNetAmount(value, formatter = currencyFormatter) {
  return formatter.format(Number(value || 0));
}

function getChartBarPercent(value, maxValue) {
  if (Number(value || 0) <= 0) return 0;
  if (!maxValue) return 0;
  return Math.max(3, Math.min(100, (Number(value || 0) / maxValue) * 100));
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
  const actualShippingTotal = Number(order?.totalShippingPriceSet?.shopMoney?.amount || 0);
  const shippingTotal = actualShippingTotal;
  const receivedSalesTotal = Number(order?.totalReceivedSet?.shopMoney?.amount || 0);
  const fallbackSalesTotal = totals.salesTotal + shippingTotal;
  const salesTotal = receivedSalesTotal || fallbackSalesTotal;

  return { salesTotal, originalSubtotalTotal: originalOrderTotal, shippingTotal, recoveredCostTotal, taxesTotal, profitTotal };
}

function extractRefundEventsFromOrders(orders, start, end) {
  const rangeStartMs = start.getTime();
  const rangeEndMs = end.getTime();
  return orders.flatMap((order) => {
    const orderFinance = calculateOrderFinanceTotals(order);
    const originalOrderTotal = Number(orderFinance.originalSubtotalTotal || 0);
    const profitMarginRate = getProfitMarginRateForOrderTotal(originalOrderTotal);
    let hasAppliedOrderShippingRefund = false;
    return (order?.refunds || [])
      .map((refund) => {
        const createdAt = refund?.createdAt ? new Date(refund.createdAt) : null;
        if (!createdAt || Number.isNaN(createdAt.getTime())) return null;
        if (createdAt.getTime() < rangeStartMs || createdAt.getTime() >= rangeEndMs) return null;
        const refundLineItems = refund?.refundLineItems?.nodes || [];
        const refundLineSubtotal = refundLineItems.reduce((sum, refundLineItem) => {
          const subtotal = Number(refundLineItem?.subtotalSet?.shopMoney?.amount || 0);
          if (subtotal > 0) return sum + subtotal;
          const quantity = Math.max(0, Number(refundLineItem?.quantity || 0));
          const unitPrice = Number(refundLineItem?.lineItem?.originalUnitPriceSet?.shopMoney?.amount || 0);
          return sum + unitPrice * quantity;
        }, 0);
        const totalRefundedAmount = Number(refund?.totalRefundedSet?.shopMoney?.amount || 0);
        if (totalRefundedAmount <= 0 && refundLineSubtotal <= 0) return null;
        const orderShippingTotal = Number(orderFinance.shippingTotal || 0);
        const orderRefundedShippingTotal = Number(order?.totalRefundedShippingSet?.shopMoney?.amount || 0);
        const currentShippingTotal = Number(order?.currentShippingPriceSet?.shopMoney?.amount || 0);
        const inferredRefundedShippingTotal = Math.max(0, orderShippingTotal - currentShippingTotal);
        const explicitRefundedShippingTotal = Math.max(orderRefundedShippingTotal, inferredRefundedShippingTotal);
        const refundShippingFromAmount =
          totalRefundedAmount > refundLineSubtotal + 0.01
            ? Math.min(orderShippingTotal, totalRefundedAmount - refundLineSubtotal)
            : 0;
        const refundShippingTotal = hasAppliedOrderShippingRefund
          ? refundShippingFromAmount
          : Math.max(refundShippingFromAmount, Math.min(orderShippingTotal, explicitRefundedShippingTotal));
        if (refundShippingTotal > 0) hasAppliedOrderShippingRefund = true;
        const refundProductSalesTotal = refundLineSubtotal || Math.max(0, totalRefundedAmount - refundShippingTotal);
        const refundSalesTotal = refundProductSalesTotal + refundShippingTotal;
        const refundedRecoveredCostTotal = refundLineItems.reduce((sum, refundLineItem) => {
          const quantity = Math.max(0, Number(refundLineItem?.quantity || 0));
          const unitPrice = Number(refundLineItem?.lineItem?.originalUnitPriceSet?.shopMoney?.amount || 0);
          const recoveredUnitCost = Math.round(Math.max(0, calculateRecoveredUnitCost(unitPrice)));
          return sum + recoveredUnitCost * quantity;
        }, 0);
        const refundedItemCount = refundLineItems.reduce(
          (sum, refundLineItem) => sum + Math.max(0, Number(refundLineItem?.quantity || 0)),
          0,
        );
        const refundOperatingCostTotal = refundedItemCount * OPERATING_COST_PER_ITEM;
        const refundMarginTotal = refundedRecoveredCostTotal * profitMarginRate;
        const refundTaxesTotal = refundMarginTotal * PROFIT_TAX_RATE;
        const refundProfitTotal = refundMarginTotal - refundTaxesTotal;
        return {
          createdAt: refund.createdAt,
          orderId: order?.id || "",
          orderName: order?.name || "Pedido",
          orderCreatedAt: order?.createdAt || "",
          refundSalesTotal,
          refundProfitTotal,
          refundShippingTotal,
          refundOperatingCostTotal,
          refundTaxesTotal,
          refundRecoveredCostTotal: refundedRecoveredCostTotal,
        };
      })
      .filter(Boolean);
  });
}

function calculateRecoveredUnitCost(unitPrice) {
  const costRecoveryFactor = 1 + COST_RECOVERY_MARGIN_RATE + COST_RECOVERY_MARGIN_RATE * PROFIT_TAX_RATE;
  return (
    (Number(unitPrice || 0) * (1 - TRANSACTION_RATE) - SHOPIFY_FIXED_COMMISSION_PER_ITEM - OPERATING_COST_PER_ITEM) /
    costRecoveryFactor
  );
}

export const headers = () => ({
  "Cache-Control": "no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow",
});

export async function loader({ request }) {
  const url = new URL(request.url);
  const period = normalizeFinancePeriod(url.searchParams.get("period"));
  const chartMonthKey = clampChartMonthKey(url.searchParams.get("month"));
  const accessCodes = configuredAccessCodes();
  if (!accessCodes.length) {
    return {
      isLoggedIn: false,
      needsConfiguration: true,
      period,
      totals: emptyTotals,
      week: { label: "", days: [] },
      history: { label: "", days: [] },
      chart: emptyChartData(chartMonthKey),
      error: "Falta configurar FINANCE_ACCESS_CODE en Render.",
    };
  }

  const isLoggedIn = await hasFinanceAccess(request);
  if (!isLoggedIn) {
    return {
      isLoggedIn: false,
      needsConfiguration: false,
      period,
      totals: emptyTotals,
      week: { label: "", days: [] },
      history: { label: "", days: [] },
      chart: emptyChartData(chartMonthKey),
      error: "",
    };
  }

  const { start, end, monthKey } = getFinanceRangeInMexico(period, { chartMonthKey });
  const dayLabel = period === "day" ? formatFinanceDate(start) : "";
  try {
    const { shop, sessions } = await resolveFinanceSession(request);
    if (!shop || !sessions?.length) {
      return {
        isLoggedIn: true,
        needsConfiguration: false,
        period,
        totals: emptyTotals,
        week: { label: "", days: [] },
        history: { label: "", days: [] },
        chart: emptyChartData(monthKey || chartMonthKey),
        error: "No se encontro una sesion offline valida para consultar ventas.",
      };
    }
    const { orders, refundEvents } = await fetchFinanceRangeDataWithCache({ shop, sessions, start, end });
    const week = period === "week" ? buildWeekBreakdown(start, end, orders, refundEvents) : { label: "", days: [] };
    const history = period === "history" ? buildMonthBreakdown(start, end, orders, refundEvents) : { label: "", days: [] };
    const chart = period === "chart" ? buildChartBreakdown(start, end, orders, refundEvents, monthKey) : emptyChartData(chartMonthKey);
    return {
      isLoggedIn: true,
      needsConfiguration: false,
      period,
      dayLabel,
      totals: calculateFinanceTotals(orders, refundEvents),
      week,
      history,
      chart,
      error: "",
    };
  } catch (error) {
    console.error("Finance portal failed to load day totals", error);
    return {
      isLoggedIn: true,
      needsConfiguration: false,
      period,
      dayLabel,
      totals: emptyTotals,
      week: { label: period === "week" ? formatWeekLabel(start, end) : "", days: [] },
      history: { label: period === "history" ? formatMonthLabel(start) : "", days: [] },
      chart: { ...emptyChartData(monthKey || chartMonthKey), label: period === "chart" ? formatMonthLabel(start) : "" },
      error: formatFinanceLoadError(error, period),
    };
  }
}

export async function action({ request }) {
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const url = new URL(request.url);
  const accessCodes = configuredAccessCodes();

  if (intent === "logout") {
    const currentAccess = await readFinanceAccessCookie(request);
    releaseFinanceExclusiveSession(currentAccess?.sessionToken);
    return redirect("/finanzas", {
      headers: {
        "Set-Cookie": await financeAccessCookie().serialize("", { maxAge: 0 }),
      },
    });
  }

  if (!accessCodes.length) return { ok: false, error: "Falta configurar FINANCE_ACCESS_CODE en Render." };
  const code = String(formData.get("code") || "").trim();
  if (!accessCodes.includes(code)) return { ok: false, error: "Codigo incorrecto." };
  const currentAccess = await readFinanceAccessCookie(request);
  const exclusiveSession = startFinanceExclusiveSession(currentAccess?.sessionToken);
  if (!exclusiveSession.ok) return { ok: false, error: exclusiveSession.error };

  return redirect(`/finanzas${url.search}`, {
    headers: {
      "Set-Cookie": await financeAccessCookie().serialize({ ok: true, code, sessionToken: exclusiveSession.token }),
    },
  });
}

export default function FinanzasPortal() {
  const { isLoggedIn, needsConfiguration, period, dayLabel, totals, week, history, chart, error } = useLoaderData();
  const actionData = useActionData();
  const revalidator = useRevalidator();
  const navigation = useNavigation();
  const submit = useSubmit();
  const [selectedDetailDayKey, setSelectedDetailDayKey] = useState("");
  const [isHistoryMonthOpen, setIsHistoryMonthOpen] = useState(false);
  const [isChartDetailOpen, setIsChartDetailOpen] = useState(false);
  const [optimisticPeriod, setOptimisticPeriod] = useState(period);
  const navigationPeriod = navigation.location
    ? normalizeFinancePeriod(new URLSearchParams(navigation.location.search).get("period"))
    : "";
  const activePeriod = navigationPeriod || optimisticPeriod || period;
  const detailDays = period === "history" ? history?.days || [] : period === "week" ? week?.days || [] : [];
  const selectedDetailDay = detailDays.find((day) => day.key === selectedDetailDayKey) || null;
  const selectedWeekDay = selectedDetailDay;
  const setSelectedWeekDayKey = setSelectedDetailDayKey;
  const selectedDetailUsesNetTotals = Boolean(
    selectedWeekDay?.totals?.hasRefunds && (period === "history" || selectedWeekDay?.isCut),
  );
  const chartDays = chart?.days || [];
  const chartMonthOptions = chart?.monthOptions || [];
  const chartCards = [
    {
      title: "Ventas",
      className: styles.chartSales,
      formatter: currencyFormatter,
      values: chartDays.map((day) => ({ ...day, value: day.totals.salesTotal })),
    },
    {
      title: "Reembolsos",
      className: styles.chartRefunds,
      formatter: currencyFormatter,
      values: chartDays.map((day) => ({ ...day, value: day.totals.refundSalesTotal })),
    },
    {
      title: "Ganancias",
      className: styles.chartProfit,
      formatter: currencyFormatter,
      values: chartDays.map((day) => ({ ...day, value: day.totals.netProfitTotal })),
    },
    {
      title: "Ticket promedio",
      className: styles.chartTicket,
      formatter: currencyFormatter,
      values: chartDays.map((day) => ({ ...day, value: day.totals.averageTicket })),
    },
  ];

  useEffect(() => {
    setOptimisticPeriod(period);
    setSelectedDetailDayKey("");
    setIsHistoryMonthOpen(false);
    setIsChartDetailOpen(false);
  }, [period]);

  useEffect(() => {
    setIsChartDetailOpen(false);
  }, [chart?.monthKey]);

  useEffect(() => {
    if (!isLoggedIn) return undefined;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") revalidator.revalidate();
    }, 60000);
    return () => window.clearInterval(interval);
  }, [isLoggedIn, revalidator]);

  if (!isLoggedIn) {
    return (
      <main className={`${styles.publicShell} ${styles.accessShell}`}>
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
                <input className={styles.input} name="code" type="password" inputMode="text" autoComplete="current-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
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
          <Link
            className={`${styles.periodButton} ${activePeriod === "day" ? styles.periodButtonActive : ""}`}
            to="/finanzas?period=day"
            prefetch="intent"
            onClick={() => setOptimisticPeriod("day")}
          >
            Dia
          </Link>
          <Link
            className={`${styles.periodButton} ${activePeriod === "week" ? styles.periodButtonActive : ""}`}
            to="/finanzas?period=week"
            prefetch="intent"
            onClick={() => setOptimisticPeriod("week")}
          >
            Semana
          </Link>
          <Link
            className={`${styles.periodButton} ${activePeriod === "history" ? styles.periodButtonActive : ""}`}
            to="/finanzas?period=history"
            prefetch="intent"
            onClick={() => setOptimisticPeriod("history")}
          >
            Historial
          </Link>
          <Link
            className={`${styles.periodButton} ${activePeriod === "chart" ? styles.periodButtonActive : ""}`}
            to="/finanzas?period=chart"
            prefetch="intent"
            onClick={() => setOptimisticPeriod("chart")}
          >
            Grafica
          </Link>
        </section>

        {error ? <p className={styles.errorText}>{error}</p> : null}

        {period === "week" ? (
          <section className={styles.weekPanel} aria-label="Resumen semanal">
            <h2>{week?.label || "Semana actual"}</h2>
            <article className={styles.weekSummaryCard}>
              <span>
                <strong>Resumen de la semana</strong>
                {totals.hasRefunds ? <small>Reembolsos</small> : null}
              </span>
              <span>
                Ventas
                <strong>{currencyFormatter.format(totals.salesTotal)}</strong>
                {totals.hasRefunds ? (
                  <small className={styles.refundAmount}>{formatRefundAmount(totals.refundSalesTotal)}</small>
                ) : null}
              </span>
              <span>
                Ganancias
                <strong>{currencyFormatter.format(totals.profitTotal)}</strong>
                {totals.hasRefunds ? (
                  <small className={styles.refundAmount}>{formatRefundAmount(totals.refundProfitTotal)}</small>
                ) : null}
              </span>
              {totals.hasRefunds ? (
                <>
                  <span className={`${styles.weekNetCell} ${styles.weekNetLabel}`}>
                    <strong>Total de la semana</strong>
                  </span>
                  <span className={styles.weekNetCell}>
                    <strong>{currencyFormatter.format(totals.netSalesTotal)}</strong>
                  </span>
                  <span className={styles.weekNetCell}>
                    <strong>{currencyFormatter.format(totals.netProfitTotal)}</strong>
                  </span>
                </>
              ) : null}
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
                    {day.totals.hasRefunds ? (
                      <>
                        <small className={styles.refundAmount}>{formatRefundAmount(day.totals.refundSalesTotal)}</small>
                        <small className={styles.netAmount}>{formatNetAmount(day.totals.netSalesTotal)}</small>
                      </>
                    ) : null}
                  </span>
                  <span>
                    Ganancias
                    <strong>{currencyFormatter.format(day.totals.profitTotal)}</strong>
                    {day.totals.hasRefunds ? (
                      <>
                        <small className={styles.refundAmount}>{formatRefundAmount(day.totals.refundProfitTotal)}</small>
                        <small className={styles.netAmount}>{formatNetAmount(day.totals.netProfitTotal)}</small>
                      </>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
            <article className={styles.weekFullSummaryCard}>
              <h3>Total de toda la semana</h3>
              <div className={styles.metrics}>
                <article className={`${styles.metric} ${styles.metricSales}`}>
                  <span>Ventas</span>
                  <strong>{currencyFormatter.format(totals.hasRefunds ? totals.netSalesTotal : totals.salesTotal)}</strong>
                </article>
                <article className={`${styles.metric} ${styles.metricTicket}`}>
                  <span>Ticket promedio</span>
                  <strong>{currencyFormatter.format(totals.averageTicket)}</strong>
                </article>
                <article className={`${styles.metric} ${styles.metricOperatingCost}`}>
                  <span>Costo operativo</span>
                  <strong>
                    {currencyFormatter.format(totals.hasRefunds ? totals.netOperatingCostTotal : totals.operatingCostTotal)}
                  </strong>
                </article>
                <article className={`${styles.metric} ${styles.metricShipping}`}>
                  <span>Paqueteria</span>
                  <strong>{currencyFormatter.format(totals.hasRefunds ? totals.netShippingTotal : totals.shippingTotal)}</strong>
                </article>
                <article className={`${styles.metric} ${styles.metricTaxes}`}>
                  <span>Impuestos</span>
                  <strong>{currencyFormatter.format(totals.hasRefunds ? totals.netTaxesTotal : totals.taxesTotal)}</strong>
                </article>
                <article className={`${styles.metric} ${styles.metricRecovered}`}>
                  <span>Costo recuperado</span>
                  <strong>
                    {wholeCurrencyFormatter.format(totals.hasRefunds ? totals.netRecoveredCostTotal : totals.recoveredCostTotal)}
                  </strong>
                </article>
                <article className={`${styles.metric} ${styles.metricProfit}`}>
                  <span>Ganancias</span>
                  <strong>{currencyFormatter.format(totals.hasRefunds ? totals.netProfitTotal : totals.profitTotal)}</strong>
                </article>
              </div>
            </article>
          </section>
        ) : null}

        {period === "history" ? (
          <section className={styles.weekPanel} aria-label="Historial mensual">
            <h2>Historial</h2>
            <button
              className={`${styles.weekCard} ${styles.monthOverviewCard}`}
              type="button"
              onClick={() => setIsHistoryMonthOpen((isOpen) => !isOpen)}
              aria-expanded={isHistoryMonthOpen}
            >
              <span>
                <strong>{history?.label || "Mes actual"}</strong>
              </span>
              <span>
                Ventas
                <strong>{currencyFormatter.format(totals.salesTotal)}</strong>
                {totals.hasRefunds ? (
                  <>
                    <small className={styles.refundAmount}>{formatRefundAmount(totals.refundSalesTotal)}</small>
                    <small className={styles.netAmount}>{formatNetAmount(totals.netSalesTotal)}</small>
                  </>
                ) : null}
              </span>
              <span>
                Ganancias
                <strong>{currencyFormatter.format(totals.profitTotal)}</strong>
                {totals.hasRefunds ? (
                  <>
                    <small className={styles.refundAmount}>{formatRefundAmount(totals.refundProfitTotal)}</small>
                    <small className={styles.netAmount}>{formatNetAmount(totals.netProfitTotal)}</small>
                  </>
                ) : null}
              </span>
            </button>
            {isHistoryMonthOpen ? (
              <div className={`${styles.weekCards} ${styles.monthCards}`}>
                {(history?.days || []).map((day) => (
                  <button
                    className={`${styles.weekCard} ${day.isCut ? styles.cutCard : ""} ${
                      selectedDetailDay?.key === day.key ? styles.weekCardActive : ""
                    }`}
                    type="button"
                    key={day.key}
                    onClick={() => setSelectedDetailDayKey(day.key)}
                  >
                    <span>
                      <strong>{day.dayName}</strong>
                      <small>{day.dateLabel}</small>
                    </span>
                    <span>
                      Ventas
                      <strong>{currencyFormatter.format(day.totals.salesTotal)}</strong>
                      {day.totals.hasRefunds ? (
                        <>
                          <small className={styles.refundAmount}>{formatRefundAmount(day.totals.refundSalesTotal)}</small>
                          <small className={styles.netAmount}>{formatNetAmount(day.totals.netSalesTotal)}</small>
                        </>
                      ) : null}
                    </span>
                    <span>
                      Ganancias
                      <strong>{currencyFormatter.format(day.totals.profitTotal)}</strong>
                      {day.totals.hasRefunds ? (
                        <>
                          <small className={styles.refundAmount}>{formatRefundAmount(day.totals.refundProfitTotal)}</small>
                          <small className={styles.netAmount}>{formatNetAmount(day.totals.netProfitTotal)}</small>
                        </>
                      ) : null}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {period === "chart" ? (
          <section className={styles.chartPanel} aria-label="Graficas financieras">
            {!isChartDetailOpen ? (
              <>
                <h2>Graficas de {chart?.label || "Mes actual"}</h2>
                <div className={styles.chartOverviewGrid}>
                  {chartCards.map((chartCard) => {
                    const maxValue = Math.max(...chartCard.values.map((day) => Number(day.value || 0)), 0);
                    return (
                      <button
                        className={styles.chartOverviewCard}
                        type="button"
                        key={chartCard.title}
                        onClick={() => setIsChartDetailOpen(true)}
                      >
                        <span>{chartCard.title}</span>
                        <span className={styles.chartMiniBars} aria-hidden="true">
                          {chartCard.values.map((day) => (
                            <span
                              className={styles.chartMiniTrack}
                              key={`${chartCard.title}-mini-${day.key}`}
                            >
                              <span
                                className={`${styles.chartMiniFill} ${chartCard.className}`}
                                style={{ height: `${getChartBarPercent(day.value, maxValue)}%` }}
                              />
                            </span>
                          ))}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>
            ) : (
              <>
                <h2>Graficas de {chart?.label || "Mes actual"}</h2>
                <div className={styles.chartControls}>
                  <Form method="get" className={styles.chartMonthForm}>
                    <input type="hidden" name="period" value="chart" />
                    <label className={styles.chartMonthLabel}>
                      Mes
                      <select
                        className={styles.chartMonthSelect}
                        name="month"
                        value={chart?.monthKey || ""}
                        onChange={(event) => submit(event.currentTarget.form)}
                      >
                        {chartMonthOptions.map((monthOption) => (
                          <option value={monthOption.value} key={monthOption.value}>
                            {monthOption.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </Form>
                  {chart?.canGoNext ? (
                    <Link
                      className={styles.chartNavButton}
                      to={`/finanzas?period=chart&month=${chart.nextMonthKey}`}
                      prefetch="intent"
                    >
                      Siguiente
                    </Link>
                  ) : (
                    <span className={`${styles.chartNavButton} ${styles.chartNavButtonDisabled}`}>Siguiente</span>
                  )}
                  <Link
                    className={styles.chartNavButton}
                    to={`/finanzas?period=chart&month=${chart?.previousMonthKey || ""}`}
                    prefetch="intent"
                  >
                    Anterior
                  </Link>
                  <button className={styles.chartSummaryButton} type="button" onClick={() => setIsChartDetailOpen(false)}>
                    Resumen
                  </button>
                </div>
                <div className={styles.chartGrid}>
                  {chartCards.map((chartCard) => {
                    const maxValue = Math.max(...chartCard.values.map((day) => Number(day.value || 0)), 0);
                    return (
                      <article className={styles.chartCard} key={chartCard.title}>
                        <h3>{chartCard.title}</h3>
                        <div className={styles.chartBars}>
                          {chartCard.values.map((day) => (
                            <div className={styles.chartRow} key={`${chartCard.title}-${day.key}`}>
                              <span className={styles.chartDay}>{day.dateLabel}</span>
                              <span className={styles.chartTrack}>
                                <span
                                  className={`${styles.chartFill} ${chartCard.className}`}
                                  style={{ width: `${getChartBarPercent(day.value, maxValue)}%` }}
                                />
                              </span>
                              <strong>{chartCard.formatter.format(day.value)}</strong>
                            </div>
                          ))}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </>
            )}
          </section>
        ) : null}

        {(period === "week" || period === "history") && selectedWeekDay ? (
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
                  <strong>
                    {currencyFormatter.format(
                      selectedDetailUsesNetTotals
                        ? selectedWeekDay.totals.netSalesTotal
                        : selectedWeekDay.totals.salesTotal,
                    )}
                  </strong>
                </article>
                <article className={`${styles.metric} ${styles.metricTicket}`}>
                  <span>Ticket promedio</span>
                  <strong>{currencyFormatter.format(selectedWeekDay.totals.averageTicket)}</strong>
                </article>
                <article className={`${styles.metric} ${styles.metricOperatingCost}`}>
                  <span>Costo operativo</span>
                  <strong>
                    {currencyFormatter.format(
                      selectedWeekDay.totals.hasRefunds
                        ? selectedWeekDay.totals.netOperatingCostTotal
                        : selectedWeekDay.totals.operatingCostTotal,
                    )}
                  </strong>
                </article>
                <article className={`${styles.metric} ${styles.metricShipping}`}>
                  <span>Paqueteria</span>
                  <strong>
                    {currencyFormatter.format(
                      selectedWeekDay.totals.hasRefunds
                        ? selectedWeekDay.totals.netShippingTotal
                        : selectedWeekDay.totals.shippingTotal,
                    )}
                  </strong>
                </article>
                <article className={`${styles.metric} ${styles.metricTaxes}`}>
                  <span>Impuestos</span>
                  <strong>
                    {currencyFormatter.format(
                      selectedWeekDay.totals.hasRefunds
                        ? selectedWeekDay.totals.netTaxesTotal
                        : selectedWeekDay.totals.taxesTotal,
                    )}
                  </strong>
                </article>
                <article className={`${styles.metric} ${styles.metricRecovered}`}>
                  <span>Costo recuperado</span>
                  <strong>
                    {wholeCurrencyFormatter.format(
                      selectedWeekDay.totals.hasRefunds
                        ? selectedWeekDay.totals.netRecoveredCostTotal
                        : selectedWeekDay.totals.recoveredCostTotal,
                    )}
                  </strong>
                </article>
                <article className={`${styles.metric} ${styles.metricProfit}`}>
                  <span>Ganancias</span>
                  <strong>
                    {currencyFormatter.format(
                      selectedWeekDay.totals.hasRefunds
                        ? selectedWeekDay.totals.netProfitTotal
                        : selectedWeekDay.totals.profitTotal,
                    )}
                  </strong>
                </article>
              </div>
            </div>
          </section>
        ) : null}

        {period === "day" ? (
          <section className={styles.financeDetailSection} aria-label="Detalle financiero">
          {dayLabel ? (
            <div className={styles.dayDateCard} aria-label="Fecha del dia">
              {dayLabel}
            </div>
          ) : null}
          {totals.hasRefunds ? (
            <article className={styles.weekSummaryCard}>
              <span>
                <strong>Resumen del dia</strong>
                <small>Reembolsos</small>
              </span>
              <span>
                Ventas
                <strong>{currencyFormatter.format(totals.netSalesTotal + totals.refundSalesTotal)}</strong>
                <small className={styles.refundAmount}>{formatRefundAmount(totals.refundSalesTotal)}</small>
              </span>
              <span>
                Ganancias
                <strong>{currencyFormatter.format(totals.netProfitTotal + totals.refundProfitTotal)}</strong>
                <small className={styles.refundAmount}>{formatRefundAmount(totals.refundProfitTotal)}</small>
              </span>
              <span className={styles.weekNetCell}>
                <strong>Total del dia</strong>
              </span>
              <span className={styles.weekNetCell}>
                <strong>{currencyFormatter.format(totals.netSalesTotal)}</strong>
              </span>
              <span className={styles.weekNetCell}>
                <strong>{currencyFormatter.format(totals.netProfitTotal)}</strong>
              </span>
            </article>
          ) : null}
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
              <strong>
                {currencyFormatter.format(
                  (selectedWeekDay?.totals || totals).hasRefunds
                    ? (selectedWeekDay?.totals || totals).netOperatingCostTotal
                    : (selectedWeekDay?.totals || totals).operatingCostTotal,
                )}
              </strong>
            </article>
            <article className={`${styles.metric} ${styles.metricShipping}`}>
              <span>Paqueteria</span>
              <strong>
                {currencyFormatter.format(
                  (selectedWeekDay?.totals || totals).hasRefunds
                    ? (selectedWeekDay?.totals || totals).netShippingTotal
                    : (selectedWeekDay?.totals || totals).shippingTotal,
                )}
              </strong>
            </article>
            <article className={`${styles.metric} ${styles.metricTaxes}`}>
              <span>Impuestos</span>
              <strong>
                {currencyFormatter.format(
                  (selectedWeekDay?.totals || totals).hasRefunds
                    ? (selectedWeekDay?.totals || totals).netTaxesTotal
                    : (selectedWeekDay?.totals || totals).taxesTotal,
                )}
              </strong>
            </article>
            <article className={`${styles.metric} ${styles.metricRecovered}`}>
              <span>Costo recuperado</span>
              <strong>
                {wholeCurrencyFormatter.format(
                  (selectedWeekDay?.totals || totals).hasRefunds
                    ? (selectedWeekDay?.totals || totals).netRecoveredCostTotal
                    : (selectedWeekDay?.totals || totals).recoveredCostTotal,
                )}
              </strong>
            </article>
            <article className={`${styles.metric} ${styles.metricProfit}`}>
              <span>Ganancias</span>
              <strong>
                {currencyFormatter.format(
                  (selectedWeekDay?.totals || totals).hasRefunds
                    ? (selectedWeekDay?.totals || totals).netProfitTotal
                    : (selectedWeekDay?.totals || totals).profitTotal,
                )}
              </strong>
            </article>
          </div>
        </section>
        ) : null}
      </div>
    </main>
  );
}
