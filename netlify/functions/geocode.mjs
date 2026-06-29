/**
 * AOTO Lead Machine — Geocoding
 * Netlify Function (ESM)
 *
 * Hämtar leads utan lat/lng från Supabase, slår upp adress mot
 * Nominatim (OpenStreetMap) och sparar koordinaterna tillbaka.
 * Stödjer även enstaka adressuppslag via POST body.
 *
 * Max 1 anrop/sekund mot Nominatim (deras krav).
 * Kör max 50 bolag per anrop för att undvika timeout.
 */

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const BATCH_SIZE = 50;
const DELAY_MS = 1100; // lite över 1 sek för säkerhets skull

/* ─── Hjälpare ─── */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Slå upp adress mot Nominatim, returnera { lat, lng } eller null */
async function geocodeQuery(query) {
  if (!query?.trim()) return null;
  const params = new URLSearchParams({
    q: query.trim(),
    countrycodes: "se",
    format: "json",
    limit: "1",
  });
  const res = await fetch(`${NOMINATIM_URL}?${params}`, {
    headers: {
      "User-Agent": "AOTO-Lead-Machine/1.0 (lagerfinansiering)",
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || data.length === 0) return null;
  return {
    lat: parseFloat(data[0].lat),
    lng: parseFloat(data[0].lon),
  };
}

function buildLeadQuery(lead) {
  const parts = [lead.address, lead.postal_address, lead.city].filter((s) => s?.trim());
  if (parts.length) return parts.join(", ") + ", Sverige";
  return null;
}

/* ─── Auth ─── */

async function verifyUser(token, sbUrl, anonKey) {
  const res = await fetch(`${sbUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
  });
  if (!res.ok) return null;
  return res.json();
}

/* ─── Handler ─── */

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_ANON_KEY,
  } = process.env;

  if (!SUPABASE_URL) {
    return { statusCode: 500, body: "Missing environment variables" };
  }

  const jwt = (event.headers.authorization || "").replace("Bearer ", "");
  if (!jwt) return { statusCode: 401, body: "No token" };

  const user = await verifyUser(jwt, SUPABASE_URL, SUPABASE_ANON_KEY);
  if (!user) return { statusCode: 401, body: "Invalid session" };

  try {
    // Enstaka adressuppslag (t.ex. vid manuell kundskapande)
    if (event.body) {
      const body = JSON.parse(event.body);
      const query =
        body.query?.trim() ||
        [body.address, body.postal_address, body.city, "Sverige"].filter((s) => s?.trim()).join(", ");

      if (!query) {
        return {
          statusCode: 400,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ success: false, error: "Ingen adress angiven" }),
        };
      }

      const coords = await geocodeQuery(query);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          success: !!coords,
          lat: coords?.lat ?? null,
          lng: coords?.lng ?? null,
        }),
      };
    }

    // Batch: hämta leads utan koordinater som har adress eller stad
    const fetchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/leads?select=id,city,address,postal_address&lat=is.null&or=(city.not.is.null,postal_address.not.is.null,address.not.is.null)&limit=${BATCH_SIZE}`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    const leads = await fetchRes.json();

    if (!leads || leads.length === 0) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ success: true, updated: 0, message: "Alla bolag har redan koordinater." }),
      };
    }

    // Geocoda unika adresser (undvik dubbla anrop)
    const queryCache = {};
    let updated = 0;
    let failed = 0;

    for (const lead of leads) {
      const query = buildLeadQuery(lead);
      if (!query) continue;

      if (!(query in queryCache)) {
        queryCache[query] = await geocodeQuery(query);
        await sleep(DELAY_MS);
      }

      const coords = queryCache[query];
      if (!coords) { failed++; continue; }

      // Uppdatera lead med koordinater
      const patchRes = await fetch(
        `${SUPABASE_URL}/rest/v1/leads?id=eq.${lead.id}`,
        {
          method: "PATCH",
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({ lat: coords.lat, lng: coords.lng }),
        }
      );

      if (patchRes.ok) updated++;
      else failed++;
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: true,
        updated,
        failed,
        message: `Geocodade ${updated} bolag (${failed} misslyckades). ${leads.length < BATCH_SIZE ? "Alla klara!" : "Kör igen för fler."}`,
      }),
    };
  } catch (err) {
    console.error("Geocode error:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: false, error: err.message }),
    };
  }
}
