import { STATUS } from "./constants.js";
import { scoreBreakdown } from "./scoring.js";
import {
  LEADS,
  TAGS,
  selectedLead,
  setSelectedLead,
  sb,
  currentUserId,
  currentUserFirstName,
  currentView,
  filterState,
} from "./store.js";
import {
  patchLead,
  loadContacts,
  loadDealerMarketStats,
  fetchBilstatistikInventory,
  bumpLeadNoteCount,
  addTagToLeads,
  removeTagFromLeads,
  renameTag,
} from "./data.js";
import { renderAll, renderTable } from "./render.js";
import { assigneeBadgeHtml, getProfile, profileDisplayName } from "./assignees.js";
import { openAssignModal, openMarketAssignModal } from "./assign.js";
import { tagChipsHtml, tagsBadgeHtml } from "./tags.js";
import {
  $,
  toast,
  fmtMSEK,
  scoreColor,
  scoreBarColor,
  fmtDateTime,
  escapeHtml,
  escapeAttr,
  formatOrgNr,
  normalizeOrgNr,
} from "./utils.js";

/** Market row for dealers not yet in CRM pipeline (Marknadsanalys). */
let prospectStats = null;
/** Existing CRM lead without assignee (or takeover candidate) when showing prospect UI. */
let dormantLead = null;

function syncSelectedLeadTagsFromStore() {
  if (!selectedLead?.id) return;
  const lead = LEADS.find((l) => String(l.id) === String(selectedLead.id));
  if (!lead) return;
  selectedLead.tags = lead.tags || [];
  const chipsHost = document.querySelector(".tags-section #leadTagChips") || $("#leadTagChips");
  if (chipsHost) {
    chipsHost.outerHTML = tagChipsHtml(selectedLead.tags, { editable: true });
  }
  const ownerBadge = assigneeBadgeHtml(selectedLead.assigned_to, { emptyLabel: true });
  if ($("#pName")) {
    $("#pName").innerHTML =
      `${escapeHtml(selectedLead.company_name)}${tagsBadgeHtml(selectedLead.tags)}${ownerBadge}`;
  }
}

function fillPanelTagSuggestions() {
  const list = $("#panelTagSuggestions");
  if (!list) return;
  list.innerHTML = TAGS.map((t) => `<option value="${escapeAttr(t.name)}"></option>`).join("");
}

function bindLeadTagUi() {
  fillPanelTagSuggestions();

  const addBtn = $("#addTagBtn");
  const input = $("#newTagInput");
  if (addBtn && input) {
    const add = async () => {
      const name = input.value.trim();
      if (!name || !selectedLead?.id) return;
      addBtn.disabled = true;
      try {
        const result = await addTagToLeads([selectedLead.id], name);
        if (!result.ok) {
          toast(result.error || "Kunde inte lägga till tagg");
          return;
        }
        input.value = "";
        syncSelectedLeadTagsFromStore();
        fillPanelTagSuggestions();
        renderAll();
      } finally {
        addBtn.disabled = false;
      }
    };
    addBtn.onclick = add;
    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        add();
      }
    };
  }

  const section = document.querySelector(".tags-section");
  if (!section || section.dataset.bound === "1") return;
  section.dataset.bound = "1";

  section.addEventListener("click", async (e) => {
    const removeBtn = e.target.closest('[data-act="remove-tag"]');
    if (!removeBtn) return;
    e.preventDefault();
    if (!selectedLead?.id) return;
    const tagId = removeBtn.dataset.tagId;
    const result = await removeTagFromLeads([selectedLead.id], tagId);
    if (!result.ok) {
      toast(result.error || "Kunde inte ta bort tagg");
      return;
    }
    syncSelectedLeadTagsFromStore();
    renderAll();
  });

  section.addEventListener("dblclick", async (e) => {
    const label = e.target.closest('[data-act="rename-tag"]');
    if (!label) return;
    const chip = label.closest(".tag-chip");
    if (!chip) return;
    const tagId = chip.dataset.tagId;
    const current = chip.dataset.tagName || label.textContent || "";
    const next = window.prompt("Byt namn på taggen (påverkar alla leads):", current);
    if (next == null) return;
    const result = await renameTag(tagId, next);
    if (!result.ok) {
      toast(result.error || "Kunde inte byta namn");
      return;
    }
    if (result.merged) toast(`Taggen slogs ihop med “${result.tag.name}”`);
    syncSelectedLeadTagsFromStore();
    fillPanelTagSuggestions();
    renderAll();
  });
}

function tkrToSek(tkr) {
  if (tkr == null || tkr === "") return null;
  const n = Number(tkr);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000);
}

function draftLeadFromMarket(stats) {
  const orgNr = normalizeOrgNr(stats?.org_nr);
  const postal = [stats?.postcode, stats?.city].filter(Boolean).join(" ").trim() || null;
  return {
    id: null,
    company_name: stats?.company_name || "—",
    org_nr: orgNr,
    city: stats?.city || null,
    address: stats?.address || null,
    postal_address: postal,
    revenue: tkrToSek(stats?.turnover_tkr),
    result_after_fin: tkrToSek(stats?.profit_tkr),
    equity: tkrToSek(stats?.equity_tkr),
    solidity: null,
    employees: stats?.employees ?? null,
    status: "ny",
    score: null,
    tags: [],
    assigned_to: null,
    follow_up_date: null,
    lat: null,
    lng: null,
    kyc_approved: false,
    kredit_pm_klart: false,
    kredit_beviljad: false,
    enriched_at: null,
  };
}

function setPanelChromeMode(isProspect) {
  const createBtn = $("#createLeadBtn");
  const assignBtn = $("#panelAssignBtn");
  const mailBtn = $("#mailBtn");
  const editBtn = $("#editLeadBtn");
  const followup = $("#followup");
  const saveFollowup = $("#saveFollowup");

  if (createBtn) {
    createBtn.style.display = isProspect ? "" : "none";
    if (isProspect) {
      createBtn.textContent = "Tilldela";
      createBtn.title = dormantLead
        ? "Tilldela dig eller en säljarkollega (anteckningar behålls)"
        : "Skapa lead och tilldela säljare";
    }
  }
  if (assignBtn) assignBtn.style.display = isProspect ? "none" : "";
  if (editBtn) editBtn.style.display = isProspect ? "none" : "";
  if (mailBtn) {
    mailBtn.disabled = !!isProspect;
    mailBtn.style.opacity = isProspect ? "0.4" : "";
  }
  if (followup) followup.disabled = !!isProspect;
  if (saveFollowup) {
    saveFollowup.disabled = !!isProspect;
    saveFollowup.style.opacity = isProspect ? "0.4" : "";
  }
}
function fmtStatNum(value) {
  if (value == null || value === "") return "–";
  const n = Number(value);
  if (!Number.isFinite(n)) return "–";
  return n.toLocaleString("sv-SE");
}

function fmtStatSplit(privat, foretag) {
  const p = privat == null || privat === "" ? null : Number(privat);
  const f = foretag == null || foretag === "" ? null : Number(foretag);
  if (!Number.isFinite(p) && !Number.isFinite(f)) return "–";
  const pv = Number.isFinite(p) ? p : 0;
  const fv = Number.isFinite(f) ? f : 0;
  const total = pv + fv;
  if (total <= 0) return "0 / 0 = 0 bilar";
  const pPct = Math.round((pv / total) * 100);
  const fPct = 100 - pPct;
  return `${fmtStatNum(pv)} / ${fmtStatNum(fv)} = ${fmtStatNum(total)} bilar (${pPct} / ${fPct} %)`;
}

function fmtFinanced(antal, total) {
  const a = antal == null || antal === "" ? null : Number(antal);
  const t = total == null || total === "" ? null : Number(total);
  if (!Number.isFinite(a) || !Number.isFinite(t)) return "–";
  if (t <= 0) return `${fmtStatNum(a)} / 0`;
  const pct = Math.round((a / t) * 100);
  return `${fmtStatNum(a)} / ${fmtStatNum(t)} (${pct} %)`;
}

function noteHtml(note, { readOnly = false } = {}) {
  const author = note.author_name || "Okänd";
  const id = String(note.id || "");
  const actions = readOnly
    ? ""
    : `<div class="note-actions">
        <button type="button" class="note-act" data-act="edit" title="Redigera" aria-label="Redigera anteckning">✎</button>
        <button type="button" class="note-act note-act-danger" data-act="delete" title="Ta bort" aria-label="Ta bort anteckning">🗑</button>
      </div>`;
  return `<div class="note-item" data-note-id="${escapeAttr(id)}">
    <div class="note-head">
      <div class="meta">${escapeHtml(author)} · ${fmtDateTime(note.created_at)}</div>
      ${actions}
    </div>
    <div class="txt">${escapeHtml(note.note || "")}</div>
  </div>`;
}

function updateLastContactFromList() {
  const lastContact = $("#lastContact");
  if (!lastContact) return;
  const first = document.querySelector("#notesList .note-item .meta");
  if (!first) {
    lastContact.textContent = "Senaste kontakt: –";
    return;
  }
  // meta is "Author · datetime" — keep datetime part if present
  const parts = first.textContent.split(" · ");
  const when = parts.length > 1 ? parts.slice(1).join(" · ") : first.textContent;
  lastContact.textContent = `Senaste kontakt: ${when}`;
}

function renderNotesList(notes, { readOnly = false } = {}) {
  const el = $("#notesList");
  if (!el) return;

  const lastContact = $("#lastContact");
  if (lastContact) {
    lastContact.textContent = notes.length
      ? `Senaste kontakt: ${fmtDateTime(notes[0].created_at)}`
      : "Senaste kontakt: –";
  }

  el.innerHTML = notes.length
    ? notes.map((n) => noteHtml(n, { readOnly })).join("")
    : `<div class="notes-empty">Inga anteckningar ännu.</div>`;
}

function beginNoteEdit(item) {
  if (!item || item.classList.contains("is-editing")) return;
  const txt = item.querySelector(".txt");
  if (!txt) return;
  const current = txt.textContent || "";
  item.classList.add("is-editing");
  txt.outerHTML = `<div class="note-edit">
    <textarea class="note-edit-input" rows="3">${escapeHtml(current)}</textarea>
    <div class="note-edit-actions">
      <button type="button" class="btn btn-prim btn-sm" data-act="save">Spara</button>
      <button type="button" class="btn btn-ghost btn-sm" data-act="cancel">Avbryt</button>
    </div>
  </div>`;
  const input = item.querySelector(".note-edit-input");
  if (input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

function cancelNoteEdit(item) {
  if (!item) return;
  const edit = item.querySelector(".note-edit");
  if (!edit) return;
  const input = item.querySelector(".note-edit-input");
  const original = input?.defaultValue ?? input?.value ?? "";
  edit.outerHTML = `<div class="txt">${escapeHtml(original)}</div>`;
  item.classList.remove("is-editing");
}

async function saveNoteEdit(item) {
  if (!item) return;
  const noteId = item.dataset.noteId;
  const input = item.querySelector(".note-edit-input");
  if (!noteId || !input) return;
  const text = input.value.trim();

  // Tom text = ta bort anteckningen
  if (!text) {
    await deleteNote(item, { skipConfirm: true });
    return;
  }

  const saveBtn = item.querySelector('[data-act="save"]');
  if (saveBtn) saveBtn.disabled = true;
  const { data, error } = await sb
    .from("lead_notes")
    .update({ note: text })
    .eq("id", noteId)
    .select("id")
    .maybeSingle();
  if (error || !data) {
    if (saveBtn) saveBtn.disabled = false;
    toast(
      error
        ? "Kunde inte uppdatera anteckning"
        : "Kunde inte uppdatera — kör supabase/lead_notes_edit.sql i Supabase"
    );
    if (error) console.warn(error);
    return;
  }
  const edit = item.querySelector(".note-edit");
  if (edit) edit.outerHTML = `<div class="txt">${escapeHtml(text)}</div>`;
  item.classList.remove("is-editing");
  const msg = document.getElementById("noteSavedMsg");
  if (msg) {
    msg.classList.add("show");
    setTimeout(() => msg.classList.remove("show"), 2000);
  }
}

async function deleteNote(item, { skipConfirm = false } = {}) {
  if (!item) return;
  const noteId = item.dataset.noteId;
  if (!noteId) return;
  if (!skipConfirm && !window.confirm("Vill du ta bort den här anteckningen?")) return;

  const { data, error } = await sb
    .from("lead_notes")
    .delete()
    .eq("id", noteId)
    .select("id");
  if (error || !data?.length) {
    toast(
      error
        ? "Kunde inte ta bort anteckning"
        : "Kunde inte ta bort — kör supabase/lead_notes_edit.sql i Supabase"
    );
    if (error) console.warn(error);
    return;
  }
  item.remove();
  const list = $("#notesList");
  if (list && !list.querySelector(".note-item")) {
    list.innerHTML = `<div class="notes-empty">Inga anteckningar ännu.</div>`;
  }
  updateLastContactFromList();
  const leadId = selectedLead?.id || dormantLead?.id;
  bumpLeadNoteCount(leadId, -1);
  window.dispatchEvent(new CustomEvent("crm-notes-changed", { detail: { lead_id: leadId } }));
  const msg = document.getElementById("noteSavedMsg");
  if (msg) {
    msg.classList.add("show");
    setTimeout(() => msg.classList.remove("show"), 2000);
  }
}

function bindNotesListActions() {
  const list = $("#notesList");
  if (!list || list.dataset.bound === "1") return;
  list.dataset.bound = "1";
  list.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn || !list.contains(btn)) return;
    const item = btn.closest(".note-item");
    if (!item) return;
    const act = btn.dataset.act;
    if (act === "edit") beginNoteEdit(item);
    else if (act === "cancel") cancelNoteEdit(item);
    else if (act === "save") await saveNoteEdit(item);
    else if (act === "delete") await deleteNote(item);
  });
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
  if (!selectedLead?.id) return;

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

export async function openProspectPanel(stats, { existingLead = null } = {}) {
  if (!stats) return;
  prospectStats = stats;
  // Unassigned CRM row → reclaim via "Tilldela mig"; brand-new dealer → "Skapa lead"
  dormantLead = existingLead && !existingLead.assigned_to ? existingLead : null;
  setSelectedLead(draftLeadFromMarket(stats));
  await renderDealerPanel({ isProspect: true });
}

export async function openPanel(id) {
  prospectStats = null;
  dormantLead = null;
  setSelectedLead(LEADS.find((l) => l.id === id));
  if (!selectedLead) return;
  await renderDealerPanel({ isProspect: false });
}

async function renderDealerPanel({ isProspect }) {
  if (!selectedLead) return;

  const isKreditView = currentView === "kredit";
  const breakdown = scoreBreakdown(selectedLead);
  setPanelChromeMode(isProspect);

  const ring = $("#pRing");
  if (ring) {
    ring.style.display = isKreditView ? "none" : "";
    if (!isKreditView) {
      ring.textContent = selectedLead.score == null ? "–" : selectedLead.score;
      ring.style.background =
        selectedLead.score == null
          ? "#cfd6e2"
          : `conic-gradient(${scoreColor(selectedLead.score)} ${selectedLead.score * 3.6}deg, #eef1f5 0deg)`;
      ring.style.boxShadow = "inset 0 0 0 6px #fff";
    }
  }

  const ownerBadge = isProspect
    ? ""
    : assigneeBadgeHtml(selectedLead.assigned_to, { emptyLabel: true });
  const ownerName = isProspect
    ? "Ej i CRM"
    : selectedLead.assigned_to
      ? profileDisplayName(getProfile(selectedLead.assigned_to))
      : "Otilldelad";

  $("#pName").innerHTML =
    `${escapeHtml(selectedLead.company_name)}${tagsBadgeHtml(selectedLead.tags)}${ownerBadge}`;
  $("#pMeta").textContent = `${formatOrgNr(selectedLead.org_nr) || "–"} · ${selectedLead.city || "–"} · ${ownerName}`;
  $("#followup").value = selectedLead.follow_up_date || "";

  const assignBtn = $("#panelAssignBtn");
  if (assignBtn && !isProspect) {
    const assigned = !!selectedLead.assigned_to;
    const isMine =
      assigned && currentUserId && String(selectedLead.assigned_to) === String(currentUserId);
    assignBtn.textContent = isMine ? ownerName : assigned ? "Ta över" : "Tilldela mig";
    assignBtn.title = isMine
      ? `Tilldelad dig — klicka för att byta`
      : assigned
        ? `Tilldelad: ${ownerName} — klicka för att ta över eller byta`
        : "Tilldela dig eller en kollega";
    assignBtn.classList.toggle("is-assigned", assigned);
    assignBtn.onclick = () => {
      if (!selectedLead?.id) return;
      openAssignModal([selectedLead.id], {
        onDone: () => {
          if (selectedLead?.id) openPanel(selectedLead.id);
        },
      });
    };
  }

  const createBtn = $("#createLeadBtn");
  if (createBtn) {
    createBtn.onclick = () => {
      if (!prospectStats) return;
      openMarketAssignModal(prospectStats, {
        onDone: async (lead) => {
          if (lead?.id) await openPanel(lead.id);
        },
      });
    };
  }

  const addressLines = [selectedLead.address, selectedLead.postal_address].filter(Boolean);
  const addressHtml = addressLines.length
    ? `<div class="p-sec">
      <h4>Adress</h4>
      <div class="p-address">${addressLines.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}</div>
      ${
        selectedLead.lat && selectedLead.lng
          ? `<div class="p-address-map">📍 Visas på kartan</div>`
          : `<div class="p-address-map muted">Ingen kartposition</div>`
      }
    </div>`
    : "";

  const prospectBanner = isProspect
    ? `<div class="p-sec" style="padding-top:0">
        <div class="notenriched" style="margin:0">
          ${
            dormantLead
              ? "Otilldelad i CRM. Tilldela en säljare för att jobba med den under Sälj — anteckningar och historik finns kvar."
              : "Finns inte som lead ännu. Tilldela en säljare för att spara anteckningar, status och kontakter — då syns den under Sälj."
          }
        </div>
      </div>`
    : "";

  const scoreSectionHtml =
    isKreditView || isProspect
      ? ""
      : (() => {
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
          return `<div class="p-sec"><h4>Varför den här poängen</h4>${breakdownHtml}</div>`;
        })();

  const showCreditFlags =
    !isProspect &&
    (isKreditView || ["skickad_kredit", "kund_aktiv"].includes(selectedLead.status));

  const contactsHtml = isProspect && !dormantLead
    ? `<div class="p-sec">
        <h4>Kontaktpersoner</h4>
        <div class="notes-empty">Tilldela säljare för att lägga till kontakter.</div>
      </div>`
    : `<div class="p-sec">
      <h4>Kontaktpersoner</h4>
      <div id="contactsList" style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px"></div>
      ${
        isProspect && dormantLead
          ? `<div class="notes-empty" style="margin-bottom:8px">Historik visas. Tilldela dig för att redigera kontakter.</div>`
          : `<details>
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
      </details>`
      }
    </div>`;

  const statusHtml = isProspect && !dormantLead
    ? `<div class="p-sec">
        <h4>Status</h4>
        <div class="notes-empty">Tilldela säljare för att sätta status (blir Ny).</div>
      </div>`
    : isProspect && dormantLead
      ? `<div class="p-sec">
        <h4>Status</h4>
        <div class="notes-empty">Senaste status: ${escapeHtml(
          STATUS[dormantLead.status]?.label || dormantLead.status || "–"
        )} — tilldela dig för att ändra.</div>
      </div>`
    : `<div class="p-sec">
      <h4>Status</h4>
      <div class="status-switch" id="ssw">
        ${Object.entries(STATUS)
          .map(
            ([key, val]) =>
              `<button class="ss-btn ${selectedLead.status === key ? "on" : ""}" data-s="${key}"><span class="dot"></span>${val.switchLabel || val.label}</button>`
          )
          .join("")}
      </div>
    </div>`;

  const tagsHtml = isProspect && !dormantLead
    ? `<div class="p-sec">
        <h4>Taggar</h4>
        <div class="notes-empty">Tilldela säljare för att lägga till taggar.</div>
      </div>`
    : `<div class="p-sec tags-section">
        <h4>Taggar</h4>
        ${tagChipsHtml(selectedLead.tags || [], { editable: !(isProspect && dormantLead) })}
        ${
          isProspect && dormantLead
            ? `<div class="notes-empty" style="margin-top:8px">Tilldela dig för att ändra taggar.</div>`
            : `<div class="tag-add-row">
          <input type="text" id="newTagInput" list="panelTagSuggestions" class="dateinput" placeholder="Lägg till tagg…" autocomplete="off" />
          <datalist id="panelTagSuggestions"></datalist>
          <button type="button" class="btn btn-prim btn-sm" id="addTagBtn">Lägg till</button>
        </div>
        <p class="tag-hint muted">Dubbelklicka på en tagg för att byta namn (påverkar alla leads).</p>`
        }
      </div>`;

  const notesHtml = isProspect && !dormantLead
    ? `<div class="p-sec notes-section">
        <h4>Anteckningar</h4>
        <div class="notes-empty">Tilldela säljare för att spara anteckningar.</div>
      </div>`
    : `<div class="p-sec notes-section">
      <h4>Anteckningar</h4>
      <div class="notes-meta" id="lastContact">Senaste kontakt: –</div>
      ${
        isProspect && dormantLead
          ? ""
          : `<textarea id="newNote" placeholder="Skriv en ny anteckning…"></textarea>
      <div class="notes-foot">
        <button class="btn btn-prim" id="addNoteBtn">Lägg till anteckning</button>
        <span class="saved" id="noteSavedMsg">✓ Sparat</span>
      </div>`
      }
      <div class="notes-list" id="notesList"><div class="notes-empty">Laddar anteckningar…</div></div>
    </div>`;

  $("#pBody").innerHTML = `
    ${prospectBanner}
    ${scoreSectionHtml}
    <div class="p-sec">
      <div class="p-sec-head">
        <h4>Nyckeltal</h4>
        ${isProspect ? "" : `<button class="btn-link" id="editLeadBtnInline">Redigera</button>`}
      </div>
      <div class="kpis">
        <div class="kpi"><div class="v num">${fmtMSEK(selectedLead.revenue)}</div><div class="l">Omsättning</div></div>
        <div class="kpi"><div class="v num">${fmtMSEK(selectedLead.result_after_fin)}</div><div class="l">Resultat</div></div>
        <div class="kpi"><div class="v num">${fmtMSEK(selectedLead.equity)}</div><div class="l">Eget kapital</div></div>
        <div class="kpi"><div class="v num">${selectedLead.solidity != null ? selectedLead.solidity + " %" : "–"}</div><div class="l">Soliditet</div></div>
        <div class="kpi"><div class="v num">${selectedLead.employees ?? "–"}</div><div class="l">Anställda</div></div>
      </div>
    </div>
    <div class="p-sec">
      <div class="p-sec-head">
        <h4 style="display:flex;align-items:center;gap:6px;margin:0">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M5 17h14v-5l-1.5-4.5A2 2 0 0 0 15.6 6H8.4a2 2 0 0 0-1.9 1.5L5 12v5z"/>
            <path d="M5 12h14"/>
            <circle cx="7.5" cy="17.5" r="1.5"/>
            <circle cx="16.5" cy="17.5" r="1.5"/>
          </svg>
          Fordonsdata
        </h4>
        <button type="button" class="btn-link has-tip" id="fetchBilstatistikBtn"
          data-tip="Hämtar varje fordon för denna handlare (fordonsnivå).&#10;&#10;Sålda = retail senaste 12 mån — sale-and-leaseback och övriga icke-sälj ingår inte.&#10;&#10;Beräknar även % lagerfinans och privat/företag.&#10;&#10;Skriver över trubbig bulk-data för lager och sälj på denna handlare.">
          Hämta bilstatistik
        </button>
      </div>
      <div class="kpis">
        <div class="kpi">
          <div class="v num" id="kpiLager">–</div>
          <div class="l has-tip" data-tip="Operativt lager på fordonsnivå (brukare = handlare), inkl. lagerfinansierade bilar.">I lager</div>
        </div>
        <div class="kpi">
          <div class="v num" id="kpiSaljLeasing">–</div>
          <div class="l has-tip" data-tip="Retail-sälj senaste 12 mån.&#10;&#10;Sale-and-leaseback (finans äger, handlare brukar) och andra icke-sälj ingår inte.">Antal sålda bilar 12 mån</div>
        </div>
        <div class="kpi kpi-tip" id="kpiFinansieratCard" data-tip="">
          <div class="v num v-sm" id="kpiFinansierat">–</div>
          <div class="l has-tip" data-tip="Andel av lagret där ägaren inte är handlaren. Hover på siffran för fördelning per finansbolag.">Finansierat lager</div>
        </div>
        <div class="kpi">
          <div class="v num v-sm" id="kpiSaljSplit">–</div>
          <div class="l has-tip" data-tip="Uppdelning av retail-sälj (privat vs företag). Samma underlag som sålda — S&amp;L ingår inte.">Privat / Företag</div>
        </div>
      </div>
      <div class="fordonsdata-meta muted" id="fordonsdataMeta"></div>
    </div>
    ${addressHtml}
    ${showCreditFlags ? creditFlagsHtml(selectedLead) : ""}
    ${contactsHtml}
    ${tagsHtml}
    ${statusHtml}
    ${notesHtml}`;

  const editInline = document.getElementById("editLeadBtnInline");
  if (editInline) {
    editInline.onclick = () => {
      import("./customer-modal.js").then(({ openEditModal }) => openEditModal(selectedLead.id));
    };
  }

  const fordonsOrg = normalizeOrgNr(selectedLead.org_nr);
  const applyFordonsdata = (stats) => {
    if (!selectedLead || normalizeOrgNr(selectedLead.org_nr) !== fordonsOrg) return;
    const lager = $("#kpiLager");
    const finans = $("#kpiFinansierat");
    const finansCard = $("#kpiFinansieratCard");
    const salj = $("#kpiSaljLeasing");
    const split = $("#kpiSaljSplit");
    const meta = $("#fordonsdataMeta");
    if (lager) lager.textContent = fmtStatNum(stats?.lagerantal);
    if (finans) {
      finans.textContent = fmtFinanced(stats?.lager_finansierat_antal, stats?.lagerantal);
    }
    if (finansCard) {
      const list = stats?.lager_finansbolag;
      const tip =
        Array.isArray(list) && list.length
          ? list.map((x) => `${x.name}: ${fmtStatNum(x.count)}`).join("\n")
          : "Inga lagerfinansierade bilar";
      finansCard.dataset.tip = tip;
      finansCard.title = tip.replace(/\n/g, " · ");
    }
    if (salj) salj.textContent = fmtStatNum(stats?.saljvolym_12m);
    if (split) {
      split.textContent = fmtStatSplit(stats?.salj_privat_12m, stats?.salj_foretag_12m);
    }
    if (meta) {
      meta.textContent = stats?.updated_at
        ? `Uppdaterad ${fmtDateTime(stats.updated_at)}`
        : "";
    }
  };

  if (isProspect && prospectStats) applyFordonsdata(prospectStats);
  loadDealerMarketStats(selectedLead.org_nr).then(applyFordonsdata);

  const fetchBtn = document.getElementById("fetchBilstatistikBtn");
  if (fetchBtn) {
    fetchBtn.onclick = async () => {
      if (!selectedLead) return;
      const orgNr = normalizeOrgNr(selectedLead.org_nr);
      if (!orgNr) {
        toast("Saknar giltigt organisationsnummer");
        return;
      }
      fetchBtn.disabled = true;
      fetchBtn.textContent = "Hämtar…";
      try {
        const result = await fetchBilstatistikInventory(orgNr, selectedLead.company_name);
        if (result?.error || result?.ok === false) {
          toast(result?.error || "Kunde inte hämta bilstatistik");
          return;
        }
        applyFordonsdata({
          lagerantal: result.lagerantal,
          lager_finansierat_antal: result.lager_finansierat_antal,
          lager_finansbolag: result.lager_finansbolag,
          saljvolym_12m: result.saljvolym_12m,
          salj_privat_12m: result.salj_privat_12m,
          salj_foretag_12m: result.salj_foretag_12m,
          updated_at: result.updated_at,
        });
        const fresh = await loadDealerMarketStats(orgNr);
        applyFordonsdata(fresh);
        if (prospectStats && normalizeOrgNr(prospectStats.org_nr) === orgNr) {
          prospectStats = { ...prospectStats, ...fresh };
        }
        const excludedBits = [];
        if (result.sale_leaseback) excludedBits.push(`−${result.sale_leaseback} S&L`);
        if (result.sales_non_sale) excludedBits.push(`−${result.sales_non_sale} övrigt`);
        toast(
          `Uppdaterat: lager ${fmtStatNum(result.lagerantal)}` +
            ` · finansierat ${fmtFinanced(result.lager_finansierat_antal, result.lagerantal)}` +
            ` · sålda ${fmtStatNum(result.saljvolym_12m)}` +
            (excludedBits.length ? ` (${excludedBits.join(", ")})` : "")
        );
        window.dispatchEvent(
          new CustomEvent("dealer-market-stats-updated", { detail: { org_nr: orgNr } })
        );
      } catch (err) {
        console.error(err);
        toast(err.message || "Kunde inte hämta bilstatistik");
      } finally {
        fetchBtn.disabled = false;
        fetchBtn.textContent = "Hämta bilstatistik";
      }
    };
  }

  if (!isProspect) {
    ["flagKyc", "flagPm", "flagBeviljad"].forEach((flagId) => {
      const el = document.getElementById(flagId);
      if (el) el.onchange = saveCreditFlags;
    });

    const saveContact = document.getElementById("saveContact");
    if (saveContact) {
      saveContact.onclick = async () => {
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
    }

    const ssw = document.getElementById("ssw");
    if (ssw) {
      ssw.onclick = async (e) => {
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
          // Keep lead visible on Sälj after status change (e.g. → Kredit önskas)
          if (currentView !== "kredit" && filterState.status !== "alla" && filterState.status !== newStatus) {
            filterState.status = "alla";
          }
          renderAll();
        } else {
          toast("Kunde inte byta status — kör supabase/lead_statuses.sql i Supabase");
        }
      };
    }

    const addNoteBtn = document.getElementById("addNoteBtn");
    if (addNoteBtn) {
      addNoteBtn.onclick = async () => {
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
          bindNotesListActions();
          bumpLeadNoteCount(selectedLead.id, 1);
          window.dispatchEvent(
            new CustomEvent("crm-notes-changed", { detail: { lead_id: selectedLead.id } })
          );

          const lastContact = document.getElementById("lastContact");
          if (lastContact) lastContact.textContent = `Senaste kontakt: ${fmtDateTime(data.created_at)}`;
        } else {
          toast("Kunde inte spara anteckning");
        }
      };
    }

    bindNotesListActions();
    bindLeadTagUi();
  }

  $("#panel").classList.add("open");
  $("#scrim").classList.add("open");
  renderTable();

  if (isProspect && !dormantLead) return;

  const id = isProspect ? dormantLead.id : selectedLead.id;
  const notesRes = await sb
    .from("lead_notes")
    .select("*")
    .eq("lead_id", id)
    .order("created_at", { ascending: false });

  if (isProspect) {
    if (!dormantLead || dormantLead.id !== id) return;
  } else if (!selectedLead || selectedLead.id !== id) {
    return;
  }

  if (notesRes.error) {
    document.getElementById("notesList").innerHTML =
      `<div class="notes-empty">Kunde inte hämta anteckningar.</div>`;
  } else {
    renderNotesList(notesRes.data || [], { readOnly: !!isProspect && !!dormantLead });
  }

  loadContacts(id);
  if (!isProspect) bindNotesListActions();
}

export function closePanel() {
  $("#panel")?.classList.remove("open");
  $("#scrim")?.classList.remove("open");
  prospectStats = null;
  dormantLead = null;
  setSelectedLead(null);
  setPanelChromeMode(false);
  renderTable();
}
