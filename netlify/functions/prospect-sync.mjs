/**
 * AOTO — Prospektsynk: leasingaffärer till slutkund per återförsäljare
 *
 * Hämtar Bilstatistik ReportTypeId -4 (en rad per bil) och sparar rådata i
 * prospect_leasing_tx. Aggregatet byggs sedan av SQL-funktionen
 * recompute_prospect_dealers() — se supabase/prospect_aggregate.sql.
 *
 * Rådata sparas per transaktion eftersom Bilstatistik har en frågegräns per
 * dygn: när raderna ligger i Supabase kan listan skäras om fritt utan nya
 * uttag. Nya uttag lägger till rader; UNIQUE (reg_nr, tx_date, dealer_org_nr)
 * gör att överlappande perioder inte dubbelräknas.
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

/** Fordonets minimiålder vid affären. 1 = allt utom fabriksnytt. */
const AGE_FROM_MONTHS = 1;
/** Bilstatistiks periodalternativ: 1 = år-till-datum. */
const DATE_RANGE_YTD = 1;
/** 5 = föregående kalenderår. Används för att fylla på bakåt. */
export const DATE_RANGE_PREV_YEAR = 5;

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
 *
 * @param {object} [opts]
 * @param {number} [opts.ageFromMonths] Fordonets minimiålder vid affären.
 * @param {number} [opts.dateRangeOptionId] 1 = år-till-datum, 5 = föregående
 *   kalenderår. Rullande 12 månader finns inte som alternativ — det får man
 *   genom att hämta båda och låta 365-dagarsfönstret i omräkningen skära.
 */
export function buildLeasingSalesRequest(opts = {}) {
  const ageFromMonths = opts.ageFromMonths ?? AGE_FROM_MONTHS;
  const dateRangeOptionId = opts.dateRangeOptionId ?? DATE_RANGE_YTD;
  return {
    ReportProfile: {
      ReportTypeId: -4,
      Filter: {
        // 1 = personbil, 3 = lätt lastbil, 5 = tung lastbil
        VehicleTypes: { Values: [1, 3, 5] },
        Leasing: { ExpirationDateRange: {}, Values: [1] },
        // Fordonets ålder vid affären, i månader
        Age: {
          PredefinedVehicleAgeOptionId: -98,
          FirstRegistrationDateRange: {},
          AgeInMonthsRange: { From: ageFromMonths },
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
        DateRangeOptionId: dateRangeOptionId,
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
export async function fetchReportAllRows(requestBody, user, pass) {
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

export async function upsertTransactions(sbUrl, serviceKey, transactions) {
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

/**
 * Bygger om prospect_dealers från sparad rådata.
 *
 * Aggregeringen ligger i SQL (supabase/prospect_aggregate.sql) och inte här,
 * så att listan kan räknas om när som helst utan ett nytt Bilstatistik-uttag.
 * prospect_list rörs inte — ert arbete ligger kvar.
 *
 * @returns {Promise<{dealers: number, transactions: number, period: object|null}>}
 */
async function recomputeDealers(sbUrl, serviceKey) {
  const res = await sbWrite(
    sbUrl,
    serviceKey,
    "rpc/recompute_prospect_dealers",
    "POST",
    {},
    "return=representation",
    "recompute"
  );
  return res.json();
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

    if (dryRun) {
      return json(200, {
        rows_reported: reported,
        rows_fetched: transactions.length + skipped,
        transactions: transactions.length,
        skipped_no_org_nr: skipped,
        sample: transactions.slice(0, 5),
        dry_run: true,
      });
    }

    await upsertTransactions(SUPABASE_URL, serviceKey, transactions);
    const agg = await recomputeDealers(SUPABASE_URL, serviceKey);

    const meta = {
      synced_at: new Date().toISOString(),
      rows_reported: reported,
      rows_fetched: transactions.length + skipped,
      transactions: agg?.transactions ?? transactions.length,
      fetched_this_run: transactions.length,
      skipped_no_org_nr: skipped,
      dealers: agg?.dealers ?? 0,
      period: agg?.period ?? null,
      dry_run: false,
    };

    await saveSyncMeta(SUPABASE_URL, serviceKey, meta);

    return json(200, meta);
  } catch (err) {
    console.error("prospect-sync", err);
    return json(500, { error: err.message || "Okänt fel vid prospektsynk" });
  }
}
