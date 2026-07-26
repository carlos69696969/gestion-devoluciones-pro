import { useEffect, useMemo, useState } from "react";
import { Form, redirect, useActionData, useLoaderData, useNavigation, useSearchParams } from "react-router";
import prisma from "../db.server";
import styles from "../styles/stock.module.css";

const MAX_STOCK_PHOTOS = 8;
const MAX_STOCK_PHOTO_CHARS = 1_250_000;

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
  const drafts = await prisma.stockProductDraft.findMany({
    where: { shop },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 80,
  });

  return {
    shop,
    drafts: drafts.map(serializeDraft),
  };
}

export async function action({ request }) {
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "").trim();
  const shop = cleanShop(formData.get("shop")) || portalShopFromRequest(request);

  if (intent !== "create_stock_draft") {
    return { ok: false, error: "Accion no reconocida." };
  }

  const productName = sanitizeText(formData.get("productName"));
  if (!productName) return { ok: false, error: "Escribe el nombre del producto." };

  const quantity = Math.max(1, Math.min(9999, Number(formData.get("quantity") || 1) || 1));
  const price = Math.max(0, Number(formData.get("price") || 0) || 0);
  const photos = formData
    .getAll("photos")
    .map(sanitizePhotoDataUrl)
    .filter(Boolean)
    .slice(0, MAX_STOCK_PHOTOS);

  await prisma.stockProductDraft.create({
    data: {
      shop,
      productName,
      color: sanitizeText(formData.get("color"), 80) || null,
      size: sanitizeText(formData.get("size"), 80) || null,
      quantity,
      sku: sanitizeText(formData.get("sku"), 80) || null,
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
  const { shop, drafts } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState(searchParams.get("guardado") ? "pendientes" : "capturar");
  const [photos, setPhotos] = useState([]);
  const [selectedDraftId, setSelectedDraftId] = useState(drafts[0]?.id || 0);
  const isSubmitting = navigation.state !== "idle";
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

      {actionData?.error ? <p className={styles.error}>{actionData.error}</p> : null}

      {activeTab === "capturar" ? (
        <section className={styles.card}>
          <Form method="post" className={styles.form}>
            <input type="hidden" name="intent" value="create_stock_draft" />
            <input type="hidden" name="shop" value={shop} />
            {photos.map((photo) => (
              <input key={photo.id} type="hidden" name="photos" value={photo.dataUrl} />
            ))}

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
              <label>
                SKU
                <input name="sku" placeholder="0001" />
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
                    <small>{draft.sku ? `SKU ${draft.sku}` : "Sin SKU"}</small>
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
