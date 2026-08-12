import { DEFAULT_SCORING } from "./constants.js";

/** Supabase client — initialized in main.js */
export let sb = null;

export function setSupabaseClient(client) {
  sb = client;
}

/** In-memory lead cache with computed scores */
export let LEADS = [];

export function setLeads(leads) {
  LEADS = leads;
}

/** Currently open lead in detail panel */
export let selectedLead = null;

export function setSelectedLead(lead) {
  selectedLead = lead;
}

export let appReady = false;
export let currentUserId = null;
export let currentUserEmail = "";
export let currentUserRole = "saljare";
export let currentUserFirstName = "";
export let currentUserLastName = "";
export let currentView = "salj";

export function setAppReady(ready) {
  appReady = ready;
}

export function setCurrentUserId(id) {
  currentUserId = id;
}

export function setCurrentUserEmail(email) {
  currentUserEmail = email || "";
}

export function setCurrentUserProfile({ role, firstName, lastName }) {
  if (role) currentUserRole = role;
  if (firstName != null) currentUserFirstName = firstName;
  if (lastName != null) currentUserLastName = lastName;
}

export function setCurrentView(view) {
  currentView = view === "kredit" ? "kredit" : "salj";
}

/** UI filter and sort state */
export const filterState = {
  status: "alla",
  dnb: "alla",
  creditFlag: "alla",
  showActive: false,
  /** false = only leads assigned to current user (default) */
  showAllLeads: false,
  minScore: 0,
  revMin: null,
  revMax: null,
  q: "",
  sortKey: "follow_up_date",
  sortDir: 1,
};

/** Team profiles for assignee badges / picker */
export let PROFILES = [];

export function setProfiles(profiles) {
  PROFILES = profiles || [];
}

/** Selected lead ids for bulk actions */
export const selectedIds = new Set();

export function toggleSelection(id) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
}

export function clearSelection() {
  selectedIds.clear();
}

/** User-specific scoring configuration */
export let scoringConfig = structuredClone(DEFAULT_SCORING);

export function setScoringConfig(config) {
  scoringConfig = config;
}

/** Leaflet map instances (lazy-initialized) */
export let leafletMap = null;
export let markerCluster = null;

export function setLeafletMap(map) {
  leafletMap = map;
}

export function setMarkerCluster(cluster) {
  markerCluster = cluster;
}
