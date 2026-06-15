/**
 * AOTO Lead Machine — Roaring-enrich
 * Netlify Function (ESM)
 *
 * Tar en batch leads där enriched_at är null, hämtar org.nr/SNI/anställda
 * via Company Information (Overview) och omsättning/soliditet via
 * Financial Information, och uppdaterar raderna i Supabase.
 *
 * Miljövariabler: samma som roaring-import.mjs
 */

const BATCH_SIZE = 20;
const ROARING_TOKEN_URL = "https://api.roaring.io/token";

/* ─── Hjälpare ─── */

/** Formatera org.nr med bindestreck: 5565926911 → 556592-6911 */
function fmtOrg(id) {
  const s = (id || "").replace(/\D/g, "");
  return s.length >= 10 ? s.slice(0, 6) + "-" + s.slice(6) : s;
}

/** Konvertera "10-19 anställda" → 15 (medelvärde) */
function parseEmployees(interval) {
  if (!interval) return null;
  const range = interval.match(/(\d+)\s*-\s*(\d+)/);
  if (range) return Math.round((+range[1] + +range[2]) / 2);
  const single = interval.match(/(\d+)/);
  return single ? +single[1] : null;
}

/** Hämta riktigt org.nr, SNI-kod och antal anställda via Overview-API */
async function enrichHit(roaringCompanyId, token) {
  try {
    const res = await fetch(
      `https://api.roaring.io/se/company/overview/2.0/${roaringCompanyId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return {};
    const data = await res.json();
    const record = data.records?.[0];
    if (!record) return {};
    return {
      org_nr: fmtOrg(record.companyId),
      sni_code: record.industryCode || null,
      employees: parseEmployees(record.numberEmployeesInterval),
    };
  } catch {
    return {};
  }
}

/** Hämta omsättning och soliditet via Financial Information API */
async function enrichFinancials(orgNr, token) {
  try {
    const id = (orgNr || "").replace(/\D/g, "");
    if (!id) return {};
    const res = await fetch(
      `https://api.roaring.io/se/company/economy-overview/2.1/extended/${id}?years=1`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return {};
    const data = await res.json();
    const record = data.records?.[0];
    if (!record) return {};
    return {
      revenue:  record.plSales != null ? Math.round(record.plSales * 1000) : null,
      solidity: record.kpiEquityRatioPercent != null ? Math.round(record.kpiEquityRatioPercent) : null,
    };
  } catch {
    return {};
  }
}

/* ─── Auth ─── */

async function verifyUser(token, sbUrl, anonKey) {
  const res = await fetch(`${sbUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
  });
  if (!res.ok) return null;
  return res.json();
}

async function getRoaringToken(clientId, clientSecret) {
  const basic = btoa(`${clientId}:${clientSecret}`);
  const res = await fetch(ROARING_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Roaring token error: ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

/* ─── Supabase ─── */

/** Hämta nästa batch leads som inte är anrikade än */
async function fetchBatch(sbUrl, serviceKey) {
  const res = await fetch(
    `${sbUrl}/rest/v1/leads?enriched_at=is.null&select=roaring_company_id&limit=${BATCH_SIZE}`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
  );
  if (!res.ok) throw new Error(`Supabase select error: ${res.status}`);
  return res.json();
}

/** Räkna hur många som återstår att anrika */
async function countRemaining(sbUrl, serviceKey) {
  const res = await fetch(
    `${sbUrl}/rest/v1/leads?enriched_at=is.null&select=roaring_company_id`,
    {
      method: "HEAD",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Prefer: "count=exact",
      },
    }
  );
  const range = res.headers.get("content-range"); // "*/N"
  return range ? parseInt(range.split("/")[1], 10) : null;
}

/** Uppdatera en rad via dess roaring_company_id */
async function updateLead(roaringCompanyId, fields, sbUrl, serviceKey) {
  const res = await fetch(
    `${sbUrl}/rest/v1/leads?roaring_company_id=eq.${encodeURIComponent(roaringCompanyId)}`,
    {
      method: "PATCH",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(fields),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase update error: ${res.status} — ${err}`);
  }
}

/* ─── Handler ─── */

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const {
    ROARING_CLIENT_ID,
    ROARING_CLIENT_SECRET,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_ANON_KEY,
  } = process.env;

  if (!ROARING_CLIENT_ID || !SUPABASE_URL) {
    return { statusCode: 500, body: "Missing environment variables" };
  }

  const jwt = (event.headers.authorization || "").replace("Bearer ", "");
  if (!jwt) return { statusCode: 401, body: "No token" };

  const user = await verifyUser(jwt, SUPABASE_URL, SUPABASE_ANON_KEY);
  if (!user) return { statusCode: 401, body: "Invalid session" };

  try {
    const roaringToken = await getRoaringToken(ROARING_CLIENT_ID, ROARING_CLIENT_SECRET);
    const batch = await fetchBatch(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    let overviewCalls = 0;
    let financialCalls = 0;

    for (const lead of batch) {
      const ov = await enrichHit(lead.roaring_company_id, roaringToken);
      overviewCalls++;

      let fin = {};
      if (ov.org_nr) {
        fin = await enrichFinancials(ov.org_nr, roaringToken);
        financialCalls++;
      }

      await updateLead(lead.roaring_company_id, {
        org_nr:      ov.org_nr ?? null,
        sni_code:    ov.sni_code ?? null,
        employees:   ov.employees ?? null,
        revenue:     fin.revenue ?? null,
        solidity:    fin.solidity ?? null,
        enriched_at: new Date().toISOString(),
      }, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    }

    const remaining = await countRemaining(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: true,
        enriched: batch.length,
        remaining,
        roaringCalls: { overview: overviewCalls, financial: financialCalls },
        message: `Anrikade ${batch.length} bolag (${overviewCalls + financialCalls} Roaring-anrop). ${remaining ?? "?"} kvar.`,
      }),
    };
  } catch (err) {
    console.error("Enrich error:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: false, error: err.message }),
    };
  }
}