/**
 * AOTO — Prospektsynk: leasingaffärer till slutkund per återförsäljare
 *
 * Hämtar Bilstatistik ReportTypeId -4 (en rad per bil), sparar rådata i
 * prospect_leasing_tx och aggregerar till prospect_dealers.
 *
 * Rådata sparas per transaktion eftersom Bilstatistik har en frågegräns per
 * dygn: när raderna ligger i Supabase kan listan skäras om fritt utan nya uttag.
 *
 * Request-profilen är dokumenterad i
 * reference/bilstatistik/leasing-slutkund-request.json
 *
 * POST body (valfritt): { dry_run?: boolean }  — hämtar och aggregerar utan att skriva
 * Env: BILSTATISTIK_USERNAME, BILSTATISTIK_PASSWORD,
 *      SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (eller SERVICE_ROLE_KEY)
 */

const BILSTATISTIK_API_URL =
  process.env.BILSTATISTIK_API_URL || "https://report-integration.bilstatistik.se";

const MAX_REPORT_PAGE = 1000;
const INSERT_BATCH = 500;

/** Rankingfönster. Bilstatistiks DateRangeOptionId 1 är obekräftad, så vi
 *  fönstrar själva från senaste transaktionen i datan. */
const WINDOW_DAYS = 365;
/** Momentum: senaste kvartalet mot kvartalet dessförinnan. */
const RECENT_DAYS = 90;

/** Bilhandel. 6209/6210 tas med här och rensas lokalt via prospect_exclusions
 *  — ett par finansbolag läcker igenom, men filtret riskerar annars att
 *  stänga ute äkta handlare. */
const DEALER_TRADES = [5803, 5805, 5876, 5878, 5999, 6001, 6209, 6210];
/** Ägare/brukare på den nya affären får inte vara bilhandel eller finansbolag. */
const NON_DEALER_NEGATE = [
  5803, 5804, 5805, 5876, 5877, 5878, 5999, 6000, 6001, 6209, 6210,
];
/** RegistrantClassification 1 = juridisk person. */
const CLASS_FORETAG = 1;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function digitsOrg(value) {
  const d = String(value || "").replace(/\D/g, "");
  return d.length === 10 ? d : null;
}

function pick(obj, ...keys) {
  if (!obj) return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined) return obj[k];
  }
  return undefined;
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return typeof event.body === "string" ? JSON.parse(event.body) : event.body;
  } catch {
    return {};
  }
}

function basicAuthHeader(user, pass) {
  return "Basic " + Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
}

async function verifyUser(token, sbUrl, anonKey) {
  const res = await fetch(`${sbUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
  });
  if (!res.ok) return null;
  return res.json();
}

function bilstatistikErrorMessage(data, text, status) {
  let detail = "";
  if (data?.errors && typeof data.errors === "object") {
    detail = Object.entries(data.errors)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join("; ") : v}`)
      .join(" | ");
  }
  return (
    detail ||
    (data && (data.message || data.title || data.error || data.detail)) ||
    text?.slice(0, 400) ||
    `HTTP ${status}`
  );
}

/**
 * Leasingaffärer till företagskund, en rad per bil.
 *
 * Filtret identifierar ÅF:en via föregående BRUKARE, inte föregående ägare:
 * vid lagerfinansiering står finansbolaget som ägare medan ÅF:en är brukare,
 * och det gäller ungefär var tredje affär. PreviousOwner lämnas därför öppen.
 */
function buildLeasingSalesRequest() {
  return {
    ReportProfile: {
      ReportTypeId: -4,
      Filter: {
        // 1 = personbil, 3 = lätt lastbil, 5 = tung lastbil
        VehicleTypes: { Values: [1, 3, 5] },
        Leasing: { ExpirationDateRange: {}, Values: [1] },
        // Begagnat: bilen minst 12 månader gammal vid affären
        Age: {
          PredefinedVehicleAgeOptionId: -98,
          FirstRegistrationDateRange: {},
          AgeInMonthsRange: { From: 12 },
        },
        // Ny ägare = leasinggivaren
        Owner: {
          CompanyTrades: { Negate: true, Values: NON_DEALER_NEGATE },
          RegistrantClassification: { Values: [CLASS_FORETAG] },
        },
        // Ny brukare = slutkunden, ska vara ett företag (ej privatleasing)
        User: {
          CompanyTrades: { Negate: true, Values: NON_DEALER_NEGATE },
          RegistrantClassification: { Values: [CLASS_FORETAG] },
        },
        // Öppen: är finansbolaget vid lagerfinansierad bil
        PreviousOwner: {
          RegistrantClassification: { Values: [CLASS_FORETAG] },
        },
        // Säljande ÅF
        PreviousUser: {
          CompanyTrades: { Values: DEALER_TRADES },
          RegistrantClassification: { Values: [CLASS_FORETAG] },
        },
      },
      TransactionDataset: {
        DateRange: {},
        DateRangeOptionId: 1,
        TransactionTypeGroupId: 3,
      },
    },
    SortColumnName: "Date",
    SortAscending: false,
    AreaSetId: 18905,
    OutputColumns: [87, 88, 156, 157, 1, 108, 37, 155, 4],
  };
}

async function parseJsonResponse(res) {
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new Error(`Bilstatistik: ${bilstatistikErrorMessage(data, text, res.status)}`);
  }
  return data;
}

async function fetchReport(requestBody, user, pass, count = MAX_REPORT_PAGE) {
  const capped = Math.min(Math.max(Number(count) || MAX_REPORT_PAGE, 1), MAX_REPORT_PAGE);
  const res = await fetch(
    `${BILSTATISTIK_API_URL}/reports?count=${encodeURIComponent(capped)}`,
    {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(user, pass),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(requestBody),
    }
  );
  return parseJsonResponse(res);
}

async function createReportHandle(requestBody, user, pass) {
  const res = await fetch(`${BILSTATISTIK_API_URL}/reports/handles`, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(user, pass),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(requestBody),
  });
  const data = await parseJsonResponse(res);
  const id = pick(data, "id", "Id");
  if (!id) throw new Error("Bilstatistik: saknar report handle-id");
  return id;
}

async function fetchReportPage(handleId, offset, count, user, pass) {
  const capped = Math.min(Math.max(Number(count) || MAX_REPORT_PAGE, 1), MAX_REPORT_PAGE);
  const url =
    `${BILSTATISTIK_API_URL}/reports/handles/${encodeURIComponent(handleId)}/result` +
    `?offset=${encodeURIComponent(offset)}&count=${encodeURIComponent(capped)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: basicAuthHeader(user, pass),
      Accept: "application/json",
    },
  });
  return parseJsonResponse(res);
}

/** Hämtar alla rader (paginerar via handle om >1000). */
async function fetchReportAllRows(requestBody, user, pass) {
  const first = await fetchReport(requestBody, user, pass, MAX_REPORT_PAGE);
  const total = Number(pick(first, "TotalRowCount", "totalRowCount")) || 0;
  const rows = [...(pick(first, "Rows", "rows") || [])];
  if (total <= rows.length) return { ...first, Rows: rows, TotalRowCount: total };

  const handleId = await createReportHandle(requestBody, user, pass);
  for (let offset = rows.length; offset < total; offset += MAX_REPORT_PAGE) {
    const page = await fetchReportPage(handleId, offset, MAX_REPORT_PAGE, user, pass);
    const pageRows = pick(page, "Rows", "rows") || [];
    if (!pageRows.length) break;
    rows.push(...pageRows);
  }

  return { ...first, Rows: rows, TotalRowCount: total };
}

function columnIndex(data) {
  const columns = pick(data, "Columns", "columns") || [];
  const colIndex = {};
  for (const col of columns) {
    const name = pick(col, "Name", "name");
    const idx = pick(col, "CellIndex", "cellIndex");
    if (name != null && idx != null) colIndex[name] = idx;
  }
  return colIndex;
}

function isoDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** @returns {Array<Record<string, unknown>>} en post per bil */
export function parseTransactions(report) {
  const col = columnIndex(report);
  const rows = pick(report, "Rows", "rows") || [];

  const idxRegNr = col.RegistrationNumber;
  const idxDate = col.Date;
  const idxDealer = col.PreviousPrimaryUserDisplayName;
  const idxDealerOrg = col.PreviousPrimaryUserVisibleCompanyRegistrationNumber;
  const idxPrevOwnerOrg = col.PreviousPrimaryOwnerVisibleCompanyRegistrationNumber;
  const idxMake = col.MakeName;
  const idxHolding = col.CurrentStateDurationDisplayString;
  const idxFinance = col.PrimaryOwnerDisplayName;
  const idxCustomer = col.PrimaryUserDisplayName;

  if (idxDealerOrg == null) {
    throw new Error(
      "Bilstatistik: svaret saknar kolumnen för föregående brukares org.nr " +
        "(PreviousPrimaryUserVisibleCompanyRegistrationNumber). Kontrollera OutputColumns."
    );
  }

  const out = [];
  let skippedNoOrg = 0;

  for (const row of rows) {
    if (pick(row, "RowType", "rowType") === 1) continue;
    const cells = pick(row, "Cells", "cells") || [];

    const orgNr = digitsOrg(cells[idxDealerOrg]);
    const txDate = isoDate(cells[idxDate]);
    const regNr = String(cells[idxRegNr] || "").trim().toUpperCase();
    if (!orgNr || !txDate || !regNr) {
      skippedNoOrg += 1;
      continue;
    }

    out.push({
      reg_nr: regNr,
      tx_date: txDate,
      dealer_org_nr: orgNr,
      dealer_name: cells[idxDealer] ? String(cells[idxDealer]).trim() : null,
      prev_owner_org_nr: digitsOrg(cells[idxPrevOwnerOrg]),
      make_name: cells[idxMake] ? String(cells[idxMake]).trim() : null,
      holding_time: cells[idxHolding] ? String(cells[idxHolding]).trim() : null,
      finance_company: cells[idxFinance] ? String(cells[idxFinance]).trim() : null,
      end_customer: cells[idxCustomer] ? String(cells[idxCustomer]).trim() : null,
    });
  }

  return { transactions: out, skipped: skippedNoOrg };
}

/** "1 dag" / "3 veckor" / "8 månader" / "3 år" → ungefärligt antal dagar. */
function holdingDays(text) {
  const s = String(text || "").toLowerCase();
  const n = Number((s.match(/\d+/) || [])[0]);
  if (!Number.isFinite(n)) return null;
  if (s.includes("dag")) return n;
  if (s.includes("vecka") || s.includes("veckor")) return n * 7;
  if (s.includes("månad")) return n * 30;
  if (s.includes("år")) return n * 365;
  return null;
}

function daysBetween(fromIso, toIso) {
  return (Date.parse(toIso) - Date.parse(fromIso)) / 86400000;
}

function topCounts(map, limit = 12) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

/**
 * Aggregerar transaktioner per ÅF över ett fönster bakåt från senaste
 * transaktionen i datan.
 */
export function aggregateDealers(transactions) {
  if (!transactions.length) return { dealers: [], period: null };

  const dates = transactions.map((t) => t.tx_date).sort();
  const maxDate = dates[dates.length - 1];
  const windowStart = new Date(Date.parse(maxDate) - WINDOW_DAYS * 86400000)
    .toISOString()
    .slice(0, 10);
  const recentStart = new Date(Date.parse(maxDate) - RECENT_DAYS * 86400000)
    .toISOString()
    .slice(0, 10);
  const prevStart = new Date(Date.parse(maxDate) - 2 * RECENT_DAYS * 86400000)
    .toISOString()
    .slice(0, 10);

  /** @type {Map<string, any>} */
  const byOrg = new Map();

  for (const tx of transactions) {
    if (tx.tx_date < windowStart) continue;

    let agg = byOrg.get(tx.dealer_org_nr);
    if (!agg) {
      agg = {
        org_nr: tx.dealer_org_nr,
        company_name: tx.dealer_name,
        deals_total: 0,
        customers: new Set(),
        deals_recent_90d: 0,
        deals_prev_90d: 0,
        floorplan: 0,
        passthrough: 0,
        holdingKnown: 0,
        first_tx: tx.tx_date,
        last_tx: tx.tx_date,
        finance: new Map(),
        makes: new Map(),
        months: new Map(),
      };
      byOrg.set(tx.dealer_org_nr, agg);
    }

    // Senaste namnet vinner — rapporten är sorterad datum fallande
    if (!agg.company_name && tx.dealer_name) agg.company_name = tx.dealer_name;

    agg.deals_total += 1;
    if (tx.end_customer) agg.customers.add(tx.end_customer.toLowerCase());
    if (tx.tx_date < agg.first_tx) agg.first_tx = tx.tx_date;
    if (tx.tx_date > agg.last_tx) agg.last_tx = tx.tx_date;

    if (tx.tx_date >= recentStart) agg.deals_recent_90d += 1;
    else if (tx.tx_date >= prevStart) agg.deals_prev_90d += 1;

    // Ägaren var någon annan än ÅF:en → bilen låg på lagerfinansiering
    if (tx.prev_owner_org_nr && tx.prev_owner_org_nr !== tx.dealer_org_nr) {
      agg.floorplan += 1;
    }

    const held = holdingDays(tx.holding_time);
    if (held != null) {
      agg.holdingKnown += 1;
      if (held < 30) agg.passthrough += 1;
    }

    if (tx.finance_company) {
      agg.finance.set(tx.finance_company, (agg.finance.get(tx.finance_company) || 0) + 1);
    }
    if (tx.make_name) {
      agg.makes.set(tx.make_name, (agg.makes.get(tx.make_name) || 0) + 1);
    }
    const month = tx.tx_date.slice(0, 7);
    agg.months.set(month, (agg.months.get(month) || 0) + 1);
  }

  const dealers = [...byOrg.values()].map((a) => ({
    org_nr: a.org_nr,
    company_name: a.company_name,
    deals_total: a.deals_total,
    distinct_customers: a.customers.size,
    deals_recent_90d: a.deals_recent_90d,
    deals_prev_90d: a.deals_prev_90d,
    floorplan_share: a.deals_total ? Number((a.floorplan / a.deals_total).toFixed(4)) : null,
    passthrough_share: a.holdingKnown
      ? Number((a.passthrough / a.holdingKnown).toFixed(4))
      : null,
    first_tx: a.first_tx,
    last_tx: a.last_tx,
    finance_companies: topCounts(a.finance),
    makes: topCounts(a.makes),
    months: Object.fromEntries([...a.months.entries()].sort()),
  }));

  dealers.sort((a, b) => b.deals_total - a.deals_total);

  return {
    dealers,
    period: {
      first_tx: dates[0],
      last_tx: maxDate,
      window_start: windowStart,
      window_days: WINDOW_DAYS,
      span_days: Math.round(daysBetween(dates[0], maxDate)),
    },
  };
}

// ── Supabase ─────────────────────────────────────────────────────────────

function sbHeaders(serviceKey, prefer) {
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };
  if (prefer) headers.Prefer = prefer;
  return headers;
}

async function sbWrite(sbUrl, serviceKey, path, method, payload, prefer, label) {
  const res = await fetch(`${sbUrl}/rest/v1/${path}`, {
    method,
    headers: sbHeaders(serviceKey, prefer),
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase ${label}: ${err.slice(0, 400)}`);
  }
  return res;
}

async function upsertTransactions(sbUrl, serviceKey, transactions) {
  const now = new Date().toISOString();
  for (let i = 0; i < transactions.length; i += INSERT_BATCH) {
    const batch = transactions
      .slice(i, i + INSERT_BATCH)
      .map((t) => ({ ...t, imported_at: now }));
    await sbWrite(
      sbUrl,
      serviceKey,
      "prospect_leasing_tx?on_conflict=reg_nr,tx_date,dealer_org_nr",
      "POST",
      batch,
      "resolution=merge-duplicates,return=minimal",
      "tx upsert"
    );
  }
}

async function replaceDealers(sbUrl, serviceKey, dealers) {
  // Nollställ aggregatet så att ÅF som fallit ur perioden inte ligger kvar
  // med gamla siffror. prospect_list rörs inte — arbetet ligger kvar.
  await sbWrite(
    sbUrl,
    serviceKey,
    "prospect_dealers?org_nr=not.is.null",
    "DELETE",
    null,
    "return=minimal",
    "dealers delete"
  );

  const now = new Date().toISOString();
  for (let i = 0; i < dealers.length; i += INSERT_BATCH) {
    const batch = dealers.slice(i, i + INSERT_BATCH).map((d) => ({ ...d, updated_at: now }));
    await sbWrite(
      sbUrl,
      serviceKey,
      "prospect_dealers?on_conflict=org_nr",
      "POST",
      batch,
      "resolution=merge-duplicates,return=minimal",
      "dealers upsert"
    );
  }
}

async function saveSyncMeta(sbUrl, serviceKey, meta) {
  await sbWrite(
    sbUrl,
    serviceKey,
    "app_state?on_conflict=key",
    "POST",
    [{ key: "prospect_sync", value: meta, updated_at: new Date().toISOString() }],
    "resolution=merge-duplicates,return=minimal",
    "sync meta"
  );
}

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const {
    BILSTATISTIK_USERNAME,
    BILSTATISTIK_PASSWORD,
    SUPABASE_URL: envUrl,
    SUPABASE_ANON_KEY,
    SUPABASE_ANON,
    SUPABASE_SERVICE_ROLE_KEY,
    SERVICE_ROLE_KEY,
  } = process.env;

  const SUPABASE_URL = envUrl || "https://plydduphthqhpmwasznr.supabase.co";
  const anonKey =
    SUPABASE_ANON_KEY ||
    SUPABASE_ANON ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBseWRkdXBodGhxaHBtd2Fzem5yIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1MTcxNjksImV4cCI6MjA5NjA5MzE2OX0.fdxR8DXxFjsT0f7fL0LamsNTj6WdFx5R_rFdi67SNWo";
  const serviceKey = SUPABASE_SERVICE_ROLE_KEY || SERVICE_ROLE_KEY;

  if (!BILSTATISTIK_USERNAME || !BILSTATISTIK_PASSWORD) {
    return json(500, { error: "Saknar BILSTATISTIK_USERNAME/PASSWORD i .env" });
  }
  if (!serviceKey) {
    return json(500, { error: "Saknar SERVICE_ROLE_KEY / SUPABASE_SERVICE_ROLE_KEY" });
  }

  const jwt = (event.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json(401, { error: "Ingen session" });
  const user = await verifyUser(jwt, SUPABASE_URL, anonKey);
  if (!user) return json(401, { error: "Ogiltig session" });

  const body = parseBody(event);
  const dryRun = body.dry_run === true;

  try {
    const report = await fetchReportAllRows(
      buildLeasingSalesRequest(),
      BILSTATISTIK_USERNAME,
      BILSTATISTIK_PASSWORD
    );

    const reported = Number(pick(report, "TotalRowCount", "totalRowCount")) || 0;
    const { transactions, skipped } = parseTransactions(report);

    if (!transactions.length) {
      return json(502, { error: "Bilstatistik returnerade inga leasingaffärer" });
    }

    const { dealers, period } = aggregateDealers(transactions);

    const meta = {
      synced_at: new Date().toISOString(),
      rows_reported: reported,
      rows_fetched: transactions.length + skipped,
      transactions: transactions.length,
      skipped_no_org_nr: skipped,
      dealers: dealers.length,
      period,
      dry_run: dryRun,
    };

    if (dryRun) {
      return json(200, { ...meta, top: dealers.slice(0, 20) });
    }

    await upsertTransactions(SUPABASE_URL, serviceKey, transactions);
    await replaceDealers(SUPABASE_URL, serviceKey, dealers);
    await saveSyncMeta(SUPABASE_URL, serviceKey, meta);

    return json(200, meta);
  } catch (err) {
    console.error("prospect-sync", err);
    return json(500, { error: err.message || "Okänt fel vid prospektsynk" });
  }
}
