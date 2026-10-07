-- ============================================================
-- card-metrics.postgres.sql — הסטטיסטיקות של כרטיסי הדשבורד, פעם אחת לכולם
-- ============================================================
-- ⚠️ **למה זה קיים — נמדד ב-07/10/2026.** המסד (NANO) נשאר בלי קרדיטים
-- למעבד וההתחברות החזירה 504. ב-pg_stat_statements, 97% מזמן המסד היו
-- ארבע קריאות שכל מסך פתוח הריץ בעצמו כל דקה: site_stats (פעמיים — התקופה
-- והקודמת, לחץ המגמה), site_uptime_service, site_uptime. ~12 שניות מסד לטעינה.
--
-- הדשבורד כבר תוקן לחשב רק בכניסה לדף (utils/siteSync.js). מה שנשאר: כל מסך
-- שנכנס מריץ את אותו חישוב בדיוק — ו"רענון לכולם" הוא 6 מסכים × 12 שניות
-- באותה שנייה. הנתונים זהים לכולם (כל משתמש רואה כל אתר), ולכן אין שום
-- סיבה שהחישוב ירוץ פעם למסך.
--
-- כאן: `app.refresh_site_card_metrics()` מריצה את **אותן ארבע פונקציות** פעם
-- אחת, ב-pg_cron כל 10 דקות (cron.postgres.sql), ושומרת שורה לכל אתר. המסך
-- קורא את הטבלה — שאילתה אחת, אלפיות שנייה.
--
-- ⚠️ **אותן פונקציות, לא העתק שלהן.** שום מדד לא הוגדר מחדש כאן: כל עמודה
-- היא הפלט של הפונקציה הקיימת, כמו שהוא. הכלל ש"כל מדד מוגדר במקום אחד"
-- נשמר, ואין כאן פריטי parity חדשים — רק החלון, שחייב להיות זהה לזה שהדשבורד
-- ביקש (`app.card_metrics_window`, ובדיקה מולו ב-tests/card-metrics.test.js).
--
-- ⚠️ **json ולא jsonb, בכוונה.** jsonb ממיר double precision ל-numeric עם 15
-- ספרות; PostgREST מחזיר json עם הייצוג המלא. json שומר את הטקסט של
-- float8out — אותו מספר בדיוק שהמסך קיבל עד היום.

CREATE TABLE IF NOT EXISTS public.site_card_metrics (
  site_id     INTEGER PRIMARY KEY REFERENCES public.sites(id) ON DELETE CASCADE,
  computed_at TEXT NOT NULL,     -- ISO 8601 UTC — סוף החלון, כלומר "נכון ל-"
  period_from TEXT NOT NULL,
  period_to   TEXT NOT NULL,
  prev_from   TEXT NOT NULL,     -- התקופה הקודמת: [prev_from, period_from)
  stats       JSON,              -- שורת site_stats(period_from, period_to)
  prev        JSON,              -- שורת site_stats(prev_from, period_from) — לחץ המגמה
  uptime      JSON,              -- שורת site_uptime(period_from, period_to)
  svc         JSON               -- שורת site_uptime_service — רק לאתר שחובר ברמזור
);

-- ⚠️ אותו כלל כמו בכל טבלה שהדשבורד קורא: משתמש פעיל קורא הכול, אף אחד
-- לא כותב מהדפדפן. רק הפונקציה (כבעלים) כותבת.
ALTER TABLE public.site_card_metrics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_card_metrics_read_authenticated ON public.site_card_metrics;
CREATE POLICY site_card_metrics_read_authenticated ON public.site_card_metrics
  FOR SELECT TO authenticated USING ((SELECT app.is_active_user()));
REVOKE ALL ON public.site_card_metrics FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.site_card_metrics TO authenticated;

-- ============================================================
-- app.card_metrics_window — **אותו** חלון שהדשבורד ביקש
-- ============================================================
-- dataSource.js: periodFromIso("week") — חצות **מקומית** (הדפדפן בישראל)
-- לפני 6 ימים; והקודמת: from − (now − from), כלומר באותו אורך בדיוק
-- (prevWeekFromIso). שני פרטים שקל לטעות בהם, ושניהם נבדקים:
--   • "6 ימים" הם ימי **לוח** מקומיים — חצות נשארת חצות גם מעבר לשעון קיץ.
--   • התקופה הקודמת היא חיסור של **מילישניות**, כמו ב-JS — ולא interval
--     של ימים, שהיה זז בשעה כשמעבר שעון נופל בתוכה.
CREATE OR REPLACE FUNCTION app.card_metrics_window(p_now timestamptz DEFAULT now())
RETURNS TABLE (period_from text, period_to text, prev_from text)
LANGUAGE sql
STABLE
AS $$
  WITH b AS (
    SELECT p_now AS now_t,
           (date_trunc('day', p_now AT TIME ZONE 'Asia/Jerusalem') - interval '6 days')
             AT TIME ZONE 'Asia/Jerusalem' AS from_t
  )
  SELECT to_char(b.from_t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         to_char(b.now_t  AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         to_char(to_timestamp(2 * EXTRACT(EPOCH FROM b.from_t) - EXTRACT(EPOCH FROM b.now_t))
                   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    FROM b
$$;

-- ============================================================
-- app.refresh_site_card_metrics — החישוב, פעם אחת
-- ============================================================
-- ⚠️ **הכול או כלום.** משפט אחד: אם אחת הפונקציות נכשלת (למשל זמן קצוב
-- כשהמסד עמוס), שום שורה לא מתעדכנת והטבלה נשארת על החישוב הקודם — עם
-- computed_at שלו. חצי עדכון היה מציג אתר אחד מעכשיו ושכנו מלפני שעה,
-- בלי שום דרך לדעת.
--
-- ⚠️ TimeZone קבוע: PostgREST (מאיפה שהמסך קרא עד היום) רץ ב-UTC, וכל
-- פונקציה שתלויה באזור הזמן של החיבור חייבת לראות כאן את אותו דבר.
CREATE OR REPLACE FUNCTION app.refresh_site_card_metrics()
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, app, pg_temp
SET timezone = 'UTC'
AS $fn$
DECLARE
  w record;
  n integer;
BEGIN
  SELECT * INTO w FROM app.card_metrics_window(now());

  WITH st AS (SELECT x.site_id, to_json(x) AS j FROM public.site_stats(NULL, w.period_from, w.period_to) x),
       pv AS (SELECT x.site_id, to_json(x) AS j FROM public.site_stats(NULL, w.prev_from, w.period_from) x),
       up AS (SELECT x.site_id, to_json(x) AS j FROM public.site_uptime(NULL, w.period_from, w.period_to) x),
       sv AS (SELECT x.site_id, to_json(x) AS j FROM public.site_uptime_service(NULL, w.period_from, w.period_to) x)
  INSERT INTO public.site_card_metrics AS m
         (site_id, computed_at, period_from, period_to, prev_from, stats, prev, uptime, svc)
  SELECT s.id, w.period_to, w.period_from, w.period_to, w.prev_from, st.j, pv.j, up.j, sv.j
    FROM public.sites s
    LEFT JOIN st ON st.site_id = s.id
    LEFT JOIN pv ON pv.site_id = s.id
    LEFT JOIN up ON up.site_id = s.id
    LEFT JOIN sv ON sv.site_id = s.id
  ON CONFLICT (site_id) DO UPDATE
     SET computed_at = EXCLUDED.computed_at,
         period_from = EXCLUDED.period_from,
         period_to   = EXCLUDED.period_to,
         prev_from   = EXCLUDED.prev_from,
         stats       = EXCLUDED.stats,
         prev        = EXCLUDED.prev,
         uptime      = EXCLUDED.uptime,
         svc         = EXCLUDED.svc;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$fn$;

REVOKE ALL ON FUNCTION app.refresh_site_card_metrics() FROM PUBLIC;

-- ⚠️ חישוב ראשון כבר בהחלה — בלי זה, עד ריצת ה-cron הראשונה הכרטיסים היו
-- מציגים "0 פעולות". **כישלון כאן אינו מפיל את ההחלה**: הטבלה והפונקציה כבר
-- קיימות, וה-cron ימלא אותן תוך 10 דקות. החלה שנופלת על עומס רגעי במסד
-- הייתה משאירה את שאר הקבצים לא מוחלים — זה הנזק הגדול יותר.
DO $$
BEGIN
  PERFORM app.refresh_site_card_metrics();
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'site_card_metrics: החישוב הראשון נכשל — ה-cron ימלא: %', SQLERRM;
END
$$;
