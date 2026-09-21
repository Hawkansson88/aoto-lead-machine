-- AOTO — Prospektlista slutkundsleasing (fristående från CRM-leads)
-- Källa: Bilstatistik ReportTypeId -4, leasingaffärer till företagskund.
-- Se reference/bilstatistik/leasing-slutkund-request.json
-- Kör i Supabase SQL Editor.

-- ── Rådata: en rad per bil ───────────────────────────────────────────────
-- Sparas per transaktion så att listan kan skäras om utan nya API-uttag
-- (Bilstatistik har en frågegräns per dygn).

CREATE TABLE IF NOT EXISTS public.prospect_leasing_tx (
  id BIGSERIAL PRIMARY KEY,
  reg_nr TEXT NOT NULL,
  tx_date DATE NOT NULL,
  dealer_org_nr TEXT NOT NULL,
  dealer_name TEXT,
  prev_owner_org_nr TEXT,
  make_name TEXT,
  holding_time TEXT,
  finance_company TEXT,
  end_customer TEXT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (reg_nr, tx_date, dealer_org_nr)
);

CREATE INDEX IF NOT EXISTS prospect_leasing_tx_dealer_idx
  ON public.prospect_leasing_tx (dealer_org_nr);
CREATE INDEX IF NOT EXISTS prospect_leasing_tx_date_idx
  ON public.prospect_leasing_tx (tx_date);

COMMENT ON TABLE public.prospect_leasing_tx IS
  'Bilstatistik: leasingaffärer till företagskund, en rad per bil';
COMMENT ON COLUMN public.prospect_leasing_tx.dealer_org_nr IS
  'Föregående BRUKARE (= säljande ÅF). Ej föregående ägare, som vid lagerfinansiering är finansbolaget.';
COMMENT ON COLUMN public.prospect_leasing_tx.prev_owner_org_nr IS
  'Föregående ägare. Skiljer sig från dealer_org_nr när bilen låg på lagerfinansiering.';
COMMENT ON COLUMN public.prospect_leasing_tx.finance_company IS
  'Nuvarande ägare = leasinggivaren som finansierade affären (AOTO:s konkurrent på den affären)';
COMMENT ON COLUMN public.prospect_leasing_tx.end_customer IS
  'Nuvarande brukare = leasingtagaren (slutkunden)';

-- ── Aggregat per återförsäljare ──────────────────────────────────────────
-- Beräknas av netlify/functions/prospect-sync.mjs efter varje uttag.

CREATE TABLE IF NOT EXISTS public.prospect_dealers (
  org_nr TEXT PRIMARY KEY,
  company_name TEXT,
  deals_total INTEGER NOT NULL DEFAULT 0,
  distinct_customers INTEGER NOT NULL DEFAULT 0,
  deals_recent_90d INTEGER NOT NULL DEFAULT 0,
  deals_prev_90d INTEGER NOT NULL DEFAULT 0,
  floorplan_share NUMERIC,
  passthrough_share NUMERIC,
  first_tx DATE,
  last_tx DATE,
  finance_companies JSONB,
  makes JSONB,
  months JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.prospect_dealers IS
  'Aggregat per ÅF från prospect_leasing_tx';
COMMENT ON COLUMN public.prospect_dealers.deals_total IS
  'Antal leasingaffärer till företagskund i hämtad period — rankingens huvudmått';
COMMENT ON COLUMN public.prospect_dealers.distinct_customers IS
  'Unika slutkunder. Låg siffra mot deals_total = få storkunder, inte bredd.';
COMMENT ON COLUMN public.prospect_dealers.deals_recent_90d IS
  'Affärer senaste 90 dagarna av perioden';
COMMENT ON COLUMN public.prospect_dealers.deals_prev_90d IS
  'Affärer 90–180 dagar bakåt, för momentum-jämförelse';
COMMENT ON COLUMN public.prospect_dealers.floorplan_share IS
  'Andel affärer 0–1 där föregående ägare != ÅF, dvs. bilen låg på lagerfinansiering';
COMMENT ON COLUMN public.prospect_dealers.passthrough_share IS
  'Andel affärer 0–1 med innehavstid under en månad = ren förmedling, AOTO:s flöde';
COMMENT ON COLUMN public.prospect_dealers.finance_companies IS
  'JSON [{name, count}] — vilka leasinggivare ÅF:en använder idag';
COMMENT ON COLUMN public.prospect_dealers.makes IS 'JSON [{name, count}]';
COMMENT ON COLUMN public.prospect_dealers.months IS 'JSON {"2026-09": 12, ...}';

-- ── Arbetslista: status, ägare, anteckning ───────────────────────────────
-- Skiljd från aggregatet så att en ny synk aldrig skriver över ert arbete.

CREATE TABLE IF NOT EXISTS public.prospect_list (
  org_nr TEXT PRIMARY KEY,
  frozen_rank INTEGER,
  owner_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'ny',
  next_action TEXT,
  next_action_date DATE,
  note TEXT,
  -- NULL = inget beslut, prospect_exclusions styr. Se prospect_excluded_nullable.sql
  excluded BOOLEAN,
  excluded_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.prospect_list
  DROP CONSTRAINT IF EXISTS prospect_list_status_check;
ALTER TABLE public.prospect_list
  ADD CONSTRAINT prospect_list_status_check CHECK (
    status IN ('ny', 'kontaktad', 'bokat_besok', 'besokt', 'onboardad', 'nej')
  );

CREATE INDEX IF NOT EXISTS prospect_list_owner_idx ON public.prospect_list (owner_id);
CREATE INDEX IF NOT EXISTS prospect_list_status_idx ON public.prospect_list (status);

COMMENT ON COLUMN public.prospect_list.frozen_rank IS
  'Placering när listan frystes. Håller topp-100 stabil trots nya synkar.';

-- ── Uteslutningar: koncerner och finansbolag ─────────────────────────────
-- Redigerbar i UI. Matchas på org.nr eller namnmönster (ILIKE).

CREATE TABLE IF NOT EXISTS public.prospect_exclusions (
  id BIGSERIAL PRIMARY KEY,
  org_nr TEXT,
  name_pattern TEXT,
  kind TEXT NOT NULL DEFAULT 'koncern',
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (org_nr IS NOT NULL OR name_pattern IS NOT NULL)
);

ALTER TABLE public.prospect_exclusions
  DROP CONSTRAINT IF EXISTS prospect_exclusions_kind_check;
ALTER TABLE public.prospect_exclusions
  ADD CONSTRAINT prospect_exclusions_kind_check CHECK (
    kind IN ('koncern', 'finans', 'ej_af', 'annat')
  );

COMMENT ON TABLE public.prospect_exclusions IS
  'Bolag som aldrig ska med i prospektlistan. Filtrering sker lokalt, inte i Bilstatistik-anropet.';

-- Startvärden: koncerner AOTO har svårt att komma in på, plus finansbolag
-- och plattformar som läcker igenom branschfiltret.
INSERT INTO public.prospect_exclusions (name_pattern, kind, note)
SELECT v.pattern, v.kind, v.note
FROM (VALUES
  ('Hedin %',           'koncern', 'Koncern, många anläggningar'),
  ('Bilia %',           'koncern', 'Koncern'),
  ('Holmgrens Bil%',    'koncern', 'Koncern'),
  ('Riddermark Bil%',   'koncern', 'Rikstäckande kedja'),
  ('Din Bil %',         'koncern', 'Koncern'),
  ('Volvo Car Retail%', 'koncern', 'Tillverkarägd'),
  ('Veho Bil %',        'koncern', 'Koncern'),
  ('Möller Bil %',      'koncern', 'Koncern'),
  ('Bilbolaget %',      'koncern', 'Koncern'),
  ('Brandt Fordon%',    'koncern', 'Koncern'),
  ('Kamux %',           'koncern', 'Kedja'),
  ('Kvdbil%',           'koncern', 'Auktionsplattform'),
  ('Ayvens %',          'finans',  'Leasingbolag, ej ÅF'),
  ('% Finans %',        'finans',  'Finansbolag'),
  ('%Handlarfinans%',   'finans',  'Finansbolag'),
  ('Santander %',       'finans',  'Finansbolag'),
  ('NF Fleet%',         'finans',  'Leasingbolag'),
  ('AutoRemarketing%',  'finans',  'Remarketing, ej ÅF'),
  ('Circle K %',        'ej_af',   'Drivmedelskedja'),
  ('PLC Invest%',       'ej_af',   'Ej bilhandel'),
  ('Truxco %',          'ej_af',   'Ej bilhandel')
) AS v(pattern, kind, note)
WHERE NOT EXISTS (
  SELECT 1 FROM public.prospect_exclusions e WHERE e.name_pattern = v.pattern
);

-- ── Synk-metadata ────────────────────────────────────────────────────────
-- Perioden som Bilstatistik faktiskt returnerar (DateRangeOptionId 1 är
-- obekräftad) läses ut ur datan och sparas här vid varje synk.

INSERT INTO public.app_state (key, value)
VALUES ('prospect_sync', '{}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── RLS ──────────────────────────────────────────────────────────────────

ALTER TABLE public.prospect_leasing_tx ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prospect_dealers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prospect_list ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prospect_exclusions ENABLE ROW LEVEL SECURITY;

-- Läsning: hela teamet. Skrivning av rådata/aggregat: service role från
-- Netlify-funktionen (går förbi RLS).

DROP POLICY IF EXISTS "prospect_leasing_tx_select" ON public.prospect_leasing_tx;
CREATE POLICY "prospect_leasing_tx_select" ON public.prospect_leasing_tx
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "prospect_dealers_select" ON public.prospect_dealers;
CREATE POLICY "prospect_dealers_select" ON public.prospect_dealers
  FOR SELECT TO authenticated USING (true);

-- Arbetslistan och uteslutningarna redigeras av teamet i UI.

DROP POLICY IF EXISTS "prospect_list_select" ON public.prospect_list;
CREATE POLICY "prospect_list_select" ON public.prospect_list
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "prospect_list_write" ON public.prospect_list;
CREATE POLICY "prospect_list_write" ON public.prospect_list
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "prospect_exclusions_select" ON public.prospect_exclusions;
CREATE POLICY "prospect_exclusions_select" ON public.prospect_exclusions
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "prospect_exclusions_write" ON public.prospect_exclusions;
CREATE POLICY "prospect_exclusions_write" ON public.prospect_exclusions
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
