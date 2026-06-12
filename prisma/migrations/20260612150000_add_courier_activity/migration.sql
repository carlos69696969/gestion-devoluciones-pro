CREATE TABLE "CourierActivity" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "courierId" INTEGER NOT NULL,
    "courierName" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "orderNumber" TEXT,
    "action" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourierActivity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CourierActivity_shop_courierId_createdAt_idx" ON "CourierActivity"("shop", "courierId", "createdAt");
CREATE INDEX "CourierActivity_shop_requestId_createdAt_idx" ON "CourierActivity"("shop", "requestId", "createdAt");
