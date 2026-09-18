-- CreateTable
CREATE TABLE "StoreCreditLedger" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "orderNumber" TEXT,
    "shopifyCustomerId" TEXT,
    "customerEmail" TEXT,
    "currencyCode" TEXT NOT NULL DEFAULT 'MXN',
    "creditRate" DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    "eligibleSubtotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "creditedAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "debitedAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pendingDebitAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "creditTransactionId" TEXT,
    "creditError" TEXT,
    "creditedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreCreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreCreditTransaction" (
    "id" SERIAL NOT NULL,
    "ledgerId" INTEGER,
    "shop" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyRefundId" TEXT,
    "shopifyCustomerId" TEXT,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'webhook',
    "amount" DOUBLE PRECISION NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "shopifyTransactionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreCreditTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoreCreditLedger_shop_shopifyOrderId_key" ON "StoreCreditLedger"("shop", "shopifyOrderId");

-- CreateIndex
CREATE INDEX "StoreCreditLedger_shop_shopifyCustomerId_idx" ON "StoreCreditLedger"("shop", "shopifyCustomerId");

-- CreateIndex
CREATE INDEX "StoreCreditLedger_shop_status_createdAt_idx" ON "StoreCreditLedger"("shop", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StoreCreditTransaction_shop_sourceKey_key" ON "StoreCreditTransaction"("shop", "sourceKey");

-- CreateIndex
CREATE INDEX "StoreCreditTransaction_shop_shopifyOrderId_idx" ON "StoreCreditTransaction"("shop", "shopifyOrderId");

-- CreateIndex
CREATE INDEX "StoreCreditTransaction_shop_shopifyRefundId_idx" ON "StoreCreditTransaction"("shop", "shopifyRefundId");

-- CreateIndex
CREATE INDEX "StoreCreditTransaction_shop_shopifyCustomerId_status_idx" ON "StoreCreditTransaction"("shop", "shopifyCustomerId", "status");

-- CreateIndex
CREATE INDEX "StoreCreditTransaction_shop_type_createdAt_idx" ON "StoreCreditTransaction"("shop", "type", "createdAt");

-- AddForeignKey
ALTER TABLE "StoreCreditTransaction" ADD CONSTRAINT "StoreCreditTransaction_ledgerId_fkey" FOREIGN KEY ("ledgerId") REFERENCES "StoreCreditLedger"("id") ON DELETE SET NULL ON UPDATE CASCADE;
