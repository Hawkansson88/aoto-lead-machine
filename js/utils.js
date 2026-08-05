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

/** Parse MSEK input to SEK integer, or null if empty/invalid */
export function msekToSek(value) {
  if (value === "" || value == null) return null;
  const n = Number(String(value).replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1e6);
}

/** Normalize Swedish org.nr to 10 digits (no dash) */
export function normalizeOrgNr(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 10 ? digits : null;
}

/** Build Nominatim search query from address parts */
export function buildGeocodeQuery({ address, postal_address, city }) {
  return [address, postal_address, city, "Sverige"].filter((s) => s?.trim()).join(", ");
}

/** Extract city from Swedish postadress, e.g. "412 34 Göteborg" */
export function parseCityFromPostalAddress(value) {
  if (!value?.trim()) return null;
  const trimmed = value.trim();
  const withCode = trimmed.match(/^\d{3}\s?\d{2}\s+(.+)$/);
  if (withCode) return withCode[1].trim();
  return trimmed;
}

export function formatOrgNr(digits) {
  if (!digits || digits.length !== 10) return digits || "";
  return `${digits.slice(0, 6)}-${digits.slice(6)}`;
}

/** SEK → MSEK for form inputs */
export function sekToMsekInput(value) {
  if (value == null) return "";
  return (value / 1e6).toString();
}

/** Parse employee count, or null if empty/invalid */
export function parseEmployees(value) {
  if (value === "" || value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
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

export function escapeAttr(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}
