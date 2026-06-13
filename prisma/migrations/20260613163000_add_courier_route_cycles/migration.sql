ALTER TABLE "CourierActivity" ADD COLUMN "routeId" TEXT;

CREATE INDEX "CourierActivity_shop_courierId_routeId_createdAt_idx"
ON "CourierActivity"("shop", "courierId", "routeId", "createdAt");
