-- AOTO Prospekt — aggregering i databasen
--
-- Flyttar beräkningen från Netlify-funktionen till en SQL-funktion, så att
-- prospect_dealers kan räknas om från redan sparad rådata utan ett nytt
-- Bilstatistik-uttag (API:t är ransonerat per dygn).
--
-- Kör i Supabase SQL Editor efter supabase/prospect_list.sql.

-- ── Nytt mått: hur många finansbolag ÅF:en sprider affärerna på ──────────
-- Ersätter passthrough_share i listvyn, som visade sig vara 100 % för alla:
-- filtret fångar bara förmedlingsaffärer, så andelen kan inte variera.

ALTER TABLE public.prospect_dealers
  ADD COLUMN IF NOT EXISTS finance_company_count INTEGER;

COMMENT ON COLUMN public.prospect_dealers.finance_company_count IS
  'Antal olika leasinggivare ÅF:en använt i perioden. 1 = allt genom en part, lättare att ta över.';

-- Eftersläpningen i Bilstatistik gör de senaste veckorna underrapporterade.
-- Momentum jämför därför dag 30–120 mot dag 120–210 bakåt, inte 0–90 mot
-- 90–180: då hamnar eftersläpningen utanför båda halvorna.
COMMENT ON COLUMN public.prospect_dealers.deals_recent_90d IS
  'Affärer dag 30–120 bakåt från senaste transaktionen (30 dagars eftersläpningsmarginal)';
COMMENT ON COLUMN public.prospect_dealers.deals_prev_90d IS
  'Affärer dag 120–210 bakåt, jämförelseperiod för momentum';

-- ── Omräkning ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.recompute_prospect_dealers()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max_date   date;
  v_min_date   date;
  v_window     date;
  v_recent_to  date;
  v_recent_fr  date;
  v_prev_to    date;
  v_prev_fr    date;
  v_dealers    integer;
  v_tx         integer;
BEGIN
  SELECT min(tx_date), max(tx_date) INTO v_min_date, v_max_date
  FROM prospect_leasing_tx;

  IF v_max_date IS NULL THEN
    RETURN jsonb_build_object('dealers', 0, 'transactions', 0, 'period', NULL);
  END IF;

  v_window    := v_max_date - 365;
  v_recent_to := v_max_date - 30;
  v_recent_fr := v_max_date - 120;
  v_prev_to   := v_max_date - 120;
  v_prev_fr   := v_max_date - 210;

  DELETE FROM prospect_dealers;

  WITH win AS (
    SELECT * FROM prospect_leasing_tx WHERE tx_date >= v_window
  ),
  base AS (
    SELECT
      dealer_org_nr AS org_nr,
      (array_agg(dealer_name ORDER BY tx_date DESC))[1] AS company_name,
      count(*)::int AS deals_total,
      count(DISTINCT lower(end_customer))::int AS distinct_customers,
      count(*) FILTER (
        WHERE tx_date > v_recent_fr AND tx_date <= v_recent_to
      )::int AS deals_recent_90d,
      count(*) FILTER (
        WHERE tx_date > v_prev_fr AND tx_date <= v_prev_to
      )::int AS deals_prev_90d,
      count(DISTINCT finance_company)::int AS finance_company_count,
      avg(
        CASE
          WHEN prev_owner_org_nr IS NOT NULL AND prev_owner_org_nr <> dealer_org_nr
          THEN 1 ELSE 0
        END
      )::numeric AS floorplan_share,
      min(tx_date) AS first_tx,
      max(tx_date) AS last_tx
    FROM win
    GROUP BY dealer_org_nr
  ),
  fin AS (
    SELECT org_nr, jsonb_agg(entry ORDER BY cnt DESC) AS finance_companies
    FROM (
      SELECT
        dealer_org_nr AS org_nr,
        count(*)::int AS cnt,
        jsonb_build_object('name', finance_company, 'count', count(*)::int) AS entry
      FROM win
      WHERE finance_company IS NOT NULL
      GROUP BY dealer_org_nr, finance_company
    ) s
    GROUP BY org_nr
  ),
  mk AS (
    SELECT org_nr, jsonb_agg(entry ORDER BY cnt DESC) AS makes
    FROM (
      SELECT
        dealer_org_nr AS org_nr,
        count(*)::int AS cnt,
        jsonb_build_object('name', make_name, 'count', count(*)::int) AS entry
      FROM win
      WHERE make_name IS NOT NULL
      GROUP BY dealer_org_nr, make_name
    ) s
    GROUP BY org_nr
  ),
  mo AS (
    SELECT org_nr, jsonb_object_agg(month, cnt ORDER BY month) AS months
    FROM (
      SELECT
        dealer_org_nr AS org_nr,
        to_char(tx_date, 'YYYY-MM') AS month,
        count(*)::int AS cnt
      FROM win
      GROUP BY dealer_org_nr, to_char(tx_date, 'YYYY-MM')
    ) s
    GROUP BY org_nr
  )
  INSERT INTO prospect_dealers (
    org_nr, company_name, deals_total, distinct_customers,
    deals_recent_90d, deals_prev_90d, finance_company_count,
    floorplan_share, passthrough_share, first_tx, last_tx,
    finance_companies, makes, months, updated_at
  )
  SELECT
    b.org_nr, b.company_name, b.deals_total, b.distinct_customers,
    b.deals_recent_90d, b.deals_prev_90d, b.finance_company_count,
    round(b.floorplan_share, 4),
    -- Kvar för historikens skull; filtret gör den 1 för alla, så den visas inte
    NULL,
    b.first_tx, b.last_tx,
    COALESCE(f.finance_companies, '[]'::jsonb),
    COALESCE(m.makes, '[]'::jsonb),
    COALESCE(mo.months, '{}'::jsonb),
    now()
  FROM base b
  LEFT JOIN fin f ON f.org_nr = b.org_nr
  LEFT JOIN mk m ON m.org_nr = b.org_nr
  LEFT JOIN mo ON mo.org_nr = b.org_nr;

  GET DIAGNOSTICS v_dealers = ROW_COUNT;
  SELECT count(*)::int INTO v_tx FROM prospect_leasing_tx WHERE tx_date >= v_window;

  RETURN jsonb_build_object(
    'dealers', v_dealers,
    'transactions', v_tx,
    'period', jsonb_build_object(
      'first_tx', v_min_date,
      'last_tx', v_max_date,
      'window_start', v_window,
      'window_days', 365,
      'span_days', v_max_date - v_min_date,
      'momentum_recent', jsonb_build_array(v_recent_fr, v_recent_to),
      'momentum_prev', jsonb_build_array(v_prev_fr, v_prev_to)
    )
  );
END;
$$;

COMMENT ON FUNCTION public.recompute_prospect_dealers() IS
  'Bygger om prospect_dealers från prospect_leasing_tx. Kräver inget Bilstatistik-uttag.';

GRANT EXECUTE ON FUNCTION public.recompute_prospect_dealers() TO authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_prospect_dealers() TO service_role;
