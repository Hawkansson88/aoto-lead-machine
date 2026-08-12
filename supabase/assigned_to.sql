-- Tilldela kollega: assigned_to på leads + auto-profil vid ny auth-användare
-- Kör i Supabase SQL Editor
-- OBS: profiles finns redan (first_name, last_name, email, role) via roles_credit.sql

-- ── assigned_to på leads ─────────────────────────────────────────────────

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS leads_assigned_to_idx ON public.leads (assigned_to);

COMMENT ON COLUMN public.leads.assigned_to IS 'Ägare (kollega) — nullable = otilldelad';

-- ── Auto-skapa profil vid nytt konto ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, first_name, last_name, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.email, ''),
    COALESCE(NULLIF(split_part(COALESCE(NEW.email, ''), '@', 1), ''), 'Användare'),
    '',
    'saljare'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE PROCEDURE public.handle_new_user();
