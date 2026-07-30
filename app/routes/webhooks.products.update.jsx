import { authenticate } from "../shopify.server";
import {
  archiveAllZeroInventoryProducts,
  archiveZeroInventoryProductById,
} from "../utils/stockZeroInventoryArchive.server";

export const action = async ({ request }) => {
  const { admin, payload, shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!admin) return new Response();

  const productId = payload?.admin_graphql_api_id || (payload?.id ? `gid://shopify/Product/${payload.id}` : "");
  if (productId) {
    await archiveZeroInventoryProductById({ admin, shop, productId }).catch((error) => {
      console.error("No se pudo archivar producto desde products/update", {
        shop,
        productId,
        error,
      });
    });
  }

  await archiveAllZeroInventoryProducts({ admin, shop }).catch((error) => {
    console.error("No se pudo sincronizar productos agotados desde products/update", {
      shop,
      error,
    });
  });

  return new Response();
};
