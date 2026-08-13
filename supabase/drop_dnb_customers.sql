-- Ta bort gamla DNB-tabellen efter lyckad migrering till tags.
-- Kör endast när DNB-taggar syns korrekt i UI.
--
-- Säkerhetskoll (valfritt, kör först):
--   SELECT count(*) FROM public.dnb_customers;
--   SELECT count(*) FROM public.lead_tags lt
--   JOIN public.tags t ON t.id = lt.tag_id
--   WHERE t.name_norm = 'dnb';
--   (antalen ska stämma överens)

DROP POLICY IF EXISTS "dnb_select" ON public.dnb_customers;
DROP POLICY IF EXISTS "dnb_insert" ON public.dnb_customers;
DROP POLICY IF EXISTS "dnb_delete" ON public.dnb_customers;

DROP TABLE IF EXISTS public.dnb_customers;
