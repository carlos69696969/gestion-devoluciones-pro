CREATE TABLE "StockProductDraft" (
  "id" SERIAL NOT NULL,
  "shop" TEXT NOT NULL,
  "productName" TEXT NOT NULL,
  "color" TEXT,
  "size" TEXT,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "sku" TEXT,
  "price" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "notes" TEXT,
  "photos" JSONB NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'pendiente',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "StockProductDraft_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StockProductDraft_shop_status_createdAt_idx" ON "StockProductDraft"("shop", "status", "createdAt");
CREATE INDEX "StockProductDraft_shop_sku_idx" ON "StockProductDraft"("shop", "sku");
