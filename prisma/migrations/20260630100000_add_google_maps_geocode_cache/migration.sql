CREATE TABLE "GoogleMapsGeocodeCache" (
  "id" SERIAL NOT NULL,
  "shop" TEXT NOT NULL,
  "addressKey" TEXT NOT NULL,
  "address" TEXT NOT NULL,
  "formattedAddress" TEXT,
  "latitude" DOUBLE PRECISION NOT NULL,
  "longitude" DOUBLE PRECISION NOT NULL,
  "placeId" TEXT,
  "source" TEXT NOT NULL DEFAULT 'google',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GoogleMapsGeocodeCache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GoogleMapsGeocodeCache_shop_addressKey_key"
ON "GoogleMapsGeocodeCache"("shop", "addressKey");

CREATE INDEX "GoogleMapsGeocodeCache_shop_updatedAt_idx"
ON "GoogleMapsGeocodeCache"("shop", "updatedAt");
