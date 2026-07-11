-- CreateTable
CREATE TABLE "Preparer" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Preparer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Preparer_shop_code_key" ON "Preparer"("shop", "code");

-- CreateIndex
CREATE INDEX "Preparer_shop_createdAt_idx" ON "Preparer"("shop", "createdAt");
