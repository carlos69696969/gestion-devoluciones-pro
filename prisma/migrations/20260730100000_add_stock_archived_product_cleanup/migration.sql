ALTER TABLE "ReturnSettings"
ADD COLUMN IF NOT EXISTS "stockArchivedProductCleanupDays" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "StockArchivedProduct" (
  "id" SERIAL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "title" TEXT,
  "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "StockArchivedProduct_shop_productId_key"
ON "StockArchivedProduct"("shop", "productId");

CREATE INDEX IF NOT EXISTS "StockArchivedProduct_shop_archivedAt_idx"
ON "StockArchivedProduct"("shop", "archivedAt");

CREATE INDEX IF NOT EXISTS "StockArchivedProduct_shop_deletedAt_idx"
ON "StockArchivedProduct"("shop", "deletedAt");
