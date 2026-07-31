export const FINANCE_PRICE_SETTINGS_DEFAULTS = {
  profitPercent: 50,
  taxPercent: 10,
  shopifyCommission: 3,
  operationalCost: 15,
  transactionPercent: 3,
  highProfitThreshold: 750,
  highProfitPercent: 40,
  veryHighProfitThreshold: 1000,
  veryHighProfitPercent: 35,
};

export function normalizeFinancePricePercent(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
}

export function normalizeFinancePriceAmount(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
}

export function normalizeFinancePriceSettings(settings = {}) {
  return {
    profitPercent: normalizeFinancePricePercent(
      settings.financeProfitPercent ?? settings.profitPercent,
      FINANCE_PRICE_SETTINGS_DEFAULTS.profitPercent,
    ),
    taxPercent: normalizeFinancePricePercent(
      settings.financeTaxPercent ?? settings.taxPercent,
      FINANCE_PRICE_SETTINGS_DEFAULTS.taxPercent,
    ),
    shopifyCommission: normalizeFinancePriceAmount(
      settings.financeShopifyCommission ?? settings.shopifyCommission,
      FINANCE_PRICE_SETTINGS_DEFAULTS.shopifyCommission,
    ),
    operationalCost: normalizeFinancePriceAmount(
      settings.financeOperationalCost ?? settings.operationalCost,
      FINANCE_PRICE_SETTINGS_DEFAULTS.operationalCost,
    ),
    transactionPercent: normalizeFinancePricePercent(
      settings.financeTransactionPercent ?? settings.transactionPercent,
      FINANCE_PRICE_SETTINGS_DEFAULTS.transactionPercent,
    ),
    highProfitThreshold: normalizeFinancePriceAmount(
      settings.financeHighProfitThreshold ?? settings.highProfitThreshold,
      FINANCE_PRICE_SETTINGS_DEFAULTS.highProfitThreshold,
    ),
    highProfitPercent: normalizeFinancePricePercent(
      settings.financeHighProfitPercent ?? settings.highProfitPercent,
      FINANCE_PRICE_SETTINGS_DEFAULTS.highProfitPercent,
    ),
    veryHighProfitThreshold: normalizeFinancePriceAmount(
      settings.financeVeryHighProfitThreshold ?? settings.veryHighProfitThreshold,
      FINANCE_PRICE_SETTINGS_DEFAULTS.veryHighProfitThreshold,
    ),
    veryHighProfitPercent: normalizeFinancePricePercent(
      settings.financeVeryHighProfitPercent ?? settings.veryHighProfitPercent,
      FINANCE_PRICE_SETTINGS_DEFAULTS.veryHighProfitPercent,
    ),
  };
}

export function financePriceSettingsForDate(settingsTimeline = [], value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const time = Number.isFinite(date.getTime()) ? date.getTime() : Date.now();
  let selectedSettings = FINANCE_PRICE_SETTINGS_DEFAULTS;
  for (const entry of settingsTimeline || []) {
    const effectiveAt = entry?.effectiveAt ? new Date(entry.effectiveAt) : null;
    if (!effectiveAt || !Number.isFinite(effectiveAt.getTime())) continue;
    if (effectiveAt.getTime() <= time) {
      selectedSettings = entry;
      continue;
    }
    break;
  }
  return normalizeFinancePriceSettings(selectedSettings);
}

export function financePriceSettingsSignature(settingsTimeline = []) {
  return (settingsTimeline || [])
    .map((settings) =>
      [
        settings.effectiveAt || "",
        settings.profitPercent,
        settings.taxPercent,
        settings.shopifyCommission,
        settings.operationalCost,
        settings.transactionPercent,
        settings.highProfitThreshold,
        settings.highProfitPercent,
        settings.veryHighProfitThreshold,
        settings.veryHighProfitPercent,
      ].join(":"),
    )
    .join("|");
}
