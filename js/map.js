import { statusMeta } from "./constants.js";
import { getMapLeads } from "./filters.js";
import {
  LEADS,
  leafletMap,
  markerCluster,
  setLeafletMap,
  setMarkerCluster,
} from "./store.js";
import { $, fmtMSEK, scoreColorHex, toast } from "./utils.js";
import { openPanel } from "./panel.js";
import { assigneeBadgeHtml } from "./assignees.js";

function formatLeadAddress(lead) {
  return [lead.address, lead.postal_address].filter(Boolean).join(", ") || lead.city || "–";
}

/** Öppna kartan. Ange focusLeadId för att centrera på en specifik kund
 *  (t.ex. från lead-panelen) och se andra bilhandlare i närheten. */
export function openMap(focusLeadId = null) {
  let visible = getMapLeads();

  // Kunden som knappen öppnades från ska alltid synas, även om den råkar
  // falla utanför aktivt status-/tagg-filter.
  const focusFromStore = focusLeadId != null ? LEADS.find((l) => String(l.id) === String(focusLeadId)) : null;
  if (focusFromStore && !visible.some((l) => String(l.id) === String(focusFromStore.id))) {
    visible = [...visible, focusFromStore];
  }

  const withCoords = visible.filter((l) => l.lat && l.lng);
  const noCoords = $("#mapNoCoords");
  const mapContainer = $("#mapContainer");
  const focusLead = withCoords.find((l) => String(l.id) === String(focusLeadId)) || null;

  if (focusLeadId != null && !focusLead) {
    toast("Kunden saknar koordinater — lägg till adress för att visa på karta");
  }

  $("#mapSub").textContent = focusLead
    ? `${focusLead.company_name} · ${withCoords.length - 1} andra bilhandlare med koordinater i närheten`
    : `Visar ${withCoords.length} av ${visible.length} leads med koordinater · alla i CRM, oavsett tilldelning`;

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

  let focusMarker = null;

  withCoords.forEach((lead) => {
    const isFocus = !!focusLead && String(lead.id) === String(focusLead.id);
    const color = scoreColorHex(lead.score || 0);
    const size = isFocus ? 22 : 14;
    const icon = L.divIcon({
      className: "",
      html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:${
        isFocus ? "3px solid #1a73e8" : "2px solid #fff"
      };box-shadow:0 2px 6px rgba(0,0,0,.3)${isFocus ? ",0 0 0 5px rgba(26,115,232,.3)" : ""}"></div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });

    const marker = L.marker([lead.lat, lead.lng], { icon, zIndexOffset: isFocus ? 1000 : 0 });
    const st = statusMeta(lead.status);

    marker.bindPopup(`
      <div class="map-popup">
        ${isFocus ? `<div class="map-focus-tag">📍 Utgångspunkt</div>` : ""}
        <div class="name">${lead.company_name}</div>
        <span class="score" style="background:${color}">${lead.score ?? "–"} p</span>
        <div class="meta">${formatLeadAddress(lead)} · ${fmtMSEK(lead.revenue)} · ${lead.employees ?? "–"} anst.${
          (lead.tags || []).length
            ? ` · ${lead.tags.map((t) => t.name).join(", ")}`
            : ""
        }</div>
        <div class="meta" style="margin-bottom:8px">
          <span class="badge ${st.cls}" style="font-size:11px;padding:3px 7px"><span class="dot"></span>${st.label}</span>
          ${assigneeBadgeHtml(lead.assigned_to, { emptyLabel: true })}
        </div>
        <button data-lead-id="${lead.id}" class="map-open-lead">Öppna lead →</button>
      </div>`);

    markerCluster.addLayer(marker);
    if (isFocus) focusMarker = marker;
  });

  if (focusMarker) {
    markerCluster.zoomToShowLayer(focusMarker, () => {
      leafletMap.setView(focusMarker.getLatLng(), Math.max(leafletMap.getZoom(), 12));
      focusMarker.openPopup();
    });
  } else {
    const bounds = L.featureGroup(markerCluster.getLayers()).getBounds();
    if (bounds.isValid()) leafletMap.fitBounds(bounds, { padding: [40, 40] });
  }

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
