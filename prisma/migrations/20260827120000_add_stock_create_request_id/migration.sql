ALTER TABLE "StockProductDraft"
  ADD COLUMN IF NOT EXISTS "createRequestId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "StockProductDraft_shop_createRequestId_key"
  ON "StockProductDraft"("shop", "createRequestId");
