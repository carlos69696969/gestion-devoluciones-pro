import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { startBranchDeliveryExpirationScheduler } from "./utils/branchDeliveryExpirationScheduler.server";

if (process.env.npm_lifecycle_event !== "build") {
  startBranchDeliveryExpirationScheduler();
}

const requiredScopes = [
  "write_merchant_managed_fulfillment_orders",
  "write_assigned_fulfillment_orders",
  "write_fulfillments",
];
const configuredScopes = process.env.SCOPES?.split(",").map((scope) => scope.trim()).filter(Boolean) || [];

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: Array.from(new Set([...configuredScopes, ...requiredScopes])),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  // Ensures we persist both online and offline sessions. The public returns portal
  // depends on an offline token being present for the shop.
  useOnlineTokens: true,
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
