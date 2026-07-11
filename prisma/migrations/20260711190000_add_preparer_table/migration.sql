-- CreateTable
CREATE TABLE "Preparer" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Preparer_shop_code_key" ON "Preparer"("shop", "code");

-- CreateIndex
CREATE INDEX "Preparer_shop_createdAt_idx" ON "Preparer"("shop", "createdAt");
