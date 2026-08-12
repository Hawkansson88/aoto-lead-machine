import { DEFAULT_SCORING } from "./constants.js";
import { scoringConfig } from "./store.js";

/** Sweet-spot curve: full weight in [low, high], fade above toward max, ramp below. */
function sweetSpotPts(value, { sweet_low: sw, sweet_high: sh, max: mx, weight: w }) {
  if (value == null || !Number.isFinite(value) || value < 0 || w <= 0) return 0;
  let pts = 0;
  if (value >= sw && value <= sh) pts = w;
  else if (value > sh && mx > sh) pts = w - ((value - sh) / (mx - sh)) * (w * 0.35);
  else if (value > 0 && value < sw) pts = (value / sw) * (w * 0.5);
  else if (value > mx) pts = Math.max(0, w * 0.2);
  return Math.max(0, Math.round(pts));
}

/** Band: full weight in [min, max]. */
function bandPts(value, { min: lo, max: hi, weight: w }) {
  if (value == null || !Number.isFinite(value) || value <= 0 || w <= 0) return 0;
  let pts = 0;
  if (value >= lo && value <= hi) pts = w;
  else if (value > 0 && value < lo) pts = (value / lo) * (w * 0.6);
  else if (value > hi) pts = Math.max(w * 0.3, w - ((value - hi) / hi) * w);
  return Math.round(Math.max(0, pts));
}

/** Bucketed points from breaks/points arrays. */
function bucketPts(value, { breaks: br, points: pts }) {
  if (value == null || !Number.isFinite(value) || !br?.length || !pts?.length) return 0;
  if (value <= br[0]) return pts[0];
  if (value <= br[1]) return pts[1];
  if (value <= br[2]) return pts[2];
  return pts[3] ?? pts[pts.length - 1];
}

function asPct(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n > 0 && n <= 1 ? n * 100 : n;
}

function num(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Merge saved scoring with defaults (handles old lead-scoring shape). */
export function normalizeScoringConfig(saved) {
  const base = structuredClone(DEFAULT_SCORING);
  if (!saved || typeof saved !== "object") return base;

  // Old Sälj shape → map what we can
  if (saved.revenue && !saved.turnover) {
    base.turnover = {
      ...base.turnover,
      weight: saved.revenue.weight ?? base.turnover.weight,
      sweet_low: saved.revenue.sweet_low ?? base.turnover.sweet_low,
      sweet_high: saved.revenue.sweet_high ?? base.turnover.sweet_high,
      max: saved.revenue.max ?? base.turnover.max,
    };
  }
  if (saved.employees && saved.employees.min != null) {
    base.employees = { ...base.employees, ...saved.employees };
  }
  if (saved.profit?.breaks && !saved.turnover) {
    base.profit = { ...base.profit, ...saved.profit };
  }

  for (const key of Object.keys(base)) {
    if (saved[key] && typeof saved[key] === "object") {
      base[key] = { ...base[key], ...saved[key] };
      if (Array.isArray(saved[key].breaks)) base[key].breaks = [...saved[key].breaks];
      if (Array.isArray(saved[key].points)) base[key].points = [...saved[key].points];
    }
  }
  return base;
}

/**
 * Score a Marknadsanalys / dealer_market_stats row → 0–100 + breakdown.
 * @param {Record<string, unknown>} row
 * @param {number|null} [foretagsandel] ratio 0–1 or percent
 */
export function scoreMarketBreakdown(row, foretagsandel = null) {
  if (!row || (!row.org_nr && !row.company_name)) {
    return { total: null, parts: [], notEnriched: true };
  }

  const cfg = scoringConfig;
  const turnoverMkr = (() => {
    const tkr = num(row.turnover_tkr);
    return tkr == null ? null : tkr / 1000;
  })();
  const profitTkr = num(row.profit_tkr);
  const turnoverTkr = num(row.turnover_tkr);
  const marginPct =
    profitTkr != null && turnoverTkr && turnoverTkr !== 0 ? (profitTkr / turnoverTkr) * 100 : null;

  const emp = num(row.employees);
  const lager = num(row.lagerantal);
  const sales = num(row.saljvolym_12m);
  const financePct = asPct(row.lager_finansierat_andel);
  const b2bPct = asPct(foretagsandel != null ? foretagsandel : null);
  const year = num(row.established_year);
  const age =
    year != null && year >= 1800 ? new Date().getFullYear() - Math.round(year) : null;

  const parts = [
    {
      lab: "Omsättning",
      pts: sweetSpotPts(turnoverMkr ?? -1, cfg.turnover),
      max: cfg.turnover.weight,
    },
    {
      lab: "Resultatmarginal",
      pts: bucketPts(marginPct, cfg.profit),
      max: cfg.profit.weight,
    },
    {
      lab: "Anställda",
      pts: bandPts(emp, cfg.employees),
      max: cfg.employees.weight,
    },
    {
      lab: "I lager",
      pts: sweetSpotPts(lager ?? -1, cfg.lager),
      max: cfg.lager.weight,
    },
    {
      lab: "Sålda 12 mån",
      pts: sweetSpotPts(sales ?? -1, cfg.sales),
      max: cfg.sales.weight,
    },
    {
      lab: "% lagerfinans",
      pts: sweetSpotPts(financePct ?? -1, cfg.finance),
      max: cfg.finance.weight,
    },
    {
      lab: "Företagsandel",
      pts: sweetSpotPts(b2bPct ?? -1, cfg.b2b),
      max: cfg.b2b.weight,
    },
    {
      lab: "Etablering (ålder)",
      pts: sweetSpotPts(age ?? -1, cfg.age),
      max: cfg.age.weight,
    },
  ];

  // Treat missing as 0 pts (sweetSpot with -1 yields 0)
  const rawTotal = parts.reduce((sum, p) => sum + p.pts, 0);
  const maxTotal = parts.reduce((sum, p) => sum + p.max, 0);
  const total = Math.min(100, maxTotal > 0 ? Math.round((rawTotal / maxTotal) * 100) : 0);

  return { total, parts, notEnriched: false };
}

/**
 * Score a CRM lead (maps financials into market scorer; missing bilstatistik = 0 pts).
 */
export function scoreBreakdown(lead) {
  if (lead?.org_nr == null) {
    return { total: null, parts: [], notEnriched: true };
  }
  const row = {
    org_nr: lead.org_nr,
    company_name: lead.company_name,
    turnover_tkr: lead.revenue != null ? Number(lead.revenue) / 1000 : null,
    profit_tkr: lead.result_after_fin != null ? Number(lead.result_after_fin) / 1000 : null,
    employees: lead.employees,
    established_year: lead.established_year ?? null,
    lagerantal: lead.lagerantal ?? null,
    saljvolym_12m: lead.saljvolym_12m ?? null,
    lager_finansierat_andel: lead.lager_finansierat_andel ?? null,
  };
  return scoreMarketBreakdown(row, lead.foretagsandel ?? null);
}
