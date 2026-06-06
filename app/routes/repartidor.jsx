import { useLoaderData } from "react-router";
import { useState } from "react";
import adminStyles from "../styles/admin.module.css";
import styles from "../styles/repartidor.module.css";
import {
  courierOrderTimestampMs,
  formatCourierAddress,
  formatCourierScheduledDate,
} from "../utils/courier.shared";
import {
  fetchCourierOrdersForShop,
  fetchPickupCourierOrders,
  resolveCourierPortalShop,
} from "../utils/courier.server";

export const headers = () => ({
  "Cache-Control": "no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow",
});

export const loader = async ({ request }) => {
  const { shop, sessionCandidates } = await resolveCourierPortalShop(request);

  if (!shop || !sessionCandidates?.length) {
    return {
      shop: shop || "",
      courierOrders: [],
      error:
        "No se encontro una sesion valida para la tienda. Verifica que la app siga instalada y que exista una sesion offline.",
    };
  }

  const [deliveryResult, pickupResult] = await Promise.allSettled([
    fetchCourierOrdersForShop({ shop, sessionCandidates }),
    fetchPickupCourierOrders(shop),
  ]);

  const deliveryOrders = deliveryResult.status === "fulfilled" ? deliveryResult.value : [];
  const pickupOrders = pickupResult.status === "fulfilled" ? pickupResult.value : [];
  const courierOrders = [...deliveryOrders, ...pickupOrders].sort(
    (a, b) => courierOrderTimestampMs(a) - courierOrderTimestampMs(b),
  );

  return {
    shop,
    courierOrders,
  };
};

export default function RepartidorPublicPortal() {
  const { shop, courierOrders } = useLoaderData();
  const [activeTab, setActiveTab] = useState("pedidos");
  const routeOrder = courierOrders[0] || null;
  const visibleOrders =
    activeTab === "en_ruta"
      ? routeOrder
        ? [routeOrder]
        : []
      : activeTab === "historial"
        ? []
        : courierOrders;
  const hasOrders = visibleOrders.length > 0;
  const isHistoryTab = activeTab === "historial";
  const emptyMessage =
    activeTab === "en_ruta" ? "No hay pedidos en ruta." : "No hay ordenes pendientes por entregar.";

  const buildMapsUrl = (request) => {
    const address = formatCourierAddress(request);
    const query = encodeURIComponent(address);
    return `https://www.google.com/maps/search/?api=1&query=${query}`;
  };

  const buildPhoneUrl = (request) => {
    const phone = String(request?.customerPhone || "").trim();
    const safePhone = phone.replace(/[^\d+]/g, "");
    return safePhone ? `tel:${safePhone}` : "";
  };

  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Portal publico</p>
            <h1 className={styles.title}>Ordenes repartidor</h1>
            <p className={styles.subtitle}>
              Vista publica y sin login para ver ordenes pendientes de entrega y devolucion.
            </p>
          </div>
          <div className={styles.shopBadge}>{shop ? `Tienda: ${shop}` : "Sin tienda detectada"}</div>
        </header>

        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Ordenes repartidor</h2>
          <div className={styles.tabRow} role="tablist" aria-label="Secciones de repartidor">
            <button
              type="button"
              className={`${styles.tabButton} ${activeTab === "pedidos" ? styles.tabButtonActive : ""}`}
              onClick={() => setActiveTab("pedidos")}
            >
              Pedidos
            </button>
            <button
              type="button"
              className={`${styles.tabButton} ${activeTab === "en_ruta" ? styles.tabButtonActive : ""}`}
              onClick={() => setActiveTab("en_ruta")}
            >
              En ruta
            </button>
            <button
              type="button"
              className={`${styles.tabButton} ${activeTab === "historial" ? styles.tabButtonActive : ""}`}
              onClick={() => setActiveTab("historial")}
            >
              Historial
            </button>
          </div>

          {isHistoryTab ? null : !hasOrders ? (
            <p className={styles.empty}>{emptyMessage}</p>
          ) : (
            <div className={adminStyles.courierGrid}>
              {visibleOrders.map((request) => (
                <article
                  key={request.id}
                  className={`${adminStyles.courierCard} ${
                    request.courierLabel === "Devolucion"
                      ? adminStyles.courierCardReturn
                      : adminStyles.courierCardDelivery
                  }`}
                >
                  <div className={adminStyles.courierHeader}>
                    <span
                      className={
                        request.courierLabel === "Devolucion"
                          ? adminStyles.courierBadgeReturn
                          : adminStyles.courierBadgeDelivery
                      }
                    >
                      {request.courierLabel}
                    </span>
                    <span className={adminStyles.courierBadgeStatus}>{request.status}</span>
                  </div>
                  <h3 className={adminStyles.courierOrderNumber}>#{request.orderNumber}</h3>
                  <p className={adminStyles.courierCustomerName}>{request.customerName}</p>
                  <p className={adminStyles.courierField}>
                    <strong>Programado:</strong> {formatCourierScheduledDate(request.pickupDate)}
                  </p>
                  <p className={adminStyles.courierAddress}>{formatCourierAddress(request)}</p>
                  <p className={adminStyles.courierField}>{request.customerPhone || "-"}</p>
                  {activeTab === "en_ruta" ? (
                    <div className={styles.actionRow}>
                      <a
                        className={`${styles.actionButton} ${styles.actionButtonPrimary}`}
                        href={buildMapsUrl(request)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Mapa
                      </a>
                      {buildPhoneUrl(request) ? (
                        <a
                          className={`${styles.actionButton} ${styles.actionButtonSecondary}`}
                          href={buildPhoneUrl(request)}
                        >
                          Telefono
                        </a>
                      ) : (
                        <button type="button" className={`${styles.actionButton} ${styles.actionButtonSecondary}`} disabled>
                          Telefono
                        </button>
                      )}
                      <button type="button" className={styles.actionButton}>
                        En ruta
                      </button>
                      <button type="button" className={styles.actionButton}>
                        Entregado
                      </button>
                      <button type="button" className={styles.actionButton}>
                        No entregado
                      </button>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
