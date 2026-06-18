import { SUPABASE_URL, SUPABASE_ANON } from "./config.js";
import { setSupabaseClient, currentUserId } from "./store.js";
import { bindAuthEvents, initAuth } from "./auth.js";
import { bindEvents } from "./events.js";
import { openPanel } from "./panel.js";
import { setRowClickHandler } from "./render.js";
import { openSettings, closeSettings, saveScoring } from "./settings-modal.js";
import { $ } from "./utils.js";

async function boot() {
  setSupabaseClient(window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON));

  setRowClickHandler(openPanel);

  bindAuthEvents({
    onSettingsOpen: openSettings,
    onSettingsSave: () => saveScoring(currentUserId),
  });

  $("#modalClose").onclick = closeSettings;
  $("#modalCancel").onclick = closeSettings;
  $("#modalScrim").onclick = closeSettings;

  bindEvents();
  await initAuth();
}

boot();
