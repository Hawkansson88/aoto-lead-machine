import { CREDIT_FLAG_FILTERS, CREDIT_STATUSES } from "./constants.js";
import { LEADS, filterState, currentView } from "./store.js";

/** Return leads matching current filters, sorted by active column. */
export function getVisibleLeads() {
  const filtered = LEADS.filter((lead) => {
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
      if (filterState.status === "alla") {
        if (lead.status === "ejaktuell") return false;
      } else if (lead.status !== filterState.status) {
        return false;
      }
      if (filterState.dnb === "dnb" && !lead.is_dnb) return false;
      if (filterState.dnb === "ej_dnb" && lead.is_dnb) return false;
      if ((lead.score || 0) < filterState.minScore) return false;
      if (filterState.revMin != null && lead.revenue != null && lead.revenue / 1e6 < filterState.revMin) {
        return false;
      }
      if (filterState.revMax != null && lead.revenue != null && lead.revenue / 1e6 > filterState.revMax) {
        return false;
      }
    }

    if (filterState.q) {
      const haystack =
        `${lead.company_name} ${lead.city} ${lead.address || ""} ${lead.postal_address || ""} ${lead.org_nr || ""}`.toLowerCase();
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

    if (typeof x === "string") {
      x = (x || "").toLowerCase();
      y = (y || "").toLowerCase();
      return x < y ? -sortDir : x > y ? sortDir : 0;
    }

    return ((x || 0) - (y || 0)) * sortDir;
  });
}

/** Credit leads for stats (ignores UI flag filters except active toggle). */
export function getCreditPool() {
  return LEADS.filter((lead) => {
    if (!CREDIT_STATUSES.includes(lead.status)) return false;
    if (!filterState.showActive && lead.status === "kund_aktiv") return false;
    return true;
  });
}
