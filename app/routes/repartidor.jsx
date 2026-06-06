import { useLoaderData } from "react-router";
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
  const hasOrders = courierOrders.length > 0;

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
            <button type="button" className={`${styles.tabButton} ${styles.tabButtonActive}`}>
              Pedidos
            </button>
            <button type="button" className={styles.tabButton}>En ruta</button>
            <button type="button" className={styles.tabButton}>Historial</button>
          </div>

          {!hasOrders ? (
            <p className={styles.empty}>No hay ordenes pendientes por entregar.</p>
          ) : (
            <div className={adminStyles.courierGrid}>
              {courierOrders.map((request) => (
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
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
