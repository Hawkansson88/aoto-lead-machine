import { filterState, selectedLead, sb } from "./store.js";
import { patchLead } from "./data.js";
import {
  renderAll,
  renderStatusFilter,
  renderDnbFilter,
  renderCreditFlagFilter,
  renderTable,
} from "./render.js";
import { closePanel } from "./panel.js";
import { openMap, closeMap, handleMapPopupClick } from "./map.js";
import { closeCustomerModal } from "./customer-modal.js";
import { closeProfileModal } from "./profile-modal.js";
import { closeAssignModal } from "./assign.js";
import { $, toast } from "./utils.js";

export function bindEvents() {
  $("#statusList").onclick = (e) => {
    const item = e.target.closest(".status-item");
    if (!item) return;
    filterState.status = item.dataset.st;
    renderStatusFilter();
    renderTable();
  };

  $("#dnbFilterList").onclick = (e) => {
    const item = e.target.closest(".status-item");
    if (!item) return;
    filterState.dnb = item.dataset.dnb;
    renderDnbFilter();
    renderTable();
  };

  const creditFlagList = $("#creditFlagList");
  if (creditFlagList) {
    creditFlagList.onclick = (e) => {
      const item = e.target.closest(".status-item");
      if (!item) return;
      filterState.creditFlag = item.dataset.cflag;
      renderCreditFlagFilter();
      renderTable();
    };
  }

  $("#revMin")?.addEventListener("input", (e) => {
    filterState.revMin = e.target.value ? +e.target.value : null;
    renderTable();
  });

  $("#revMax")?.addEventListener("input", (e) => {
    filterState.revMax = e.target.value ? +e.target.value : null;
    renderTable();
  });

  $("#search").oninput = (e) => {
    filterState.q = e.target.value.trim();
    renderTable();
  };

  $("#mapBtn")?.addEventListener("click", openMap);
  $("#mapClose")?.addEventListener("click", closeMap);
  $("#mapScrim")?.addEventListener("click", closeMap);
  document.addEventListener("click", handleMapPopupClick);

  bindPanelChrome();

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closePanel();
      closeCustomerModal();
      closeProfileModal();
      closeAssignModal();
      closeMap();
    }
  });
}

/** Panel chrome used on both Sälj and Marknadsanalys. */
export function bindPanelChrome() {
  $("#pClose")?.addEventListener("click", closePanel);
  $("#scrim")?.addEventListener("click", closePanel);

  $("#saveFollowup")?.addEventListener("click", async () => {
    if (!selectedLead?.id) return;
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
  });

  $("#mailBtn")?.addEventListener("click", async () => {
    if (!selectedLead?.id) return;

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
  });
}
