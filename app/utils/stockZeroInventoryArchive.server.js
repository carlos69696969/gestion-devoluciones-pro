import prisma from "../db.server";

const STOCK_DRAFT_READY_STATUS = "listo";
const STOCK_ARCHIVE_STORAGE_FLAG = "__carianaStockArchiveCleanupStorageReady";
const STOCK_WEBHOOKS = [
  {
    topic: "PRODUCTS_UPDATE",
    path: "/webhooks/products/update",
  },
  {
    topic: "PRODUCTS_DELETE",
    path: "/webhooks/products/delete",
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

function normalizeArchivedProductSkus(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((sku) => String(sku || "").trim()).filter(Boolean))];
  }
  if (typeof value === "string") {
    try {
      return normalizeArchivedProductSkus(JSON.parse(value));
    } catch (_error) {
      return value
        .split(/[\n,]/)
        .map((sku) => sku.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function productIsActive(product) {
  const status = String(product?.status || "ACTIVE").trim().toUpperCase();
  return status === "ACTIVE";
}

function productIsArchived(product) {
  const status = String(product?.status || "").trim().toUpperCase();
  return status === "ARCHIVED";
}

function cutoffDateFromDays(days) {
  const at = new Date();
  at.setHours(0, 0, 0, 0);
  at.setDate(at.getDate() - days);
  return at;
}

export function normalizeStockArchivedProductCleanupDays(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const rounded = Math.floor(parsed);
  if (rounded <= 0) return 0;
  if (rounded > 5000) return 5000;
  return rounded;
}

export async function ensureStockArchivedProductCleanupStorage() {
  if (globalThis[STOCK_ARCHIVE_STORAGE_FLAG]) return;
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "ReturnSettings"
    ADD COLUMN IF NOT EXISTS "stockArchivedProductCleanupDays" INTEGER NOT NULL DEFAULT 0
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "StockArchivedProduct" (
      "id" SERIAL PRIMARY KEY,
      "shop" TEXT NOT NULL,
      "productId" TEXT NOT NULL,
      "title" TEXT,
      "skus" JSONB NOT NULL DEFAULT '[]',
      "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "deletedAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "StockArchivedProduct"
    ADD COLUMN IF NOT EXISTS "skus" JSONB NOT NULL DEFAULT '[]'
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "StockArchivedProduct_shop_productId_key"
    ON "StockArchivedProduct"("shop", "productId")
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "StockArchivedProduct_shop_archivedAt_idx"
    ON "StockArchivedProduct"("shop", "archivedAt")
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "StockArchivedProduct_shop_deletedAt_idx"
    ON "StockArchivedProduct"("shop", "deletedAt")
  `);
  globalThis[STOCK_ARCHIVE_STORAGE_FLAG] = true;
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

export async function recordArchivedStockProduct({ shop, product }) {
  const cleanShop = cleanShopDomain(shop);
  const productId = String(product?.id || "").trim();
  if (!cleanShop || !productId) return null;
  await ensureStockArchivedProductCleanupStorage();
  const existing = await prisma.stockArchivedProduct.findUnique({
    where: { shop_productId: { shop: cleanShop, productId } },
    select: { id: true, deletedAt: true },
  });
  const title = String(product?.title || "").trim() || null;
  const skus = productSkus(product);
  if (existing) {
    return prisma.stockArchivedProduct.update({
      where: { id: existing.id },
      data: existing.deletedAt
        ? { title, skus, archivedAt: new Date(), deletedAt: null }
        : { title, skus },
    });
  }
  return prisma.stockArchivedProduct.create({
    data: {
      shop: cleanShop,
      productId,
      title,
      skus,
    },
  });
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
  await recordArchivedStockProduct({ shop, product });
  const releasedLocations = await releaseStockLocationsForProduct(shop, product);
  return { archived: true, releasedLocations };
}

async function fetchArchivedProductForDeletion(graphqlRequest, productId) {
  const data = await graphqlRequest(
    `#graphql
    query StockArchivedProductForDeletion($id: ID!) {
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
    { id: productId },
  );
  return data?.product || null;
}

async function deleteArchivedProductInShopify(graphqlRequest, productId) {
  const data = await graphqlRequest(
    `#graphql
    mutation DeleteArchivedStockProduct($input: ProductDeleteInput!) {
      productDelete(input: $input) {
        deletedProductId
        userErrors {
          field
          message
        }
      }
    }`,
    { input: { id: productId } },
  );
  const errors = data?.productDelete?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((error) => error.message).filter(Boolean).join(", ") || "No se pudo borrar el producto archivado.");
  }
  return data?.productDelete?.deletedProductId || productId;
}

async function deleteStockHistoryForSkus(shop, skus) {
  const cleanShop = cleanShopDomain(shop);
  const cleanSkus = normalizeArchivedProductSkus(skus);
  if (!cleanShop || !cleanSkus.length) return 0;
  const result = await prisma.stockProductDraft.deleteMany({
    where: {
      shop: cleanShop,
      status: STOCK_DRAFT_READY_STATUS,
      locationReleasedAt: { not: null },
      sku: { in: cleanSkus },
    },
  });
  return Number(result?.count || 0);
}

function stockSkuSearchTerm(sku) {
  const cleanSku = String(sku || "").trim();
  if (!cleanSku) return "";
  if (/^[A-Za-z0-9_:-]+$/.test(cleanSku)) return `sku:${cleanSku}`;
  return `sku:"${cleanSku.replace(/["\\]/g, "\\$&")}"`;
}

async function fetchExistingStockSkus(admin, skus) {
  const cleanSkus = normalizeArchivedProductSkus(skus);
  if (!admin || !cleanSkus.length) return new Set(cleanSkus.map((sku) => sku.toLowerCase()));

  const foundSkus = new Set();
  for (let index = 0; index < cleanSkus.length; index += 20) {
    const chunk = cleanSkus.slice(index, index + 20);
    const query = chunk.map(stockSkuSearchTerm).filter(Boolean).join(" OR ");
    if (!query) continue;
    const data = await adminGraphql(
      admin,
      `#graphql
      query ExistingStockSkus($query: String!) {
        productVariants(first: 250, query: $query) {
          nodes {
            sku
          }
        }
      }`,
      { query },
    );
    for (const variant of data?.productVariants?.nodes || []) {
      const sku = String(variant?.sku || "").trim();
      if (sku) foundSkus.add(sku.toLowerCase());
    }
  }
  return foundSkus;
}

export async function deleteStockHistoryForDeletedProduct({
  shop,
  productId,
  skus = [],
}) {
  const cleanShop = cleanShopDomain(shop);
  const cleanProductId = String(productId || "").trim();
  if (!cleanShop) return { deletedStockHistoryRecords: 0, skus: [] };
  await ensureStockArchivedProductCleanupStorage();

  const archivedProduct = cleanProductId
    ? await prisma.stockArchivedProduct.findUnique({
        where: { shop_productId: { shop: cleanShop, productId: cleanProductId } },
        select: { id: true, skus: true },
      })
    : null;
  const cleanSkus = normalizeArchivedProductSkus(
    skus.length ? skus : archivedProduct?.skus,
  );
  const deletedStockHistoryRecords = await deleteStockHistoryForSkus(
    cleanShop,
    cleanSkus,
  );

  if (archivedProduct) {
    await prisma.stockArchivedProduct.update({
      where: { id: archivedProduct.id },
      data: { skus: cleanSkus, deletedAt: new Date() },
    });
  }

  return { deletedStockHistoryRecords, skus: cleanSkus };
}

export async function deleteMissingShopifyStockHistory({
  admin,
  shop,
  drafts = [],
}) {
  const cleanShop = cleanShopDomain(shop);
  const candidateSkus = normalizeArchivedProductSkus(
    drafts
      .filter((draft) => draft?.locationReleasedAt)
      .map((draft) => draft?.sku),
  );
  if (!admin || !cleanShop || !candidateSkus.length) {
    return { deletedStockHistoryRecords: 0, skus: [] };
  }

  let existingSkus;
  try {
    existingSkus = await fetchExistingStockSkus(admin, candidateSkus);
  } catch (error) {
    console.error("No se pudo verificar historial de stock contra Shopify", {
      shop: cleanShop,
      error,
    });
    return { deletedStockHistoryRecords: 0, skus: [] };
  }

  const missingSkus = candidateSkus.filter(
    (sku) => !existingSkus.has(String(sku || "").trim().toLowerCase()),
  );
  if (!missingSkus.length) return { deletedStockHistoryRecords: 0, skus: [] };

  const deletedStockHistoryRecords = await deleteStockHistoryForSkus(
    cleanShop,
    missingSkus,
  );
  return { deletedStockHistoryRecords, skus: missingSkus };
}

export async function deleteExpiredArchivedStockProducts({
  shop,
  cleanupDays,
  batchSize = 50,
  graphqlRequest,
}) {
  const cleanShop = cleanShopDomain(shop);
  const days = normalizeStockArchivedProductCleanupDays(cleanupDays);
  if (!cleanShop || !days) {
    return { disabled: true, candidates: 0, deletedProducts: 0, skippedProducts: 0, deletedStockHistoryRecords: 0 };
  }
  await ensureStockArchivedProductCleanupStorage();
  const cutoff = cutoffDateFromDays(days);
  const rows = await prisma.stockArchivedProduct.findMany({
    where: {
      shop: cleanShop,
      deletedAt: null,
      archivedAt: { lt: cutoff },
    },
    select: { id: true, productId: true, title: true, skus: true, archivedAt: true },
    orderBy: [{ archivedAt: "asc" }, { id: "asc" }],
    take: Math.max(1, Math.min(Number(batchSize) || 50, 500)),
  });
  if (!rows.length) {
    return { disabled: false, candidates: 0, deletedProducts: 0, skippedProducts: 0, deletedStockHistoryRecords: 0 };
  }
  if (typeof graphqlRequest !== "function") {
    return { disabled: false, candidates: rows.length, deletedProducts: 0, skippedProducts: rows.length, deletedStockHistoryRecords: 0 };
  }

  let deletedProducts = 0;
  let skippedProducts = 0;
  let deletedStockHistoryRecords = 0;
  for (const row of rows) {
    try {
      const product = await fetchArchivedProductForDeletion(graphqlRequest, row.productId);
      const skus = product ? productSkus(product) : normalizeArchivedProductSkus(row.skus);
      if (!product) {
        await prisma.stockArchivedProduct.update({
          where: { id: row.id },
          data: { deletedAt: new Date() },
        });
        deletedStockHistoryRecords += await deleteStockHistoryForSkus(cleanShop, skus);
        deletedProducts += 1;
        continue;
      }
      const totalInventory = Number(product.totalInventory || 0);
      if (!productIsArchived(product) || (Number.isFinite(totalInventory) && totalInventory > 0)) {
        await prisma.stockArchivedProduct.delete({ where: { id: row.id } });
        skippedProducts += 1;
        continue;
      }
      await deleteArchivedProductInShopify(graphqlRequest, row.productId);
      await prisma.stockArchivedProduct.update({
        where: { id: row.id },
        data: { skus, deletedAt: new Date() },
      });
      deletedStockHistoryRecords += await deleteStockHistoryForSkus(cleanShop, skus);
      deletedProducts += 1;
    } catch (error) {
      skippedProducts += 1;
      console.error("No se pudo borrar producto archivado de Shopify", {
        shop: cleanShop,
        productId: row.productId,
        title: row.title || "",
        error,
      });
    }
  }
  return { disabled: false, candidates: rows.length, deletedProducts, skippedProducts, deletedStockHistoryRecords };
}

export async function deleteExpiredArchivedStockProductsFromAdmin({
  admin,
  shop,
  cleanupDays,
  batchSize,
}) {
  if (!admin) return { disabled: true, candidates: 0, deletedProducts: 0, skippedProducts: 0 };
  return deleteExpiredArchivedStockProducts({
    shop,
    cleanupDays,
    batchSize,
    graphqlRequest: (query, variables) => adminGraphql(admin, query, variables),
  });
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
