export async function ensureStockUserTable(prisma) {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "StockUser" (
      "id" SERIAL NOT NULL,
      "shop" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "role" TEXT NOT NULL,
      "code" TEXT NOT NULL,
      "active" BOOLEAN NOT NULL DEFAULT true,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "StockUser_pkey" PRIMARY KEY ("id")
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "StockUser_shop_code_key" ON "StockUser"("shop", "code")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "StockUser_shop_role_idx" ON "StockUser"("shop", "role")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "StockUser_shop_active_idx" ON "StockUser"("shop", "active")`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "StockUser" ADD COLUMN IF NOT EXISTS "sessionToken" TEXT`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "StockUser" ADD COLUMN IF NOT EXISTS "sessionStartedAt" TIMESTAMP(3)`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "StockUser" ADD COLUMN IF NOT EXISTS "sessionLastSeenAt" TIMESTAMP(3)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "StockUser_shop_sessionToken_idx" ON "StockUser"("shop", "sessionToken")`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "StockProductDraft" ADD COLUMN IF NOT EXISTS "preparedByStockUserId" INTEGER`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "StockProductDraft" ADD COLUMN IF NOT EXISTS "publishedByStockUserId" INTEGER`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "StockProductDraft" ADD COLUMN IF NOT EXISTS "publishedAt" TIMESTAMP(3)`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "StockProductDraft" ADD COLUMN IF NOT EXISTS "publishingLockedByStockUserId" INTEGER`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "StockProductDraft" ADD COLUMN IF NOT EXISTS "publishingLockedAt" TIMESTAMP(3)`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "StockProductDraft" ADD COLUMN IF NOT EXISTS "locationReleasedAt" TIMESTAMP(3)`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "StockProductDraft" ADD COLUMN IF NOT EXISTS "locationReusedAt" TIMESTAMP(3)`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "ReturnSettings" ADD COLUMN IF NOT EXISTS "stockLogoutTime" TEXT NOT NULL DEFAULT ''`);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "StockProductDraft_shop_publishedAt_idx" ON "StockProductDraft"("shop", "publishedAt")`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "StockProductDraft_preparedByStockUserId_idx" ON "StockProductDraft"("preparedByStockUserId")`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "StockProductDraft_publishedByStockUserId_idx" ON "StockProductDraft"("publishedByStockUserId")`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "StockProductDraft_shop_publishingLockedAt_idx" ON "StockProductDraft"("shop", "publishingLockedAt")`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "StockProductDraft_shop_locationReleasedAt_idx" ON "StockProductDraft"("shop", "locationReleasedAt")`,
  );
}
