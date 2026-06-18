import { scoringConfig } from "./store.js";

/**
 * Compute a 0–100 score and per-factor breakdown for a lead.
 * Returns { total: null } when the lead has not been enriched yet.
 */
export function scoreBreakdown(lead) {
  if (lead.org_nr == null) {
    return { total: null, parts: [], notEnriched: true };
  }

  const cfg = scoringConfig;

  const msek = (lead.revenue || 0) / 1e6;
  let revenuePts = 0;
  const { sweet_low: sw, sweet_high: sh, max: rm, weight: rw } = cfg.revenue;

  if (msek >= sw && msek <= sh) revenuePts = rw;
  else if (msek > sh && msek <= rm) revenuePts = rw - ((msek - sh) / (rm - sh)) * (rw * 0.35);
  else if (msek > 0 && msek < sw) revenuePts = (msek / sw) * (rw * 0.5);
  revenuePts = Math.max(0, Math.round(revenuePts));

  const e = lead.employees || 0;
  let employeePts = 0;
  const { min: emin, max: emax, weight: ew } = cfg.employees;

  if (e >= emin && e <= emax) employeePts = ew;
  else if (e > 0 && e < emin) employeePts = (e / emin) * (ew * 0.6);
  else if (e > emax) employeePts = Math.max(ew * 0.3, ew - ((e - emax) / emax) * ew);
  employeePts = Math.round(employeePts);

  const solidity = lead.solidity == null ? 40 : lead.solidity;
  const { breaks: sb, points: sp, weight: solWeight } = cfg.solidity;
  const solidityPts =
    solidity <= sb[0] ? sp[0] : solidity <= sb[1] ? sp[1] : solidity <= sb[2] ? sp[2] : sp[3];

  let resultPts = 0;
  if (lead.result_after_fin != null && lead.revenue) {
    const { breaks: rb, points: rpts } = cfg.result;
    const pct = (lead.result_after_fin / lead.revenue) * 100;
    resultPts = pct <= rb[0] ? rpts[0] : pct <= rb[1] ? rpts[1] : pct <= rb[2] ? rpts[2] : rpts[3];
  }

  const parts = [
    { lab: "Omsättning", pts: revenuePts, max: cfg.revenue.weight },
    { lab: "Anställda", pts: employeePts, max: cfg.employees.weight },
    { lab: "Soliditet", pts: solidityPts, max: solWeight },
    { lab: "Resultat", pts: resultPts, max: cfg.result.weight },
  ];

  const rawTotal = parts.reduce((sum, p) => sum + p.pts, 0);
  const maxTotal = parts.reduce((sum, p) => sum + p.max, 0);
  const total = Math.min(100, maxTotal > 0 ? Math.round((rawTotal / maxTotal) * 100) : 0);

  return { total, parts, notEnriched: false };
}
