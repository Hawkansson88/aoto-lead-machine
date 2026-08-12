import { SUPABASE_URL, SUPABASE_ANON } from "./config.js";
import { setSupabaseClient } from "./store.js";
import { bindAuthEvents, initAuth } from "./auth.js";
import { bindEvents } from "./events.js";
import { openPanel } from "./panel.js";
import { setRowClickHandler } from "./render.js";
import { bindCustomerModal } from "./customer-modal.js";
import { bindProfileModal } from "./profile-modal.js";
import { bindViewNav } from "./views.js";
import { bindSelectionEvents } from "./selection.js";
import { bindAssignModal } from "./assign.js";

async function boot() {
  setSupabaseClient(window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON));

  setRowClickHandler(openPanel);

  bindAuthEvents();

  bindEvents();
  bindSelectionEvents();
  bindAssignModal();
  bindCustomerModal();
  bindProfileModal();
  bindViewNav();
  await initAuth();
}

boot();
