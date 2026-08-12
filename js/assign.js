import { assignLeads, claimOrCreateLeadFromMarket } from "./data.js";
import {
  LEADS,
  PROFILES,
  selectedIds,
  selectedLead,
  clearSelection,
  currentUserId,
} from "./store.js";
import { renderAll, renderBulkBar } from "./render.js";
import { profileDisplayName, profileInitials } from "./assignees.js";
import { $, toast, escapeHtml, normalizeOrgNr } from "./utils.js";

let pendingLeadIds = [];
let onAssigned = null;
/** @type {Record<string, unknown>|null} */
let pendingMarketStats = null;

/** Assignable = säljare/admin — aldrig kredit. */
function isAssignableProfile(p) {
  const role = String(p?.role || "saljare").toLowerCase();
  return role !== "kredit";
}

function salesProfiles() {
  return [...PROFILES].filter(isAssignableProfile).sort((a, b) =>
    profileDisplayName(a).localeCompare(profileDisplayName(b), "sv")
  );
}

function renderUserList(list, { allowUnassign = true } = {}) {
  if (!list) return;

  const profiles = salesProfiles();
  const meIsSales =
    currentUserId &&
    (profiles.some((p) => String(p.id) === String(currentUserId)) ||
      !PROFILES.some((p) => String(p.id) === String(currentUserId)));

  if (!profiles.length && !meIsSales) {
    list.innerHTML = `<div class="assign-empty">Inga säljare hittades.</div>`;
    return;
  }

  const meFirst =
    currentUserId && meIsSales
      ? `<button type="button" class="assign-user assign-user-me" data-id="${currentUserId}">
      <span class="assignee-badge" title="Jag">Jag</span>
      <span class="assign-user-name">Tilldela mig <span class="muted">(sist vinner)</span></span>
    </button>`
      : "";

  const usersHtml = profiles
    .filter((p) => String(p.id) !== String(currentUserId))
    .map((p) => {
      const name = profileDisplayName(p);
      const initials = profileInitials(p);
      return `<button type="button" class="assign-user" data-id="${p.id}">
        <span class="assignee-badge" title="${escapeHtml(name)}">${escapeHtml(initials)}</span>
        <span class="assign-user-name">${escapeHtml(name)}</span>
      </button>`;
    })
    .join("");

  const unassignHtml = allowUnassign
    ? `<button type="button" class="assign-user assign-user-none" data-id="">
      <span class="assignee-badge assignee-badge-empty" title="Otilldelad">–</span>
      <span class="assign-user-name">Ta bort tilldelning</span>
    </button>`
    : "";

  list.innerHTML = meFirst + usersHtml + unassignHtml;
}

export function openAssignModal(leadIds, { onDone } = {}) {
  pendingLeadIds = [...leadIds];
  pendingMarketStats = null;
  onAssigned = onDone || null;

  const count = pendingLeadIds.length;
  const title = $("#assignModalTitle");
  if (title) {
    title.textContent =
      count === 1 ? "Tilldela säljare" : `Tilldela säljare (${count} valda)`;
  }

  renderUserList($("#assignUserList"), { allowUnassign: true });
  $("#assignModal")?.classList.add("open");
  $("#assignModalScrim")?.classList.add("open");
}

/** Marknadsanalys: skapa/återta lead och tilldela valfri säljare. */
export function openMarketAssignModal(stats, { onDone } = {}) {
  if (!stats) return;
  pendingLeadIds = [];
  pendingMarketStats = stats;
  onAssigned = onDone || null;

  const title = $("#assignModalTitle");
  if (title) title.textContent = "Tilldela säljare";

  renderUserList($("#assignUserList"), { allowUnassign: false });
  $("#assignModal")?.classList.add("open");
  $("#assignModalScrim")?.classList.add("open");
}

export function closeAssignModal() {
  $("#assignModal")?.classList.remove("open");
  $("#assignModalScrim")?.classList.remove("open");
  pendingLeadIds = [];
  pendingMarketStats = null;
  onAssigned = null;
}

async function pickUser(userId) {
  const assignedTo = userId || null;

  if (pendingMarketStats) {
    if (!assignedTo) {
      toast("Välj en säljare");
      return;
    }
    const stats = pendingMarketStats;
    const done = onAssigned;
    const result = await claimOrCreateLeadFromMarket(stats, assignedTo);
    if (result.error) {
      toast(result.error);
      return;
    }
    closeAssignModal();
    renderAll();
    window.dispatchEvent(
      new CustomEvent("crm-lead-changed", {
        detail: {
          org_nr: normalizeOrgNr(result.data.org_nr),
          id: result.data.id,
          assigned_to: assignedTo,
        },
      })
    );
    const profile = PROFILES.find((p) => String(p.id) === String(assignedTo));
    const label = profile ? profileDisplayName(profile) : "säljare";
    toast(
      result.claimed
        ? `Tilldelad: ${label}`
        : `Lead skapad och tilldelad: ${label}`
    );
    if (typeof done === "function") done(result.data);
    return;
  }

  const ids = pendingLeadIds;
  if (!ids.length) return;

  if (assignedTo) {
    const target = PROFILES.find((p) => String(p.id) === String(assignedTo));
    if (target && !isAssignableProfile(target)) {
      toast("Kan bara tilldela säljare (inte kredit)");
      return;
    }
  }

  const ok = await assignLeads(ids, assignedTo);
  if (!ok) {
    toast("Kunde inte tilldela kollega");
    return;
  }

  ids.forEach((id) => {
    const lead = LEADS.find((l) => l.id === id);
    if (lead) lead.assigned_to = assignedTo;
  });

  if (selectedLead && ids.some((id) => String(id) === String(selectedLead.id))) {
    selectedLead.assigned_to = assignedTo;
  }

  const done = onAssigned;
  closeAssignModal();
  clearSelection();
  renderBulkBar();
  renderAll();

  if (!assignedTo && selectedLead && ids.some((id) => String(id) === String(selectedLead.id))) {
    const { closePanel } = await import("./panel.js");
    closePanel();
  } else if (typeof done === "function") {
    done(assignedTo);
  }

  window.dispatchEvent(
    new CustomEvent("crm-lead-changed", { detail: { ids, assigned_to: assignedTo } })
  );

  const profile = assignedTo ? PROFILES.find((p) => p.id === assignedTo) : null;
  const label = profile ? profileDisplayName(profile) : "otilldelad";
  toast(
    ids.length === 1
      ? assignedTo
        ? `Tilldelad: ${label}`
        : "Tilldelning borttagen"
      : assignedTo
        ? `${ids.length} leads tilldelade: ${label}`
        : `Tilldelning borttagen för ${ids.length} leads`
  );
}

export function bindAssignModal() {
  $("#assignModalClose")?.addEventListener("click", closeAssignModal);
  $("#assignModalCancel")?.addEventListener("click", closeAssignModal);
  $("#assignModalScrim")?.addEventListener("click", closeAssignModal);

  $("#assignUserList")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".assign-user");
    if (!btn) return;
    pickUser(btn.dataset.id || null);
  });

  $("#bulkAssign")?.addEventListener("click", () => {
    const ids = [...selectedIds];
    if (!ids.length) return;
    openAssignModal(ids);
  });
}
