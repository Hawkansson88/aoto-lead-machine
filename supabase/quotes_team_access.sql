-- Tillåt alla inloggade att läsa/skriva offerter (team-CRM)
-- Kör i Supabase SQL Editor om quotes.sql redan körts tidigare

DROP POLICY IF EXISTS "Users manage own quotes" ON public.quotes;
CREATE POLICY "Users manage own quotes"
  ON public.quotes
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);
