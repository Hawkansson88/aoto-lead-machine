import { refreshLeadScores, saveUserSettings } from "./data.js";
import { renderAll } from "./render.js";
import { scoringConfig, setScoringConfig } from "./store.js";
import { $, toast } from "./utils.js";

export function openSettings() {
  renderScoringParams();
  $("#settingsModal").classList.add("open");
  $("#modalScrim").classList.add("open");
}

export function closeSettings() {
  $("#settingsModal").classList.remove("open");
  $("#modalScrim").classList.remove("open");
}

function renderScoringParams() {
  const cfg = scoringConfig;
  const params = [
    {
      key: "revenue",
      name: "Omsättning",
      weight: cfg.revenue.weight,
      fields: [
        { key: "sweet_low", label: "Sweet spot från (MSEK)", val: cfg.revenue.sweet_low },
        { key: "sweet_high", label: "Sweet spot till (MSEK)", val: cfg.revenue.sweet_high },
        { key: "max", label: "Max (MSEK)", val: cfg.revenue.max },
      ],
    },
    {
      key: "employees",
      name: "Anställda",
      weight: cfg.employees.weight,
      fields: [
        { key: "min", label: "Min anställda", val: cfg.employees.min },
        { key: "max", label: "Max anställda", val: cfg.employees.max },
      ],
    },
    {
      key: "solidity",
      name: "Soliditet",
      weight: cfg.solidity.weight,
      fields: [
        { key: "b0", label: "Brytpunkt 1 (%)", val: cfg.solidity.breaks[0] },
        { key: "b1", label: "Brytpunkt 2 (%)", val: cfg.solidity.breaks[1] },
        { key: "b2", label: "Brytpunkt 3 (%)", val: cfg.solidity.breaks[2] },
        { key: "p0", label: "Poäng ≤ B1", val: cfg.solidity.points[0] },
        { key: "p1", label: "Poäng B1–B2", val: cfg.solidity.points[1] },
        { key: "p2", label: "Poäng B2–B3", val: cfg.solidity.points[2] },
        { key: "p3", label: "Poäng > B3", val: cfg.solidity.points[3] },
      ],
    },
    {
      key: "result",
      name: "Resultat efter fin.",
      weight: cfg.result.weight,
      fields: [
        { key: "b0", label: "Brytpunkt 1 (%)", val: cfg.result.breaks[0] },
        { key: "b1", label: "Brytpunkt 2 (%)", val: cfg.result.breaks[1] },
        { key: "b2", label: "Brytpunkt 3 (%)", val: cfg.result.breaks[2] },
        { key: "p0", label: "Poäng ≤ B1", val: cfg.result.points[0] },
        { key: "p1", label: "Poäng B1–B2", val: cfg.result.points[1] },
        { key: "p2", label: "Poäng B2–B3", val: cfg.result.points[2] },
        { key: "p3", label: "Poäng > B3", val: cfg.result.points[3] },
      ],
    },
  ];

  $("#scoringParams").innerHTML = params
    .map(
      (p) => `
    <div class="sc-param" data-param="${p.key}">
      <div class="sc-param-head">
        <span class="name">${p.name}</span>
        <div class="weight-wrap">
          <label>Vikt</label>
          <input type="number" class="weight-input" data-param="${p.key}" value="${p.weight}" min="0" max="999">
        </div>
      </div>
      ${
        p.fields.length
          ? `<div class="sc-fields">${p.fields
              .map(
                (f) =>
                  `<div class="sc-field"><label>${f.label}</label><input type="number" data-param="${p.key}" data-field="${f.key}" value="${f.val}"></div>`
              )
              .join("")}</div>`
          : ""
      }
    </div>`
    )
    .join("");

  updateTotalWeight();
  $("#scoringParams").querySelectorAll(".weight-input").forEach((inp) => {
    inp.oninput = updateTotalWeight;
  });
}

function updateTotalWeight() {
  const total = Array.from(document.querySelectorAll(".weight-input")).reduce(
    (sum, inp) => sum + (parseFloat(inp.value) || 0),
    0
  );
  $("#totalWeight").textContent = total + "p";
  $("#totalWeight").style.color = total === 0 ? "var(--sc-low)" : "var(--ink)";
}

export async function saveScoring(userId) {
  const newCfg = structuredClone(scoringConfig);

  document.querySelectorAll(".weight-input").forEach((inp) => {
    newCfg[inp.dataset.param].weight = parseFloat(inp.value) || 0;
  });

  document.querySelectorAll(".sc-fields input").forEach((inp) => {
    const param = inp.dataset.param;
    const field = inp.dataset.field;
    const val = parseFloat(inp.value);

    if (param === "revenue") newCfg.revenue[field] = val;
    if (param === "employees") newCfg.employees[field] = val;
    if (param === "solidity") {
      if (field.startsWith("b")) newCfg.solidity.breaks[+field[1]] = val;
      if (field.startsWith("p")) newCfg.solidity.points[+field[1]] = val;
    }
    if (param === "result") {
      if (field.startsWith("b")) newCfg.result.breaks[+field[1]] = val;
      if (field.startsWith("p")) newCfg.result.points[+field[1]] = val;
    }
  });

  setScoringConfig(newCfg);
  refreshLeadScores();
  renderAll();

  const ok = await saveUserSettings(userId, { scoring: newCfg });
  if (ok) {
    toast("Scoring sparad");
    closeSettings();
  } else {
    toast("Kunde inte spara scoring");
  }
}
