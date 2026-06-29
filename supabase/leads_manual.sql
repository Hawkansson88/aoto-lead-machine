-- Manuell kundskapande — kör i Supabase SQL Editor
-- Lägger till eget kapital och INSERT-policy för inloggade användare

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS equity BIGINT;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS address TEXT;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS postal_address TEXT;

COMMENT ON COLUMN public.leads.equity IS 'Eget kapital i SEK';
COMMENT ON COLUMN public.leads.address IS 'Gatuadress';
COMMENT ON COLUMN public.leads.postal_address IS 'Postadress (postnummer och ort)';

ALTER TABLE public.leads
  ALTER COLUMN roaring_company_id DROP NOT NULL;

DROP POLICY IF EXISTS "leads_insert" ON public.leads;

CREATE POLICY "leads_insert" ON public.leads
  FOR INSERT TO authenticated
  WITH CHECK (true);
