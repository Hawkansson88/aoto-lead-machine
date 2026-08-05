/** Lead pipeline status labels and styling. */
export const STATUS = {
  ny: { label: "Ej kontaktad", switchLabel: "Ej kontaktad", cls: "b-ny", col: "var(--st-ny)" },
  kontaktad: { label: "Kontaktad", switchLabel: "Kontaktad", cls: "b-kontaktad", col: "var(--st-kontaktad)" },
  mote: { label: "Möte bokat", switchLabel: "Möte bokat", cls: "b-mote", col: "var(--st-mote)" },
  skickad_kredit: {
    label: "Skickad för Kredit-PM",
    switchLabel: "Behöver Kredit",
    cls: "b-kredit",
    col: "var(--st-kredit)",
  },
  invantar_aterkoppling: {
    label: "Inväntar återkoppling",
    switchLabel: "Inväntar återkoppling",
    cls: "b-invantar",
    col: "var(--st-invantar)",
  },
  kund_aktiv: {
    label: "Kund aktiv",
    switchLabel: "Kund aktiv",
    cls: "b-aktiv",
    col: "var(--st-aktiv)",
  },
  ejaktuell: { label: "Ej intressant", switchLabel: "Ej intressant", cls: "b-ejaktuell", col: "var(--st-ej)" },
};

/** Statuses that belong on the credit page. */
export const CREDIT_STATUSES = ["skickad_kredit", "invantar_aterkoppling", "kund_aktiv"];

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

/** Default scoring weights and thresholds (overridable per user). */
export const DEFAULT_SCORING = {
  revenue: { weight: 35, sweet_low: 10, sweet_high: 120, max: 200 },
  employees: { weight: 25, min: 5, max: 50 },
  solidity: { weight: 25, breaks: [15, 30, 45], points: [25, 18, 11, 4] },
  result: { weight: 10, breaks: [-5, 0, 5], points: [0, 4, 8, 10] },
};
