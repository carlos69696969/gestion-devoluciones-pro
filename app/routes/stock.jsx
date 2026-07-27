import { useEffect, useMemo, useState } from "react";
import { Form, redirect, useActionData, useLoaderData, useNavigation, useSearchParams } from "react-router";
import prisma from "../db.server";
import styles from "../styles/stock.module.css";

const MAX_STOCK_PHOTOS = 8;
const MAX_STOCK_PHOTO_CHARS = 1_250_000;
const STOCK_SIZES = ["XS", "S", "M", "L", "XL", "XXL", "XXXL"];
const STOCK_AUDIENCES = [
  { value: "hombre", label: "Hombre", code: "H" },
  { value: "mujer", label: "Mujer", code: "M" },
];
const STOCK_GARMENTS = [
  { value: "playera", label: "Playera", code: "PL", section: "Parte superior", audiences: ["hombre", "mujer"] },
  { value: "camisa", label: "Camisa", code: "CA", section: "Parte superior", audiences: ["hombre", "mujer"] },
  { value: "chamarra", label: "Chamarra", code: "CH", section: "Parte superior", audiences: ["hombre", "mujer"] },
  { value: "sudadera", label: "Sudadera", code: "SU", section: "Parte superior", audiences: ["mujer"] },
  { value: "chaleco", label: "Chaleco", code: "CL", section: "Parte superior", audiences: ["mujer"] },
  { value: "sueter", label: "Sueter", code: "ST", section: "Parte superior", audiences: ["hombre", "mujer"] },
  { value: "blusa", label: "Blusa", code: "BL", section: "Parte superior", audiences: ["mujer"] },
  { value: "pantalon", label: "Pantalon", code: "PA", section: "Parte inferior", audiences: ["hombre", "mujer"] },
  { value: "short", label: "Short", code: "SH", section: "Parte inferior", audiences: ["hombre", "mujer"] },
  { value: "falda", label: "Falda", code: "FA", section: "Parte inferior", audiences: ["mujer"] },
  { value: "tenis", label: "Tenis", code: "TE", section: "Parte inferior", audiences: ["hombre", "mujer"] },
  { value: "vestido", label: "Vestido", code: "VE", section: "Parte superior e inferior", audiences: ["mujer"] },
  { value: "conjunto", label: "Conjunto", code: "CO", section: "Parte superior e inferior", audiences: ["hombre", "mujer"] },
];

function cleanShop(value) {
  return String(value || "").trim().toLowerCase();
}

function portalShopFromRequest(request) {
  const url = new URL(request.url);
  return cleanShop(url.searchParams.get("shop")) || cleanShop(process.env.SHOPIFY_SHOP_DOMAIN) || "portal-stock";
}

function sanitizeText(value, maxLength = 180) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeAudience(value) {
  const cleanValue = String(value || "").trim().toLowerCase();
  return STOCK_AUDIENCES.some((audience) => audience.value === cleanValue) ? cleanValue : STOCK_AUDIENCES[0].value;
}

function normalizeGarment(value) {
  const cleanValue = String(value || "").trim().toLowerCase();
  return STOCK_GARMENTS.some((garment) => garment.value === cleanValue) ? cleanValue : STOCK_GARMENTS[0].value;
}

function audienceConfig(value) {
  return STOCK_AUDIENCES.find((audience) => audience.value === normalizeAudience(value)) || STOCK_AUDIENCES[0];
}

function garmentConfig(value) {
  return STOCK_GARMENTS.find((garment) => garment.value === normalizeGarment(value)) || STOCK_GARMENTS[0];
}

function stockSkuPrefix(audience, garment) {
  return `${audienceConfig(audience).code}-${garmentConfig(garment).code}`;
}

function nextStockSkuForPrefix(prefix, existingSkus = []) {
  const matcher = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`, "i");
  const usedNumbers = new Set();
  const highestNumber = existingSkus.reduce((highest, sku) => {
    const match = String(sku || "").trim().match(matcher);
    const number = match ? Number(match[1] || 0) : 0;
    if (number >= 1 && number <= 10000) usedNumbers.add(number);
    return number ? Math.max(highest, number) : highest;
  }, 0);
  const nextNumber = highestNumber < 10000 ? highestNumber + 1 : 1;
  for (let number = nextNumber; number <= 10000; number += 1) {
    if (!usedNumbers.has(number)) return `${prefix}-${String(number).padStart(2, "0")}`;
  }
  for (let number = 1; number < nextNumber; number += 1) {
    if (!usedNumbers.has(number)) return `${prefix}-${String(number).padStart(2, "0")}`;
  }
  return `${prefix}-10000`;
}

function defaultStockLocation(audience, garment) {
  return `${audienceConfig(audience).label}-${garmentConfig(garment).label}-A1`;
}

function nextStockLocation(currentLocation, audience, garment) {
  const defaultLocation = defaultStockLocation(audience, garment);
  const match = String(currentLocation || "").trim().toUpperCase().match(/-([A-Z])(\d+)$/);
  const currentLetter = match?.[1] || "A";
  const currentRound = Math.max(1, Number(match?.[2] || 1));
  if (currentLetter === "Z") {
    return `${audienceConfig(audience).label}-${garmentConfig(garment).label}-A${currentRound + 1}`;
  }
  const nextLetter = String.fromCharCode(currentLetter.charCodeAt(0) + 1);
  return defaultLocation.replace(/-[A-Z]\d+$/, `-${nextLetter}${currentRound}`);
}

function stockLabels() {
  return {
    audiences: Object.fromEntries(STOCK_AUDIENCES.map((audience) => [audience.value, audience.label])),
    garments: Object.fromEntries(STOCK_GARMENTS.map((garment) => [garment.value, garment.label])),
  };
}

function sanitizePhotoDataUrl(value) {
  const photo = String(value || "").trim();
  if (!photo.startsWith("data:image/")) return "";
  if (photo.length > MAX_STOCK_PHOTO_CHARS) return "";
  return photo;
}

function sanitizeStockVariants(value) {
  let parsed = [];
  try {
    parsed = JSON.parse(String(value || "[]"));
  } catch (_error) {
    parsed = [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((variant) => {
      const color = sanitizeText(variant?.color, 80);
      const price = Math.max(0, Number(variant?.price || 0) || 0);
      const sizes = (Array.isArray(variant?.sizes) ? variant.sizes : [])
        .map((sizeRow) => ({
          size: STOCK_SIZES.includes(String(sizeRow?.size || "").trim().toUpperCase())
            ? String(sizeRow.size).trim().toUpperCase()
            : "",
          quantity: Math.max(1, Math.min(9999, Number(sizeRow?.quantity || 0) || 0)),
        }))
        .filter((sizeRow) => sizeRow.size && sizeRow.quantity);
      return { color, price, sizes };
    })
    .filter((variant) => variant.color && variant.sizes.length);
}

function serializeDraft(draft) {
  const variants = Array.isArray(draft.variants) ? draft.variants : [];
  return {
    id: draft.id,
    productName: draft.productName,
    color: draft.color || "",
    size: draft.size || "",
    quantity: draft.quantity,
    sku: draft.sku || "",
    audience: draft.audience || "",
    audienceLabel: stockLabels().audiences[draft.audience] || "",
    garmentType: draft.garmentType || "",
    garmentLabel: stockLabels().garments[draft.garmentType] || "",
    locationCode: draft.locationCode || "",
    price: draft.price,
    notes: draft.notes || "",
    photos: Array.isArray(draft.photos) ? draft.photos : [],
    variants,
    status: draft.status,
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
  };
}

export const headers = () => ({
  "Cache-Control": "no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow",
});

export async function loader({ request }) {
  const shop = portalShopFromRequest(request);
  let drafts = [];
  let skuRows = [];
  let locationRows = [];
  let error = "";
  try {
    [drafts, skuRows, locationRows] = await Promise.all([
      prisma.stockProductDraft.findMany({
        where: { shop },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 80,
      }),
      prisma.stockProductDraft.findMany({
        where: { shop },
        select: { sku: true },
      }),
      prisma.stockLocationState.findMany({
        where: { shop },
      }),
    ]);
  } catch (loadError) {
    console.error("No se pudo cargar portal stock", loadError);
    error = "El almacenamiento de stock se esta preparando. Actualiza la pagina en un momento.";
  }
  const existingSkus = skuRows.map((row) => row.sku).filter(Boolean);
  const nextSkuByCategory = Object.fromEntries(
    STOCK_AUDIENCES.flatMap((audience) =>
      STOCK_GARMENTS.map((garment) => {
        const prefix = stockSkuPrefix(audience.value, garment.value);
        return [`${audience.value}:${garment.value}`, nextStockSkuForPrefix(prefix, existingSkus)];
      }),
    ),
  );
  const locationByCategory = Object.fromEntries(
    STOCK_AUDIENCES.flatMap((audience) =>
      STOCK_GARMENTS.map((garment) => {
        const location = locationRows.find(
          (row) => row.audience === audience.value && row.garmentType === garment.value,
        )?.currentLocation;
        return [`${audience.value}:${garment.value}`, location || defaultStockLocation(audience.value, garment.value)];
      }),
    ),
  );

  return {
    shop,
    drafts: drafts.map(serializeDraft),
    audiences: STOCK_AUDIENCES,
    garments: STOCK_GARMENTS,
    nextSkuByCategory,
    locationByCategory,
    error,
  };
}

export async function action({ request }) {
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "").trim();
  const shop = cleanShop(formData.get("shop")) || portalShopFromRequest(request);

  if (intent === "advance_stock_location") {
    const audience = normalizeAudience(formData.get("audience"));
    const garmentType = normalizeGarment(formData.get("garmentType"));
    const currentLocation =
      sanitizeText(formData.get("currentLocation"), 80) || defaultStockLocation(audience, garmentType);
    const nextLocation = nextStockLocation(currentLocation, audience, garmentType);
    await prisma.stockLocationState.upsert({
      where: { shop_audience_garmentType: { shop, audience, garmentType } },
      create: { shop, audience, garmentType, currentLocation: nextLocation },
      update: { currentLocation: nextLocation },
    });
    return redirect(`/stock?shop=${encodeURIComponent(shop)}`);
  }

  if (intent !== "create_stock_draft") {
    return { ok: false, error: "Accion no reconocida." };
  }

  const audience = normalizeAudience(formData.get("audience"));
  const garmentType = normalizeGarment(formData.get("garmentType"));
  const productName = sanitizeText(formData.get("productName")) || garmentConfig(garmentType).label;
  const variants = sanitizeStockVariants(formData.get("variants"));
  if (!variants.length) return { ok: false, error: "Agrega color y al menos una talla con cantidad." };
  const quantity = variants.reduce(
    (sum, variant) => sum + variant.sizes.reduce((sizeSum, sizeRow) => sizeSum + sizeRow.quantity, 0),
    0,
  );
  const firstVariant = variants[0] || {};
  const firstSize = firstVariant.sizes?.[0] || {};
  const price = Math.max(0, Number(firstVariant.price || 0) || 0);
  const photos = formData
    .getAll("photos")
    .map(sanitizePhotoDataUrl)
    .filter(Boolean)
    .slice(0, MAX_STOCK_PHOTOS);
  const existingSkus = (
    await prisma.stockProductDraft.findMany({
      where: { shop },
      select: { sku: true },
    })
  )
    .map((row) => row.sku)
    .filter(Boolean);
  const sku = nextStockSkuForPrefix(stockSkuPrefix(audience, garmentType), existingSkus);
  const locationState = await prisma.stockLocationState.findUnique({
    where: { shop_audience_garmentType: { shop, audience, garmentType } },
  });
  const locationCode = locationState?.currentLocation || defaultStockLocation(audience, garmentType);
  const nextLocation = nextStockLocation(locationCode, audience, garmentType);

  await prisma.$transaction([
    prisma.stockProductDraft.create({
      data: {
        shop,
        productName,
        audience,
        garmentType,
        locationCode,
        color: firstVariant.color || null,
        size: firstSize.size || null,
        quantity,
        sku,
        price,
        notes: sanitizeText(formData.get("notes"), 600) || null,
        photos,
        variants,
        status: "pendiente",
      },
    }),
    prisma.stockLocationState.upsert({
      where: { shop_audience_garmentType: { shop, audience, garmentType } },
      create: { shop, audience, garmentType, currentLocation: nextLocation },
      update: { currentLocation: nextLocation },
    }),
  ]);

  return redirect(`/stock?shop=${encodeURIComponent(shop)}&guardado=1`);
}

function money(value) {
  return new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: "MXN",
  }).format(Number(value || 0));
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function compressImageFile(file) {
  const originalDataUrl = await fileToDataUrl(file);
  const image = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = originalDataUrl;
  });
  const maxSide = 1400;
  const scale = Math.min(1, maxSide / Math.max(image.width || maxSide, image.height || maxSide));
  const width = Math.max(1, Math.round((image.width || maxSide) * scale));
  const height = Math.max(1, Math.round((image.height || maxSide) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", 0.78);
}

export default function StockPortal() {
  const { shop, drafts, error, audiences, garments, nextSkuByCategory, locationByCategory } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState(searchParams.get("guardado") ? "pendientes" : "capturar");
  const [photos, setPhotos] = useState([]);
  const [selectedDraftId, setSelectedDraftId] = useState(drafts[0]?.id || 0);
  const [selectedAudience, setSelectedAudience] = useState(audiences?.[0]?.value || "hombre");
  const [selectedGarment, setSelectedGarment] = useState(garments?.[0]?.value || "playera");
  const [captureStep, setCaptureStep] = useState("audience");
  const [variantGroups, setVariantGroups] = useState([
    { id: "variant-1", color: "", price: "", sizes: [], selectedSize: "", quantityDraft: "", sizesDone: false },
  ]);
  const isSubmitting = navigation.state !== "idle";
  const suggestedSku =
    nextSkuByCategory?.[`${selectedAudience}:${selectedGarment}`] ||
    nextStockSkuForPrefix(stockSkuPrefix(selectedAudience, selectedGarment), []);
  const suggestedLocation =
    locationByCategory?.[`${selectedAudience}:${selectedGarment}`] ||
    defaultStockLocation(selectedAudience, selectedGarment);
  const selectedDraft = useMemo(
    () => drafts.find((draft) => Number(draft.id) === Number(selectedDraftId)) || drafts[0] || null,
    [drafts, selectedDraftId],
  );

  useEffect(() => {
    if (searchParams.get("guardado")) {
      setActiveTab("pendientes");
      setPhotos([]);
      resetStockVariants();
    }
  }, [searchParams]);

  async function handlePhotoFiles(event) {
    const files = Array.from(event.target.files || []).slice(0, MAX_STOCK_PHOTOS - photos.length);
    if (!files.length) return;
    const compressed = [];
    for (const file of files) {
      try {
        compressed.push({
          id: `${Date.now()}-${file.name}-${compressed.length}`,
          name: file.name || "foto-producto.jpg",
          dataUrl: await compressImageFile(file),
        });
      } catch (error) {
        console.error("No se pudo procesar la foto de stock", error);
      }
    }
    setPhotos((current) => [...current, ...compressed].slice(0, MAX_STOCK_PHOTOS));
    event.target.value = "";
  }

  function chooseAudience(value) {
    setSelectedAudience(value);
    setCaptureStep("product");
  }

  function chooseGarment(value) {
    setSelectedGarment(value);
    setCaptureStep("details");
    resetStockVariants();
  }

  function resetStockVariants() {
    setVariantGroups([
      { id: "variant-1", color: "", price: "", sizes: [], selectedSize: "", quantityDraft: "", sizesDone: false },
    ]);
  }

  const cleanVariantGroups = useMemo(
    () =>
      variantGroups
        .map((variant) => ({
          color: String(variant.color || "").trim(),
          price: Math.max(0, Number(variant.price || 0) || 0),
          sizes: (Array.isArray(variant.sizes) ? variant.sizes : [])
            .map((sizeRow) => ({
              size: String(sizeRow.size || "").trim().toUpperCase(),
              quantity: Math.max(1, Math.min(9999, Number(sizeRow.quantity || 0) || 0)),
            }))
            .filter((sizeRow) => sizeRow.size && sizeRow.quantity),
        }))
        .filter((variant) => variant.color && variant.sizes.length),
    [variantGroups],
  );

  function updateVariant(variantId, field, value) {
    setVariantGroups((currentGroups) =>
      currentGroups.map((variant) =>
        variant.id === variantId
          ? {
              ...variant,
              [field]: value,
            }
          : variant,
      ),
    );
  }

  function selectVariantSize(variantId, value) {
    if (value === "__done") {
      updateVariant(variantId, "sizesDone", true);
      return;
    }
    setVariantGroups((currentGroups) =>
      currentGroups.map((variant) =>
        variant.id === variantId ? { ...variant, selectedSize: value, quantityDraft: "" } : variant,
      ),
    );
  }

  function confirmVariantSize(variantId) {
    setVariantGroups((currentGroups) =>
      currentGroups.map((variant) => {
        if (variant.id !== variantId) return variant;
        const cleanSize = String(variant.selectedSize || "").trim().toUpperCase();
        const quantity = Math.max(1, Math.min(9999, Number(variant.quantityDraft || 0) || 0));
        if (!cleanSize || !quantity) return variant;
        const nextSizes = [
          ...variant.sizes.filter((sizeRow) => String(sizeRow.size || "").trim().toUpperCase() !== cleanSize),
          { size: cleanSize, quantity },
        ];
        return { ...variant, sizes: nextSizes, selectedSize: "", quantityDraft: "" };
      }),
    );
  }

  function removeSizeFromVariant(variantId, size) {
    const cleanSize = String(size || "").trim().toUpperCase();
    setVariantGroups((currentGroups) =>
      currentGroups.map((variant) => {
        if (variant.id !== variantId) return variant;
        const nextSizes = variant.sizes.filter(
          (sizeRow) => String(sizeRow.size || "").trim().toUpperCase() !== cleanSize,
        );
        return {
          ...variant,
          sizes: nextSizes,
          sizesDone: nextSizes.length ? variant.sizesDone : false,
        };
      }),
    );
  }

  function addVariantGroup() {
    const nextId = `variant-${Date.now()}`;
    setVariantGroups((currentGroups) => [
      ...currentGroups,
      { id: nextId, color: "", price: "", sizes: [], selectedSize: "", quantityDraft: "", sizesDone: false },
    ]);
  }

  function removeVariantGroup(variantId) {
    setVariantGroups((currentGroups) => {
      const nextGroups = currentGroups.filter((variant) => variant.id !== variantId);
      return nextGroups.length
        ? nextGroups
        : [{ id: "variant-1", color: "", price: "", sizes: [], selectedSize: "", quantityDraft: "", sizesDone: false }];
    });
  }

  const garmentGroups = useMemo(() => {
    return (garments || STOCK_GARMENTS)
      .filter((garment) => !garment.audiences || garment.audiences.includes(selectedAudience))
      .reduce((groups, garment) => {
        const section = garment.section || "Productos";
        return {
          ...groups,
          [section]: [...(groups[section] || []), garment],
        };
      }, {});
  }, [garments, selectedAudience]);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p>Cariana</p>
          <h1>Portal stock</h1>
        </div>
      </header>

      {error ? <p className={styles.error}>{error}</p> : null}
      {actionData?.error ? <p className={styles.error}>{actionData.error}</p> : null}

      {activeTab === "capturar" ? (
        <section className={styles.card}>
          {captureStep === "audience" ? (
            <div className={styles.choicePanel}>
              <h2>Para quién es este producto</h2>
              <div className={styles.choiceGrid}>
                {(audiences || STOCK_AUDIENCES).map((audience) => (
                  <button
                    className={`${styles.choiceButton} ${
                      selectedAudience === audience.value ? styles.choiceButtonActive : ""
                    }`}
                    key={audience.value}
                    type="button"
                    onClick={() => chooseAudience(audience.value)}
                  >
                    {audience.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {captureStep === "product" ? (
            <div className={styles.choicePanel}>
              <div className={styles.stepHeader}>
                <div>
                  <span>{audienceConfig(selectedAudience).label}</span>
                  <h2>Qué producto vas a agregar</h2>
                </div>
                <button className={styles.textButton} type="button" onClick={() => setCaptureStep("audience")}>
                  Regresar
                </button>
              </div>
              {Object.entries(garmentGroups).map(([section, sectionGarments]) => (
                <div className={styles.productGroup} key={section}>
                  <h3>{section}</h3>
                  <div className={styles.productGrid}>
                    {sectionGarments.map((garment) => (
                      <button
                        className={`${styles.choiceButton} ${
                          selectedGarment === garment.value ? styles.choiceButtonActive : ""
                        }`}
                        key={garment.value}
                        type="button"
                        onClick={() => chooseGarment(garment.value)}
                      >
                        {garment.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {captureStep === "details" ? (
            <>
              <div className={styles.changeProductRow}>
                <button className={styles.textButton} type="button" onClick={() => setCaptureStep("product")}>
                  Cambiar producto
                </button>
              </div>

              <Form method="post" className={styles.form}>
                <input type="hidden" name="intent" value="create_stock_draft" />
                <input type="hidden" name="shop" value={shop} />
                <input type="hidden" name="audience" value={selectedAudience} />
                <input type="hidden" name="garmentType" value={selectedGarment} />
                <input type="hidden" name="variants" value={JSON.stringify(cleanVariantGroups)} />
                {photos.map((photo) => (
                  <input key={photo.id} type="hidden" name="photos" value={photo.dataUrl} />
                ))}

                <div className={styles.generatedPanel}>
                  <span>
                    SKU automatico
                    <strong>{suggestedSku}</strong>
                  </span>
                  <span>
                    Ubicacion
                    <strong>{suggestedLocation}</strong>
                  </span>
                </div>

                <label className={styles.photoPicker}>
                  <span>Tomar o agregar fotos</span>
                  <strong>{photos.length}/{MAX_STOCK_PHOTOS}</strong>
                  <input accept="image/*" capture="environment" multiple type="file" onChange={handlePhotoFiles} />
                </label>

                {photos.length ? (
                  <div className={styles.photoGrid}>
                    {photos.map((photo) => (
                      <figure className={styles.photoThumb} key={photo.id}>
                        <img src={photo.dataUrl} alt={photo.name} />
                        <button
                          type="button"
                          onClick={() => setPhotos((current) => current.filter((item) => item.id !== photo.id))}
                        >
                          Quitar
                        </button>
                      </figure>
                    ))}
                  </div>
                ) : null}

                <div className={styles.variantEditor}>
                  {variantGroups.map((variant, index) => (
                    <div className={styles.variantBlock} key={variant.id}>
                      {variantGroups.length > 1 ? (
                        <div className={styles.variantBlockHeader}>
                          <strong>{variant.color || `Color ${index + 1}`}</strong>
                          <button
                            className={styles.removeVariantButton}
                            type="button"
                            onClick={() => removeVariantGroup(variant.id)}
                          >
                            Quitar color
                          </button>
                        </div>
                      ) : null}

                      <div className={styles.productFields}>
                        <label>
                          Color
                          <input
                            name={`colorDraft-${variant.id}`}
                            value={variant.color || ""}
                            onChange={(event) => updateVariant(variant.id, "color", event.currentTarget.value)}
                          />
                        </label>
                        <label>
                          Precio
                          <input
                            min="0"
                            name={`priceDraft-${variant.id}`}
                            inputMode="decimal"
                            step="0.01"
                            type="number"
                            value={variant.price ?? ""}
                            onChange={(event) => updateVariant(variant.id, "price", event.currentTarget.value)}
                          />
                        </label>
                      </div>

                      <div className={styles.sizeFlow}>
                        {!variant.sizesDone ? (
                          variant.selectedSize ? (
                            <label>
                              Cantidad
                              <div className={styles.sizeQuantityRow}>
                                <input
                                  min="1"
                                  inputMode="numeric"
                                  placeholder={`Cantidad ${variant.selectedSize}`}
                                  type="number"
                                  value={variant.quantityDraft || ""}
                                  onChange={(event) =>
                                    updateVariant(variant.id, "quantityDraft", event.currentTarget.value)
                                  }
                                />
                                <button
                                  className={styles.secondaryButton}
                                  type="button"
                                  disabled={!variant.quantityDraft}
                                  onClick={() => confirmVariantSize(variant.id)}
                                >
                                  Listo
                                </button>
                              </div>
                            </label>
                          ) : (
                            <label>
                              Talla
                              <select
                                value=""
                                onChange={(event) => selectVariantSize(variant.id, event.currentTarget.value)}
                              >
                                <option value="" disabled />
                                {STOCK_SIZES.map((size) => (
                                  <option key={size} value={size}>
                                    {size}
                                  </option>
                                ))}
                                <option value="__done">Listo</option>
                              </select>
                            </label>
                          )
                        ) : null}

                        {variant.sizes.length ? (
                          <div className={styles.sizeSelectionBox}>
                            <span>Tallas</span>
                            <div className={styles.sizeChipList}>
                              {variant.sizes.map((sizeRow) => (
                                <button
                                  className={styles.sizeChip}
                                  key={`${variant.id}-${sizeRow.size}`}
                                  type="button"
                                  onClick={() => removeSizeFromVariant(variant.id, sizeRow.size)}
                                >
                                  {sizeRow.size} x{sizeRow.quantity} Quitar
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>

                <div className={styles.formActions}>
                  <button className={styles.secondaryButton} type="button" onClick={addVariantGroup}>
                    + Agregar
                  </button>
                  <button className={styles.primaryButton} type="submit" disabled={isSubmitting}>
                    {isSubmitting ? "Guardando..." : "Listo"}
                  </button>
                </div>
              </Form>
            </>
          ) : null}
        </section>
      ) : (
        <section className={styles.pendingLayout}>
          <div className={styles.listCard}>
            <h2>Productos guardados</h2>
            {drafts.length ? (
              <div className={styles.draftList}>
                {drafts.map((draft) => (
                  <button
                    className={`${styles.draftButton} ${selectedDraft?.id === draft.id ? styles.draftButtonActive : ""}`}
                    key={draft.id}
                    type="button"
                    onClick={() => setSelectedDraftId(draft.id)}
                  >
                    {draft.photos?.[0] ? <img src={draft.photos[0]} alt={draft.productName} /> : <span />}
                    <strong>{draft.productName}</strong>
                    <small>
                      {draft.sku ? `SKU ${draft.sku}` : "Sin SKU"}
                      {draft.locationCode ? ` | ${draft.locationCode}` : ""}
                    </small>
                  </button>
                ))}
              </div>
            ) : (
              <p className={styles.empty}>Todavia no hay productos guardados.</p>
            )}
          </div>

          {selectedDraft ? (
            <article className={styles.detailCard}>
              <h2>{selectedDraft.productName}</h2>
              <dl className={styles.detailGrid}>
                <div>
                  <dt>Color</dt>
                  <dd>{selectedDraft.color || "-"}</dd>
                </div>
                <div>
                  <dt>Talla</dt>
                  <dd>{selectedDraft.size || "-"}</dd>
                </div>
                <div>
                  <dt>Cantidad</dt>
                  <dd>{selectedDraft.quantity}</dd>
                </div>
                <div>
                  <dt>SKU</dt>
                  <dd>{selectedDraft.sku || "-"}</dd>
                </div>
                <div>
                  <dt>Ubicacion</dt>
                  <dd>{selectedDraft.locationCode || "-"}</dd>
                </div>
                <div>
                  <dt>Persona</dt>
                  <dd>{selectedDraft.audienceLabel || "-"}</dd>
                </div>
                <div>
                  <dt>Prenda</dt>
                  <dd>{selectedDraft.garmentLabel || "-"}</dd>
                </div>
                <div>
                  <dt>Precio</dt>
                  <dd>{money(selectedDraft.price)}</dd>
                </div>
              </dl>
              {selectedDraft.variants?.length ? (
                <div className={styles.variantDetailList}>
                  {selectedDraft.variants.map((variant, index) => (
                    <div className={styles.variantDetailItem} key={`${selectedDraft.id}-variant-${index}`}>
                      <div>
                        <strong>{variant.color || `Color ${index + 1}`}</strong>
                        <span>{money(variant.price)}</span>
                      </div>
                      <p>
                        {(variant.sizes || [])
                          .map((sizeRow) => `${sizeRow.size} x${sizeRow.quantity}`)
                          .join(" | ")}
                      </p>
                    </div>
                  ))}
                </div>
              ) : null}
              {selectedDraft.notes ? <p className={styles.notes}>{selectedDraft.notes}</p> : null}
              {selectedDraft.photos?.length ? (
                <div className={styles.downloadGrid}>
                  {selectedDraft.photos.map((photo, index) => (
                    <figure className={styles.downloadPhoto} key={`${selectedDraft.id}-${index}`}>
                      <img src={photo} alt={`${selectedDraft.productName} ${index + 1}`} />
                      <a href={photo} download={`${selectedDraft.sku || selectedDraft.productName}-foto-${index + 1}.jpg`}>
                        Descargar foto
                      </a>
                    </figure>
                  ))}
                </div>
              ) : (
                <p className={styles.empty}>Este producto no tiene fotos.</p>
              )}
            </article>
          ) : null}
        </section>
      )}
    </main>
  );
}
