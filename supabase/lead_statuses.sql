-- Utöka tillåtna lead-statusar (kör i Supabase SQL Editor)
-- Fixar: statusbyte till Behöver Kredit m.fl. sparas inte

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'leads'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE public.leads DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE public.leads
  DROP CONSTRAINT IF EXISTS leads_status_check;

ALTER TABLE public.leads
  ADD CONSTRAINT leads_status_check
  CHECK (status IN (
    'ny',
    'kontaktad',
    'mote',
    'ejaktuell',
    'skickad_kredit',
    'invantar_aterkoppling',
    'kund_aktiv'
  ));
