/**
 * AOTO Prospekt — leasingandelens nämnare, ett anrop per handlare.
 *
 * Bilstatistiks kvot räknas i RADER, inte i antal frågor. Att hämta alla
 * företagsaffärer som fordonsrader hade kostat omkring 150 000 rader.
 *
 * Men svaret bär `TotalRowCount` oavsett hur få rader man ber om. Med
 * `count=1` och ett org.nr i filtret får vi bolagets hela antal affärer till
 * priset av en rad. 1 212 handlare kostar 1 212 rader — drygt hundra gånger
 * billigare, och exakt samma tal.
 *
 *   node scripts/prospect-b2b-counts.mjs --dry
 *   node scripts/prospect-b2b-counts.mjs --limit 150
 *   node scripts/prospect-b2b-counts.mjs
 *
 * Flaggor:
 *   --limit <n>       Ta bara de n största (efter leasingaffärer)
 *   --min-deals <n>   Hoppa över handlare under n leasingaffärer
 *   --period <namn>   ytd (default) eller forra-aret
 *   --dry             Visa vad som skulle hämtas och vad det kostar
 *
 * Täljaren räknas lokalt ur prospect_leasing_tx över exakt samma period, så
 * andelen jämför äpplen med äpplen. Blanda inte perioder: ett tal från ytd
 * går inte att dela med ett från föregående kalenderår.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildLeasingSalesRequest,
  fetchReport,
  DATE_RANGE_PREV_YEAR,
} from "../netlify/functions/prospect-sync.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DELAY_MS = 250;

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
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const PERIODS = {
  ytd: { id: 1, label: "år-till-datum" },
  "forra-aret": { id: DATE_RANGE_PREV_YEAR, label: "föregående kalenderår" },
};

const periodName = arg("period", "ytd");
const period = PERIODS[periodName];
const limit = Number(arg("limit", Infinity));
const minDeals = Number(arg("min-deals", 0));
const dry = argv.includes("--dry");

if (!period) {
  console.error("--period måste vara ytd eller forra-aret");
  process.exit(2);
}

const env = loadEnv();
const user = env.BILSTATISTIK_USERNAME;
const pass = env.BILSTATISTIK_PASSWORD;
const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SERVICE_ROLE_KEY;
const sbUrl = env.SUPABASE_URL || "https://plydduphthqhpmwasznr.supabase.co";
if (!user || !pass) {
  console.error("Saknar BILSTATISTIK_USERNAME/PASSWORD i .env");
  process.exit(1);
}

const H = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (o, ...k) => k.map((x) => o?.[x]).find((v) => v !== undefined);

async function getAll(path) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(`${sbUrl}/rest/v1/${path}&offset=${offset}&limit=1000`, { headers: H });
    if (!res.ok) throw new Error(`Supabase: ${(await res.text()).slice(0, 200)}`);
    const page = await res.json();
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

// ── Vilka handlare, och vilken period täljaren ska räknas över ───────────

const dealers = (
  await getAll("prospect_dealers?select=org_nr,company_name,deals_total&order=deals_total.desc")
)
  .filter((d) => d.deals_total >= minDeals)
  .slice(0, Number.isFinite(limit) ? limit : undefined);

console.log(`Period:    ${period.label}`);
console.log(`Handlare:  ${dealers.length}`);
console.log(`Kostnad:   ~${dealers.length} rader ur kvoten (en per handlare)\n`);

if (dry) {
  console.log("Torrkörning — inget hämtas. De tio första:");
  dealers.slice(0, 10).forEach((d) => console.log("  ", d.org_nr, d.company_name));
  process.exit(0);
}

// Täljaren ur redan sparad rådata. Perioden måste matcha nämnarens, annars
// blir andelen nonsens — därför hämtas datumspannet ur ett eget uttag först.
const probe = await fetchReport(
  buildLeasingSalesRequest({ dateRangeOptionId: period.id, leasingOnly: false }),
  user,
  pass,
  1
);
console.log(`Kontroll: perioden omfattar ${pick(probe, "TotalRowCount", "totalRowCount")} affärer totalt i landet\n`);

const tx = await getAll("prospect_leasing_tx?select=dealer_org_nr,tx_date");
const leasingByOrg = new Map();

// Periodgränser läses ur datan: ytd = innevarande år, forra-aret = fjolåret
const now = new Date();
const year = now.getFullYear();
const [from, to] =
  periodName === "ytd"
    ? [`${year}-01-01`, now.toISOString().slice(0, 10)]
    : [`${year - 1}-01-01`, `${year - 1}-12-31`];

for (const t of tx) {
  if (t.tx_date < from || t.tx_date > to) continue;
  leasingByOrg.set(t.dealer_org_nr, (leasingByOrg.get(t.dealer_org_nr) || 0) + 1);
}
console.log(`Täljare räknad ur prospect_leasing_tx för ${from} → ${to}\n`);

// ── Hämta nämnaren, en handlare i taget ─────────────────────────────────

const results = [];
let failed = 0;

for (const [i, d] of dealers.entries()) {
  const request = buildLeasingSalesRequest({
    dateRangeOptionId: period.id,
    leasingOnly: false,
    dealerOrgNrs: [d.org_nr],
  });

  try {
    const report = await fetchReport(request, user, pass, 1);
    results.push({
      org_nr: d.org_nr,
      period: periodName,
      b2b_deals: Number(pick(report, "TotalRowCount", "totalRowCount")) || 0,
      leasing_deals: leasingByOrg.get(d.org_nr) || 0,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    failed++;
    console.error(`  ${d.company_name}: ${err.message.slice(0, 120)}`);
    if (/quota/i.test(err.message)) {
      console.error("\nKvoten tog slut. Sparar det som hunnit hämtas.");
      break;
    }
  }

  if ((i + 1) % 50 === 0) console.log(`${i + 1}/${dealers.length} · ${failed} fel`);
  await sleep(DELAY_MS);
}

if (!results.length) {
  console.error("Inget hämtat.");
  process.exit(1);
}

// ── Spara ────────────────────────────────────────────────────────────────

for (let i = 0; i < results.length; i += 500) {
  const res = await fetch(`${sbUrl}/rest/v1/prospect_b2b_counts?on_conflict=org_nr`, {
    method: "POST",
    headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(results.slice(i, i + 500)),
  });
  if (!res.ok) {
    console.error("Skrivfel:", (await res.text()).slice(0, 300));
    process.exit(1);
  }
}

const withShare = results.filter((r) => r.b2b_deals > 0);
const shares = withShare.map((r) => r.leasing_deals / r.b2b_deals).sort((a, b) => a - b);
const median = shares.length ? shares[Math.floor(shares.length / 2)] : null;

console.log(`\nKlart: ${results.length} handlare sparade, ${failed} fel.`);
if (median != null) {
  console.log(`Medianleasingandel: ${Math.round(median * 100)} %`);
}
console.log("\nHögst leasingandel bland de med minst 20 företagsaffärer:");
withShare
  .filter((r) => r.b2b_deals >= 20)
  .sort((a, b) => b.leasing_deals / b.b2b_deals - a.leasing_deals / a.b2b_deals)
  .slice(0, 10)
  .forEach((r) => {
    const name = dealers.find((d) => d.org_nr === r.org_nr)?.company_name || r.org_nr;
    console.log(
      `  ${name.slice(0, 32).padEnd(32)} ${String(r.leasing_deals).padStart(4)}/${String(r.b2b_deals).padStart(4)}  ${Math.round((r.leasing_deals / r.b2b_deals) * 100)} %`
    );
  });
