import "@shopify/ui-extensions/customer-account";

const RETURN_PORTAL_URL = "https://gestion-devoluciones-pro.onrender.com/app";

export default function extension() {
  const target = globalThis?.shopify?.target?.value;
  const orderName = target?.order?.name || "";
  const customerEmail = target?.customer?.emailAddress?.emailAddress || "";

  const url = new URL(RETURN_PORTAL_URL);
  if (orderName) {
    url.searchParams.set("order", String(orderName).replace("#", ""));
  }
  if (customerEmail) {
    url.searchParams.set("email", String(customerEmail));
  }

  const wrapper = document.createElement("s-stack");
  wrapper.setAttribute("padding", "base");
  wrapper.setAttribute("gap", "tight");

  const title = document.createElement("s-text");
  title.setAttribute("appearance", "strong");
  title.textContent = "Devoluciones";

  const description = document.createElement("s-text");
  description.textContent = "Inicia aqui la devolucion de este pedido.";

  const button = document.createElement("s-button");
  button.textContent = "Solicitar devolucion";
  button.setAttribute("href", url.toString());
  button.setAttribute("target", "_blank");

  wrapper.appendChild(title);
  wrapper.appendChild(description);
  wrapper.appendChild(button);
  document.body.appendChild(wrapper);
}
