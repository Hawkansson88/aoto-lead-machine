-- AOTO Prospekt — koordinater för kartan
--
-- Adresserna ligger redan i dealer_market_stats, så koordinaterna läggs
-- bredvid dem i stället för i en egen tabell. Det håller adress och position
-- på samma rad och gör att CRM:et kan dra nytta av dem också.
--
-- Fylls av scripts/prospect-geocode.mjs (Nominatim, max 1 uppslag/sekund).
--
-- Kör i Supabase SQL Editor.

ALTER TABLE public.dealer_market_stats
  ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
ALTER TABLE public.dealer_market_stats
  ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
ALTER TABLE public.dealer_market_stats
  ADD COLUMN IF NOT EXISTS geocoded_at TIMESTAMPTZ;

COMMENT ON COLUMN public.dealer_market_stats.lat IS
  'Latitud från Nominatim-uppslag på adressen';
COMMENT ON COLUMN public.dealer_market_stats.lng IS
  'Longitud från Nominatim-uppslag på adressen';
COMMENT ON COLUMN public.dealer_market_stats.geocoded_at IS
  'När uppslaget gjordes. Satt men lat/lng NULL = adressen gick inte att hitta, försök inte igen.';

-- Kartan hämtar alla med koordinater i ett svep
CREATE INDEX IF NOT EXISTS dealer_market_stats_coords_idx
  ON public.dealer_market_stats (lat, lng)
  WHERE lat IS NOT NULL;
