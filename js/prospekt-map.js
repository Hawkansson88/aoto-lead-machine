/**
 * AOTO Prospekt — kartvy för besöksplanering.
 *
 * Två lägen, båda byggda för samma fråga: "jag ska till X, vilka ligger i
 * närheten eller på vägen?"
 *
 *   Ett mål angivet   → alla inom radien från den orten
 *   Från och till     → alla inom radien från linjen mellan orterna
 *
 * Korridoren räknas mot en rak linje, inte mot vägnätet. För svenska avstånd
 * är det en god approximation, men kring fjäll, sjöar och skärgård kan en
 * handlare se närmare ut än vad bilvägen medger. Läs den som en första
 * gallring, inte som en körtidsberäkning.
 */

import { $, escapeHtml, escapeAttr, formatOrgNr, toast } from "./utils.js";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT_NOTE = "AOTO-Prospekt";

/** Klassfärger — samma som etiketterna i listan. */
const CLASS_COLOR = {
  a: "#0a7d5a",
  b: "#cf8a12",
  c: "#9aa6b8",
  oklassad: "#5b6b85",
};

let map = null;
let cluster = null;
let routeLayer = null;
let rows = [];
let onOpenDealer = null;

/** Sverige ligger runt 62°N — projektionen räcker för avstånd i den skalan. */
const KM_PER_DEG_LAT = 111.2;
function kmPerDegLng(lat) {
  return 111.32 * Math.cos((lat * Math.PI) / 180);
}

function toXY(point, refLat) {
  return { x: point.lng * kmPerDegLng(refLat), y: point.lat * KM_PER_DEG_LAT };
}

function distanceKm(a, b) {
  const refLat = (a.lat + b.lat) / 2;
  const pa = toXY(a, refLat);
  const pb = toXY(b, refLat);
  return Math.hypot(pa.x - pb.x, pa.y - pb.y);
}

/** Kortaste avståndet från punkt till sträckan from–to, i km. */
function distanceToSegmentKm(point, from, to) {
  const refLat = (from.lat + to.lat) / 2;
  const p = toXY(point, refLat);
  const a = toXY(from, refLat);
  const b = toXY(to, refLat);

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);

  // Projektion klampad till sträckan, så punkter bortom ändarna mäts mot
  // närmaste ände i stället för mot den oändliga linjen.
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

async function geocodePlace(query) {
  const params = new URLSearchParams({
    q: query.trim(),
    countrycodes: "se",
    format: "json",
    limit: "1",
  });
  const res = await fetch(`${NOMINATIM_URL}?${params}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data?.length) return null;
  return {
    lat: parseFloat(data[0].lat),
    lng: parseFloat(data[0].lon),
    label: data[0].display_name?.split(",")[0] || query,
  };
}

function markerIcon(row) {
  const color = CLASS_COLOR[row.list?.status || "oklassad"] || CLASS_COLOR.oklassad;
  // Storleken följer affärsvolymen så tyngdpunkten syns utan att man klickar
  const deals = row.dealer.deals_total || 0;
  const size = deals >= 200 ? 22 : deals >= 80 ? 18 : deals >= 30 ? 14 : 11;
  return L.divIcon({
    className: "",
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3)"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function popupHtml(row, distance) {
  const d = row.dealer;
  const s = row.stats || {};
  const fin = (d.finance_companies || [])[0];
  return `
    <div class="map-popup">
      <div class="name">${escapeHtml(d.company_name || "—")}</div>
      <div class="meta">${escapeHtml(formatOrgNr(d.org_nr))} · ${escapeHtml(
        [s.address, s.city].filter(Boolean).join(", ") || "–"
      )}</div>
      <div class="meta">
        <b>${d.deals_total}</b> leasingaffärer · ${d.distinct_customers} kunder
        ${fin ? ` · idag: ${escapeHtml(fin.name)}` : ""}
      </div>
      ${
        distance != null
          ? `<div class="meta"><b>${Math.round(distance)} km</b> från resvägen</div>`
          : ""
      }
      <button data-org="${escapeAttr(d.org_nr)}" class="map-open-lead">Öppna →</button>
    </div>`;
}

function ensureMap() {
  if (map) return;
  map = L.map("prospectMapContainer").setView([62.5, 16.5], 5);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
    maxZoom: 18,
  }).addTo(map);
  cluster = L.markerClusterGroup({ maxClusterRadius: 45 });
  map.addLayer(cluster);
  routeLayer = L.layerGroup().addTo(map);
}

/**
 * Ritar om markörerna.
 * @param {{from: object|null, to: object|null, radiusKm: number}} route
 */
function draw(route) {
  cluster.clearLayers();
  routeLayer.clearLayers();

  const withCoords = rows.filter((r) => r.stats?.lat != null && r.stats?.lng != null);
  let shown = withCoords;
  const distanceOf = new Map();

  if (route.from && route.to) {
    shown = withCoords.filter((r) => {
      const dist = distanceToSegmentKm(
        { lat: r.stats.lat, lng: r.stats.lng },
        route.from,
        route.to
      );
      distanceOf.set(r.dealer.org_nr, dist);
      return dist <= route.radiusKm;
    });
  } else if (route.to) {
    shown = withCoords.filter((r) => {
      const dist = distanceKm({ lat: r.stats.lat, lng: r.stats.lng }, route.to);
      distanceOf.set(r.dealer.org_nr, dist);
      return dist <= route.radiusKm;
    });
  }

  for (const row of shown) {
    const marker = L.marker([row.stats.lat, row.stats.lng], { icon: markerIcon(row) });
    marker.bindPopup(popupHtml(row, distanceOf.get(row.dealer.org_nr) ?? null));
    cluster.addLayer(marker);
  }

  for (const point of [route.from, route.to]) {
    if (!point) continue;
    routeLayer.addLayer(
      L.circleMarker([point.lat, point.lng], {
        radius: 8,
        color: "#1a73e8",
        weight: 3,
        fillColor: "#fff",
        fillOpacity: 1,
      }).bindTooltip(point.label, { permanent: true, direction: "top", className: "route-tip" })
    );
  }
  if (route.from && route.to) {
    routeLayer.addLayer(
      L.polyline(
        [
          [route.from.lat, route.from.lng],
          [route.to.lat, route.to.lng],
        ],
        { color: "#1a73e8", weight: 3, opacity: 0.5, dashArray: "8 6" }
      )
    );
  }

  const missing = rows.length - withCoords.length;
  $("#prospectMapSub").innerHTML =
    (route.from && route.to
      ? `${shown.length} återförsäljare inom ${route.radiusKm} km från sträckan`
      : route.to
        ? `${shown.length} återförsäljare inom ${route.radiusKm} km från ${escapeHtml(route.to.label)}`
        : `${withCoords.length} återförsäljare med koordinater`) +
    (missing ? ` · <span style="color:var(--faint)">${missing} saknar adress</span>` : "");

  const layers = [...cluster.getLayers(), ...routeLayer.getLayers()];
  if (layers.length) {
    const bounds = L.featureGroup(layers).getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] });
  }
  setTimeout(() => map.invalidateSize(), 60);
}

async function applyRoute() {
  const fromText = $("#mapFrom").value.trim();
  const toText = $("#mapTo").value.trim();
  const radiusKm = Number($("#mapRadius").value) || 50;
  const btn = $("#mapApplyBtn");

  if (!toText) {
    draw({ from: null, to: null, radiusKm });
    return;
  }

  btn.disabled = true;
  btn.textContent = "Söker…";
  try {
    // Nominatim tillåter ett anrop per sekund — två platser körs i följd
    const to = await geocodePlace(toText);
    if (!to) {
      toast(`Hittade ingen plats som heter "${toText}"`, { error: true });
      return;
    }
    let from = null;
    if (fromText) {
      await new Promise((r) => setTimeout(r, 1100));
      from = await geocodePlace(fromText);
      if (!from) toast(`Hittade inte "${fromText}" — visar radie runt ${to.label} i stället`);
    }
    draw({ from, to, radiusKm });
  } catch (err) {
    console.error(err);
    toast("Kunde inte slå upp platsen", { error: true });
  } finally {
    btn.disabled = false;
    btn.textContent = "Visa";
  }
}

/**
 * @param {Array} indexedRows Raderna från listan (dealer + list + stats)
 * @param {(orgNr: string) => void} openDealer
 */
export function openProspectMap(indexedRows, openDealer) {
  rows = indexedRows;
  onOpenDealer = openDealer;

  $("#prospectMapModal").classList.add("open");
  $("#prospectMapScrim").classList.add("open");

  ensureMap();
  draw({ from: null, to: null, radiusKm: Number($("#mapRadius").value) || 50 });
}

export function closeProspectMap() {
  $("#prospectMapModal").classList.remove("open");
  $("#prospectMapScrim").classList.remove("open");
}

export function bindProspectMap() {
  $("#mapApplyBtn").onclick = applyRoute;
  $("#mapClearBtn").onclick = () => {
    $("#mapFrom").value = "";
    $("#mapTo").value = "";
    draw({ from: null, to: null, radiusKm: Number($("#mapRadius").value) || 50 });
  };
  $("#mapRadius").addEventListener("change", applyRoute);
  for (const id of ["#mapFrom", "#mapTo"]) {
    $(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") applyRoute();
    });
  }
  $("#prospectMapClose").onclick = closeProspectMap;
  $("#prospectMapScrim").onclick = closeProspectMap;

  // Popup-knapparna finns inte i DOM:en förrän de öppnas
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".map-open-lead");
    if (!btn || !onOpenDealer) return;
    closeProspectMap();
    setTimeout(() => onOpenDealer(btn.dataset.org), 120);
  });
}
