-- functions.postgres.sql — מדדים כפונקציות SQL, ליד הנתונים.
--
-- ============================================================
-- למה הקובץ הזה קיים
-- ============================================================
-- החישובים חיו ב-queries.js, כלומר רק השרת ידע לחשב אותם. כדי שהדשבורד
-- יוכל לשאול את בסיס הנתונים ישירות, ההגדרה חייבת לחיות *בבסיס הנתונים*.
--
-- הקובץ נטען ב-db.init() בכל עלייה, אחרי schema.postgres.sql. כל פונקציה
-- היא CREATE OR REPLACE ולכן ההרצה אידמפוטנטית בדיוק כמו ה-DDL של הסכמה:
-- הרצה שנייה מחליפה את הגוף באותו גוף. גלגול לאחור = להחזיר את הקובץ
-- ולהפעיל מחדש.
--
-- ============================================================
-- ארבעה כללים שכל פונקציה כאן מקיימת. אל תפרו אותם.
-- ============================================================
-- 1. **סינון לקסיקוגרפי על TEXT, המרה רק לחשבון.**
--    התאריכים הם TEXT בפורמט ISO-8601 (החלטה מכוונת — ראה schema).
--    השוואת מחרוזות על ISO היא כרונולוגית, ולכן
--        WHERE started_at < p_to
--    משתמש ב-idx_status_hist_site כרגיל. לעומת זאת
--        WHERE started_at::timestamptz < p_to::timestamptz
--    ממיר את *העמודה*, פוסל את האינדקס, והופך כל טווח ל-seq scan על הטבלה
--    הגדולה ביותר. ההמרה ל-timestamptz מותרת רק על שורות ש**כבר סוננו**.
--
-- 2. **מקבלת מערך מזהי אתרים ומחזירה שורה לכל אתר.**
--    הקריאה מ-JS היא פעם אחת לכל הבקשה. פונקציה לאתר-בודד שנקראת בלולאה
--    הייתה משחזרת בדיוק את ה-N+1 שנמחק מ-queries.js (חודש בגרנולריות יומית
--    עם 200 אתרים = ~18,000 סיבובי רשת).
--
-- 3. **::double precision על כל מספר שמוחזר.**
--    ROUND(x, 2) ב-Postgres מחזיר NUMERIC, והדרייבר (pg) מחזיר NUMERIC
--    כ**מחרוזת**. הדשבורד עושה חשבון על הערכים האלה, ולכן מחרוזת הופכת
--    חיבור לשרשור בשקט. אותה מלכודת כבר מתועדת בסכמה עבור REAL מול NUMERIC.
--
-- 4. **בלי auth.* בתוך פונקציות מדד.**
--    auth.uid() קיים רק ב-Supabase. פונקציה שמשתמשת בו מפסיקה לרוץ על
--    Postgres רגיל, וזו בדיוק דלת היציאה שאנחנו שומרים פתוחה. היקוף
--    (מי רואה מה) שייך ל-RLS ברמת הטבלה, לא לחישוב.

-- ============================================================
-- site_uptime — זמינות, פירוק שעות לפי מצב
-- ============================================================
-- תרגום מדויק של getUptimeBreakdown + availabilityFrom מ-queries.js.
-- כל החלטה כאן קיימת גם שם; הרשימה למטה היא מה שקל לשבור בתרגום.
--
-- **חיתוך מקטעים.** מקטע שמתחיל לפני החלון או נגמר אחריו נחתך לגבולות.
-- מקטע פתוח (ended_at IS NULL) נמשך עד סוף החלון.
--
-- **לא סופרים אל תוך העתיד.** גבול עליון אפקטיבי = min(p_to, now).
-- ההשוואה לקסיקוגרפית על מחרוזות ISO, בדיוק כמו ב-JS.
--
-- **תחזוקה מוחרגת מהמכנה.** היא אינה זמינות ואינה השבתה. הורדה מתוכננת
-- לא תיראה ככשל, וגם לא תזכה בקרדיט של זמינות.
--
-- **measured_hours = 0 פירושו "אין נתון", לא "זמינות אפס".** הפונקציה
-- מחזירה 0 באחוז, והקורא מבדיל לפי measured_hours — כמו ב-JS, שם
-- getSiteUptime מחזיר null. אפס אחוז נקרא כ"שבור לגמרי" במקום "לא ידוע".
--
-- **total_hours כולל תחזוקה** (לתצוגה), והוא סכום המקטעים ולא אורך החלון:
-- אתר שנרשם באמצע התקופה לא נענש על זמן שבו לא היה קיים.
--
-- אין כאן אזור זמן, וזה מכוון: הגבולות מגיעים כפרמטרים. חישוב התקופה
-- (שבוע מתגלגל / חודש / שנה קלנדריים) הוא המקום שבו Asia/Jerusalem נחוץ,
-- והוא עדיין ב-api/periods.js.
CREATE OR REPLACE FUNCTION public.site_uptime(
  p_site_ids integer[],
  p_from     text,
  p_to       text
)
RETURNS TABLE (
  site_id              integer,
  ready_hours          double precision,
  operating_hours      double precision,
  error_hours          double precision,
  maintenance_hours    double precision,
  no_comm_hours        double precision,
  total_hours          double precision,
  measured_hours       double precision,
  availability_percent double precision
)
LANGUAGE sql
STABLE
AS $$
WITH bounds AS (
  SELECT
    p_from AS w_from,
    -- min(p_to, now) על מחרוזות ISO — לקסיקוגרפי = כרונולוגי, כמו ב-JS
    LEAST(p_to, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS w_to
),
-- חלון לא-חוקי (to <= from) מחזיר אפסים, ולא שורות חסרות
ok AS (SELECT *, (w_to > w_from) AS valid FROM bounds),
clipped AS (
  SELECT
    h.site_id,
    h.status,
    GREATEST(h.started_at::timestamptz, o.w_from::timestamptz) AS seg_start,
    LEAST(COALESCE(h.ended_at, o.w_to)::timestamptz, o.w_to::timestamptz) AS seg_end
  FROM status_history h
  CROSS JOIN ok o
  WHERE o.valid
    AND h.site_id = ANY(p_site_ids)
    -- שתי ההשוואות על TEXT: האינדקס (site_id, started_at) נשאר בשימוש
    AND h.started_at < o.w_to
    AND (h.ended_at IS NULL OR h.ended_at > o.w_from)
),
secs AS (
  SELECT
    c.site_id,
    COALESCE(SUM(EXTRACT(EPOCH FROM (c.seg_end - c.seg_start)))
             FILTER (WHERE c.status = 'ready'       AND c.seg_end > c.seg_start), 0) AS ready_s,
    COALESCE(SUM(EXTRACT(EPOCH FROM (c.seg_end - c.seg_start)))
             FILTER (WHERE c.status = 'operating'   AND c.seg_end > c.seg_start), 0) AS operating_s,
    COALESCE(SUM(EXTRACT(EPOCH FROM (c.seg_end - c.seg_start)))
             FILTER (WHERE c.status = 'error'       AND c.seg_end > c.seg_start), 0) AS error_s,
    COALESCE(SUM(EXTRACT(EPOCH FROM (c.seg_end - c.seg_start)))
             FILTER (WHERE c.status = 'maintenance' AND c.seg_end > c.seg_start), 0) AS maintenance_s,
    COALESCE(SUM(EXTRACT(EPOCH FROM (c.seg_end - c.seg_start)))
             FILTER (WHERE c.status = 'no_comm'     AND c.seg_end > c.seg_start), 0) AS no_comm_s
  FROM clipped c
  GROUP BY c.site_id
)
SELECT
  ids.site_id,
  ROUND((COALESCE(s.ready_s,0)       / 3600.0)::numeric, 2)::double precision,
  ROUND((COALESCE(s.operating_s,0)   / 3600.0)::numeric, 2)::double precision,
  ROUND((COALESCE(s.error_s,0)       / 3600.0)::numeric, 2)::double precision,
  ROUND((COALESCE(s.maintenance_s,0) / 3600.0)::numeric, 2)::double precision,
  ROUND((COALESCE(s.no_comm_s,0)     / 3600.0)::numeric, 2)::double precision,
  -- total כולל תחזוקה
  ROUND(((COALESCE(s.ready_s,0) + COALESCE(s.operating_s,0) + COALESCE(s.error_s,0)
        + COALESCE(s.maintenance_s,0) + COALESCE(s.no_comm_s,0)) / 3600.0)::numeric, 2)::double precision,
  -- measured = זמין + מושבת. **בלי תחזוקה** — זה המכנה של הזמינות.
  ROUND(((COALESCE(s.ready_s,0) + COALESCE(s.operating_s,0)
        + COALESCE(s.error_s,0) + COALESCE(s.no_comm_s,0)) / 3600.0)::numeric, 2)::double precision,
  CASE
    WHEN (COALESCE(s.ready_s,0) + COALESCE(s.operating_s,0)
        + COALESCE(s.error_s,0) + COALESCE(s.no_comm_s,0)) > 0
    THEN ROUND((((COALESCE(s.ready_s,0) + COALESCE(s.operating_s,0))
               / (COALESCE(s.ready_s,0) + COALESCE(s.operating_s,0)
                + COALESCE(s.error_s,0) + COALESCE(s.no_comm_s,0))) * 100)::numeric, 2)::double precision
    ELSE 0::double precision
  END
FROM unnest(p_site_ids) AS ids(site_id)
LEFT JOIN secs s ON s.site_id = ids.site_id;
$$;

COMMENT ON FUNCTION public.site_uptime(integer[], text, text) IS
  'זמינות ופירוק שעות לכל אתר בטווח. תרגום של getUptimeBreakdown/availabilityFrom. '
  'תחזוקה מוחרגת ממכנה הזמינות. measured_hours=0 פירושו אין נתון.';

-- ============================================================
-- site_segments_collapsed — קיפול ריצוד הנתק
-- ============================================================
-- תרגום של collapseNoCommFlicker. הכלל: מקטע no_comm נשמר תמיד, ומקטע
-- שאינו no_comm נזרק אם הוא זהה למצב הלא-no_comm שקדם לו — כלומר הוא
-- *המשך* של אותו מצב ולא אירוע חדש.
--
-- למה זה קיים: אתר במצב error שנותק וחזר מייצר שלושה מקטעים —
-- error → no_comm → error — אבל זו תקלה אחת, לא שתיים. בלי הקיפול
-- statsFromData היה סופר אותה פעמיים, ואחוז הכשל היה מוכפל.
--
-- ============================================================
-- ה-look-back הוא הלב, והוא מה שקל לפספס בתרגום
-- ============================================================
-- טווח הקלט הוא **כל מקטע שחופף לחלון**, כולל מקטע שהתחיל *לפני* p_from
-- ונמשך לתוכו:
--     started_at < p_to AND (ended_at IS NULL OR ended_at >= p_from)
--
-- זה מכוון ומועתק מ-loadRangeData. תקלה שהתחילה לפני החלון, נותקה, וחזרה
-- בתוך החלון היא המשך — ואי אפשר לדעת זאת בלי לראות את המקטע שלפני
-- הגבול. סינון ל-[p_from, p_to) לפני הקיפול נראה נכון, עובר כל בדיקה על
-- נתוני פרודקשן, **ומכפיל בשקט תקלות שחוצות את גבול החלון**.
--
-- ============================================================
-- למה LAG על תת-הקבוצה, ולא ניסיון לחשב "המצב הקודם" על הכול
-- ============================================================
-- ב-JS lastObserved מתעדכן רק במקטע שאינו no_comm, ולכן הוא תמיד "המצב של
-- המקטע הלא-no_comm האחרון שנראה". אם מסננים את מקטעי ה-no_comm ומריצים
-- LAG על מה שנשאר, מקבלים בדיוק את הערך הזה — בלי לחקות IGNORE NULLS
-- (שאינו קיים ב-Postgres) ובלי טריק gaps-and-islands.
--
-- ה-ORDER BY כולל id כשובר-שוויון: קיימים מקטעים באותה שנייה בדיוק, ובלי
-- שובר-שוויון ה-LAG היה שרירותי. אותו סדר בדיוק כמו sortByStartedAt ב-JS.
CREATE OR REPLACE FUNCTION public.site_segments_collapsed(
  p_site_ids integer[],
  p_from     text,
  p_to       text
)
RETURNS TABLE (
  site_id    integer,
  id         integer,
  status     text,
  started_at text,
  ended_at   text
)
LANGUAGE sql
STABLE
AS $$
WITH src AS (
  SELECT h.id, h.site_id, h.status, h.started_at, h.ended_at
    FROM status_history h
   WHERE h.site_id = ANY(p_site_ids)
     -- שתי ההשוואות על TEXT — האינדקס נשאר בשימוש. ה-look-back מתקבל
     -- מהתנאי השני: מקטע שהתחיל לפני p_from אך נמשך לתוך החלון נכלל.
     AND h.started_at < p_to
     AND (h.ended_at IS NULL OR h.ended_at >= p_from)
),
observed AS (
  -- רק מקטעים שאינם no_comm. LAG כאן = "המצב הלא-no_comm שקדם".
  SELECT s.*,
         LAG(s.status) OVER (PARTITION BY s.site_id ORDER BY s.started_at, s.id) AS prev_status
    FROM src s
   WHERE s.status <> 'no_comm'
)
SELECT o.site_id, o.id, o.status, o.started_at, o.ended_at
  FROM observed o
 WHERE o.prev_status IS NULL OR o.status <> o.prev_status
UNION ALL
SELECT s.site_id, s.id, s.status, s.started_at, s.ended_at
  FROM src s
 WHERE s.status = 'no_comm'
ORDER BY 1, 4, 2;
$$;

COMMENT ON FUNCTION public.site_segments_collapsed(integer[], text, text) IS
  'מקטעי מצב אחרי קיפול ריצוד נתק. תרגום של collapseNoCommFlicker. '
  'הקלט כולל מקטעים שהתחילו לפני p_from (look-back) — חיוני לזיהוי המשכיות.';

-- ============================================================
-- site_stats — פעולות, תקלות, ואחוז כשל
-- ============================================================
-- תרגום של statsFromData. בונה על site_segments_collapsed, ולכן הגדרת
-- הקיפול נשארת במקום אחד בלבד.
--
-- **פעולות** = שורות ב-operations עם is_anomaly = 0 ו-start_end = 'end'.
-- רק 'end': פעולה נספרת כשהיא הושלמה, לא כשהתחילה. is_anomaly INTEGER
-- ולא BOOLEAN — החלטה מכוונת בסכמה, והשוואה ל-0 היא הנכונה.
--
-- **תקלות** = מקטעי error שנותרו אחרי הקיפול ושהתחילו בתוך החלון. שים לב
-- לאסימטריה: הקיפול רואה גם מקטעים שלפני p_from (look-back), אבל הספירה
-- כוללת רק מקטעים ש-started_at שלהם בתוך [p_from, p_to). תקלה שהתחילה
-- לפני החלון אינה תקלה *של* החלון — היא רק ההקשר שמסביר שהחזרה שאחריה
-- היא המשך.
--
-- **החרגת תחזוקה** משני מקורות, ושניהם נדרשים:
--   1. חלון תחזוקה ידני (maintenance_windows) — מה שמופעל מהדשבורד.
--   2. מקטע 'maintenance' ב-status_history — מה שה-PLC עצמו מדווח.
-- הגבולות **כוללים בשני הקצוות** (<= ו->=), וזה מכוון: כשה-PLC עובר
-- מתחזוקה לתקלה, applyStateChange סוגר את מקטע התחזוקה ופותח את מקטע
-- התקלה באותו חותם זמן בדיוק. ה->= גורם לתקלה שמתחילה ברגע שהתחזוקה
-- נגמרה להיחשב "בתוך תחזוקה" — ההתנהגות הרצויה: תקלה בזמן או בגבול
-- תחזוקה מתוכננת אינה תקלה.
--
-- התקלות המוחרגות מוחזרות ב-errors_in_maintenance, לא נזרקות — כדי
-- שאפשר יהיה להציג "היו 3 תקלות, כולן בתחזוקה" במקום "לא היו תקלות".
--
-- **אחוז כשל = תקלות ÷ פעולות**, ולא מ-cycle_total. אתר ותיק עם מונה
-- מכונה של מיליון ועם 500 פעולות נמדדות ו-5 תקלות הוא 1%, לא 0.0005%.
-- אפס פעולות מחזיר 0 ולא חלוקה באפס.
CREATE OR REPLACE FUNCTION public.site_stats(
  p_site_ids integer[],
  p_from     text,
  p_to       text
)
RETURNS TABLE (
  site_id               integer,
  operations            integer,
  errors                integer,
  errors_in_maintenance integer,
  failure_rate          double precision
)
LANGUAGE sql
STABLE
AS $$
WITH ops AS (
  SELECT o.site_id, COUNT(*)::int AS n
    FROM operations o
   WHERE o.site_id = ANY(p_site_ids)
     AND o.is_anomaly = 0
     AND o.start_end = 'end'
     -- לקסיקוגרפי על TEXT — idx_operations_site_time נשאר בשימוש
     AND o.occurred_at >= p_from
     AND o.occurred_at < p_to
   GROUP BY o.site_id
),
-- מקטעי התקלה ששרדו את הקיפול ושהתחילו בתוך החלון
err AS (
  SELECT c.site_id, c.started_at
    FROM public.site_segments_collapsed(p_site_ids, p_from, p_to) c
   WHERE c.status = 'error'
     AND c.started_at >= p_from
     AND c.started_at < p_to
),
classified AS (
  SELECT
    e.site_id,
    (EXISTS (
       SELECT 1 FROM maintenance_windows w
        WHERE w.site_id = e.site_id
          AND w.started_at <= e.started_at
          AND COALESCE(w.cancelled_at, w.expires_at) >= e.started_at)
     OR EXISTS (
       SELECT 1 FROM status_history m
        WHERE m.site_id = e.site_id
          AND m.status = 'maintenance'
          AND m.started_at <= e.started_at
          AND (m.ended_at IS NULL OR m.ended_at >= e.started_at))
    ) AS in_maintenance
  FROM err e
),
agg AS (
  SELECT site_id,
         COUNT(*) FILTER (WHERE NOT in_maintenance)::int AS errors,
         COUNT(*) FILTER (WHERE in_maintenance)::int     AS errors_in_maint
    FROM classified
   GROUP BY site_id
)
SELECT
  ids.site_id,
  COALESCE(o.n, 0)::int,
  COALESCE(a.errors, 0)::int,
  COALESCE(a.errors_in_maint, 0)::int,
  CASE
    WHEN COALESCE(o.n, 0) > 0
    THEN ROUND(((COALESCE(a.errors, 0)::numeric / o.n) * 100), 2)::double precision
    ELSE 0::double precision
  END
FROM unnest(p_site_ids) AS ids(site_id)
LEFT JOIN ops o ON o.site_id = ids.site_id
LEFT JOIN agg a ON a.site_id = ids.site_id;
$$;

COMMENT ON FUNCTION public.site_stats(integer[], text, text) IS
  'פעולות, תקלות, תקלות-בתחזוקה ואחוז כשל לכל אתר בטווח. תרגום של statsFromData. '
  'התקלות עוברות דרך site_segments_collapsed; החרגת התחזוקה משני מקורות, גבולות כוללים.';
