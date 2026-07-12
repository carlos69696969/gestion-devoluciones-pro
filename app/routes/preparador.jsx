import { useEffect, useState } from "react";
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

function itemBaseKey(item) {
  return String(item?.lineItemId || item?.id || item?.title || "item").trim();
}

function itemUnitKey(item, index = 0) {
  return `${itemBaseKey(item)}::${Number(index || 0) + 1}`;
}

function itemUnitKeys(item) {
  const quantity = Math.max(1, Number(item?.quantity || 1));
  return Array.from({ length: quantity }, (_value, index) => itemUnitKey(item, index));
}

function normalizeOrderItemsWithPreparerStatus(orderData, readyUnitKeys = [], missingUnitKeys = []) {
  const readySet = new Set(readyUnitKeys.map((value) => String(value || "").trim()).filter(Boolean));
  const missingSet = new Set(missingUnitKeys.map((value) => String(value || "").trim()).filter(Boolean));
  const order = orderData && typeof orderData === "object" ? orderData : {};
  const items = Array.isArray(order.items) ? order.items : [];
  return {
    ...order,
    preparerReadyUnitKeys: [...readySet],
    preparerMissingUnitKeys: [...missingSet],
    preparerCompletedAt: new Date().toISOString(),
    items: items.map((item, itemIndex) => {
      const unitKeys = itemUnitKeys(item);
      const missingItemUnitKeys = unitKeys.filter((unitKey) => missingSet.has(unitKey));
      const readyItemUnitKeys = unitKeys.filter((unitKey) => readySet.has(unitKey));
      return {
        ...item,
        preparerItemKey: itemBaseKey(item) || `item-${itemIndex}`,
        preparerUnitKeys: unitKeys,
        preparerReadyUnitKeys: readyItemUnitKeys,
        preparerMissingUnitKeys: missingItemUnitKeys,
        preparerStatus: missingItemUnitKeys.length ? "not_located" : "ready",
      };
    }),
  };
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

  if (intent === "preparer_mark_ready") {
    const access = await getPreparerAccess(request);
    if (!access) return { ok: false, error: "Inicia sesion nuevamente." };
    const assignmentId = Number(formData.get("assignmentId") || 0);
    if (!assignmentId) return { ok: false, error: "Orden invalida." };
    const readyUnitKeys = formData
      .getAll("readyUnitKeys")
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    const missingUnitKeys = formData
      .getAll("missingUnitKeys")
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    const assignment = await prisma.preparerAssignment.findFirst({
      where: {
        id: assignmentId,
        shop: access.shop,
        preparerId: access.id,
      },
    });
    if (!assignment) return { ok: false, error: "Orden invalida." };
    const nextStatus = missingUnitKeys.length ? "not_located" : "ready";
    const nextOrderData = normalizeOrderItemsWithPreparerStatus(assignment.orderData, readyUnitKeys, missingUnitKeys);
    await prisma.$transaction([
      prisma.preparerAssignment.update({
        where: { id: assignment.id },
        data: {
          status: nextStatus,
          orderData: nextOrderData,
          completedAt: new Date(),
        },
      }),
      ...(missingUnitKeys.length
        ? [
            prisma.courierActivity.create({
              data: {
                shop: access.shop,
                courierId: 0,
                courierName: `Preparador: ${access.name}`,
                requestId: String(assignment.requestId || "").trim(),
                orderNumber: assignment.orderNumber || null,
                action: "courier_route_order_not_located",
                routeId: null,
              },
            }),
          ]
        : []),
    ]);
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
  if (normalized === "not_located") return "x";
  return "";
}

function preparerDisplaySequence(assignment, fallback = 0) {
  const order = assignment?.orderData && typeof assignment.orderData === "object" ? assignment.orderData : {};
  return Number(order.sequenceNumber || assignment?.sequence || fallback || 0) || 0;
}

function preparerOrderNumberValue(assignment) {
  const order = assignment?.orderData && typeof assignment.orderData === "object" ? assignment.orderData : {};
  const digits = String(order.orderNumber || assignment?.orderNumber || "").replace(/\D/g, "");
  return Number(digits || 0) || 0;
}

export default function PreparerPortal() {
  const { shop, preparerName, isLoggedIn, assignments = [] } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [enlargedImage, setEnlargedImage] = useState(null);
  const [readyUnitKeys, setReadyUnitKeys] = useState([]);
  const [missingReviewOpen, setMissingReviewOpen] = useState(false);
  const [reviewUnitKeys, setReviewUnitKeys] = useState([]);
  const isSubmitting = navigation.state === "submitting";
  const requestedTab = String(searchParams.get("tab") || "ordenes").trim().toLowerCase();
  const activeTab = requestedTab === "despachar" ? "despachar" : "ordenes";
  const sortedAssignments = [...assignments].sort(
    (firstAssignment, secondAssignment) =>
      preparerOrderNumberValue(firstAssignment) - preparerOrderNumberValue(secondAssignment) ||
      preparerDisplaySequence(firstAssignment) - preparerDisplaySequence(secondAssignment) ||
      Number(firstAssignment.id || 0) - Number(secondAssignment.id || 0),
  );
  const displaySequenceByAssignmentId = new Map(
    sortedAssignments.map((assignment, index) => [String(assignment.id), index + 1]),
  );
  const dispatchAssignment =
    sortedAssignments.find((assignment) => !isPreparerAssignmentDone(assignment.status)) || null;

  useEffect(() => {
    setReadyUnitKeys([]);
    setMissingReviewOpen(false);
    setReviewUnitKeys([]);
  }, [dispatchAssignment?.id]);

  const handleTabChange = (nextTab) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("tab", nextTab);
    if (shop) nextParams.set("shop", shop);
    setSearchParams(nextParams);
  };

  if (isLoggedIn) {
    const remainingAssignments = sortedAssignments.filter((assignment) => !isPreparerAssignmentDone(assignment.status));
    const dispatchOrder = dispatchAssignment?.orderData || {};
    const dispatchItems = Array.isArray(dispatchOrder.items) ? dispatchOrder.items : [];
    const dispatchStatus = String(dispatchAssignment?.status || "assigned").trim().toLowerCase();
    const isDispatchCompleted = isPreparerAssignmentDone(dispatchStatus);
    const dispatchAddress = formatPreparerAddress(dispatchOrder);
    const dispatchUnitKeys = dispatchItems.flatMap((item) => itemUnitKeys(item));
    const readyUnitKeySet = new Set(readyUnitKeys);
    const uncheckedUnitKeys = dispatchUnitKeys.filter((unitKey) => !readyUnitKeySet.has(unitKey));
    const activeReviewUnitKeys = missingReviewOpen && reviewUnitKeys.length ? reviewUnitKeys : uncheckedUnitKeys;
    const activeReviewUnitKeySet = new Set(activeReviewUnitKeys);
    const visibleDispatchItems = missingReviewOpen
      ? dispatchItems.filter((item) => itemUnitKeys(item).some((unitKey) => activeReviewUnitKeySet.has(unitKey)))
      : dispatchItems;
    const reviewItemCount = visibleDispatchItems.length;

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
            <span className={styles.counterBadge}>Restantes {remainingAssignments.length}</span>
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
                        <span className={styles.orderSequenceBadge}>
                          {displaySequenceByAssignmentId.get(String(assignment.id)) || ""}
                        </span>
                        <strong>Orden #{order.orderNumber || assignment.orderNumber || "-"}</strong>
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
                          <div className={styles.preparerDispatchTitleRow}>
                            <span className={styles.orderSequenceBadge}>
                              {displaySequenceByAssignmentId.get(String(dispatchAssignment.id)) || ""}
                            </span>
                            <h2 className={styles.preparerDispatchOrderNumber}>
                              #{dispatchOrder.orderNumber || dispatchAssignment.orderNumber || "-"}
                            </h2>
                          </div>
                          <h3 className={styles.cardTitle}>{dispatchOrder.customerName || "Cliente"}</h3>
                          {dispatchAddress ? <p className={styles.subtitle}>{dispatchAddress}</p> : null}
                        </div>
                        <span className={`${styles.counterBadge} ${styles.preparerStatusBadge}`}>
                          {preparerStatusLabel(dispatchStatus)}
                        </span>
                      </div>

                      <Form
                        method="post"
                        onSubmit={(event) => {
                          if (isDispatchCompleted) return;
                          const submitAction = event.nativeEvent?.submitter?.value || "";
                          if (submitAction === "not_located") {
                            if (!window.confirm("Confirmas que estos productos no fueron localizados?")) {
                              event.preventDefault();
                            }
                            return;
                          }
                          if (uncheckedUnitKeys.length) {
                            event.preventDefault();
                            if (!window.confirm("Hay productos sin palomita. Quieres revisarlos antes de guardar?")) {
                              return;
                            }
                            setReviewUnitKeys(uncheckedUnitKeys);
                            setMissingReviewOpen(true);
                            return;
                          }
                          if (!window.confirm("Confirmas que esta orden esta lista?")) {
                            event.preventDefault();
                          }
                        }}
                      >
                        <input type="hidden" name="intent" value="preparer_mark_ready" />
                        <input type="hidden" name="assignmentId" value={dispatchAssignment.id} />
                        {readyUnitKeys.map((unitKey) => (
                          <input key={`ready:${unitKey}`} type="hidden" name="readyUnitKeys" value={unitKey} />
                        ))}
                        {missingReviewOpen
                          ? activeReviewUnitKeys
                              .filter((unitKey) => !readyUnitKeySet.has(unitKey))
                              .map((unitKey) => (
                              <input key={`missing:${unitKey}`} type="hidden" name="missingUnitKeys" value={unitKey} />
                            ))
                          : null}
                        {missingReviewOpen ? (
                          <p className={styles.preparerInlineReviewMessage}>
                            {reviewItemCount === 1 ? "Revisa que tengas este producto." : "Revisa que tengas estos productos."}
                          </p>
                        ) : null}
                        <div className={styles.preparerProductList}>
                          {visibleDispatchItems.length ? (
                            visibleDispatchItems.map((item, index) => {
                              const unitKeys = itemUnitKeys(item);
                              const checked = unitKeys.every((unitKey) => readyUnitKeySet.has(unitKey));
                              return (
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
                                  <label className={styles.preparerProductCheck}>
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      disabled={isDispatchCompleted}
                                      onChange={(event) => {
                                        setReadyUnitKeys((currentKeys) => {
                                          const nextKeys = new Set(currentKeys);
                                          for (const unitKey of unitKeys) {
                                            if (event.target.checked) nextKeys.add(unitKey);
                                            else nextKeys.delete(unitKey);
                                          }
                                          return [...nextKeys];
                                        });
                                      }}
                                    />
                                    <span>{checked ? "✓" : ""}</span>
                                  </label>
                                </div>
                              );
                            })
                          ) : (
                            <p className={styles.subtitle}>No hay productos registrados para esta orden.</p>
                          )}
                        </div>

                        <div className={styles.preparerActions}>
                          <button className={styles.accessButton} type="submit" disabled={isSubmitting || isDispatchCompleted}>
                            Listo
                          </button>
                          {missingReviewOpen && activeReviewUnitKeys.some((unitKey) => !readyUnitKeySet.has(unitKey)) ? (
                            <>
                              <button
                                className={styles.missingButton}
                                type="submit"
                                name="preparerSubmitAction"
                                value="not_located"
                                disabled={isSubmitting || isDispatchCompleted}
                              >
                                No localizado
                              </button>
                              <button
                                className={styles.accessButton}
                                type="button"
                                disabled={isSubmitting || isDispatchCompleted}
                                onClick={() => {
                                  setMissingReviewOpen(false);
                                  setReviewUnitKeys([]);
                                }}
                              >
                                Regresar
                              </button>
                            </>
                          ) : null}
                        </div>
                      </Form>
                    </>
                  ) : (
                    <p className={styles.empty}>No hay ordenes para despachar.</p>
                  )}
                </article>
              )}
            </section>
          ) : (
            <section className={styles.card}>
              <p className={styles.error}>Este preparador aun no tiene ordenes asignadas.</p>
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
