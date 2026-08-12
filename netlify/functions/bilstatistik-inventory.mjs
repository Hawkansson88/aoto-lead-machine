/**
 * AOTO CRM — Bilstatistik: bestånd + säljvolym 12 mån per org.nr
 *
 * POST body: { org_nr, company_name? }
 * Env: BILSTATISTIK_USERNAME, BILSTATISTIK_PASSWORD,
 *      SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (eller SERVICE_ROLE_KEY)
 */

const BILSTATISTIK_API_URL =
  process.env.BILSTATISTIK_API_URL || "https://report-integration.bilstatistik.se";

/** 1 = personbil, 3 = lätt lastbil */
const VEHICLE_TYPES = [1, 3];

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

async function verifyUser(token, sbUrl, anonKey) {
  const res = await fetch(`${sbUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
  });
  if (!res.ok) return null;
  return res.json();
}

function basicAuthHeader(user, pass) {
  return "Basic " + Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
}

/** Operativt lager per fordon — brukare (User) inkl. lagerfinansierade. */
function buildInventoryRequest(orgNr) {
  return {
    ReportProfile: {
      ReportTypeId: -4,
      Filter: {
        VehicleTypes: { Values: VEHICLE_TYPES },
        User: {
          CompanyIdentifiers: { Values: [orgNr] },
          RegistrantClassification: { Values: [1] },
        },
      },
      PopulationDataset: { DateOptionId: 1 },
    },
    SortColumnName: "Date",
    SortAscending: false,
    AreaSetId: 18905,
    OutputColumns: [87, 88, 156, 1, 108, 37, 4],
  };
}

/** Sälj per fordon 12 mån — PreviousOwner (för S&L-rensning i kod). */
function buildSalesRequest(orgNr) {
  return {
    ReportProfile: {
      ReportTypeId: -4,
      Filter: {
        VehicleTypes: { Values: VEHICLE_TYPES },
        PreviousOwner: {
          CompanyIdentifiers: { Values: [orgNr] },
          RegistrantClassification: { Values: [1] },
        },
      },
      TransactionDataset: {
        DateRange: {},
        DateRangeOptionId: 5,
        TransactionTypeGroupId: 3,
      },
    },
    SortColumnName: "Date",
    SortAscending: false,
    AreaSetId: 18905,
    OutputColumns: [87, 88, 156, 1, 108, 37, 4],
  };
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

const MAX_REPORT_PAGE = 1000;

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

async function fetchReport(requestBody, user, pass, count = 500) {
  // API: count måste vara 1–1000
  const capped = Math.min(Math.max(Number(count) || 500, 1), MAX_REPORT_PAGE);
  const url = `${BILSTATISTIK_API_URL}/reports?count=${encodeURIComponent(capped)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(user, pass),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(requestBody),
  });
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

function normParty(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\baktiebolag\b/g, "ab")
    .replace(/[^a-z0-9åäö]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sameParty(a, b) {
  const na = normParty(a);
  const nb = normParty(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

function isDealerParty(name, companyName) {
  if (!companyName) return false;
  return sameParty(name, companyName);
}

function isPrivateParty(name) {
  return normParty(name) === "privat";
}

/**
 * Strikt retail: ny ägare ≠ dealer OCH ny brukare ≠ dealer.
 * Exkluderar S&L (brukare=dealer, ägare=finans) och "övrigt" (ägare kvar=dealer).
 * Retail delas i privat vs företag (allt icke-privat).
 */
function parseRetailSales(data, companyName) {
  const colIndex = columnIndex(data);
  const rows = pick(data, "Rows", "rows") || [];
  const ownerIdx = colIndex.PrimaryOwnerDisplayName;
  const userIdx = colIndex.PrimaryUserDisplayName;
  const prevIdx = colIndex.PreviousPrimaryUserDisplayName;
  const totalReported = Number(pick(data, "TotalRowCount", "totalRowCount"));

  let retail = 0;
  let retailPrivat = 0;
  let retailForetag = 0;
  let saleLeaseback = 0;
  let nonSale = 0;
  let parsed = 0;

  for (const row of rows) {
    const rowType = pick(row, "RowType", "rowType");
    if (rowType === 1) continue;
    const cells = pick(row, "Cells", "cells") || [];
    if (ownerIdx == null || userIdx == null) continue;

    const owner = cells[ownerIdx];
    const user = cells[userIdx];
    const prevUser = prevIdx != null ? cells[prevIdx] : null;
    parsed += 1;

    let ownerDealer = isDealerParty(owner, companyName);
    let userDealer = isDealerParty(user, companyName);

    // Fallback om company_name saknas/matchar dåligt: använd föregående brukare + mönster
    if (!companyName) {
      userDealer = sameParty(user, prevUser);
      ownerDealer = sameParty(owner, prevUser) || (sameParty(owner, user) && userDealer);
    }

    if (!ownerDealer && !userDealer) {
      retail += 1;
      if (isPrivateParty(owner)) retailPrivat += 1;
      else retailForetag += 1;
    } else if (!ownerDealer && userDealer) {
      saleLeaseback += 1;
    } else {
      // ägare kvar = dealer (brukarbyte/utlåning/återtag m.m.)
      nonSale += 1;
    }
  }

  const total = Number.isFinite(totalReported) && totalReported > 0 ? totalReported : parsed;
  const truncated = parsed < total;

  return {
    total,
    parsed,
    sale_leaseback: saleLeaseback,
    non_sale: nonSale,
    saljvolym_12m: retail,
    salj_privat_12m: retailPrivat,
    salj_foretag_12m: retailForetag,
    truncated,
  };
}

/**
 * Fordonsnivå-lager: lagerantal + märken + lagerfinansiering per finansbolag.
 * Finansierat = ägare ≠ dealer (brukare = dealer via rapportfilter).
 */
function parseStockResponse(data, companyName) {
  const colIndex = columnIndex(data);
  const rows = pick(data, "Rows", "rows") || [];
  const ownerIdx = colIndex.PrimaryOwnerDisplayName;
  const makeIdx = colIndex.MakeName;
  const regIdx = colIndex.RegistrationNumber;
  const totalReported = Number(pick(data, "TotalRowCount", "totalRowCount"));

  const makeCounts = new Map();
  const financeCounts = new Map();
  const seenRegs = new Set();
  let financed = 0;
  let parsed = 0;

  for (const row of rows) {
    const rowType = pick(row, "RowType", "rowType");
    if (rowType === 1) continue;
    const cells = pick(row, "Cells", "cells") || [];
    const reg =
      regIdx != null && cells[regIdx] != null
        ? String(cells[regIdx]).toUpperCase().replace(/\s+/g, "")
        : null;
    if (reg) {
      if (seenRegs.has(reg)) continue;
      seenRegs.add(reg);
    }
    parsed += 1;

    const make = makeIdx != null ? cells[makeIdx] : null;
    if (make && typeof make === "string") {
      makeCounts.set(make, (makeCounts.get(make) || 0) + 1);
    }

    const owner = ownerIdx != null ? cells[ownerIdx] : null;
    const ownerDealer = companyName
      ? isDealerParty(owner, companyName)
      : false;
    // Utan company_name: behandla saknad/privat som icke-finans; övriga bolagsägare = finanskandidat
    const isFinanced = companyName
      ? !ownerDealer
      : owner && !isPrivateParty(owner);

    if (isFinanced) {
      financed += 1;
      const name = String(owner || "Okänt").trim() || "Okänt";
      financeCounts.set(name, (financeCounts.get(name) || 0) + 1);
    }
  }

  const lagerantal =
    Number.isFinite(totalReported) && totalReported > 0
      ? totalReported
      : seenRegs.size || parsed;

  const brands = [...makeCounts.entries()]
    .map(([make_name, count]) => ({
      make_name,
      count,
      share: lagerantal > 0 ? count / lagerantal : null,
    }))
    .sort((a, b) => a.count - b.count || a.make_name.localeCompare(b.make_name, "sv"));

  const lager_finansbolag = [...financeCounts.entries()]
    .map(([name, count]) => ({
      name,
      count,
      share: lagerantal > 0 ? count / lagerantal : null,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "sv"));

  return {
    lagerantal,
    brands,
    lager_finansierat_antal: financed,
    lager_finansierat_andel: lagerantal > 0 ? financed / lagerantal : 0,
    lager_finansbolag,
    truncated: parsed < lagerantal,
  };
}

async function upsertMarketStats(sbUrl, serviceKey, row) {
  const res = await fetch(`${sbUrl}/rest/v1/dealer_market_stats?on_conflict=org_nr`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase stats: ${err.slice(0, 300)}`);
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

async function replaceBrands(sbUrl, serviceKey, orgNr, brands) {
  const del = await fetch(
    `${sbUrl}/rest/v1/dealer_vehicle_brands?org_nr=eq.${encodeURIComponent(orgNr)}`,
    {
      method: "DELETE",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
    }
  );
  if (!del.ok) {
    const err = await del.text();
    throw new Error(`Supabase brands delete: ${err.slice(0, 300)}`);
  }

  if (!brands.length) return [];

  const now = new Date().toISOString();
  const payload = brands.map((b) => ({
    org_nr: orgNr,
    make_name: b.make_name,
    count: b.count,
    share: b.share,
    updated_at: now,
  }));

  const ins = await fetch(`${sbUrl}/rest/v1/dealer_vehicle_brands`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(payload),
  });
  if (!ins.ok) {
    const err = await ins.text();
    throw new Error(`Supabase brands insert: ${err.slice(0, 300)}`);
  }
  return ins.json();
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

  // URL + anon finns redan publikt i frontend (js/config.js) — fallback för lokal netlify dev
  const SUPABASE_URL =
    envUrl || "https://plydduphthqhpmwasznr.supabase.co";
  const anonKey =
    SUPABASE_ANON_KEY ||
    SUPABASE_ANON ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBseWRkdXBodGhxaHBtd2Fzem5yIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1MTcxNjksImV4cCI6MjA5NjA5MzE2OX0.fdxR8DXxFjsT0f7fL0LamsNTj6WdFx5R_rFdi67SNWo";
  const serviceKey = SUPABASE_SERVICE_ROLE_KEY || SERVICE_ROLE_KEY;

  if (!BILSTATISTIK_USERNAME || !BILSTATISTIK_PASSWORD) {
    return json(500, { error: "Saknar BILSTATISTIK_USERNAME/PASSWORD i .env" });
  }
  if (!serviceKey) {
    return json(500, {
      error:
        "Saknar SUPABASE_SERVICE_ROLE_KEY (eller SERVICE_ROLE_KEY). Lägg till den i .env och starta om netlify dev.",
    });
  }

  const jwt = (event.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json(401, { error: "Ingen session" });

  const user = await verifyUser(jwt, SUPABASE_URL, anonKey);
  if (!user) return json(401, { error: "Ogiltig session" });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Ogiltig JSON" });
  }

  const orgNr = digitsOrg(body.org_nr);
  if (!orgNr) return json(400, { error: "Ogiltigt organisationsnummer" });

  const companyName = String(body.company_name || "").trim() || null;

  try {
    const [stockReport, salesReport] = await Promise.all([
      fetchReportAllRows(buildInventoryRequest(orgNr), BILSTATISTIK_USERNAME, BILSTATISTIK_PASSWORD),
      fetchReportAllRows(buildSalesRequest(orgNr), BILSTATISTIK_USERNAME, BILSTATISTIK_PASSWORD),
    ]);

    const stock = parseStockResponse(stockReport, companyName);
    const sales = parseRetailSales(salesReport, companyName);
    if (stock.truncated) {
      console.warn(
        `bilstatistik stock truncated for ${orgNr}: parsed rows incomplete vs TotalRowCount`
      );
    }
    if (sales.truncated) {
      console.warn(
        `bilstatistik sales truncated for ${orgNr}: parsed=${sales.parsed} total=${sales.total}`
      );
    }

    const {
      lagerantal,
      brands,
      lager_finansierat_antal,
      lager_finansierat_andel,
      lager_finansbolag,
    } = stock;
    const saljvolym_12m = sales.saljvolym_12m;
    const salj_privat_12m = sales.salj_privat_12m;
    const salj_foretag_12m = sales.salj_foretag_12m;

    const now = new Date().toISOString();

    const stats = await upsertMarketStats(SUPABASE_URL, serviceKey, {
      org_nr: orgNr,
      company_name: companyName,
      lagerantal,
      saljvolym_12m,
      salj_privat_12m,
      salj_foretag_12m,
      lager_finansierat_antal,
      lager_finansierat_andel,
      lager_finansbolag,
      updated_at: now,
    });

    await replaceBrands(SUPABASE_URL, serviceKey, orgNr, brands);

    return json(200, {
      ok: true,
      org_nr: orgNr,
      lagerantal,
      saljvolym_12m,
      salj_privat_12m,
      salj_foretag_12m,
      lager_finansierat_antal,
      lager_finansierat_andel,
      lager_finansbolag,
      sale_leaseback: sales.sale_leaseback,
      sales_non_sale: sales.non_sale,
      sales_total: sales.total,
      sales_truncated: sales.truncated,
      stock_truncated: stock.truncated,
      brand_count: brands.length,
      updated_at: stats?.updated_at || now,
      brands,
    });
  } catch (err) {
    console.error("bilstatistik-inventory error:", err);
    return json(502, { error: err.message || "Kunde inte hämta Bilstatistik" });
  }
}
