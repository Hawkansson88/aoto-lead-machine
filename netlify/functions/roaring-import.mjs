/**
 * Antons CRM — Roaring-import (upptäckt)
 * Netlify Function (ESM)
 *
 * Hämtar bilhandlare (SNI 45111/45112/45191/45192) från Roaring Company Search
 * och skriver in minimala rader i Supabase leads-tabellen.
 *
 * Anrikning (org.nr, SNI, anställda, omsättning, soliditet) görs separat
 * av roaring-enrich.mjs i batchar — denna funktion gör BARA upptäckt.
 *
 * Miljövariabler (sätts i Netlify dashboard → Environment variables):
 *   ROARING_CLIENT_ID, ROARING_CLIENT_SECRET
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
 */

const SNI_CODES = ["47811"];
const PAGE_SIZE = 100;
const ROARING_TOKEN_URL = "https://api.roaring.io/token";
const ROARING_SEARCH_URL = "https://api.roaring.io/se/company/search/2.0/search";

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

async function searchCompanies(token) {
  const allHits = [];

for (const sni of SNI_CODES) {
    let from = 0;
    let requestKey = null;

    while (true) {
      const params = new URLSearchParams();
      // TEMP: SNI-filter avstängt för att testa nya GUI:t mot sandbox-data
      // TODO: kommentera in igen när produktionscredentials är på plats
      params.append("industryCode", sni);
      params.append("statusCode", "100");      // Aktivt bolag
      params.append("legalGroupCode", "AB");    // Aktiebolag
      params.append("pageSize", String(PAGE_SIZE));
      params.append("from", String(from));
      if (requestKey) params.append("requestKey", requestKey);

      const res = await fetch(`${ROARING_SEARCH_URL}?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        console.error(`Roaring search error (SNI ${sni}): ${res.status}`);
        break;
      }

      const data = await res.json();
      const hits = data.hits || [];
      allHits.push(...hits);
      requestKey = data.requestKey || null;

      if (hits.length < PAGE_SIZE || allHits.length >= 50) break;
      from += PAGE_SIZE;
    }
  }

  return allHits;
}

/* ─── Supabase skrivning ─── */

async function upsertLeads(leads, sbUrl, serviceKey) {
  // Hämta existerande roaring_company_id så vi inte skriver dubbletter
  const existRes = await fetch(
    `${sbUrl}/rest/v1/leads?select=roaring_company_id`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
  );
  const existing = new Set((await existRes.json()).map((r) => r.roaring_company_id));

  const newLeads = leads.filter((l) => !existing.has(l.roaring_company_id));
  if (newLeads.length === 0) return { inserted: 0, skipped: leads.length };

  // Batchinsert nya leads (POST med service_role)
  const res = await fetch(`${sbUrl}/rest/v1/leads`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(newLeads),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase insert error: ${res.status} — ${err}`);
  }

  return { inserted: newLeads.length, skipped: leads.length - newLeads.length };
}

/* ─── Handler ─── */

export async function handler(event) {
  // Bara POST
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

  // Kolla env
  if (!ROARING_CLIENT_ID || !SUPABASE_URL) {
    return { statusCode: 500, body: "Missing environment variables" };
  }

  // Verifiera inloggad användare
  const jwt = (event.headers.authorization || "").replace("Bearer ", "");
  if (!jwt) return { statusCode: 401, body: "No token" };

  const user = await verifyUser(jwt, SUPABASE_URL, SUPABASE_ANON_KEY);
  if (!user) return { statusCode: 401, body: "Invalid session" };

  try {
    // 1. Roaring-token
    const roaringToken = await getRoaringToken(ROARING_CLIENT_ID, ROARING_CLIENT_SECRET);

    // 2. Sök bilhandlare
    const hits = await searchCompanies(roaringToken);

    // 3. Mappa + deduplika (samma companyId kan dyka upp under flera SNI)
    const seen = new Set();
    const leads = [];
    for (const hit of hits) {
      if (!hit.companyId || seen.has(hit.companyId)) continue;
      seen.add(hit.companyId);
      leads.push(mapToLead(hit));
    }

    // 4. Skriv till Supabase
    const result = await upsertLeads(leads, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: true,
        found: leads.length,
        ...result,
        message: `Hittade ${leads.length} bolag, importerade ${result.inserted} nya (${result.skipped} fanns redan). Anrikning sker separat.`,
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