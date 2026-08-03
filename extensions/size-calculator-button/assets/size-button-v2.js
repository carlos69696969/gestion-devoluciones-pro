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
  var chestGuideFallbackImage = "data:image/webp;base64,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";

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
      buildChestGuide(content, root);
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

  function buildChestGuide(content, root) {
    var imageUrl = root.getAttribute("data-cariana-chest-guide-image") || chestGuideFallbackImage;
    var guide = document.createElement("div");
    guide.className = "cariana-chest-guide";

    guide.innerHTML =
      (imageUrl ? '<img src="' + imageUrl + '" alt="Guía visual para medir el pecho" loading="lazy">' : "") +
      '<div class="cariana-chest-guide-text">' +
        '<p>Coloca la cinta alrededor de la parte más prominente del pecho (a la altura de los pezones).</p>' +
        '<p>Verifica que la cinta quede completamente horizontal, tanto al frente como en la espalda.</p>' +
      '</div>';

    content.appendChild(guide);
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
