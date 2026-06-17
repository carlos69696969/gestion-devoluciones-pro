CREATE TABLE "CourierRouteSnapshot" (
  "id" SERIAL NOT NULL,
  "shop" TEXT NOT NULL,
  "courierId" INTEGER NOT NULL,
  "courierName" TEXT NOT NULL,
  "routeId" TEXT NOT NULL,
  "dateKey" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "orders" JSONB NOT NULL,
  "remainingCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CourierRouteSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CourierRouteSnapshot_shop_routeId_key"
ON "CourierRouteSnapshot"("shop", "routeId");

CREATE INDEX "CourierRouteSnapshot_shop_courierId_finishedAt_idx"
ON "CourierRouteSnapshot"("shop", "courierId", "finishedAt");

CREATE INDEX "CourierRouteSnapshot_shop_courierId_dateKey_idx"
ON "CourierRouteSnapshot"("shop", "courierId", "dateKey");
