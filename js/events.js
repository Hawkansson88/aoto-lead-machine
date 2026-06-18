import { filterState, selectedLead, sb } from "./store.js";
import { patchLead } from "./data.js";
import { renderAll, renderStatusFilter, renderTable } from "./render.js";
import { closePanel } from "./panel.js";
import { openMap, closeMap, handleMapPopupClick } from "./map.js";
import { closeSettings } from "./settings-modal.js";
import { $, toast } from "./utils.js";

export function bindEvents() {
  $("#statusList").onclick = (e) => {
    const item = e.target.closest(".status-item");
    if (!item) return;
    filterState.status = item.dataset.st;
    renderStatusFilter();
    renderTable();
  };

  $("#scoreSlider").oninput = (e) => {
    filterState.minScore = +e.target.value;
    $("#scoreVal").textContent = e.target.value;
    e.target.style.setProperty("--p", e.target.value + "%");
    renderTable();
  };

  $("#revMin").oninput = (e) => {
    filterState.revMin = e.target.value ? +e.target.value : null;
    renderTable();
  };

  $("#revMax").oninput = (e) => {
    filterState.revMax = e.target.value ? +e.target.value : null;
    renderTable();
  };

  $("#search").oninput = (e) => {
    filterState.q = e.target.value.trim();
    renderTable();
  };

  $("#pClose").onclick = closePanel;
  $("#scrim").onclick = closePanel;
  $("#mapBtn").onclick = openMap;
  $("#mapClose").onclick = closeMap;
  $("#mapScrim").onclick = closeMap;
  document.addEventListener("click", handleMapPopupClick);

  $("#saveFollowup").onclick = async () => {
    if (!selectedLead) return;
    const date = $("#followup").value || null;
    const ok = await patchLead(selectedLead.id, {
      follow_up_date: date,
      updated_at: new Date().toISOString(),
    });
    if (ok) {
      selectedLead.follow_up_date = date;
      toast("Uppföljning sparad");
      renderAll();
    } else {
      toast("Kunde inte spara uppföljning");
    }
  };

  $("#mailBtn").onclick = async () => {
    if (!selectedLead) return;

    const { data } = await sb
      .from("lead_contacts")
      .select("name, email")
      .eq("lead_id", selectedLead.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    const email = data?.email?.trim();
    if (!email) {
      toast("Lägg till kontaktpersonens e-post först");
      return;
    }

    const firstName = data?.name?.trim().split(" ")[0] || "";
    const body =
      `Hej${firstName ? ` ${firstName}` : ""}!\n\n` +
      `Jag heter [Ditt namn] och jobbar på AOTO. Jag ser att ${selectedLead.company_name} i ${selectedLead.city || "er region"} skulle kunna frigöra rörelsekapital genom lagerfinansiering av begagnade bilar – ni betalar bara för det lager ni faktiskt har ute.\n\n` +
      `Har du 15 minuter nästa vecka för ett kort samtal om hur det skulle se ut för er?\n\n` +
      `Vänliga hälsningar,\n[Ditt namn], AOTO`;

    window.location.href =
      `mailto:${email}?subject=${encodeURIComponent(`AOTO – lagerfinansiering för ${selectedLead.company_name}`)}` +
      `&body=${encodeURIComponent(body)}`;
  };

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closePanel();
      closeSettings();
      closeMap();
    }
  });

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
