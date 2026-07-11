-- CreateTable
CREATE TABLE "PreparerAssignment" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "preparerId" INTEGER NOT NULL,
    "preparerName" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "orderNumber" TEXT,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'assigned',
    "orderData" JSONB NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "PreparerAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PreparerAssignment_shop_requestId_key" ON "PreparerAssignment"("shop", "requestId");

-- CreateIndex
CREATE INDEX "PreparerAssignment_shop_preparerId_status_idx" ON "PreparerAssignment"("shop", "preparerId", "status");

-- CreateIndex
CREATE INDEX "PreparerAssignment_shop_assignedAt_idx" ON "PreparerAssignment"("shop", "assignedAt");
