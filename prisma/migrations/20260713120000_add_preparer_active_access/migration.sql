ALTER TABLE "Preparer" ADD COLUMN "activeAccessId" TEXT;
ALTER TABLE "Preparer" ADD COLUMN "activeAccessStartedAt" TIMESTAMP(3);
CREATE INDEX "Preparer_shop_activeAccessId_idx" ON "Preparer"("shop", "activeAccessId");

