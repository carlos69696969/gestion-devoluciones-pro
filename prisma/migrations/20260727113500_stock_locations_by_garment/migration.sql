ALTER TABLE "StockLocationState"
  ADD COLUMN IF NOT EXISTS "garmentType" TEXT NOT NULL DEFAULT 'general';

DROP INDEX IF EXISTS "StockLocationState_shop_audience_key";

CREATE UNIQUE INDEX IF NOT EXISTS "StockLocationState_shop_audience_garmentType_key"
  ON "StockLocationState"("shop", "audience", "garmentType");
