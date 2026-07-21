CREATE TABLE "CourierHistoryPurge" (
  "id" SERIAL NOT NULL,
  "shop" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "orderNumber" TEXT,
  "cutoffAt" TIMESTAMP(3) NOT NULL,
  "purgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CourierHistoryPurge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CourierHistoryPurge_shop_requestId_key"
ON "CourierHistoryPurge"("shop", "requestId");

CREATE INDEX "CourierHistoryPurge_shop_purgedAt_idx"
ON "CourierHistoryPurge"("shop", "purgedAt");

CREATE INDEX "CourierHistoryPurge_shop_cutoffAt_idx"
ON "CourierHistoryPurge"("shop", "cutoffAt");
