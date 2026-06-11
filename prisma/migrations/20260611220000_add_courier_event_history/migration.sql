CREATE TABLE "CourierEvent" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "orderNumber" TEXT,
    "status" TEXT NOT NULL,
    "attempt" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourierEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CourierEvent_shop_requestId_createdAt_idx" ON "CourierEvent"("shop", "requestId", "createdAt");
