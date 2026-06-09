-- CreateTable
CREATE TABLE "PushDevice" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "customerId" TEXT,
    "customerEmail" TEXT,
    "platform" TEXT NOT NULL DEFAULT 'android',
    "packageName" TEXT,
    "androidVersion" TEXT,
    "deviceId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushDevice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PushDevice_token_key" ON "PushDevice"("token");

-- CreateIndex
CREATE INDEX "PushDevice_shop_customerEmail_idx" ON "PushDevice"("shop", "customerEmail");

-- CreateIndex
CREATE INDEX "PushDevice_shop_customerId_idx" ON "PushDevice"("shop", "customerId");

-- CreateIndex
CREATE INDEX "PushDevice_shop_isActive_idx" ON "PushDevice"("shop", "isActive");
