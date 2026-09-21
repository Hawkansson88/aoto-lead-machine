/**
 * AOTO Prospekt — geokodning av återförsäljaradresser.
 *
 * Slår upp adresserna i dealer_market_stats mot Nominatim och sparar lat/lng,
 * så att prospekten kan ritas ut på kartan.
 *
 *   node scripts/prospect-geocode.mjs
 *   node scripts/prospect-geocode.mjs --limit 50
 *   node scripts/prospect-geocode.mjs --all
 *
 * Flaggor:
 *   --limit <n>   Sluta efter n uppslag (default: alla som saknas)
 *   --all         Ta med alla i dealer_market_stats, inte bara prospekten
 *   --retry       Försök igen på adresser som tidigare misslyckades
 *
 * Nominatim tillåter max ett anrop per sekund, så ~700 adresser tar en
 * kvart. Skriptet är avbrytbart: redan geokodade rader hoppas över, så det
 * går att köra igen och fortsätta där det slutade.
 *
 * geocoded_at sätts även när uppslaget misslyckas. Då vet nästa körning att
 * adressen redan är prövad och slösar inte en sekund på den igen.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const DELAY_MS = 1100;
const USER_AGENT = "AOTO-Prospekt/1.0 (prospektlista bilhandlare)";

function loadEnv() {
  const env = {};
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}

const argv = process.argv.slice(2);
const limit = argv.includes("--limit") ? Number(argv[argv.indexOf("--limit") + 1]) : Infinity;
const onlyProspects = !argv.includes("--all");
const retryFailed = argv.includes("--retry");

const env = loadEnv();
const base = env.SUPABASE_URL || "https://plydduphthqhpmwasznr.supabase.co";
const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SERVICE_ROLE_KEY;
if (!key) {
  console.error("Saknar SUPABASE_SERVICE_ROLE_KEY i .env");
  process.exit(1);
}
const H = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  const res = await fetch(`${base}/rest/v1/${path}`, { headers: H });
  if (!res.ok) throw new Error(`Supabase: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Läser en hel tabell — PostgREST tar max 1000 rader per anrop. */
async function getAll(path) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await get(`${path}&offset=${offset}&limit=1000`);
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

async function geocode(query) {
  const params = new URLSearchParams({
    q: query,
    countrycodes: "se",
    format: "json",
    limit: "1",
  });
  const res = await fetch(`${NOMINATIM_URL}?${params}`, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data?.length) return null;
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
}

/**
 * Gatuadress först, ort som reserv. En träff på orten är inte exakt, men för
 * "vilka ligger på vägen till Östersund" räcker det gott — och det är bättre
 * än att bolaget saknas på kartan helt.
 */
function queriesFor(row) {
  const out = [];
  const street = [row.address, row.postcode, row.city].filter((s) => s?.trim()).join(", ");
  if (row.address?.trim() && street) out.push(street + ", Sverige");
  if (row.city?.trim()) out.push(row.city.trim() + ", Sverige");
  return out;
}

// ── Vilka rader ska slås upp? ────────────────────────────────────────────

let wanted = null;
if (onlyProspects) {
  const dealers = await getAll("prospect_dealers?select=org_nr");
  wanted = new Set(dealers.map((d) => d.org_nr));
  console.log(`Prospekt i listan: ${wanted.size}`);
}

const filter = retryFailed ? "lat=is.null" : "lat=is.null&geocoded_at=is.null";
const candidates = (
  await getAll(`dealer_market_stats?select=org_nr,company_name,address,postcode,city&${filter}`)
).filter((r) => (wanted ? wanted.has(r.org_nr) : true)).filter((r) => queriesFor(r).length > 0);

const todo = candidates.slice(0, Number.isFinite(limit) ? limit : undefined);

console.log(`Att geokoda: ${todo.length}${todo.length < candidates.length ? ` (av ${candidates.length})` : ""}`);
if (!todo.length) {
  console.log("Inget att göra — allt med adress är redan uppslaget.");
  process.exit(0);
}
console.log(`Beräknad tid: ~${Math.ceil((todo.length * DELAY_MS) / 60000)} min\n`);

let ok = 0;
let viaCity = 0;
let failed = 0;

for (const [i, row] of todo.entries()) {
  const queries = queriesFor(row);
  let coords = null;
  let usedFallback = false;

  for (const [qi, q] of queries.entries()) {
    coords = await geocode(q);
    if (coords) {
      usedFallback = qi > 0;
      break;
    }
    await sleep(DELAY_MS);
  }

  const patch = {
    lat: coords?.lat ?? null,
    lng: coords?.lng ?? null,
    geocoded_at: new Date().toISOString(),
  };
  const res = await fetch(
    `${base}/rest/v1/dealer_market_stats?org_nr=eq.${encodeURIComponent(row.org_nr)}`,
    { method: "PATCH", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify(patch) }
  );

  if (!res.ok) {
    console.error(`  ${row.company_name}: skrivfel ${(await res.text()).slice(0, 120)}`);
    failed++;
  } else if (coords) {
    ok++;
    if (usedFallback) viaCity++;
  } else {
    failed++;
  }

  if ((i + 1) % 25 === 0 || i === todo.length - 1) {
    console.log(`${i + 1}/${todo.length} · träff ${ok} (varav ${viaCity} bara ort) · miss ${failed}`);
  }

  await sleep(DELAY_MS);
}

console.log(`\nKlart: ${ok} geokodade, ${viaCity} av dem bara på ort, ${failed} utan träff.`);
