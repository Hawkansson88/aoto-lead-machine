-- Roller, kreditflöde och noteringsförfattare
-- Kör i Supabase SQL Editor

-- ── Profiler ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'saljare'
    CHECK (role IN ('admin', 'saljare', 'kredit')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
CREATE POLICY "profiles_select" ON public.profiles
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
CREATE POLICY "profiles_insert_own" ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    AND role = (SELECT p.role FROM public.profiles p WHERE p.id = auth.uid())
  );

-- Befintliga auth-användare får en profil (standardroll: säljare)
INSERT INTO public.profiles (id, email, first_name, last_name, role)
SELECT
  u.id,
  COALESCE(u.email, ''),
  COALESCE(NULLIF(split_part(COALESCE(u.email, ''), '@', 1), ''), 'Användare'),
  '',
  'saljare'
FROM auth.users u
ON CONFLICT (id) DO NOTHING;

-- Sätt dig själv till admin efter körning, t.ex.:
-- UPDATE public.profiles SET role = 'admin', first_name = 'Anton', last_name = 'Håkansson'
-- WHERE email = 'din@email.se';

-- ── Kreditflaggor på leads ───────────────────────────────────────────────

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS kyc_approved BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS kredit_pm_klart BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS kredit_beviljad BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.leads.kyc_approved IS 'KYC beviljad';
COMMENT ON COLUMN public.leads.kredit_pm_klart IS 'Kredit-PM klart';
COMMENT ON COLUMN public.leads.kredit_beviljad IS 'Kredit beviljad (kräver KYC + Kredit-PM)';

-- Nya statusvärden (textkolumn, ingen CHECK idag):
-- skickad_kredit, invantar_aterkoppling, kund_aktiv

-- ── Noteringsförfattare ──────────────────────────────────────────────────

ALTER TABLE public.lead_notes
  ADD COLUMN IF NOT EXISTS author_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.lead_notes
  ADD COLUMN IF NOT EXISTS author_name TEXT;

UPDATE public.lead_notes
SET author_name = 'Anton'
WHERE author_name IS NULL OR author_name = '';

COMMENT ON COLUMN public.lead_notes.author_name IS 'Förnamn som visas i noteringsloggen';
