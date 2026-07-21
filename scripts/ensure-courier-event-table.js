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
  CREATE TABLE IF NOT EXISTS "Preparer" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Preparer_pkey" PRIMARY KEY ("id")
  )
`);

await prisma.$executeRawUnsafe(`
  CREATE UNIQUE INDEX IF NOT EXISTS "Preparer_shop_code_key"
  ON "Preparer"("shop", "code")
`);

await prisma.$executeRawUnsafe(`
  CREATE INDEX IF NOT EXISTS "Preparer_shop_createdAt_idx"
  ON "Preparer"("shop", "createdAt")
`);

await prisma.$executeRawUnsafe(`
  CREATE TABLE IF NOT EXISTS "PreparerAssignment" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "preparerId" INTEGER NOT NULL,
    "preparerName" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "orderNumber" TEXT,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'assigned',
    "orderData" JSONB NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "PreparerAssignment_pkey" PRIMARY KEY ("id")
  )
`);

await prisma.$executeRawUnsafe(`
  CREATE UNIQUE INDEX IF NOT EXISTS "PreparerAssignment_shop_requestId_key"
  ON "PreparerAssignment"("shop", "requestId")
`);

await prisma.$executeRawUnsafe(`
  CREATE INDEX IF NOT EXISTS "PreparerAssignment_shop_preparerId_status_idx"
  ON "PreparerAssignment"("shop", "preparerId", "status")
`);

await prisma.$executeRawUnsafe(`
  CREATE INDEX IF NOT EXISTS "PreparerAssignment_shop_assignedAt_idx"
  ON "PreparerAssignment"("shop", "assignedAt")
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

await prisma.$executeRawUnsafe(`
  CREATE TABLE IF NOT EXISTS "DeliveryCodeAssignment" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "code" TEXT,
    "historicalCode" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeliveryCodeAssignment_pkey" PRIMARY KEY ("id")
  )
`);

await prisma.$executeRawUnsafe(`
  CREATE UNIQUE INDEX IF NOT EXISTS "DeliveryCodeAssignment_code_key"
  ON "DeliveryCodeAssignment"("code")
`);

await prisma.$executeRawUnsafe(`
  CREATE UNIQUE INDEX IF NOT EXISTS "DeliveryCodeAssignment_shop_shopifyOrderId_key"
  ON "DeliveryCodeAssignment"("shop", "shopifyOrderId")
`);

await prisma.$executeRawUnsafe(`
  CREATE INDEX IF NOT EXISTS "DeliveryCodeAssignment_shop_active_idx"
  ON "DeliveryCodeAssignment"("shop", "active")
`);

await prisma.$executeRawUnsafe(`
  CREATE INDEX IF NOT EXISTS "DeliveryCodeAssignment_shop_orderNumber_idx"
  ON "DeliveryCodeAssignment"("shop", "orderNumber")
`);

await prisma.$executeRawUnsafe(`
  CREATE TABLE IF NOT EXISTS "GoogleMapsGeocodeCache" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "addressKey" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "formattedAddress" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "placeId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'google',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GoogleMapsGeocodeCache_pkey" PRIMARY KEY ("id")
  )
`);

await prisma.$executeRawUnsafe(`
  CREATE UNIQUE INDEX IF NOT EXISTS "GoogleMapsGeocodeCache_shop_addressKey_key"
  ON "GoogleMapsGeocodeCache"("shop", "addressKey")
`);

await prisma.$executeRawUnsafe(`
  CREATE INDEX IF NOT EXISTS "GoogleMapsGeocodeCache_shop_updatedAt_idx"
  ON "GoogleMapsGeocodeCache"("shop", "updatedAt")
`);


await prisma.$executeRawUnsafe(`
  CREATE TABLE IF NOT EXISTS "CourierHistoryPurge" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "orderNumber" TEXT,
    "cutoffAt" TIMESTAMP(3) NOT NULL,
    "purgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CourierHistoryPurge_pkey" PRIMARY KEY ("id")
  )
`);

await prisma.$executeRawUnsafe(`
  CREATE UNIQUE INDEX IF NOT EXISTS "CourierHistoryPurge_shop_requestId_key"
  ON "CourierHistoryPurge"("shop", "requestId")
`);

await prisma.$executeRawUnsafe(`
  CREATE INDEX IF NOT EXISTS "CourierHistoryPurge_shop_purgedAt_idx"
  ON "CourierHistoryPurge"("shop", "purgedAt")
`);

await prisma.$executeRawUnsafe(`
  CREATE INDEX IF NOT EXISTS "CourierHistoryPurge_shop_cutoffAt_idx"
  ON "CourierHistoryPurge"("shop", "cutoffAt")
`);

await prisma.$executeRawUnsafe(`
  ALTER TABLE "ReturnSettings"
  ADD COLUMN IF NOT EXISTS "maintenanceEvidenceDays" INTEGER NOT NULL DEFAULT 120
`);

await prisma.$executeRawUnsafe(`
  ALTER TABLE "ReturnSettings"
  ADD COLUMN IF NOT EXISTS "maintenancePurgeDays" INTEGER NOT NULL DEFAULT 180
`);

await prisma.$executeRawUnsafe(`
  ALTER TABLE "ReturnSettings"
  ADD COLUMN IF NOT EXISTS "maintenanceBatchSize" INTEGER NOT NULL DEFAULT 200
`);

await prisma.$disconnect();
