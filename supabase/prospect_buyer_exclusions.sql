-- AOTO Prospekt — köpare som inte är slutkunder
--
-- Leasingandelens nämnare ska vara affärer till riktiga företagskunder. Men
-- handlare gör sig också av med inbyten via B2B-auktioner och trading-bolag,
-- och de räknades in.
--
-- Tesla (TM Sweden AB) är det tydligaste fallet: 1 054 "företagsaffärer" år
-- till datum, varav 748 till AUTOproff ensamt. Filtrerar man bort AUTOproff
-- återstår 306. Deras verkliga leasingandel är därmed omkring 20 %, inte 6 %.
--
-- Mellanhänderna slank igenom branschfiltret för att de inte är registrerade
-- som bilhandel. AUTOproff och Handlarbudet har SNI 47920, "Förmedling
-- avseende specialiserad detaljhandel".
--
-- Bilstatistik kräver numeriska branschid i filtret och har inget sätt att
-- översätta SNI dit (TradeName utan Values avvisas). Därför svartlistas de på
-- org.nr i stället, via CompanyIdentifiers med Negate — vilket är verifierat
-- att fungera.
--
-- Kör i Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS public.prospect_buyer_exclusions (
  org_nr TEXT PRIMARY KEY,
  company_name TEXT,
  sni TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.prospect_buyer_exclusions IS
  'Köpare som inte är slutkunder — B2B-auktioner, grossister, exportmellanhänder. Negeras i nämnarfrågan.';
COMMENT ON COLUMN public.prospect_buyer_exclusions.org_nr IS
  '10 siffror. Skickas som CompanyIdentifiers med Negate på Owner och User.';

INSERT INTO public.prospect_buyer_exclusions (org_nr, company_name, sni, note)
SELECT v.org_nr, v.name, v.sni, v.note
FROM (VALUES
  ('5592042344', 'AUTOproff Sverige AB', '47920',
   'B2B-auktionsplattform. Tog emot 748 av Teslas 1054 företagsaffärer YTD 2026.'),
  ('5593885345', 'Handlarbudet Trading AB', '47920',
   'Trading-bolag. 66 av 300 i samma urval.')
) AS v(org_nr, name, sni, note)
WHERE NOT EXISTS (
  SELECT 1 FROM public.prospect_buyer_exclusions e WHERE e.org_nr = v.org_nr
);

ALTER TABLE public.prospect_buyer_exclusions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "prospect_buyer_exclusions_select" ON public.prospect_buyer_exclusions;
CREATE POLICY "prospect_buyer_exclusions_select" ON public.prospect_buyer_exclusions
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "prospect_buyer_exclusions_write" ON public.prospect_buyer_exclusions;
CREATE POLICY "prospect_buyer_exclusions_write" ON public.prospect_buyer_exclusions
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── Köparens identitet i rådatan ─────────────────────────────────────────
-- Med org.nr och SNI på köparen går mellanhänder att upptäcka i efterhand,
-- utan att man behöver gissa sig till dem via namn.

ALTER TABLE public.prospect_leasing_tx
  ADD COLUMN IF NOT EXISTS end_customer_org_nr TEXT;
ALTER TABLE public.prospect_leasing_tx
  ADD COLUMN IF NOT EXISTS end_customer_trade TEXT;

COMMENT ON COLUMN public.prospect_leasing_tx.end_customer_org_nr IS
  'Slutkundens org.nr (utdatakolumn 34)';
COMMENT ON COLUMN public.prospect_leasing_tx.end_customer_trade IS
  'Slutkundens SNI-bransch (utdatakolumn 35), t.ex. "47920 Förmedling avseende specialiserad detaljhandel"';
