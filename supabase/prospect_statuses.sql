-- AOTO Prospekt — handlarklassning A/B/C
--
-- Ersätter den CRM-lika statuskedjan (ny → kontaktad → bokat besök …) med den
-- klassning Anton och Marc faktiskt jobbar efter under höstens kampanj.
--
-- Kör i Supabase SQL Editor efter supabase/prospect_list.sql.

-- Släpp det gamla villkoret först: det känner inte till 'oklassad', så en
-- migrering innan detta steg avvisas av just den regel vi är på väg att byta ut.
ALTER TABLE public.prospect_list
  DROP CONSTRAINT IF EXISTS prospect_list_status_check;

-- Migrera befintliga värden: allt oarbetat blir oklassat.
UPDATE public.prospect_list
SET status = 'oklassad', updated_at = now()
WHERE status NOT IN ('a', 'b', 'c');

ALTER TABLE public.prospect_list
  ADD CONSTRAINT prospect_list_status_check CHECK (
    status IN ('oklassad', 'a', 'b', 'c')
  );

ALTER TABLE public.prospect_list
  ALTER COLUMN status SET DEFAULT 'oklassad';

COMMENT ON COLUMN public.prospect_list.status IS
  'Handlarklassning: oklassad (ej bedömd än), a, b eller c';
