/**
 * AOTO Prospekt — prospektlista för slutkundsleasing, hösten fram till jul.
 *
 * Fristående sida, inte en del av CRM:et: läser prospect_dealers (aggregat
 * från Bilstatistik) och prospect_list (klassning/ansvarig/anteckning), och
 * joinar mot dealer_market_stats för firmografi. Rankar på antal
 * leasingaffärer till företagskund.
 *
 * Sidan hämtar aldrig något från Bilstatistik. Uttag och omräkning körs från
 * scripts/, eftersom API:ets kvot räknas i rader per vecka och ett felklick
 * inte ska kunna bränna den.
 */

import { SUPABASE_URL, SUPABASE_ANON } from "./config.js";
import { bindFloatingTips } from "./floating-tip.js";
import { openProspectMap, bindProspectMap, closeProspectMap } from "./prospekt-map.js";
import { $, toast, formatOrgNr, escapeHtml, escapeAttr } from "./utils.js";

const PAGE_SIZE = 1000;
const SEARCH_DEBOUNCE_MS = 200;

/** Klassningen Anton och Marc jobbar efter. */
const STATUSES = [
  { key: "oklassad", label: "Oklassad" },
  { key: "a", label: "A-handlare" },
  { key: "b", label: "B-handlare" },
  { key: "c", label: "C-handlare" },
];

const STATUS_LABEL = Object.fromEntries(STATUSES.map((s) => [s.key, s.label]));

/** Bara de som faktiskt jobbar med listan går att tilldela. */
const OWNER_EMAILS = ["anton@aoto.se", "marc@aoto.se"];

/** @type {any} */
let sb = null;

/** @type {Array<Record<string, any>>} */
let dealers = [];
/** @type {Map<string, Record<string, any>>} */
let listByOrg = new Map();
/** @type {Map<string, Record<string, any>>} */
let statsByOrg = new Map();
/** @type {Array<Record<string, any>>} */
let exclusions = [];
/** Företagsaffärer per ÅF — nämnaren till leasingandelen. */
let b2bByOrg = new Map();
/** Mellanhänder som inte räknas som slutkunder. */
let buyerExclusions = [];
/** @type {Array<Record<string, any>>} */
let profiles = [];
let syncMeta = null;
let currentUserId = null;

/** @type {Array<Record<string, any>>} */
let indexed = [];
let sortKey = "rank";
let sortDir = 1;
let searchTimer = 0;
let openOrgNr = null;
let bound = false;

const filters = {
  status: "alla",
  owner: "alla",
  minDeals: 0,
  city: "",
  turnoverMin: null,
  turnoverMax: null,
  /** "aktiva" = dölj uteslutna, "uteslutna" = bara dem, "alla" = båda */
  excludedMode: "aktiva",
  q: "",
};

// ── Hjälpare ─────────────────────────────────────────────────────────────

function fmtNum(value) {
  if (value == null || value === "") return "–";
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("sv-SE") : "–";
}

function fmtPct(ratio) {
  if (ratio == null || ratio === "") return "–";
  const n = Number(ratio);
  if (!Number.isFinite(n)) return "–";
  return Math.round(n * 100) + " %";
}

function fmtTkrAsMkr(tkr) {
  if (tkr == null || tkr === "") return "–";
  const n = Number(tkr);
  if (!Number.isFinite(n)) return "–";
  return (n / 1000).toLocaleString("sv-SE", { maximumFractionDigits: 1 });
}

function personName(profile) {
  if (!profile) return "–";
  const name = [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim();
  return name || profile.full_name || profile.email || "–";
}

function initials(profile) {
  const name = personName(profile);
  if (name === "–") return "?";
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();
}

/** ILIKE-mönster ('Hedin %') → RegExp. */
function patternToRegex(pattern) {
  const escaped = String(pattern)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, ".*")
    .replace(/_/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/** Matchar bolaget någon rad i prospect_exclusions? */
function matchExclusion(dealer) {
  const name = String(dealer.company_name || "");
  for (const ex of exclusions) {
    if (ex.org_nr && ex.org_nr === dealer.org_nr) return ex;
    if (ex.name_pattern && patternToRegex(ex.name_pattern).test(name)) return ex;
  }
  return null;
}

/**
 * Momentum: dag 30–120 bakåt mot exakt samma dagar ett år tidigare.
 *
 * Årsjämförelsen finns för att kvartal mot kvartal mäter säsong snarare än
 * tillväxt, och marginalen på 30 dagar för att registreringar släpar i
 * Bilstatistik. null när jämförelsen inte bär: saknad historik, eller för få
 * affärer för att skillnaden ska betyda något.
 */
function momentum(dealer) {
  // null, inte 0 — databasen lämnar fältet tomt när rådatan inte når ett år
  // bakåt, och det är inte samma sak som noll affärer.
  if (dealer.deals_prev_90d == null) return null;
  const recent = Number(dealer.deals_recent_90d) || 0;
  const prev = Number(dealer.deals_prev_90d);
  if (recent + prev < 4) return null;
  if (prev === 0) return recent > 0 ? 1 : null;
  return (recent - prev) / prev;
}

// ── Datahämtning ─────────────────────────────────────────────────────────

/** Läser en hel tabell i sidor om PAGE_SIZE. */
async function selectAll(table, columns, order) {
  const out = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = sb.from(table).select(columns).range(from, from + PAGE_SIZE - 1);
    if (order) query = query.order(order.column, { ascending: order.ascending !== false });
    const { data, error } = await query;
    if (error) {
      console.warn(`Kunde inte läsa ${table}`, error);
      break;
    }
    out.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return out;
}

async function loadAll() {
  const [dealerRows, listRows, exclusionRows, b2bRows, buyerRows, profileRows, stateRow] =
    await Promise.all([
    selectAll(
      "prospect_dealers",
      "org_nr, company_name, deals_total, distinct_customers, deals_recent_90d, deals_prev_90d, floorplan_share, finance_company_count, first_tx, last_tx, finance_companies, makes, months, updated_at",
      { column: "deals_total", ascending: false }
    ),
    selectAll(
      "prospect_list",
      "org_nr, owner_id, status, next_action, next_action_date, note, excluded, excluded_reason, updated_at"
    ),
    selectAll("prospect_exclusions", "id, org_nr, name_pattern, kind, note"),
    selectAll("prospect_b2b_counts", "org_nr, period, b2b_deals, leasing_deals, updated_at"),
    selectAll("prospect_buyer_exclusions", "org_nr, company_name, sni, note"),
    selectAll("profiles", "id, email, first_name, last_name, role"),
    sb.from("app_state").select("value, updated_at").eq("key", "prospect_sync").maybeSingle(),
  ]);

  dealers = dealerRows;
  listByOrg = new Map(listRows.map((r) => [r.org_nr, r]));
  exclusions = exclusionRows;
  b2bByOrg = new Map(b2bRows.map((r) => [r.org_nr, r]));
  buyerExclusions = buyerRows;
  profiles = profileRows.filter((p) => OWNER_EMAILS.includes((p.email || "").toLowerCase()));
  syncMeta = stateRow?.data?.value || null;

  await loadMarketStats(dealers.map((d) => d.org_nr));
  rebuildIndex();
  renderAll();
}

/** Firmografi för de ÅF som finns i listan (adress, omsättning, anställda). */
async function loadMarketStats(orgNrs) {
  statsByOrg = new Map();
  const columns =
    "org_nr, company_name, address, postcode, city, employees, turnover_tkr, profit_tkr, established_year, lagerantal, lat, lng";
  const CHUNK = 200;
  for (let i = 0; i < orgNrs.length; i += CHUNK) {
    const chunk = orgNrs.slice(i, i + CHUNK);
    const { data, error } = await sb.from("dealer_market_stats").select(columns).in("org_nr", chunk);
    if (error) {
      console.warn("Kunde inte läsa dealer_market_stats", error);
      return;
    }
    for (const row of data || []) statsByOrg.set(row.org_nr, row);
  }
}

// ── Index och filtrering ─────────────────────────────────────────────────

function rebuildIndex() {
  indexed = dealers.map((dealer) => {
    const list = listByOrg.get(dealer.org_nr) || null;
    const stats = statsByOrg.get(dealer.org_nr) || null;
    const autoExclusion = matchExclusion(dealer);
    // Manuellt beslut i prospect_list väger tyngre än mönsterlistan
    const excluded = list?.excluded != null ? !!list.excluded : !!autoExclusion;
    const excludedReason = list?.excluded_reason || autoExclusion?.note || autoExclusion?.kind || null;

    return {
      dealer,
      list,
      stats,
      excluded,
      excludedReason,
      momentum: momentum(dealer),
      city: stats?.city || "",
      hay: [
        dealer.company_name,
        dealer.org_nr,
        formatOrgNr(dealer.org_nr),
        stats?.city,
        stats?.address,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
    };
  });

  // Rank = placering bland icke-uteslutna, på antal affärer
  const ranked = indexed
    .filter((r) => !r.excluded)
    .sort((a, b) => b.dealer.deals_total - a.dealer.deals_total);
  ranked.forEach((r, i) => {
    r.rank = i + 1;
  });
}

function passesFilters(row) {
  if (filters.excludedMode === "aktiva" && row.excluded) return false;
  if (filters.excludedMode === "uteslutna" && !row.excluded) return false;
  const status = row.list?.status || "oklassad";
  if (filters.status !== "alla" && status !== filters.status) return false;

  if (filters.owner === "mina" && row.list?.owner_id !== currentUserId) return false;
  if (filters.owner === "otilldelade" && row.list?.owner_id) return false;
  if (
    filters.owner !== "alla" &&
    filters.owner !== "mina" &&
    filters.owner !== "otilldelade" &&
    row.list?.owner_id !== filters.owner
  ) {
    return false;
  }

  if (row.dealer.deals_total < filters.minDeals) return false;

  if (filters.city) {
    const city = (row.stats?.city || "").toLowerCase();
    if (!city.includes(filters.city.toLowerCase())) return false;
  }

  const turnoverMkr = row.stats?.turnover_tkr != null ? row.stats.turnover_tkr / 1000 : null;
  if (filters.turnoverMin != null && (turnoverMkr == null || turnoverMkr < filters.turnoverMin)) {
    return false;
  }
  if (filters.turnoverMax != null && (turnoverMkr == null || turnoverMkr > filters.turnoverMax)) {
    return false;
  }

  if (filters.q && !row.hay.includes(filters.q.toLowerCase())) return false;

  return true;
}

function sortValue(row, key) {
  switch (key) {
    case "rank":
      return row.rank ?? Number.MAX_SAFE_INTEGER;
    case "company_name":
      return (row.dealer.company_name || "").toLowerCase();
    case "momentum":
      return row.momentum ?? -Infinity;
    case "b2b":
      return b2bByOrg.get(row.dealer.org_nr)?.b2b_deals ?? -1;
    case "finance_company_count":
      return row.dealer.finance_company_count ?? -1;
    case "status":
      return STATUSES.findIndex((s) => s.key === (row.list?.status || "oklassad"));
    case "owner":
      return personName(profiles.find((p) => p.id === row.list?.owner_id)).toLowerCase();
    default:
      return row.dealer[key] ?? -1;
  }
}

function visibleRows() {
  const rows = indexed.filter(passesFilters);
  rows.sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    if (av < bv) return -1 * sortDir;
    if (av > bv) return 1 * sortDir;
    return a.dealer.deals_total < b.dealer.deals_total ? 1 : -1;
  });
  return rows;
}

// ── Rendering ────────────────────────────────────────────────────────────

function renderAll() {
  renderStats();
  renderStatusFilter();
  renderOwnerFilter();
  renderExcludedFilter();
  renderTable();
  renderSubtitle();
}

function renderStats() {
  const active = indexed.filter((r) => !r.excluded);
  const byClass = (key) => active.filter((r) => (r.list?.status || "oklassad") === key).length;

  $("#prospectStats").innerHTML = [
    { label: "I listan", value: active.length },
    { label: "A-handlare", value: byClass("a") },
    { label: "B-handlare", value: byClass("b") },
    { label: "C-handlare", value: byClass("c") },
  ]
    .map(
      (s) =>
        `<div class="stat"><div class="v num">${s.value}</div><div class="l">${escapeHtml(s.label)}</div></div>`
    )
    .join("");
}

function renderStatusFilter() {
  const counts = new Map();
  for (const row of indexed) {
    if (row.excluded) continue;
    const status = row.list?.status || "oklassad";
    counts.set(status, (counts.get(status) || 0) + 1);
  }
  const total = indexed.filter((r) => !r.excluded).length;

  const items = [{ key: "alla", label: "Alla", count: total }].concat(
    STATUSES.map((s) => ({ key: s.key, label: s.label, count: counts.get(s.key) || 0 }))
  );

  $("#statusFilter").innerHTML = items
    .map(
      (item) =>
        `<div class="status-item${filters.status === item.key ? " active" : ""}" data-status="${escapeAttr(item.key)}">
           <span>${escapeHtml(item.label)}</span><b class="cnt">${item.count}</b>
         </div>`
    )
    .join("");
}

function renderOwnerFilter() {
  const items = [
    { key: "alla", label: "Alla" },
    { key: "mina", label: "Mina" },
    { key: "otilldelade", label: "Otilldelade" },
  ].concat(profiles.map((p) => ({ key: p.id, label: personName(p) })));

  $("#ownerFilter").innerHTML = items
    .map(
      (item) =>
        `<div class="status-item${filters.owner === item.key ? " active" : ""}" data-owner="${escapeAttr(item.key)}">
           <span>${escapeHtml(item.label)}</span>
         </div>`
    )
    .join("");
}

/** Aktiva / uteslutna / alla. Uteslutna blandas inte in i arbetslistan. */
function renderExcludedFilter() {
  const excluded = indexed.filter((r) => r.excluded).length;
  const active = indexed.length - excluded;

  const items = [
    { key: "aktiva", label: "Dölj uteslutna", count: active },
    { key: "uteslutna", label: "Visa endast uteslutna", count: excluded },
    { key: "alla", label: "Visa alla", count: indexed.length },
  ];

  $("#excludedFilter").innerHTML = items
    .map(
      (item) =>
        `<div class="status-item${filters.excludedMode === item.key ? " active" : ""}" data-excluded="${escapeAttr(item.key)}">
           <span>${escapeHtml(item.label)}</span><b class="cnt">${item.count}</b>
         </div>`
    )
    .join("");
}

function momentumHtml(value) {
  if (value == null) return '<span class="faint">–</span>';
  const pct = Math.round(value * 100);
  const cls = pct > 10 ? "mom-up" : pct < -10 ? "mom-down" : "mom-flat";
  const arrow = pct > 10 ? "▲" : pct < -10 ? "▼" : "→";
  return `<span class="mom ${cls}">${arrow} ${pct > 0 ? "+" : ""}${pct} %</span>`;
}

function financeHtml(dealer) {
  const list = Array.isArray(dealer.finance_companies) ? dealer.finance_companies : [];
  if (!list.length) return '<span class="faint">–</span>';
  const shown = list.slice(0, 2);
  const rest = list.length - shown.length;
  const tip = list.map((f) => `${f.name}: ${f.count}`).join("\n");
  return `<span class="fin-cell has-tip" data-tip="${escapeAttr(tip)}">${shown
    .map((f) => `${escapeHtml(shortFinance(f.name))} <b class="num">${f.count}</b>`)
    .join("<br />")}${rest > 0 ? `<span class="faint"> +${rest}</span>` : ""}</span>`;
}

/** "Santander Consumer Bank AS Norge, Sverige Filial" → "Santander" */
function shortFinance(name) {
  return String(name || "")
    .replace(/\s+(AB|AS|A\/S|ASA|GmbH|Filial|filial).*$/i, "")
    .replace(/,.*$/, "")
    .trim()
    .slice(0, 22);
}

function statusPillHtml(status) {
  const key = status || "oklassad";
  return `<span class="pill status-${escapeAttr(key)}">${escapeHtml(STATUS_LABEL[key] || key)}</span>`;
}

function ownerHtml(ownerId) {
  if (!ownerId) return '<span class="faint">–</span>';
  const profile = profiles.find((p) => p.id === ownerId);
  if (!profile) return '<span class="faint">–</span>';
  return `<span class="av av-sm has-tip" data-tip="${escapeAttr(personName(profile))}">${escapeHtml(initials(profile))}</span>`;
}

/** "2026-01-01 → 2026-09-21" — perioden nämnaren hämtades för. */
function periodLabel(counts) {
  const to = counts.updated_at?.slice(0, 10);
  return to ? `${to.slice(0, 4)}-01-01 → ${to}` : "innevarande år";
}

/**
 * Företagsaffärer till slutkund, med leasingandelen under.
 *
 * Både täljare och nämnare kommer ur prospect_b2b_counts och avser samma
 * period, med mellanhänder borträknade i båda.
 *
 * Tillförlitligheten går att sluta sig till från andelen själv. En okänd
 * mellanhand kan bara blåsa upp nämnaren, aldrig täljaren — felet drar alltså
 * andelen nedåt. Ett högt tal kan därför inte vara uppblåst, medan ett lågt
 * tal antingen är sant eller döljer en auktionskanal vi ännu inte känner till.
 * Tesla låg på 6 % innan AUTOproff och Handlarbudet plockades bort; rätt
 * siffra var 86 %.
 */
function b2bCellHtml(row) {
  const counts = b2bByOrg.get(row.dealer.org_nr);
  if (!counts || counts.b2b_deals == null) {
    const tip =
      "Nämnaren är inte hämtad för den här handlaren än. Varje bolag kostar en rad ur Bilstatistiks veckokvot.";
    return `<span class="faint has-tip" data-tip="${escapeAttr(tip)}">–</span>`;
  }

  const share =
    counts.b2b_deals > 0 ? Math.round((counts.leasing_deals / counts.b2b_deals) * 100) : null;
  if (share == null) return `<span class="num">${fmtNum(counts.b2b_deals)}</span>`;

  const cls = share >= 60 ? "share-high" : share >= 35 ? "share-mid" : "share-low";
  const reliable = share >= 35;
  const basis = `${fmtNum(counts.leasing_deals)} av ${fmtNum(counts.b2b_deals)} företagsaffärer hittills i år gick på leasing (${periodLabel(counts)}).`;
  const tip = reliable
    ? `${basis}\n\nSiffran är tillförlitlig. En oupptäckt mellanhand kan bara blåsa upp nämnaren och dra andelen nedåt, aldrig uppåt — så högt kan den inte vara felaktigt uppblåst.`
    : `${basis}\n\nBör dubbelkollas. Antingen leasar de verkligen sällan, eller så säljer de inbyten via en B2B-auktion som räknas som företagskund.\n\nTesla såg ut att ligga på 6 % tills AUTOproff och Handlarbudet plockades bort. Rätt siffra var 86 %.\n\nKontrollera med:\nnode scripts/prospect-dealer-sample.mjs --org ${row.dealer.org_nr}`;

  return `<span class="num">${fmtNum(counts.b2b_deals)}</span>
    <div class="cell-sub ${cls} has-tip" data-tip="${escapeAttr(tip)}">${share} % leasing <i class="rel-${
      reliable ? "ok" : "warn"
    }">${reliable ? "✓" : "⚠"}</i></div>`;
}

function renderTable() {
  const rows = visibleRows();
  $("#resultCount").textContent = rows.length;
  $("#empty").style.display = rows.length ? "none" : "block";

  $("#prospectRows").innerHTML = rows
    .map((row, i) => {
      const d = row.dealer;
      // Uteslutna saknar placering i arbetslistan — numrera dem löpande så
      // kolumnen inte blir en rad med streck i den renodlade vyn.
      const rank = row.rank ?? i + 1;
      const city = row.stats?.city || "";
      return `
        <tr data-org="${escapeAttr(d.org_nr)}"${
          // Dämpa bara när uteslutna ligger blandade med de aktiva — i den
          // renodlade listan vore allt överstruket, och den ska gå att jobba i.
          row.excluded && filters.excludedMode === "alla" ? ' class="row-excluded"' : ""
        }>
          <td class="num">${rank}</td>
          <td>
            <div class="cell-name">${escapeHtml(d.company_name || "—")}</div>
            <div class="cell-sub num">${escapeHtml(formatOrgNr(d.org_nr))}${
              row.excluded ? ` · <span class="faint">utesluten</span>` : ""
            }</div>
          </td>
          <td>${escapeHtml(city) || '<span class="faint">–</span>'}</td>
          <td class="right num"><b>${fmtNum(d.deals_total)}</b></td>
          <td class="right num">${fmtNum(d.distinct_customers)}</td>
          <td class="right">${momentumHtml(row.momentum)}</td>
          <td class="right">${b2bCellHtml(row)}</td>
          <td class="right num">${fmtNum(d.finance_company_count)}</td>
          <td class="fin">${financeHtml(d)}</td>
          <td>${statusPillHtml(row.list?.status)}</td>
          <td>${ownerHtml(row.list?.owner_id)}</td>
        </tr>`;
    })
    .join("");

  bindFloatingTips();
}

function renderSubtitle() {
  const el = $("#dataUpdated");
  if (!syncMeta?.period) {
    el.textContent = " · Data: –";
    return;
  }
  const { first_tx, last_tx, window_start } = syncMeta.period;
  el.textContent = ` · Period: ${window_start || first_tx} → ${last_tx} · ${fmtNum(
    syncMeta.transactions
  )} affärer`;
}

// ── Om urvalet ───────────────────────────────────────────────────────────

/**
 * Vad listan faktiskt visar. Hämtar siffrorna ur datan i stället för att
 * upprepa dem i text, så beskrivningen inte hinner bli osann.
 */
function renderInfo() {
  const period = syncMeta?.period;
  const withB2b = indexed.filter((r) => b2bByOrg.has(r.dealer.org_nr)).length;
  const manualDecision = (r) => r.list?.excluded != null;
  const excludedManually = indexed.filter((r) => r.list?.excluded === true).length;
  const excludedByPattern = indexed.filter((r) => r.excluded && !manualDecision(r)).length;
  const patternOverridden = indexed.filter(
    (r) => r.list?.excluded === false && matchExclusion(r.dealer)
  ).length;

  const filters = [
    ["Fordon", "Personbil, lätt lastbil och husbil"],
    ["Ålder", "Minst 1 månad vid affären — allt utom fabriksnytt"],
    ["Affärstyp", "Bilen registrerad på ett leasingavtal"],
    ["Säljare", "Föregående brukare med bilhandel som bransch"],
    ["Köpare", "Företag. Ej bilhandel, ej finansbolag, ej privatperson"],
    ["Geografi", "Hela Sverige"],
  ];

  const data = [
    ["Period", period ? `${period.window_start} → ${period.last_tx}` : "–"],
    ["Affärer i perioden", fmtNum(syncMeta?.transactions)],
    ["Återförsäljare", fmtNum(dealers.length)],
    ["Senast hämtat", syncMeta?.synced_at ? syncMeta.synced_at.slice(0, 10) : "–"],
    [
      "Trendjämförelse",
      period?.momentum_recent
        ? `${period.momentum_recent[0]} → ${period.momentum_recent[1]} mot samma period i fjol`
        : "–",
    ],
  ];

  $("#infoBody").innerHTML = `
    <p class="info-lead">
      Återförsäljare rankade på antal leasingaffärer till företagskund, hämtade
      från Bilstatistik. Varje rad i grunddatan är en enskild bil.
    </p>

    <h4>Urvalet filtrerar på</h4>
    <div class="info-grid">
      ${filters.map(([k, v]) => `<span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b>`).join("")}
    </div>

    <h4>Datan just nu</h4>
    <div class="info-grid">
      ${data.map(([k, v]) => `<span>${escapeHtml(k)}</span><b>${escapeHtml(String(v))}</b>`).join("")}
    </div>

    <h4>Säljaren identifieras på brukaren, inte ägaren</h4>
    <p class="info-note">
      När en bil ligger på lagerfinansiering står finansbolaget som ägare medan
      handlaren är brukare. Det gäller ungefär var tredje affär, så ett filter på
      ägaren hade missat dem.
    </p>

    <h4>Leasingandel</h4>
    <p class="info-note">
      Nämnaren är alla företagsaffärer till slutkund under innevarande år, hämtad
      med samma filter minus leasingvillkoret. Den finns för
      <b>${withB2b} av ${indexed.length}</b> handlare — övriga visar streck.
    </p>
    <p class="info-note">
      ${buyerExclusions.length} köpare räknas inte som slutkunder, eftersom de är
      B2B-auktioner eller mellanhänder:
      ${buyerExclusions.map((b) => escapeHtml(b.company_name)).join(", ") || "inga"}.
      De är inte registrerade som bilhandel och slipper därför igenom branschfiltret.
    </p>

    <h4>Uteslutna handlare</h4>
    <p class="info-note">
      ${exclusions.length} mönster i blocklistan filtrerar bort koncerner och
      finansbolag. Ett manuellt beslut på en enskild handlare väger alltid tyngre
      än mönstret.
    </p>
    <div class="info-grid">
      <span>Uteslutna via mönster</span><b>${fmtNum(excludedByPattern)}</b>
      <span>Uteslutna manuellt</span><b>${fmtNum(excludedManually)}</b>
      <span>Mönster överkört, visas ändå</span><b>${fmtNum(patternOverridden)}</b>
    </div>
  `;
}

function openInfo() {
  renderInfo();
  $("#infoModal").classList.add("open");
  $("#infoScrim").classList.add("open");
}

function closeInfo() {
  $("#infoModal").classList.remove("open");
  $("#infoScrim").classList.remove("open");
}

// ── Detaljpanel ──────────────────────────────────────────────────────────

function monthsHtml(months) {
  const entries = Object.entries(months || {}).sort();
  if (!entries.length) return '<p class="faint">Ingen månadsdata</p>';
  const max = Math.max(...entries.map(([, v]) => v));
  return `<div class="month-bars">${entries
    .map(
      ([month, count]) =>
        `<div class="month-bar has-tip" data-tip="${escapeAttr(month)}: ${count} affärer">
           <span style="height:${Math.max(4, Math.round((count / max) * 56))}px"></span>
           <em>${escapeHtml(month.slice(5))}</em>
         </div>`
    )
    .join("")}</div>`;
}

function countListHtml(items, emptyText) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return `<p class="faint">${escapeHtml(emptyText)}</p>`;
  const max = Math.max(...list.map((i) => i.count));
  return `<div class="count-list">${list
    .map(
      (item) => `
      <div class="count-row">
        <span class="count-label">${escapeHtml(item.name)}</span>
        <span class="count-track"><span style="width:${Math.round((item.count / max) * 100)}%"></span></span>
        <b class="num">${item.count}</b>
      </div>`
    )
    .join("")}</div>`;
}

function openDealer(orgNr) {
  const row = indexed.find((r) => r.dealer.org_nr === orgNr);
  if (!row) return;
  openOrgNr = orgNr;

  const d = row.dealer;
  const s = row.stats;
  const list = row.list || {};

  $("#pRing").textContent = fmtNum(d.deals_total);
  $("#pName").textContent = d.company_name || "—";
  $("#pMeta").textContent = [formatOrgNr(d.org_nr), s?.city, s?.address].filter(Boolean).join(" · ");
  $("#excludeBtn").textContent = row.excluded ? "Ta tillbaka" : "Uteslut";

  const facts = [
    ["Leasingaffärer i år", fmtNum(d.deals_total)],
    ["Unika slutkunder", fmtNum(d.distinct_customers)],
    ["Företagsaffärer i år", fmtNum(b2bByOrg.get(d.org_nr)?.b2b_deals)],
    ["Kvartal i år", fmtNum(d.deals_recent_90d)],
    ["Samma kvartal i fjol", fmtNum(d.deals_prev_90d)],
    ["Antal finansbolag", fmtNum(d.finance_company_count)],
    ["Lagerfinansierat", fmtPct(d.floorplan_share)],
    ["Omsättning (Mkr)", fmtTkrAsMkr(s?.turnover_tkr)],
    ["Resultat (Mkr)", fmtTkrAsMkr(s?.profit_tkr)],
    ["Anställda", fmtNum(s?.employees)],
    ["Etablerad", s?.established_year || "–"],
    ["I lager", fmtNum(s?.lagerantal)],
    ["Senaste affär", d.last_tx || "–"],
  ];

  $("#pBody").innerHTML = `
    ${
      row.excluded
        ? `<div class="p-note">Utesluten${
            row.excludedReason ? `: ${escapeHtml(row.excludedReason)}` : ""
          }</div>`
        : ""
    }

    <section class="p-sec">
      <h4>Klassning och ansvar</h4>
      <div class="field">
        <label for="pStatus">Klass</label>
        <select id="pStatus">
          ${STATUSES.map(
            (st) =>
              `<option value="${st.key}"${(list.status || "oklassad") === st.key ? " selected" : ""}>${escapeHtml(st.label)}</option>`
          ).join("")}
        </select>
      </div>
      <div class="field">
        <label for="pOwner">Ansvarig</label>
        <select id="pOwner">
          <option value="">–</option>
          ${profiles
            .map(
              (p) =>
                `<option value="${escapeAttr(p.id)}"${list.owner_id === p.id ? " selected" : ""}>${escapeHtml(personName(p))}</option>`
            )
            .join("")}
        </select>
      </div>
      <div class="field">
        <label for="pNextAction">Nästa åtgärd</label>
        <input id="pNextAction" type="text" placeholder="t.ex. Ring om portalen" value="${escapeAttr(list.next_action || "")}" />
      </div>
      <div class="field">
        <label for="pNextDate">Datum</label>
        <input id="pNextDate" type="date" class="dateinput" value="${escapeAttr(list.next_action_date || "")}" />
      </div>
      <div class="field">
        <label for="pNote">Anteckning</label>
        <textarea id="pNote" rows="4" placeholder="Vad sa de?">${escapeHtml(list.note || "")}</textarea>
      </div>
      <button class="btn btn-prim" id="pSaveBtn">Spara</button>
    </section>

    <section class="p-sec">
      <h4>Nyckeltal</h4>
      <div class="fact-grid">
        ${facts
          .map(
            ([label, value]) =>
              `<div class="fact"><span>${escapeHtml(label)}</span><b class="num">${value}</b></div>`
          )
          .join("")}
      </div>
    </section>

    <section class="p-sec">
      <h4>Affärer per månad</h4>
      ${monthsHtml(d.months)}
    </section>

    <section class="p-sec">
      <h4>Finansbolag idag</h4>
      <p class="p-hint">Leasinggivarna ÅF:en använder nu — det är dem AOTO ska ersätta.</p>
      ${countListHtml(d.finance_companies, "Ingen finansbolagsdata")}
    </section>

    <section class="p-sec">
      <h4>Märken</h4>
      ${countListHtml(d.makes, "Ingen märkesdata")}
    </section>
  `;

  $("#pSaveBtn").onclick = () => saveListRow(orgNr);
  $("#panel").classList.add("open");
  $("#scrim").classList.add("open");
  bindFloatingTips();
}

function closePanel() {
  openOrgNr = null;
  $("#panel").classList.remove("open");
  $("#scrim").classList.remove("open");
}

// ── Skrivning ────────────────────────────────────────────────────────────

async function upsertList(orgNr, patch) {
  const existing = listByOrg.get(orgNr) || { org_nr: orgNr };
  const row = { ...existing, ...patch, org_nr: orgNr, updated_at: new Date().toISOString() };

  const { data, error } = await sb
    .from("prospect_list")
    .upsert(row, { onConflict: "org_nr" })
    .select()
    .maybeSingle();

  if (error) {
    console.error(error);
    toast(error.message || "Kunde inte spara", { error: true });
    return null;
  }

  listByOrg.set(orgNr, data || row);
  rebuildIndex();
  renderAll();
  return data || row;
}

async function saveListRow(orgNr) {
  const patch = {
    status: $("#pStatus").value,
    owner_id: $("#pOwner").value || null,
    next_action: $("#pNextAction").value.trim() || null,
    next_action_date: $("#pNextDate").value || null,
    note: $("#pNote").value.trim() || null,
  };
  const saved = await upsertList(orgNr, patch);
  if (saved) toast("Sparat");
}

async function toggleExcluded() {
  if (!openOrgNr) return;
  const row = indexed.find((r) => r.dealer.org_nr === openOrgNr);
  if (!row) return;

  const next = !row.excluded;
  const saved = await upsertList(openOrgNr, {
    excluded: next,
    excluded_reason: next ? "Manuellt utesluten" : null,
  });
  if (saved) {
    toast(next ? "Utesluten ur listan" : "Tillbaka i listan");
    openDealer(openOrgNr);
  }
}

// ── UI-bindning ──────────────────────────────────────────────────────────

function numOrNull(value) {
  if (value === "" || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function bindFilters() {
  $("#statusFilter").addEventListener("click", (e) => {
    const item = e.target.closest("[data-status]");
    if (!item) return;
    filters.status = item.dataset.status;
    renderStatusFilter();
    renderTable();
  });

  $("#ownerFilter").addEventListener("click", (e) => {
    const item = e.target.closest("[data-owner]");
    if (!item) return;
    filters.owner = item.dataset.owner;
    renderOwnerFilter();
    renderTable();
  });

  $("#minDealsSlider").addEventListener("input", (e) => {
    filters.minDeals = Number(e.target.value) || 0;
    $("#minDealsVal").textContent = filters.minDeals;
    renderTable();
  });

  $("#pfCity").addEventListener("input", (e) => {
    filters.city = e.target.value.trim();
    renderTable();
  });

  $("#pfTurnoverMin").addEventListener("input", (e) => {
    filters.turnoverMin = numOrNull(e.target.value);
    renderTable();
  });
  $("#pfTurnoverMax").addEventListener("input", (e) => {
    filters.turnoverMax = numOrNull(e.target.value);
    renderTable();
  });

  $("#excludedFilter").addEventListener("click", (e) => {
    const item = e.target.closest("[data-excluded]");
    if (!item) return;
    filters.excludedMode = item.dataset.excluded;
    renderExcludedFilter();
    renderTable();
  });
  $("#clearFiltersBtn").onclick = () => {
    Object.assign(filters, {
      status: "alla",
      owner: "alla",
      minDeals: 0,
      city: "",
      turnoverMin: null,
      turnoverMax: null,
      excludedMode: "aktiva",
    });
    $("#minDealsSlider").value = "0";
    $("#minDealsVal").textContent = "0";
    $("#pfCity").value = "";
    $("#pfTurnoverMin").value = "";
    $("#pfTurnoverMax").value = "";
    renderAll();
  };
}

function bindSort() {
  document.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (sortKey === key) sortDir *= -1;
      else {
        sortKey = key;
        // Antal, trend och liknande vill man se högst först
        sortDir = ["rank", "company_name", "owner", "status"].includes(key) ? 1 : -1;
      }
      renderTable();
    });
  });
}

function bindUi() {
  if (bound) return;
  bound = true;

  $("#authBtn").onclick = doLogin;
  $("#authPw").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLogin();
  });
  $("#authEmail").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#authPw").focus();
  });
  $("#logoutBtn").onclick = () => sb.auth.signOut();

  $("#search").addEventListener("input", (e) => {
    filters.q = e.target.value || "";
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderTable, SEARCH_DEBOUNCE_MS);
  });

  // Kartan får de filtrerade raderna, så sidopanelens filter gäller där också
  $("#infoBtn").onclick = openInfo;
  $("#infoClose").onclick = closeInfo;
  $("#infoScrim").onclick = closeInfo;
  $("#mapBtn").onclick = () => openProspectMap(visibleRows(), openDealer);
  bindProspectMap();
  $("#excludeBtn").onclick = toggleExcluded;
  $("#pClose").onclick = closePanel;
  $("#scrim").onclick = closePanel;
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closePanel();
    closeProspectMap();
    closeInfo();
  });

  $("#prospectRows").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-org]");
    if (tr) openDealer(tr.dataset.org);
  });

  bindFilters();
  bindSort();
  bindFloatingTips();
}

// ── Boot ─────────────────────────────────────────────────────────────────

function showApp() {
  $("#app").style.display = "grid";
  $("#authGate").classList.remove("show");
}

function showGate() {
  $("#app").style.display = "none";
  $("#authGate").classList.add("show");
  closePanel();
}

async function doLogin() {
  const email = $("#authEmail").value.trim();
  const password = $("#authPw").value;
  const btn = $("#authBtn");
  const err = $("#authErr");

  err.textContent = "";
  if (!email || !password) {
    err.textContent = "Fyll i e-post och lösenord.";
    return;
  }

  btn.disabled = true;
  btn.textContent = "Loggar in…";
  const { error } = await sb.auth.signInWithPassword({ email, password });
  btn.disabled = false;
  btn.textContent = "Logga in";
  if (error) err.textContent = "Fel e-post eller lösenord.";
}

async function enterApp(session) {
  showApp();
  currentUserId = session.user.id;
  const email = session.user.email || "";
  $("#userEmail").textContent = email || "–";
  $("#userAv").textContent = (email || "?").slice(0, 1).toUpperCase();
  await loadAll();
}

async function boot() {
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
  bindUi();

  const {
    data: { session },
  } = await sb.auth.getSession();

  if (session) await enterApp(session);
  else showGate();

  sb.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_IN" && session) enterApp(session);
    if (event === "SIGNED_OUT") showGate();
  });
}

boot();
