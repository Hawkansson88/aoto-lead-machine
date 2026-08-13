-- Taggar för återförsäljare (CRM-leads)
-- Kör i Supabase SQL Editor
--
-- 1) Skapar tags + lead_tags
-- 2) Migrerar befintliga DNB-kunder → taggen "DNB"
-- 3) (Valfritt) tar bort dnb_customers när migreringen är klar

-- ── Tabeller ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tags (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.tags IS 'Delade taggar (case-insensitive unika via name_norm)';
COMMENT ON COLUMN public.tags.name_norm IS 'lower(trim(name)) för unikhet';

CREATE TABLE IF NOT EXISTS public.lead_tags (
  lead_id BIGINT NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  tag_id BIGINT NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (lead_id, tag_id)
);

CREATE INDEX IF NOT EXISTS lead_tags_tag_id_idx ON public.lead_tags (tag_id);
CREATE INDEX IF NOT EXISTS lead_tags_lead_id_idx ON public.lead_tags (lead_id);

ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_tags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tags_select" ON public.tags;
DROP POLICY IF EXISTS "tags_insert" ON public.tags;
DROP POLICY IF EXISTS "tags_update" ON public.tags;
DROP POLICY IF EXISTS "tags_delete" ON public.tags;

CREATE POLICY "tags_select" ON public.tags
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "tags_insert" ON public.tags
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "tags_update" ON public.tags
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "tags_delete" ON public.tags
  FOR DELETE TO authenticated USING (true);

DROP POLICY IF EXISTS "lead_tags_select" ON public.lead_tags;
DROP POLICY IF EXISTS "lead_tags_insert" ON public.lead_tags;
DROP POLICY IF EXISTS "lead_tags_delete" ON public.lead_tags;

CREATE POLICY "lead_tags_select" ON public.lead_tags
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "lead_tags_insert" ON public.lead_tags
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "lead_tags_delete" ON public.lead_tags
  FOR DELETE TO authenticated USING (true);

-- ── Migrera DNB → tagg "DNB" ─────────────────────────────────────────────

INSERT INTO public.tags (name, name_norm)
VALUES ('DNB', 'dnb')
ON CONFLICT (name_norm) DO NOTHING;

INSERT INTO public.lead_tags (lead_id, tag_id, created_at, created_by)
SELECT
  d.lead_id,
  t.id,
  COALESCE(d.created_at, now()),
  d.created_by
FROM public.dnb_customers d
CROSS JOIN public.tags t
WHERE t.name_norm = 'dnb'
ON CONFLICT (lead_id, tag_id) DO NOTHING;

-- När DNB-taggarna syns korrekt i UI: kör supabase/drop_dnb_customers.sql
