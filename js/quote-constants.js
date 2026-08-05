/** Standardmall för alla offerter */
export const QUOTE_TEMPLATE = {
  intro:
    "AOTO utmanar det traditionella sättet att finansiera lager. Nedan finner ni ett skräddarsytt förslag — transparent, rakt och utan dolda villkor.",
  validityDays: 30,
};

export function formatOfferId(offerId) {
  if (!offerId) return "–";
  return `AOTO-${String(offerId).replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

export function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function quotePublicUrl(publicToken) {
  return `${window.location.origin}/offert.html?t=${publicToken}`;
}
