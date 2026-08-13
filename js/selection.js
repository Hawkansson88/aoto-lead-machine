import { getVisibleLeads } from "./filters.js";
import {
  bulkUpdateStatus,
  bulkUnassignLeads,
  addTagToLeads,
  removeTagFromLeads,
} from "./data.js";
import { renderAll, renderTable, renderBulkBar } from "./render.js";
import {
  LEADS,
  TAGS,
  selectedIds,
  selectedLead,
  clearSelection,
} from "./store.js";
import { closePanel } from "./panel.js";
import { escapeHtml, escapeAttr, $, toast } from "./utils.js";

function getSelectedLeads() {
  return [...selectedIds]
    .map((id) => LEADS.find((l) => l.id === id))
    .filter(Boolean);
}

function sharedTags(leads) {
  if (!leads.length) return [];
  const maps = leads.map((l) => new Map((l.tags || []).map((t) => [String(t.id), t])));
  const first = [...maps[0].values()];
  return first.filter((t) => maps.every((m) => m.has(String(t.id))));
}

export function handleSelectAllClick(e) {
  e.stopPropagation();
  const visible = getVisibleLeads();
  const allSelected = visible.length > 0 && visible.every((l) => selectedIds.has(l.id));

  if (allSelected) visible.forEach((l) => selectedIds.delete(l.id));
  else visible.forEach((l) => selectedIds.add(l.id));

  renderBulkBar();
  renderTable();
}

export function clearBulkSelection() {
  clearSelection();
  renderBulkBar();
  renderTable();
}

export async function bulkMarkNotInterested() {
  const ids = [...selectedIds];
  if (!ids.length) return;

  const ok = await bulkUpdateStatus(ids, "ejaktuell");
  if (!ok) {
    toast("Kunde inte uppdatera status");
    return;
  }

  ids.forEach((id) => {
    const lead = LEADS.find((l) => l.id === id);
    if (lead) lead.status = "ejaktuell";
  });

  clearSelection();
  renderBulkBar();
  renderAll();
  toast(`${ids.length} markerade som Ej intressant`);
}

function fillTagSuggestions() {
  const list = $("#tagSuggestions");
  if (!list) return;
  list.innerHTML = TAGS.map((t) => `<option value="${escapeAttr(t.name)}"></option>`).join("");
}

function renderSharedTagsInModal(leads) {
  const el = $("#tagModalShared");
  if (!el) return;
  const shared = sharedTags(leads);
  if (!shared.length) {
    el.innerHTML = `<p class="muted" style="margin:12px 0 0;font-size:13px">Inga gemensamma taggar på alla valda.</p>`;
    return;
  }
  el.innerHTML = `
    <p class="section-label" style="margin:16px 0 8px">Gemensamma taggar (klicka för att ta bort från alla)</p>
    <div class="tag-chips">
      ${shared
        .map(
          (t) =>
            `<button type="button" class="tag-chip tag-chip-btn" data-remove-tag="${escapeAttr(String(t.id))}">
              ${escapeHtml(t.name)} <span aria-hidden="true">×</span>
            </button>`
        )
        .join("")}
    </div>`;
}

export function openBulkTagModal() {
  const selected = getSelectedLeads();
  if (!selected.length) return;

  fillTagSuggestions();
  const title = $("#tagModalTitle");
  const sub = $("#tagModalSub");
  if (title) title.textContent = `Tagga ${selected.length} valda`;
  if (sub) sub.textContent = "Lägg till en tagg på alla valda, eller ta bort en gemensam tagg.";
  const input = $("#bulkTagInput");
  if (input) input.value = "";
  renderSharedTagsInModal(selected);

  $("#tagModal")?.classList.add("open");
  $("#tagModalScrim")?.classList.add("open");
  input?.focus();
}

export function closeBulkTagModal() {
  $("#tagModal")?.classList.remove("open");
  $("#tagModalScrim")?.classList.remove("open");
}

export async function bulkAddTagFromModal() {
  const ids = [...selectedIds];
  if (!ids.length) return;
  const input = $("#bulkTagInput");
  const name = input?.value?.trim() || "";
  if (!name) {
    toast("Skriv ett taggnamn");
    return;
  }

  const btn = $("#tagModalAdd");
  if (btn) btn.disabled = true;
  try {
    const result = await addTagToLeads(ids, name);
    if (!result.ok) {
      toast(result.error || "Kunde inte lägga till tagg");
      return;
    }
    toast(`Taggade ${ids.length} med “${result.tag.name}”`);
    clearSelection();
    renderBulkBar();
    renderAll();
    closeBulkTagModal();
  } finally {
    if (btn) btn.disabled = false;
  }
}

export async function bulkRemoveSharedTag(tagId) {
  const ids = [...selectedIds];
  if (!ids.length || tagId == null) return;
  const result = await removeTagFromLeads(ids, tagId);
  if (!result.ok) {
    toast(result.error || "Kunde inte ta bort tagg");
    return;
  }
  toast(`Tog bort tagg från ${ids.length} leads`);
  renderSharedTagsInModal(getSelectedLeads());
  renderAll();
  renderBulkBar();
}

export async function bulkUnassignSelectedLeads() {
  const ids = [...selectedIds];
  if (!ids.length) return;

  const n = ids.length;
  const okConfirm = window.confirm(
    n === 1
      ? "Ta bort tilldelningen?\n\nLeaden försvinner från Sälj men anteckningar och data sparas. Den syns som otilldelad i Marknadsanalys."
      : `Ta bort tilldelning för ${n} leads?\n\nDe försvinner från Sälj men anteckningar och data sparas. De syns som otilldelade i Marknadsanalys.`
  );
  if (!okConfirm) return;

  const btn = $("#bulkUnassign");
  if (btn) btn.disabled = true;
  try {
    const ok = await bulkUnassignLeads(ids);
    if (!ok) {
      toast("Kunde inte ta bort tilldelning");
      return;
    }

    ids.forEach((id) => {
      const lead = LEADS.find((l) => l.id === id);
      if (lead) lead.assigned_to = null;
    });

    if (selectedLead && ids.some((id) => String(id) === String(selectedLead.id))) {
      closePanel();
    }

    clearSelection();
    renderBulkBar();
    renderAll();
    window.dispatchEvent(
      new CustomEvent("crm-lead-changed", { detail: { ids, assigned_to: null } })
    );
    toast(n === 1 ? "Tilldelning borttagen" : `Tilldelning borttagen för ${n} leads`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

export function bindSelectionEvents() {
  $("#bulkNotInterested").onclick = bulkMarkNotInterested;
  $("#bulkTag")?.addEventListener("click", openBulkTagModal);
  $("#bulkUnassign").onclick = bulkUnassignSelectedLeads;
  $("#bulkClear").onclick = clearBulkSelection;

  $("#tagModalClose")?.addEventListener("click", closeBulkTagModal);
  $("#tagModalCancel")?.addEventListener("click", closeBulkTagModal);
  $("#tagModalScrim")?.addEventListener("click", closeBulkTagModal);
  $("#tagModalAdd")?.addEventListener("click", bulkAddTagFromModal);
  $("#bulkTagInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      bulkAddTagFromModal();
    }
  });
  $("#tagModalShared")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remove-tag]");
    if (!btn) return;
    bulkRemoveSharedTag(btn.dataset.removeTag);
  });

  document.querySelector(".table-scroll")?.addEventListener("click", (e) => {
    if (e.target.id === "selectAll") handleSelectAllClick(e);
  });
}
