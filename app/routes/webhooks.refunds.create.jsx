import { authenticate } from "../shopify.server";
import { processRefundStoreCreditDebit } from "../utils/storeCreditRewards.server";

export const action = async ({ request }) => {
  const { admin, payload, shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!admin) return new Response();

  const result = await processRefundStoreCreditDebit({ admin, shop, payload }).catch((error) => {
    console.error("No se pudo debitar credito en tienda desde refunds/create", {
      shop,
      refundId: payload?.admin_graphql_api_id || payload?.id,
      orderId: payload?.order_id,
      error: error?.message || error,
    });
    return { failed: true, error: error?.message || String(error) };
  });
  if (result?.skipped) {
    console.warn("Debito de credito en tienda omitido desde refunds/create", {
      shop,
      refundId: payload?.admin_graphql_api_id || payload?.id,
      orderId: payload?.order_id,
      reason: result.reason,
      transactionId: result.transactionId,
    });
  } else if (result?.debited) {
    console.log("Credito en tienda debitado desde refunds/create", {
      shop,
      refundId: payload?.admin_graphql_api_id || payload?.id,
      orderId: payload?.order_id,
      amount: result.amount,
      currencyCode: result.currencyCode,
    });
  }

  return new Response();
};
