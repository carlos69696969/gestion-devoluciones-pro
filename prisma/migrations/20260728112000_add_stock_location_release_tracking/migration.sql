ALTER TABLE "StockProductDraft"
  ADD COLUMN IF NOT EXISTS "locationReleasedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "locationReusedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "StockProductDraft_shop_locationReleasedAt_idx"
  ON "StockProductDraft"("shop", "locationReleasedAt");
