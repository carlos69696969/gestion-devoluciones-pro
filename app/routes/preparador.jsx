import { useState } from "react";
import { createCookie, Form, redirect, useActionData, useLoaderData, useNavigation, useSearchParams } from "react-router";
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
    return redirect(`/preparador?shop=${encodeURIComponent(access.shop)}&tab=despachar`);
  }

  const code = String(formData.get("code") || "").replace(/\D/g, "").trim();
  if (!shop) return { ok: false, error: "Falta la tienda para validar el acceso." };
  if (!/^\d{6}$/.test(code)) return { ok: false, error: "Ingresa tu codigo de 6 digitos." };

  let preparer = await prisma.preparer.findFirst({
    where: { shop, code },
    select: { id: true, shop: true, name: true },
  });
  if (!preparer) {
    preparer = await prisma.preparer.findFirst({
      where: { code },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: { id: true, shop: true, name: true },
    });
  }
  if (!preparer) return { ok: false, error: "Codigo invalido." };

  return redirect(`/preparador?shop=${encodeURIComponent(preparer.shop)}`, {
    headers: {
      "Set-Cookie": await accessCookie.serialize({
        shop: preparer.shop,
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

function isPreparerAssignmentDone(status) {
  const normalized = String(status || "").trim().toLowerCase();
  return normalized === "ready" || normalized === "not_located";
}

function formatPreparerAddress(order) {
  return [
    order?.pickupAddress,
    order?.pickupNeighborhood,
    order?.pickupCity,
    order?.pickupState,
    order?.pickupPostalCode,
    order?.pickupCountry,
  ]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(", ");
}

function preparerOrderMark(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "ready") return "✓";
  if (normalized === "not_located") return "×";
  return "";
}

export default function PreparerPortal() {
  const { shop, preparerName, isLoggedIn, assignments = [] } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [enlargedImage, setEnlargedImage] = useState(null);
  const isSubmitting = navigation.state === "submitting";
  const requestedTab = String(searchParams.get("tab") || "ordenes").trim().toLowerCase();
  const activeTab = requestedTab === "despachar" ? "despachar" : "ordenes";
  const sortedAssignments = [...assignments].sort(
    (firstAssignment, secondAssignment) =>
      Number(firstAssignment.sequence || 0) - Number(secondAssignment.sequence || 0) ||
      Number(firstAssignment.id || 0) - Number(secondAssignment.id || 0),
  );
  const dispatchAssignment =
    sortedAssignments.find((assignment) => !isPreparerAssignmentDone(assignment.status)) ||
    sortedAssignments[0] ||
    null;

  const handleTabChange = (nextTab) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("tab", nextTab);
    if (shop) nextParams.set("shop", shop);
    setSearchParams(nextParams);
  };

  if (isLoggedIn) {
    const dispatchOrder = dispatchAssignment?.orderData || {};
    const dispatchItems = Array.isArray(dispatchOrder.items) ? dispatchOrder.items : [];
    const dispatchStatus = String(dispatchAssignment?.status || "assigned").trim().toLowerCase();
    const isDispatchCompleted = isPreparerAssignmentDone(dispatchStatus);
    const dispatchAddress = formatPreparerAddress(dispatchOrder);

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
            <span className={styles.counterBadge}>Ordenes {sortedAssignments.length}</span>
          </div>

          {sortedAssignments.length ? (
            <section className={styles.card}>
              <div className={styles.tabRow} role="tablist" aria-label="Secciones de preparador">
                <button
                  type="button"
                  className={`${styles.tabButton} ${activeTab === "ordenes" ? styles.tabButtonActive : ""}`}
                  onClick={() => handleTabChange("ordenes")}
                >
                  Ordenes
                </button>
                <button
                  type="button"
                  className={`${styles.tabButton} ${activeTab === "despachar" ? styles.tabButtonActive : ""}`}
                  onClick={() => handleTabChange("despachar")}
                >
                  Despachar
                </button>
              </div>

              {activeTab === "ordenes" ? (
                <div className={styles.preparerOrderChecklist}>
                  {sortedAssignments.map((assignment) => {
                    const order = assignment.orderData || {};
                    const status = String(assignment.status || "assigned").trim().toLowerCase();
                    return (
                      <div key={assignment.id} className={styles.preparerOrderCheckItem}>
                        <span className={styles.orderSequenceBadge}>{Number(assignment.sequence || 0) || ""}</span>
                        <span
                          className={`${styles.preparerCheckBox} ${
                            status === "ready"
                              ? styles.preparerCheckBoxReady
                              : status === "not_located"
                                ? styles.preparerCheckBoxMissing
                                : ""
                          }`}
                          aria-label={`Estado ${preparerStatusLabel(status)}`}
                        >
                          {preparerOrderMark(status)}
                        </span>
                        <strong>Orden #{order.orderNumber || assignment.orderNumber || "-"}</strong>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <article className={`${styles.card} ${styles.preparerDispatchCard}`}>
                  {dispatchAssignment ? (
                    <>
                      <div className={styles.cardHeader}>
                        <div>
                          <p className={styles.eyebrow}>
                            Orden {Number(dispatchAssignment.sequence || 0) || ""} · #{dispatchOrder.orderNumber || dispatchAssignment.orderNumber || "-"}
                          </p>
                          <h2 className={styles.cardTitle}>{dispatchOrder.customerName || "Cliente"}</h2>
                          {dispatchAddress ? <p className={styles.subtitle}>{dispatchAddress}</p> : null}
                        </div>
                        <span className={`${styles.counterBadge} ${styles.preparerStatusBadge}`}>
                          {preparerStatusLabel(dispatchStatus)}
                        </span>
                      </div>

                      <div className={styles.preparerProductList}>
                        {dispatchItems.length ? (
                          dispatchItems.map((item, index) => (
                            <div key={`${item.lineItemId || item.id || item.title || "item"}-${index}`} className={styles.preparerProductItem}>
                              {item.imageUrl ? (
                                <button
                                  className={styles.preparerProductImageButton}
                                  type="button"
                                  onClick={() =>
                                    setEnlargedImage({
                                      src: item.imageUrl,
                                      alt: item.imageAlt || item.title || "Producto",
                                    })
                                  }
                                >
                                  <img
                                    className={styles.preparerProductImage}
                                    src={item.imageUrl}
                                    alt={item.imageAlt || item.title || "Producto"}
                                  />
                                </button>
                              ) : (
                                <span className={styles.preparerProductImagePlaceholder} />
                              )}
                              <div className={styles.preparerProductCopy}>
                                <strong>{item.title || "Producto"}</strong>
                                {item.variantSummary ? <span>Variante: {item.variantSummary}</span> : null}
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
                          <input type="hidden" name="assignmentId" value={dispatchAssignment.id} />
                          <button className={styles.accessButton} type="submit" disabled={isSubmitting || isDispatchCompleted}>
                            Listo
                          </button>
                        </Form>
                        <Form method="post">
                          <input type="hidden" name="intent" value="preparer_mark_not_located" />
                          <input type="hidden" name="assignmentId" value={dispatchAssignment.id} />
                          <button className={styles.missingButton} type="submit" disabled={isSubmitting || isDispatchCompleted}>
                            No localizado
                          </button>
                        </Form>
                      </div>
                    </>
                  ) : (
                    <p className={styles.empty}>No hay ordenes para despachar.</p>
                  )}
                </article>
              )}
            </section>
          ) : (
            <section className={styles.card}>
              <p className={styles.error}>Este preparador aún no tiene órdenes asignadas.</p>
            </section>
          )}
          {enlargedImage ? (
            <div className={styles.modalBackdrop} role="presentation" onClick={() => setEnlargedImage(null)}>
              <div className={styles.preparerImageModal} role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
                <button className={styles.logoutButton} type="button" onClick={() => setEnlargedImage(null)}>
                  Cerrar
                </button>
                <img src={enlargedImage.src} alt={enlargedImage.alt} />
              </div>
            </div>
          ) : null}
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
