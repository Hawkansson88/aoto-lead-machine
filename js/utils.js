/** Shorthand for document.querySelector */
export const $ = (selector) => document.querySelector(selector);

export function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove("show"), 2200);
}

export function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export function fmtMSEK(value) {
  if (value == null) return "–";
  return (value / 1e6).toLocaleString("sv-SE", { maximumFractionDigits: 1 }) + " MSEK";
}

export function scoreColor(score) {
  if (score >= 80) return "var(--sc-high)";
  if (score >= 50) return "var(--sc-mid)";
  return "var(--sc-low)";
}

export function scoreColorHex(score) {
  if (score >= 80) return "#11a37a";
  if (score >= 50) return "#e0a23a";
  return "#e0556b";
}

export function scoreBarColor(pts, max) {
  const ratio = pts / max;
  if (ratio >= 0.7) return "var(--sc-high)";
  if (ratio >= 0.4) return "var(--sc-mid)";
  return "var(--sc-low)";
}

export function followupInfo(date) {
  if (!date) return { label: "–", cls: "fu-none" };

  const formatted = new Date(date + "T00:00:00").toLocaleDateString("sv-SE", {
    day: "numeric",
    month: "short",
  });

  if (date < todayStr()) return { label: `${formatted} · försenad`, cls: "fu-late" };
  if (date === todayStr()) return { label: `${formatted} · idag`, cls: "fu-today" };
  return { label: formatted, cls: "fu-future" };
}

export function fmtDateTime(iso) {
  const d = new Date(iso);
  return (
    d.toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" }) +
    " kl " +
    d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })
  );
}

export function escapeHtml(text) {
  return text.replace(/</g, "&lt;");
}
