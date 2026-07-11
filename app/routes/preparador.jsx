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
  return {
    shop: access?.shop || shop,
    preparerName: access?.name || "",
    isLoggedIn: Boolean(access),
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

export default function PreparerPortal() {
  const { shop, preparerName, isLoggedIn } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  if (isLoggedIn) {
    return (
      <main className={styles.page}>
        <div className={styles.accessContainer}>
          <section className={`${styles.card} ${styles.accessCard}`}>
            <p className={styles.eyebrow}>Portal del preparador</p>
            <h1 className={styles.cardTitle}>Hola, {preparerName}</h1>
            <p className={styles.subtitle}>Tu acceso esta activo. Aqui apareceran las ordenes de preparacion.</p>
            <Form method="post" className={styles.accessForm}>
              <input type="hidden" name="intent" value="logout" />
              <input type="hidden" name="shop" value={shop || ""} />
              <button className={styles.accessButton} type="submit" disabled={isSubmitting}>
                Cerrar sesion
              </button>
            </Form>
          </section>
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
