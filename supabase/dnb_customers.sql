-- DNB-kundflaggor — kör i Supabase SQL Editor
-- Kopplar leads till DNB-status (en rad per lead)

CREATE TABLE IF NOT EXISTS public.dnb_customers (
  lead_id BIGINT PRIMARY KEY REFERENCES public.leads(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS dnb_customers_created_at_idx ON public.dnb_customers(created_at);

ALTER TABLE public.dnb_customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "dnb_select" ON public.dnb_customers;
DROP POLICY IF EXISTS "dnb_insert" ON public.dnb_customers;
DROP POLICY IF EXISTS "dnb_delete" ON public.dnb_customers;

CREATE POLICY "dnb_select" ON public.dnb_customers
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "dnb_insert" ON public.dnb_customers
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "dnb_delete" ON public.dnb_customers
  FOR DELETE TO authenticated USING (true);
