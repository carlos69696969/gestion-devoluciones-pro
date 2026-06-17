import prisma from "../app/db.server.js";

await prisma.$executeRawUnsafe(`
  CREATE TABLE IF NOT EXISTS "CourierEvent" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "orderNumber" TEXT,
    "status" TEXT NOT NULL,
    "attempt" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CourierEvent_pkey" PRIMARY KEY ("id")
  )
`);

await prisma.$executeRawUnsafe(`
  CREATE INDEX IF NOT EXISTS "CourierEvent_shop_requestId_createdAt_idx"
  ON "CourierEvent"("shop", "requestId", "createdAt")
`);

await prisma.$executeRawUnsafe(`
  CREATE TABLE IF NOT EXISTS "Courier" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Courier_pkey" PRIMARY KEY ("id")
  )
`);

await prisma.$executeRawUnsafe(`
  CREATE UNIQUE INDEX IF NOT EXISTS "Courier_shop_code_key"
  ON "Courier"("shop", "code")
`);

await prisma.$executeRawUnsafe(`
  CREATE INDEX IF NOT EXISTS "Courier_shop_createdAt_idx"
  ON "Courier"("shop", "createdAt")
`);

await prisma.$executeRawUnsafe(`
  CREATE TABLE IF NOT EXISTS "CourierActivity" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "courierId" INTEGER NOT NULL,
    "courierName" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "orderNumber" TEXT,
    "action" TEXT NOT NULL,
    "routeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CourierActivity_pkey" PRIMARY KEY ("id")
  )
`);

await prisma.$executeRawUnsafe(`
  ALTER TABLE "CourierActivity"
  ADD COLUMN IF NOT EXISTS "routeId" TEXT
`);

await prisma.$executeRawUnsafe(`
  CREATE INDEX IF NOT EXISTS "CourierActivity_shop_courierId_createdAt_idx"
  ON "CourierActivity"("shop", "courierId", "createdAt")
`);

await prisma.$executeRawUnsafe(`
  CREATE INDEX IF NOT EXISTS "CourierActivity_shop_requestId_createdAt_idx"
  ON "CourierActivity"("shop", "requestId", "createdAt")
`);

await prisma.$executeRawUnsafe(`
  CREATE INDEX IF NOT EXISTS "CourierActivity_shop_courierId_routeId_createdAt_idx"
  ON "CourierActivity"("shop", "courierId", "routeId", "createdAt")
`);

await prisma.$executeRawUnsafe(`
  CREATE TABLE IF NOT EXISTS "CourierRouteSnapshot" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "courierId" INTEGER NOT NULL,
    "courierName" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orders" JSONB NOT NULL,
    "remainingCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CourierRouteSnapshot_pkey" PRIMARY KEY ("id")
  )
`);

await prisma.$executeRawUnsafe(`
  ALTER TABLE "CourierRouteSnapshot"
  ADD COLUMN IF NOT EXISTS "remainingCount" INTEGER NOT NULL DEFAULT 0
`);

await prisma.$executeRawUnsafe(`
  CREATE UNIQUE INDEX IF NOT EXISTS "CourierRouteSnapshot_shop_routeId_key"
  ON "CourierRouteSnapshot"("shop", "routeId")
`);

await prisma.$executeRawUnsafe(`
  CREATE INDEX IF NOT EXISTS "CourierRouteSnapshot_shop_courierId_finishedAt_idx"
  ON "CourierRouteSnapshot"("shop", "courierId", "finishedAt")
`);

await prisma.$executeRawUnsafe(`
  CREATE INDEX IF NOT EXISTS "CourierRouteSnapshot_shop_courierId_dateKey_idx"
  ON "CourierRouteSnapshot"("shop", "courierId", "dateKey")
`);

await prisma.$disconnect();
