import { createLead } from "./data.js";
import { renderAll } from "./render.js";
import { openPanel } from "./panel.js";
import { $, toast } from "./utils.js";

export function openCustomerModal() {
  $("#newCustomerName").value = "";
  $("#newCustomerOrgNr").value = "";
  $("#newCustomerRevenue").value = "";
  $("#newCustomerResult").value = "";
  $("#newCustomerEquity").value = "";
  $("#newCustomerSolidity").value = "";
  $("#newCustomerAddress").value = "";
  $("#newCustomerPostal").value = "";
  $("#newCustomerErr").textContent = "";
  $("#customerModal").classList.add("open");
  $("#customerModalScrim").classList.add("open");
  $("#newCustomerName").focus();
}

export function closeCustomerModal() {
  $("#customerModal").classList.remove("open");
  $("#customerModalScrim").classList.remove("open");
}

export async function saveCustomer() {
  const errEl = $("#newCustomerErr");
  errEl.textContent = "";

  const btn = $("#customerModalSave");
  btn.disabled = true;
  btn.textContent = "Skapar…";

  const result = await createLead({
    company_name: $("#newCustomerName").value,
    org_nr: $("#newCustomerOrgNr").value,
    revenue: $("#newCustomerRevenue").value,
    result_after_fin: $("#newCustomerResult").value,
    equity: $("#newCustomerEquity").value,
    solidity: $("#newCustomerSolidity").value,
    address: $("#newCustomerAddress").value,
    postal_address: $("#newCustomerPostal").value,
  });

  btn.disabled = false;
  btn.textContent = "Skapa handlare";

  if (result.error) {
    errEl.textContent = result.error;
    return;
  }

  const hadAddress =
    $("#newCustomerAddress").value.trim() || $("#newCustomerPostal").value.trim();
  if (hadAddress && !result.geocoded) {
    toast("Handlare skapad (kunde inte hitta position på kartan)");
  } else if (result.geocoded) {
    toast("Handlare skapad och placerad på kartan");
  } else {
    toast("Handlare skapad");
  }
  closeCustomerModal();
  renderAll();
  openPanel(result.data.id);
}

export function bindCustomerModal() {
  $("#newCustomerBtn").onclick = openCustomerModal;
  $("#customerModalClose").onclick = closeCustomerModal;
  $("#customerModalCancel").onclick = closeCustomerModal;
  $("#customerModalScrim").onclick = closeCustomerModal;
  $("#customerModalSave").onclick = saveCustomer;

  ["newCustomerName", "newCustomerOrgNr"].forEach((id) => {
    $(`#${id}`).addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveCustomer();
    });
  });
}
