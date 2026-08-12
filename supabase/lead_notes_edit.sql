-- Tillåt inloggade användare att uppdatera och ta bort anteckningar.
-- Kör i Supabase SQL Editor om ✎ / 🗑 ger behörighetsfel.

DROP POLICY IF EXISTS "lead_notes_update_authenticated" ON public.lead_notes;
CREATE POLICY "lead_notes_update_authenticated"
  ON public.lead_notes
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "lead_notes_delete_authenticated" ON public.lead_notes;
CREATE POLICY "lead_notes_delete_authenticated"
  ON public.lead_notes
  FOR DELETE
  TO authenticated
  USING (true);
