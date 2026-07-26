ALTER TABLE "StockProductDraft"
  ADD COLUMN IF NOT EXISTS "audience" TEXT,
  ADD COLUMN IF NOT EXISTS "garmentType" TEXT,
  ADD COLUMN IF NOT EXISTS "locationCode" TEXT;

CREATE INDEX IF NOT EXISTS "StockProductDraft_shop_audience_garmentType_idx"
  ON "StockProductDraft"("shop", "audience", "garmentType");

CREATE INDEX IF NOT EXISTS "StockProductDraft_shop_locationCode_idx"
  ON "StockProductDraft"("shop", "locationCode");

CREATE TABLE IF NOT EXISTS "StockLocationState" (
  "id" SERIAL NOT NULL,
  "shop" TEXT NOT NULL,
  "audience" TEXT NOT NULL,
  "currentLocation" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StockLocationState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StockLocationState_shop_audience_key"
  ON "StockLocationState"("shop", "audience");

CREATE INDEX IF NOT EXISTS "StockLocationState_shop_currentLocation_idx"
  ON "StockLocationState"("shop", "currentLocation");
