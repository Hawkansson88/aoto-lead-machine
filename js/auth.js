import {
  loadUserSettings,
  loadLeads,
  saveUserSettings,
  loadUserProfile,
  loadProfiles,
  loadShowAllPreference,
} from "./data.js";
import { closePanel, openPanel } from "./panel.js";
import {
  sb,
  setLeads,
  setAppReady,
  setCurrentUserId,
  setCurrentUserEmail,
  appReady,
  currentUserId,
  currentUserRole,
  filterState,
  clearSelection,
  LEADS,
} from "./store.js";
import { applyView, homeViewForRole } from "./views.js";
import { refreshUserChrome } from "./profile-modal.js";
import { $, toast, normalizeOrgNr } from "./utils.js";

const appEl = $("#app");

export function showApp() {
  appEl.style.display = "grid";
  $("#authGate").classList.remove("show");
}

export function showGate() {
  appEl.style.display = "none";
  $("#authGate").classList.add("show");
  setAppReady(false);
  setLeads([]);
  clearSelection();
  closePanel();
}

function initialViewFromUrl() {
  const view = new URLSearchParams(window.location.search).get("view");
  if (view === "kredit" || view === "salj") return view;
  return homeViewForRole(currentUserRole);
}

function openLeadFromUrl() {
  const orgNr = normalizeOrgNr(new URLSearchParams(window.location.search).get("org_nr"));
  if (!orgNr) return;
  const lead = LEADS.find((l) => l.org_nr === orgNr);
  if (lead) openPanel(lead.id);
  else toast("Ingen handlare med det org.nr hittades i CRM");
}

export async function enterApp(session) {
  showApp();
  setCurrentUserId(session.user.id);

  const email = session?.user?.email || "";
  setCurrentUserEmail(email);

  await loadUserProfile(session.user.id, email);
  refreshUserChrome();

  // Token refresh / tab focus also emits SIGNED_IN — don't reset view or close panel
  if (appReady) return;

  setAppReady(true);
  try {
    loadShowAllPreference();
    await loadUserSettings(currentUserId);
    await Promise.all([loadLeads(), loadProfiles()]);
    applyView(initialViewFromUrl());
    openLeadFromUrl();
  } catch (err) {
    console.error(err);
    toast("Kunde inte hämta leads – kontrollera RLS-policy");
  }
}

export async function doLogin() {
  const email = $("#authEmail").value.trim();
  const password = $("#authPw").value;
  const btn = $("#authBtn");
  const err = $("#authErr");

  err.textContent = "";
  if (!email || !password) {
    err.textContent = "Fyll i e-post och lösenord.";
    return;
  }

  btn.disabled = true;
  btn.textContent = "Loggar in…";

  const { error } = await sb.auth.signInWithPassword({ email, password });

  btn.disabled = false;
  btn.textContent = "Logga in";
  if (error) err.textContent = "Fel e-post eller lösenord.";
}

export async function saveFilters() {
  if (!currentUserId) return;

  const ok = await saveUserSettings(currentUserId, {
    tag: filterState.tag,
  });

  if (ok) {
    const msg = $("#filterSavedMsg");
    if (msg) {
      msg.classList.add("show");
      setTimeout(() => msg.classList.remove("show"), 2000);
    }
  } else {
    toast("Kunde inte spara filter");
  }
}

export function bindAuthEvents() {
  $("#authBtn").onclick = doLogin;
  $("#authPw").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLogin();
  });
  $("#authEmail").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#authPw").focus();
  });
  $("#logoutBtn").onclick = () => sb.auth.signOut();
  $("#saveFiltersBtn")?.addEventListener("click", saveFilters);
}

export async function initAuth() {
  const {
    data: { session },
  } = await sb.auth.getSession();

  if (session) enterApp(session);
  else showGate();

  sb.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_IN" && session) enterApp(session);
    if (event === "SIGNED_OUT") showGate();
  });
}
