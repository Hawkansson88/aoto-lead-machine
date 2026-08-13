/** Floating tooltip for [data-tip] hosts — escapes overflow/transform containers (e.g. panel). */

const HOST_SEL = ".has-tip[data-tip], .kpi-tip[data-tip]";

let tipEl = null;
let activeHost = null;
let bound = false;

function ensureTipEl() {
  if (tipEl) return tipEl;
  tipEl = document.createElement("div");
  tipEl.className = "floating-tip";
  tipEl.setAttribute("role", "tooltip");
  tipEl.hidden = true;
  document.body.appendChild(tipEl);
  return tipEl;
}

function hideTip() {
  activeHost = null;
  if (!tipEl) return;
  tipEl.hidden = true;
  tipEl.textContent = "";
}

function placeTip(host) {
  const el = ensureTipEl();
  const text = host.getAttribute("data-tip") || "";
  if (!text.trim()) {
    hideTip();
    return;
  }

  activeHost = host;
  el.hidden = false;
  el.textContent = text;

  const rect = host.getBoundingClientRect();
  const tipRect = el.getBoundingClientRect();
  const pad = 8;
  const gap = 8;

  let top = rect.top - tipRect.height - gap;
  let preferBelow = host.classList.contains("tip-below") || top < pad;
  if (preferBelow) {
    top = rect.bottom + gap;
    if (top + tipRect.height > window.innerHeight - pad) {
      top = Math.max(pad, rect.top - tipRect.height - gap);
    }
  }

  let left = rect.left + rect.width / 2 - tipRect.width / 2;
  left = Math.min(Math.max(pad, left), window.innerWidth - tipRect.width - pad);

  el.style.top = `${Math.round(top)}px`;
  el.style.left = `${Math.round(left)}px`;
}

function onMove(e) {
  const host = e.target.closest?.(HOST_SEL);
  if (!host || !(host.getAttribute("data-tip") || "").trim()) {
    if (activeHost) hideTip();
    return;
  }
  if (activeHost !== host) placeTip(host);
  else placeTip(host);
}

function onLeave(e) {
  const next = e.relatedTarget;
  if (activeHost && next && activeHost.contains(next)) return;
  if (activeHost && next?.closest?.(HOST_SEL) === activeHost) return;
  hideTip();
}

function onScrollOrResize() {
  if (activeHost) placeTip(activeHost);
}

/** Call once per page. Safe to call multiple times. */
export function bindFloatingTips() {
  if (bound) return;
  bound = true;
  ensureTipEl();
  document.addEventListener("pointerover", onMove);
  document.addEventListener("pointerout", onLeave);
  document.addEventListener("focusin", (e) => {
    const host = e.target.closest?.(HOST_SEL);
    if (host) placeTip(host);
  });
  document.addEventListener("focusout", () => hideTip());
  window.addEventListener("scroll", onScrollOrResize, true);
  window.addEventListener("resize", onScrollOrResize);
}
