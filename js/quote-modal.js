import { saveQuoteVersion, publishQuote, loadQuotesForLead } from "./data.js";
import { LEADS, selectedLead } from "./store.js";
import { QUOTE_TEMPLATE, formatOfferId, quotePublicUrl } from "./quote-constants.js";
import { renderPanelQuotes } from "./panel.js";
import { $, toast, formatOrgNr, escapeAttr } from "./utils.js";

let editingLeadId = null;
let currentOfferId = null;
let currentQuoteId = null;
let lineItems = [];

function resetState() {
  editingLeadId = null;
  currentOfferId = null;
  currentQuoteId = null;
  lineItems = [];
}

function renderRows() {
  const container = $("#quoteRows");
  if (!lineItems.length) {
    container.innerHTML = `<div class="quote-rows-empty">Inga villkorsrader ännu. Klicka på ”Lägg till rad”.</div>`;
    return;
  }

  container.innerHTML = lineItems
    .map(
      (row, i) => `
    <div class="quote-row" data-idx="${i}">
      <input type="text" class="dateinput quote-row-label" placeholder="T.ex. Räntenivå" value="${escapeAttr(row.label || "")}" />
      <input type="text" class="dateinput quote-row-value" placeholder="T.ex. 6%" value="${escapeAttr(row.value || "")}" />
      <button type="button" class="btn-icon quote-row-remove" title="Ta bort rad">✕</button>
    </div>`
    )
    .join("");

  container.querySelectorAll(".quote-row-label").forEach((input, i) => {
    input.oninput = (e) => {
      lineItems[i].label = e.target.value;
    };
  });
  container.querySelectorAll(".quote-row-value").forEach((input, i) => {
    input.oninput = (e) => {
      lineItems[i].value = e.target.value;
    };
  });
  container.querySelectorAll(".quote-row-remove").forEach((btn) => {
    btn.onclick = () => {
      const idx = +btn.closest(".quote-row").dataset.idx;
      lineItems.splice(idx, 1);
      renderRows();
    };
  });
}

function readForm() {
  return {
    introText: $("#quoteIntro").value,
    lineItems: lineItems.map((row) => ({
      label: row.label || "",
      value: row.value || "",
    })),
  };
}

function setQuoteMeta(quote) {
  const meta = $("#quoteMeta");
  if (!quote) {
    meta.innerHTML = `<span class="quote-meta-new">Ny offert · giltig ${QUOTE_TEMPLATE.validityDays} dagar efter publicering</span>`;
    const saveBtn = $("#quoteSaveBtn");
    if (saveBtn) saveBtn.textContent = "Spara offert";
    return;
  }

  const statusLabel =
    quote.status === "published"
      ? "Publicerad"
      : quote.status === "accepted"
        ? "Accepterad"
        : quote.status === "draft"
          ? "Utkast"
          : quote.status;

  meta.innerHTML = `
    <span class="quote-meta-id num">${formatOfferId(quote.offer_id)}</span>
    <span class="quote-meta-ver">v${quote.version}</span>
    <span class="quote-meta-status">${statusLabel}</span>`;

  const saveBtn = $("#quoteSaveBtn");
  if (saveBtn) saveBtn.textContent = quote.offer_id ? "Spara ny version" : "Spara offert";
}

async function renderExistingQuotes(leadId) {
  const el = $("#quoteHistory");
  const quotes = await loadQuotesForLead(leadId);

  if (!quotes.length) {
    el.innerHTML = `<div class="quote-history-empty">Inga offerter för detta företag ännu.</div>`;
    return;
  }

  const sorted = [...quotes].sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  );

  el.innerHTML = sorted
    .map((q) => {
      const link =
        q.public_token && q.status !== "draft"
          ? `<button type="button" class="btn-link quote-open-link" data-token="${q.public_token}">Öppna länk</button>`
          : "";
      const active = q.offer_id === currentOfferId && q.id === currentQuoteId ? " active" : "";
      return `<button type="button" class="quote-history-item${active}" data-offer="${q.offer_id}" data-id="${q.id}">
        <span class="num">${formatOfferId(q.offer_id)}</span>
        <span>v${q.version}</span>
        <span class="quote-hist-status">${q.status}</span>
        ${link}
      </button>`;
    })
    .join("");

  el.querySelectorAll(".quote-history-item").forEach((btn) => {
    btn.onclick = (e) => {
      if (e.target.closest(".quote-open-link")) return;
      loadQuoteById(+btn.dataset.id);
    };
  });

  el.querySelectorAll(".quote-open-link").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      window.open(quotePublicUrl(btn.dataset.token), "_blank");
    };
  });
}

async function loadQuoteById(quoteId) {
  const quotes = await loadQuotesForLead(editingLeadId);
  const quote = quotes.find((q) => q.id === quoteId);
  if (!quote) return;

  currentOfferId = quote.offer_id;
  currentQuoteId = quote.id;
  $("#quoteIntro").value = quote.intro_text || QUOTE_TEMPLATE.intro;
  lineItems = (quote.line_items || []).map((r) => ({ ...r }));
  if (!lineItems.length) lineItems.push({ label: "", value: "" });
  renderRows();
  setQuoteMeta(quote);
  updatePublishSection(quote);
  await renderExistingQuotes(editingLeadId);
}

async function loadOfferVersion(offerId) {
  const quotes = await loadQuotesForLead(editingLeadId);
  const latest = quotes
    .filter((q) => q.offer_id === offerId)
    .sort((a, b) => b.version - a.version)[0];

  if (!latest) return null;
  await loadQuoteById(latest.id);
  return latest;
}

function resetToNewOffer() {
  currentOfferId = null;
  currentQuoteId = null;
  $("#quoteIntro").value = QUOTE_TEMPLATE.intro;
  $("#quoteErr").textContent = "";
  lineItems = [{ label: "", value: "" }];
  renderRows();
  setQuoteMeta(null);
  updatePublishSection(null);
  renderExistingQuotes(editingLeadId);
}

function updatePublishSection(quote) {
  const section = $("#quoteLinkSection");
  const input = $("#quotePublicLink");

  if (quote?.public_token && quote.status !== "draft") {
    section.style.display = "block";
    input.value = quotePublicUrl(quote.public_token);
  } else {
    section.style.display = "none";
    input.value = "";
  }
}

function openModal() {
  $("#quoteModal").classList.add("open");
  $("#quoteModalScrim").classList.add("open");
}

export function closeQuoteModal() {
  $("#quoteModal").classList.remove("open");
  $("#quoteModalScrim").classList.remove("open");
  resetState();
}

export async function openQuoteModal(leadId, { newOffer = false } = {}) {
  const lead = LEADS.find((l) => l.id === leadId) || selectedLead;
  if (!lead) return;

  editingLeadId = lead.id;
  currentOfferId = null;
  currentQuoteId = null;

  $("#quoteCompanyName").textContent = lead.company_name;
  $("#quoteOrgNr").textContent = formatOrgNr(lead.org_nr) || "–";
  $("#quoteErr").textContent = "";

  openModal();

  const quotes = await loadQuotesForLead(lead.id);

  if (!newOffer && quotes.length) {
    const loaded = await loadOfferVersion(quotes[0].offer_id);
    if (loaded) {
      toast(`Fortsätter på ${formatOfferId(loaded.offer_id)} — spara skapar v${loaded.version + 1}`);
    }
  } else {
    $("#quoteIntro").value = QUOTE_TEMPLATE.intro;
    lineItems = [{ label: "", value: "" }];
    renderRows();
    setQuoteMeta(null);
    updatePublishSection(null);
    $("#quoteLinkSection").style.display = "none";
    await renderExistingQuotes(lead.id);
  }
}

async function saveDraft() {
  const lead = LEADS.find((l) => l.id === editingLeadId);
  if (!lead) return;

  const { introText, lineItems: items } = readForm();
  const btn = $("#quoteSaveBtn");
  btn.disabled = true;
  btn.textContent = "Sparar…";

  const result = await saveQuoteVersion({
    leadId: lead.id,
    offerId: currentOfferId,
    companyName: lead.company_name,
    orgNr: lead.org_nr || "",
    introText,
    lineItems: items,
  });

  btn.disabled = false;
  btn.textContent = currentOfferId ? "Spara ny version" : "Spara offert";

  if (result.error) {
    $("#quoteErr").textContent = result.error;
    return;
  }

  currentOfferId = result.data.offer_id;
  currentQuoteId = result.data.id;
  setQuoteMeta(result.data);
  toast(result.data.version > 1 ? "Ny version sparad" : "Offert sparad");
  await renderExistingQuotes(lead.id);
  if (selectedLead?.id === lead.id) renderPanelQuotes(lead.id);
}

async function publishCurrent() {
  if (!currentQuoteId) {
    $("#quoteErr").textContent = "Spara offerten först innan du skapar en delningslänk.";
    return;
  }

  const btn = $("#quotePublishBtn");
  btn.disabled = true;
  btn.textContent = "Skapar länk…";

  const result = await publishQuote(currentQuoteId);

  btn.disabled = false;
  btn.textContent = "Skapa offert";

  if (result.error) {
    $("#quoteErr").textContent = result.error;
    return;
  }

  $("#quoteErr").textContent = "";
  currentQuoteId = result.data.id;
  setQuoteMeta(result.data);
  updatePublishSection(result.data);
  toast("Offertlänk skapad");

  try {
    await navigator.clipboard.writeText(quotePublicUrl(result.data.public_token));
    toast("Länk kopierad till urklipp");
  } catch {
    /* clipboard optional */
  }

  await renderExistingQuotes(editingLeadId);
  if (selectedLead?.id === editingLeadId) renderPanelQuotes(editingLeadId);
}

function copyLink() {
  const url = $("#quotePublicLink").value;
  if (!url) return;
  navigator.clipboard.writeText(url).then(
    () => toast("Länk kopierad"),
    () => toast("Kunde inte kopiera länk")
  );
}

export function bindQuoteModal() {
  $("#quoteModalClose").onclick = closeQuoteModal;
  $("#quoteModalCancel").onclick = closeQuoteModal;
  $("#quoteModalScrim").onclick = closeQuoteModal;
  $("#quoteAddRow").onclick = () => {
    lineItems.push({ label: "", value: "" });
    renderRows();
    const rows = $("#quoteRows");
    const last = rows.querySelector(".quote-row:last-child .quote-row-label");
    last?.focus();
  };
  $("#quoteSaveBtn").onclick = saveDraft;
  $("#quotePublishBtn").onclick = publishCurrent;
  $("#quoteCopyLink").onclick = copyLink;
  $("#quoteNewOfferBtn").onclick = () => {
    resetToNewOffer();
    toast("Ny offert — får nytt offert-ID vid sparning");
  };
  $("#quoteBtn").onclick = () => {
    if (selectedLead) openQuoteModal(selectedLead.id);
  };
}
