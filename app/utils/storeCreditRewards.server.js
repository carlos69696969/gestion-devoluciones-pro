import prisma from "../db.server";

const DEFAULT_REWARD_RATE = 0.1;
const RECENT_PENDING_MS = 5 * 60 * 1000;
const NOTIFICATIONS_API_BASE_URL = String(
  process.env.NOTIFICATIONS_API_URL || "https://centro-de-notificaciones-cariana.onrender.com",
).replace(/\/+$/, "");
const NOTIFICATIONS_API_KEY = String(process.env.NOTIFICATIONS_API_KEY || process.env.APP_INTERNAL_API_KEY || "").trim();
const STORE_CREDIT_NOTIFICATION_DELAY_MS = Number(process.env.STORE_CREDIT_NOTIFICATION_DELAY_MS || 60 * 1000);

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

async function scheduleStoreCreditNotification({
  shop,
  shopifyOrderId,
  orderNumber,
  shopifyCustomerId,
  customerEmail,
  amount,
  currencyCode,
  sourceKey,
  logger = console,
}) {
  if (!NOTIFICATIONS_API_BASE_URL || !shop || !shopifyCustomerId || roundMoney(amount) <= 0) return;

  const endpoint = `${NOTIFICATIONS_API_BASE_URL}/api/store-credit/events`;
  const headers = {
    "Content-Type": "application/json",
    "x-shop-domain": shop,
  };
  if (NOTIFICATIONS_API_KEY) {
    headers["x-api-key"] = NOTIFICATIONS_API_KEY;
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        shopDomain: shop,
        event: {
          sourceKey,
          shopifyCustomerId: legacyNumericId(shopifyCustomerId),
          customerEmail,
          orderId: legacyNumericId(shopifyOrderId) || shopifyOrderId,
          orderNumber,
          amount: roundMoney(amount),
          currencyCode,
          delayMs: Number.isFinite(STORE_CREDIT_NOTIFICATION_DELAY_MS)
            ? STORE_CREDIT_NOTIFICATION_DELAY_MS
            : 60 * 1000,
        },
      }),
    });
    const responsePayload = await response.json().catch(() => null);
    if (!response.ok || responsePayload?.ok === false) {
      logger.warn?.("No se pudo programar la notificacion de credito en tienda", {
        shop,
        shopifyOrderId,
        status: response.status,
        detail: responsePayload?.error || responsePayload?.detail || responsePayload?.result?.reason || "",
      });
    }
  } catch (error) {
    logger.warn?.("No se pudo programar la notificacion de credito en tienda", {
      shop,
      shopifyOrderId,
      error: error?.message || error,
    });
  }
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
    (sum, item) => sum + moneyNumber(item?.subtotal || item?.subtotal_set?.shop_money?.amount),
    0,
  );
  return {
    amount: roundMoney(subtotal),
    currencyCode: normalizeString(payload.currency || payload.presentment_currency || "MXN").toUpperCase(),
  };
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

  const sourceKey = `debit:${shopifyRefundId}`;
  const existing = await findReusableTransaction({ shop: normalizedShop, sourceKey });
  if (existing?.skip || existing?.status === "completed" || existing?.status === "pending_debit") {
    return { skipped: true, reason: "already_processed", transactionId: existing.id };
  }

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
  if (!ledger || ledger.creditedAmount <= 0) {
    return { skipped: true, reason: "order_without_credit" };
  }

  const refundLineSubtotal = refundNode?.refundLineItems?.nodes?.length
    ? refundNode.refundLineItems.nodes.reduce((sum, item) => sum + moneyFromSet(item?.subtotalSet).amount, 0)
    : refundSubtotalFromWebhook(payload).amount;
  const refundCurrency =
    refundNode?.refundLineItems?.nodes?.find((item) => moneyFromSet(item?.subtotalSet).currencyCode)?.subtotalSet ||
    refundNode?.totalRefundedSet;
  const currencyCode = moneyFromSet(refundCurrency).currencyCode || ledger.currencyCode;
  const refundableCredit = roundMoney(refundLineSubtotal * Number(ledger.creditRate || DEFAULT_REWARD_RATE));
  const remainingCreditedAmount = roundMoney(Number(ledger.creditedAmount || 0) - Number(ledger.debitedAmount || 0));
  const debitAmount = roundMoney(Math.min(refundableCredit, remainingCreditedAmount));
  if (debitAmount <= 0) return { skipped: true, reason: "nothing_to_debit" };

  const customerId = normalizeString(refundNode?.order?.customer?.id || ledger.shopifyCustomerId);
  if (!customerId) return { skipped: true, reason: "missing_customer" };

  const transaction = existing
    ? await prisma.storeCreditTransaction.update({
        where: { id: existing.id },
        data: {
          ledgerId: ledger.id,
          shopifyOrderId,
          shopifyRefundId,
          shopifyCustomerId: customerId,
          amount: debitAmount,
          currencyCode,
          status: "pending",
          errorCode: null,
          errorMessage: null,
          payload: compactRefundPayload(payload),
        },
      })
    : await prisma.storeCreditTransaction.create({
        data: {
          ledgerId: ledger.id,
          shop: normalizedShop,
          sourceKey,
          shopifyOrderId,
          shopifyRefundId,
          shopifyCustomerId: customerId,
          type: "debit",
          amount: debitAmount,
          currencyCode,
          status: "pending",
          payload: compactRefundPayload(payload),
        },
      });

  try {
    await debitStoreCreditAccount(admin, {
      customerId,
      amount: debitAmount,
      currencyCode,
    });
    const nextDebitedAmount = roundMoney(Number(ledger.debitedAmount || 0) + debitAmount);
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
        debitedAmount: { increment: debitAmount },
        status: nextDebitedAmount >= Number(ledger.creditedAmount || 0) ? "reversed" : "partially_debited",
      },
    });
    return { debited: true, amount: debitAmount, currencyCode };
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
    await prisma.storeCreditLedger.update({
      where: { id: ledger.id },
      data: {
        pendingDebitAmount: status === "pending_debit" ? { increment: debitAmount } : undefined,
        status: status === "pending_debit" ? "pending_debit" : "debit_failed",
      },
    });
    throw error;
  }
}
