/**
 * AOTO Prospekt — kostnadskoll innan ett skarpt uttag.
 *
 * Bilstatistiks kvot räknas i RADER, inte i antal frågor, och fönstret är en
 * vecka (felet säger "Retry after 604800 seconds"). Ett uttag på 24 000 rader
 * är alltså dyrt även om det bara är en fråga.
 *
 * Den här hämtar ett fåtal rader men läser av `TotalRowCount`, som talar om
 * vad ett fullt uttag skulle kosta. Fem rader för att slippa gissa.
 *
 *   node scripts/prospect-probe.mjs --request b2b-aggregat --period ytd
 *   node scripts/prospect-probe.mjs --request leasing --period forra-aret
 *   node scripts/prospect-probe.mjs --request b2b-fordon --period ytd --rows 3
 *
 * Flaggor:
 *   --request <namn>   leasing | b2b-fordon | b2b-aggregat
 *   --period <namn>    ytd | forra-aret
 *   --rows <n>         Antal rader att hämta (default 5 — håll den låg)
 *   --age-from <mån>   Fordonets minimiålder (default 1)
 *
 * Skriver ut kolumnerna som faktiskt kommer tillbaka, ett par exempelrader och
 * totalen. Använd det för att avgöra om en rapport går att identifiera på
 * org.nr innan ni lägger en veckas radbudget på den.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildLeasingSalesRequest,
  buildB2bRetailAggregateRequest,
  fetchReport,
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

const PERIODS = { ytd: 1, "forra-aret": DATE_RANGE_PREV_YEAR };
const periodName = arg("period", "ytd");
const dateRangeOptionId = PERIODS[periodName];
const ageFromMonths = Number(arg("age-from", 1));
const rows = Math.max(1, Math.min(Number(arg("rows", 5)), 50));
const requestName = arg("request", "b2b-aggregat");

if (!dateRangeOptionId) {
  console.error("--period måste vara ytd eller forra-aret");
  process.exit(2);
}

const REQUESTS = {
  leasing: {
    label: "Leasingaffärer till företag, en rad per bil",
    build: () => buildLeasingSalesRequest({ dateRangeOptionId, ageFromMonths }),
  },
  "b2b-fordon": {
    label: "Alla företagsaffärer, en rad per bil (dyr — för jämförelse)",
    build: () => buildLeasingSalesRequest({ dateRangeOptionId, ageFromMonths, leasingOnly: false }),
  },
  "b2b-aggregat": {
    label: "Alla företagsaffärer, aggregerat per återförsäljare",
    build: () => buildB2bRetailAggregateRequest({ dateRangeOptionId, ageFromMonths }),
  },
};

const chosen = REQUESTS[requestName];
if (!chosen) {
  console.error(`--request måste vara en av: ${Object.keys(REQUESTS).join(", ")}`);
  process.exit(2);
}

const env = loadEnv();
if (!env.BILSTATISTIK_USERNAME || !env.BILSTATISTIK_PASSWORD) {
  console.error("Saknar BILSTATISTIK_USERNAME/PASSWORD i .env");
  process.exit(1);
}

console.log(`Rapport:  ${chosen.label}`);
console.log(`Period:   ${periodName}`);
console.log(`Hämtar:   ${rows} rader\n`);

let report;
try {
  report = await fetchReport(chosen.build(), env.BILSTATISTIK_USERNAME, env.BILSTATISTIK_PASSWORD, rows);
} catch (err) {
  console.error(err.message);
  if (/quota/i.test(err.message)) {
    const secs = Number((err.message.match(/after (\d+) seconds/) || [])[1]);
    if (secs) {
      const when = new Date(Date.now() + secs * 1000);
      console.error(`\nKvoten släpper ${when.toISOString().slice(0, 16).replace("T", " ")} (om ${Math.round(secs / 86400)} dygn).`);
    }
  }
  process.exit(1);
}

// Bilstatistik svarar med stor begynnelsebokstav på fordonsrapporten och
// liten på den aggregerade. Läs båda.
const pick = (obj, ...keys) => keys.map((k) => obj?.[k]).find((v) => v !== undefined);
const columns = pick(report, "Columns", "columns") || [];
const total = pick(report, "TotalRowCount", "totalRowCount") ?? 0;
const reportRows = pick(report, "Rows", "rows") || [];
const totalRow = pick(report, "TotalRow", "totalRow");

console.log("Kolumner som returneras:");
columns.forEach((c) => {
  const idx = pick(c, "CellIndex", "cellIndex");
  const name = pick(c, "Name", "name") || "";
  const caps = (pick(c, "Captions", "captions") || []).map((x) => pick(x, "Caption", "caption")).join(" / ");
  console.log(`  ${String(idx).padStart(2)}  ${name.padEnd(52)} ${caps}`);
});

const hasOrgNr = columns.some((c) => {
  const name = pick(c, "Name", "name") || "";
  return /CompanyRegistrationNumber$/.test(name);
});
console.log(`\nOrg.nr i svaret: ${hasOrgNr ? "JA — går att joina exakt" : "NEJ — kräver namn-join"}`);

console.log(`\nTotalt antal rader ett fullt uttag skulle kosta: ${total.toLocaleString("sv-SE")}`);

console.log("\nExempelrader:");
reportRows.slice(0, 3).forEach((r) => console.log("  ", JSON.stringify(pick(r, "Cells", "cells"))));
if (totalRow) console.log("\nTotalrad:", JSON.stringify(pick(totalRow, "Cells", "cells")));
