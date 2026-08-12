import { getVisibleLeads } from "./filters.js";
import { bulkUpdateStatus, bulkFlagDnb, bulkUnflagDnb, bulkUnassignLeads } from "./data.js";
import { renderAll, renderTable, renderBulkBar } from "./render.js";
import {
  LEADS,
  selectedIds,
  selectedLead,
  clearSelection,
  currentUserId,
} from "./store.js";
import { closePanel } from "./panel.js";
import { $, toast } from "./utils.js";

function getSelectedLeads() {
  return [...selectedIds]
    .map((id) => LEADS.find((l) => l.id === id))
    .filter(Boolean);
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

export async function bulkToggleDnb() {
  const selected = getSelectedLeads();
  if (!selected.length) return;

  const allDnb = selected.every((l) => l.is_dnb);

  if (allDnb) {
    const ids = selected.map((l) => l.id);
    const ok = await bulkUnflagDnb(ids);
    if (!ok) {
      toast("Kunde inte ta bort DNB-flagga");
      return;
    }

    ids.forEach((id) => {
      const lead = LEADS.find((l) => l.id === id);
      if (lead) lead.is_dnb = false;
    });

    clearSelection();
    renderBulkBar();
    renderAll();
    toast(`${ids.length} DNB-flaggor borttagna`);
    return;
  }

  const ids = selected.filter((l) => !l.is_dnb).map((l) => l.id);
  if (!ids.length) return;

  const ok = await bulkFlagDnb(ids, currentUserId);
  if (!ok) {
    toast("Kunde inte flagga som DNB-kund");
    return;
  }

  ids.forEach((id) => {
    const lead = LEADS.find((l) => l.id === id);
    if (lead) lead.is_dnb = true;
  });

  clearSelection();
  renderBulkBar();
  renderAll();
  toast(`${ids.length} flaggade som DNB-kund`);
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
  $("#bulkDnb").onclick = bulkToggleDnb;
  $("#bulkUnassign").onclick = bulkUnassignSelectedLeads;
  $("#bulkClear").onclick = clearBulkSelection;

  // selectAll återskapas när tabellhuvudet byts (sälj/kredit)
  document.querySelector(".table-scroll")?.addEventListener("click", (e) => {
    if (e.target.id === "selectAll") handleSelectAllClick(e);
  });
}
