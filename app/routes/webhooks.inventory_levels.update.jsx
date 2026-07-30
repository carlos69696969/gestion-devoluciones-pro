import { authenticate } from "../shopify.server";
import {
  archiveAllZeroInventoryProducts,
  archiveZeroInventoryProductByInventoryItemId,
} from "../utils/stockZeroInventoryArchive.server";

export const action = async ({ request }) => {
  const { admin, payload, shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!admin) return new Response();

  const inventoryItemId = payload?.inventory_item_id || payload?.inventory_item_gid || payload?.admin_graphql_api_id;
  if (inventoryItemId) {
    await archiveZeroInventoryProductByInventoryItemId({ admin, shop, inventoryItemId }).catch((error) => {
      console.error("No se pudo archivar producto desde inventory_levels/update", {
        shop,
        inventoryItemId,
        error,
      });
    });
  }

  await archiveAllZeroInventoryProducts({ admin, shop }).catch((error) => {
    console.error("No se pudo sincronizar productos agotados desde inventory_levels/update", {
      shop,
      error,
    });
  });

  return new Response();
};
