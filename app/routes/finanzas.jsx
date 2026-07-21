import styles from "../styles/finanzas.module.css";

const currencyFormatter = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
});

export const headers = () => ({
  "Cache-Control": "no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow",
});

export default function FinanzasPortal() {
  const totals = {
    salesTotal: 0,
    averageTicket: 0,
    operatingCostTotal: 0,
    shippingTotal: 0,
    taxesTotal: 0,
    recoveredCostTotal: 0,
    profitTotal: 0,
  };

  return (
    <main className={styles.publicShell}>
      <div className={styles.publicHeader}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>CAR</span>
          <div>
            <strong>CARIANA</strong>
            <small>Finanzas</small>
          </div>
        </div>
      </div>

      <div className={styles.wrap}>
        <section className={styles.hero}>
          <div>
            <h1>Control financiero</h1>
          </div>
        </section>

        <section className={styles.metrics} aria-label="Resumen financiero">
          <article className={`${styles.metric} ${styles.metricSales}`}>
            <span>Ventas</span>
            <strong>{currencyFormatter.format(totals.salesTotal)}</strong>
          </article>
          <article className={`${styles.metric} ${styles.metricTicket}`}>
            <span>Ticket promedio</span>
            <strong>{currencyFormatter.format(totals.averageTicket)}</strong>
          </article>
          <article className={`${styles.metric} ${styles.metricOperatingCost}`}>
            <span>Costo operativo</span>
            <strong>{currencyFormatter.format(totals.operatingCostTotal)}</strong>
          </article>
          <article className={`${styles.metric} ${styles.metricShipping}`}>
            <span>Paqueteria</span>
            <strong>{currencyFormatter.format(totals.shippingTotal)}</strong>
          </article>
          <article className={`${styles.metric} ${styles.metricTaxes}`}>
            <span>Impuestos</span>
            <strong>{currencyFormatter.format(totals.taxesTotal)}</strong>
          </article>
          <article className={`${styles.metric} ${styles.metricRecovered}`}>
            <span>Costo recuperado</span>
            <strong>{currencyFormatter.format(totals.recoveredCostTotal)}</strong>
          </article>
          <article className={`${styles.metric} ${styles.metricProfit}`}>
            <span>Ganancias</span>
            <strong>{currencyFormatter.format(totals.profitTotal)}</strong>
          </article>
        </section>
      </div>
    </main>
  );
}
