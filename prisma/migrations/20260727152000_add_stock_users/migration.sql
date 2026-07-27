CREATE TABLE "StockUser" (
  "id" SERIAL NOT NULL,
  "shop" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "StockUser_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StockUser_shop_code_key" ON "StockUser"("shop", "code");
CREATE INDEX "StockUser_shop_role_idx" ON "StockUser"("shop", "role");
CREATE INDEX "StockUser_shop_active_idx" ON "StockUser"("shop", "active");
