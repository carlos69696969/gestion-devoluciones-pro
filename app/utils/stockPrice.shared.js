export const STOCK_PRICE_SETTINGS_DEFAULTS = {
  profitPercent: 50,
  taxPercent: 10,
  shopifyCommission: 3,
  operationalCost: 15,
  transactionPercent: 3,
};

export function normalizeStockPricePercent(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
}

export function normalizeStockPriceAmount(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
}

export function normalizeStockPriceSettings(settings = {}) {
  return {
    profitPercent: normalizeStockPricePercent(
      settings.stockProfitPercent ?? settings.profitPercent,
      STOCK_PRICE_SETTINGS_DEFAULTS.profitPercent,
    ),
    taxPercent: normalizeStockPricePercent(
      settings.stockTaxPercent ?? settings.taxPercent,
      STOCK_PRICE_SETTINGS_DEFAULTS.taxPercent,
    ),
    shopifyCommission: normalizeStockPriceAmount(
      settings.stockShopifyCommission ?? settings.shopifyCommission,
      STOCK_PRICE_SETTINGS_DEFAULTS.shopifyCommission,
    ),
    operationalCost: normalizeStockPriceAmount(
      settings.stockOperationalCost ?? settings.operationalCost,
      STOCK_PRICE_SETTINGS_DEFAULTS.operationalCost,
    ),
    transactionPercent: normalizeStockPricePercent(
      settings.stockTransactionPercent ?? settings.transactionPercent,
      STOCK_PRICE_SETTINGS_DEFAULTS.transactionPercent,
    ),
  };
}

export function calculateStockStorePrice(basePrice, settings = {}) {
  const cleanSettings = normalizeStockPriceSettings(settings);
  const base = normalizeStockPriceAmount(basePrice, 0);
  const profit = base * (cleanSettings.profitPercent / 100);
  const tax = profit * (cleanSettings.taxPercent / 100);
  const subtotal =
    base +
    profit +
    tax +
    cleanSettings.shopifyCommission +
    cleanSettings.operationalCost;
  const transaction = subtotal * (cleanSettings.transactionPercent / 100);
  return Math.ceil(subtotal + transaction);
}

export function applyStockStorePriceToVariants(variants = [], settings = {}) {
  return (Array.isArray(variants) ? variants : []).map((variant) => {
    const basePrice = normalizeStockPriceAmount(
      variant?.basePrice ?? variant?.price,
      0,
    );
    return {
      ...variant,
      basePrice,
      price: calculateStockStorePrice(basePrice, settings),
    };
  });
}
