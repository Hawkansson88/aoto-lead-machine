-- Bilstatistik: marknadsdata per återförsäljare
-- Kör i Supabase SQL Editor

-- ── Aggregerade nyckeltal ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.dealer_market_stats (
  org_nr TEXT PRIMARY KEY,
  company_name TEXT,
  lagerantal INTEGER,
  saljvolym_12m INTEGER,
  leasing_andel NUMERIC,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.dealer_market_stats IS 'Fordonsdata från Bilstatistik (lager, sälj, leasing)';
COMMENT ON COLUMN public.dealer_market_stats.org_nr IS '10 siffror utan bindestreck';
COMMENT ON COLUMN public.dealer_market_stats.lagerantal IS 'Antal fordon i bestånd/lager';
COMMENT ON COLUMN public.dealer_market_stats.saljvolym_12m IS 'Säljvolym senaste 12 mån (fylls via försäljningsrapport)';
COMMENT ON COLUMN public.dealer_market_stats.leasing_andel IS 'Leasing-andel 0–1 eller % beroende på källa';

-- Privat vs företag (retail-sälj 12 mån)
ALTER TABLE public.dealer_market_stats
  ADD COLUMN IF NOT EXISTS salj_privat_12m INTEGER;

ALTER TABLE public.dealer_market_stats
  ADD COLUMN IF NOT EXISTS salj_foretag_12m INTEGER;

COMMENT ON COLUMN public.dealer_market_stats.salj_privat_12m IS 'Retail-sälj till privatperson senaste 12 mån';
COMMENT ON COLUMN public.dealer_market_stats.salj_foretag_12m IS 'Retail-sälj till företag (icke-privat) senaste 12 mån';

-- Lagerfinansiering (Steg 3)
ALTER TABLE public.dealer_market_stats
  ADD COLUMN IF NOT EXISTS lager_finansierat_antal INTEGER;

ALTER TABLE public.dealer_market_stats
  ADD COLUMN IF NOT EXISTS lager_finansierat_andel NUMERIC;

ALTER TABLE public.dealer_market_stats
  ADD COLUMN IF NOT EXISTS lager_finansbolag JSONB;

COMMENT ON COLUMN public.dealer_market_stats.lager_finansierat_antal IS 'Antal fordon i operativt lager där ägare != dealer';
COMMENT ON COLUMN public.dealer_market_stats.lager_finansierat_andel IS 'Andel lagerfinansierat 0–1';
COMMENT ON COLUMN public.dealer_market_stats.lager_finansbolag IS 'JSON-array [{name, count, share}] per finansbolag';

-- Firmografi från Bilstatistik bulk (bestånd per brukare)
ALTER TABLE public.dealer_market_stats
  ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE public.dealer_market_stats
  ADD COLUMN IF NOT EXISTS postcode TEXT;
ALTER TABLE public.dealer_market_stats
  ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE public.dealer_market_stats
  ADD COLUMN IF NOT EXISTS industry TEXT;
ALTER TABLE public.dealer_market_stats
  ADD COLUMN IF NOT EXISTS established_year INTEGER;
ALTER TABLE public.dealer_market_stats
  ADD COLUMN IF NOT EXISTS employees INTEGER;
ALTER TABLE public.dealer_market_stats
  ADD COLUMN IF NOT EXISTS turnover_tkr NUMERIC;
ALTER TABLE public.dealer_market_stats
  ADD COLUMN IF NOT EXISTS equity_tkr NUMERIC;
ALTER TABLE public.dealer_market_stats
  ADD COLUMN IF NOT EXISTS profit_tkr NUMERIC;
ALTER TABLE public.dealer_market_stats
  ADD COLUMN IF NOT EXISTS bulk_updated_at TIMESTAMPTZ;

COMMENT ON COLUMN public.dealer_market_stats.bulk_updated_at IS 'Senaste bulk-import från Bilstatistik marknadsrapport';

ALTER TABLE public.dealer_market_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "dealer_market_stats_select" ON public.dealer_market_stats;
CREATE POLICY "dealer_market_stats_select" ON public.dealer_market_stats
  FOR SELECT TO authenticated
  USING (true);

-- Skriver sker via service role från Netlify-funktion

-- ── Märkesfördelning ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.dealer_vehicle_brands (
  id BIGSERIAL PRIMARY KEY,
  org_nr TEXT NOT NULL REFERENCES public.dealer_market_stats(org_nr) ON DELETE CASCADE,
  make_name TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  share NUMERIC,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_nr, make_name)
);

CREATE INDEX IF NOT EXISTS dealer_vehicle_brands_org_nr_idx
  ON public.dealer_vehicle_brands (org_nr);

ALTER TABLE public.dealer_vehicle_brands ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "dealer_vehicle_brands_select" ON public.dealer_vehicle_brands;
CREATE POLICY "dealer_vehicle_brands_select" ON public.dealer_vehicle_brands
  FOR SELECT TO authenticated
  USING (true);
