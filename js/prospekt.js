/**
 * AOTO Prospekt — 3-månaders prospektlista för slutkundsleasing.
 *
 * Fristående från CRM: läser prospect_dealers (aggregat från Bilstatistik) och
 * prospect_list (status/ansvarig/anteckning), joinar mot dealer_market_stats
 * för firmografi. Rankar på antal leasingaffärer till företagskund.
 */

import { SUPABASE_URL, SUPABASE_ANON } from "./config.js";
import { bindFloatingTips } from "./floating-tip.js";
import { $, toast, formatOrgNr, escapeHtml, escapeAttr } from "./utils.js";

const PAGE_SIZE = 1000;
const SEARCH_DEBOUNCE_MS = 200;
const FREEZE_SIZE = 100;

const STATUSES = [
  { key: "ny", label: "Ny" },
  { key: "kontaktad", label: "Kontaktad" },
  { key: "bokat_besok", label: "Bokat besök" },
  { key: "besokt", label: "Besökt" },
  { key: "onboardad", label: "Onboardad" },
  { key: "nej", label: "Nej" },
];

const STATUS_LABEL = Object.fromEntries(STATUSES.map((s) => [s.key, s.label]));

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
  showExcluded: false,
  onlyFrozen: false,
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
 * Momentum från de två jämförelsefönstren i prospect_dealers: dag 30–120
 * bakåt mot dag 120–210. Marginalen på 30 dagar finns för att registreringar
 * släpar i Bilstatistik — utan den ser i stort sett alla ÅF ut att tappa.
 * null när underlaget är för tunt för att säga något.
 */
function momentum(dealer) {
  const recent = Number(dealer.deals_recent_90d) || 0;
  const prev = Number(dealer.deals_prev_90d) || 0;
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
  const [dealerRows, listRows, exclusionRows, profileRows, stateRow] = await Promise.all([
    selectAll(
      "prospect_dealers",
      "org_nr, company_name, deals_total, distinct_customers, deals_recent_90d, deals_prev_90d, floorplan_share, finance_company_count, first_tx, last_tx, finance_companies, makes, months, updated_at",
      { column: "deals_total", ascending: false }
    ),
    selectAll(
      "prospect_list",
      "org_nr, frozen_rank, owner_id, status, next_action, next_action_date, note, excluded, excluded_reason, updated_at"
    ),
    selectAll("prospect_exclusions", "id, org_nr, name_pattern, kind, note"),
    selectAll("profiles", "id, email, first_name, last_name, role"),
    sb.from("app_state").select("value, updated_at").eq("key", "prospect_sync").maybeSingle(),
  ]);

  dealers = dealerRows;
  listByOrg = new Map(listRows.map((r) => [r.org_nr, r]));
  exclusions = exclusionRows;
  profiles = profileRows;
  syncMeta = stateRow?.data?.value || null;

  await loadMarketStats(dealers.map((d) => d.org_nr));
  rebuildIndex();
  renderAll();
}

/** Firmografi för de ÅF som finns i listan (adress, omsättning, anställda). */
async function loadMarketStats(orgNrs) {
  statsByOrg = new Map();
  const columns =
    "org_nr, company_name, address, postcode, city, employees, turnover_tkr, profit_tkr, established_year, lagerantal";
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
  if (!filters.showExcluded && row.excluded) return false;
  if (filters.onlyFrozen && !row.list?.frozen_rank) return false;

  const status = row.list?.status || "ny";
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
    case "finance_company_count":
      return row.dealer.finance_company_count ?? -1;
    case "status":
      return STATUSES.findIndex((s) => s.key === (row.list?.status || "ny"));
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
  renderTable();
  renderSubtitle();
}

function renderStats() {
  const active = indexed.filter((r) => !r.excluded);
  const frozen = active.filter((r) => r.list?.frozen_rank);
  const worked = active.filter((r) => r.list && r.list.status && r.list.status !== "ny");
  const booked = active.filter((r) =>
    ["bokat_besok", "besokt", "onboardad"].includes(r.list?.status)
  );

  $("#prospectStats").innerHTML = [
    { label: "I listan", value: active.length },
    { label: "Frysta", value: frozen.length },
    { label: "Påbörjade", value: worked.length },
    { label: "Bokade+", value: booked.length },
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
    const status = row.list?.status || "ny";
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
  const key = status || "ny";
  return `<span class="pill status-${escapeAttr(key)}">${escapeHtml(STATUS_LABEL[key] || key)}</span>`;
}

function ownerHtml(ownerId) {
  if (!ownerId) return '<span class="faint">–</span>';
  const profile = profiles.find((p) => p.id === ownerId);
  if (!profile) return '<span class="faint">–</span>';
  return `<span class="av av-sm has-tip" data-tip="${escapeAttr(personName(profile))}">${escapeHtml(initials(profile))}</span>`;
}

function renderTable() {
  const rows = visibleRows();
  $("#resultCount").textContent = rows.length;
  $("#empty").style.display = rows.length ? "none" : "block";

  $("#prospectRows").innerHTML = rows
    .map((row) => {
      const d = row.dealer;
      const rank = row.list?.frozen_rank || row.rank;
      const city = row.stats?.city || "";
      return `
        <tr data-org="${escapeAttr(d.org_nr)}"${row.excluded ? ' class="row-excluded"' : ""}>
          <td class="num">${rank ?? "–"}</td>
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
    ["Leasingaffärer", fmtNum(d.deals_total)],
    ["Unika slutkunder", fmtNum(d.distinct_customers)],
    ["Senaste 90 dagar", fmtNum(d.deals_recent_90d)],
    ["Föregående 90 dagar", fmtNum(d.deals_prev_90d)],
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
      <h4>Arbetslista</h4>
      <div class="field">
        <label for="pStatus">Status</label>
        <select id="pStatus">
          ${STATUSES.map(
            (st) =>
              `<option value="${st.key}"${(list.status || "ny") === st.key ? " selected" : ""}>${escapeHtml(st.label)}</option>`
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

/** Låser nuvarande topp-N så att listan slutar röra sig mellan synkar. */
async function freezeTop() {
  const ranked = indexed
    .filter((r) => !r.excluded)
    .sort((a, b) => b.dealer.deals_total - a.dealer.deals_total)
    .slice(0, FREEZE_SIZE);

  if (!ranked.length) {
    toast("Ingen data att frysa", { error: true });
    return;
  }

  const now = new Date().toISOString();
  const payload = ranked.map((row, i) => {
    const existing = listByOrg.get(row.dealer.org_nr) || {};
    return {
      ...existing,
      org_nr: row.dealer.org_nr,
      frozen_rank: i + 1,
      status: existing.status || "ny",
      updated_at: now,
    };
  });

  const { data, error } = await sb
    .from("prospect_list")
    .upsert(payload, { onConflict: "org_nr" })
    .select();

  if (error) {
    console.error(error);
    toast(error.message || "Kunde inte frysa listan", { error: true });
    return;
  }

  for (const row of data || []) listByOrg.set(row.org_nr, row);
  rebuildIndex();
  renderAll();
  toast(`Topp ${ranked.length} fryst som arbetslista`);
}

/**
 * Bygger om aggregatet från rådatan som redan ligger i Supabase.
 * Kostar inget Bilstatistik-uttag, så den går att köra hur ofta som helst.
 */
async function runRecompute() {
  const btn = $("#recomputeBtn");
  btn.disabled = true;
  const prevLabel = btn.textContent;
  btn.textContent = "Räknar om…";

  try {
    const { data, error } = await sb.rpc("recompute_prospect_dealers");
    if (error) throw error;
    toast(`Omräknat: ${fmtNum(data?.dealers)} återförsäljare från ${fmtNum(data?.transactions)} affärer`);
    await loadAll();
  } catch (err) {
    console.error(err);
    toast(err.message || "Kunde inte räkna om listan", { error: true });
  } finally {
    btn.disabled = false;
    btn.textContent = prevLabel || "Räkna om";
  }
}

async function runSync() {
  const btn = $("#syncBtn");
  const {
    data: { session },
  } = await sb.auth.getSession();
  if (!session) {
    toast("Du måste vara inloggad", { error: true });
    return;
  }

  btn.disabled = true;
  const prevLabel = btn.textContent;
  btn.textContent = "Synkar…";
  setLoading(true);

  try {
    const res = await fetch("/.netlify/functions/prospect-sync", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + session.access_token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) {
      toast(body.error || "Kunde inte synka Bilstatistik", { error: true });
      return;
    }
    toast(
      `Synk klar: ${fmtNum(body.transactions)} affärer · ${fmtNum(body.dealers)} återförsäljare · period ${body.period?.first_tx} → ${body.period?.last_tx}`
    );
    await loadAll();
  } catch (err) {
    console.error(err);
    toast(err.message || "Kunde inte synka Bilstatistik", { error: true });
  } finally {
    setLoading(false);
    btn.disabled = false;
    btn.textContent = prevLabel || "Synka Bilstatistik";
  }
}

function setLoading(on) {
  const el = $("#marketLoading");
  if (!el) return;
  el.hidden = !on;
  el.setAttribute("aria-hidden", on ? "false" : "true");
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

  $("#pfShowExcluded").addEventListener("change", (e) => {
    filters.showExcluded = e.target.checked;
    renderTable();
  });
  $("#pfOnlyFrozen").addEventListener("change", (e) => {
    filters.onlyFrozen = e.target.checked;
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
      showExcluded: false,
      onlyFrozen: false,
    });
    $("#minDealsSlider").value = "0";
    $("#minDealsVal").textContent = "0";
    $("#pfCity").value = "";
    $("#pfTurnoverMin").value = "";
    $("#pfTurnoverMax").value = "";
    $("#pfShowExcluded").checked = false;
    $("#pfOnlyFrozen").checked = false;
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

  $("#syncBtn").onclick = runSync;
  $("#recomputeBtn").onclick = runRecompute;
  $("#freezeBtn").onclick = freezeTop;
  $("#excludeBtn").onclick = toggleExcluded;
  $("#pClose").onclick = closePanel;
  $("#scrim").onclick = closePanel;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePanel();
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
