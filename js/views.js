import { ROLES } from "./constants.js";
import {
  currentUserRole,
  currentView,
  setCurrentView,
  filterState,
  clearSelection,
} from "./store.js";
import { renderAll, renderTableHeader } from "./render.js";
import { closePanel } from "./panel.js";
import { $ } from "./utils.js";

export function homeViewForRole(role) {
  return ROLES[role]?.homeView || "salj";
}

export function applyView(view, { resetFilters = true } = {}) {
  setCurrentView(view);
  clearSelection();
  closePanel();

  if (resetFilters) {
    filterState.status = "alla";
    filterState.creditFlag = "alla";
    filterState.dnb = "alla";
    filterState.q = "";
    const search = $("#search");
    if (search) search.value = "";

    if (view === "kredit") {
      filterState.sortKey = "company_name";
      filterState.sortDir = 1;
      filterState.showActive = false;
      const showActive = $("#showActiveToggle");
      if (showActive) showActive.checked = false;
    } else {
      filterState.sortKey = "follow_up_date";
      filterState.sortDir = 1;
    }
  }

  updateViewChrome();
  renderTableHeader();
  renderAll();
}

export function updateViewChrome() {
  const isKredit = currentView === "kredit";

  document.querySelectorAll(".view-nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === currentView);
  });

  const title = $("#pageTitle");
  const sub = $("#pageSub");
  if (title) title.textContent = isKredit ? "Kredit" : "Bilhandlare";
  if (sub) {
    if (isKredit) {
      sub.innerHTML = `<span id="resultCount">0</span> handlare i kreditprocess`;
    } else {
      sub.innerHTML = `<span id="resultCount">0</span> leads · mina kunder`;
    }
  }

  const saljOnly = document.querySelectorAll("[data-salj-only]");
  saljOnly.forEach((el) => {
    el.style.display = isKredit ? "none" : "";
  });

  const kreditOnly = document.querySelectorAll("[data-kredit-only]");
  kreditOnly.forEach((el) => {
    el.style.display = isKredit ? "" : "none";
  });

  const mapBtn = $("#mapBtn");
  const newCustomerBtn = $("#newCustomerBtn");
  if (mapBtn) mapBtn.style.display = isKredit ? "none" : "";
  if (newCustomerBtn) newCustomerBtn.style.display = isKredit ? "none" : "";
}

export function switchToHomeView() {
  applyView(homeViewForRole(currentUserRole));
}

export function bindViewNav() {
  const nav = $("#viewNav");
  if (!nav) return;

  nav.onclick = (e) => {
    const btn = e.target.closest(".view-nav-btn[data-view]");
    if (!btn || btn.dataset.view === currentView) return;
    applyView(btn.dataset.view);
  };

  const showActive = $("#showActiveToggle");
  if (showActive) {
    showActive.onchange = () => {
      filterState.showActive = showActive.checked;
      renderAll();
    };
  }
}
