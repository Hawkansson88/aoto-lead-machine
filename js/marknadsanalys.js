import { SUPABASE_URL, SUPABASE_ANON } from "./config.js";
import {
  setSupabaseClient,
  sb,
  LEADS,
  setCurrentUserId,
  setCurrentUserEmail,
  currentUserId,
} from "./store.js";
import {
  loadLeads,
  loadProfiles,
  loadUserProfile,
  loadDealerMarketStats,
  loadLeadActivity,
  loadUserSettings,
  saveUserSettings,
  leadActivity,
} from "./data.js";
import { openPanel, openProspectPanel, closePanel } from "./panel.js";
import { bindPanelChrome } from "./events.js";
import { bindCustomerModal, closeCustomerModal } from "./customer-modal.js";
import { bindAssignModal, closeAssignModal } from "./assign.js";
import { bindSettingsModal, closeSettings } from "./settings-modal.js";
import { scoreMarketBreakdown } from "./scoring.js";
import { bindFloatingTips } from "./floating-tip.js";
import { assigneeBadgeHtml } from "./assignees.js";
import { $, toast, formatOrgNr, normalizeOrgNr, escapeHtml, escapeAttr, scoreColor } from "./utils.js";

const PAGE_SIZE = 1000;
const SEARCH_DEBOUNCE_MS = 200;
/** Legacy browser key — cleared after moving filters to user_settings */
const MARKET_FILTERS_KEY = "aoto_market_filters";

/** @typedef {{ min: number|null, max: number|null }} RangeFilter */

const EMPTY_RANGE = () => ({ min: null, max: null });

/** @type {{
 *   leadMode: "alla"|"lead"|"ej_lead"|"historik"|"notes",
 *   minScore: number,
 *   turnover: RangeFilter,
 *   profit: RangeFilter,
 *   year: RangeFilter,
 *   employees: RangeFilter,
 *   lager: RangeFilter,
 *   finance: RangeFilter,
 *   sales: RangeFilter,
 *   foretag: RangeFilter,
 * }} */
const marketFilterState = {
  leadMode: "alla",
  minScore: 0,
  turnover: EMPTY_RANGE(),
  profit: EMPTY_RANGE(),
  year: EMPTY_RANGE(),
  employees: EMPTY_RANGE(),
  lager: EMPTY_RANGE(),
  finance: EMPTY_RANGE(),
  sales: EMPTY_RANGE(),
  foretag: EMPTY_RANGE(),
};

const RANGE_KEYS = [
  "turnover",
  "profit",
  "year",
  "employees",
  "lager",
  "finance",
  "sales",
  "foretag",
];

/** @type {Array<Record<string, unknown>>} */
let rows = [];
/** @type {Array<{row: Record<string, unknown>, hay: string, foretagsandel: number|null, financeTip: string, score: number}>} */
let indexed = [];
let sortKey = "score";
let sortDir = -1;
let query = "";
let searchTimer = 0;
let rowsBound = false;
let panelChromeBound = false;
let filtersBound = false;

function showApp() {
  $("#app").style.display = "grid";
  $("#authGate").classList.remove("show");
}

function showGate() {
  $("#app").style.display = "none";
  $("#authGate").classList.add("show");
  closePanel();
  closeCustomerModal();
  closeAssignModal();
  closeSettings();
  resetMarketFilterState();
}

function setUserChrome(email) {
  $("#userEmail").textContent = email || "–";
  $("#userAv").textContent = (email || "?").slice(0, 1).toUpperCase();
}

function fmtNum(value) {
  if (value == null || value === "") return "–";
  const n = Number(value);
  if (!Number.isFinite(n)) return "–";
  return n.toLocaleString("sv-SE");
}

/** Bilstatistik tkr → MSEK for list columns */
function fmtTkrAsMsek(tkr) {
  if (tkr == null || tkr === "") return "–";
  const n = Number(tkr);
  if (!Number.isFinite(n)) return "–";
  return (n / 1000).toLocaleString("sv-SE", { maximumFractionDigits: 1 });
}

function fmtYear(value) {
  if (value == null || value === "") return "–";
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1800) return "–";
  return String(Math.round(n));
}

function fmtPctRatio(value) {
  if (value == null || value === "") return "–";
  const n = Number(value);
  if (!Number.isFinite(n)) return "–";
  const pct = n > 0 && n <= 1 ? n * 100 : n;
  return pct.toLocaleString("sv-SE", { maximumFractionDigits: 0 }) + " %";
}

function foretagsAndel(r) {
  const privat = Number(r.salj_privat_12m);
  const foretag = Number(r.salj_foretag_12m);
  if (Number.isFinite(privat) && Number.isFinite(foretag)) {
    const splitTotal = privat + foretag;
    if (splitTotal <= 0) return null;
    return foretag / splitTotal;
  }
  const total = Number(r.saljvolym_12m);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(foretag)) return null;
  return foretag / total;
}

function financeTip(list) {
  if (!Array.isArray(list) || !list.length) return "Ingen lagerfinansiering registrerad";
  return list.map((x) => `${x.name}: ${fmtNum(x.count)}`).join("\n");
}

function fmtUpdatedAt(iso) {
  if (!iso) return "–";
  return new Date(iso).toLocaleDateString("sv-SE", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function sortValue(item) {
  if (sortKey === "score") return item.score;
  if (sortKey === "foretagsandel") return item.foretagsandel;
  return item.row[sortKey];
}

function rebuildIndex() {
  indexed = rows.map((row) => {
    const andel = foretagsAndel(row);
    const { total } = scoreMarketBreakdown(row, andel);
    return {
      row,
      hay: `${String(row.company_name || "").toLowerCase()} ${String(row.city || "").toLowerCase()} ${String(row.org_nr || "")}`,
      foretagsandel: andel,
      financeTip: financeTip(row.lager_finansbolag),
      score: total ?? 0,
    };
  });
  sortIndexed();
}

function sortIndexed() {
  indexed.sort((a, b) => {
    let x = sortValue(a);
    let y = sortValue(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === "string") x = x.toLowerCase();
    if (typeof y === "string") y = y.toLowerCase();
    if (x < y) return -1 * sortDir;
    if (x > y) return 1 * sortDir;
    return 0;
  });
}

function parseBound(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function hasBound(range) {
  return range.min != null || range.max != null;
}

/** Exclude missing values when any bound is set. */
function inRange(value, range) {
  if (!hasBound(range)) return true;
  if (value == null || !Number.isFinite(value)) return false;
  if (range.min != null && value < range.min) return false;
  if (range.max != null && value > range.max) return false;
  return true;
}

/** Ratio 0–1 or already percent → percent for filter compare. */
function asPct(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n > 0 && n <= 1 ? n * 100 : n;
}

function tkrToMkr(tkr) {
  if (tkr == null || tkr === "") return null;
  const n = Number(tkr);
  if (!Number.isFinite(n)) return null;
  return n / 1000;
}

function numOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readFiltersFromDom() {
  document.querySelectorAll("#marketFilters input[data-filter]").forEach((input) => {
    const key = input.dataset.filter;
    const bound = input.dataset.bound;
    if (!RANGE_KEYS.includes(key) || (bound !== "min" && bound !== "max")) return;
    marketFilterState[key][bound] = parseBound(input.value);
  });
}

function writeFiltersToDom() {
  document.querySelectorAll("#marketFilters input[data-filter]").forEach((input) => {
    const key = input.dataset.filter;
    const bound = input.dataset.bound;
    if (!RANGE_KEYS.includes(key) || (bound !== "min" && bound !== "max")) return;
    const v = marketFilterState[key][bound];
    input.value = v == null ? "" : String(v);
  });
  document.querySelectorAll("#marketLeadFilter .status-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.lead === marketFilterState.leadMode);
  });
  const slider = $("#scoreSlider");
  const scoreVal = $("#scoreVal");
  if (slider) {
    slider.value = String(marketFilterState.minScore);
    slider.style.setProperty("--p", marketFilterState.minScore + "%");
  }
  if (scoreVal) scoreVal.textContent = String(marketFilterState.minScore);
}

function marketFilterPayload() {
  const payload = {
    leadMode: marketFilterState.leadMode,
    minScore: marketFilterState.minScore,
  };
  for (const key of RANGE_KEYS) {
    payload[key] = { ...marketFilterState[key] };
  }
  return payload;
}

function resetMarketFilterState() {
  marketFilterState.leadMode = "alla";
  marketFilterState.minScore = 0;
  for (const key of RANGE_KEYS) {
    marketFilterState[key] = EMPTY_RANGE();
  }
}

function applyMarketFilterPayload(saved) {
  if (!saved || typeof saved !== "object") return;
  if (
    saved.leadMode === "alla" ||
    saved.leadMode === "lead" ||
    saved.leadMode === "ej_lead" ||
    saved.leadMode === "historik" ||
    saved.leadMode === "notes"
  ) {
    marketFilterState.leadMode = saved.leadMode;
  }
  if (saved.minScore != null && Number.isFinite(Number(saved.minScore))) {
    marketFilterState.minScore = Math.max(0, Math.min(100, Number(saved.minScore)));
  }
  for (const key of RANGE_KEYS) {
    const r = saved[key];
    if (!r || typeof r !== "object") continue;
    marketFilterState[key] = {
      min: parseBound(r.min),
      max: parseBound(r.max),
    };
  }
}

function readLegacyMarketFilters() {
  try {
    const raw = localStorage.getItem(MARKET_FILTERS_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    return saved && typeof saved === "object" ? saved : null;
  } catch {
    return null;
  }
}

function clearLegacyMarketFilters() {
  try {
    localStorage.removeItem(MARKET_FILTERS_KEY);
  } catch {
    /* ignore */
  }
}

function resetMarketFilters() {
  resetMarketFilterState();
  writeFiltersToDom();
  renderMarketTable();
}

async function saveMarketFilters() {
  if (!currentUserId) {
    toast("Du måste vara inloggad");
    return;
  }
  readFiltersFromDom();
  const payload = marketFilterPayload();
  const ok = await saveUserSettings(currentUserId, { market: payload });
  clearLegacyMarketFilters();
  if (ok) {
    const msg = $("#marketFilterSavedMsg");
    if (msg) {
      msg.classList.add("show");
      window.setTimeout(() => msg.classList.remove("show"), 1800);
    }
  } else {
    toast("Kunde inte spara filter");
  }
}

/**
 * Load market filters from user_settings.
 * One-time: if profile has no market filters, adopt legacy localStorage then persist to profile.
 */
async function loadMarketFiltersFromSettings(userId, filters) {
  resetMarketFilterState();
  let market = filters?.market || null;
  const legacy = !market ? readLegacyMarketFilters() : null;
  if (!market && legacy) {
    market = legacy;
    await saveUserSettings(userId, { market });
  }
  if (market) applyMarketFilterPayload(market);
  clearLegacyMarketFilters();
  writeFiltersToDom();
}

function visibleIndexed() {
  const q = query.trim().toLowerCase();
  const digits = q.replace(/\D/g, "");
  const leadsByOrg = marketFilterState.leadMode === "alla" ? null : leadByOrgMap();

  return indexed.filter((item) => {
    if (q) {
      const match =
        item.hay.includes(q) || (digits.length >= 2 && item.hay.includes(digits));
      if (!match) return false;
    }

    if (leadsByOrg) {
      const org = normalizeOrgNr(item.row.org_nr);
      const lead = org ? leadsByOrg.get(org) : null;
      const isLead = isPipelineLead(lead);
      const mode = marketFilterState.leadMode;
      if (mode === "lead" && !isLead) return false;
      if (mode === "ej_lead" && lead) return false;
      if (mode === "historik" && !lead) return false;
      if (mode === "notes" && noteCountForLead(lead) <= 0) return false;
    }

    const r = item.row;
    if (!inRange(tkrToMkr(r.turnover_tkr), marketFilterState.turnover)) return false;
    if (!inRange(tkrToMkr(r.profit_tkr), marketFilterState.profit)) return false;
    if (!inRange(numOrNull(r.established_year), marketFilterState.year)) return false;
    if (!inRange(numOrNull(r.employees), marketFilterState.employees)) return false;
    if (!inRange(numOrNull(r.lagerantal), marketFilterState.lager)) return false;
    if (!inRange(asPct(r.lager_finansierat_andel), marketFilterState.finance)) return false;
    if (!inRange(numOrNull(r.saljvolym_12m), marketFilterState.sales)) return false;
    if (!inRange(asPct(item.foretagsandel), marketFilterState.foretag)) return false;
    if (marketFilterState.minScore > 0 && (item.score ?? 0) < marketFilterState.minScore) return false;

    return true;
  });
}

function updateSortArrows() {
  document.querySelectorAll(".market-table-head thead th .ar").forEach((a) => a.remove());
  const th = document.querySelector(`.market-table-head thead th[data-sort="${sortKey}"]`);
  if (!th) return;
  const arrow = document.createElement("span");
  arrow.className = "ar";
  arrow.textContent = sortDir > 0 ? "▲" : "▼";
  th.appendChild(arrow);
}

function isPipelineLead(lead) {
  return !!(lead && lead.assigned_to);
}

function noteCountForLead(lead) {
  if (!lead?.id) return 0;
  return leadActivity.noteCountByLeadId.get(String(lead.id)) || 0;
}

function leadByOrgMap() {
  const map = new Map();
  for (const lead of LEADS) {
    const org = normalizeOrgNr(lead.org_nr);
    if (org) map.set(org, lead);
  }
  return map;
}

function leadListMetaHtml(lead) {
  if (!lead) return "";
  const parts = [];

  if (isPipelineLead(lead)) {
    parts.push(`<span class="badge-lead" title="Tilldelad lead i CRM">Lead</span>`);
    parts.push(assigneeBadgeHtml(lead.assigned_to, { emptyLabel: true }));
  } else if (lead) {
    // Unassigned CRM row = previously in pipeline
    parts.push(
      `<span class="badge-history" title="Finns i CRM sedan tidigare (otilldelad)">Tidigare</span>`
    );
  }

  const notes = noteCountForLead(lead);
  if (notes > 0) {
    parts.push(
      `<span class="badge-notes" title="${notes} notering${notes === 1 ? "" : "ar"}">📝 ${notes}</span>`
    );
  }

  return parts.join("");
}

function renderMarketTable() {
  const list = visibleIndexed();
  $("#resultCount").textContent = String(list.length);

  const tbody = $("#marketRows");
  const empty = $("#empty");
  empty.style.display = list.length ? "none" : "block";
  empty.textContent = rows.length
    ? "Inga företag matchar filter/sökning."
    : "Ingen data ännu — uppdatera marknadsdata.";

  const leadsByOrg = leadByOrgMap();
  const parts = new Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const { row: r, foretagsandel: andel, financeTip: tip, score } = list[i];
    const org = normalizeOrgNr(r.org_nr) || String(r.org_nr || "");
    const leadMeta = leadListMetaHtml(leadsByOrg.get(org));
    const financePct = fmtPctRatio(r.lager_finansierat_andel);
    const hasFinanceTip = financePct !== "–";
    const financeCell = hasFinanceTip
      ? `<td class="right num tip-cell" title="${escapeAttr(tip)}">${financePct}</td>`
      : `<td class="right num">${financePct}</td>`;
    const color = scoreColor(score);
    parts[i] = `<tr data-org="${escapeAttr(org)}">
        <td>
          <div class="score-cell">
            <span class="score-num" style="color:${color}">${score}</span>
            <div class="score-bar"><span class="score-fill" style="width:${score}%;background:${color}"></span></div>
          </div>
        </td>
        <td>
          <div class="co-name">${escapeHtml(String(r.company_name || "–"))}${leadMeta}</div>
          <div class="co-org num">${escapeHtml(formatOrgNr(org) || org || "–")}${
            r.city ? ` · ${escapeHtml(String(r.city))}` : ""
          }</div>
        </td>
        <td class="right num">${fmtTkrAsMsek(r.turnover_tkr)}</td>
        <td class="right num">${fmtTkrAsMsek(r.profit_tkr)}</td>
        <td class="right num">${fmtYear(r.established_year)}</td>
        <td class="right num">${fmtNum(r.employees)}</td>
        <td class="right num">${fmtNum(r.lagerantal)}</td>
        ${financeCell}
        <td class="right num">${fmtNum(r.saljvolym_12m)}</td>
        <td class="right num">${fmtPctRatio(andel)}</td>
      </tr>`;
  }
  tbody.innerHTML = parts.join("");
  updateSortArrows();
}

function scheduleSearchRender() {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    renderMarketTable();
  }, SEARCH_DEBOUNCE_MS);
}

async function refreshMarketRow(orgNr) {
  const digits = normalizeOrgNr(orgNr);
  if (!digits) return;
  const stats = await loadDealerMarketStats(digits);
  if (!stats) return;
  const idx = rows.findIndex((r) => normalizeOrgNr(r.org_nr) === digits);
  if (idx >= 0) rows[idx] = { ...rows[idx], ...stats };
  else rows.push(stats);
  rebuildIndex();
  renderMarketTable();
}

async function openDealer(org) {
  if (!org) {
    toast("Saknar organisationsnummer");
    return;
  }
  const digits = normalizeOrgNr(org);
  const marketRow = rows.find((r) => normalizeOrgNr(r.org_nr) === digits) || null;
  const lead = LEADS.find((l) => normalizeOrgNr(l.org_nr) === digits);

  if (isPipelineLead(lead)) {
    await openPanel(lead.id);
    return;
  }
  if (!marketRow) {
    toast("Ingen marknadsdata för bolaget");
    return;
  }
  await openProspectPanel(marketRow, { existingLead: lead || null });
}

function bindFilters() {
  if (filtersBound) return;
  filtersBound = true;

  const filtersEl = $("#marketFilters");
  if (filtersEl) {
    filtersEl.addEventListener("input", (e) => {
      const input = e.target.closest("input[data-filter]");
      if (!input) return;
      const key = input.dataset.filter;
      const bound = input.dataset.bound;
      if (!RANGE_KEYS.includes(key) || (bound !== "min" && bound !== "max")) return;
      marketFilterState[key][bound] = parseBound(input.value);
      renderMarketTable();
    });
  }

  const leadList = $("#marketLeadFilter");
  if (leadList) {
    leadList.addEventListener("click", (e) => {
      const item = e.target.closest(".status-item[data-lead]");
      if (!item) return;
      const mode = item.dataset.lead;
      if (
        mode !== "alla" &&
        mode !== "lead" &&
        mode !== "ej_lead" &&
        mode !== "historik" &&
        mode !== "notes"
      )
        return;
      marketFilterState.leadMode = mode;
      leadList.querySelectorAll(".status-item").forEach((el) => {
        el.classList.toggle("active", el === item);
      });
      renderMarketTable();
    });
  }

  const saveBtn = $("#saveMarketFiltersBtn");
  if (saveBtn) saveBtn.onclick = saveMarketFilters;
  const clearBtn = $("#clearMarketFiltersBtn");
  if (clearBtn) clearBtn.onclick = resetMarketFilters;

  const scoreSlider = $("#scoreSlider");
  if (scoreSlider) {
    scoreSlider.addEventListener("input", (e) => {
      marketFilterState.minScore = +e.target.value;
      const scoreVal = $("#scoreVal");
      if (scoreVal) scoreVal.textContent = e.target.value;
      e.target.style.setProperty("--p", e.target.value + "%");
      renderMarketTable();
    });
  }
}

function bindSort() {
  document.querySelectorAll(".market-table-head thead th[data-sort]").forEach((th) => {
    th.onclick = () => {
      const key = th.dataset.sort;
      if (sortKey === key) sortDir *= -1;
      else {
        sortKey = key;
        sortDir = -1;
      }
      sortIndexed();
      renderMarketTable();
    };
  });
}

async function fetchAllMarketStats() {
  const select =
    "org_nr, company_name, address, postcode, city, industry, employees, established_year, turnover_tkr, equity_tkr, profit_tkr, lagerantal, saljvolym_12m, salj_privat_12m, salj_foretag_12m, lager_finansierat_antal, lager_finansierat_andel, lager_finansbolag, bulk_updated_at, updated_at";
  const all = [];
  let from = 0;

  for (;;) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await sb
      .from("dealer_market_stats")
      .select(select)
      .order("lagerantal", { ascending: false, nullsFirst: false })
      .range(from, to);

    if (error) throw error;
    const batch = data || [];
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return all;
}

async function loadMarketStats() {
  try {
    rows = await fetchAllMarketStats();
  } catch (error) {
    console.warn("Kunde inte läsa dealer_market_stats", error);
    rows = [];
    $("#dataUpdated").textContent = " · Data uppdaterad: –";
    rebuildIndex();
    renderMarketTable();
    if (error?.code !== "PGRST205" && error?.code !== "42P01") {
      toast("Kunde inte hämta marknadsdata");
    }
    return;
  }

  let latest = null;
  for (const r of rows) {
    const ts = r.bulk_updated_at || r.updated_at;
    if (!ts) continue;
    if (!latest || ts > latest) latest = ts;
  }
  $("#dataUpdated").textContent = ` · Data uppdaterad: ${fmtUpdatedAt(latest)}`;
  rebuildIndex();
  renderMarketTable();
}

const MARKET_LOADING_LINES = [
  "Hämtar data på cirka en halv miljon bilar — chilla bror.",
  "Räknar lager, sälj och privat/företag…",
  "Bilstatistik levererar — vi sitter och väntar elegant.",
  "Snart klart. Kaffe? Eller bara chilla.",
];

let loadingLineTimer = 0;
let loadingLineIndex = 0;

function setMarketLoading(on) {
  const el = $("#marketLoading");
  if (!el) return;
  window.clearInterval(loadingLineTimer);
  loadingLineTimer = 0;

  if (!on) {
    el.hidden = true;
    el.setAttribute("aria-hidden", "true");
    return;
  }

  loadingLineIndex = 0;
  const title = $("#marketLoadingTitle");
  if (title) title.textContent = MARKET_LOADING_LINES[0];
  el.hidden = false;
  el.setAttribute("aria-hidden", "false");

  loadingLineTimer = window.setInterval(() => {
    const titleEl = $("#marketLoadingTitle");
    if (!titleEl) return;
    titleEl.classList.add("is-swap");
    window.setTimeout(() => {
      loadingLineIndex = (loadingLineIndex + 1) % MARKET_LOADING_LINES.length;
      titleEl.textContent = MARKET_LOADING_LINES[loadingLineIndex];
      titleEl.classList.remove("is-swap");
    }, 220);
  }, 3200);
}

async function refreshMarketBulk() {
  const btn = $("#refreshMarketBtn");
  if (!btn) return;

  const {
    data: { session },
  } = await sb.auth.getSession();
  if (!session) {
    toast("Du måste vara inloggad");
    return;
  }

  btn.disabled = true;
  const prevLabel = btn.textContent;
  setMarketLoading(true);
  try {
    const res = await fetch("/.netlify/functions/bilstatistik-market-bulk", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + session.access_token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) {
      toast(body.error || "Kunde inte uppdatera marknadsdata", { error: true });
      return;
    }
    const stock = fmtNum(body.stock_imported ?? body.imported);
    const sales = fmtNum(body.sales_updated);
    const split = fmtNum(body.sales_split_updated);
    toast(
      `Marknadsdata uppdaterad: ${stock} handlare · ${sales} sälj ≥20 · ${split} med privat/företag`
    );
    await loadMarketStats();
  } catch (err) {
    console.error(err);
    toast(err.message || "Kunde inte uppdatera marknadsdata", { error: true });
  } finally {
    setMarketLoading(false);
    btn.disabled = false;
    btn.textContent = prevLabel || "Uppdatera marknadsdata";
  }
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
  const email = session?.user?.email || "";
  setCurrentUserId(session.user.id);
  setCurrentUserEmail(email);
  setUserChrome(email);

  await loadUserProfile(session.user.id, email);
  const settings = await loadUserSettings(session.user.id);
  await loadMarketFiltersFromSettings(session.user.id, settings);
  await Promise.all([loadLeads(), loadProfiles(), loadLeadActivity(), loadMarketStats()]);
}

function bindUi() {
  $("#authBtn").onclick = doLogin;
  $("#authPw").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLogin();
  });
  $("#authEmail").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#authPw").focus();
  });
  $("#logoutBtn").onclick = () => sb.auth.signOut();
  $("#search").addEventListener("input", (e) => {
    query = e.target.value || "";
    scheduleSearchRender();
  });
  const refreshBtn = $("#refreshMarketBtn");
  if (refreshBtn) refreshBtn.onclick = refreshMarketBulk;

  if (!panelChromeBound) {
    bindPanelChrome();
    bindCustomerModal();
    bindAssignModal();
    bindSettingsModal({
      userId: () => currentUserId,
      onSaved: () => {
        rebuildIndex();
        renderMarketTable();
      },
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      closePanel();
      closeCustomerModal();
      closeAssignModal();
      closeSettings();
    });
    window.addEventListener("dealer-market-stats-updated", (e) => {
      refreshMarketRow(e.detail?.org_nr);
    });
    window.addEventListener("crm-lead-changed", async () => {
      await loadLeadActivity();
      renderMarketTable();
    });
    window.addEventListener("crm-notes-changed", async () => {
      await loadLeadActivity();
      renderMarketTable();
    });
    panelChromeBound = true;
  }

  if (!rowsBound) {
    $("#marketRows").addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-org]");
      if (!tr) return;
      openDealer(tr.dataset.org);
    });
    rowsBound = true;
  }

  bindSort();
  bindFilters();
  bindFloatingTips();
}

async function boot() {
  setSupabaseClient(window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON));
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
