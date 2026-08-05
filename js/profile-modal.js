import { ROLES } from "./constants.js";
import { callNetlifyFunction } from "./data.js";
import {
  sb,
  currentUserEmail,
  currentUserRole,
  currentUserFirstName,
  currentUserLastName,
} from "./store.js";
import { $, toast } from "./utils.js";

export function openProfileModal() {
  fillProfileForm();
  $("#profileModal").classList.add("open");
  $("#profileModalScrim").classList.add("open");
  updateAdminSection();
}

export function closeProfileModal() {
  $("#profileModal").classList.remove("open");
  $("#profileModalScrim").classList.remove("open");
  const err = $("#profileErr");
  if (err) err.textContent = "";
  const createErr = $("#createUserErr");
  if (createErr) createErr.textContent = "";
  const pwMsg = $("#profilePwMsg");
  if (pwMsg) pwMsg.classList.remove("show");
}

function fillProfileForm() {
  $("#profileName").textContent =
    [currentUserFirstName, currentUserLastName].filter(Boolean).join(" ") || "–";
  $("#profileEmail").textContent = currentUserEmail || "–";
  $("#profileRole").textContent = ROLES[currentUserRole]?.label || currentUserRole;
  $("#profileNewPw").value = "";
  $("#profileNewPw2").value = "";
}

function updateAdminSection() {
  const section = $("#adminCreateSection");
  if (!section) return;
  section.style.display = currentUserRole === "admin" ? "" : "none";
}

export async function changePassword() {
  const err = $("#profileErr");
  err.textContent = "";
  const pw = $("#profileNewPw").value;
  const pw2 = $("#profileNewPw2").value;

  if (!pw || pw.length < 6) {
    err.textContent = "Lösenordet måste vara minst 6 tecken.";
    return;
  }
  if (pw !== pw2) {
    err.textContent = "Lösenorden matchar inte.";
    return;
  }

  const { error } = await sb.auth.updateUser({ password: pw });
  if (error) {
    err.textContent = error.message || "Kunde inte byta lösenord.";
    return;
  }

  $("#profileNewPw").value = "";
  $("#profileNewPw2").value = "";
  const msg = $("#profilePwMsg");
  msg.classList.add("show");
  setTimeout(() => msg.classList.remove("show"), 2500);
  toast("Lösenord uppdaterat");
}

export async function createUser() {
  const err = $("#createUserErr");
  err.textContent = "";

  const first_name = $("#createFirstName").value.trim();
  const last_name = $("#createLastName").value.trim();
  const email = $("#createEmail").value.trim();
  const password = $("#createPassword").value;
  const role = $("#createRole").value;

  if (!first_name || !email || !password) {
    err.textContent = "Förnamn, e-post och lösenord krävs.";
    return;
  }

  const btn = $("#createUserBtn");
  btn.disabled = true;
  btn.textContent = "Skapar…";

  try {
    const res = await callNetlifyFunction("create-user", {
      first_name,
      last_name,
      email,
      password,
      role,
    });

    if (res.error) {
      err.textContent = res.error;
      return;
    }

    toast(`Användare skapad: ${first_name}`);
    ["createFirstName", "createLastName", "createEmail", "createPassword"].forEach((id) => {
      $(`#${id}`).value = "";
    });
    $("#createRole").value = "saljare";
  } catch (e) {
    console.error(e);
    err.textContent = "Kunde inte skapa användare.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Skapa användare";
  }
}

export function bindProfileModal() {
  $("#profileBtn").onclick = openProfileModal;
  $("#profileModalClose").onclick = closeProfileModal;
  $("#profileModalScrim").onclick = closeProfileModal;
  $("#profileCancel").onclick = closeProfileModal;
  $("#profileChangePw").onclick = changePassword;
  $("#createUserBtn").onclick = createUser;

  const adminBtn = $("#adminCreateBtn");
  if (adminBtn) {
    adminBtn.onclick = () => {
      openProfileModal();
      const section = $("#adminCreateSection");
      if (section) section.scrollIntoView({ behavior: "smooth", block: "start" });
    };
  }
}

/** Keep avatar/name display in sync after profile load */
export function refreshUserChrome() {
  const emailEl = $("#userEmail");
  const avEl = $("#userAv");
  if (emailEl) {
    emailEl.textContent = currentUserFirstName
      ? `${currentUserFirstName}${currentUserLastName ? ` ${currentUserLastName[0]}.` : ""}`
      : currentUserEmail;
    emailEl.title = currentUserEmail;
  }
  if (avEl) avEl.textContent = (currentUserFirstName || currentUserEmail || "–")[0];

  const adminBtn = $("#adminCreateBtn");
  if (adminBtn) adminBtn.style.display = currentUserRole === "admin" ? "" : "none";
}
