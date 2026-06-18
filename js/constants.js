/** Lead pipeline status labels and styling. */
export const STATUS = {
  ny: { label: "Ej kontaktad", cls: "b-ny", col: "var(--st-ny)" },
  kontaktad: { label: "Kontaktad", cls: "b-kontaktad", col: "var(--st-kontaktad)" },
  mote: { label: "Möte bokat", cls: "b-mote", col: "var(--st-mote)" },
  ejaktuell: { label: "Ej intressant", cls: "b-ejaktuell", col: "var(--st-ej)" },
};

/** Default scoring weights and thresholds (overridable per user). */
export const DEFAULT_SCORING = {
  revenue: { weight: 35, sweet_low: 10, sweet_high: 120, max: 200 },
  employees: { weight: 25, min: 5, max: 50 },
  solidity: { weight: 25, breaks: [15, 30, 45], points: [25, 18, 11, 4] },
  result: { weight: 10, breaks: [-5, 0, 5], points: [0, 4, 8, 10] },
};
