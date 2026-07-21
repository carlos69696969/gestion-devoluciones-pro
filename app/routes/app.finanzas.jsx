import { useEffect, useMemo, useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import styles from "../styles/finanzas.module.css";

const STORAGE_KEY = "cariana_finance_transactions_v1";
const currencyFormatter = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
});

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function currentMonthValue() {
  return todayIsoDate().slice(0, 7);
}

function readStoredTransactions() {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function writeStoredTransactions(transactions) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(transactions));
}

function makeId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export default function FinanzasPortal() {
  const [transactions, setTransactions] = useState([]);
  const [month, setMonth] = useState(currentMonthValue);
  const [form, setForm] = useState({
    type: "sale",
    date: todayIsoDate(),
    concept: "",
    method: "Shopify",
    amount: "",
  });

  useEffect(() => {
    setTransactions(readStoredTransactions());
  }, []);

  useEffect(() => {
    writeStoredTransactions(transactions);
  }, [transactions]);

  const visibleTransactions = useMemo(
    () =>
      transactions
        .filter((transaction) => String(transaction.date || "").slice(0, 7) === month)
        .sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))),
    [transactions, month],
  );

  const totals = useMemo(() => {
    const sales = visibleTransactions.filter((transaction) => transaction.type === "sale");
    const expenses = visibleTransactions.filter((transaction) => transaction.type === "expense");
    const salesTotal = sales.reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
    const expensesTotal = expenses.reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
    return {
      salesTotal,
      expensesTotal,
      profitTotal: salesTotal - expensesTotal,
      averageTicket: sales.length ? salesTotal / sales.length : 0,
    };
  }, [visibleTransactions]);

  function updateForm(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function saveTransaction(event) {
    event.preventDefault();
    const amount = Number(form.amount || 0);
    if (!form.concept.trim() || !form.date || !Number.isFinite(amount) || amount <= 0) return;
    setTransactions((current) => [
      ...current,
      {
        id: makeId(),
        type: form.type,
        date: form.date,
        concept: form.concept.trim(),
        method: form.method,
        amount,
      },
    ]);
    setForm({
      type: "sale",
      date: todayIsoDate(),
      concept: "",
      method: "Shopify",
      amount: "",
    });
  }

  function addExampleTransactions() {
    const date = todayIsoDate();
    setTransactions((current) => [
      ...current,
      { id: makeId(), type: "sale", date, concept: "Venta Shopify", method: "Shopify", amount: 1280 },
      { id: makeId(), type: "sale", date, concept: "Venta en tienda", method: "Efectivo", amount: 640 },
      { id: makeId(), type: "expense", date, concept: "Envios", method: "Transferencia", amount: 210 },
      { id: makeId(), type: "expense", date, concept: "Empaque", method: "Tarjeta", amount: 155 },
    ]);
  }

  function clearVisibleTransactions() {
    setTransactions((current) => current.filter((transaction) => String(transaction.date || "").slice(0, 7) !== month));
  }

  function deleteTransaction(id) {
    setTransactions((current) => current.filter((transaction) => transaction.id !== id));
  }

  return (
    <s-page heading="Control financiero">
      <div className={styles.wrap}>
        <section className={styles.hero}>
          <div>
            <h1>Control financiero</h1>
            <p>Ventas, costos operativos y ganancia del negocio en una sola vista.</p>
          </div>
          <div className={styles.filters}>
            <label className={styles.label}>
              Mes
              <input className={styles.input} type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
            </label>
            <button className={styles.btn} type="button" onClick={addExampleTransactions}>
              Agregar ejemplo
            </button>
          </div>
        </section>

        <section className={styles.metrics} aria-label="Resumen financiero">
          <article className={`${styles.metric} ${styles.metricSales}`}>
            <span>Ventas</span>
            <strong>{currencyFormatter.format(totals.salesTotal)}</strong>
          </article>
          <article className={`${styles.metric} ${styles.metricExpenses}`}>
            <span>Costos operativos</span>
            <strong>{currencyFormatter.format(totals.expensesTotal)}</strong>
          </article>
          <article className={`${styles.metric} ${styles.metricProfit}`}>
            <span>Ganacia</span>
            <strong>{currencyFormatter.format(totals.profitTotal)}</strong>
          </article>
          <article className={`${styles.metric} ${styles.metricTicket}`}>
            <span>Ticket promedio</span>
            <strong>{currencyFormatter.format(totals.averageTicket)}</strong>
            <small>Solo ventas</small>
          </article>
        </section>

        <section className={styles.contentGrid}>
          <div className={styles.panel}>
            <div className={styles.panelHead}>
              <h2>Movimientos</h2>
              <button className={`${styles.btn} ${styles.btnDanger}`} type="button" onClick={clearVisibleTransactions}>
                Limpiar lista
              </button>
            </div>
            {visibleTransactions.length ? (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>Tipo</th>
                      <th>Concepto</th>
                      <th>Metodo</th>
                      <th>Monto</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleTransactions.map((transaction) => (
                      <tr key={transaction.id}>
                        <td>{transaction.date}</td>
                        <td>
                          <span className={`${styles.pill} ${transaction.type === "sale" ? styles.pillSale : styles.pillExpense}`}>
                            {transaction.type === "sale" ? "Venta" : "Costo"}
                          </span>
                        </td>
                        <td>{transaction.concept}</td>
                        <td>{transaction.method}</td>
                        <td>{currencyFormatter.format(Number(transaction.amount || 0))}</td>
                        <td>
                          <button className={`${styles.btn} ${styles.btnDanger}`} type="button" onClick={() => deleteTransaction(transaction.id)}>
                            Eliminar
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className={styles.empty}>Todavia no hay movimientos para este mes.</div>
            )}
          </div>

          <aside className={styles.panel}>
            <div className={styles.panelHead}>
              <h2>Registrar movimiento</h2>
            </div>
            <form className={styles.formGrid} onSubmit={saveTransaction}>
              <label className={styles.label}>
                Tipo
                <select className={styles.input} value={form.type} onChange={(event) => updateForm("type", event.target.value)}>
                  <option value="sale">Venta</option>
                  <option value="expense">Costo operativo</option>
                </select>
              </label>
              <label className={styles.label}>
                Fecha
                <input className={styles.input} type="date" value={form.date} onChange={(event) => updateForm("date", event.target.value)} />
              </label>
              <label className={`${styles.label} ${styles.wide}`}>
                Concepto
                <input
                  className={styles.input}
                  value={form.concept}
                  onChange={(event) => updateForm("concept", event.target.value)}
                  placeholder="Ej. Venta Shopify, renta, envio"
                />
              </label>
              <label className={styles.label}>
                Metodo
                <select className={styles.input} value={form.method} onChange={(event) => updateForm("method", event.target.value)}>
                  <option>Shopify</option>
                  <option>Efectivo</option>
                  <option>Transferencia</option>
                  <option>Tarjeta</option>
                  <option>Otro</option>
                </select>
              </label>
              <label className={styles.label}>
                Monto
                <input
                  className={styles.input}
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.amount}
                  onChange={(event) => updateForm("amount", event.target.value)}
                  placeholder="0.00"
                />
              </label>
              <div className={`${styles.actions} ${styles.wide}`}>
                <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit">
                  Guardar movimiento
                </button>
              </div>
            </form>
          </aside>
        </section>
      </div>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
