import prisma from "../db.server";
import {
  normalizeFinancePriceSettings,
} from "./financePrice.shared";

const FINANCE_PRICE_STORAGE_FLAG = "__carianaFinancePriceSettingsStorageReady";

function cleanShop(value) {
  return String(value || "").trim().toLowerCase();
}

export async function ensureFinancePriceSettingsStorage() {
  if (globalThis[FINANCE_PRICE_STORAGE_FLAG]) return;
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "ReturnSettings" ADD COLUMN IF NOT EXISTS "financeProfitPercent" DOUBLE PRECISION NOT NULL DEFAULT 50`,
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "ReturnSettings" ADD COLUMN IF NOT EXISTS "financeTaxPercent" DOUBLE PRECISION NOT NULL DEFAULT 10`,
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "ReturnSettings" ADD COLUMN IF NOT EXISTS "financeShopifyCommission" DOUBLE PRECISION NOT NULL DEFAULT 3`,
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "ReturnSettings" ADD COLUMN IF NOT EXISTS "financeOperationalCost" DOUBLE PRECISION NOT NULL DEFAULT 15`,
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "ReturnSettings" ADD COLUMN IF NOT EXISTS "financeTransactionPercent" DOUBLE PRECISION NOT NULL DEFAULT 3`,
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "ReturnSettings" ADD COLUMN IF NOT EXISTS "financeHighProfitThreshold" DOUBLE PRECISION NOT NULL DEFAULT 750`,
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "ReturnSettings" ADD COLUMN IF NOT EXISTS "financeHighProfitPercent" DOUBLE PRECISION NOT NULL DEFAULT 40`,
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "ReturnSettings" ADD COLUMN IF NOT EXISTS "financeVeryHighProfitThreshold" DOUBLE PRECISION NOT NULL DEFAULT 1000`,
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "ReturnSettings" ADD COLUMN IF NOT EXISTS "financeVeryHighProfitPercent" DOUBLE PRECISION NOT NULL DEFAULT 35`,
  );
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "FinancePriceSettingsVersion" (
      "id" SERIAL PRIMARY KEY,
      "shop" TEXT NOT NULL,
      "profitPercent" DOUBLE PRECISION NOT NULL DEFAULT 50,
      "taxPercent" DOUBLE PRECISION NOT NULL DEFAULT 10,
      "shopifyCommission" DOUBLE PRECISION NOT NULL DEFAULT 3,
      "operationalCost" DOUBLE PRECISION NOT NULL DEFAULT 15,
      "transactionPercent" DOUBLE PRECISION NOT NULL DEFAULT 3,
      "highProfitThreshold" DOUBLE PRECISION NOT NULL DEFAULT 750,
      "highProfitPercent" DOUBLE PRECISION NOT NULL DEFAULT 40,
      "veryHighProfitThreshold" DOUBLE PRECISION NOT NULL DEFAULT 1000,
      "veryHighProfitPercent" DOUBLE PRECISION NOT NULL DEFAULT 35,
      "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "FinancePriceSettingsVersion" ADD COLUMN IF NOT EXISTS "highProfitThreshold" DOUBLE PRECISION NOT NULL DEFAULT 750`,
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "FinancePriceSettingsVersion" ADD COLUMN IF NOT EXISTS "highProfitPercent" DOUBLE PRECISION NOT NULL DEFAULT 40`,
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "FinancePriceSettingsVersion" ADD COLUMN IF NOT EXISTS "veryHighProfitThreshold" DOUBLE PRECISION NOT NULL DEFAULT 1000`,
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "FinancePriceSettingsVersion" ADD COLUMN IF NOT EXISTS "veryHighProfitPercent" DOUBLE PRECISION NOT NULL DEFAULT 35`,
  );
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "FinancePriceSettingsVersion_shop_effectiveAt_idx"
    ON "FinancePriceSettingsVersion"("shop", "effectiveAt")
  `);
  globalThis[FINANCE_PRICE_STORAGE_FLAG] = true;
}

export async function saveFinancePriceSettingsVersion({ shop, settings }) {
  const cleanShopDomain = cleanShop(shop);
  if (!cleanShopDomain) return null;
  const cleanSettings = normalizeFinancePriceSettings(settings);
  const effectiveAt = new Date();
  await ensureFinancePriceSettingsStorage();
  await prisma.returnSettings.upsert({
    where: { shop: cleanShopDomain },
    update: {
      financeProfitPercent: cleanSettings.profitPercent,
      financeTaxPercent: cleanSettings.taxPercent,
      financeShopifyCommission: cleanSettings.shopifyCommission,
      financeOperationalCost: cleanSettings.operationalCost,
      financeTransactionPercent: cleanSettings.transactionPercent,
      financeHighProfitThreshold: cleanSettings.highProfitThreshold,
      financeHighProfitPercent: cleanSettings.highProfitPercent,
      financeVeryHighProfitThreshold: cleanSettings.veryHighProfitThreshold,
      financeVeryHighProfitPercent: cleanSettings.veryHighProfitPercent,
    },
    create: {
      shop: cleanShopDomain,
      financeProfitPercent: cleanSettings.profitPercent,
      financeTaxPercent: cleanSettings.taxPercent,
      financeShopifyCommission: cleanSettings.shopifyCommission,
      financeOperationalCost: cleanSettings.operationalCost,
      financeTransactionPercent: cleanSettings.transactionPercent,
      financeHighProfitThreshold: cleanSettings.highProfitThreshold,
      financeHighProfitPercent: cleanSettings.highProfitPercent,
      financeVeryHighProfitThreshold: cleanSettings.veryHighProfitThreshold,
      financeVeryHighProfitPercent: cleanSettings.veryHighProfitPercent,
    },
  });
  return prisma.financePriceSettingsVersion.create({
    data: {
      shop: cleanShopDomain,
      ...cleanSettings,
      effectiveAt,
    },
  });
}

export async function loadFinancePriceSettingsTimeline({ shop, end } = {}) {
  const cleanShopDomain = cleanShop(shop);
  if (!cleanShopDomain) return [];
  await ensureFinancePriceSettingsStorage();
  const endDate = end instanceof Date ? end : new Date(end || Date.now());
  const cleanEnd = Number.isFinite(endDate.getTime()) ? endDate : new Date();
  const rows = await prisma.financePriceSettingsVersion.findMany({
    where: {
      shop: cleanShopDomain,
      effectiveAt: { lt: cleanEnd },
    },
    orderBy: [{ effectiveAt: "asc" }, { id: "asc" }],
  });
  return rows.map((row) => ({
    ...normalizeFinancePriceSettings(row),
    effectiveAt: row.effectiveAt.toISOString(),
  }));
}
