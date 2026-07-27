import { useEffect, useMemo, useState } from "react";
import { Form, redirect, useActionData, useLoaderData, useNavigation, useSearchParams } from "react-router";
import prisma from "../db.server";
import styles from "../styles/stock.module.css";

const MAX_STOCK_PHOTOS = 8;
const MAX_STOCK_PHOTO_CHARS = 1_250_000;
const STOCK_AUDIENCES = [
  { value: "hombre", label: "Hombre", code: "H" },
  { value: "mujer", label: "Mujer", code: "M" },
];
const STOCK_GARMENTS = [
  { value: "playera", label: "Playera", code: "PL", section: "Parte superior" },
  { value: "camisa", label: "Camisa", code: "CA", section: "Parte superior" },
  { value: "chamarra", label: "Chamarra", code: "CH", section: "Parte superior" },
  { value: "sudadera", label: "Sudadera", code: "SU", section: "Parte superior" },
  { value: "blusa", label: "Blusa", code: "BL", section: "Parte superior" },
  { value: "vestido", label: "Vestido", code: "VE", section: "Parte superior" },
  { value: "pantalon", label: "Pantalon", code: "PA", section: "Parte inferior" },
  { value: "short", label: "Short", code: "SH", section: "Parte inferior" },
  { value: "tenis", label: "Tenis", code: "TE", section: "Parte inferior" },
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
  const highestNumber = existingSkus.reduce((highest, sku) => {
    const match = String(sku || "").trim().match(matcher);
    return match ? Math.max(highest, Number(match[1] || 0)) : highest;
  }, 0);
  return `${prefix}-${String(highestNumber + 1).padStart(3, "0")}`;
}

function defaultStockLocation(audience) {
  return `${audienceConfig(audience).code}-A`;
}

function nextStockLocation(currentLocation, audience) {
  const audienceCode = audienceConfig(audience).code;
  const match = String(currentLocation || "").trim().toUpperCase().match(/^([HM])-([A-Z])(\d+)?$/);
  const currentLetter = match?.[1] === audienceCode ? match[2] : "A";
  const currentRound = match?.[1] === audienceCode ? Math.max(1, Number(match[3] || 1)) : 1;
  if (currentLetter === "Z") {
    return `${audienceCode}-A${currentRound + 1}`;
  }
  const nextLetter = String.fromCharCode(currentLetter.charCodeAt(0) + 1);
  return `${audienceCode}-${nextLetter}${currentRound > 1 ? currentRound : ""}`;
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

function serializeDraft(draft) {
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
  const locationByAudience = Object.fromEntries(
    STOCK_AUDIENCES.map((audience) => {
      const location = locationRows.find((row) => row.audience === audience.value)?.currentLocation;
      return [audience.value, location || defaultStockLocation(audience.value)];
    }),
  );

  return {
    shop,
    drafts: drafts.map(serializeDraft),
    audiences: STOCK_AUDIENCES,
    garments: STOCK_GARMENTS,
    nextSkuByCategory,
    locationByAudience,
    error,
  };
}

export async function action({ request }) {
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "").trim();
  const shop = cleanShop(formData.get("shop")) || portalShopFromRequest(request);

  if (intent === "advance_stock_location") {
    const audience = normalizeAudience(formData.get("audience"));
    const currentLocation =
      sanitizeText(formData.get("currentLocation"), 24) || defaultStockLocation(audience);
    const nextLocation = nextStockLocation(currentLocation, audience);
    await prisma.stockLocationState.upsert({
      where: { shop_audience: { shop, audience } },
      create: { shop, audience, currentLocation: nextLocation },
      update: { currentLocation: nextLocation },
    });
    return redirect(`/stock?shop=${encodeURIComponent(shop)}`);
  }

  if (intent !== "create_stock_draft") {
    return { ok: false, error: "Accion no reconocida." };
  }

  const productName = sanitizeText(formData.get("productName"));
  if (!productName) return { ok: false, error: "Escribe el nombre del producto." };

  const audience = normalizeAudience(formData.get("audience"));
  const garmentType = normalizeGarment(formData.get("garmentType"));
  const quantity = Math.max(1, Math.min(9999, Number(formData.get("quantity") || 1) || 1));
  const price = Math.max(0, Number(formData.get("price") || 0) || 0);
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
    where: { shop_audience: { shop, audience } },
  });
  const locationCode = locationState?.currentLocation || defaultStockLocation(audience);

  await prisma.stockProductDraft.create({
    data: {
      shop,
      productName,
      audience,
      garmentType,
      locationCode,
      color: sanitizeText(formData.get("color"), 80) || null,
      size: sanitizeText(formData.get("size"), 80) || null,
      quantity,
      sku,
      price,
      notes: sanitizeText(formData.get("notes"), 600) || null,
      photos,
      status: "pendiente",
    },
  });

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
  const { shop, drafts, error, audiences, garments, nextSkuByCategory, locationByAudience } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState(searchParams.get("guardado") ? "pendientes" : "capturar");
  const [photos, setPhotos] = useState([]);
  const [selectedDraftId, setSelectedDraftId] = useState(drafts[0]?.id || 0);
  const [selectedAudience, setSelectedAudience] = useState(audiences?.[0]?.value || "hombre");
  const [selectedGarment, setSelectedGarment] = useState(garments?.[0]?.value || "playera");
  const [captureStep, setCaptureStep] = useState("audience");
  const isSubmitting = navigation.state !== "idle";
  const suggestedSku =
    nextSkuByCategory?.[`${selectedAudience}:${selectedGarment}`] ||
    nextStockSkuForPrefix(stockSkuPrefix(selectedAudience, selectedGarment), []);
  const suggestedLocation = locationByAudience?.[selectedAudience] || defaultStockLocation(selectedAudience);
  const selectedDraft = useMemo(
    () => drafts.find((draft) => Number(draft.id) === Number(selectedDraftId)) || drafts[0] || null,
    [drafts, selectedDraftId],
  );

  useEffect(() => {
    if (searchParams.get("guardado")) {
      setActiveTab("pendientes");
      setPhotos([]);
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
  }

  const garmentGroups = useMemo(() => {
    return (garments || STOCK_GARMENTS).reduce((groups, garment) => {
      const section = garment.section || "Productos";
      return {
        ...groups,
        [section]: [...(groups[section] || []), garment],
      };
    }, {});
  }, [garments]);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p>Cariana</p>
          <h1>Portal stock</h1>
        </div>
      </header>

      <section className={styles.tabs} aria-label="Secciones de stock">
        <button
          className={`${styles.tabButton} ${activeTab === "capturar" ? styles.tabButtonActive : ""}`}
          type="button"
          onClick={() => setActiveTab("capturar")}
        >
          Capturar
        </button>
        <button
          className={`${styles.tabButton} ${activeTab === "pendientes" ? styles.tabButtonActive : ""}`}
          type="button"
          onClick={() => setActiveTab("pendientes")}
        >
          Pendientes {drafts.length}
        </button>
      </section>

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
                  Cambiar
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
              <div className={styles.stepSummary}>
                <div>
                  <span>Persona</span>
                  <strong>{audienceConfig(selectedAudience).label}</strong>
                </div>
                <div>
                  <span>Producto</span>
                  <strong>{garmentConfig(selectedGarment).label}</strong>
                </div>
                <button className={styles.textButton} type="button" onClick={() => setCaptureStep("product")}>
                  Cambiar producto
                </button>
              </div>

              <Form method="post" className={styles.locationForm}>
                <input type="hidden" name="intent" value="advance_stock_location" />
                <input type="hidden" name="shop" value={shop} />
                <input type="hidden" name="audience" value={selectedAudience} />
                <input type="hidden" name="currentLocation" value={suggestedLocation} />
                <div>
                  <span>Ubicacion sugerida</span>
                  <strong>{suggestedLocation}</strong>
                </div>
                <button className={styles.secondaryButton} type="submit" disabled={isSubmitting}>
                  Marcar llena y usar siguiente
                </button>
              </Form>

              <Form method="post" className={styles.form}>
                <input type="hidden" name="intent" value="create_stock_draft" />
                <input type="hidden" name="shop" value={shop} />
                <input type="hidden" name="audience" value={selectedAudience} />
                <input type="hidden" name="garmentType" value={selectedGarment} />
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

                <label>
                  Nombre del producto
                  <input name="productName" placeholder="Ej. Playera vaquera" required />
                </label>
                <div className={styles.twoColumns}>
                  <label>
                    Color
                    <input name="color" placeholder="Azul" />
                  </label>
                  <label>
                    Talla
                    <input name="size" placeholder="CH / M / G" />
                  </label>
                </div>
                <div className={styles.twoColumns}>
                  <label>
                    Cantidad
                    <input min="1" name="quantity" inputMode="numeric" type="number" defaultValue="1" />
                  </label>
                </div>
                <label>
                  Precio
                  <input min="0" name="price" inputMode="decimal" step="0.01" type="number" placeholder="0.00" />
                </label>
                <label>
                  Notas
                  <textarea name="notes" rows="3" placeholder="Detalle opcional del producto" />
                </label>

                <button className={styles.primaryButton} type="submit" disabled={isSubmitting}>
                  {isSubmitting ? "Guardando..." : "Listo"}
                </button>
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
