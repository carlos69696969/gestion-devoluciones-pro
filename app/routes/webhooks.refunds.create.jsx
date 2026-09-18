import { authenticate } from "../shopify.server";
import { processRefundStoreCreditDebit } from "../utils/storeCreditRewards.server";

export const action = async ({ request }) => {
  const { admin, payload, shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!admin) return new Response();

  await processRefundStoreCreditDebit({ admin, shop, payload }).catch((error) => {
    console.error("No se pudo debitar credito en tienda desde refunds/create", {
      shop,
      refundId: payload?.admin_graphql_api_id || payload?.id,
      orderId: payload?.order_id,
      error: error?.message || error,
    });
  });

  return new Response();
};
