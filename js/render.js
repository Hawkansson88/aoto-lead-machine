import { STATUS, DNB_FILTERS, CREDIT_STATUSES, CREDIT_FLAG_FILTERS } from "./constants.js";
import { getVisibleLeads, getCreditPool } from "./filters.js";
import {
  LEADS,
  filterState,
  selectedLead,
  selectedIds,
  toggleSelection,
  currentView,
} from "./store.js";
import {
  $,
  todayStr,
  fmtMSEK,
  scoreColor,
  followupInfo,
  formatOrgNr,
} from "./utils.js";

let onRowClick = () => {};

/** Wire row click handler (avoids circular import with panel.js). */
export function setRowClickHandler(handler) {
  onRowClick = handler;
}

export function renderBulkBar() {
  const bar = $("#bulkBar");
  if (!bar) return;
  if (currentView === "kredit") {
    bar.classList.remove("show");
    return;
  }

  const count = selectedIds.size;
  bar.classList.toggle("show", count > 0);
  $("#bulkCount").textContent = `${count} valda`;

  const dnbBtn = $("#bulkDnb");
  if (!dnbBtn || count === 0) return;

  const selected = [...selectedIds]
    .map((id) => LEADS.find((l) => l.id === id))
    .filter(Boolean);
  const allDnb = selected.length > 0 && selected.every((l) => l.is_dnb);

  dnbBtn.textContent = allDnb ? "Ta bort DNB-flagga" : "Flagga som DNB-kund";
  dnbBtn.classList.toggle("bulk-dnb-remove", allDnb);
}

export function renderStats() {
  const el = $("#stats");
  if (!el) return;

  if (currentView === "kredit") {
    const pool = getCreditPool();
    const pending = pool.filter((l) => l.status !== "kund_aktiv").length;
    const waiting = LEADS.filter((l) => l.status === "invantar_aterkoppling").length;
    const kycDone = pool.filter((l) => l.kyc_approved).length;
    const approved = pool.filter((l) => l.kredit_beviljad).length;

    el.innerHTML = `
      <div class="stat mote"><span class="spark">⏳</span><div class="v num">${pending}</div><div class="l">I kreditprocess</div></div>
      <div class="stat followup"><span class="spark">↩</span><div class="v num">${waiting}</div><div class="l">Inväntar återkoppling</div></div>
      <div class="stat hot"><span class="spark">✓</span><div class="v num">${kycDone}</div><div class="l">KYC beviljad</div></div>
      <div class="stat untouched"><span class="spark">★</span><div class="v num">${approved}</div><div class="l">Kredit beviljad</div></div>`;
    return;
  }

  const meetings = LEADS.filter((l) => l.status === "mote").length;
  const hot = LEADS.filter((l) => l.score >= 80 && l.status !== "ejaktuell").length;
  const followups = LEADS.filter(
    (l) => l.follow_up_date && l.follow_up_date <= todayStr() && l.status !== "ejaktuell"
  ).length;
  const untouched = LEADS.filter((l) => l.status === "ny" && l.score >= 80).length;

  el.innerHTML = `
    <div class="stat mote"><span class="spark">📅</span><div class="v num">${meetings}</div><div class="l">Möten bokade</div></div>
    <div class="stat hot"><span class="spark">🔥</span><div class="v num">${hot}</div><div class="l">Heta leads (80+)</div></div>
    <div class="stat followup"><span class="spark">⏰</span><div class="v num">${followups}</div><div class="l">Uppföljning idag/försenad</div></div>
    <div class="stat untouched"><span class="spark">✦</span><div class="v num">${untouched}</div><div class="l">Orörda · score 80+</div></div>`;
}

export function renderStatusFilter() {
  const el = $("#statusList");
  if (!el) return;

  if (currentView === "kredit") {
    const pool = getCreditPool();
    const counts = { alla: pool.length };
    CREDIT_STATUSES.forEach((key) => {
      counts[key] = LEADS.filter((l) => {
        if (l.status !== key) return false;
        if (!filterState.showActive && key === "kund_aktiv") return false;
        return true;
      }).length;
    });

    const item = (key, label, col) =>
      `<div class="status-item ${filterState.status === key ? "active" : ""}" data-st="${key}">
        <span class="dot" style="background:${col}"></span>${label}
        <span class="cnt">${counts[key] || 0}</span>
      </div>`;

    el.innerHTML =
      item("alla", "Alla i kredit", "#7f8eaa") +
      CREDIT_STATUSES.map((key) => {
        const val = STATUS[key];
        return item(key, val.label, val.col);
      }).join("");
    return;
  }

  const counts = { alla: LEADS.filter((l) => l.status !== "ejaktuell").length };
  Object.keys(STATUS).forEach((key) => {
    counts[key] = LEADS.filter((l) => l.status === key).length;
  });

  const item = (key, label, col) =>
    `<div class="status-item ${filterState.status === key ? "active" : ""}" data-st="${key}">
      <span class="dot" style="background:${col}"></span>${label}
      <span class="cnt">${counts[key] || 0}</span>
    </div>`;

  el.innerHTML =
    item("alla", "Alla leads", "#7f8eaa") +
    Object.entries(STATUS)
      .map(([key, val]) => item(key, val.label, val.col))
      .join("");
}

export function renderDnbFilter() {
  const el = $("#dnbFilterList");
  if (!el) return;

  if (currentView === "kredit") {
    el.innerHTML = "";
    return;
  }

  const counts = {
    alla: LEADS.length,
    dnb: LEADS.filter((l) => l.is_dnb).length,
    ej_dnb: LEADS.filter((l) => !l.is_dnb).length,
  };

  el.innerHTML = Object.entries(DNB_FILTERS)
    .map(
      ([key, val]) =>
        `<div class="status-item ${filterState.dnb === key ? "active" : ""}" data-dnb="${key}">
          <span class="dot" style="background:${val.col}"></span>${val.label}
          <span class="cnt">${counts[key] || 0}</span>
        </div>`
    )
    .join("");
}

export function renderCreditFlagFilter() {
  const el = $("#creditFlagList");
  if (!el) return;

  if (currentView !== "kredit") {
    el.innerHTML = "";
    return;
  }

  const pool = getCreditPool();
  el.innerHTML = Object.entries(CREDIT_FLAG_FILTERS)
    .map(([key, val]) => {
      let count = pool.length;
      if (val.field) {
        count = pool.filter((l) => !!l[val.field] === val.value).length;
      }
      return `<div class="status-item ${filterState.creditFlag === key ? "active" : ""}" data-cflag="${key}">
        <span class="dot" style="background:${val.col}"></span>${val.label}
        <span class="cnt">${count}</span>
      </div>`;
    })
    .join("");
}

function flagCell(ok) {
  return ok
    ? `<span class="flag-pill flag-ok">Klar</span>`
    : `<span class="flag-pill flag-no">Ej klar</span>`;
}

export function renderTable() {
  const rows = getVisibleLeads();
  $("#resultCount").textContent = rows.length;

  const tbody = $("#rows");
  const empty = $("#empty");
  if (!tbody) return;
  if (empty) empty.style.display = rows.length ? "none" : "block";

  const allVisibleSelected = rows.length > 0 && rows.every((l) => selectedIds.has(l.id));
  const someVisibleSelected = rows.some((l) => selectedIds.has(l.id));
  const selectAll = $("#selectAll");
  if (selectAll) {
    selectAll.checked = allVisibleSelected;
    selectAll.indeterminate = someVisibleSelected && !allVisibleSelected;
  }

  if (currentView === "kredit") {
    tbody.innerHTML = rows
      .map((lead) => {
        const st = STATUS[lead.status] || STATUS.skickad_kredit;
        const checked = selectedIds.has(lead.id) ? "checked" : "";
        const dnbBadge = lead.is_dnb ? `<span class="badge-dnb">DNB</span>` : "";

        return `<tr data-id="${lead.id}" class="${selectedLead && selectedLead.id === lead.id ? "sel" : ""}${checked ? " row-checked" : ""}">
          <td>
            <div class="co-name">${lead.company_name}${dnbBadge}</div>
            <div class="co-org num">${formatOrgNr(lead.org_nr) || "–"}</div>
          </td>
          <td>${lead.city || "–"}</td>
          <td>${flagCell(lead.kyc_approved)}</td>
          <td>${flagCell(lead.kredit_pm_klart)}</td>
          <td>${flagCell(lead.kredit_beviljad)}</td>
          <td><span class="badge ${st.cls}"><span class="dot"></span>${st.label}</span></td>
        </tr>`;
      })
      .join("");
  } else {
    tbody.innerHTML = rows
      .map((lead) => {
        const st = STATUS[lead.status] || STATUS.ny;
        const fu = followupInfo(lead.follow_up_date);
        const checked = selectedIds.has(lead.id) ? "checked" : "";
        const scoreCell =
          lead.score == null
            ? `<div class="score-cell"><span class="score-num" style="color:var(--faint)">–</span><span class="score-bar"></span></div>`
            : `<div class="score-cell">
                <span class="score-num" style="color:${scoreColor(lead.score)}">${lead.score}</span>
                <span class="score-bar">
                  <span class="score-fill" style="width:${lead.score}%;background:${scoreColor(lead.score)}"></span>
                </span>
              </div>`;
        const dnbBadge = lead.is_dnb ? `<span class="badge-dnb">DNB</span>` : "";

        return `<tr data-id="${lead.id}" class="${selectedLead && selectedLead.id === lead.id ? "sel" : ""}${checked ? " row-checked" : ""}">
          <td class="check-cell">
            <input type="checkbox" class="row-check" data-id="${lead.id}" ${checked} aria-label="Välj ${lead.company_name}">
          </td>
          <td class="right">${scoreCell}</td>
          <td>
            <div class="co-name">${lead.company_name}${dnbBadge}</div>
            <div class="co-org num">${formatOrgNr(lead.org_nr) || "–"}</div>
          </td>
          <td>${lead.city || "–"}</td>
          <td class="right num">${fmtMSEK(lead.revenue)}</td>
          <td class="right num">${lead.employees ?? "–"}</td>
          <td><span class="${fu.cls}">${fu.label}</span></td>
          <td><span class="badge ${st.cls}"><span class="dot"></span>${st.label}</span></td>
        </tr>`;
      })
      .join("");
  }

  tbody.querySelectorAll("tr").forEach((tr) => {
    tr.onclick = (e) => {
      if (e.target.closest(".row-check")) return;
      onRowClick(+tr.dataset.id);
    };
  });

  tbody.querySelectorAll(".row-check").forEach((cb) => {
    cb.onclick = (e) => {
      e.stopPropagation();
      toggleSelection(+cb.dataset.id);
      renderBulkBar();
      renderTable();
    };
  });
}

export function renderTableHeader() {
  const thead = document.querySelector(".table-scroll thead tr");
  if (!thead) return;

  if (currentView === "kredit") {
    thead.innerHTML = `
      <th data-sort="company_name">Företag</th>
      <th data-sort="city">Stad</th>
      <th data-sort="kyc_approved">KYC</th>
      <th data-sort="kredit_pm_klart">Kredit-PM</th>
      <th data-sort="kredit_beviljad">Kredit beviljad</th>
      <th data-sort="status">Status</th>`;
  } else {
    thead.innerHTML = `
      <th class="check-col">
        <input type="checkbox" id="selectAll" aria-label="Välj alla synliga">
      </th>
      <th data-sort="score" class="right">Score</th>
      <th data-sort="company_name">Företag</th>
      <th data-sort="city">Stad</th>
      <th data-sort="revenue" class="right">Omsättning</th>
      <th data-sort="employees" class="right">Anställda</th>
      <th data-sort="follow_up_date">Uppföljning</th>
      <th data-sort="status">Status</th>`;
  }

  bindHeaderSort();
}

function bindHeaderSort() {
  document.querySelectorAll("thead th[data-sort]").forEach((th) => {
    th.onclick = () => {
      const key = th.dataset.sort;
      if (filterState.sortKey === key) {
        filterState.sortDir *= -1;
      } else {
        filterState.sortKey = key;
        filterState.sortDir =
          key === "company_name" || key === "city" || key === "status" || key === "follow_up_date"
            ? 1
            : -1;
      }

      document.querySelectorAll("thead th .ar").forEach((a) => a.remove());
      const arrow = document.createElement("span");
      arrow.className = "ar";
      arrow.textContent = filterState.sortDir > 0 ? "▲" : "▼";
      th.appendChild(arrow);
      renderTable();
    };
  });
}

export function renderAll() {
  renderStats();
  renderStatusFilter();
  renderDnbFilter();
  renderCreditFlagFilter();
  renderBulkBar();
  renderTable();
}
