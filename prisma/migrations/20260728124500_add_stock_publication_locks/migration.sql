ALTER TABLE "StockProductDraft"
  ADD COLUMN IF NOT EXISTS "publishingLockedByStockUserId" INTEGER,
  ADD COLUMN IF NOT EXISTS "publishingLockedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "StockProductDraft_shop_publishingLockedAt_idx"
  ON "StockProductDraft"("shop", "publishingLockedAt");
