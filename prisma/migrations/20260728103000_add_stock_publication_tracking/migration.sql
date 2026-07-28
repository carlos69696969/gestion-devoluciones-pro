ALTER TABLE "StockProductDraft"
  ADD COLUMN IF NOT EXISTS "preparedByStockUserId" INTEGER,
  ADD COLUMN IF NOT EXISTS "publishedByStockUserId" INTEGER,
  ADD COLUMN IF NOT EXISTS "publishedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "StockProductDraft_shop_publishedAt_idx"
  ON "StockProductDraft"("shop", "publishedAt");

CREATE INDEX IF NOT EXISTS "StockProductDraft_preparedByStockUserId_idx"
  ON "StockProductDraft"("preparedByStockUserId");

CREATE INDEX IF NOT EXISTS "StockProductDraft_publishedByStockUserId_idx"
  ON "StockProductDraft"("publishedByStockUserId");

ALTER TABLE "StockProductDraft"
  ADD CONSTRAINT "StockProductDraft_preparedByStockUserId_fkey"
  FOREIGN KEY ("preparedByStockUserId") REFERENCES "StockUser"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "StockProductDraft"
  ADD CONSTRAINT "StockProductDraft_publishedByStockUserId_fkey"
  FOREIGN KEY ("publishedByStockUserId") REFERENCES "StockUser"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
