import { DEFAULT_SCORING } from "./constants.js";
import { scoreBreakdown } from "./scoring.js";
import {
  filterState,
  sb,
  LEADS,
  setLeads,
  setScoringConfig,
  currentUserId,
  currentUserEmail,
  setCurrentUserProfile,
} from "./store.js";
import { QUOTE_TEMPLATE } from "./quote-constants.js";
import { $, msekToSek, normalizeOrgNr, parseCityFromPostalAddress, parseEmployees } from "./utils.js";

// --- Profiles ---

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

export async function createLead(fields) {
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
  const row = {
    ...parsed.row,
    lat,
    lng,
    status: "ny",
    enriched_at: now,
    updated_at: now,
  };

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

// --- Quotes ---

function addValidityDays(fromDate = new Date()) {
  const d = new Date(fromDate);
  d.setDate(d.getDate() + QUOTE_TEMPLATE.validityDays);
  return d.toISOString().slice(0, 10);
}

export async function loadQuotesForLead(leadId) {
  const { data, error } = await sb
    .from("quotes")
    .select("*")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error(error);
    return [];
  }
  return data || [];
}

export async function getLatestQuoteVersion(offerId) {
  const { data, error } = await sb
    .from("quotes")
    .select("*")
    .eq("offer_id", offerId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) console.error(error);
  return data;
}

export async function getNextQuoteVersion(offerId) {
  const latest = await getLatestQuoteVersion(offerId);
  return latest ? latest.version + 1 : 1;
}

export async function saveQuoteVersion({ leadId, offerId, companyName, orgNr, introText, lineItems }) {
  if (!currentUserId || !currentUserEmail) {
    return { error: "Du måste vara inloggad." };
  }

  const cleanedItems = lineItems
    .map((row) => ({ label: row.label?.trim() || "", value: row.value?.trim() || "" }))
    .filter((row) => row.label || row.value);

  if (!cleanedItems.length) {
    return { error: "Lägg till minst en rad med villkor." };
  }

  const version = offerId ? await getNextQuoteVersion(offerId) : 1;
  const row = {
    offer_id: offerId || crypto.randomUUID(),
    version,
    lead_id: leadId,
    created_by: currentUserId,
    creator_email: currentUserEmail,
    company_name: companyName,
    org_nr: orgNr,
    intro_text: introText?.trim() || QUOTE_TEMPLATE.intro,
    line_items: cleanedItems,
    valid_until: addValidityDays(),
    status: "draft",
  };

  const { data, error } = await sb.from("quotes").insert(row).select().single();
  if (error) {
    console.error(error);
    return { error: "Kunde inte spara offert. Kör supabase/quotes.sql i Supabase." };
  }
  return { data };
}

export async function publishQuote(quoteId) {
  const { data: quote, error: fetchErr } = await sb
    .from("quotes")
    .select("*")
    .eq("id", quoteId)
    .maybeSingle();

  if (fetchErr || !quote) {
    return { error: "Offerten hittades inte." };
  }
  if (quote.status === "accepted") {
    return { error: "Offerten är redan accepterad." };
  }

  const publicToken = crypto.randomUUID();
  const now = new Date().toISOString();

  await sb
    .from("quotes")
    .update({ status: "superseded" })
    .eq("offer_id", quote.offer_id)
    .eq("status", "published");

  const { data, error } = await sb
    .from("quotes")
    .update({
      status: "published",
      public_token: publicToken,
      published_at: now,
    })
    .eq("id", quoteId)
    .select()
    .single();

  if (error) {
    console.error(error);
    return { error: "Kunde inte publicera offert." };
  }
  return { data };
}

export async function loadPublicQuote(publicToken) {
  const { data, error } = await sb
    .from("quotes")
    .select("*")
    .eq("public_token", publicToken)
    .maybeSingle();

  if (error) console.error(error);
  return data;
}

export async function acceptQuote(publicToken, email) {
  const res = await fetch("/.netlify/functions/accept-quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ public_token: publicToken, email }),
  });
  return res.json();
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
