-- Uppdatera tillåtna lead-statusar
-- Tar bort: mote, invantar_aterkoppling
-- Behåller skickad_kredit (= "Kredit önskas" i UI)
-- Kör i Supabase SQL Editor

-- Migrera borttagna statusar till närmaste giltiga
UPDATE public.leads SET status = 'kontaktad', updated_at = now()
WHERE status = 'mote';

UPDATE public.leads SET status = 'skickad_kredit', updated_at = now()
WHERE status = 'invantar_aterkoppling';

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
    'ejaktuell',
    'skickad_kredit',
    'kund_aktiv'
  ));
