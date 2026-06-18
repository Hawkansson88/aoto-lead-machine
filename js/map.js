import { STATUS } from "./constants.js";
import { getVisibleLeads } from "./filters.js";
import {
  leafletMap,
  markerCluster,
  setLeafletMap,
  setMarkerCluster,
} from "./store.js";
import { $, fmtMSEK, scoreColorHex } from "./utils.js";
import { openPanel } from "./panel.js";

export function openMap() {
  const visible = getVisibleLeads();
  const withCoords = visible.filter((l) => l.lat && l.lng);
  const noCoords = $("#mapNoCoords");
  const mapContainer = $("#mapContainer");

  $("#mapSub").textContent = `Visar ${withCoords.length} av ${visible.length} leads med koordinater`;

  if (withCoords.length === 0) {
    noCoords.style.display = "block";
    mapContainer.style.display = "none";
  } else {
    noCoords.style.display = "none";
    mapContainer.style.display = "block";
  }

  $("#mapModal").classList.add("open");
  $("#mapScrim").classList.add("open");

  if (!leafletMap) {
    setLeafletMap(L.map("mapContainer").setView([62.5, 16.5], 5));
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
      maxZoom: 18,
    }).addTo(leafletMap);
    setMarkerCluster(L.markerClusterGroup({ maxClusterRadius: 40 }));
    leafletMap.addLayer(markerCluster);
  }

  markerCluster.clearLayers();
  if (withCoords.length === 0) return;

  withCoords.forEach((lead) => {
    const color = scoreColorHex(lead.score || 0);
    const icon = L.divIcon({
      className: "",
      html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3)"></div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });

    const marker = L.marker([lead.lat, lead.lng], { icon });
    const st = STATUS[lead.status] || STATUS.ny;

    marker.bindPopup(`
      <div class="map-popup">
        <div class="name">${lead.company_name}</div>
        <span class="score" style="background:${color}">${lead.score ?? "–"} p</span>
        <div class="meta">${lead.city || "–"} · ${fmtMSEK(lead.revenue)} · ${lead.employees ?? "–"} anst.</div>
        <div class="meta" style="margin-bottom:8px">
          <span class="badge ${st.cls}" style="font-size:11px;padding:3px 7px"><span class="dot"></span>${st.label}</span>
        </div>
        <button data-lead-id="${lead.id}" class="map-open-lead">Öppna lead →</button>
      </div>`);

    markerCluster.addLayer(marker);
  });

  const bounds = L.featureGroup(markerCluster.getLayers()).getBounds();
  if (bounds.isValid()) leafletMap.fitBounds(bounds, { padding: [40, 40] });

  setTimeout(() => leafletMap.invalidateSize(), 50);
}

/** Called from map popup buttons (event delegation avoids inline onclick). */
export function handleMapPopupClick(e) {
  const btn = e.target.closest(".map-open-lead");
  if (!btn) return;
  closeMap();
  setTimeout(() => openPanel(+btn.dataset.leadId), 100);
}

export function closeMap() {
  $("#mapModal").classList.remove("open");
  $("#mapScrim").classList.remove("open");
}
