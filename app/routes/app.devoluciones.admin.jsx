import { Form, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import styles from "../styles/admin.module.css";

async function getOrCreateSettings(shop) {
  const existing = await prisma.returnSettings.findUnique({ where: { shop } });
  if (existing) return existing;
  return prisma.returnSettings.create({ data: { shop } });
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const settings = await getOrCreateSettings(session.shop);
  return { settings };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent !== "update_settings") return { ok: false };

  await prisma.returnSettings.upsert({
    where: { shop: session.shop },
    update: {
      pickupCost: Number(formData.get("pickupCost") || 0),
      returnWindowDays: Number(formData.get("returnWindowDays") || 30),
      returnReasons: String(formData.get("returnReasons") || ""),
      evidenceReasons: String(formData.get("evidenceReasons") || ""),
      branchInstructions: String(formData.get("branchInstructions") || ""),
      branchAddress: String(formData.get("branchAddress") || ""),
      branchHours: String(formData.get("branchHours") || ""),
      pickupInstructions: String(formData.get("pickupInstructions") || ""),
      pickupHours: String(formData.get("pickupHours") || ""),
    },
    create: {
      shop: session.shop,
      pickupCost: Number(formData.get("pickupCost") || 0),
      returnWindowDays: Number(formData.get("returnWindowDays") || 30),
      returnReasons: String(formData.get("returnReasons") || ""),
      evidenceReasons: String(formData.get("evidenceReasons") || ""),
      branchInstructions: String(formData.get("branchInstructions") || ""),
      branchAddress: String(formData.get("branchAddress") || ""),
      branchHours: String(formData.get("branchHours") || ""),
      pickupInstructions: String(formData.get("pickupInstructions") || ""),
      pickupHours: String(formData.get("pickupHours") || ""),
    },
  });

  return { ok: true };
};

export default function ReturnsAdmin() {
  const { settings } = useLoaderData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <s-page heading="Panel admin de devoluciones">
      <s-section heading="Configuracion de devoluciones">
        <Form method="post">
          <input type="hidden" name="intent" value="update_settings" />
          <div className={styles.wrap}>
            <div className={`${styles.card} ${styles.grid}`}>
              <div className={styles.grid2}>
                <label className={styles.label}>
                  Costo de recoleccion (MXN)
                  <span className={styles.help}>Costo que vera el cliente si elige recoleccion.</span>
                  <input
                    className={styles.input}
                    name="pickupCost"
                    type="number"
                    step="0.01"
                    defaultValue={settings.pickupCost}
                  />
                </label>
                <label className={styles.label}>
                  Dias limite para devolucion
                  <span className={styles.help}>Cuantos dias despues de la compra permites devolucion.</span>
                  <input
                    className={styles.input}
                    name="returnWindowDays"
                    type="number"
                    defaultValue={settings.returnWindowDays}
                  />
                </label>
              </div>

              <label className={styles.label}>
                Direccion de sucursal
                <input className={styles.input} name="branchAddress" defaultValue={settings.branchAddress} />
              </label>

              <div className={styles.grid2}>
                <label className={styles.label}>
                  Instrucciones entrega en sucursal
                  <textarea
                    className={styles.textarea}
                    name="branchInstructions"
                    defaultValue={settings.branchInstructions}
                  />
                </label>
                <label className={styles.label}>
                  Horarios entrega en sucursal
                  <input className={styles.input} name="branchHours" defaultValue={settings.branchHours} />
                </label>
              </div>

              <div className={styles.grid2}>
                <label className={styles.label}>
                  Instrucciones de recoleccion
                  <textarea
                    className={styles.textarea}
                    name="pickupInstructions"
                    defaultValue={settings.pickupInstructions}
                  />
                </label>
                <label className={styles.label}>
                  Horarios de recoleccion
                  <input className={styles.input} name="pickupHours" defaultValue={settings.pickupHours} />
                </label>
              </div>

              <div className={styles.grid2}>
                <label className={styles.label}>
                  Motivos de devolucion (uno por linea)
                  <span className={styles.help}>Estos son los motivos que veran tus clientes al solicitar devolucion.</span>
                  <textarea
                    className={styles.textarea}
                    name="returnReasons"
                    defaultValue={settings.returnReasons || ""}
                    placeholder={"Me quedo grande\nMe quedo chico\nNo era lo que pedi\nLlego danado\nOtro"}
                  />
                </label>
                <label className={styles.label}>
                  Motivos que requieren evidencia (uno por linea)
                  <span className={styles.help}>Si un motivo esta aqui, pediremos descripcion y al menos 1 foto.</span>
                  <textarea
                    className={styles.textarea}
                    name="evidenceReasons"
                    defaultValue={settings.evidenceReasons || ""}
                    placeholder={"No era lo que pedi\nLlego danado"}
                  />
                </label>
              </div>

              <div className={styles.actions}>
                <button className={`${styles.btn} ${styles.btnPrimary}`} type="submit" disabled={isSubmitting}>
                  Guardar configuracion
                </button>
              </div>
            </div>
          </div>
        </Form>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);

