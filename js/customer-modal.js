import { createLead, updateLead } from "./data.js";
import { renderAll } from "./render.js";
import { openPanel } from "./panel.js";
import { LEADS, selectedLead, setSelectedLead } from "./store.js";
import { $, toast, formatOrgNr, sekToMsekInput } from "./utils.js";

let editingLeadId = null;

function readFormFields() {
  return {
    company_name: $("#newCustomerName").value,
    org_nr: $("#newCustomerOrgNr").value,
    revenue: $("#newCustomerRevenue").value,
    result_after_fin: $("#newCustomerResult").value,
    equity: $("#newCustomerEquity").value,
    solidity: $("#newCustomerSolidity").value,
    employees: $("#newCustomerEmployees").value,
    address: $("#newCustomerAddress").value,
    postal_address: $("#newCustomerPostal").value,
  };
}

function resetForm() {
  $("#newCustomerName").value = "";
  $("#newCustomerOrgNr").value = "";
  $("#newCustomerRevenue").value = "";
  $("#newCustomerResult").value = "";
  $("#newCustomerEquity").value = "";
  $("#newCustomerSolidity").value = "";
  $("#newCustomerEmployees").value = "";
  $("#newCustomerAddress").value = "";
  $("#newCustomerPostal").value = "";
  $("#newCustomerErr").textContent = "";
}

function fillFormFromLead(lead) {
  $("#newCustomerName").value = lead.company_name || "";
  $("#newCustomerOrgNr").value = formatOrgNr(lead.org_nr) || "";
  $("#newCustomerRevenue").value = sekToMsekInput(lead.revenue);
  $("#newCustomerResult").value = sekToMsekInput(lead.result_after_fin);
  $("#newCustomerEquity").value = sekToMsekInput(lead.equity);
  $("#newCustomerSolidity").value = lead.solidity ?? "";
  $("#newCustomerEmployees").value = lead.employees ?? "";
  $("#newCustomerAddress").value = lead.address || "";
  $("#newCustomerPostal").value = lead.postal_address || "";
  $("#newCustomerErr").textContent = "";
}

function setModalMode(mode) {
  const isEdit = mode === "edit";
  $("#customerModalTitle").textContent = isEdit ? "Redigera handlare" : "Ny kund";
  $("#customerModalSave").textContent = isEdit ? "Spara ändringar" : "Skapa handlare";
}

function openModal() {
  $("#customerModal").classList.add("open");
  $("#customerModalScrim").classList.add("open");
  $("#newCustomerName").focus();
}

export function openCustomerModal() {
  editingLeadId = null;
  resetForm();
  setModalMode("create");
  openModal();
}

export function openEditModal(leadId) {
  const lead = LEADS.find((l) => l.id === leadId);
  if (!lead) return;

  editingLeadId = leadId;
  fillFormFromLead(lead);
  setModalMode("edit");
  openModal();
}

export function closeCustomerModal() {
  editingLeadId = null;
  $("#customerModal").classList.remove("open");
  $("#customerModalScrim").classList.remove("open");
}

function toastAfterSave(result, hadAddress, isEdit) {
  if (isEdit) {
    if (hadAddress && result.addressChanged && !result.geocoded) {
      toast("Handlare uppdaterad (kunde inte hitta ny kartposition)");
    } else if (result.geocoded) {
      toast("Handlare uppdaterad och placerad på kartan");
    } else {
      toast("Handlare uppdaterad");
    }
    return;
  }

  if (hadAddress && !result.geocoded) {
    toast("Handlare skapad (kunde inte hitta position på kartan)");
  } else if (result.geocoded) {
    toast("Handlare skapad och placerad på kartan");
  } else {
    toast("Handlare skapad");
  }
}

export async function saveCustomer() {
  const errEl = $("#newCustomerErr");
  errEl.textContent = "";

  const btn = $("#customerModalSave");
  const isEdit = editingLeadId != null;
  btn.disabled = true;
  btn.textContent = isEdit ? "Sparar…" : "Skapar…";

  const fields = readFormFields();
  const result = isEdit ? await updateLead(editingLeadId, fields) : await createLead(fields);

  btn.disabled = false;
  btn.textContent = isEdit ? "Spara ändringar" : "Skapa handlare";

  if (result.error) {
    errEl.textContent = result.error;
    return;
  }

  const hadAddress = fields.address.trim() || fields.postal_address.trim();
  toastAfterSave(result, hadAddress, isEdit);
  closeCustomerModal();
  renderAll();

  if (selectedLead?.id === result.data.id) {
    setSelectedLead(result.data);
  }
  openPanel(result.data.id);
}

export function bindCustomerModal() {
  $("#newCustomerBtn").onclick = openCustomerModal;
  $("#customerModalClose").onclick = closeCustomerModal;
  $("#customerModalCancel").onclick = closeCustomerModal;
  $("#customerModalScrim").onclick = closeCustomerModal;
  $("#customerModalSave").onclick = saveCustomer;
  $("#editLeadBtn").onclick = () => {
    if (selectedLead) openEditModal(selectedLead.id);
  };

  ["newCustomerName", "newCustomerOrgNr"].forEach((id) => {
    $(`#${id}`).addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveCustomer();
    });
  });
}
