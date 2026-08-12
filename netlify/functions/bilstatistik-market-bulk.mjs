/**
 * AOTO CRM — Bilstatistik bulk: marknadsanalys
 *
 * POST body (optional JSON):
 *   { smoke_org_nrs?: string[] }  — begränsa säljstegen till dessa org.nr (API-filter)
 *
 * Steg 1: bestånd (ReportType 10) → firmografi + lagerantal
 * Steg 2: sälj totalt + privat + företag (ReportType 394, 12 mån)
 *   Join via bolagsnamn mot beståndet. Totalt: Antal >= 20.
 * Djupdata (finans) skrivs inte över.
 */

const BILSTATISTIK_API_URL =
  process.env.BILSTATISTIK_API_URL || "https://report-integration.bilstatistik.se";

const MAX_REPORT_PAGE = 1000;
const UPSERT_BATCH = 150;
const MIN_SALES_VOLUME = 20;
/** Ny ägare: 4 = privatperson, 1 = företag (Bilstatistik RegistrantClassification). */
const OWNER_CLASS_PRIVAT = 4;
const OWNER_CLASS_FORETAG = 1;

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

function parseBody(event) {
  if (!event.body) return {};
  try {
    return typeof event.body === "string" ? JSON.parse(event.body) : event.body;
  } catch {
    return {};
  }
}

/** Bestånd per brukare — bilhandel, PB+LL, flotta ≥20. */
function buildMarketDealersRequest() {
  return {
    ReportProfile: {
      ReportTypeId: 10,
      Filter: {
        VehicleTypes: { Values: [1, 3] },
        User: {
          CompanyTrades: {
            OnlyPrimaryTrades: true,
            Values: [5803, 5876, 5999],
          },
          RegistrantClassification: { Values: [1] },
          FleetSize: {
            VehicleTypesInFleet: { Values: [1, 3] },
            From: 20,
          },
        },
      },
      PopulationDataset: { DateOptionId: 1 },
    },
    SortColumnName: "IAar",
    SortAscending: false,
    AreaSetId: 18905,
    OutputColumns: [160, 162, 161, 164, 170, 169, 173, 179, 184, 182],
  };
}

/**
 * Ägar-/brukarbyte per föregående ägare (ReportType 394).
 * DateRangeOptionId 5 = rullande 12 mån.
 * @param {string[]|null} orgNrs
 * @param {number|null} ownerClassification — Owner.RegistrantClassification (4 privat, 1 företag, null = alla)
 */
function buildSalesByPreviousOwnerRequest(orgNrs = null, ownerClassification = null) {
  const previousOwner = {
    CompanyTrades: {
      OnlyPrimaryTrades: true,
      Values: [5803, 5876, 5999],
    },
    RegistrantClassification: { Values: [1] },
  };
  if (Array.isArray(orgNrs) && orgNrs.length) {
    previousOwner.CompanyIdentifiers = { Values: orgNrs };
  }

  const filter = {
    VehicleTypes: { Values: [1, 3] },
    PreviousOwner: previousOwner,
    PreviousUser: {
      CompanyTrades: {
        OnlyPrimaryTrades: true,
        Values: [5803, 5876, 5999],
      },
      RegistrantClassification: { Values: [1] },
      FleetSize: {
        VehicleTypesInFleet: { Values: [1, 3] },
        From: 20,
      },
    },
  };

  if (ownerClassification != null) {
    filter.Owner = {
      RegistrantClassification: { Values: [ownerClassification] },
    };
  }

  return {
    ReportProfile: {
      ReportTypeId: 394,
      Filter: filter,
      TransactionDataset: {
        DateRange: {},
        DateRangeOptionId: 5,
        TransactionTypeGroupId: 3,
      },
    },
    SortColumnName: "IAar",
    SortAscending: false,
    AreaSetId: 18905,
  };
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

async function fetchReportAllRows(requestBody, user, pass) {
  const first = await fetchReport(requestBody, user, pass, MAX_REPORT_PAGE);
  const total = Number(pick(first, "TotalRowCount", "totalRowCount")) || 0;
  const rows = [...(pick(first, "Rows", "rows") || [])];
  if (total <= rows.length) return first;

  const handleId = await createReportHandle(requestBody, user, pass);
  for (let offset = rows.length; offset < total; offset += MAX_REPORT_PAGE) {
    const page = await fetchReportPage(handleId, offset, MAX_REPORT_PAGE, user, pass);
    const pageRows = pick(page, "Rows", "rows") || [];
    if (!pageRows.length) break;
    rows.push(...pageRows);
  }

  return {
    ...first,
    Rows: rows,
    rows,
    TotalRowCount: total,
    totalRowCount: total,
  };
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

function numOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseMarketRows(data) {
  const colIndex = columnIndex(data);
  const rows = pick(data, "Rows", "rows") || [];
  const out = [];
  const seen = new Set();

  for (const row of rows) {
    const rowType = pick(row, "RowType", "rowType");
    if (rowType === 1) continue;
    const cells = pick(row, "Cells", "cells") || [];

    const orgNr = digitsOrg(cells[colIndex.CVRNr]);
    if (!orgNr || seen.has(orgNr)) continue;
    seen.add(orgNr);

    const companyName = cells[colIndex.PrimaryUserCompanyDisplayName];
    if (!companyName || String(companyName).toLowerCase().includes("total")) continue;

    out.push({
      org_nr: orgNr,
      company_name: String(companyName).trim(),
      address: cells[colIndex.CompanyStreetNameAndNumber]
        ? String(cells[colIndex.CompanyStreetNameAndNumber]).trim()
        : null,
      postcode: cells[colIndex.CompanyPostCode]
        ? String(cells[colIndex.CompanyPostCode]).trim()
        : null,
      city: cells[colIndex.CompanyTown]
        ? String(cells[colIndex.CompanyTown]).trim()
        : null,
      industry: cells[colIndex.CompanyTradeDisplayName]
        ? String(cells[colIndex.CompanyTradeDisplayName]).trim()
        : null,
      established_year: numOrNull(cells[colIndex.CompanyYearOfEstablishment]),
      employees: numOrNull(
        cells[colIndex.CompanyLatestFinancialFiguresNumberOfEmployees]
      ),
      turnover_tkr: numOrNull(cells[colIndex.CompanyLatestFinancialFiguresTurnover]),
      equity_tkr: numOrNull(cells[colIndex.CompanyLatestFinancialFiguresEquity]),
      profit_tkr: numOrNull(
        cells[colIndex.CompanyLatestFinancialFiguresProfitForTheYear]
      ),
      lagerantal: Math.round(numOrNull(cells[colIndex.IAar]) || 0),
    });
  }

  return out;
}

function salesCompanyName(cells, colIndex) {
  const keys = [
    "PreviousPrimaryOwnerCompanyDisplayName",
    "PrimaryOwnerCompanyDisplayName",
    "PreviousOwnerCompanyDisplayName",
    "PrimaryUserCompanyDisplayName",
  ];
  for (const key of keys) {
    if (colIndex[key] == null) continue;
    const v = cells[colIndex[key]];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return null;
}

/** Normalize company names for join when ReportType 394 lacks CVRNr. */
function normalizeCompanyKey(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(ab|aktiebolag|hb|kb|filial)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildNameToOrgMap(dealers) {
  const map = new Map();
  const ambiguous = new Set();
  for (const d of dealers) {
    const key = normalizeCompanyKey(d.company_name);
    if (!key) continue;
    if (ambiguous.has(key)) continue;
    if (map.has(key) && map.get(key) !== d.org_nr) {
      map.delete(key);
      ambiguous.add(key);
      continue;
    }
    map.set(key, d.org_nr);
  }
  return { map, ambiguousCount: ambiguous.size };
}

function parseSalesRows(data) {
  const colIndex = columnIndex(data);
  if (colIndex.IAar == null) {
    const columnNames = Object.keys(colIndex);
    throw new Error(
      `Säljrapport saknar IAar-kolumn (fick: ${columnNames.join(", ") || "inga"}).`
    );
  }

  const rows = pick(data, "Rows", "rows") || [];
  const out = [];
  const seenNames = new Set();

  for (const row of rows) {
    const rowType = pick(row, "RowType", "rowType");
    if (rowType === 1) continue;
    const cells = pick(row, "Cells", "cells") || [];

    const name = salesCompanyName(cells, colIndex);
    if (!name || name.toLowerCase().includes("total")) continue;

    const nameKey = normalizeCompanyKey(name);
    if (!nameKey || seenNames.has(nameKey)) continue;
    seenNames.add(nameKey);

    const orgNr = colIndex.CVRNr != null ? digitsOrg(cells[colIndex.CVRNr]) : null;
    const antal = Math.round(numOrNull(cells[colIndex.IAar]) || 0);
    out.push({
      org_nr: orgNr,
      company_name: name,
      name_key: nameKey,
      antal,
    });
  }

  return out;
}

/** Map sales rows → org_nr via CVR or company name; optionally require stock membership. */
function joinSalesToOrgs(salesParsed, { nameToOrg, stockOrgSet, minAntal = 0 }) {
  let unmatched = 0;
  const joined = [];
  for (const r of salesParsed) {
    if (r.antal < minAntal) continue;
    let orgNr = r.org_nr;
    if (!orgNr) orgNr = nameToOrg.get(r.name_key) || null;
    if (!orgNr || !stockOrgSet.has(orgNr)) {
      unmatched += 1;
      continue;
    }
    joined.push({
      org_nr: orgNr,
      company_name: r.company_name,
      antal: r.antal,
    });
  }
  return { joined, unmatched };
}

async function upsertBatch(sbUrl, serviceKey, batch, now, { touchBulk = true } = {}) {
  const payload = batch.map((r) => {
    const row = { ...r, updated_at: now };
    if (touchBulk) row.bulk_updated_at = now;
    return row;
  });

  const res = await fetch(`${sbUrl}/rest/v1/dealer_market_stats?on_conflict=org_nr`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase upsert: ${err.slice(0, 400)}`);
  }
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
  const smokeOrgNrs = Array.isArray(body.smoke_org_nrs)
    ? body.smoke_org_nrs.map(digitsOrg).filter(Boolean)
    : null;

  try {
    const now = new Date().toISOString();

    // ── Steg 1: bestånd ─────────────────────────────────────────────
    const stockReport = await fetchReportAllRows(
      buildMarketDealersRequest(),
      BILSTATISTIK_USERNAME,
      BILSTATISTIK_PASSWORD
    );
    const dealers = parseMarketRows(stockReport);
    if (!dealers.length) {
      return json(502, { error: "Bilstatistik returnerade inga handlare (bestånd)" });
    }

    for (let i = 0; i < dealers.length; i += UPSERT_BATCH) {
      await upsertBatch(
        SUPABASE_URL,
        serviceKey,
        dealers.slice(i, i + UPSERT_BATCH),
        now,
        { touchBulk: true }
      );
    }

    const stockOrgSet = new Set(dealers.map((d) => d.org_nr));
    const { map: nameToOrg, ambiguousCount } = buildNameToOrgMap(dealers);

    // ── Steg 2: sälj totalt + privat + företag (12 mån) ─────────────
    const salesFilterOrgs =
      smokeOrgNrs && smokeOrgNrs.length ? [...new Set(smokeOrgNrs)] : null;

    const [totalReport, privatReport, foretagReport] = await Promise.all([
      fetchReportAllRows(
        buildSalesByPreviousOwnerRequest(salesFilterOrgs, null),
        BILSTATISTIK_USERNAME,
        BILSTATISTIK_PASSWORD
      ),
      fetchReportAllRows(
        buildSalesByPreviousOwnerRequest(salesFilterOrgs, OWNER_CLASS_PRIVAT),
        BILSTATISTIK_USERNAME,
        BILSTATISTIK_PASSWORD
      ),
      fetchReportAllRows(
        buildSalesByPreviousOwnerRequest(salesFilterOrgs, OWNER_CLASS_FORETAG),
        BILSTATISTIK_USERNAME,
        BILSTATISTIK_PASSWORD
      ),
    ]);

    const totalParsed = parseSalesRows(totalReport);
    const privatParsed = parseSalesRows(privatReport);
    const foretagParsed = parseSalesRows(foretagReport);

    const totalJoin = joinSalesToOrgs(totalParsed, {
      nameToOrg,
      stockOrgSet,
      minAntal: MIN_SALES_VOLUME,
    });
    const privatJoin = joinSalesToOrgs(privatParsed, {
      nameToOrg,
      stockOrgSet,
      minAntal: 0,
    });
    const foretagJoin = joinSalesToOrgs(foretagParsed, {
      nameToOrg,
      stockOrgSet,
      minAntal: 0,
    });

    /** @type {Map<string, {org_nr: string, saljvolym_12m?: number, salj_privat_12m: number, salj_foretag_12m: number}>} */
    const salesByOrg = new Map();
    function ensureSalesRow(orgNr) {
      if (!salesByOrg.has(orgNr)) {
        salesByOrg.set(orgNr, {
          org_nr: orgNr,
          salj_privat_12m: 0,
          salj_foretag_12m: 0,
        });
      }
      return salesByOrg.get(orgNr);
    }

    for (const r of totalJoin.joined) {
      if (salesFilterOrgs && !salesFilterOrgs.includes(r.org_nr)) continue;
      ensureSalesRow(r.org_nr).saljvolym_12m = r.antal;
    }
    for (const r of privatJoin.joined) {
      if (salesFilterOrgs && !salesFilterOrgs.includes(r.org_nr)) continue;
      ensureSalesRow(r.org_nr).salj_privat_12m = r.antal;
    }
    for (const r of foretagJoin.joined) {
      if (salesFilterOrgs && !salesFilterOrgs.includes(r.org_nr)) continue;
      ensureSalesRow(r.org_nr).salj_foretag_12m = r.antal;
    }

    // Om total saknas men split finns: sätt saljvolym = privat + företag (om >= min)
    for (const row of salesByOrg.values()) {
      if (row.saljvolym_12m != null) continue;
      const sum = (row.salj_privat_12m || 0) + (row.salj_foretag_12m || 0);
      if (sum >= MIN_SALES_VOLUME) row.saljvolym_12m = sum;
    }

    // Ensure every row has identical keys (PostgREST PGRST102 otherwise).
    const salesUpsert = [...salesByOrg.values()]
      .map((r) => {
        const privat = r.salj_privat_12m || 0;
        const foretag = r.salj_foretag_12m || 0;
        const volym =
          r.saljvolym_12m != null ? r.saljvolym_12m : privat + foretag || null;
        return {
          org_nr: r.org_nr,
          saljvolym_12m: volym,
          salj_privat_12m: privat,
          salj_foretag_12m: foretag,
        };
      })
      .filter(
        (r) =>
          r.saljvolym_12m != null ||
          r.salj_privat_12m > 0 ||
          r.salj_foretag_12m > 0
      );

    for (let i = 0; i < salesUpsert.length; i += UPSERT_BATCH) {
      await upsertBatch(
        SUPABASE_URL,
        serviceKey,
        salesUpsert.slice(i, i + UPSERT_BATCH),
        now,
        { touchBulk: false }
      );
    }

    const withSplit = salesUpsert.filter(
      (r) => (r.salj_privat_12m || 0) + (r.salj_foretag_12m || 0) > 0
    ).length;

    return json(200, {
      ok: true,
      stock_imported: dealers.length,
      sales_raw: totalParsed.length,
      sales_updated: totalJoin.joined.length,
      sales_split_updated: withSplit,
      sales_privat_raw: privatParsed.length,
      sales_foretag_raw: foretagParsed.length,
      sales_unmatched: totalJoin.unmatched,
      sales_ambiguous_names: ambiguousCount,
      sales_match: "company_name",
      sales_min_volume: MIN_SALES_VOLUME,
      smoke: !!(salesFilterOrgs && salesFilterOrgs.length),
      smoke_org_nrs: salesFilterOrgs,
      sample_sales: totalJoin.joined.slice(0, 5).map((r) => {
        const split = salesByOrg.get(r.org_nr);
        return {
          org_nr: r.org_nr,
          company_name: r.company_name,
          saljvolym_12m: r.antal,
          salj_privat_12m: split?.salj_privat_12m ?? null,
          salj_foretag_12m: split?.salj_foretag_12m ?? null,
        };
      }),
      imported: dealers.length,
      total_row_count:
        Number(pick(stockReport, "TotalRowCount", "totalRowCount")) || dealers.length,
      updated_at: now,
    });
  } catch (err) {
    console.error("bilstatistik-market-bulk error:", err);
    return json(502, { error: err.message || "Kunde inte hämta marknadsdata" });
  }
}
