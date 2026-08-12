import { scoreBreakdown, normalizeScoringConfig } from "./scoring.js";
import {
  filterState,
  sb,
  LEADS,
  setLeads,
  setScoringConfig,
  setProfiles,
  currentUserId,
  setCurrentUserProfile,
} from "./store.js";
import { $, msekToSek, normalizeOrgNr, parseCityFromPostalAddress, parseEmployees } from "./utils.js";

const SHOW_ALL_KEY = "aoto_show_all_leads";

export function loadShowAllPreference() {
  filterState.showAllLeads = false;
  try {
    sessionStorage.removeItem(SHOW_ALL_KEY);
  } catch {
    /* ignore */
  }
}

export function setShowAllLeads() {
  filterState.showAllLeads = false;
}

// --- Profiles ---

export async function loadProfiles() {
  const { data, error } = await sb
    .from("profiles")
    .select("id, email, first_name, last_name, full_name, role")
    .order("first_name", { ascending: true });

  if (error) {
    // full_name may not exist — retry without it
    const fallback = await sb
      .from("profiles")
      .select("id, email, first_name, last_name, role")
      .order("first_name", { ascending: true });
    if (fallback.error) {
      console.warn("Kunde inte läsa profiles", fallback.error);
      setProfiles([]);
      return [];
    }
    setProfiles(fallback.data || []);
    return fallback.data || [];
  }

  setProfiles(data || []);
  return data || [];
}

export async function loadUserProfile(userId, email) {
  const { data, error } = await sb.from("profiles").select("*").eq("id", userId).maybeSingle();

  if (error) {
    console.warn("Kunde inte läsa profil — kör supabase/roles_credit.sql", error);
  }

  if (data) {
    setCurrentUserProfile({
      role: data.role || "saljare",
      firstName: data.first_name || "",
      lastName: data.last_name || "",
    });
    return data;
  }

  // Skapa profil om den saknas (t.ex. innan migration körts klart)
  const firstName = (email || "").split("@")[0] || "Användare";
  const row = {
    id: userId,
    email: email || "",
    first_name: firstName,
    last_name: "",
    role: "saljare",
    updated_at: new Date().toISOString(),
  };
  const { data: created } = await sb.from("profiles").upsert(row).select().maybeSingle();
  setCurrentUserProfile({
    role: created?.role || "saljare",
    firstName: created?.first_name || firstName,
    lastName: created?.last_name || "",
  });
  return created || row;
}

// --- User settings ---

export async function loadUserSettings(userId) {
  const { data } = await sb.from("user_settings").select("filters").eq("user_id", userId).maybeSingle();
  if (!data) return {};

  const filters = data.filters || {};

  // DNB/score-filter sparas inte längre i UI — nollställ ev. gamla sparade värden
  filterState.dnb = "alla";
  filterState.minScore = 0;
  filterState.revMin = null;
  filterState.revMax = null;

  if (filters.scoring) {
    setScoringConfig(normalizeScoringConfig(filters.scoring));
  }

  return filters;
}

export async function saveUserSettings(userId, patch) {
  const { data: existing } = await sb
    .from("user_settings")
    .select("filters")
    .eq("user_id", userId)
    .maybeSingle();

  const merged = { ...(existing?.filters || {}), ...patch };
  const { error } = await sb.from("user_settings").upsert({
    user_id: userId,
    filters: merged,
    updated_at: new Date().toISOString(),
  });

  return !error;
}

// --- Leads ---

export async function loadLeads() {
  const [leadsRes, dnbRes] = await Promise.all([
    sb.from("leads").select("*"),
    sb.from("dnb_customers").select("lead_id"),
  ]);

  if (leadsRes.error) throw leadsRes.error;
  if (dnbRes.error) {
    console.warn("Kunde inte läsa dnb_customers — kör supabase/dnb_customers.sql i Supabase", dnbRes.error);
  }

  const dnbIds = new Set((dnbRes.data || []).map((row) => row.lead_id));
  setLeads(
    leadsRes.data.map((row) => ({
      ...row,
      is_dnb: dnbIds.has(row.id),
      score: scoreBreakdown(row).total,
    }))
  );
}

/** Note/contact counts per lead_id for Marknadsanalys historik-badges. */
export let leadActivity = {
  /** @type {Map<string, number>} */
  noteCountByLeadId: new Map(),
  /** @type {Map<string, number>} */
  contactCountByLeadId: new Map(),
};

function countByLeadId(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const id = String(row.lead_id);
    map.set(id, (map.get(id) || 0) + 1);
  }
  return map;
}

export async function loadLeadActivity() {
  const [notesRes, contactsRes] = await Promise.all([
    sb.from("lead_notes").select("lead_id"),
    sb.from("lead_contacts").select("lead_id"),
  ]);

  if (notesRes.error) {
    console.warn("Kunde inte läsa lead_notes för historik", notesRes.error);
    leadActivity.noteCountByLeadId = new Map();
  } else {
    leadActivity.noteCountByLeadId = countByLeadId(notesRes.data);
  }

  if (contactsRes.error) {
    console.warn("Kunde inte läsa lead_contacts för historik", contactsRes.error);
    leadActivity.contactCountByLeadId = new Map();
  } else {
    leadActivity.contactCountByLeadId = countByLeadId(contactsRes.data);
  }

  return leadActivity;
}

export function bumpLeadNoteCount(leadId, delta = 1) {
  if (leadId == null) return;
  const key = String(leadId);
  const next = (leadActivity.noteCountByLeadId.get(key) || 0) + delta;
  if (next <= 0) leadActivity.noteCountByLeadId.delete(key);
  else leadActivity.noteCountByLeadId.set(key, next);
}

export async function bulkUpdateStatus(ids, status) {
  if (!ids.length) return true;
  const fields = { status, updated_at: new Date().toISOString() };
  const { error } = await sb.from("leads").update(fields).in("id", ids);
  if (error) {
    console.error(error);
    return false;
  }

  if (status === "ejaktuell") {
    const skipAt = new Date().toISOString();
    const { error: skipErr } = await sb
      .from("leads")
      .update({ enriched_at: skipAt })
      .in("id", ids)
      .is("enriched_at", null);
    if (skipErr) console.error(skipErr);
    else {
      ids.forEach((id) => {
        const lead = LEADS.find((l) => l.id === id);
        if (lead && !lead.enriched_at) lead.enriched_at = skipAt;
      });
    }
  }

  return true;
}

export async function bulkFlagDnb(ids, userId) {
  if (!ids.length) return true;
  const rows = ids.map((lead_id) => ({
    lead_id,
    created_by: userId,
    created_at: new Date().toISOString(),
  }));
  const { error } = await sb.from("dnb_customers").upsert(rows, { onConflict: "lead_id" });
  if (error) console.error(error);
  return !error;
}

export async function bulkUnflagDnb(ids) {
  if (!ids.length) return true;
  const { error } = await sb.from("dnb_customers").delete().in("lead_id", ids);
  if (error) console.error(error);
  return !error;
}

export async function assignLeads(ids, assignedTo) {
  if (!ids.length) return true;
  const { error } = await sb
    .from("leads")
    .update({
      assigned_to: assignedTo,
      updated_at: new Date().toISOString(),
    })
    .in("id", ids);
  if (error) console.error(error);
  return !error;
}

/** Remove from sales pipeline (keep lead + notes). Last-wins when reclaiming. */
export async function bulkUnassignLeads(ids) {
  return assignLeads(ids, null);
}

export async function patchLead(id, fields) {
  const payload = { ...fields };
  if (fields.status === "ejaktuell") {
    const lead = LEADS.find((l) => l.id === id);
    if (lead && !lead.enriched_at) payload.enriched_at = new Date().toISOString();
  }
  const { error } = await sb.from("leads").update(payload).eq("id", id);
  if (error) console.error(error);
  return !error;
}

export function refreshLeadScores() {
  setLeads(LEADS.map((lead) => ({ ...lead, score: scoreBreakdown(lead).total })));
}

function isUniqueViolation(error) {
  return error?.code === "23505";
}

async function findDuplicateOrgNr(orgNr, excludeId = null) {
  const local = LEADS.find((l) => l.org_nr === orgNr && l.id !== excludeId);
  if (local) return local;

  let query = sb.from("leads").select("id, company_name").eq("org_nr", orgNr);
  if (excludeId != null) query = query.neq("id", excludeId);
  const { data } = await query.maybeSingle();
  return data;
}

async function geocodeLeadAddress(address, postal_address, city) {
  const addressTrim = address?.trim() || null;
  const postalTrim = postal_address?.trim() || null;
  if (!addressTrim && !postalTrim) return { lat: null, lng: null, geocoded: false };

  try {
    const geo = await callNetlifyFunction("geocode", {
      address: addressTrim,
      postal_address: postalTrim,
      city,
    });
    if (geo.success && geo.lat != null) {
      return { lat: geo.lat, lng: geo.lng, geocoded: true };
    }
  } catch (err) {
    console.warn("Geocoding misslyckades:", err);
  }
  return { lat: null, lng: null, geocoded: false };
}

function parseLeadFormInput(fields) {
  const orgNr = normalizeOrgNr(fields.org_nr);
  if (!fields.company_name?.trim()) return { error: "Ange företagsnamn." };
  if (!orgNr) return { error: "Organisationsnummer måste vara 10 siffror." };

  const addressTrim = fields.address?.trim() || null;
  const postalTrim = fields.postal_address?.trim() || null;

  return {
    row: {
      company_name: fields.company_name.trim(),
      org_nr: orgNr,
      revenue: msekToSek(fields.revenue),
      result_after_fin: msekToSek(fields.result_after_fin),
      equity: msekToSek(fields.equity),
      solidity: fields.solidity !== "" && fields.solidity != null ? Number(fields.solidity) : null,
      employees: parseEmployees(fields.employees),
      address: addressTrim,
      postal_address: postalTrim,
      city: parseCityFromPostalAddress(postalTrim),
    },
    addressTrim,
    postalTrim,
  };
}

function upsertLeadInStore(data, isNew) {
  const lead = { ...data, is_dnb: data.is_dnb ?? false, score: scoreBreakdown(data).total };
  if (isNew) {
    setLeads([...LEADS, lead]);
  } else {
    setLeads(
      LEADS.map((l) =>
        l.id === lead.id ? { ...lead, is_dnb: l.is_dnb, score: scoreBreakdown(data).total } : l
      )
    );
  }
  return lead;
}

export async function createLead(fields, { assignedTo } = {}) {
  const parsed = parseLeadFormInput(fields);
  if (parsed.error) return { error: parsed.error };

  const duplicate = await findDuplicateOrgNr(parsed.row.org_nr);
  if (duplicate) {
    return { error: `En handlare med detta org.nr finns redan (${duplicate.company_name}).` };
  }

  const { lat, lng, geocoded } = await geocodeLeadAddress(
    parsed.addressTrim,
    parsed.postalTrim,
    parsed.row.city
  );

  const now = new Date().toISOString();
  const assignee =
    assignedTo !== undefined ? assignedTo : currentUserId || null;
  const row = {
    ...parsed.row,
    lat,
    lng,
    status: "ny",
    enriched_at: now,
    updated_at: now,
    assigned_to: assignee,
  };

  // Prefer explicit city from market data when provided
  if (fields.city?.trim()) {
    row.city = fields.city.trim();
  }

  const { data, error } = await sb.from("leads").insert(row).select().single();
  if (error) {
    console.error(error);
    if (isUniqueViolation(error)) {
      return { error: "En handlare med detta org.nr finns redan." };
    }
    return { error: "Kunde inte skapa handlare. Kontrollera att SQL-migrationen körts." };
  }

  const lead = upsertLeadInStore(data, true);
  return { data: lead, geocoded };
}

/** Bilstatistik tkr → MSEK string for createLead form parser */
function tkrToMsekInput(tkr) {
  if (tkr == null || tkr === "") return "";
  const n = Number(tkr);
  if (!Number.isFinite(n)) return "";
  // 1 tkr = 1 000 SEK = 0.001 MSEK
  const msek = n / 1000;
  return String(Number(msek.toFixed(3)));
}

/** Create a CRM lead from a dealer_market_stats row (Marknadsanalys). */
export async function createLeadFromMarket(stats, assignedTo) {
  if (!stats) return { error: "Saknar marknadsdata." };
  const orgNr = normalizeOrgNr(stats.org_nr);
  if (!orgNr) return { error: "Saknar giltigt organisationsnummer." };
  if (!stats.company_name?.trim()) return { error: "Saknar företagsnamn." };

  const postal = [stats.postcode, stats.city].filter(Boolean).join(" ").trim();

  return createLead(
    {
      company_name: String(stats.company_name).trim(),
      org_nr: orgNr,
      address: stats.address ? String(stats.address) : "",
      postal_address: postal,
      city: stats.city ? String(stats.city) : "",
      revenue: tkrToMsekInput(stats.turnover_tkr),
      result_after_fin: tkrToMsekInput(stats.profit_tkr),
      equity: tkrToMsekInput(stats.equity_tkr),
      solidity: "",
      employees: stats.employees ?? "",
    },
    { assignedTo: assignedTo !== undefined ? assignedTo : currentUserId }
  );
}

/**
 * Claim existing lead / create new, then assign to assigneeId (säljare).
 * Last-wins when taking over an existing assignment.
 */
export async function claimOrCreateLeadFromMarket(stats, assigneeId) {
  if (!stats) return { error: "Saknar marknadsdata." };
  const orgNr = normalizeOrgNr(stats.org_nr);
  if (!orgNr) return { error: "Saknar giltigt organisationsnummer." };
  const assignee = assigneeId || currentUserId;
  if (!assignee) return { error: "Du måste vara inloggad." };

  const existing =
    LEADS.find((l) => normalizeOrgNr(l.org_nr) === orgNr) ||
    (await findLeadByOrgNr(orgNr));

  if (existing?.id) {
    const ok = await assignLeads([existing.id], assignee);
    if (!ok) return { error: "Kunde inte tilldela lead." };
    const updated = { ...existing, assigned_to: assignee };
    const inStore = LEADS.some((l) => String(l.id) === String(existing.id));
    upsertLeadInStore(updated, !inStore);
    return { data: updated, claimed: true };
  }

  return createLeadFromMarket(stats, assignee);
}

async function findLeadByOrgNr(orgNr) {
  const digits = normalizeOrgNr(orgNr);
  if (!digits) return null;
  const { data, error } = await sb.from("leads").select("*").eq("org_nr", digits).maybeSingle();
  if (error) {
    console.warn(error);
    return null;
  }
  return data;
}

export async function updateLead(id, fields) {
  const existing = LEADS.find((l) => l.id === id);
  if (!existing) return { error: "Handlaren hittades inte." };

  const parsed = parseLeadFormInput(fields);
  if (parsed.error) return { error: parsed.error };

  const duplicate = await findDuplicateOrgNr(parsed.row.org_nr, id);
  if (duplicate) {
    return { error: `En handlare med detta org.nr finns redan (${duplicate.company_name}).` };
  }

  const addressChanged =
    parsed.addressTrim !== (existing.address || null) ||
    parsed.postalTrim !== (existing.postal_address || null);

  let lat = existing.lat;
  let lng = existing.lng;
  let geocoded = false;

  if (!parsed.addressTrim && !parsed.postalTrim) {
    lat = null;
    lng = null;
  } else if (addressChanged || lat == null || lng == null) {
    const geo = await geocodeLeadAddress(parsed.addressTrim, parsed.postalTrim, parsed.row.city);
    lat = geo.lat;
    lng = geo.lng;
    geocoded = geo.geocoded;
  }

  const row = {
    ...parsed.row,
    lat,
    lng,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await sb.from("leads").update(row).eq("id", id).select().single();
  if (error) {
    console.error(error);
    if (isUniqueViolation(error)) {
      return { error: "En handlare med detta org.nr finns redan." };
    }
    return { error: "Kunde inte uppdatera handlare." };
  }

  const lead = upsertLeadInStore({ ...data, is_dnb: existing.is_dnb }, false);
  return { data: lead, geocoded, addressChanged: addressChanged || (!parsed.addressTrim && !parsed.postalTrim) };
}

// --- Contacts & notes ---

export async function loadContacts(leadId) {
  const el = document.getElementById("contactsList");
  if (!el) return;

  const { data, error } = await sb
    .from("lead_contacts")
    .select("*")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: true });

  if (error || !data || data.length === 0) {
    el.innerHTML =
      `<span style="font-size:12.5px;color:var(--faint);font-style:italic">Inga kontakter tillagda.</span>`;
    return;
  }

  el.innerHTML = data
    .map(
      (c) => `
    <div class="contact-card">
      <div class="cn">${c.name || "–"}</div>
      <div class="cd">
        ${c.phone ? `<span>${c.phone}</span>` : ""}
        ${c.phone && c.email ? " · " : ""}
        ${c.email ? `<a href="mailto:${c.email}">${c.email}</a>` : ""}
      </div>
    </div>`
    )
    .join("");
}

// --- Bilstatistik / fordonsdata ---

export async function loadDealerMarketStats(orgNr) {
  const digits = normalizeOrgNr(orgNr);
  if (!digits) return null;
  const { data, error } = await sb
    .from("dealer_market_stats")
    .select(
      "org_nr, company_name, address, postcode, city, industry, employees, turnover_tkr, equity_tkr, profit_tkr, lagerantal, saljvolym_12m, salj_privat_12m, salj_foretag_12m, lager_finansierat_antal, lager_finansierat_andel, lager_finansbolag, leasing_andel, updated_at, bulk_updated_at"
    )
    .eq("org_nr", digits)
    .maybeSingle();
  if (error) {
    console.warn("Kunde inte läsa dealer_market_stats", error);
    return null;
  }
  return data;
}

export async function fetchBilstatistikInventory(orgNr, companyName) {
  return callNetlifyFunction("bilstatistik-inventory", {
    org_nr: orgNr,
    company_name: companyName || null,
  });
}

// --- Netlify serverless functions ---

export async function callNetlifyFunction(name, body = null) {
  const {
    data: { session },
  } = await sb.auth.getSession();
  if (!session) throw new Error("Du måste vara inloggad");

  const headers = { Authorization: "Bearer " + session.access_token };
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(`/.netlify/functions/${name}`, {
    method: "POST",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  return res.json();
}
