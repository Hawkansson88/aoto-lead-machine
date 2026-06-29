import {
  loadUserSettings,
  loadLeads,
  saveUserSettings,
} from "./data.js";
import { renderAll } from "./render.js";
import { closePanel } from "./panel.js";
import {
  sb,
  setLeads,
  setAppReady,
  setCurrentUserId,
  appReady,
  currentUserId,
  filterState,
  clearSelection,
} from "./store.js";
import { $, toast } from "./utils.js";

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

export async function enterApp(session) {
  showApp();
  setCurrentUserId(session.user.id);

  const email = session?.user?.email || "";
  $("#userEmail").textContent = email;
  $("#userAv").textContent = email[0] || "–";

  if (appReady) return;

  setAppReady(true);
  try {
    await loadUserSettings(currentUserId);
    await loadLeads();
    renderAll();
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
    minScore: filterState.minScore,
    revMin: filterState.revMin,
    revMax: filterState.revMax,
    dnb: filterState.dnb,
  });

  if (ok) {
    const msg = $("#filterSavedMsg");
    msg.classList.add("show");
    setTimeout(() => msg.classList.remove("show"), 2000);
  } else {
    toast("Kunde inte spara filter");
  }
}

export function bindAuthEvents({ onSettingsOpen, onSettingsSave }) {
  $("#authBtn").onclick = doLogin;
  $("#authPw").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLogin();
  });
  $("#authEmail").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#authPw").focus();
  });
  $("#logoutBtn").onclick = () => sb.auth.signOut();
  $("#settingsBtn").onclick = onSettingsOpen;
  $("#saveFiltersBtn").onclick = saveFilters;
  $("#modalSave").onclick = onSettingsSave;
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
