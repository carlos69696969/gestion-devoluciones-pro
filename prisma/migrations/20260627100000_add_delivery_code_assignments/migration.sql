CREATE TABLE "DeliveryCodeAssignment" (
  "id" SERIAL NOT NULL,
  "shop" TEXT NOT NULL,
  "shopifyOrderId" TEXT NOT NULL,
  "orderNumber" TEXT NOT NULL,
  "code" TEXT,
  "historicalCode" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "releasedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeliveryCodeAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DeliveryCodeAssignment_code_key"
ON "DeliveryCodeAssignment"("code");

CREATE UNIQUE INDEX "DeliveryCodeAssignment_shop_shopifyOrderId_key"
ON "DeliveryCodeAssignment"("shop", "shopifyOrderId");

CREATE INDEX "DeliveryCodeAssignment_shop_active_idx"
ON "DeliveryCodeAssignment"("shop", "active");

CREATE INDEX "DeliveryCodeAssignment_shop_orderNumber_idx"
ON "DeliveryCodeAssignment"("shop", "orderNumber");
