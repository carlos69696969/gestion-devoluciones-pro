import { authenticate } from "../shopify.server";
import { processPaidOrderStoreCreditReward } from "../utils/storeCreditRewards.server";

export const action = async ({ request }) => {
  const { admin, payload, shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!admin) return new Response();

  await processPaidOrderStoreCreditReward({ admin, shop, payload }).catch((error) => {
    console.error("No se pudo acreditar credito en tienda desde orders/paid", {
      shop,
      orderId: payload?.admin_graphql_api_id || payload?.id,
      error: error?.message || error,
    });
  });

  return new Response();
};
