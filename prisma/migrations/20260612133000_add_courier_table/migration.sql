CREATE TABLE "Courier" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Courier_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Courier_shop_code_key" ON "Courier"("shop", "code");
CREATE INDEX "Courier_shop_createdAt_idx" ON "Courier"("shop", "createdAt");
