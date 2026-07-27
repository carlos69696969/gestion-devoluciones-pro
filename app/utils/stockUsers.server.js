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
}
