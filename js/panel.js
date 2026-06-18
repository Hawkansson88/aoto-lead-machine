import { STATUS } from "./constants.js";
import { scoreBreakdown } from "./scoring.js";
import { LEADS, selectedLead, setSelectedLead, sb } from "./store.js";
import { patchLead, loadContacts } from "./data.js";
import { renderAll, renderTable } from "./render.js";
import {
  $,
  toast,
  fmtMSEK,
  scoreColor,
  scoreBarColor,
  fmtDateTime,
  escapeHtml,
} from "./utils.js";

function noteHtml(note) {
  return `<div class="note-item">
    <div class="meta">${fmtDateTime(note.created_at)}</div>
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
  $("#pMeta").textContent = `${selectedLead.org_nr || "Org.nr ej hämtat"} · ${selectedLead.city || "–"}`;
  $("#followup").value = selectedLead.follow_up_date || "";

  const breakdownHtml = breakdown.notEnriched
    ? `<div class="notenriched">Det här bolaget är inte anrikat ännu. Klicka "⚙ Anrika 20" för att hämta finansiell data.</div>`
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

  $("#pBody").innerHTML = `
    <div class="p-sec"><h4>Varför den här poängen</h4>${breakdownHtml}</div>
    <div class="p-sec">
      <h4>Nyckeltal</h4>
      <div class="kpis">
        <div class="kpi"><div class="v num">${fmtMSEK(selectedLead.revenue)}</div><div class="l">Omsättning</div></div>
        <div class="kpi"><div class="v num">${fmtMSEK(selectedLead.result_after_fin)}</div><div class="l">Resultat e. fin</div></div>
        <div class="kpi"><div class="v num">${selectedLead.employees ?? "–"}</div><div class="l">Anställda</div></div>
        <div class="kpi"><div class="v num">${selectedLead.solidity != null ? selectedLead.solidity + " %" : "–"}</div><div class="l">Soliditet</div></div>
      </div>
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
              `<button class="ss-btn ${selectedLead.status === key ? "on" : ""}" data-s="${key}"><span class="dot"></span>${val.label}</button>`
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
        (id) => (document.getElementById(id).value = "")
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

    const note = { lead_id: selectedLead.id, note: text, created_at: new Date().toISOString() };
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

export function closePanel() {
  $("#panel").classList.remove("open");
  $("#scrim").classList.remove("open");
  setSelectedLead(null);
  renderTable();
}
