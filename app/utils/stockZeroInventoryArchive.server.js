import prisma from "../db.server";

const STOCK_DRAFT_READY_STATUS = "listo";
const STOCK_WEBHOOKS = [
  {
    topic: "PRODUCTS_UPDATE",
    path: "/webhooks/products/update",
  },
  {
    topic: "INVENTORY_LEVELS_UPDATE",
    path: "/webhooks/inventory_levels/update",
  },
];

function cleanShopDomain(shop) {
  return String(shop || "").trim().toLowerCase();
}

function productSkus(product) {
  return [
    ...new Set(
      (product?.variants?.nodes || [])
        .map((variant) => String(variant?.sku || "").trim())
        .filter(Boolean),
    ),
  ];
}

function productIsActive(product) {
  const status = String(product?.status || "ACTIVE").trim().toUpperCase();
  return status === "ACTIVE";
}

async function adminGraphql(admin, query, variables = {}) {
  const response = await admin.graphql(query, { variables });
  const payload = await response.json();
  if (payload?.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).filter(Boolean).join(", "));
  }
  return payload?.data || {};
}

export async function archiveStockProductInShopify(admin, productId) {
  const data = await adminGraphql(
    admin,
    `#graphql
    mutation ArchiveStockProduct($product: ProductUpdateInput!) {
      productUpdate(product: $product) {
        product {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }`,
    { product: { id: productId, status: "ARCHIVED" } },
  );
  const errors = data?.productUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((error) => error.message).filter(Boolean).join(", ") || "No se pudo archivar el producto.");
  }
  return data?.productUpdate?.product || null;
}

async function releaseStockLocationsForProduct(shop, product) {
  const skus = productSkus(product);
  if (!skus.length) return 0;
  const result = await prisma.stockProductDraft.updateMany({
    where: {
      shop: cleanShopDomain(shop),
      status: STOCK_DRAFT_READY_STATUS,
      locationReleasedAt: null,
      sku: { in: skus },
    },
    data: { locationReleasedAt: new Date() },
  });
  return Number(result?.count || 0);
}

export async function archiveProductIfInventoryIsZero({ admin, shop, product }) {
  if (!admin || !product?.id || !productIsActive(product)) {
    return { archived: false, releasedLocations: 0 };
  }
  const totalInventory = Number(product.totalInventory || 0);
  if (!Number.isFinite(totalInventory) || totalInventory > 0) {
    return { archived: false, releasedLocations: 0 };
  }

  await archiveStockProductInShopify(admin, product.id);
  const releasedLocations = await releaseStockLocationsForProduct(shop, product);
  return { archived: true, releasedLocations };
}

export async function fetchShopifyProductById(admin, productId) {
  const id = String(productId || "").trim();
  if (!id) return null;
  const data = await adminGraphql(
    admin,
    `#graphql
    query StockProductById($id: ID!) {
      product(id: $id) {
        id
        title
        status
        totalInventory
        variants(first: 100) {
          nodes {
            sku
          }
        }
      }
    }`,
    { id },
  );
  return data?.product || null;
}

export async function fetchShopifyProductByInventoryItemId(admin, inventoryItemId) {
  const rawId = String(inventoryItemId || "").trim();
  if (!rawId) return null;
  const id = rawId.startsWith("gid://shopify/InventoryItem/")
    ? rawId
    : `gid://shopify/InventoryItem/${rawId}`;
  const data = await adminGraphql(
    admin,
    `#graphql
    query StockProductByInventoryItem($id: ID!) {
      inventoryItem(id: $id) {
        id
        variant {
          product {
            id
            title
            status
            totalInventory
            variants(first: 100) {
              nodes {
                sku
              }
            }
          }
        }
      }
    }`,
    { id },
  );
  return data?.inventoryItem?.variant?.product || null;
}

export async function archiveZeroInventoryProductById({ admin, shop, productId }) {
  const product = await fetchShopifyProductById(admin, productId);
  if (!product) return { archived: false, releasedLocations: 0 };
  return archiveProductIfInventoryIsZero({ admin, shop, product });
}

export async function archiveZeroInventoryProductByInventoryItemId({ admin, shop, inventoryItemId }) {
  const product = await fetchShopifyProductByInventoryItemId(admin, inventoryItemId);
  if (!product) return { archived: false, releasedLocations: 0 };
  return archiveProductIfInventoryIsZero({ admin, shop, product });
}

export async function archiveAllZeroInventoryProducts({ admin, shop }) {
  const data = await adminGraphql(
    admin,
    `#graphql
    query StockZeroInventoryProducts($query: String!) {
      products(first: 100, query: $query) {
        nodes {
          id
          title
          status
          totalInventory
          variants(first: 100) {
            nodes {
              sku
            }
          }
        }
      }
    }`,
    { query: "status:active inventory_total:0" },
  );
  const products = data?.products?.nodes || [];
  const archivedProducts = [];
  for (const product of products) {
    try {
      const result = await archiveProductIfInventoryIsZero({ admin, shop, product });
      if (result.archived) {
        archivedProducts.push({
          id: product.id,
          title: product.title || "",
          releasedLocations: result.releasedLocations,
        });
      }
    } catch (error) {
      console.error("No se pudo archivar producto agotado de Shopify", {
        shop,
        productId: product?.id || "",
        title: product?.title || "",
        error,
      });
    }
  }
  return archivedProducts;
}

export async function ensureStockInventoryArchiveWebhooks(admin) {
  const appUrl = String(process.env.SHOPIFY_APP_URL || "").replace(/\/+$/, "");
  if (!admin || !appUrl) return;

  const data = await adminGraphql(
    admin,
    `#graphql
    query StockWebhookSubscriptions {
      webhookSubscriptions(first: 100) {
        nodes {
          id
          topic
          endpoint {
            __typename
            ... on WebhookHttpEndpoint {
              callbackUrl
            }
          }
        }
      }
    }`,
  );
  const existingWebhooks = data?.webhookSubscriptions?.nodes || [];

  for (const webhook of STOCK_WEBHOOKS) {
    const callbackUrl = `${appUrl}${webhook.path}`;
    const alreadyRegistered = existingWebhooks.some(
      (node) =>
        String(node?.topic || "") === webhook.topic &&
        String(node?.endpoint?.callbackUrl || "").replace(/\/+$/, "") === callbackUrl,
    );
    if (alreadyRegistered) continue;

    const created = await adminGraphql(
      admin,
      `#graphql
      mutation StockWebhookSubscriptionCreate(
        $topic: WebhookSubscriptionTopic!
        $webhookSubscription: WebhookSubscriptionInput!
      ) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
          webhookSubscription {
            id
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        topic: webhook.topic,
        webhookSubscription: {
          callbackUrl,
          format: "JSON",
        },
      },
    );
    const errors = created?.webhookSubscriptionCreate?.userErrors || [];
    if (errors.length) {
      console.error("No se pudo registrar webhook de stock", {
        topic: webhook.topic,
        callbackUrl,
        errors,
      });
    }
  }
}
