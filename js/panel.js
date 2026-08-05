import { STATUS } from "./constants.js";
import { scoreBreakdown } from "./scoring.js";
import {
  LEADS,
  selectedLead,
  setSelectedLead,
  sb,
  currentUserId,
  currentUserFirstName,
  currentView,
} from "./store.js";
import { patchLead, loadContacts, loadQuotesForLead } from "./data.js";
import { formatOfferId, quotePublicUrl } from "./quote-constants.js";
import { renderAll, renderTable } from "./render.js";
import {
  $,
  toast,
  fmtMSEK,
  scoreColor,
  scoreBarColor,
  fmtDateTime,
  escapeHtml,
  formatOrgNr,
} from "./utils.js";

function noteHtml(note) {
  const author = note.author_name || "Okänd";
  return `<div class="note-item">
    <div class="meta">${escapeHtml(author)} · ${fmtDateTime(note.created_at)}</div>
    <div class="txt">${escapeHtml(note.note)}</div>
  </div>`;
}

function renderNotesList(notes) {
  const el = $("#notesList");
  if (!el) return;

  const lastContact = $("#lastContact");
  if (lastContact) {
    lastContact.textContent = notes.length
      ? `Senaste kontakt: ${fmtDateTime(notes[0].created_at)}`
      : "Senaste kontakt: –";
  }

  el.innerHTML = notes.length
    ? notes.map(noteHtml).join("")
    : `<div class="notes-empty">Inga anteckningar ännu.</div>`;
}

function creditFlagsHtml(lead) {
  const canApprove = !!(lead.kyc_approved && lead.kredit_pm_klart);
  return `
    <div class="p-sec">
      <h4>Kreditkontroll</h4>
      <div class="credit-checks">
        <label class="credit-check">
          <input type="checkbox" id="flagKyc" ${lead.kyc_approved ? "checked" : ""} />
          <span>KYC Beviljad</span>
        </label>
        <label class="credit-check">
          <input type="checkbox" id="flagPm" ${lead.kredit_pm_klart ? "checked" : ""} />
          <span>Kredit-PM klart</span>
        </label>
        <label class="credit-check ${canApprove ? "" : "is-locked"}" title="${canApprove ? "" : "Kräver att KYC och Kredit-PM är klara"}">
          <input type="checkbox" id="flagBeviljad" ${lead.kredit_beviljad ? "checked" : ""} ${canApprove ? "" : "disabled"} />
          <span>Kredit beviljad</span>
        </label>
      </div>
      <p class="credit-hint" id="creditHint">${
        canApprove
          ? "Alla förkrav är uppfyllda — kredit kan beviljas."
          : "Kredit beviljad kan markeras först när KYC och Kredit-PM är i-bockade."
      }</p>
    </div>`;
}

async function saveCreditFlags() {
  if (!selectedLead) return;

  const kyc = document.getElementById("flagKyc")?.checked || false;
  const pm = document.getElementById("flagPm")?.checked || false;
  let beviljad = document.getElementById("flagBeviljad")?.checked || false;
  if (!(kyc && pm)) beviljad = false;

  const ok = await patchLead(selectedLead.id, {
    kyc_approved: kyc,
    kredit_pm_klart: pm,
    kredit_beviljad: beviljad,
    updated_at: new Date().toISOString(),
  });

  if (!ok) {
    toast("Kunde inte spara kreditflaggor");
    return;
  }

  selectedLead.kyc_approved = kyc;
  selectedLead.kredit_pm_klart = pm;
  selectedLead.kredit_beviljad = beviljad;
  const lead = LEADS.find((l) => l.id === selectedLead.id);
  if (lead) {
    lead.kyc_approved = kyc;
    lead.kredit_pm_klart = pm;
    lead.kredit_beviljad = beviljad;
  }

  const beviljadEl = document.getElementById("flagBeviljad");
  const label = beviljadEl?.closest(".credit-check");
  const hint = document.getElementById("creditHint");
  const canApprove = kyc && pm;
  if (beviljadEl) {
    beviljadEl.disabled = !canApprove;
    beviljadEl.checked = beviljad;
  }
  if (label) label.classList.toggle("is-locked", !canApprove);
  if (hint) {
    hint.textContent = canApprove
      ? "Alla förkrav är uppfyllda — kredit kan beviljas."
      : "Kredit beviljad kan markeras först när KYC och Kredit-PM är i-bockade.";
  }

  renderAll();
}

export async function openPanel(id) {
  setSelectedLead(LEADS.find((l) => l.id === id));
  if (!selectedLead) return;

  const breakdown = scoreBreakdown(selectedLead);

  $("#pRing").textContent = selectedLead.score == null ? "–" : selectedLead.score;
  $("#pRing").style.background =
    selectedLead.score == null
      ? "#cfd6e2"
      : `conic-gradient(${scoreColor(selectedLead.score)} ${selectedLead.score * 3.6}deg, #eef1f5 0deg)`;
  $("#pRing").style.boxShadow = "inset 0 0 0 6px #fff";
  $("#pName").innerHTML =
    `${selectedLead.company_name}${selectedLead.is_dnb ? '<span class="badge-dnb">DNB</span>' : ""}`;
  $("#pMeta").textContent = `${formatOrgNr(selectedLead.org_nr) || "–"} · ${selectedLead.city || "–"}`;
  $("#followup").value = selectedLead.follow_up_date || "";

  const addressLines = [selectedLead.address, selectedLead.postal_address].filter(Boolean);
  const addressHtml = addressLines.length
    ? `<div class="p-sec">
      <h4>Adress</h4>
      <div class="p-address">${addressLines.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}</div>
      ${selectedLead.lat && selectedLead.lng ? `<div class="p-address-map">📍 Visas på kartan</div>` : `<div class="p-address-map muted">Ingen kartposition</div>`}
    </div>`
    : "";

  const breakdownHtml = breakdown.notEnriched
    ? `<div class="notenriched">Nyckeltal saknas — fyll i org.nr och finansiell data för att beräkna score.</div>`
    : breakdown.parts
        .map(
          (p) => `
        <div class="bd-row">
          <span class="lab">${p.lab}</span>
          <span class="track"><span class="fill" style="width:${(p.pts / p.max) * 100}%;background:${scoreBarColor(p.pts, p.max)}"></span></span>
          <span class="pts">${p.pts}/${p.max}</span>
        </div>`
        )
        .join("");

  const showCreditFlags =
    currentView === "kredit" ||
    ["skickad_kredit", "invantar_aterkoppling", "kund_aktiv"].includes(selectedLead.status);

  $("#pBody").innerHTML = `
    <div class="p-sec"><h4>Varför den här poängen</h4>${breakdownHtml}</div>
    <div class="p-sec">
      <div class="p-sec-head">
        <h4>Nyckeltal</h4>
        <button class="btn-link" id="editLeadBtnInline">Redigera</button>
      </div>
      <div class="kpis">
        <div class="kpi"><div class="v num">${fmtMSEK(selectedLead.revenue)}</div><div class="l">Omsättning</div></div>
        <div class="kpi"><div class="v num">${fmtMSEK(selectedLead.result_after_fin)}</div><div class="l">Resultat</div></div>
        <div class="kpi"><div class="v num">${fmtMSEK(selectedLead.equity)}</div><div class="l">Eget kapital</div></div>
        <div class="kpi"><div class="v num">${selectedLead.solidity != null ? selectedLead.solidity + " %" : "–"}</div><div class="l">Soliditet</div></div>
        <div class="kpi"><div class="v num">${selectedLead.employees ?? "–"}</div><div class="l">Anställda</div></div>
      </div>
    </div>
    ${addressHtml}
    ${showCreditFlags ? creditFlagsHtml(selectedLead) : ""}
    <div class="p-sec">
      <div class="p-sec-head">
        <h4>Offerter</h4>
        <button class="btn-link" id="openQuoteBtn">Skapa offert</button>
      </div>
      <div id="panelQuotesList" class="panel-quotes-list">Laddar offerter…</div>
    </div>
    <div class="p-sec">
      <h4>Kontaktpersoner</h4>
      <div id="contactsList" style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px"></div>
      <details>
        <summary style="font-size:12.5px;color:var(--accent);cursor:pointer;list-style:none;padding:4px 0">+ Lägg till kontakt</summary>
        <div class="contact-form" style="margin-top:10px">
          <input type="text" id="contactName" class="dateinput" placeholder="Namn">
          <input type="text" id="contactPhone" class="dateinput" placeholder="Telefon">
          <input type="email" id="contactEmail" class="dateinput" placeholder="E-post">
          <div class="notes-foot">
            <button class="btn btn-prim" id="saveContact">Spara kontakt</button>
            <span class="saved" id="contactSavedMsg">✓ Sparat</span>
          </div>
        </div>
      </details>
    </div>
    <div class="p-sec">
      <h4>Status</h4>
      <div class="status-switch" id="ssw">
        ${Object.entries(STATUS)
          .map(
            ([key, val]) =>
              `<button class="ss-btn ${selectedLead.status === key ? "on" : ""}" data-s="${key}"><span class="dot"></span>${val.switchLabel || val.label}</button>`
          )
          .join("")}
      </div>
    </div>
    <div class="p-sec notes-section">
      <h4>Anteckningar</h4>
      <div class="notes-meta" id="lastContact">Senaste kontakt: –</div>
      <textarea id="newNote" placeholder="Skriv en ny anteckning…"></textarea>
      <div class="notes-foot">
        <button class="btn btn-prim" id="addNoteBtn">Lägg till anteckning</button>
        <span class="saved" id="noteSavedMsg">✓ Sparat</span>
      </div>
      <div class="notes-list" id="notesList"><div class="notes-empty">Laddar anteckningar…</div></div>
    </div>`;

  document.getElementById("editLeadBtnInline").onclick = () => {
    import("./customer-modal.js").then(({ openEditModal }) => openEditModal(selectedLead.id));
  };

  document.getElementById("openQuoteBtn").onclick = () => {
    import("./quote-modal.js").then(({ openQuoteModal }) => openQuoteModal(selectedLead.id));
  };

  renderPanelQuotes(id);

  ["flagKyc", "flagPm", "flagBeviljad"].forEach((flagId) => {
    const el = document.getElementById(flagId);
    if (el) el.onchange = saveCreditFlags;
  });

  document.getElementById("saveContact").onclick = async () => {
    const name = document.getElementById("contactName").value.trim();
    const phone = document.getElementById("contactPhone").value.trim();
    const email = document.getElementById("contactEmail").value.trim();
    if (!name && !phone && !email) return;

    const { error } = await sb.from("lead_contacts").insert({
      lead_id: selectedLead.id,
      name,
      phone,
      email,
      created_at: new Date().toISOString(),
    });

    if (!error) {
      const msg = document.getElementById("contactSavedMsg");
      msg.classList.add("show");
      setTimeout(() => msg.classList.remove("show"), 2000);
      loadContacts(selectedLead.id);
      ["contactName", "contactPhone", "contactEmail"].forEach(
        (cid) => (document.getElementById(cid).value = "")
      );
    } else {
      toast("Kunde inte spara kontakt");
      console.error(error);
    }
  };

  document.getElementById("ssw").onclick = async (e) => {
    const btn = e.target.closest(".ss-btn");
    if (!btn) return;

    const newStatus = btn.dataset.s;
    const ok = await patchLead(selectedLead.id, {
      status: newStatus,
      updated_at: new Date().toISOString(),
    });

    if (ok) {
      selectedLead.status = newStatus;
      if (newStatus === "ejaktuell" && !selectedLead.enriched_at) {
        selectedLead.enriched_at = new Date().toISOString();
      }
      const lead = LEADS.find((l) => l.id === selectedLead.id);
      if (lead) {
        lead.status = newStatus;
        if (newStatus === "ejaktuell" && !lead.enriched_at) {
          lead.enriched_at = selectedLead.enriched_at;
        }
      }
      document.querySelectorAll(".ss-btn").forEach((b) =>
        b.classList.toggle("on", b.dataset.s === newStatus)
      );
      renderAll();
    }
  };

  document.getElementById("addNoteBtn").onclick = async () => {
    const text = document.getElementById("newNote").value.trim();
    if (!text) return;

    const note = {
      lead_id: selectedLead.id,
      note: text,
      author_id: currentUserId,
      author_name: currentUserFirstName || "Okänd",
      created_at: new Date().toISOString(),
    };
    const { data, error } = await sb.from("lead_notes").insert(note).select().single();

    if (!error) {
      document.getElementById("newNote").value = "";
      const msg = document.getElementById("noteSavedMsg");
      msg.classList.add("show");
      setTimeout(() => msg.classList.remove("show"), 2000);

      const list = document.getElementById("notesList");
      if (list.querySelector(".notes-empty")) list.innerHTML = "";
      list.insertAdjacentHTML("afterbegin", noteHtml(data));

      const lastContact = document.getElementById("lastContact");
      if (lastContact) lastContact.textContent = `Senaste kontakt: ${fmtDateTime(data.created_at)}`;
    } else {
      toast("Kunde inte spara anteckning");
    }
  };

  $("#panel").classList.add("open");
  $("#scrim").classList.add("open");
  renderTable();

  const notesRes = await sb
    .from("lead_notes")
    .select("*")
    .eq("lead_id", id)
    .order("created_at", { ascending: false });

  if (!selectedLead || selectedLead.id !== id) return;

  if (notesRes.error) {
    document.getElementById("notesList").innerHTML =
      `<div class="notes-empty">Kunde inte hämta anteckningar.</div>`;
  } else {
    renderNotesList(notesRes.data || []);
  }

  loadContacts(id);
}

export async function renderPanelQuotes(leadId) {
  const el = document.getElementById("panelQuotesList");
  if (!el) return;

  const quotes = await loadQuotesForLead(leadId);
  if (!selectedLead || selectedLead.id !== leadId) return;

  if (!quotes.length) {
    el.innerHTML = `<div class="panel-quotes-empty">Inga offerter ännu.</div>`;
    return;
  }

  const byOffer = new Map();
  for (const q of quotes) {
    const existing = byOffer.get(q.offer_id);
    if (!existing || q.version > existing.version) byOffer.set(q.offer_id, q);
  }

  const latest = [...byOffer.values()].sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  );

  el.innerHTML = latest
    .slice(0, 5)
    .map((q) => {
      const versionCount = quotes.filter((x) => x.offer_id === q.offer_id).length;
      const versionLabel = versionCount > 1 ? `v${q.version} (${versionCount} versioner)` : `v${q.version}`;
      const link =
        q.public_token && q.status !== "draft"
          ? `<a href="${quotePublicUrl(q.public_token)}" target="_blank" rel="noopener" class="btn-link">Öppna</a>`
          : "";
      return `<div class="panel-quote-item">
        <span class="num">${formatOfferId(q.offer_id)}</span>
        <span>${versionLabel}</span>
        <span class="panel-quote-status">${q.status}</span>
        ${link}
      </div>`;
    })
    .join("");
}

export function closePanel() {
  $("#panel").classList.remove("open");
  $("#scrim").classList.remove("open");
  setSelectedLead(null);
  renderTable();
}
