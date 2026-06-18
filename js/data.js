import { DEFAULT_SCORING } from "./constants.js";
import { scoreBreakdown } from "./scoring.js";
import { filterState, sb, LEADS, setLeads, setScoringConfig } from "./store.js";
import { $ } from "./utils.js";

// --- User settings ---

export async function loadUserSettings(userId) {
  const { data } = await sb.from("user_settings").select("filters").eq("user_id", userId).maybeSingle();
  if (!data) return;

  const filters = data.filters || {};

  if (filters.minScore != null) {
    filterState.minScore = filters.minScore;
    $("#scoreSlider").value = filters.minScore;
    $("#scoreVal").textContent = filters.minScore;
    $("#scoreSlider").style.setProperty("--p", filters.minScore + "%");
  }
  if (filters.revMin != null) {
    filterState.revMin = filters.revMin;
    $("#revMin").value = filters.revMin;
  }
  if (filters.revMax != null) {
    filterState.revMax = filters.revMax;
    $("#revMax").value = filters.revMax;
  }
  if (filters.dnb) filterState.dnb = filters.dnb;
  if (filters.scoring) {
    setScoringConfig({ ...DEFAULT_SCORING, ...filters.scoring });
  }
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

// --- Netlify serverless functions ---

export async function callNetlifyFunction(name) {
  const {
    data: { session },
  } = await sb.auth.getSession();
  if (!session) throw new Error("Du måste vara inloggad");

  const res = await fetch(`/.netlify/functions/${name}`, {
    method: "POST",
    headers: { Authorization: "Bearer " + session.access_token },
  });

  return res.json();
}
