import { DEFAULT_SCORING } from "./constants.js";
import { refreshLeadScores, saveUserSettings } from "./data.js";
import { renderAll } from "./render.js";
import { scoringConfig, setScoringConfig } from "./store.js";
import { normalizeScoringConfig } from "./scoring.js";
import { $, toast } from "./utils.js";

export function openSettings() {
  renderScoringParams();
  $("#settingsModal")?.classList.add("open");
  $("#modalScrim")?.classList.add("open");
}

export function closeSettings() {
  $("#settingsModal")?.classList.remove("open");
  $("#modalScrim")?.classList.remove("open");
}

const PARAM_DEFS = [
  {
    key: "turnover",
    name: "Omsättning",
    fields: [
      { key: "sweet_low", label: "Sweet spot från (Mkr)" },
      { key: "sweet_high", label: "Sweet spot till (Mkr)" },
      { key: "max", label: "Max (Mkr)" },
    ],
  },
  {
    key: "profit",
    name: "Resultatmarginal",
    fields: [
      { key: "b0", label: "Brytpunkt 1 (%)" },
      { key: "b1", label: "Brytpunkt 2 (%)" },
      { key: "b2", label: "Brytpunkt 3 (%)" },
      { key: "p0", label: "Poäng ≤ B1" },
      { key: "p1", label: "Poäng B1–B2" },
      { key: "p2", label: "Poäng B2–B3" },
      { key: "p3", label: "Poäng > B3" },
    ],
  },
  {
    key: "employees",
    name: "Anställda",
    fields: [
      { key: "min", label: "Min anställda" },
      { key: "max", label: "Max anställda" },
    ],
  },
  {
    key: "lager",
    name: "I lager",
    fields: [
      { key: "sweet_low", label: "Sweet spot från (antal)" },
      { key: "sweet_high", label: "Sweet spot till (antal)" },
      { key: "max", label: "Max (antal)" },
    ],
  },
  {
    key: "sales",
    name: "Sålda 12 mån",
    fields: [
      { key: "sweet_low", label: "Sweet spot från (antal)" },
      { key: "sweet_high", label: "Sweet spot till (antal)" },
      { key: "max", label: "Max (antal)" },
    ],
  },
  {
    key: "finance",
    name: "% lagerfinans",
    fields: [
      { key: "sweet_low", label: "Sweet spot från (%)" },
      { key: "sweet_high", label: "Sweet spot till (%)" },
      { key: "max", label: "Max (%)" },
    ],
  },
  {
    key: "b2b",
    name: "Företagsandel",
    fields: [
      { key: "sweet_low", label: "Sweet spot från (%)" },
      { key: "sweet_high", label: "Sweet spot till (%)" },
      { key: "max", label: "Max (%)" },
    ],
  },
  {
    key: "age",
    name: "Etablering (ålder i år)",
    fields: [
      { key: "sweet_low", label: "Sweet spot från (år)" },
      { key: "sweet_high", label: "Sweet spot till (år)" },
      { key: "max", label: "Max (år)" },
    ],
  },
];

function fieldValue(cfg, key, field) {
  const block = cfg[key] || DEFAULT_SCORING[key];
  if (!block) return 0;
  if (field.startsWith("b") && block.breaks) return block.breaks[+field[1]];
  if (field.startsWith("p") && block.points) return block.points[+field[1]];
  return block[field] ?? 0;
}

function renderScoringParams() {
  const cfg = normalizeScoringConfig(scoringConfig);
  const el = $("#scoringParams");
  if (!el) return;

  el.innerHTML = PARAM_DEFS.map((p) => {
    const weight = cfg[p.key]?.weight ?? 0;
    return `
    <div class="sc-param" data-param="${p.key}">
      <div class="sc-param-head">
        <span class="name">${p.name}</span>
        <div class="weight-wrap">
          <label>Vikt</label>
          <input type="number" class="weight-input" data-param="${p.key}" value="${weight}" min="0" max="999">
        </div>
      </div>
      <div class="sc-fields">${p.fields
        .map(
          (f) =>
            `<div class="sc-field"><label>${f.label}</label><input type="number" data-param="${p.key}" data-field="${f.key}" value="${fieldValue(cfg, p.key, f.key)}"></div>`
        )
        .join("")}</div>
    </div>`;
  }).join("");

  updateTotalWeight();
  el.querySelectorAll(".weight-input").forEach((inp) => {
    inp.oninput = updateTotalWeight;
  });
}

function updateTotalWeight() {
  const total = Array.from(document.querySelectorAll(".weight-input")).reduce(
    (sum, inp) => sum + (parseFloat(inp.value) || 0),
    0
  );
  const tw = $("#totalWeight");
  if (!tw) return;
  tw.textContent = total + "p";
  tw.style.color = total === 0 ? "var(--sc-low)" : "var(--ink)";
}

/**
 * @param {string} userId
 * @param {{ onSaved?: () => void }} [opts]
 */
export async function saveScoring(userId, { onSaved } = {}) {
  const newCfg = normalizeScoringConfig(scoringConfig);

  document.querySelectorAll(".weight-input").forEach((inp) => {
    const key = inp.dataset.param;
    if (!newCfg[key]) return;
    newCfg[key].weight = parseFloat(inp.value) || 0;
  });

  document.querySelectorAll(".sc-fields input").forEach((inp) => {
    const param = inp.dataset.param;
    const field = inp.dataset.field;
    const val = parseFloat(inp.value);
    if (!newCfg[param] || Number.isNaN(val)) return;

    if (field.startsWith("b") && newCfg[param].breaks) {
      newCfg[param].breaks[+field[1]] = val;
    } else if (field.startsWith("p") && newCfg[param].points) {
      newCfg[param].points[+field[1]] = val;
    } else {
      newCfg[param][field] = val;
    }
  });

  setScoringConfig(newCfg);
  refreshLeadScores();

  if (typeof onSaved === "function") {
    onSaved();
  } else {
    renderAll();
  }

  const ok = await saveUserSettings(userId, { scoring: newCfg });
  if (ok) {
    toast("Scoring sparad");
    closeSettings();
  } else {
    toast("Kunde inte spara scoring");
  }
}

export function bindSettingsModal({ userId, onSaved } = {}) {
  $("#settingsBtn")?.addEventListener("click", openSettings);
  $("#modalClose")?.addEventListener("click", closeSettings);
  $("#modalCancel")?.addEventListener("click", closeSettings);
  $("#modalScrim")?.addEventListener("click", closeSettings);
  $("#modalSave")?.addEventListener("click", () => {
    const id = typeof userId === "function" ? userId() : userId;
    if (!id) {
      toast("Du måste vara inloggad");
      return;
    }
    saveScoring(id, { onSaved });
  });
}
