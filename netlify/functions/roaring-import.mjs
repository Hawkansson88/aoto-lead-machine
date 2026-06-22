/**
 * Antons CRM — Roaring-import (upptäckt)
 * Netlify Function (ESM)
 *
 * Hämtar bilhandlare (SNI 45111/45112/45191/45192) från Roaring Company Search
 * och skriver in minimala rader i Supabase leads-tabellen.
 *
 * Varje körning paginerar vidare i Roaring tills 50 nya bolag hittats
 * (eller resultatlistan tar slut). Cursor sparas i app_state.
 *
 * Anrikning (org.nr, SNI, anställda, omsättning, soliditet) görs separat
 * av roaring-enrich.mjs i batchar — denna funktion gör BARA upptäckt.
 *
 * Miljövariabler (sätts i Netlify dashboard → Environment variables):
 *   ROARING_CLIENT_ID, ROARING_CLIENT_SECRET
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
 */

const SNI_CODES = ["47811"];
const IMPORT_TARGET = 50;
const PAGE_SIZE = 100;
const MAX_ROARING_PAGES = 40;
const CURSOR_KEY = "roaring_import";
const ROARING_TOKEN_URL = "https://api.roaring.io/token";
const ROARING_SEARCH_URL = "https://api.roaring.io/se/company/search/2.0/search";

const sbHeaders = (serviceKey, extra = {}) => ({
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  ...extra,
});

/* ─── Hjälpare ─── */

/** Mappa ett Roaring SearchHit till en minimal leads-rad (ingen anrikning) */
function mapToLead(hit) {
  return {
    org_nr:              null,           // fylls i av roaring-enrich.mjs
    roaring_company_id:  hit.companyId,
    company_name:        hit.companyName || "Okänt",
    city:                hit.town || hit.visitTown || null,
    sni_code:            null,           // fylls i av roaring-enrich.mjs
    brand:               null,
    revenue:             null,           // fylls i av roaring-enrich.mjs
    employees:           null,           // fylls i av roaring-enrich.mjs
    solidity:            null,           // fylls i av roaring-enrich.mjs
    score:               null,
    status:              "ny",
  };
}

/* ─── Auth ─── */

/** Verifiera att anroparen har en giltig Supabase-session */
async function verifyUser(token, sbUrl, anonKey) {
  const res = await fetch(`${sbUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
  });
  if (!res.ok) return null;
  return res.json();
}

/** Hämta Roaring Bearer-token (OAuth2 client credentials) */
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

/* ─── Roaring sökning ─── */

async function fetchSearchPage(token, sni, from, requestKey) {
  const params = new URLSearchParams();
  params.append("industryCode", sni);
  params.append("statusCode", "100");      // Aktivt bolag
  params.append("legalGroupCode", "AB");   // Aktiebolag
  params.append("pageSize", String(PAGE_SIZE));
  params.append("from", String(from));
  if (requestKey) params.append("requestKey", requestKey);

  const res = await fetch(`${ROARING_SEARCH_URL}?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`Roaring search error (SNI ${sni}): ${res.status}`);
  }

  const data = await res.json();
  return {
    hits: data.hits || [],
    requestKey: data.requestKey || requestKey || null,
  };
}

/**
 * Paginera i Roaring tills IMPORT_TARGET nya bolag hittats.
 * Hoppar över bolag som redan finns i Supabase.
 */
async function collectNewLeads(token, existingIds, cursor) {
  const newLeads = [];
  let skipped = 0;
  let scanned = 0;
  let pages = 0;
  const sessionSeen = new Set();
  const nextCursor = { ...cursor };

  for (const sni of SNI_CODES) {
    if (newLeads.length >= IMPORT_TARGET) break;

    const sniCursor = nextCursor[sni] || { from: 0, requestKey: null };
    if (sniCursor.exhausted) continue;

    let { from, requestKey } = sniCursor;
    let exhausted = false;

    while (newLeads.length < IMPORT_TARGET && !exhausted) {
      if (pages >= MAX_ROARING_PAGES) break;
      pages++;

      const { hits, requestKey: newRequestKey } = await fetchSearchPage(
        token, sni, from, requestKey
      );
      requestKey = newRequestKey;

      if (!hits.length) {
        exhausted = true;
        break;
      }

      const pageStart = from;
      let processed = 0;

      for (const hit of hits) {
        processed++;
        scanned++;

        if (!hit.companyId || sessionSeen.has(hit.companyId)) {
          skipped++;
          continue;
        }
        sessionSeen.add(hit.companyId);

        if (existingIds.has(hit.companyId)) {
          skipped++;
          continue;
        }

        newLeads.push(mapToLead(hit));
        existingIds.add(hit.companyId);

        if (newLeads.length >= IMPORT_TARGET) break;
      }

      from = pageStart + processed;

      if (hits.length < PAGE_SIZE) exhausted = true;
    }

    nextCursor[sni] = { from, requestKey, exhausted };
  }

  return { newLeads, skipped, scanned, pages, cursor: nextCursor };
}

/* ─── Supabase ─── */

async function getExistingIds(sbUrl, serviceKey) {
  const res = await fetch(
    `${sbUrl}/rest/v1/leads?select=roaring_company_id`,
    { headers: sbHeaders(serviceKey) }
  );
  if (!res.ok) throw new Error(`Supabase select error: ${res.status}`);
  const rows = await res.json();
  return new Set(rows.map((r) => r.roaring_company_id).filter(Boolean));
}

async function getImportCursor(sbUrl, serviceKey) {
  const res = await fetch(
    `${sbUrl}/rest/v1/app_state?key=eq.${CURSOR_KEY}&select=value`,
    { headers: sbHeaders(serviceKey) }
  );
  if (!res.ok) {
    console.warn("Could not read import cursor:", res.status);
    return {};
  }
  const rows = await res.json();
  return rows[0]?.value || {};
}

async function saveImportCursor(cursor, sbUrl, serviceKey) {
  const body = {
    key: CURSOR_KEY,
    value: cursor,
    updated_at: new Date().toISOString(),
  };

  const res = await fetch(`${sbUrl}/rest/v1/app_state`, {
    method: "POST",
    headers: sbHeaders(serviceKey, {
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    }),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.warn("Could not save import cursor:", res.status, await res.text());
  }
}

async function insertLeads(leads, sbUrl, serviceKey) {
  if (leads.length === 0) return;

  const res = await fetch(`${sbUrl}/rest/v1/leads`, {
    method: "POST",
    headers: sbHeaders(serviceKey, {
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    }),
    body: JSON.stringify(leads),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase insert error: ${res.status} — ${err}`);
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
    const existingIds = await getExistingIds(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const cursor = await getImportCursor(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { newLeads, skipped, scanned, pages, cursor: nextCursor } =
      await collectNewLeads(roaringToken, existingIds, cursor);

    if (newLeads.length > 0) {
      await insertLeads(newLeads, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    }

    await saveImportCursor(nextCursor, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const inserted = newLeads.length;
    let message;

    if (inserted === 0) {
      message = "Inga nya bolag hittades i Roaring (alla redan importerade eller listan är slut).";
    } else if (inserted < IMPORT_TARGET) {
      message = `Importerade ${inserted} nya bolag (färre än ${IMPORT_TARGET} — inga fler hittades). Anrikning sker separat.`;
    } else {
      message = `Importerade ${inserted} nya bolag (${skipped} hoppades över). Anrikning sker separat.`;
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: true,
        inserted,
        skipped,
        scanned,
        pages,
        target: IMPORT_TARGET,
        message,
      }),
    };
  } catch (err) {
    console.error("Import error:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: false, error: err.message }),
    };
  }
}
