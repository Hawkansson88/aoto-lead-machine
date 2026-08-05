-- AOTO Lead Machine — Offerter (quotes)
-- Kör i Supabase SQL Editor

CREATE TABLE IF NOT EXISTS public.quotes (
  id BIGSERIAL PRIMARY KEY,
  offer_id UUID NOT NULL DEFAULT gen_random_uuid(),
  version INT NOT NULL DEFAULT 1,
  lead_id BIGINT NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  creator_email TEXT NOT NULL,
  company_name TEXT NOT NULL,
  org_nr TEXT NOT NULL,
  intro_text TEXT NOT NULL DEFAULT '',
  line_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  valid_until DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'accepted', 'superseded', 'expired')),
  public_token UUID UNIQUE,
  published_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  accepted_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (offer_id, version)
);

CREATE INDEX IF NOT EXISTS quotes_lead_id_idx ON public.quotes(lead_id);
CREATE INDEX IF NOT EXISTS quotes_offer_id_idx ON public.quotes(offer_id);
CREATE INDEX IF NOT EXISTS quotes_public_token_idx ON public.quotes(public_token)
  WHERE public_token IS NOT NULL;

ALTER TABLE public.quotes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own quotes" ON public.quotes;
CREATE POLICY "Users manage own quotes"
  ON public.quotes
  FOR ALL
  TO authenticated
  USING (created_by = auth.uid())
  WITH CHECK (created_by = auth.uid());

DROP POLICY IF EXISTS "Public read published quotes" ON public.quotes;
CREATE POLICY "Public read published quotes"
  ON public.quotes
  FOR SELECT
  TO anon
  USING (
    public_token IS NOT NULL
    AND (
      status = 'accepted'
      OR (status = 'published' AND valid_until >= CURRENT_DATE)
    )
  );
