/* eslint-disable react/prop-types */
import { useState } from "react";
import { Form, useActionData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import styles from "../styles/admin.module.css";

const STATUS_LABEL = {
  pendiente: "pendiente",
  en_revision: "en revision",
  aprobada: "aprobada",
  intento_fallido_1: "intento de devolucion fallido",
  intento_fallido_2: "segundo intento de devolucion fallido",
  por_devolver: "pendiente por devolver",
  rechazada: "rechazada",
  denegada: "reembolso denegado",
  reembolso_denegado: "reembolso denegado",
  recibida: "recibida",
  reembolsada: "reembolsada",
  completada: "completada",
};

const HISTORY_STATUSES = new Set(["reembolsada", "rechazada", "denegada", "reembolso_denegado"]);
const RETURNED_TO_CUSTOMER_KIND = "returned_to_customer";

function normalizeOrderNumber(value) {
  return String(value || "")
    .trim()
    .replace(/^#/, "");
}

function toMoney(value) {
  return Number(value || 0).toFixed(2);
}

function parsePhotoUrls(rawValue) {
  if (!rawValue) return [];
  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed.filter(Boolean).slice(0, 2) : [];
  } catch {
    return [String(rawValue)].filter(Boolean);
  }
}

function parseReasonEntries(rawValue) {
  const text = String(rawValue || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    return entries
      .map((entry) => ({
        kind: String(entry?.kind || "").trim() || "legacy",
        reason: String(entry?.reason || "").trim(),
        at: entry?.at ? String(entry.at) : "",
      }))
      .filter((entry) => entry.reason);
  } catch {
    return [{ kind: "legacy", reason: text, at: "" }];
  }
}

function isReturnedToCustomerEntry(entry) {
  return String(entry?.kind || "").toLowerCase() === RETURNED_TO_CUSTOMER_KIND;
}

function latestReasonFromRaw(rawValue) {
  const entries = parseReasonEntries(rawValue);
  for (let idx = entries.length - 1; idx >= 0; idx -= 1) {
    if (isReturnedToCustomerEntry(entries[idx])) continue;
    return entries[idx]?.reason || "";
  }
  return "";
}

function latestReturnedToCustomerAtFromRaw(rawValue) {
  const entries = parseReasonEntries(rawValue);
  for (let idx = entries.length - 1; idx >= 0; idx -= 1) {
    if (!isReturnedToCustomerEntry(entries[idx])) continue;
    return String(entries[idx]?.at || "").trim();
  }
  return "";
}

function reasonEntryLabel(entry) {
  const kind = String(entry?.kind || "").toLowerCase();
  if (kind === "attempt_failed_1") return "Intento de recoleccion fallido (1 de 2)";
  if (kind === "attempt_failed_2") return "Intento de recoleccion fallido (2 de 2)";
  if (kind === "rejected_after_attempts") return "Motivo de rechazo final";
  if (kind === "review_rejected") return "Motivo de rechazo";
  if (kind === "denied_after_received") return "Motivo de denegacion";
  if (kind === RETURNED_TO_CUSTOMER_KIND) return "Devuelto al cliente";
  return "Motivo";
}

function getStatusClassName(status) {
  if (status === "en_revision") return "statusReview";
  if (status === "aprobada") return "statusApproved";
  if (status === "intento_fallido_1" || status === "intento_fallido_2") return "statusAttemptFailed";
  if (status === "por_devolver") return "statusPendingReturn";
  if (status === "rechazada") return "statusRejected";
  if (status === "reembolso_denegado") return "statusDenied";
  if (status === "recibida") return "statusReceived";
  if (status === "reembolsada") return "statusRefunded";
  if (status === "denegada") return "statusDenied";
  return "statusDefault";
}

function itemKeyFromRecord(item) {
  const lineItemId = String(item?.lineItemId || "").trim();
  if (lineItemId) return `line:${lineItemId}`;
  const variantId = String(item?.variantId || "").trim();
  if (variantId) return `variant:${variantId}`;
  const productId = String(item?.productId || "").trim();
  if (productId) return `product:${productId}`;
  return `title:${String(item?.title || "").trim().toLowerCase()}`;
}

function putImageCandidate(map, key, imageUrl, imageAlt) {
  if (!key || !imageUrl || map[key]) return;
  map[key] = { imageUrl, imageAlt: imageAlt || "" };
}

async function fetchOrderItemImageMaps(admin, orderIds) {
  const uniqueIds = Array.from(new Set(orderIds.filter(Boolean)));
  if (!uniqueIds.length) return {};

  try {
    const response = await admin.graphql(
      `#graphql
      query OrdersForReturnImages($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Order {
            id
            lineItems(first: 100) {
              edges {
                node {
                  id
                  title
                  variant {
                    id
                    image {
                      url
                      altText
                    }
                  }
                  product {
                    id
                    featuredImage {
                      url
                      altText
                    }
                  }
                }
              }
            }
          }
        }
      }`,
      { variables: { ids: uniqueIds } },
    );
    const payload = await response.json();
    const nodes = payload?.data?.nodes || [];
    const byOrder = {};

    for (const orderNode of nodes) {
      const orderId = String(orderNode?.id || "").trim();
      if (!orderId) continue;
      const imageMap = {};
      const edges = Array.isArray(orderNode?.lineItems?.edges) ? orderNode.lineItems.edges : [];
      for (const edge of edges) {
        const lineNode = edge?.node;
        if (!lineNode) continue;
        const lineItemId = String(lineNode.id || "").trim();
        const lineTitle = String(lineNode.title || "").trim().toLowerCase();
        const variantId = String(lineNode?.variant?.id || "").trim();
        const productId = String(lineNode?.product?.id || "").trim();
        const variantImageUrl = String(lineNode?.variant?.image?.url || "").trim();
        const variantImageAlt = String(lineNode?.variant?.image?.altText || "").trim();
        const productImageUrl = String(lineNode?.product?.featuredImage?.url || "").trim();
        const productImageAlt = String(lineNode?.product?.featuredImage?.altText || "").trim();
        const chosenUrl = variantImageUrl || productImageUrl;
        const chosenAlt = variantImageAlt || productImageAlt;

        putImageCandidate(imageMap, lineItemId ? `line:${lineItemId}` : "", chosenUrl, chosenAlt);
        putImageCandidate(imageMap, variantId ? `variant:${variantId}` : "", chosenUrl, chosenAlt);
        putImageCandidate(imageMap, productId ? `product:${productId}` : "", chosenUrl, chosenAlt);
        putImageCandidate(imageMap, lineTitle ? `title:${lineTitle}` : "", chosenUrl, chosenAlt);
      }
      byOrder[orderId] = imageMap;
    }

    return byOrder;
  } catch (error) {
    console.error("Error loading product images for portal results", error);
    return {};
  }
}

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "lookup") {
    try {
      const orderNumber = normalizeOrderNumber(formData.get("orderNumber"));
      if (!orderNumber) {
        return { ok: false, error: "Captura el numero de pedido." };
      }

      const requests = await prisma.returnRequest.findMany({
        where: {
          shop: session.shop,
          orderNumber,
        },
        include: {
          items: true,
        },
        orderBy: {
          createdAt: "desc",
        },
      });
      const imageMapsByOrder = await fetchOrderItemImageMaps(
        admin,
        requests.map((requestRow) => requestRow.shopifyOrderId),
      );

      return {
        ok: true,
        requests: requests.map((requestRow) => {
          const status = String(requestRow.status || "").toLowerCase();
          const reasonEntries = parseReasonEntries(requestRow.rejectionReason);
          const returnedToCustomerAt = latestReturnedToCustomerAtFromRaw(requestRow.rejectionReason);
          const imageMap = imageMapsByOrder[String(requestRow.shopifyOrderId || "").trim()] || {};
          return {
            id: requestRow.id,
            orderNumber: requestRow.orderNumber,
            customerName: requestRow.customerName,
            customerEmail: requestRow.customerEmail,
            customerPhone: requestRow.customerPhone || "",
            returnMethod: requestRow.returnMethod,
            returnCost: requestRow.returnCost,
            refundedSubtotal: requestRow.refundedSubtotal,
            estimatedRefund: requestRow.estimatedRefund,
            finalRefund: requestRow.finalRefund,
            status,
            createdAt: requestRow.createdAt?.toISOString() || null,
            updatedAt: requestRow.updatedAt?.toISOString() || null,
            receivedAt: requestRow.receivedAt?.toISOString() || null,
            refundedAt: requestRow.refundedAt?.toISOString() || null,
            branchAddress: requestRow.branchAddress || "",
            branchHours: requestRow.branchHours || "",
            pickupAddress: requestRow.pickupAddress || "",
            pickupCity: requestRow.pickupCity || "",
            pickupState: requestRow.pickupState || "",
            pickupPostalCode: requestRow.pickupPostalCode || "",
            pickupDate: requestRow.pickupDate || "",
            pickupNotes: requestRow.pickupNotes || "",
            reasonEntries,
            wasReturnedToCustomer: reasonEntries.some(isReturnedToCustomerEntry),
            returnedToCustomerAt: returnedToCustomerAt || null,
            rejectionReason: latestReasonFromRaw(requestRow.rejectionReason),
            items: requestRow.items.map((item) => ({
              id: item.id,
              lineItemId: item.lineItemId || "",
              productId: item.productId || "",
              variantId: item.variantId || "",
              title: item.title,
              quantity: item.quantity,
              reason: item.reason,
              details: item.details || "",
              photoDataUrl: item.photoDataUrl || "",
              imageUrl: imageMap[itemKeyFromRecord(item)]?.imageUrl || "",
              imageAlt: imageMap[itemKeyFromRecord(item)]?.imageAlt || "",
            })),
          };
        }),
      };
    } catch (error) {
      console.error("Error searching return requests by order number", error);
      return { ok: false, error: "No se pudo buscar la devolucion en este momento." };
    }
  }

  return { ok: false, error: "Accion no valida." };
};

export default function ReturnsPortal() {
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const requests = Array.isArray(actionData?.requests) ? actionData.requests : [];
  const hasResults = requests.length > 0;

  return (
    <s-page heading="Portal de devoluciones">
      <s-section heading="Buscar devolucion por numero de pedido">
        <Form method="post">
          <input type="hidden" name="intent" value="lookup" />
          <div className={styles.grid}>
            <label className={styles.label}>
              Numero de pedido
              <input className={styles.input} name="orderNumber" required placeholder="Ejemplo: 1011" />
            </label>
            <div className={styles.actions}>
              <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Buscando..." : "Buscar pedido"}
              </button>
            </div>
            {actionData?.error ? <p className={styles.errorMsg}>{actionData.error}</p> : null}
          </div>
        </Form>
      </s-section>

      {hasResults ? (
        <s-section heading={`Resultado${requests.length > 1 ? "s" : ""}`}>
          <div className={`${styles.wrap} ${styles.reqGrid}`}>
            {requests.map((request) => (
              <ResultCard key={request.id} request={request} />
            ))}
          </div>
        </s-section>
      ) : null}
    </s-page>
  );
}

function ResultCard({ request }) {
  const [viewerImage, setViewerImage] = useState(null);
  const status = String(request.status || "").toLowerCase();
  const statusClassName = styles[getStatusClassName(status)];
  const isHistoryStatus = HISTORY_STATUSES.has(status);
  const closedAt =
    status === "reembolsada" && request.refundedAt ? request.refundedAt : request.updatedAt || null;
  const isDeniedReturnedToCustomer = status === "reembolso_denegado" && request.wasReturnedToCustomer;

  return (
    <article className={styles.card}>
      <div className={styles.reqHeader}>
        <div>
          <h3 className={styles.reqTitle}>Pedido #{request.orderNumber}</h3>
          <p className={styles.meta}>
            {request.customerName} | {request.customerEmail} | {request.customerPhone || "-"}
          </p>
        </div>
        <span className={styles.pill}>
          Estado:{" "}
          <strong className={statusClassName}>
            {isDeniedReturnedToCustomer ? (
              <>
                reembolso denegado - <span className={styles.returnedToCustomerStatus}>devuelto al cliente</span>
              </>
            ) : (
              STATUS_LABEL[status] || status
            )}
          </strong>
        </span>
      </div>

      <details className={styles.details}>
        <summary className={styles.summary}>Ver orden</summary>

        <div className={styles.kv}>
          <div className={styles.kvRow}>
            <span className={styles.kvKey}>Metodo</span>
            <span className={styles.kvVal}>
              {request.returnMethod === "pickup" ? "Recoleccion a domicilio" : "Entrega en sucursal"}
            </span>
          </div>
          <div className={styles.kvRow}>
            <span className={styles.kvKey}>Subtotal (sin impuestos)</span>
            <span className={styles.kvVal}>${toMoney(request.refundedSubtotal || request.estimatedRefund)} MXN</span>
          </div>
          <div className={styles.kvRow}>
            <span className={styles.kvKey}>Costo devolucion</span>
            <span className={styles.kvVal}>${toMoney(request.returnCost)} MXN</span>
          </div>
          <div className={styles.kvRow}>
            <span className={styles.kvKey}>Reembolso final</span>
            <span className={styles.kvVal}>${toMoney(request.finalRefund)} MXN</span>
          </div>
          <div className={styles.kvRow}>
            <span className={styles.kvKey}>Fecha solicitud</span>
            <span className={styles.kvVal}>
              {request.createdAt ? new Date(request.createdAt).toLocaleString("es-MX") : "-"}
            </span>
          </div>
          {isHistoryStatus && closedAt ? (
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Fecha de cierre</span>
              <span className={styles.kvVal}>{new Date(closedAt).toLocaleString("es-MX")}</span>
            </div>
          ) : null}
          {request.receivedAt ? (
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Recibida</span>
              <span className={styles.kvVal}>{new Date(request.receivedAt).toLocaleString("es-MX")}</span>
            </div>
          ) : null}
          {request.returnedToCustomerAt ? (
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Devuelta al cliente</span>
              <span className={styles.kvVal}>{new Date(request.returnedToCustomerAt).toLocaleString("es-MX")}</span>
            </div>
          ) : null}
          {request.refundedAt ? (
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Reembolsada</span>
              <span className={styles.kvVal}>{new Date(request.refundedAt).toLocaleString("es-MX")}</span>
            </div>
          ) : null}
        </div>

        {request.returnMethod === "pickup" ? (
          <p className={styles.meta}>
            Recoleccion:{" "}
            {[request.pickupAddress, request.pickupCity, request.pickupState, request.pickupPostalCode]
              .filter(Boolean)
              .join(", ") || "-"}
            {" | "}Dia: {request.pickupDate || "-"}
            {request.pickupNotes ? ` | Notas: ${request.pickupNotes}` : ""}
          </p>
        ) : (
          <p className={styles.meta}>
            Sucursal: {request.branchAddress || "-"} | Horarios: {request.branchHours || "-"}
          </p>
        )}

        {request.reasonEntries?.length ? (
          <div className={styles.reasonHistory}>
            <p className={styles.reasonHistoryTitle}>Historial de motivos enviados</p>
            <ul className={styles.reasonHistoryList}>
              {request.reasonEntries.map((entry, idx) => (
                <li key={`${request.id}_reason_${idx}`} className={styles.reasonHistoryItem}>
                  <strong>{reasonEntryLabel(entry)}:</strong>{" "}
                  <span className={styles.reasonHistoryMessage}>{entry.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {!request.reasonEntries?.length && request.rejectionReason ? (
          <div className={styles.reasonHistory}>
            <p className={styles.reasonHistoryTitle}>Historial de motivos enviados</p>
            <ul className={styles.reasonHistoryList}>
              <li className={styles.reasonHistoryItem}>
                <strong>Motivo:</strong> <span className={styles.reasonHistoryMessage}>{request.rejectionReason}</span>
              </li>
            </ul>
          </div>
        ) : null}

        <h4 className={styles.orderDetailTitle}>Productos, motivos, fotos y descripcion</h4>
        <ul className={styles.productList}>
          {request.items.map((item) => {
            const photos = parsePhotoUrls(item.photoDataUrl);
            return (
              <li key={item.id} className={styles.productItem}>
                <div className={styles.productItemHeader}>
                  {item.imageUrl ? (
                    <button
                      type="button"
                      className={styles.imageButton}
                      onClick={() =>
                        setViewerImage({
                          src: item.imageUrl,
                          alt: item.imageAlt || item.title,
                        })
                      }
                    >
                      <img
                        src={item.imageUrl}
                        alt={item.imageAlt || item.title}
                        className={styles.productThumb}
                      />
                    </button>
                  ) : (
                    <div className={styles.productThumbPlaceholder} />
                  )}
                  <div className={styles.productCopy}>
                    <p className={styles.productLineTitle}>
                      {item.title} x{item.quantity}
                    </p>
                    <p className={styles.productLineMeta}>Motivo: {item.reason}</p>
                  </div>
                </div>
                {item.details ? <p className={styles.productLineMeta}>Descripcion: {item.details}</p> : null}
                {photos.length ? (
                  <div className={styles.evidencePhotos}>
                    {photos.map((src, idx) => (
                      <button
                        key={`${item.id}_${idx}`}
                        type="button"
                        className={styles.evidenceLink}
                        onClick={() =>
                          setViewerImage({
                            src,
                            alt: `Evidencia ${idx + 1}`,
                          })
                        }
                      >
                        <img src={src} alt={`Evidencia ${idx + 1}`} className={styles.evidencePhoto} />
                        <span>Foto {idx + 1}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </details>

      {viewerImage?.src ? (
        <div className={styles.imageViewerOverlay} onClick={() => setViewerImage(null)} role="presentation">
          <div className={styles.imageViewerDialog} onClick={(event) => event.stopPropagation()} role="presentation">
            <img
              src={viewerImage.src}
              alt={viewerImage.alt || "Imagen"}
              className={styles.imageViewerImg}
            />
          </div>
        </div>
      ) : null}
    </article>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
