/**
 * AOTO Prospekt — manuell hämtning från Bilstatistik.
 *
 * Kör hämtningen från kommandoraden istället för via en knapp i gränssnittet.
 * Bilstatistik har en frågegräns per dygn, så uttagen ska göras medvetet och
 * inte råka triggas av någon som klickar fel i arbetslistan.
 *
 *   node scripts/prospect-pull.mjs --period ytd
 *   node scripts/prospect-pull.mjs --period forra-aret
 *   node scripts/prospect-pull.mjs --period ytd --age-from 1 --dry
 *
 * Flaggor:
 *   --period ytd|forra-aret   Vilken period som hämtas (obligatorisk)
 *   --age-from <månader>      Fordonets minimiålder vid affären (default 1)
 *   --dry                     Hämta och visa, men skriv inget till Supabase
 *
 * Rullande 12 månader finns inte som periodalternativ hos Bilstatistik. Kör
 * båda perioderna en gång var, så täcker rådatan ett helt år och
 * 365-dagarsfönstret i recompute_prospect_dealers() skär ut det rullande året.
 * Överlapp är ofarligt: UNIQUE (reg_nr, tx_date, dealer_org_nr) rensar det.
 *
 * Läser inloggningsuppgifter ur .env i repo-roten.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildLeasingSalesRequest,
  fetchReportAllRows,
  parseTransactions,
  upsertTransactions,
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

function parseArgs(argv) {
  const args = { period: null, ageFrom: 1, dry: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--period") args.period = argv[++i];
    else if (argv[i] === "--age-from") args.ageFrom = Number(argv[++i]);
    else if (argv[i] === "--dry") args.dry = true;
  }
  return args;
}

const PERIODS = {
  ytd: { id: 1, label: "år-till-datum" },
  "forra-aret": { id: DATE_RANGE_PREV_YEAR, label: "föregående kalenderår" },
};

const args = parseArgs(process.argv.slice(2));
const period = PERIODS[args.period];

if (!period) {
  console.error("Ange --period ytd eller --period forra-aret");
  process.exit(2);
}
if (!Number.isFinite(args.ageFrom) || args.ageFrom < 0) {
  console.error("--age-from måste vara ett antal månader");
  process.exit(2);
}

const env = loadEnv();
const user = env.BILSTATISTIK_USERNAME;
const pass = env.BILSTATISTIK_PASSWORD;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SERVICE_ROLE_KEY;
const sbUrl = env.SUPABASE_URL || "https://plydduphthqhpmwasznr.supabase.co";

if (!user || !pass) {
  console.error("Saknar BILSTATISTIK_USERNAME/PASSWORD i .env");
  process.exit(1);
}
if (!serviceKey && !args.dry) {
  console.error("Saknar SUPABASE_SERVICE_ROLE_KEY i .env");
  process.exit(1);
}

console.log(`Period: ${period.label} (DateRangeOptionId ${period.id})`);
console.log(`Ålder från: ${args.ageFrom} mån`);
console.log(args.dry ? "Torrkörning — inget skrivs\n" : "Skriver till Supabase\n");

const request = buildLeasingSalesRequest({
  dateRangeOptionId: period.id,
  ageFromMonths: args.ageFrom,
});

console.log("Hämtar från Bilstatistik…");
const report = await fetchReportAllRows(request, user, pass);
const { transactions, skipped } = parseTransactions(report);

const dates = transactions.map((t) => t.tx_date).sort();
console.log(`\nRader: ${transactions.length} (${skipped} utan org.nr)`);
console.log(`Datumspann: ${dates[0]} → ${dates[dates.length - 1]}`);
console.log(`Unika återförsäljare: ${new Set(transactions.map((t) => t.dealer_org_nr)).size}`);

if (args.dry) {
  console.log("\nExempelrad:", transactions[0]);
  process.exit(0);
}

console.log("\nSkriver till prospect_leasing_tx…");
await upsertTransactions(sbUrl, serviceKey, transactions);

console.log("Räknar om prospect_dealers…");
const res = await fetch(`${sbUrl}/rest/v1/rpc/recompute_prospect_dealers`, {
  method: "POST",
  headers: {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  },
  body: "{}",
});
if (!res.ok) {
  console.error("Omräkning misslyckades:", (await res.text()).slice(0, 300));
  process.exit(1);
}
const agg = await res.json();
console.log(`\nKlart: ${agg.dealers} återförsäljare, ${agg.transactions} affärer i fönstret`);
console.log("Period i databasen:", JSON.stringify(agg.period));
