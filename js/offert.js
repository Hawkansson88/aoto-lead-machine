import { SUPABASE_URL, SUPABASE_ANON } from "./config.js";
import { acceptQuote } from "./data.js";
import { formatOfferId } from "./quote-constants.js";
import { formatOrgNr } from "./utils.js";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

const params = new URLSearchParams(window.location.search);
const token = params.get("t");

const $ = (sel) => document.querySelector(sel);

function show(id) {
  ["offertLoading", "offertError", "offertContent"].forEach((section) => {
    const el = $(`#${section}`);
    if (el) el.hidden = section !== id;
  });
}

function formatDate(dateStr) {
  if (!dateStr) return "–";
  return new Date(dateStr + "T00:00:00").toLocaleDateString("sv-SE", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function renderLines(items) {
  const el = $("#offertLines");
  el.innerHTML = (items || [])
    .map(
      (row, i) => `
    <div class="offert-line" style="--delay:${i * 0.06}s">
      <span class="offert-line-label">${escapeHtml(row.label)}</span>
      <span class="offert-line-value num">${escapeHtml(row.value)}</span>
    </div>`
    )
    .join("");
}

function escapeHtml(text) {
  return String(text || "").replace(/</g, "&lt;");
}

async function boot() {
  if (!token) {
    $("#offertErrorMsg").textContent = "Ingen offertlänk angiven.";
    show("offertError");
    return;
  }

  const { data, error } = await sb
    .from("quotes")
    .select("*")
    .eq("public_token", token)
    .maybeSingle();

  if (error || !data) {
    $("#offertErrorMsg").textContent = "Länken är ogiltig eller har gått ut.";
    show("offertError");
    return;
  }

  const quote = data;

  $("#offertCompany").textContent = quote.company_name;
  $("#offertOrg").textContent = formatOrgNr(quote.org_nr) || quote.org_nr;
  $("#offertIntro").textContent = quote.intro_text;
  $("#offertValidUntil").textContent = formatDate(quote.valid_until);
  $("#offertId").textContent = formatOfferId(quote.offer_id);
  $("#offertVersion").textContent = `Version ${quote.version}`;
  renderLines(quote.line_items);

  if (quote.status === "accepted") {
    $("#offertActions").hidden = true;
    $("#offertAccepted").hidden = false;
    $("#offertAcceptedEmail").textContent = quote.accepted_email || "—";
    $("#offertBadge").textContent = "Accepterad";
    $("#offertBadge").classList.add("accepted");
  }

  show("offertContent");

  $("#acceptBtn").onclick = async () => {
    const email = $("#acceptEmail").value.trim();
    const errEl = $("#acceptErr");
    errEl.textContent = "";

    if (!email) {
      errEl.textContent = "Ange din e-postadress som signatur.";
      return;
    }

    const btn = $("#acceptBtn");
    btn.disabled = true;
    btn.textContent = "Signerar…";

    const result = await acceptQuote(token, email);

    btn.disabled = false;
    btn.textContent = "Acceptera offert";

    if (!result.success) {
      errEl.textContent = result.error || "Kunde inte acceptera offerten.";
      return;
    }

    $("#offertActions").hidden = true;
    $("#offertAccepted").hidden = false;
    $("#offertAcceptedEmail").textContent = email;
    $("#offertBadge").textContent = "Accepterad";
    $("#offertBadge").classList.add("accepted");
  };
}

boot();
