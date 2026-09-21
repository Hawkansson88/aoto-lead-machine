-- AOTO Prospekt — låt prospect_list.excluded vara tom
--
-- Kolumnen skapades NOT NULL DEFAULT false, vilket gör att den aldrig kan
-- uttrycka "inget beslut fattat". Eftersom UI:t tolkar ett satt värde som ett
-- medvetet val stängdes mönsterlistan i prospect_exclusions av för varje
-- handlare som fick en rad — även när raden bara kom av att någon satte en
-- klass på bolaget.
--
-- Efter den här ändringen:
--   NULL   inget beslut, prospect_exclusions gäller
--   true   manuellt utesluten
--   false  manuellt tillbakatagen trots att mönsterlistan träffar
--
-- Befintliga false-värden lämnas orörda: de är beslut Anton fattat med flit.
--
-- Kör i Supabase SQL Editor.

ALTER TABLE public.prospect_list
  ALTER COLUMN excluded DROP NOT NULL;

ALTER TABLE public.prospect_list
  ALTER COLUMN excluded SET DEFAULT NULL;

COMMENT ON COLUMN public.prospect_list.excluded IS
  'NULL = inget beslut (prospect_exclusions styr), true = manuellt utesluten, false = manuellt tillbakatagen';
