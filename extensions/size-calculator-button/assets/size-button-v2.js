(function () {
  if (window.carianaSizeButtonReady) return;
  window.carianaSizeButtonReady = true;

  var bodyLabels = {
    delgado: "Delgado",
    promedio: "Promedio",
    curvy: "Curvy",
    extra_curvy: "Extra Curvy",
  };

  var bodyImages = {
    delgado: "https://cdn.shopify.com/s/files/1/0974/2683/3713/files/cuerpo_delgado.webp?v=1776223850",
    promedio: "https://cdn.shopify.com/s/files/1/0974/2683/3713/files/cuerpo_promedio.webp?v=1776040274",
    curvy: "https://cdn.shopify.com/s/files/1/0974/2683/3713/files/cuerpo_curvy.webp?v=1776040250",
    extra_curvy: "https://cdn.shopify.com/s/files/1/0974/2683/3713/files/cuerpo_extra_curvy.webp?v=1776040265",
  };

  var hipLabels = {
    rectas: "Recta",
    promedio: "Promedio",
    curvy_fit: "Curvy fit",
    curvy: "Curvy",
  };

  var hipImages = {
    rectas: "https://cdn.shopify.com/s/files/1/0974/2683/3713/files/caderas_rectas.webp?v=1776211532",
    promedio: "https://cdn.shopify.com/s/files/1/0974/2683/3713/files/cadera_promedio.webp?v=1776211532",
    curvy_fit: "https://cdn.shopify.com/s/files/1/0974/2683/3713/files/cadera_curvy_fit.webp?v=1776211532",
    curvy: "https://cdn.shopify.com/s/files/1/0974/2683/3713/files/cadera_curvy.webp?v=1776211533",
  };

  var topSizes = [
    { talla: "XCH", alias: "XS", pesoMin: 40, pesoMax: 50, alturaMin: 150, alturaMax: 160, cinturaMin: 60, cinturaMax: 68, pechoMin: 76, pechoMax: 84 },
    { talla: "CH", alias: "S", pesoMin: 50, pesoMax: 58, alturaMin: 155, alturaMax: 165, cinturaMin: 68, cinturaMax: 74, pechoMin: 84, pechoMax: 90 },
    { talla: "M", alias: "M", pesoMin: 58, pesoMax: 65, alturaMin: 160, alturaMax: 170, cinturaMin: 74, cinturaMax: 80, pechoMin: 90, pechoMax: 96 },
    { talla: "G", alias: "L", pesoMin: 65, pesoMax: 75, alturaMin: 165, alturaMax: 175, cinturaMin: 80, cinturaMax: 88, pechoMin: 96, pechoMax: 104 },
    { talla: "XG", alias: "XL", pesoMin: 75, pesoMax: 85, alturaMin: 165, alturaMax: 175, cinturaMin: 88, cinturaMax: 96, pechoMin: 104, pechoMax: 112 },
    { talla: "XXG", alias: "XXL", pesoMin: 85, pesoMax: 95, alturaMin: 165, alturaMax: 175, cinturaMin: 96, cinturaMax: 104, pechoMin: 112, pechoMax: 120 },
    { talla: "3XG", alias: "3XL", pesoMin: 95, pesoMax: 110, alturaMin: 165, alturaMax: 178, cinturaMin: 104, cinturaMax: 112, pechoMin: 120, pechoMax: 128 },
    { talla: "4XG", alias: "4XL", pesoMin: 110, pesoMax: 125, alturaMin: 165, alturaMax: 180, cinturaMin: 112, cinturaMax: 120, pechoMin: 128, pechoMax: 136 },
    { talla: "5XG", alias: "5XL", pesoMin: 125, pesoMax: 140, alturaMin: 165, alturaMax: 182, cinturaMin: 120, cinturaMax: 128, pechoMin: 136, pechoMax: 144 },
  ];

  var bustTable = [
    { pechoMin: 76, pechoMax: 84, A: "32A", B: "32B", C: "32C", D: "32D", DD: "32DD", rowIndex: 0 },
    { pechoMin: 84, pechoMax: 90, A: "34A", B: "34B", C: "34C", D: "34D", DD: "34DD", rowIndex: 1 },
    { pechoMin: 90, pechoMax: 96, A: "36A", B: "36B", C: "36C", D: "36D", DD: "36DD", rowIndex: 2 },
    { pechoMin: 96, pechoMax: 104, A: "38A", B: "38B", C: "38C", D: "38D", DD: "38DD", rowIndex: 3 },
    { pechoMin: 104, pechoMax: 112, A: "40A", B: "40B", C: "40C", D: "40D", DD: "40DD", rowIndex: 4 },
    { pechoMin: 112, pechoMax: 120, A: "42A", B: "42B", C: "42C", D: "42D", DD: "42DD", rowIndex: 5 },
    { pechoMin: 120, pechoMax: 128, A: "44A", B: "44B", C: "44C", D: "44D", DD: "44DD", rowIndex: 6 },
    { pechoMin: 128, pechoMax: 136, A: "46A", B: "46B", C: "46C", D: "46D", DD: "46DD", rowIndex: 7 },
    { pechoMin: 136, pechoMax: 144, A: "48A", B: "48B", C: "48C", D: "48D", DD: "48DD", rowIndex: 8 },
  ];

  var bottomSizes = [
    { talla: "1", pesoMin: 40, pesoMax: 45, alturaMin: 150, alturaMax: 155, cinturaMin: 62, cinturaMax: 64, caderaMin: 86, caderaMax: 90 },
    { talla: "3", pesoMin: 42, pesoMax: 48, alturaMin: 150, alturaMax: 158, cinturaMin: 63, cinturaMax: 67, caderaMin: 88, caderaMax: 92 },
    { talla: "5", pesoMin: 45, pesoMax: 52, alturaMin: 152, alturaMax: 160, cinturaMin: 68, cinturaMax: 72, caderaMin: 92, caderaMax: 96 },
    { talla: "7", pesoMin: 50, pesoMax: 58, alturaMin: 155, alturaMax: 163, cinturaMin: 73, cinturaMax: 77, caderaMin: 96, caderaMax: 100 },
    { talla: "9", pesoMin: 55, pesoMax: 63, alturaMin: 158, alturaMax: 166, cinturaMin: 78, cinturaMax: 82, caderaMin: 100, caderaMax: 104 },
    { talla: "11", pesoMin: 60, pesoMax: 70, alturaMin: 160, alturaMax: 168, cinturaMin: 83, cinturaMax: 87, caderaMin: 104, caderaMax: 108 },
    { talla: "13", pesoMin: 65, pesoMax: 78, alturaMin: 160, alturaMax: 170, cinturaMin: 88, cinturaMax: 92, caderaMin: 108, caderaMax: 112 },
    { talla: "15", pesoMin: 72, pesoMax: 85, alturaMin: 160, alturaMax: 172, cinturaMin: 93, cinturaMax: 97, caderaMin: 112, caderaMax: 118 },
    { talla: "17", pesoMin: 80, pesoMax: 92, alturaMin: 160, alturaMax: 173, cinturaMin: 98, cinturaMax: 102, caderaMin: 118, caderaMax: 124 },
    { talla: "19", pesoMin: 85, pesoMax: 98, alturaMin: 160, alturaMax: 175, cinturaMin: 103, cinturaMax: 107, caderaMin: 124, caderaMax: 130 },
    { talla: "21", pesoMin: 90, pesoMax: 105, alturaMin: 160, alturaMax: 175, cinturaMin: 108, cinturaMax: 112, caderaMin: 130, caderaMax: 136 },
    { talla: "23", pesoMin: 95, pesoMax: 115, alturaMin: 160, alturaMax: 175, cinturaMin: 113, cinturaMax: 118, caderaMin: 136, caderaMax: 142 },
  ];

  var cups = ["A", "B", "C", "D", "DD"];
  var stateByRoot = new WeakMap();

  function getState(root) {
    if (!stateByRoot.has(root)) {
      stateByRoot.set(root, {
        body: "",
        bust: null,
        bustCm: 90,
        chestSelected: false,
        waistCm: 74,
        waistSelected: false,
        hip: "",
        selector: "",
        temp: null,
      });
    }
    return stateByRoot.get(root);
  }

  function qs(root, selector) {
    return root.querySelector(selector);
  }

  function setHidden(element, hidden) {
    if (!element) return;
    element.hidden = hidden;
  }

  function center(min, max) {
    return (min + max) / 2;
  }

  function inRange(value, min, max) {
    return value >= min && value <= max;
  }

  function clampIndex(index, list) {
    if (index < 0) return 0;
    if (index > list.length - 1) return list.length - 1;
    return index;
  }

  function cleanNumber(value) {
    return parseFloat(String(value || "").replace(/[^\d.]/g, "")) || 0;
  }

  function getFieldValue(field) {
    if (!field) return "";
    if (field.getAttribute("data-cariana-value")) {
      return field.getAttribute("data-cariana-value");
    }
    return "value" in field ? field.value : field.textContent;
  }

  function setFieldValue(field, value) {
    if (!field) return;
    var cleanValue = String(value || "");
    field.setAttribute("data-cariana-value", cleanValue);
    if ("value" in field && field.tagName !== "BUTTON") {
      field.value = cleanValue;
      return;
    }
    field.innerHTML = '<span class="cariana-size-field-value">' + cleanValue + "</span>";
  }

  function formatWeight(field) {
    setFieldValue(field, getFieldValue(field).replace(/[^\d]/g, ""));
  }

  function closeWeight(field) {
    var value = getFieldValue(field).replace(/[^\d]/g, "");
    setFieldValue(field, value ? value + " kg" : "");
  }

  function formatHeight(field) {
    var value = getFieldValue(field).replace(/[^\d]/g, "");
    if (!value) {
      setFieldValue(field, "");
      return;
    }
    if (value.length === 1) {
      setFieldValue(field, value);
      return;
    }
    if (value.length === 2) {
      setFieldValue(field, value[0] + "." + value[1]);
      return;
    }
    setFieldValue(field, value[0] + "." + value.substring(1, 3));
  }

  function closeHeight(field) {
    var value = getFieldValue(field).trim();
    if (!value) {
      setFieldValue(field, "");
      return;
    }
    if (value.endsWith(".")) value = value.slice(0, -1);
    if (!value.toLowerCase().includes("cm")) value += " cm";
    setFieldValue(field, value);
  }

  function makeMeasurementField(kind) {
    var field = document.createElement("button");
    field.type = "button";
    field.className = "cariana-size-field";
    field.setAttribute("data-placeholder", kind === "weight" ? "Peso kg" : "Altura cm");
    setFieldValue(field, kind === "weight" ? "Peso kg" : "Altura cm");
    field.setAttribute(kind === "weight" ? "data-cariana-weight" : "data-cariana-height", "");
    return field;
  }

  function requestMeasurement(field, kind) {
    var current = getFieldValue(field).replace(/[^\d.]/g, "");
    var root = field.closest("[data-cariana-size-root]");
    var modalCard = root ? qs(root, ".cariana-size-modal-card") : null;
    if (!modalCard) return;

    var oldPanel = qs(root, "[data-cariana-number-panel]");
    if (oldPanel) oldPanel.remove();

    var panel = document.createElement("div");
    panel.className = "cariana-number-panel";
    panel.setAttribute("data-cariana-number-panel", "");
    panel.innerHTML =
      '<div class="cariana-number-card">' +
        '<p class="cariana-number-label">' + (kind === "weight" ? "Escribe tu peso" : "Escribe tu altura") + '</p>' +
        '<div class="cariana-number-display" data-cariana-number-display>' + (current || "") + '</div>' +
        '<div class="cariana-number-hint">' + (kind === "weight" ? "kg" : "cm") + '</div>' +
        '<div class="cariana-number-grid">' +
          ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"].map(function (key) {
            return '<button type="button" data-cariana-number-key="' + key + '">' + key + '</button>';
          }).join("") +
        '</div>' +
        '<div class="cariana-number-actions">' +
          '<button type="button" class="cariana-number-cancel" data-cariana-number-cancel>Cancelar</button>' +
          '<button type="button" class="cariana-number-accept" data-cariana-number-accept>Aceptar</button>' +
        '</div>' +
      '</div>';

    panel.addEventListener("click", function (event) {
      var display = qs(panel, "[data-cariana-number-display]");
      var value = display.textContent || "";

      if (event.target.matches("[data-cariana-number-key]")) {
        var key = event.target.getAttribute("data-cariana-number-key");
        if (key === "⌫") {
          display.textContent = value.slice(0, -1);
          return;
        }
        if (key === "." && (kind === "weight" || value.includes("."))) return;
        if (value.length >= 5) return;
        display.textContent = value + key;
        return;
      }

      if (event.target.matches("[data-cariana-number-cancel]")) {
        panel.remove();
        return;
      }

      if (event.target.matches("[data-cariana-number-accept]")) {
        applyMeasurementValue(field, kind, display.textContent);
        panel.remove();
      }
    });

    modalCard.appendChild(panel);
  }

  function applyMeasurementValue(field, kind, rawValue) {
    var cleaned = String(rawValue || "").replace(/[^\d.]/g, "");
    if (!cleaned) {
      setFieldValue(field, kind === "weight" ? "Peso kg" : "Altura cm");
      return;
    }

    if (kind === "weight") {
      setFieldValue(field, cleaned.replace(/[^\d]/g, "") + " kg");
      return;
    }

    var heightText = formatHeightLabel(cleaned);
    setFieldValue(field, heightText || "Altura cm");
  }

  function formatHeightLabel(value) {
    var cleaned = String(value || "").replace(/[^\d.]/g, "");
    if (!cleaned) return "";

    if (cleaned.indexOf(".") !== -1) {
      var meters = parseFloat(cleaned);
      if (!meters) return "";
      if (meters >= 3) return (meters / 100).toFixed(2) + " cm";
      return meters.toFixed(2) + " cm";
    }

    if (cleaned.length >= 3) {
      return (Number(cleaned) / 100).toFixed(2) + " cm";
    }

    if (cleaned.length === 2) {
      return "1." + cleaned.padStart(2, "0") + " cm";
    }

    return cleaned + " cm";
  }

  function ensureMeasurementFields(root) {
    var fields = qs(root, "[data-cariana-fields]");
    var bodyButton = qs(root, "[data-cariana-body-button]");
    if (!fields || !bodyButton) return;

    var weight = qs(root, "[data-cariana-weight]");
    var height = qs(root, "[data-cariana-height]");

    if (!weight) {
      weight = makeMeasurementField("weight");
    }
    if (!height) {
      height = makeMeasurementField("height");
    }

    weight.style.display = "block";
    weight.style.visibility = "visible";
    weight.style.opacity = "1";
    height.style.display = "block";
    height.style.visibility = "visible";
    height.style.opacity = "1";

    if (weight.parentNode !== fields) {
      fields.insertBefore(weight, bodyButton);
    }
    if (height.parentNode !== fields) {
      fields.insertBefore(height, bodyButton);
    }

    if (height.nextElementSibling !== bodyButton) {
      fields.insertBefore(weight, bodyButton);
      fields.insertBefore(height, bodyButton);
    }
  }

  function makeRuler(name, min, max, value, dataName) {
    var wrap = document.createElement("div");
    wrap.className = "cariana-size-ruler cariana-size-ruler-selector";
    wrap.setAttribute("data-cariana-" + dataName + "-ruler", "");

    var marks = "";
    for (var cm = min; cm <= max; cm += 1) {
      var isMajor = cm === min || cm === max || cm % 10 === 0;
      var isMiddle = cm === Math.round((min + max) / 2);
      marks +=
        '<span class="cariana-size-ruler-mark' + (isMajor ? " is-major" : "") + (isMiddle ? " is-middle" : "") + '" data-cariana-ruler-cm="' + cm + '">' +
          (isMajor || isMiddle ? '<em>' + cm + '</em>' : "") +
        '</span>';
    }

    wrap.innerHTML =
      '<div class="cariana-size-ruler-head">' +
        '<span>' + name + '<sup>*</sup></span>' +
        '<strong data-cariana-' + dataName + '-value>' + value + ' cm</strong>' +
      '</div>' +
      '<div class="cariana-size-ruler-window">' +
        '<div class="cariana-size-ruler-pointer" aria-hidden="true"></div>' +
        '<div class="cariana-size-ruler-track" data-cariana-' + dataName + '-range data-cariana-ruler-track data-min="' + min + '" data-max="' + max + '" data-step-px="10" tabindex="0">' +
          '<span class="cariana-size-ruler-pad" aria-hidden="true"></span>' +
          marks +
          '<span class="cariana-size-ruler-pad" aria-hidden="true"></span>' +
        '</div>' +
      '</div>' +
      '<div class="cariana-size-ruler-numbers">' +
        '<span>' + min + '</span>' +
        '<span>' + Math.round((min + max) / 2) + '</span>' +
        '<span>' + max + '</span>' +
      '</div>';
    return wrap;
  }

  function makeTopMeasureButton(name, dataName) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "cariana-size-selector cariana-top-measure";
    button.setAttribute("data-cariana-top-measure", dataName);
    button.innerHTML =
      '<span class="cariana-top-measure-name">' + name + '</span>' +
      '<strong class="cariana-top-measure-value" data-cariana-' + dataName + '-field></strong>';
    return button;
  }

  function updateTopMeasureLabels(root) {
    var state = getState(root);
    var chestField = qs(root, "[data-cariana-chest-field]");
    var waistField = qs(root, "[data-cariana-waist-field]");

    if (chestField) chestField.textContent = state.chestSelected ? state.bustCm + " cm" : "";
    if (waistField) waistField.textContent = state.waistSelected ? state.waistCm + " cm" : "";
  }

  function hideFieldForTop(field) {
    if (!field) return;
    field.hidden = true;
    field.style.setProperty("display", "none", "important");
  }

  function showFieldAgain(field) {
    if (!field) return;
    field.hidden = false;
    field.style.removeProperty("display");
  }

  function ensureTopMeasureButtons(root) {
    var fields = qs(root, "[data-cariana-fields]");
    var bodyButton = qs(root, "[data-cariana-body-button]");
    var extraButton = qs(root, "[data-cariana-extra-button]");
    if (!fields || !bodyButton || !extraButton) return;

    hideFieldForTop(qs(root, "[data-cariana-weight]"));
    hideFieldForTop(qs(root, "[data-cariana-height]"));
    hideFieldForTop(bodyButton);
    hideFieldForTop(extraButton);

    var chestButton = qs(root, "[data-cariana-top-measure='chest']");
    var waistButton = qs(root, "[data-cariana-top-measure='waist']");

    if (!chestButton) {
      chestButton = makeTopMeasureButton("Pecho", "chest");
    }
    if (!waistButton) {
      waistButton = makeTopMeasureButton("Cintura", "waist");
    }

    if (chestButton.parentNode !== fields) {
      fields.insertBefore(chestButton, bodyButton);
    }
    if (waistButton.parentNode !== fields) {
      fields.insertBefore(waistButton, bodyButton);
    }

    if (chestButton.nextElementSibling !== waistButton) {
      fields.insertBefore(chestButton, bodyButton);
      fields.insertBefore(waistButton, bodyButton);
    }

    updateTopMeasureLabels(root);
  }

  function removeTopMeasureButtons(root) {
    var chestButton = qs(root, "[data-cariana-top-measure='chest']");
    var waistButton = qs(root, "[data-cariana-top-measure='waist']");
    var bodyButton = qs(root, "[data-cariana-body-button]");
    var extraButton = qs(root, "[data-cariana-extra-button]");

    if (chestButton) chestButton.remove();
    if (waistButton) waistButton.remove();
    showFieldAgain(qs(root, "[data-cariana-weight]"));
    showFieldAgain(qs(root, "[data-cariana-height]"));
    showFieldAgain(bodyButton);
    showFieldAgain(extraButton);
  }

  function openGuide(root) {
    if (typeof window.abrirGuia === "function") {
      window.abrirGuia();
      return;
    }

    var guideButtons = Array.prototype.slice.call(document.querySelectorAll("button, a"));
    var guideButton = guideButtons.find(function (button) {
      return button !== qs(root, "[data-cariana-size-guide]") && /ver guía de tallas|ver guia de tallas/i.test(button.textContent || "");
    });

    if (guideButton) {
      guideButton.click();
      return;
    }

    showBuiltInGuide(root);
  }

  function showBuiltInGuide(root) {
    var mode = root.getAttribute("data-cariana-size-mode") || "pending";
    var modal = document.createElement("div");
    modal.className = "cariana-size-guide-modal";
    modal.innerHTML =
      '<div class="cariana-size-guide-card" role="dialog" aria-modal="true">' +
        '<div class="cariana-size-guide-head">' +
          '<div class="cariana-size-guide-handle"></div>' +
          '<h3>' + (mode === "woman_bottom" ? "Guía de tallas Cariana (Pantalón Mujer)" : "Guía de tallas Cariana (Mujer)") + '</h3>' +
        '</div>' +
        '<div class="cariana-size-guide-scroll">' +
          '<p class="cariana-size-guide-hint">Desliza la tabla ↕↔</p>' +
          buildGuideTable(mode) +
        '</div>' +
        '<div class="cariana-size-guide-foot">' +
          '<p>Si estás entre dos tallas, elige la más grande para mayor comodidad.</p>' +
          '<button type="button" data-cariana-guide-close>Cerrar</button>' +
        '</div>' +
      '</div>';

    modal.addEventListener("click", function (event) {
      if (event.target === modal || event.target.matches("[data-cariana-guide-close]")) {
        modal.remove();
      }
    });

    document.body.appendChild(modal);
  }

  function buildGuideTable(mode) {
    if (mode === "woman_bottom") {
      return '<div class="cariana-size-guide-table-wrap"><table class="cariana-size-guide-table">' +
        '<thead><tr><th>Talla MX</th><th>Altura</th><th>Peso<br><span>(kg)</span></th><th>Cintura<br><span>(cm)</span></th><th>Cadera<br><span>(cm)</span></th></tr></thead>' +
        '<tbody>' +
        bottomSizes.map(function (size) {
          return '<tr><td>' + size.talla + '</td><td>' + size.alturaMin + '-' + size.alturaMax + ' cm</td><td>' + size.pesoMin + '-' + size.pesoMax + '</td><td>' + size.cinturaMin + '-' + size.cinturaMax + '</td><td>' + size.caderaMin + '-' + size.caderaMax + '</td></tr>';
        }).join("") +
        '</tbody></table></div>';
    }

    return '<div class="cariana-size-guide-table-wrap"><table class="cariana-size-guide-table">' +
      '<thead><tr><th>Talla MX</th><th>Altura</th><th>Peso<br><span>(kg)</span></th><th>Cintura<br><span>(cm)</span></th><th>Pecho<br><span>(cm)</span></th></tr></thead>' +
      '<tbody>' +
      topSizes.map(function (size) {
        return '<tr><td>' + size.talla + ' (' + size.alias + ')</td><td>' + size.alturaMin + '-' + size.alturaMax + ' cm</td><td>' + size.pesoMin + '-' + size.pesoMax + '</td><td>' + size.cinturaMin + '-' + size.cinturaMax + '</td><td>' + size.pechoMin + '-' + size.pechoMax + '</td></tr>';
      }).join("") +
      '</tbody></table></div>';
  }

  function openModal(root) {
    var mode = root.getAttribute("data-cariana-size-mode") || "pending";
    var modal = qs(root, "[data-cariana-size-modal]");
    var fields = qs(root, "[data-cariana-fields]");
    var pending = qs(root, "[data-cariana-pending]");
    var title = qs(root, "[data-cariana-title]");
    var extraText = qs(root, "[data-cariana-extra-text]");

    if (mode === "woman_top") {
      title.textContent = "Encuentra tu talla ideal (Mujer)";
      ensureMeasurementFields(root);
      ensureTopMeasureButtons(root);
      setHidden(fields, false);
      setHidden(pending, true);
    } else if (mode === "woman_bottom") {
      title.textContent = "Encuentra tu talla ideal (Pantalón Mujer)";
      extraText.textContent = "Tipo de cadera";
      ensureMeasurementFields(root);
      removeTopMeasureButtons(root);
      setHidden(fields, false);
      setHidden(pending, true);
    } else {
      title.textContent = "Encuentra tu talla ideal";
      removeTopMeasureButtons(root);
      setHidden(fields, true);
      setHidden(pending, false);
    }

    showMain(root);
    setHidden(modal, false);
    modal.setAttribute("aria-hidden", "false");
    document.documentElement.classList.add("cariana-size-lock");
  }

  function closeModal(root) {
    var modal = qs(root, "[data-cariana-size-modal]");
    setHidden(modal, true);
    modal.setAttribute("aria-hidden", "true");
    document.documentElement.classList.remove("cariana-size-lock");
  }

  function showMain(root) {
    qs(root, "[data-cariana-main-screen]").classList.remove("cariana-size-screen-hidden");
    qs(root, "[data-cariana-selector-screen]").classList.add("cariana-size-screen-hidden");
  }

  function showSelector(root, type) {
    var state = getState(root);
    var content = qs(root, "[data-cariana-selector-content]");
    var title = qs(root, "[data-cariana-selector-title]");
    var mode = root.getAttribute("data-cariana-size-mode");

    state.selector = type;
    state.temp = null;
    content.innerHTML = "";

    if (type === "body") {
      state.temp = state.body || "promedio";
      title.textContent = "TIPO DE CUERPO";
      buildImageTabs(content, state, bodyLabels, bodyImages, ["delgado", "promedio", "curvy", "extra_curvy"]);
    }

    if (type === "extra" && mode === "woman_top") {
      state.temp = state.bust || { rowIndex: 0, cup: "A" };
      title.textContent = "TAMAÑO DE BUSTO";
      buildBustTable(content, state);
    }

    if (type === "extra" && mode === "woman_bottom") {
      state.temp = state.hip || "promedio";
      title.textContent = "TIPO DE CADERA";
      buildImageTabs(content, state, hipLabels, hipImages, ["rectas", "promedio", "curvy_fit", "curvy"]);
    }

    if (type === "chest" && mode === "woman_top") {
      state.temp = state.bustCm;
      title.textContent = "PECHO";
      buildMeasureRuler(content, state, "Pecho", 70, 145, state.temp, "chest");
    }

    if (type === "waist" && mode === "woman_top") {
      state.temp = state.waistCm;
      title.textContent = "CINTURA";
      buildMeasureRuler(content, state, "Cintura", 55, 125, state.temp, "waist");
    }

    qs(root, "[data-cariana-main-screen]").classList.add("cariana-size-screen-hidden");
    qs(root, "[data-cariana-selector-screen]").classList.remove("cariana-size-screen-hidden");
  }

  function buildImageTabs(content, state, labels, images, options) {
    var img = document.createElement("img");
    img.className = "cariana-size-preview";
    img.src = images[state.temp];
    img.alt = labels[state.temp] || "";
    content.appendChild(img);

    var tabs = document.createElement("div");
    tabs.className = "cariana-size-tabs";

    options.forEach(function (option) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "cariana-size-tab" + (option === state.temp ? " active" : "");
      button.textContent = labels[option];
      button.addEventListener("click", function () {
        state.temp = option;
        img.src = images[option];
        img.alt = labels[option] || "";
        tabs.querySelectorAll(".cariana-size-tab").forEach(function (tab) {
          tab.classList.remove("active");
        });
        button.classList.add("active");
      });
      tabs.appendChild(button);
    });

    content.appendChild(tabs);
  }

  function buildMeasureRuler(content, state, name, min, max, value, dataName) {
    var ruler = makeRuler(name, min, max, value, dataName);
    var track = qs(ruler, "[data-cariana-" + dataName + "-range]");
    var valueLabel = qs(ruler, "[data-cariana-" + dataName + "-value]");

    ruler.classList.add("cariana-size-ruler-open");
    track.addEventListener("scroll", function () {
      state.temp = getScrollRulerValue(track);
      valueLabel.textContent = state.temp + " cm";
    });

    content.appendChild(ruler);

    window.requestAnimationFrame(function () {
      setScrollRulerValue(track, value);
      state.temp = getScrollRulerValue(track);
      valueLabel.textContent = state.temp + " cm";
    });
  }

  function getScrollRulerValue(track) {
    var min = Number(track.getAttribute("data-min"));
    var max = Number(track.getAttribute("data-max"));
    var stepPx = Number(track.getAttribute("data-step-px")) || 10;
    var value = min + Math.round(track.scrollLeft / stepPx);
    return Math.min(max, Math.max(min, value));
  }

  function setScrollRulerValue(track, value) {
    var min = Number(track.getAttribute("data-min"));
    var stepPx = Number(track.getAttribute("data-step-px")) || 10;
    track.scrollLeft = (Number(value) - min) * stepPx;
  }

  function buildBustTable(content, state) {
    var wrap = document.createElement("div");
    wrap.className = "cariana-size-table-wrap";

    var table = document.createElement("table");
    table.className = "cariana-size-table";
    table.innerHTML = "<thead><tr><th>Pecho (cm)</th><th>Copa A</th><th>Copa B</th><th>Copa C</th><th>Copa D</th><th>Copa DD</th></tr></thead>";

    var tbody = document.createElement("tbody");
    bustTable.forEach(function (row) {
      var tr = document.createElement("tr");
      var range = document.createElement("td");
      range.textContent = row.pechoMin + " - " + row.pechoMax;
      tr.appendChild(range);

      cups.forEach(function (cup) {
        var td = document.createElement("td");
        var button = document.createElement("button");
        button.type = "button";
        button.className = "cariana-size-bra" + (state.temp && state.temp.rowIndex === row.rowIndex && state.temp.cup === cup ? " active" : "");
        button.textContent = row[cup];
        button.addEventListener("click", function () {
          state.temp = {
            tallaBra: row[cup],
            pechoMin: row.pechoMin,
            pechoMax: row.pechoMax,
            cup: cup,
            rowIndex: row.rowIndex,
          };
          table.querySelectorAll(".cariana-size-bra").forEach(function (item) {
            item.classList.remove("active");
          });
          button.classList.add("active");
        });
        td.appendChild(button);
        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrap.appendChild(table);
    content.appendChild(wrap);
  }

  function saveSelection(root) {
    var state = getState(root);
    var mode = root.getAttribute("data-cariana-size-mode");
    if (!state.selector || !state.temp) {
      showMain(root);
      return;
    }

    if (state.selector === "body") {
      state.body = state.temp;
      qs(root, "[data-cariana-body-label]").textContent = ": " + bodyLabels[state.body];
    }

    if (state.selector === "extra" && mode === "woman_top") {
      state.bust = state.temp;
      qs(root, "[data-cariana-extra-label]").textContent = ": " + state.bust.tallaBra;
    }

    if (state.selector === "extra" && mode === "woman_bottom") {
      state.hip = state.temp;
      qs(root, "[data-cariana-extra-label]").textContent = ": " + hipLabels[state.hip];
    }

    if (state.selector === "chest" && mode === "woman_top") {
      state.bustCm = Number(state.temp);
      state.chestSelected = true;
      updateTopMeasureLabels(root);
    }

    if (state.selector === "waist" && mode === "woman_top") {
      state.waistCm = Number(state.temp);
      state.waistSelected = true;
      updateTopMeasureLabels(root);
    }

    showMain(root);
  }

  function calculate(root) {
    var mode = root.getAttribute("data-cariana-size-mode");
    if (mode === "woman_top") {
      calculateWomanTop(root);
      return;
    }
    if (mode === "woman_bottom") {
      calculateWomanBottom(root);
    }
  }

  function calculateWomanTop(root) {
    var state = getState(root);
    var chest = state.bustCm;
    var waist = state.waistCm;
    var result = qs(root, "[data-cariana-result]");

    if (!state.chestSelected || !state.waistSelected || !chest || !waist) {
      result.textContent = "Completa todos los campos";
      return;
    }

    var chestIdx = indexByTopMetric(chest, "pechoMin", "pechoMax");
    var waistIdx = indexByTopMetric(waist, "cinturaMin", "cinturaMax");
    var idxFinal = Math.max(chestIdx, waistIdx);

    idxFinal = clampIndex(idxFinal, topSizes);
    renderResult(result, topSizes[idxFinal].talla);
  }

  function interpolate(x, points) {
    if (x <= points[0][0]) {
      var x0 = points[0][0];
      var y0 = points[0][1];
      var x1 = points[1][0];
      var y1 = points[1][1];
      return y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);
    }

    for (var i = 0; i < points.length - 1; i += 1) {
      var a = points[i];
      var b = points[i + 1];
      if (x >= a[0] && x <= b[0]) {
        return a[1] + ((x - a[0]) * (b[1] - a[1])) / (b[0] - a[0]);
      }
    }

    var n = points.length;
    var p0 = points[n - 2];
    var p1 = points[n - 1];
    return p1[1] + ((x - p1[0]) * (p1[1] - p0[1])) / (p1[0] - p0[0]);
  }

  function indexByWaist(cm) {
    var idx = -1;
    for (var i = 0; i < bottomSizes.length; i += 1) {
      if (inRange(cm, bottomSizes[i].cinturaMin, bottomSizes[i].cinturaMax)) idx = i;
    }
    if (idx !== -1) return idx;

    var best = 0;
    var bestDiff = Infinity;
    for (var j = 0; j < bottomSizes.length; j += 1) {
      var diff = Math.abs(cm - center(bottomSizes[j].cinturaMin, bottomSizes[j].cinturaMax));
      if (diff < bestDiff) {
        bestDiff = diff;
        best = j;
      }
    }
    return best;
  }

  function indexByHip(cm) {
    var idx = -1;
    for (var i = 0; i < bottomSizes.length; i += 1) {
      if (inRange(cm, bottomSizes[i].caderaMin, bottomSizes[i].caderaMax)) idx = i;
    }
    if (idx !== -1) return idx;

    var best = 0;
    var bestDiff = Infinity;
    for (var j = 0; j < bottomSizes.length; j += 1) {
      var diff = Math.abs(cm - center(bottomSizes[j].caderaMin, bottomSizes[j].caderaMax));
      if (diff < bestDiff) {
        bestDiff = diff;
        best = j;
      }
    }
    return best;
  }

  function indexByTopMetric(cm, minKey, maxKey) {
    var idx = -1;
    for (var i = 0; i < topSizes.length; i += 1) {
      if (inRange(cm, topSizes[i][minKey], topSizes[i][maxKey])) idx = i;
    }
    if (idx !== -1) return idx;

    var best = 0;
    var bestDiff = Infinity;
    for (var j = 0; j < topSizes.length; j += 1) {
      var diff = Math.abs(cm - center(topSizes[j][minKey], topSizes[j][maxKey]));
      if (diff < bestDiff) {
        bestDiff = diff;
        best = j;
      }
    }
    return best;
  }

  function calculateWomanBottom(root) {
    var state = getState(root);
    var weight = cleanNumber(getFieldValue(qs(root, "[data-cariana-weight]")));
    var height = cleanNumber(getFieldValue(qs(root, "[data-cariana-height]")));
    var result = qs(root, "[data-cariana-result]");

    if (height && height < 3) height = height * 100;

    if (!weight || !height || !state.body || !state.hip) {
      result.textContent = "Completa todos los campos";
      return;
    }

    var waistPoints = [
      [40, 63], [45, 67], [50, 71], [55, 76], [60, 81], [65, 85], [70, 89],
      [75, 94], [80, 98], [85, 102], [90, 106], [95, 110], [100, 114],
    ];
    var hipPoints = [
      [40, 88], [45, 92], [50, 96], [55, 101], [60, 106], [65, 111], [70, 116],
      [75, 121], [80, 126], [85, 131], [90, 136], [95, 140], [100, 144],
    ];

    var waistEst = interpolate(weight, waistPoints);
    var hipEst = interpolate(weight, hipPoints);

    var heightAdjust = 0;
    if (height < 155) heightAdjust = -1;
    else if (height <= 164) heightAdjust = 0;
    else if (height <= 172) heightAdjust = 1;
    else heightAdjust = 2;

    waistEst += heightAdjust;
    hipEst += heightAdjust;

    var bodyAdjust = {
      delgado: { cintura: -3, cadera: -2 },
      promedio: { cintura: 0, cadera: 0 },
      curvy: { cintura: 4, cadera: 5 },
      extra_curvy: { cintura: 7, cadera: 9 },
    };

    waistEst += bodyAdjust[state.body].cintura;
    hipEst += bodyAdjust[state.body].cadera;

    var hipAdjust = {
      rectas: { cintura: -1, cadera: -4 },
      promedio: { cintura: 0, cadera: 0 },
      curvy_fit: { cintura: 1, cadera: 5 },
      curvy: { cintura: 2, cadera: 9 },
    };

    waistEst += hipAdjust[state.hip].cintura;
    hipEst += hipAdjust[state.hip].cadera;

    var waistIdx = indexByWaist(waistEst);
    var hipIdx = indexByHip(hipEst);
    var finalIdx = waistIdx;
    var diff = hipIdx - waistIdx;

    if (hipIdx === waistIdx) {
      finalIdx = hipIdx;
    } else if (Math.abs(diff) >= 2) {
      finalIdx = Math.max(hipIdx, waistIdx);
    } else {
      var preferLarger = state.body === "curvy" || state.body === "extra_curvy" || state.hip === "curvy_fit" || state.hip === "curvy";
      var upperWaist = bottomSizes[waistIdx].cinturaMax;
      var waistNearUpperLimit = waistEst >= upperWaist - 1;
      finalIdx = preferLarger || waistNearUpperLimit ? Math.max(hipIdx, waistIdx) : waistIdx;
    }

    if (hipEst > bottomSizes[finalIdx].caderaMax + 3 && finalIdx < bottomSizes.length - 1) {
      finalIdx += 1;
    }

    finalIdx = clampIndex(finalIdx, bottomSizes);
    renderResult(result, bottomSizes[finalIdx].talla);
  }

  function renderResult(result, size) {
    result.innerHTML =
      '<div class="cariana-size-result-label">Tu talla ideal es</div>' +
      '<div class="cariana-size-result-size">' + size + "</div>";
  }

  document.addEventListener("click", function (event) {
    var openButton = event.target.closest("[data-cariana-size-open]");
    if (openButton) {
      openModal(openButton.closest("[data-cariana-size-root]"));
      return;
    }

    var guideOpen = event.target.closest("[data-cariana-size-guide]");
    if (guideOpen) {
      openGuide(guideOpen.closest("[data-cariana-size-root]"));
      return;
    }

    var root = event.target.closest("[data-cariana-size-root]");
    if (!root) return;

    if (event.target.matches("[data-cariana-close]")) {
      closeModal(root);
      return;
    }

    if (event.target.matches("[data-cariana-weight]")) {
      requestMeasurement(event.target, "weight");
      return;
    }

    if (event.target.matches("[data-cariana-height]")) {
      requestMeasurement(event.target, "height");
      return;
    }

    var topMeasure = event.target.closest("[data-cariana-top-measure]");
    if (topMeasure) {
      showSelector(root, topMeasure.getAttribute("data-cariana-top-measure"));
      return;
    }

    if (event.target.matches("[data-cariana-chest-range], [data-cariana-waist-range]")) {
      updateRulerValue(event.target);
      return;
    }

    if (event.target.matches("[data-cariana-back]")) {
      showMain(root);
      return;
    }

    if (event.target.matches("[data-cariana-body-button]")) {
      showSelector(root, "body");
      return;
    }

    if (event.target.closest("[data-cariana-extra-button]")) {
      showSelector(root, "extra");
      return;
    }

    if (event.target.matches("[data-cariana-save]")) {
      saveSelection(root);
      return;
    }

    if (event.target.matches("[data-cariana-calculate]")) {
      calculate(root);
    }
  });

  function updateRulerValue(range) {
    var root = range.closest("[data-cariana-size-root]");
    var state = getState(root);
    var isChest = range.matches("[data-cariana-chest-range]");
    var value = Number(range.value);
    var label = qs(root, isChest ? "[data-cariana-chest-value]" : "[data-cariana-waist-value]");

    if (isChest && state.selector === "chest") {
      state.temp = value;
    } else if (!isChest && state.selector === "waist") {
      state.temp = value;
    } else if (isChest) {
      state.bustCm = value;
    } else {
      state.waistCm = value;
    }

    if (label) label.textContent = value + " cm";
  }

  document.addEventListener("input", function (event) {
    if (event.target.matches("[data-cariana-chest-range], [data-cariana-waist-range]")) {
      updateRulerValue(event.target);
    }
  });

  document.addEventListener("keydown", function (event) {
    if (event.target.matches("[data-cariana-weight], [data-cariana-height]") && event.key === "Enter") {
      event.preventDefault();
      event.target.blur();
    }
  });
})();
