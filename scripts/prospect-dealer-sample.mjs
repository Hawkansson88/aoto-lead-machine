/**
 * AOTO Prospekt — titta närmare på en enskild återförsäljare.
 *
 * För när en siffra i listan ser konstig ut och man vill veta varför: vilka
 * köper bilarna, går de på leasing, och är det samma köpare om och om igen?
 *
 *   node scripts/prospect-dealer-sample.mjs --org 5569314098 --rows 300
 *   node scripts/prospect-dealer-sample.mjs --org 5569314098 --leasing
 *
 * Flaggor:
 *   --org <org.nr>     Säljande återförsäljare (obligatorisk)
 *   --rows <n>         Antal rader att hämta (default 200)
 *   --leasing          Bara leasingaffärer (default: alla företagsaffärer)
 *   --period <namn>    ytd (default) eller forra-aret
 *
 * Kostnaden är exakt det antal rader du ber om, så håll den nere. Svaret
 * visar ändå TotalRowCount, alltså hur många affärer bolaget har totalt, så
 * ett urval räcker långt för att se mönstret.
 *
 * Inget sparas till databasen — det här är ett analysverktyg, inte en import.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildLeasingSalesRequest,
  fetchReport,
  parseTransactions,
  DATE_RANGE_PREV_YEAR,
} from "../netlify/functions/prospect-sync.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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

const orgNr = String(arg("org", "")).replace(/\D/g, "");
const rows = Math.max(1, Math.min(Number(arg("rows", 200)), 1000));
const leasingOnly = argv.includes("--leasing");
const periodName = arg("period", "ytd");
const dateRangeOptionId = periodName === "forra-aret" ? DATE_RANGE_PREV_YEAR : 1;

if (orgNr.length !== 10) {
  console.error("--org måste vara tio siffror");
  process.exit(2);
}

const env = loadEnv();
if (!env.BILSTATISTIK_USERNAME || !env.BILSTATISTIK_PASSWORD) {
  console.error("Saknar BILSTATISTIK_USERNAME/PASSWORD i .env");
  process.exit(1);
}

console.log(`Återförsäljare: ${orgNr}`);
console.log(`Urval:          ${leasingOnly ? "bara leasingaffärer" : "alla företagsaffärer"}, ${periodName}`);
console.log(`Kostnad:        ${rows} rader ur kvoten\n`);

const pick = (o, ...k) => k.map((x) => o?.[x]).find((v) => v !== undefined);

let report;
try {
  report = await fetchReport(
    buildLeasingSalesRequest({ dateRangeOptionId, leasingOnly, dealerOrgNrs: [orgNr] }),
    env.BILSTATISTIK_USERNAME,
    env.BILSTATISTIK_PASSWORD,
    rows
  );
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const total = pick(report, "TotalRowCount", "totalRowCount") ?? 0;
const { transactions } = parseTransactions(report);

console.log(`Totalt i perioden: ${total.toLocaleString("sv-SE")} affärer`);
console.log(`Hämtade:           ${transactions.length}\n`);

function top(field, limit = 20) {
  const m = new Map();
  for (const t of transactions) {
    const v = t[field] || "–";
    m.set(v, (m.get(v) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

const customers = top("end_customer", 20);
const uniqueCustomers = new Set(transactions.map((t) => t.end_customer)).size;

console.log(`Unika köpare i urvalet: ${uniqueCustomers} av ${transactions.length} affärer`);
const concentration = customers.slice(0, 5).reduce((s, [, n]) => s + n, 0);
console.log(`De fem största köparna står för ${Math.round((concentration / transactions.length) * 100)} % av urvalet\n`);

console.log("Största köpare:");
customers.forEach(([name, n]) => console.log(`  ${String(n).padStart(4)}  ${name}`));

console.log("\nStörsta ägare efter affären (finansbolag eller köparen själv):");
top("finance_company", 12).forEach(([name, n]) => console.log(`  ${String(n).padStart(4)}  ${name}`));

console.log("\nMärken:");
top("make_name", 8).forEach(([name, n]) => console.log(`  ${String(n).padStart(4)}  ${name}`));

console.log("\nInnehavstid hos återförsäljaren:");
top("holding_time", 8).forEach(([name, n]) => console.log(`  ${String(n).padStart(4)}  ${name}`));
