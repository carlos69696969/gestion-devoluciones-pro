import prisma from "../db.server";

const DEFAULT_REWARD_RATE = 0.1;
const RECENT_PENDING_MS = 5 * 60 * 1000;
const NOTIFICATIONS_API_BASE_URL = String(
  process.env.NOTIFICATIONS_API_URL || "https://centro-de-notificaciones-cariana.onrender.com",
).replace(/\/+$/, "");
const NOTIFICATIONS_API_KEY = String(process.env.NOTIFICATIONS_API_KEY || process.env.APP_INTERNAL_API_KEY || "").trim();
const STORE_CREDIT_NOTIFICATION_TIMEOUT_MS = Number(process.env.STORE_CREDIT_NOTIFICATION_TIMEOUT_MS || 2500);

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeShop(shop) {
  return normalizeString(shop).toLowerCase();
}

function numericIdToGid(resource, value) {
  const text = normalizeString(value);
  if (!text) return "";
  if (text.startsWith("gid://")) return text;
  return `gid://shopify/${resource}/${text}`;
}

function orderIdFromPayload(payload = {}) {
  return normalizeString(payload.admin_graphql_api_id) || numericIdToGid("Order", payload.id || payload.order_id);
}

function refundIdFromPayload(payload = {}) {
  return normalizeString(payload.admin_graphql_api_id) || numericIdToGid("Refund", payload.id);
}

function customerIdFromPayload(payload = {}) {
  return (
    normalizeString(payload.customer?.admin_graphql_api_id) ||
    normalizeString(payload.customer?.id && numericIdToGid("Customer", payload.customer.id))
  );
}

function legacyNumericId(value) {
  const text = normalizeString(value);
  if (!text) return "";
  if (/^\d+$/.test(text)) return text;
  const match = text.match(/(\d+)(?!.*\d)/);
  return match ? match[1] : "";
}

function readRewardRate() {
  const configured = Number(process.env.STORE_CREDIT_REWARD_RATE || DEFAULT_REWARD_RATE);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_REWARD_RATE;
  return Math.min(configured, 1);
}

function rewardsEnabled() {
  return String(process.env.STORE_CREDIT_REWARDS_ENABLED || "true").toLowerCase() !== "false";
}

function moneyNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function roundMoney(value) {
  return Math.round((moneyNumber(value) + Number.EPSILON) * 100) / 100;
}

function moneyFromSet(set) {
  const money = set?.shopMoney || set?.presentmentMoney || set || {};
  return {
    amount: roundMoney(money.amount),
    currencyCode: normalizeString(money.currencyCode || "MXN").toUpperCase(),
  };
}

function proratedLineTotal(lineItem, refundQuantity) {
  const quantity = Math.max(0, moneyNumber(refundQuantity));
  if (quantity <= 0) return 0;

  const lineQuantity = Math.max(1, moneyNumber(lineItem?.quantity || quantity));
  const discountedTotal = moneyFromSet(lineItem?.discountedTotalSet).amount;
  if (discountedTotal > 0) {
    return roundMoney((discountedTotal / lineQuantity) * quantity);
  }

  const originalTotal = moneyFromSet(lineItem?.originalTotalSet).amount;
  if (originalTotal > 0) {
    return roundMoney((originalTotal / lineQuantity) * quantity);
  }

  const originalUnitPrice = moneyFromSet(lineItem?.originalUnitPriceSet).amount;
  if (originalUnitPrice > 0) {
    return roundMoney(originalUnitPrice * quantity);
  }

  return 0;
}

function refundLineItemSubtotal(item) {
  const explicitSubtotal = moneyFromSet(item?.subtotalSet).amount;
  if (explicitSubtotal > 0) return explicitSubtotal;
  return proratedLineTotal(item?.lineItem, item?.quantity);
}

function refundLineItemSubtotalFromWebhook(item) {
  const explicitSubtotal = moneyNumber(item?.subtotal || item?.subtotal_set?.shop_money?.amount);
  if (explicitSubtotal > 0) return roundMoney(explicitSubtotal);

  const quantity = Math.max(0, moneyNumber(item?.quantity));
  const lineItem = item?.line_item || {};
  const unitPrice = moneyNumber(
    lineItem.discounted_price ||
      lineItem.price ||
      item?.price ||
      item?.price_set?.shop_money?.amount,
  );
  if (quantity > 0 && unitPrice > 0) {
    return roundMoney(unitPrice * quantity);
  }

  return 0;
}

function compactOrderPayload(payload = {}) {
  return {
    id: payload.id || null,
    admin_graphql_api_id: payload.admin_graphql_api_id || null,
    name: payload.name || payload.order_number || null,
    currency: payload.currency || payload.presentment_currency || null,
    subtotal_price: payload.subtotal_price || null,
    current_subtotal_price: payload.current_subtotal_price || null,
    customer_id: payload.customer?.id || null,
    customer_email: payload.customer?.email || payload.email || null,
  };
}

function compactRefundPayload(payload = {}) {
  return {
    id: payload.id || null,
    admin_graphql_api_id: payload.admin_graphql_api_id || null,
    order_id: payload.order_id || null,
    refund_line_items: (payload.refund_line_items || []).map((item) => ({
      id: item?.id || null,
      line_item_id: item?.line_item_id || null,
      quantity: item?.quantity || null,
      subtotal: item?.subtotal || null,
    })),
  };
}

function firstShopifyErrorMessage(errors) {
  return (errors || [])
    .map((error) => normalizeString(error?.message || error))
    .filter(Boolean)
    .join("; ");
}

async function runGraphql(admin, query, variables = {}) {
  const response = await admin.graphql(query, { variables });
  const payload = await response.json();
  if (payload?.errors?.length) {
    throw new Error(firstShopifyErrorMessage(payload.errors) || "Shopify GraphQL error");
  }
  return payload?.data || {};
}

async function fetchOrderForStoreCredit(admin, orderId) {
  const data = await runGraphql(
    admin,
    `#graphql
    query StoreCreditRewardOrder($id: ID!) {
      node(id: $id) {
        ... on Order {
          id
          name
          displayFinancialStatus
          currentSubtotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          subtotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          customer {
            id
            email
            displayName
          }
        }
      }
    }`,
    { id: orderId },
  );
  return data?.node || null;
}

async function fetchRefundForStoreCredit(admin, refundId) {
  const data = await runGraphql(
    admin,
    `#graphql
    query StoreCreditRewardRefund($id: ID!) {
      node(id: $id) {
        ... on Refund {
          id
          createdAt
          totalRefundedSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          order {
            id
            name
            customer {
              id
              email
            }
          }
          refundLineItems(first: 250) {
            nodes {
              quantity
              subtotalSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              lineItem {
                id
                quantity
                originalUnitPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                originalTotalSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                discountedTotalSet(withCodeDiscounts: true) {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
      }
    }`,
    { id: refundId },
  );
  return data?.node || null;
}

async function creditStoreCreditAccount(admin, { customerId, amount, currencyCode }) {
  const data = await runGraphql(
    admin,
    `#graphql
    mutation CreditCustomerStoreCredit($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
      storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
        storeCreditAccountTransaction {
          amount {
            amount
            currencyCode
          }
          account {
            id
            balance {
              amount
              currencyCode
            }
          }
        }
        userErrors {
          code
          field
          message
        }
      }
    }`,
    {
      id: customerId,
      creditInput: {
        creditAmount: {
          amount: roundMoney(amount).toFixed(2),
          currencyCode,
        },
      },
    },
  );
  const result = data?.storeCreditAccountCredit || {};
  const userErrors = result.userErrors || [];
  if (userErrors.length) {
    const error = new Error(firstShopifyErrorMessage(userErrors) || "No se pudo acreditar credito en tienda.");
    error.userErrors = userErrors;
    throw error;
  }
  return result.storeCreditAccountTransaction || null;
}

async function debitStoreCreditAccount(admin, { customerId, amount, currencyCode }) {
  const data = await runGraphql(
    admin,
    `#graphql
    mutation DebitCustomerStoreCredit($id: ID!, $debitInput: StoreCreditAccountDebitInput!) {
      storeCreditAccountDebit(id: $id, debitInput: $debitInput) {
        storeCreditAccountTransaction {
          amount {
            amount
            currencyCode
          }
          account {
            id
            balance {
              amount
              currencyCode
            }
          }
        }
        userErrors {
          code
          field
          message
        }
      }
    }`,
    {
      id: customerId,
      debitInput: {
        debitAmount: {
          amount: roundMoney(amount).toFixed(2),
          currencyCode,
        },
      },
    },
  );
  const result = data?.storeCreditAccountDebit || {};
  const userErrors = result.userErrors || [];
  if (userErrors.length) {
    const error = new Error(firstShopifyErrorMessage(userErrors) || "No se pudo debitar credito en tienda.");
    error.userErrors = userErrors;
    throw error;
  }
  return result.storeCreditAccountTransaction || null;
}

export async function scheduleStoreCreditNotification({
  shop,
  shopifyOrderId,
  orderNumber,
  shopifyCustomerId,
  customerEmail,
  amount,
  currencyCode,
  sourceKey,
  notificationType = "store_credit_reward",
  title = "",
  message = "",
  logger = console,
}) {
  if (!NOTIFICATIONS_API_BASE_URL || !shop || !shopifyCustomerId || roundMoney(amount) <= 0) return;

  const endpoints = NOTIFICATIONS_API_KEY
    ? [
        {
          url: `${NOTIFICATIONS_API_BASE_URL}/api/store-credit/events`,
          apiKey: NOTIFICATIONS_API_KEY,
        },
        {
          url: `${NOTIFICATIONS_API_BASE_URL}/proxy/store-credit/events`,
        },
      ]
    : [
        {
          url: `${NOTIFICATIONS_API_BASE_URL}/proxy/store-credit/events`,
        },
      ];

  const body = JSON.stringify({
    shopDomain: shop,
    event: {
      sourceKey,
      shopifyCustomerId: legacyNumericId(shopifyCustomerId),
      customerEmail,
      orderId: legacyNumericId(shopifyOrderId) || shopifyOrderId,
      orderNumber,
      amount: roundMoney(amount),
      currencyCode,
      notificationType,
      title,
      message,
      delayMs: 0,
      sendNow: true,
    },
  });

  let lastError = null;
  for (const endpoint of endpoints) {
    const headers = {
      "Content-Type": "application/json",
      "x-shop-domain": shop,
    };
    if (endpoint.apiKey) {
      headers["x-api-key"] = endpoint.apiKey;
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Number.isFinite(STORE_CREDIT_NOTIFICATION_TIMEOUT_MS) ? STORE_CREDIT_NOTIFICATION_TIMEOUT_MS : 2500,
    );

    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      const responsePayload = await response.json().catch(() => null);
      if (response.ok && responsePayload?.ok !== false) {
        logger.info?.("Notificacion de credito en tienda enviada al centro", {
          shop,
          shopifyOrderId,
          endpoint: endpoint.url.includes("/api/") ? "api" : "proxy",
          result: responsePayload?.result || null,
        });
        return;
      }
      lastError = {
        status: response.status,
        detail: responsePayload?.error || responsePayload?.detail || responsePayload?.result?.reason || "",
      };
    } catch (error) {
      lastError = { error: error?.message || error };
    } finally {
      clearTimeout(timeout);
    }
  }

  logger.warn?.("No se pudo enviar la notificacion de credito en tienda al centro", {
    shop,
    shopifyOrderId,
    ...lastError,
  });
}

async function findReusableTransaction({ shop, sourceKey }) {
  const transaction = await prisma.storeCreditTransaction.findUnique({
    where: { shop_sourceKey: { shop, sourceKey } },
  });
  if (!transaction) return null;
  if (transaction.status === "pending" && Date.now() - transaction.createdAt.getTime() > RECENT_PENDING_MS) {
    return transaction;
  }
  return { ...transaction, skip: true };
}

function orderSubtotalFromWebhook(payload = {}) {
  return {
    amount: roundMoney(payload.current_subtotal_price || payload.subtotal_price),
    currencyCode: normalizeString(payload.currency || payload.presentment_currency || "MXN").toUpperCase(),
  };
}

function refundSubtotalFromWebhook(payload = {}) {
  const subtotal = (payload.refund_line_items || []).reduce(
    (sum, item) => sum + refundLineItemSubtotalFromWebhook(item),
    0,
  );
  return {
    amount: roundMoney(subtotal),
    currencyCode: normalizeString(payload.currency || payload.presentment_currency || "MXN").toUpperCase(),
  };
}

function logStoreCreditDebitDiagnostic(logger, message, details = {}) {
  const log = logger?.warn || logger?.info || console.warn;
  log.call(logger || console, message, {
    shop: details.shop,
    source: details.source,
    refundId: details.refundId,
    orderId: details.orderId,
    sourceKey: details.sourceKey,
    existingStatus: details.existingStatus || null,
    ledgerFound: Boolean(details.ledger),
    ledgerId: details.ledger?.id || null,
    ledgerCreditedAmount: details.ledger ? Number(details.ledger.creditedAmount || 0) : null,
    ledgerDebitedAmount: details.ledger ? Number(details.ledger.debitedAmount || 0) : null,
    ledgerPendingDebitAmount: details.ledger ? Number(details.ledger.pendingDebitAmount || 0) : null,
    ledgerStatus: details.ledger?.status || null,
    ledgerCreditCapApplied: Boolean(details.ledgerCreditCapApplied),
    rawRefundLineSubtotal: details.rawRefundLineSubtotal,
    eligibleRefundSubtotal: details.eligibleRefundSubtotal,
    creditRate: details.creditRate,
    refundableCredit: details.refundableCredit,
    remainingCreditedAmount: details.remainingCreditedAmount,
    debitAmount: details.debitAmount,
    cashRecoveredAmount: details.cashRecoveredAmount,
    totalRecoveredAmount: details.totalRecoveredAmount,
    currencyCode: details.currencyCode,
    customerIdPresent: Boolean(details.customerId),
    reason: details.reason,
  });
}

function calculateRefundStoreCreditDebitPlan({ ledger, refundLineSubtotal }) {
  const eligibleRefundSubtotal = roundMoney(refundLineSubtotal);
  const creditRate = Number(ledger?.creditRate || readRewardRate());
  const refundableCredit = roundMoney(eligibleRefundSubtotal * creditRate);
  const ledgerCreditedAmount = ledger ? roundMoney(Number(ledger.creditedAmount || 0)) : 0;
  const shouldCapToLedgerCredit = Boolean(ledger && ledgerCreditedAmount > 0);
  const remainingCreditedAmount = shouldCapToLedgerCredit
    ? roundMoney(ledgerCreditedAmount - Number(ledger.debitedAmount || 0))
    : refundableCredit;
  const expectedDebitAmount = roundMoney(Math.min(refundableCredit, remainingCreditedAmount));

  return {
    eligibleRefundSubtotal,
    creditRate,
    refundableCredit,
    remainingCreditedAmount,
    expectedDebitAmount,
    ledgerCreditCapApplied: shouldCapToLedgerCredit,
  };
}

async function fetchCustomerStoreCreditBalance(admin, { customerId, currencyCode = "MXN" }) {
  const normalizedCurrencyCode = normalizeString(currencyCode || "MXN").toUpperCase();
  const data = await runGraphql(
    admin,
    `#graphql
    query CustomerStoreCreditBalance($id: ID!, $query: String) {
      customer(id: $id) {
        storeCreditAccounts(first: 50, query: $query) {
          nodes {
            id
            balance {
              amount
              currencyCode
            }
          }
        }
      }
    }`,
    {
      id: customerId,
      query: normalizedCurrencyCode ? `currency_code:${normalizedCurrencyCode}` : undefined,
    },
  );
  const accounts = data?.customer?.storeCreditAccounts?.nodes || [];
  return roundMoney(
    accounts.reduce((total, account) => {
      const balance = account?.balance;
      if (!balance) return total;
      if (
        normalizedCurrencyCode &&
        normalizeString(balance.currencyCode).toUpperCase() !== normalizedCurrencyCode
      ) {
        return total;
      }
      return total + Number(balance.amount || 0);
    }, 0),
  );
}

export async function planRefundStoreCreditRecovery({
  admin,
  shop,
  shopifyOrderId,
  shopifyCustomerId = "",
  refundLineSubtotal,
  currencyCode = "MXN",
  source = "app_refund",
  logger = console,
}) {
  const normalizedShop = normalizeShop(shop);
  if (!rewardsEnabled()) return { skipped: true, reason: "disabled" };
  if (!admin || !normalizedShop) return { skipped: true, reason: "missing_admin_or_shop" };

  const cleanOrderId = normalizeString(shopifyOrderId);
  if (!cleanOrderId) return { skipped: true, reason: "missing_order_id" };

  const ledger = await prisma.storeCreditLedger.findUnique({
    where: { shop_shopifyOrderId: { shop: normalizedShop, shopifyOrderId: cleanOrderId } },
  });
  if (!ledger) {
    return { skipped: true, reason: "missing_ledger" };
  }

  const debitPlan = calculateRefundStoreCreditDebitPlan({ ledger, refundLineSubtotal });
  const normalizedCurrencyCode = normalizeString(currencyCode || ledger.currencyCode || "MXN").toUpperCase();
  if (debitPlan.eligibleRefundSubtotal <= 0 || debitPlan.expectedDebitAmount <= 0) {
    return {
      skipped: true,
      reason: "nothing_to_recover",
      ...debitPlan,
      currencyCode: normalizedCurrencyCode,
    };
  }

  let customerId = normalizeString(shopifyCustomerId || ledger.shopifyCustomerId);
  if (!customerId) {
    const orderNode = await fetchOrderForStoreCredit(admin, cleanOrderId);
    customerId = normalizeString(orderNode?.customer?.id);
  }
  if (!customerId) {
    return { skipped: true, reason: "missing_customer", ...debitPlan, currencyCode: normalizedCurrencyCode };
  }

  const availableStoreCreditAmount = Math.max(
    0,
    await fetchCustomerStoreCreditBalance(admin, { customerId, currencyCode: normalizedCurrencyCode }),
  );
  const storeCreditDebitAmount = roundMoney(
    Math.min(debitPlan.expectedDebitAmount, availableStoreCreditAmount),
  );
  const cashRecoveryAmount = roundMoney(
    Math.max(0, debitPlan.expectedDebitAmount - storeCreditDebitAmount),
  );

  logStoreCreditDebitDiagnostic(logger, "Diagnostico recuperacion credito tienda para reembolso", {
    shop: normalizedShop,
    source,
    orderId: cleanOrderId,
    ledger,
    rawRefundLineSubtotal: refundLineSubtotal,
    eligibleRefundSubtotal: debitPlan.eligibleRefundSubtotal,
    creditRate: debitPlan.creditRate,
    refundableCredit: debitPlan.refundableCredit,
    remainingCreditedAmount: debitPlan.remainingCreditedAmount,
    debitAmount: storeCreditDebitAmount,
    cashRecoveredAmount: cashRecoveryAmount,
    totalRecoveredAmount: debitPlan.expectedDebitAmount,
    ledgerCreditCapApplied: debitPlan.ledgerCreditCapApplied,
    currencyCode: normalizedCurrencyCode,
    customerId,
    reason: "planned_recovery",
  });

  return {
    skipped: false,
    customerId,
    currencyCode: normalizedCurrencyCode,
    availableStoreCreditAmount,
    storeCreditDebitAmount,
    cashRecoveryAmount,
    totalRecoveredAmount: debitPlan.expectedDebitAmount,
    expectedDebitAmount: debitPlan.expectedDebitAmount,
    ...debitPlan,
  };
}

async function debitRefundStoreCreditSubtotal({
  admin,
  shop,
  shopifyRefundId,
  shopifyOrderId,
  shopifyCustomerId = "",
  refundLineSubtotal,
  currencyCode = "MXN",
  payload = {},
  source = "webhook",
  logger = console,
  maxDebitAmount = null,
  cashRecoveredAmount = 0,
}) {
  const normalizedShop = normalizeShop(shop);
  if (!rewardsEnabled()) return { skipped: true, reason: "disabled" };
  if (!admin || !normalizedShop) return { skipped: true, reason: "missing_admin_or_shop" };

  const cleanRefundId = normalizeString(shopifyRefundId);
  if (!cleanRefundId) return { skipped: true, reason: "missing_refund_id" };

  const sourceKey = `debit:${cleanRefundId}`;
  const existing = await findReusableTransaction({ shop: normalizedShop, sourceKey });
  if (existing?.skip || existing?.status === "completed" || existing?.status === "pending_debit") {
    logStoreCreditDebitDiagnostic(logger, "Diagnostico debito credito tienda omitido por idempotencia", {
      shop: normalizedShop,
      source,
      refundId: cleanRefundId,
      orderId: shopifyOrderId,
      sourceKey,
      existingStatus: existing?.status,
      reason: "already_processed",
    });
    return { skipped: true, reason: "already_processed", transactionId: existing.id };
  }

  const cleanOrderId = normalizeString(shopifyOrderId);
  if (!cleanOrderId) return { skipped: true, reason: "missing_order_id" };

  const ledger = await prisma.storeCreditLedger.findUnique({
    where: { shop_shopifyOrderId: { shop: normalizedShop, shopifyOrderId: cleanOrderId } },
  });

  const eligibleRefundSubtotal = roundMoney(refundLineSubtotal);
  if (eligibleRefundSubtotal <= 0) {
    logStoreCreditDebitDiagnostic(logger, "Diagnostico debito credito tienda sin subtotal elegible", {
      shop: normalizedShop,
      source,
      refundId: cleanRefundId,
      orderId: cleanOrderId,
      sourceKey,
      ledger,
      rawRefundLineSubtotal: refundLineSubtotal,
      eligibleRefundSubtotal,
      currencyCode,
      reason: "eligible_refund_subtotal_zero",
    });
    return { skipped: true, reason: "nothing_to_debit" };
  }

  const debitPlan = calculateRefundStoreCreditDebitPlan({ ledger, refundLineSubtotal: eligibleRefundSubtotal });
  const hasDebitLimit = maxDebitAmount !== null && maxDebitAmount !== undefined && Number.isFinite(Number(maxDebitAmount));
  const debitAmount = roundMoney(
    Math.min(
      debitPlan.expectedDebitAmount,
      hasDebitLimit ? Math.max(0, Number(maxDebitAmount || 0)) : debitPlan.expectedDebitAmount,
    ),
  );
  const existingPayload =
    existing?.payload && typeof existing.payload === "object" && !Array.isArray(existing.payload)
      ? existing.payload
      : {};
  const existingCashRecoveredAmount = roundMoney(existingPayload.cash_recovered_from_refund_amount);
  const requestedCashRecoveredAmount = roundMoney(
    Math.min(
      Math.max(0, Number(cashRecoveredAmount || 0)),
      Math.max(0, debitPlan.expectedDebitAmount - debitAmount),
    ),
  );
  const normalizedCashRecoveredAmount = roundMoney(
    Math.max(0, requestedCashRecoveredAmount - existingCashRecoveredAmount),
  );
  const payloadCashRecoveredAmount = roundMoney(existingCashRecoveredAmount + normalizedCashRecoveredAmount);
  const totalRecoveredAmount = roundMoney(debitAmount + normalizedCashRecoveredAmount);
  const reportedTotalRecoveredAmount = roundMoney(debitAmount + payloadCashRecoveredAmount);
  if (debitPlan.expectedDebitAmount <= 0 || totalRecoveredAmount <= 0) {
    logStoreCreditDebitDiagnostic(logger, "Diagnostico debito credito tienda sin monto para debitar", {
      shop: normalizedShop,
      source,
      refundId: cleanRefundId,
      orderId: cleanOrderId,
      sourceKey,
      ledger,
      rawRefundLineSubtotal: refundLineSubtotal,
      eligibleRefundSubtotal,
      creditRate: debitPlan.creditRate,
      refundableCredit: debitPlan.refundableCredit,
      remainingCreditedAmount: debitPlan.remainingCreditedAmount,
      debitAmount,
      cashRecoveredAmount: normalizedCashRecoveredAmount,
      totalRecoveredAmount: reportedTotalRecoveredAmount,
      ledgerCreditCapApplied: debitPlan.ledgerCreditCapApplied,
      currencyCode,
      reason: "debit_amount_zero",
    });
    return { skipped: true, reason: "nothing_to_debit" };
  }

  let customerId = normalizeString(shopifyCustomerId || ledger?.shopifyCustomerId);
  if (!customerId) {
    const orderNode = await fetchOrderForStoreCredit(admin, cleanOrderId);
    customerId = normalizeString(orderNode?.customer?.id);
  }
  if (!customerId) {
    logStoreCreditDebitDiagnostic(logger, "Diagnostico debito credito tienda sin customer", {
      shop: normalizedShop,
      source,
      refundId: cleanRefundId,
      orderId: cleanOrderId,
      sourceKey,
      ledger,
      rawRefundLineSubtotal: refundLineSubtotal,
      eligibleRefundSubtotal,
      creditRate: debitPlan.creditRate,
      refundableCredit: debitPlan.refundableCredit,
      remainingCreditedAmount: debitPlan.remainingCreditedAmount,
      debitAmount,
      cashRecoveredAmount: normalizedCashRecoveredAmount,
      totalRecoveredAmount: reportedTotalRecoveredAmount,
      ledgerCreditCapApplied: debitPlan.ledgerCreditCapApplied,
      currencyCode,
      customerId,
      reason: "missing_customer",
    });
    return { skipped: true, reason: "missing_customer" };
  }

  const normalizedCurrencyCode = normalizeString(currencyCode || ledger?.currencyCode || "MXN").toUpperCase();
  const transactionSource = ledger ? source : `${source}_without_ledger`;
  const transactionPayload = {
    ...compactRefundPayload(payload),
    known_refund_subtotal: eligibleRefundSubtotal,
    expected_credit_reversal_amount: debitPlan.expectedDebitAmount,
    store_credit_debit_amount: debitAmount,
    cash_recovered_from_refund_amount: payloadCashRecoveredAmount,
    source,
  };

  const transaction = existing
    ? await prisma.storeCreditTransaction.update({
        where: { id: existing.id },
        data: {
          ledgerId: ledger?.id || null,
          shopifyOrderId: cleanOrderId,
          shopifyRefundId: cleanRefundId,
          shopifyCustomerId: customerId,
          amount: debitAmount,
          currencyCode: normalizedCurrencyCode,
          source: transactionSource,
          status: "pending",
          errorCode: null,
          errorMessage: null,
          payload: transactionPayload,
        },
      })
    : await prisma.storeCreditTransaction.create({
        data: {
          ledgerId: ledger?.id || null,
          shop: normalizedShop,
          sourceKey,
          shopifyOrderId: cleanOrderId,
          shopifyRefundId: cleanRefundId,
          shopifyCustomerId: customerId,
          type: "debit",
          source: transactionSource,
          amount: debitAmount,
          currencyCode: normalizedCurrencyCode,
          status: "pending",
          payload: transactionPayload,
        },
      });

  if (debitAmount <= 0 && normalizedCashRecoveredAmount > 0) {
    const nextDebitedAmount = ledger
      ? roundMoney(Number(ledger.debitedAmount || 0) + normalizedCashRecoveredAmount)
      : normalizedCashRecoveredAmount;
    await prisma.storeCreditTransaction.update({
      where: { id: transaction.id },
      data: {
        status: "completed",
        errorCode: null,
        errorMessage: null,
      },
    });
    if (ledger) {
      await prisma.storeCreditLedger.update({
        where: { id: ledger.id },
        data: {
          debitedAmount: { increment: normalizedCashRecoveredAmount },
          status: nextDebitedAmount >= Number(ledger.creditedAmount || 0) ? "reversed" : "partially_debited",
        },
      });
    }
    return {
      debited: false,
      amount: 0,
      cashRecoveredAmount: normalizedCashRecoveredAmount,
      totalRecoveredAmount: reportedTotalRecoveredAmount,
      expectedDebitAmount: debitPlan.expectedDebitAmount,
      currencyCode: normalizedCurrencyCode,
      withoutLedger: !ledger,
    };
  }

  try {
    logStoreCreditDebitDiagnostic(logger, "Diagnostico debito credito tienda intentando debitar Shopify", {
      shop: normalizedShop,
      source,
      refundId: cleanRefundId,
      orderId: cleanOrderId,
      sourceKey,
      ledger,
      rawRefundLineSubtotal: refundLineSubtotal,
      eligibleRefundSubtotal,
      creditRate: debitPlan.creditRate,
      refundableCredit: debitPlan.refundableCredit,
      remainingCreditedAmount: debitPlan.remainingCreditedAmount,
      debitAmount,
      cashRecoveredAmount: normalizedCashRecoveredAmount,
      totalRecoveredAmount: reportedTotalRecoveredAmount,
      ledgerCreditCapApplied: debitPlan.ledgerCreditCapApplied,
      currencyCode: normalizedCurrencyCode,
      customerId,
      reason: "attempting_debit",
    });
    await debitStoreCreditAccount(admin, {
      customerId,
      amount: debitAmount,
      currencyCode: normalizedCurrencyCode,
    });
    const nextDebitedAmount = ledger
      ? roundMoney(Number(ledger.debitedAmount || 0) + totalRecoveredAmount)
      : totalRecoveredAmount;
    await prisma.storeCreditTransaction.update({
      where: { id: transaction.id },
      data: {
        status: "completed",
        errorCode: null,
        errorMessage: null,
      },
    });
    if (ledger) {
      await prisma.storeCreditLedger.update({
        where: { id: ledger.id },
        data: {
          debitedAmount: { increment: totalRecoveredAmount },
          status: nextDebitedAmount >= Number(ledger.creditedAmount || 0) ? "reversed" : "partially_debited",
        },
      });
    }
    return {
      debited: true,
      amount: debitAmount,
      cashRecoveredAmount: normalizedCashRecoveredAmount,
      totalRecoveredAmount: reportedTotalRecoveredAmount,
      expectedDebitAmount: debitPlan.expectedDebitAmount,
      currencyCode: normalizedCurrencyCode,
      withoutLedger: !ledger,
    };
  } catch (error) {
    const firstUserError = error?.userErrors?.[0];
    const status = firstUserError?.code === "INSUFFICIENT_FUNDS" ? "pending_debit" : "failed";
    await prisma.storeCreditTransaction.update({
      where: { id: transaction.id },
      data: {
        status,
        errorCode: normalizeString(firstUserError?.code),
        errorMessage: error?.message || "No se pudo debitar credito en tienda.",
      },
    });
    if (ledger) {
      const ledgerUpdate = {
        pendingDebitAmount: status === "pending_debit" ? { increment: debitAmount } : undefined,
        status: status === "pending_debit" ? "pending_debit" : "debit_failed",
      };
      if (normalizedCashRecoveredAmount > 0) {
        ledgerUpdate.debitedAmount = { increment: normalizedCashRecoveredAmount };
      }
      await prisma.storeCreditLedger.update({
        where: { id: ledger.id },
        data: ledgerUpdate,
      });
    }
    throw error;
  }
}

export async function processPaidOrderStoreCreditReward({ admin, shop, payload = {}, logger = console }) {
  const normalizedShop = normalizeShop(shop);
  if (!rewardsEnabled()) return { skipped: true, reason: "disabled" };
  if (!admin || !normalizedShop) return { skipped: true, reason: "missing_admin_or_shop" };

  const shopifyOrderId = orderIdFromPayload(payload);
  if (!shopifyOrderId) return { skipped: true, reason: "missing_order_id" };

  const sourceKey = `credit:${shopifyOrderId}`;
  const existing = await findReusableTransaction({ shop: normalizedShop, sourceKey });
  if (existing?.skip || existing?.status === "completed") {
    return { skipped: true, reason: "already_processed", transactionId: existing.id };
  }

  let orderNode = null;
  try {
    orderNode = await fetchOrderForStoreCredit(admin, shopifyOrderId);
  } catch (error) {
    logger.warn?.("No se pudo leer la orden para credito en tienda; se usara el payload del webhook", {
      shop: normalizedShop,
      shopifyOrderId,
      error: error?.message || error,
    });
  }

  const customerId = normalizeString(orderNode?.customer?.id) || customerIdFromPayload(payload);
  const customerEmail = normalizeString(orderNode?.customer?.email || payload.customer?.email || payload.email);
  if (!customerId) return { skipped: true, reason: "missing_customer" };

  const subtotalMoney = orderNode?.currentSubtotalPriceSet
    ? moneyFromSet(orderNode.currentSubtotalPriceSet)
    : orderSubtotalFromWebhook(payload);
  const eligibleSubtotal = roundMoney(subtotalMoney.amount);
  if (eligibleSubtotal <= 0) return { skipped: true, reason: "zero_subtotal" };

  const creditRate = readRewardRate();
  const creditAmount = roundMoney(eligibleSubtotal * creditRate);
  if (creditAmount <= 0) return { skipped: true, reason: "zero_credit" };

  const ledger = await prisma.storeCreditLedger.upsert({
    where: { shop_shopifyOrderId: { shop: normalizedShop, shopifyOrderId } },
    create: {
      shop: normalizedShop,
      shopifyOrderId,
      orderNumber: normalizeString(orderNode?.name || payload.name || payload.order_number),
      shopifyCustomerId: customerId,
      customerEmail,
      currencyCode: subtotalMoney.currencyCode,
      creditRate,
      eligibleSubtotal,
      creditedAmount: 0,
      status: "pending",
    },
    update: {
      orderNumber: normalizeString(orderNode?.name || payload.name || payload.order_number),
      shopifyCustomerId: customerId,
      customerEmail,
      currencyCode: subtotalMoney.currencyCode,
      creditRate,
      eligibleSubtotal,
    },
  });

  const transaction = existing
    ? await prisma.storeCreditTransaction.update({
        where: { id: existing.id },
        data: {
          ledgerId: ledger.id,
          shopifyCustomerId: customerId,
          amount: creditAmount,
          currencyCode: subtotalMoney.currencyCode,
          status: "pending",
          errorCode: null,
          errorMessage: null,
          payload: compactOrderPayload(payload),
        },
      })
    : await prisma.storeCreditTransaction.create({
        data: {
          ledgerId: ledger.id,
          shop: normalizedShop,
          sourceKey,
          shopifyOrderId,
          shopifyCustomerId: customerId,
          type: "credit",
          amount: creditAmount,
          currencyCode: subtotalMoney.currencyCode,
          status: "pending",
          payload: compactOrderPayload(payload),
        },
      });

  try {
    await creditStoreCreditAccount(admin, {
      customerId,
      amount: creditAmount,
      currencyCode: subtotalMoney.currencyCode,
    });
    await prisma.storeCreditTransaction.update({
      where: { id: transaction.id },
      data: {
        status: "completed",
        errorCode: null,
        errorMessage: null,
      },
    });
    await prisma.storeCreditLedger.update({
      where: { id: ledger.id },
      data: {
        creditedAmount: creditAmount,
        creditError: null,
        creditedAt: new Date(),
        status: ledger.debitedAmount > 0 ? "partially_debited" : "credited",
      },
    });
    try {
      await scheduleStoreCreditNotification({
        shop: normalizedShop,
        shopifyOrderId,
        orderNumber: normalizeString(orderNode?.name || payload.name || payload.order_number),
        shopifyCustomerId: customerId,
        customerEmail,
        amount: creditAmount,
        currencyCode: subtotalMoney.currencyCode,
        sourceKey: `store-credit-reward:${shopifyOrderId}`,
        logger,
      });
    } catch (notificationError) {
      logger.warn?.("No se pudo iniciar la notificacion de credito en tienda", {
        shop: normalizedShop,
        shopifyOrderId,
        error: notificationError?.message || notificationError,
      });
    }
    return { credited: true, amount: creditAmount, currencyCode: subtotalMoney.currencyCode };
  } catch (error) {
    const firstUserError = error?.userErrors?.[0];
    await prisma.storeCreditTransaction.update({
      where: { id: transaction.id },
      data: {
        status: "failed",
        errorCode: normalizeString(firstUserError?.code),
        errorMessage: error?.message || "No se pudo acreditar credito en tienda.",
      },
    });
    await prisma.storeCreditLedger.update({
      where: { id: ledger.id },
      data: {
        status: "credit_failed",
        creditError: error?.message || "No se pudo acreditar credito en tienda.",
      },
    });
    throw error;
  }
}

export async function processRefundStoreCreditDebit({ admin, shop, payload = {}, logger = console }) {
  const normalizedShop = normalizeShop(shop);
  if (!rewardsEnabled()) return { skipped: true, reason: "disabled" };
  if (!admin || !normalizedShop) return { skipped: true, reason: "missing_admin_or_shop" };

  const shopifyRefundId = refundIdFromPayload(payload);
  if (!shopifyRefundId) return { skipped: true, reason: "missing_refund_id" };

  let refundNode = null;
  try {
    refundNode = await fetchRefundForStoreCredit(admin, shopifyRefundId);
  } catch (error) {
    logger.warn?.("No se pudo leer el reembolso para credito en tienda; se usara el payload del webhook", {
      shop: normalizedShop,
      shopifyRefundId,
      error: error?.message || error,
    });
  }

  const shopifyOrderId = normalizeString(refundNode?.order?.id) || numericIdToGid("Order", payload.order_id);
  if (!shopifyOrderId) return { skipped: true, reason: "missing_order_id" };

  const ledger = await prisma.storeCreditLedger.findUnique({
    where: { shop_shopifyOrderId: { shop: normalizedShop, shopifyOrderId } },
  });

  const refundLineSubtotal = refundNode?.refundLineItems?.nodes?.length
    ? refundNode.refundLineItems.nodes.reduce((sum, item) => sum + refundLineItemSubtotal(item), 0)
    : refundSubtotalFromWebhook(payload).amount;
  const refundCurrency =
    refundNode?.refundLineItems?.nodes?.find((item) => moneyFromSet(item?.subtotalSet).currencyCode)?.subtotalSet ||
    refundNode?.totalRefundedSet;
  const currencyCode = moneyFromSet(refundCurrency).currencyCode || ledger?.currencyCode || "MXN";
  const customerId = normalizeString(refundNode?.order?.customer?.id || ledger?.shopifyCustomerId);

  return debitRefundStoreCreditSubtotal({
    admin,
    shop: normalizedShop,
    shopifyRefundId,
    shopifyOrderId,
    shopifyCustomerId: customerId,
    refundLineSubtotal,
    currencyCode,
    payload,
    source: "webhook",
    logger,
  });
}

export async function processKnownRefundStoreCreditDebit({
  admin,
  shop,
  shopifyRefundId,
  shopifyOrderId,
  shopifyCustomerId = "",
  refundedSubtotal,
  currencyCode = "MXN",
  payload = {},
  source = "app_refund",
  logger = console,
  maxDebitAmount = null,
  cashRecoveredAmount = 0,
}) {
  return debitRefundStoreCreditSubtotal({
    admin,
    shop,
    shopifyRefundId,
    shopifyOrderId,
    shopifyCustomerId,
    refundLineSubtotal: refundedSubtotal,
    currencyCode,
    payload,
    source,
    logger,
    maxDebitAmount,
    cashRecoveredAmount,
  });
}
