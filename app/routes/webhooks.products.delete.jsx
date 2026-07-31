import { authenticate } from "../shopify.server";
import { deleteStockHistoryForDeletedProduct } from "../utils/stockZeroInventoryArchive.server";

export const action = async ({ request }) => {
  const { payload, shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const productId = payload?.admin_graphql_api_id || (payload?.id ? `gid://shopify/Product/${payload.id}` : "");
  const skus = (payload?.variants || [])
    .map((variant) => String(variant?.sku || "").trim())
    .filter(Boolean);

  await deleteStockHistoryForDeletedProduct({ shop, productId, skus }).catch((error) => {
    console.error("No se pudo borrar historial de stock desde products/delete", {
      shop,
      productId,
      error,
    });
  });

  return new Response();
};
