ALTER TABLE "Courier" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "Courier_shop_active_idx" ON "Courier"("shop", "active");
