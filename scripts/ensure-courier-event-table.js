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

await prisma.$disconnect();
