-- Ta bort offerter (valfritt)
-- Kör i Supabase SQL Editor om du vill rensa quotes-tabellen helt

DROP POLICY IF EXISTS "Users manage own quotes" ON public.quotes;
DROP POLICY IF EXISTS "Public read published quotes" ON public.quotes;
DROP TABLE IF EXISTS public.quotes CASCADE;
