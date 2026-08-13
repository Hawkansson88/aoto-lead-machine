import { CREDIT_FLAG_FILTERS, CREDIT_STATUSES } from "./constants.js";
import { LEADS, filterState, currentView, currentUserId } from "./store.js";

function sameUserId(a, b) {
  if (a == null || b == null) return false;
  return String(a).toLowerCase().replace(/-/g, "") === String(b).toLowerCase().replace(/-/g, "");
}

/** Leads in current view scope.
 *  Sälj: dina tilldelade leads — alla statusar, inkl. "Kredit önskas" / "Kund aktiv".
 *  Kredit: hela kreditkön (alla leads i kreditstatus, oavsett säljare). */
export function getScopedLeads() {
  if (currentView === "kredit") {
    return LEADS.filter((lead) => CREDIT_STATUSES.includes(lead.status));
  }
  if (!currentUserId) return [];
  return LEADS.filter((lead) => sameUserId(lead.assigned_to, currentUserId));
}

/** Return leads matching current filters, sorted by active column. */
export function getVisibleLeads() {
  const filtered = getScopedLeads().filter((lead) => {
    if (currentView === "kredit") {
      if (!CREDIT_STATUSES.includes(lead.status)) return false;
      if (!filterState.showActive && lead.status === "kund_aktiv") return false;
      if (filterState.status === "alla") {
        // already filtered kund_aktiv above when showActive is false
      } else if (lead.status !== filterState.status) {
        return false;
      }
      const flag = CREDIT_FLAG_FILTERS[filterState.creditFlag];
      if (flag?.field) {
        const val = !!lead[flag.field];
        if (val !== flag.value) return false;
      }
    } else {
      // Sälj: visa alla mina leads (inkl. Kredit önskas). Endast "Ej intressant" döljs under Alla.
      const statusFilter = filterState.status || "alla";
      if (statusFilter === "alla") {
        if (lead.status === "ejaktuell") return false;
      } else if (lead.status !== statusFilter) {
        return false;
      }
      const tagFilter = filterState.tag;
      if (tagFilter && tagFilter !== "alla") {
        const has = (lead.tags || []).some((t) => String(t.id) === String(tagFilter));
        if (!has) return false;
      }
    }

    if (filterState.q) {
      const tagHay = (lead.tags || []).map((t) => t.name).join(" ");
      const haystack =
        `${lead.company_name} ${lead.city} ${lead.address || ""} ${lead.postal_address || ""} ${lead.org_nr || ""} ${tagHay}`.toLowerCase();
      if (!haystack.includes(filterState.q.toLowerCase())) return false;
    }
    return true;
  });

  const { sortKey, sortDir } = filterState;

  return filtered.sort((a, b) => {
    let x = a[sortKey];
    let y = b[sortKey];

    if (sortKey === "follow_up_date") {
      if (!x && !y) return 0;
      if (!x) return 1;
      if (!y) return -1;
      return x < y ? -sortDir : x > y ? sortDir : 0;
    }

    if (sortKey === "kyc_approved" || sortKey === "kredit_pm_klart" || sortKey === "kredit_beviljad") {
      return ((x ? 1 : 0) - (y ? 1 : 0)) * sortDir;
    }

    if (typeof x === "string" || typeof y === "string") {
      x = (x || "").toString().toLowerCase();
      y = (y || "").toString().toLowerCase();
      return x < y ? -sortDir : x > y ? sortDir : 0;
    }

    return ((x || 0) - (y || 0)) * sortDir;
  });
}

/** Credit leads for stats (ignores UI flag filters except active toggle). */
export function getCreditPool() {
  return getScopedLeads().filter((lead) => {
    if (!CREDIT_STATUSES.includes(lead.status)) return false;
    if (!filterState.showActive && lead.status === "kund_aktiv") return false;
    return true;
  });
}
