import { createCookie, Form, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import prisma from "../db.server";
import styles from "../styles/repartidor.module.css";

function preparerPortalCookies() {
  const options = {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 26,
    secrets: [process.env.SHOPIFY_API_SECRET || "preparer-daily-access"],
  };
  return {
    accessCookie: createCookie("preparer_daily_access_v1", options),
  };
}

function cleanShop(value) {
  return String(value || "").trim().toLowerCase();
}

async function getPreparerAccess(request) {
  const { accessCookie } = preparerPortalCookies();
  const cookieHeader = request.headers.get("Cookie");
  const access = await accessCookie.parse(cookieHeader);
  if (!access?.shop || !access?.preparerId) return null;
  const preparer = await prisma.preparer.findFirst({
    where: {
      id: Number(access.preparerId),
      shop: cleanShop(access.shop),
    },
    select: { id: true, shop: true, name: true },
  });
  return preparer || null;
}

export const headers = () => ({
  "Cache-Control": "no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow",
});

export async function loader({ request }) {
  const url = new URL(request.url);
  const shop = cleanShop(url.searchParams.get("shop"));
  const access = await getPreparerAccess(request);
  const assignments = access
    ? await prisma.preparerAssignment.findMany({
        where: {
          shop: access.shop,
          preparerId: access.id,
        },
        orderBy: [{ sequence: "asc" }, { id: "asc" }],
      })
    : [];
  return {
    shop: access?.shop || shop,
    preparerName: access?.name || "",
    isLoggedIn: Boolean(access),
    assignments,
  };
}

export async function action({ request }) {
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const url = new URL(request.url);
  const shop = cleanShop(formData.get("shop") || url.searchParams.get("shop"));
  const { accessCookie } = preparerPortalCookies();

  if (intent === "logout") {
    return redirect(`/preparador${shop ? `?shop=${encodeURIComponent(shop)}` : ""}`, {
      headers: {
        "Set-Cookie": await accessCookie.serialize("", { maxAge: 0 }),
      },
    });
  }

  if (intent === "preparer_mark_ready" || intent === "preparer_mark_not_located") {
    const access = await getPreparerAccess(request);
    if (!access) return { ok: false, error: "Inicia sesion nuevamente." };
    const assignmentId = Number(formData.get("assignmentId") || 0);
    if (!assignmentId) return { ok: false, error: "Orden invalida." };
    await prisma.preparerAssignment.updateMany({
      where: {
        id: assignmentId,
        shop: access.shop,
        preparerId: access.id,
      },
      data: {
        status: intent === "preparer_mark_ready" ? "ready" : "not_located",
        completedAt: new Date(),
      },
    });
    return redirect(`/preparador?shop=${encodeURIComponent(access.shop)}`);
  }

  const code = String(formData.get("code") || "").trim();
  if (!shop) return { ok: false, error: "Falta la tienda para validar el acceso." };
  if (!/^\d{6}$/.test(code)) return { ok: false, error: "Ingresa tu codigo de 6 digitos." };

  const preparer = await prisma.preparer.findFirst({
    where: { shop, code },
    select: { id: true, shop: true, name: true },
  });
  if (!preparer) return { ok: false, error: "Codigo invalido." };

  return redirect(`/preparador?shop=${encodeURIComponent(shop)}`, {
    headers: {
      "Set-Cookie": await accessCookie.serialize({
        shop,
        preparerId: preparer.id,
      }),
    },
  });
}

function preparerStatusLabel(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "ready") return "listo";
  if (normalized === "not_located") return "no localizado";
  return "pendiente";
}

export default function PreparerPortal() {
  const { shop, preparerName, isLoggedIn, assignments = [] } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  if (isLoggedIn) {
    return (
      <main className={styles.page}>
        <div className={styles.container}>
          <header className={styles.header}>
            <div>
              <p className={styles.eyebrow}>Portal del preparador</p>
              <h1 className={styles.title}>Cariana preparadores</h1>
              <p className={styles.subtitle}>
                {preparerName ? `Preparador: ${preparerName}` : "Ordenes asignadas para preparacion."}
              </p>
            </div>
            <Form method="post">
              <input type="hidden" name="intent" value="logout" />
              <input type="hidden" name="shop" value={shop || ""} />
              <button className={styles.accessButton} type="submit" disabled={isSubmitting}>
                Cerrar sesion
              </button>
            </Form>
          </header>

          <div className={styles.preparerSummary}>
            <span className={styles.counterBadge}>Ordenes {assignments.length}</span>
          </div>

          {assignments.length ? (
            <div className={styles.preparerGrid}>
              {assignments.map((assignment) => {
                const order = assignment.orderData || {};
                const items = Array.isArray(order.items) ? order.items : [];
                const status = String(assignment.status || "assigned").trim().toLowerCase();
                const isCompleted = status === "ready" || status === "not_located";
                return (
                  <article key={assignment.id} className={styles.card}>
                    <div className={styles.cardHeader}>
                      <div>
                        <p className={styles.eyebrow}>Orden #{order.orderNumber || assignment.orderNumber || "-"}</p>
                        <h2 className={styles.cardTitle}>{order.customerName || "Cliente"}</h2>
                      </div>
                      <span className={`${styles.counterBadge} ${styles.preparerStatusBadge}`}>
                        {preparerStatusLabel(status)}
                      </span>
                    </div>
                    <div className={styles.preparerProductList}>
                      {items.length ? (
                        items.map((item, index) => (
                          <div key={`${item.lineItemId || item.id || item.title || "item"}-${index}`} className={styles.preparerProductItem}>
                            {item.imageUrl ? (
                              <img
                                className={styles.preparerProductImage}
                                src={item.imageUrl}
                                alt={item.imageAlt || item.title || "Producto"}
                              />
                            ) : (
                              <span className={styles.preparerProductImagePlaceholder} />
                            )}
                            <div className={styles.preparerProductCopy}>
                              <strong>{item.title || "Producto"}</strong>
                              {item.variantSummary ? <span>{item.variantSummary}</span> : null}
                              <span>Cantidad: {Math.max(1, Number(item.quantity || 1))}</span>
                            </div>
                          </div>
                        ))
                      ) : (
                        <p className={styles.subtitle}>No hay productos registrados para esta orden.</p>
                      )}
                    </div>
                    <div className={styles.preparerActions}>
                      <Form method="post">
                        <input type="hidden" name="intent" value="preparer_mark_ready" />
                        <input type="hidden" name="assignmentId" value={assignment.id} />
                        <button className={styles.accessButton} type="submit" disabled={isSubmitting || isCompleted}>
                          Listo
                        </button>
                      </Form>
                      <Form method="post">
                        <input type="hidden" name="intent" value="preparer_mark_not_located" />
                        <input type="hidden" name="assignmentId" value={assignment.id} />
                        <button className={styles.missingButton} type="submit" disabled={isSubmitting || isCompleted}>
                          No localizado
                        </button>
                      </Form>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <section className={styles.card}>
              <p className={styles.subtitle}>Todavia no tienes ordenes asignadas para preparar.</p>
            </section>
          )}
          {actionData?.error ? <p className={styles.error}>{actionData.error}</p> : null}
        </div>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <div className={styles.accessContainer}>
        <section className={`${styles.card} ${styles.accessCard}`}>
          <p className={styles.eyebrow}>Portal del preparador</p>
          <h1 className={styles.cardTitle}>Ingresa tu codigo</h1>
          <p className={styles.subtitle}>Tu codigo es necesario para acceder a tus ordenes de preparacion.</p>
          <Form method="post" className={styles.accessForm}>
            <input type="hidden" name="shop" value={shop || ""} />
            <input
              className={styles.accessInput}
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              required
            />
            <button className={styles.accessButton} type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Validando..." : "Entrar"}
            </button>
          </Form>
          {actionData?.error ? <p className={styles.error}>{actionData.error}</p> : null}
        </section>
      </div>
    </main>
  );
}
