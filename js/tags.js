import { escapeHtml, escapeAttr } from "./utils.js";

/** Normalize tag name for uniqueness / matching. */
export function normalizeTagName(raw) {
  return String(raw || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Display form: trim, collapse spaces. Keep user's casing on create. */
export function cleanTagName(raw) {
  return String(raw || "")
    .trim()
    .replace(/\s+/g, " ");
}

export function leadHasTag(lead, tagId) {
  if (!lead?.tags?.length || tagId == null) return false;
  return lead.tags.some((t) => String(t.id) === String(tagId));
}

export function leadTagNames(lead) {
  return (lead?.tags || []).map((t) => t.name).filter(Boolean);
}

/** Compact chips for list rows. */
export function tagsBadgeHtml(tags, { max = 3 } = {}) {
  const list = Array.isArray(tags) ? tags : [];
  if (!list.length) return "";
  const shown = list.slice(0, max);
  const rest = list.length - shown.length;
  const chips = shown
    .map((t) => `<span class="badge-tag" title="${escapeAttr(t.name)}">${escapeHtml(t.name)}</span>`)
    .join("");
  const more =
    rest > 0 ? `<span class="badge-tag badge-tag-more" title="${escapeAttr(list.map((t) => t.name).join(", "))}">+${rest}</span>` : "";
  return `<span class="tag-badges">${chips}${more}</span>`;
}

/** Interactive chips for panel (remove + rename via data attrs). */
export function tagChipsHtml(tags, { editable = true } = {}) {
  const list = Array.isArray(tags) ? [...tags].sort((a, b) => a.name.localeCompare(b.name, "sv")) : [];
  if (!list.length && !editable) {
    return `<div class="tags-empty">Inga taggar.</div>`;
  }
  const chips = list
    .map((t) => {
      const remove = editable
        ? `<button type="button" class="tag-chip-x" data-act="remove-tag" data-tag-id="${escapeAttr(String(t.id))}" title="Ta bort tagg" aria-label="Ta bort ${escapeAttr(t.name)}">×</button>`
        : "";
      return `<span class="tag-chip" data-tag-id="${escapeAttr(String(t.id))}" data-tag-name="${escapeAttr(t.name)}" title="Dubbelklicka för att byta namn">
        <span class="tag-chip-label" data-act="rename-tag">${escapeHtml(t.name)}</span>${remove}
      </span>`;
    })
    .join("");
  return `<div class="tag-chips" id="leadTagChips">${chips || ""}</div>`;
}
