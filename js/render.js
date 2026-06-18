import { STATUS } from "./constants.js";
import { getVisibleLeads } from "./filters.js";
import { LEADS, filterState, selectedLead } from "./store.js";
import {
  $,
  todayStr,
  fmtMSEK,
  scoreColor,
  followupInfo,
} from "./utils.js";

let onRowClick = () => {};

/** Wire row click handler (avoids circular import with panel.js). */
export function setRowClickHandler(handler) {
  onRowClick = handler;
}

export function renderStats() {
  const meetings = LEADS.filter((l) => l.status === "mote").length;
  const hot = LEADS.filter((l) => l.score >= 80 && l.status !== "ejaktuell").length;
  const followups = LEADS.filter(
    (l) => l.follow_up_date && l.follow_up_date <= todayStr() && l.status !== "ejaktuell"
  ).length;
  const untouched = LEADS.filter((l) => l.status === "ny" && l.score >= 80).length;

  $("#stats").innerHTML = `
    <div class="stat mote"><span class="spark">📅</span><div class="v num">${meetings}</div><div class="l">Möten bokade</div></div>
    <div class="stat hot"><span class="spark">🔥</span><div class="v num">${hot}</div><div class="l">Heta leads (80+)</div></div>
    <div class="stat followup"><span class="spark">⏰</span><div class="v num">${followups}</div><div class="l">Uppföljning idag/försenad</div></div>
    <div class="stat untouched"><span class="spark">✦</span><div class="v num">${untouched}</div><div class="l">Orörda · score 80+</div></div>`;
}

export function renderStatusFilter() {
  const counts = { alla: LEADS.length };
  Object.keys(STATUS).forEach((key) => {
    counts[key] = LEADS.filter((l) => l.status === key).length;
  });

  const item = (key, label, col) =>
    `<div class="status-item ${filterState.status === key ? "active" : ""}" data-st="${key}">
      <span class="dot" style="background:${col}"></span>${label}
      <span class="cnt">${counts[key] || 0}</span>
    </div>`;

  $("#statusList").innerHTML =
    item("alla", "Alla leads", "#7f8eaa") +
    Object.entries(STATUS)
      .map(([key, val]) => item(key, val.label, val.col))
      .join("");
}

export function renderTable() {
  const rows = getVisibleLeads();
  $("#resultCount").textContent = rows.length;

  const tbody = $("#rows");
  $("#empty").style.display = rows.length ? "none" : "block";

  tbody.innerHTML = rows
    .map((lead) => {
      const st = STATUS[lead.status] || STATUS.ny;
      const fu = followupInfo(lead.follow_up_date);
      const scoreCell =
        lead.score == null
          ? `<div class="score-cell"><span class="score-num" style="color:var(--faint)">–</span><span class="score-bar"></span></div>`
          : `<div class="score-cell">
              <span class="score-num" style="color:${scoreColor(lead.score)}">${lead.score}</span>
              <span class="score-bar">
                <span class="score-fill" style="width:${lead.score}%;background:${scoreColor(lead.score)}"></span>
              </span>
            </div>`;

      return `<tr data-id="${lead.id}" class="${selectedLead && selectedLead.id === lead.id ? "sel" : ""}">
        <td class="right">${scoreCell}</td>
        <td><div class="co-name">${lead.company_name}</div><div class="co-org num">${lead.org_nr || "org.nr ej hämtat"}</div></td>
        <td>${lead.city || "–"}</td>
        <td class="right num">${fmtMSEK(lead.revenue)}</td>
        <td class="right num">${lead.employees ?? "–"}</td>
        <td><span class="${fu.cls}">${fu.label}</span></td>
        <td><span class="badge ${st.cls}"><span class="dot"></span>${st.label}</span></td>
      </tr>`;
    })
    .join("");

  tbody.querySelectorAll("tr").forEach((tr) => {
    tr.onclick = () => onRowClick(+tr.dataset.id);
  });
}

export function renderAll() {
  renderStats();
  renderStatusFilter();
  renderTable();
}
