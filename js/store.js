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

export function setAppReady(ready) {
  appReady = ready;
}

export function setCurrentUserId(id) {
  currentUserId = id;
}

/** UI filter and sort state */
export const filterState = {
  status: "alla",
  dnb: "alla",
  minScore: 0,
  revMin: null,
  revMax: null,
  q: "",
  sortKey: "score",
  sortDir: -1,
};

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
