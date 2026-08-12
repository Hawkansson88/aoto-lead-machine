import { PROFILES } from "./store.js";
import { escapeHtml } from "./utils.js";

export function profileDisplayName(profile) {
  if (!profile) return "Okänd";
  const name = [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim();
  if (name) return name;
  if (profile.full_name?.trim()) return profile.full_name.trim();
  return profile.email || "Okänd";
}

export function profileInitials(profile) {
  if (!profile) return "?";
  const first = (profile.first_name || "").trim();
  const last = (profile.last_name || "").trim();
  if (first && last) return (first[0] + last[0]).toUpperCase();
  if (first) return first.slice(0, 2).toUpperCase();
  const full = (profile.full_name || profile.email || "").trim();
  if (!full) return "?";
  const parts = full.split(/[\s@.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return full.slice(0, 2).toUpperCase();
}

export function getProfile(userId) {
  if (!userId) return null;
  const want = String(userId).toLowerCase().replace(/-/g, "");
  return (
    PROFILES.find((p) => String(p.id).toLowerCase().replace(/-/g, "") === want) || null
  );
}

/** Compact initials badge for list/panel. Empty when unassigned. */
export function assigneeBadgeHtml(userId, { emptyLabel = false } = {}) {
  if (!userId) {
    return emptyLabel
      ? `<span class="assignee-badge assignee-badge-empty" title="Otilldelad">–</span>`
      : "";
  }
  const profile = getProfile(userId);
  const name = profileDisplayName(profile);
  const initials = profileInitials(profile);
  return `<span class="assignee-badge" title="${escapeHtml(name)}">${escapeHtml(initials)}</span>`;
}
