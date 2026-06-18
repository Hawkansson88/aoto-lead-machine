import { getVisibleLeads } from "./filters.js";
import { bulkUpdateStatus, bulkFlagDnb, bulkUnflagDnb } from "./data.js";
import { renderAll, renderTable, renderBulkBar } from "./render.js";
import {
  LEADS,
  selectedIds,
  clearSelection,
  currentUserId,
} from "./store.js";
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

export function bindSelectionEvents() {
  $("#bulkNotInterested").onclick = bulkMarkNotInterested;
  $("#bulkDnb").onclick = bulkToggleDnb;
  $("#bulkClear").onclick = clearBulkSelection;
  $("#selectAll").onclick = handleSelectAllClick;
}
