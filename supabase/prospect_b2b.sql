-- AOTO Prospekt — korrekt nämnare till leasingandelen
--
-- Beståndsimportens salj_foretag_12m räknar varje företagsköpare, inklusive
-- andra bilhandlare. För Piston Motors gav den 72 företagsaffärer där det
-- verkliga antalet till slutkund var 24 — partihandeln stod för resten.
-- Andelen blev därmed inte bara för låg utan olika mycket för låg beroende på
-- hur mycket partihandel bolaget gör, alltså oduglig att jämföra med.
--
-- Siffrorna här kommer från samma filter som leasingfrågan, minus
-- leasingvillkoret, och hämtas av scripts/prospect-b2b-counts.mjs.
--
-- Kör i Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS public.prospect_b2b_counts (
  org_nr TEXT PRIMARY KEY,
  period TEXT NOT NULL,
  b2b_deals INTEGER NOT NULL,
  leasing_deals INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.prospect_b2b_counts IS
  'Alla företagsaffärer till slutkund per ÅF. Nämnare till leasingandelen.';
COMMENT ON COLUMN public.prospect_b2b_counts.period IS
  'Vilken Bilstatistik-period talet avser, t.ex. "ytd". Täljaren måste räknas över samma period.';
COMMENT ON COLUMN public.prospect_b2b_counts.b2b_deals IS
  'Företagsaffärer till slutkund, oavsett finansiering. Bilhandlare uteslutna som köpare.';
COMMENT ON COLUMN public.prospect_b2b_counts.leasing_deals IS
  'Leasingaffärer över samma period, räknade ur prospect_leasing_tx. Andelen = leasing_deals / b2b_deals.';

ALTER TABLE public.prospect_b2b_counts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "prospect_b2b_counts_select" ON public.prospect_b2b_counts;
CREATE POLICY "prospect_b2b_counts_select" ON public.prospect_b2b_counts
  FOR SELECT TO authenticated USING (true);

-- Skrivning sker med service role från scripts/prospect-b2b-counts.mjs
