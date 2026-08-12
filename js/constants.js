/** Lead pipeline status labels and styling. */
export const STATUS = {
  ny: { label: "Ej kontaktad", switchLabel: "Ej kontaktad", cls: "b-ny", col: "var(--st-ny)" },
  kontaktad: { label: "Kontaktad", switchLabel: "Kontaktad", cls: "b-kontaktad", col: "var(--st-kontaktad)" },
  skickad_kredit: {
    label: "Kredit önskas",
    switchLabel: "Kredit önskas",
    cls: "b-kredit",
    col: "var(--st-kredit)",
  },
  kund_aktiv: {
    label: "Kund aktiv",
    switchLabel: "Kund aktiv",
    cls: "b-aktiv",
    col: "var(--st-aktiv)",
  },
  ejaktuell: { label: "Ej intressant", switchLabel: "Ej intressant", cls: "b-ejaktuell", col: "var(--st-ej)" },
};

/** Legacy statuses still present in DB until migrated — display only. */
export const LEGACY_STATUS = {
  mote: { label: "Möte bokat", switchLabel: "Möte bokat", cls: "b-mote", col: "var(--st-mote)" },
  invantar_aterkoppling: {
    label: "Inväntar återkoppling",
    switchLabel: "Inväntar återkoppling",
    cls: "b-invantar",
    col: "var(--st-invantar)",
  },
};

export function statusMeta(key) {
  return STATUS[key] || LEGACY_STATUS[key] || STATUS.ny;
}

/** Statuses that belong on the credit page. */
export const CREDIT_STATUSES = ["skickad_kredit", "kund_aktiv"];

/** DNB customer filter options in sidebar. */
export const DNB_FILTERS = {
  alla: { label: "Alla", col: "#7f8eaa" },
  dnb: { label: "DNB-kunder", col: "#2b4c7e" },
  ej_dnb: { label: "Ej DNB", col: "#9aa6b8" },
};

/** Credit checkbox / flag filters. */
export const CREDIT_FLAG_FILTERS = {
  alla: { label: "Alla flaggor", col: "#7f8eaa" },
  kyc_klar: { label: "KYC klar", col: "#0f9d6f", field: "kyc_approved", value: true },
  kyc_ej: { label: "KYC ej klar", col: "#cf8a12", field: "kyc_approved", value: false },
  pm_klar: { label: "Kredit-PM klart", col: "#0f9d6f", field: "kredit_pm_klart", value: true },
  pm_ej: { label: "Kredit-PM ej klart", col: "#cf8a12", field: "kredit_pm_klart", value: false },
  beviljad_klar: { label: "Kredit beviljad", col: "#0f9d6f", field: "kredit_beviljad", value: true },
  beviljad_ej: { label: "Kredit ej beviljad", col: "#cf8a12", field: "kredit_beviljad", value: false },
};

export const ROLES = {
  admin: { label: "Admin", homeView: "salj" },
  saljare: { label: "Säljare", homeView: "salj" },
  kredit: { label: "Kredit", homeView: "kredit" },
};

/**
 * Default scoring for Marknadsanalys (0–100, överstyrbart per användare).
 * Enheter: omsättning i Mkr, andelar i %, lager/sälj i antal, ålder i år.
 */
export const DEFAULT_SCORING = {
  turnover: { weight: 18, sweet_low: 10, sweet_high: 150, max: 400 },
  profit: { weight: 10, breaks: [-5, 0, 5], points: [0, 3, 7, 10] },
  employees: { weight: 10, min: 3, max: 80 },
  lager: { weight: 18, sweet_low: 20, sweet_high: 250, max: 1000 },
  sales: { weight: 14, sweet_low: 30, sweet_high: 400, max: 1500 },
  finance: { weight: 12, sweet_low: 5, sweet_high: 55, max: 100 },
  b2b: { weight: 10, sweet_low: 25, sweet_high: 75, max: 100 },
  age: { weight: 8, sweet_low: 5, sweet_high: 35, max: 80 },
};
