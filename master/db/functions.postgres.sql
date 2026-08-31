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
-- ⚠️ DROP ולא רק CREATE OR REPLACE, ואל תסירו אותו.
-- CREATE OR REPLACE אינו יכול לשנות את **טיפוס ההחזרה** — הוא נכשל עם
-- "cannot change return type of existing function", ורק על מסד שכבר מכיל
-- גרסה קודמת. כלומר: עובר בפיתוח נקי, נופל בפרודקשן.
--
-- זה כבר קרה כאן פעמיים בכיוונים הפוכים: עמודה נוספה ואז הוסרה. ה-DROP
-- הופך את הקובץ לאידמפוטנטי מול **כל** גרסה קודמת, וזו בדיוק ההבטחה
-- שהקובץ הזה נשען עליה ("הקובץ הוא מצב היעד").
DROP FUNCTION IF EXISTS public.site_uptime(integer[], text, text);

-- ⚠️ DROP ולא רק REPLACE: נוספה עמודה ל-RETURNS TABLE, ו-CREATE OR REPLACE
-- אינו יכול לשנות טיפוס החזרה ("cannot change return type of existing
-- function"). הפונקציות שקוראות לה נפתרות בזמן ריצה ולכן אינן חוסמות מחיקה;
-- מדיניות RLS כן הייתה חוסמת, ואין כזו שמצביעה לכאן.
DROP FUNCTION IF EXISTS public.site_uptime(integer[], text, text);

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
  -- פילוח התחזוקה: repair + planned = maintenance, תמיד. אינו נוגע בזמינות.
  repair_hours         double precision,
  planned_hours        double precision,
  no_comm_hours        double precision,
  -- ⚠️ זמן שמנהל הוציא מהסטטיסטיקה ("הקפצנו את הדלת כדי לבדוק"). מחוץ
  -- לזמינות לחלוטין — לא במונה ולא במכנה, בדיוק כמו תחזוקה — אבל **בתוך**
  -- total_hours, כדי שהפס על המסך לא יתקצר בלי הסבר.
  excluded_hours       double precision,
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
    -- ⚠️ **הסטטוס האפקטיבי, לא הגולמי.** מנהל יכול לסווג תקלה מחדש
    -- כתחזוקה (reclassify_status), והמקור נשמר ב-status לנצח. כל מדד
    -- חייב לקרוא את התוצאה — אחרת המסך אומר "תחזוקה" והזמינות סופרת
    -- תקלה, שני מספרים לאותו אירוע.
    -- ⚠️ והתיקון כאן ולא בלוגיקה: השאילתה מחזירה את הערך הנכון, ולכן
    -- אף חישוב במורד הזרם לא צריך להשתנות — לא ב-SQL ולא ב-JS.
    COALESCE(h.reclassified_to, h.status) AS status,
    GREATEST(h.started_at::timestamptz, o.w_from::timestamptz) AS seg_start,
    LEAST(COALESCE(h.ended_at, o.w_to)::timestamptz, o.w_to::timestamptz) AS seg_end,
    -- ⚠️ החותם ה**גולמי**, לא החתוך. סיווג "תפעול תקלה" נשען על התאמה
    -- מדויקת ל-error.ended_at, ומקטע שהתחיל לפני החלון היה מקבל seg_start
    -- = w_from ולא היה מתאים לעולם. הסיווג שייך למקטע, לא לחלון.
    h.started_at AS raw_start
  FROM status_history h
  CROSS JOIN ok o
  WHERE o.valid
    AND (p_site_ids IS NULL OR h.site_id = ANY(p_site_ids))
    -- שתי ההשוואות על TEXT: האינדקס (site_id, started_at) נשאר בשימוש
    AND h.started_at < o.w_to
    AND (h.ended_at IS NULL OR h.ended_at > o.w_from)
    -- ⚠️ **המקטע יוצא כאן, לפני כל דלי.** זהה ל-`continue` ב-uptimeFromData,
    -- ולכן גם החלק שנופל בתוך חלון תחזוקה ידני אינו נספר כתחזוקה. סינון
    -- מאוחר יותר (FILTER בכל צבירה) היה משאיר את החלק המכוסה שלו בתוך
    -- maintenance_s — שבע צבירות שכל אחת מהן הזדמנות לשכוח אחת.
    AND h.excluded_at IS NULL
),
-- ============================================================
-- excl — הזמן שהוצא, נמדד באותה חיתוך בדיוק
-- ============================================================
-- ⚠️ CTE נפרד ולא דלי בתוך agg, כי `clipped` כבר סינן אותו. אותו חישוב
-- חיתוך מילה במילה — מקטע שהוצא נחתך לחלון כמו כל אחר, אחרת "שעה שהוצאה"
-- בקצה התקופה הייתה נספרת במלואה בשתי תקופות סמוכות.
excl AS (
  SELECT
    h.site_id,
    SUM(EXTRACT(EPOCH FROM (
      LEAST(COALESCE(h.ended_at, o.w_to)::timestamptz, o.w_to::timestamptz)
      - GREATEST(h.started_at::timestamptz, o.w_from::timestamptz)
    ))) AS excluded_s
  FROM status_history h
  CROSS JOIN ok o
  WHERE o.valid
    AND (p_site_ids IS NULL OR h.site_id = ANY(p_site_ids))
    AND h.started_at < o.w_to
    AND (h.ended_at IS NULL OR h.ended_at > o.w_from)
    AND h.excluded_at IS NOT NULL
  GROUP BY h.site_id
),
-- ============================================================
-- תחזוקה אחרי תקלה היא **תפעול תקלה**, לא תחזוקה מתוכננת
-- ============================================================
-- ⚠️ חייב להישאר זהה ל-uptimeFromData ב-shared/executive.mjs. שם מתועד
-- הנימוק במלואו; בקצרה: מתוכננת היא **החלטה** ותפעול תקלה הוא **תוצאה**,
-- וערבובן גורם לאתר שנופל שלוש פעמים בשבוע להיראות כמו אתר בתחזוקה שוטפת.
--
-- ⚠️ **הזמן לא זז.** שניהם נשארים maintenance_s ומוחרגים מהמכנה בדיוק כמו
-- קודם — הזמינות אינה משתנה. זה **פילוח בלבד**, ותמיד
-- repair_hours + planned_hours = maintenance_hours.
--
-- אותו תנאי חפיפה כמו ב-clipped, כדי שהקבוצה תהיה זהה לזו שב-JS.
err_ends AS (
  SELECT DISTINCT h.site_id, h.ended_at
  FROM status_history h
  CROSS JOIN ok o
  WHERE o.valid
    AND COALESCE(h.reclassified_to, h.status) = 'error'
    AND h.ended_at IS NOT NULL
    AND (p_site_ids IS NULL OR h.site_id = ANY(p_site_ids))
    AND h.started_at < o.w_to
    AND h.ended_at > o.w_from
),
-- ============================================================
-- חלונות תחזוקה ידניים — נספרים כתחזוקה, ולא לפי מה שה-PLC דיווח
-- ============================================================
-- עד כאן רק סטטוס 'maintenance' בהיסטוריה הוחרג מהמכנה, כלומר תחזוקה
-- שהבקר דיווח עליה. חלון ידני מהדשבורד לא נגע בחישוב כלל.
--
-- וזה לא היה ניטרלי אלא הפוך מהכוונה: תקלה בזמן תחזוקה נזרקת בקליטה
-- (state-handler), ולכן מקטע ה-'ready' פשוט ממשיך — **וזמן שבור נספר כזמן
-- זמין**. נמדד: 24 שעות שמתוכן 12 בתחזוקה ידנית החזירו maintenance_hours=0
-- וזמינות 100%. שני קובצי ההנחיות אומרים את ההפך במפורש.
--
-- ⚠️ החלונות מאוחדים לקטעים זרים לפני הספירה. שני חלונות חופפים (הארכה,
-- או שניים שהופעלו במקביל) היו נספרים פעמיים, וזמן התחזוקה היה יוצא גדול
-- מהחלון עצמו. אותו איחוד בדיוק נעשה ב-JS (mergedWindows).
win AS (
  SELECT
    m.site_id,
    GREATEST(m.started_at::timestamptz, o.w_from::timestamptz) AS s,
    LEAST(COALESCE(m.cancelled_at, m.expires_at)::timestamptz, o.w_to::timestamptz) AS e
  FROM maintenance_windows m
  CROSS JOIN ok o
  WHERE o.valid
    AND (p_site_ids IS NULL OR m.site_id = ANY(p_site_ids))
    -- סינון לקסיקלי על TEXT, כמו בכל שאר הפונקציות כאן
    AND m.started_at < o.w_to
    AND COALESCE(m.cancelled_at, m.expires_at) > o.w_from
    -- ⚠️ חלון שסומן כניסוי אינו מכסה כלום. חלון תחזוקה **הופך** זמן של
    -- מקטעים אחרים לתחזוקה, ולכן סימונו כניסוי חייב להסיר גם את הכיסוי.
    AND m.excluded_at IS NULL
),
-- איחוד קטעים חופפים: קטע פותח קבוצה חדשה רק אם הוא מתחיל אחרי הסוף
-- המקסימלי של כל מי שלפניו.
win_grp AS (
  SELECT
    site_id, s, e,
    SUM(CASE WHEN prev_max IS NULL OR s > prev_max THEN 1 ELSE 0 END)
      OVER (PARTITION BY site_id ORDER BY s, e ROWS UNBOUNDED PRECEDING) AS grp
  FROM (
    SELECT
      site_id, s, e,
      MAX(e) OVER (PARTITION BY site_id ORDER BY s, e
                   ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_max
    FROM win
    WHERE e > s
  ) w
),
win_merged AS (
  SELECT site_id, MIN(s) AS s, MAX(e) AS e
  FROM win_grp
  GROUP BY site_id, grp
),
-- לכל מקטע: כמה ממנו מכוסה בחלון ידני.
cov AS (
  SELECT
    c.site_id,
    c.status,
    EXTRACT(EPOCH FROM (c.seg_end - c.seg_start)) AS dur_s,
    COALESCE((
      SELECT SUM(EXTRACT(EPOCH FROM (LEAST(w.e, c.seg_end) - GREATEST(w.s, c.seg_start))))
      FROM win_merged w
      WHERE w.site_id = c.site_id
        AND w.e > c.seg_start
        AND w.s < c.seg_end
    ), 0) AS covered_s,
    -- האם המקטע הזה הוא תפעול תקלה: התחיל בדיוק כשתקלה נגמרה.
    EXISTS (
      SELECT 1 FROM err_ends e
      WHERE e.site_id = c.site_id AND e.ended_at = c.raw_start
    ) AS after_error
  FROM clipped c
  WHERE c.seg_end > c.seg_start
),
secs AS (
  SELECT
    v.site_id,
    COALESCE(SUM(v.dur_s - v.covered_s) FILTER (WHERE v.status = 'ready'),     0) AS ready_s,
    COALESCE(SUM(v.dur_s - v.covered_s) FILTER (WHERE v.status = 'operating'), 0) AS operating_s,
    COALESCE(SUM(v.dur_s - v.covered_s) FILTER (WHERE v.status = 'error'),     0) AS error_s,
    -- כל הזמן המכוסה, ועוד החלק הלא-מכוסה של מקטעי תחזוקה אמיתיים
    COALESCE(SUM(v.covered_s), 0)
      + COALESCE(SUM(v.dur_s - v.covered_s) FILTER (WHERE v.status = 'maintenance'), 0) AS maintenance_s,
    -- הפילוח. ⚠️ החלק ה**מכוסה** בחלון ידני נספר תמיד כמתוכנן: מישהו לחץ
    -- על כפתור, וזו החלטה לפי הגדרה. רק מקטע PLC יכול להיות תפעול תקלה.
    COALESCE(SUM(v.dur_s - v.covered_s)
             FILTER (WHERE v.status = 'maintenance' AND v.after_error), 0) AS repair_s,
    COALESCE(SUM(v.covered_s), 0)
      + COALESCE(SUM(v.dur_s - v.covered_s)
                 FILTER (WHERE v.status = 'maintenance' AND NOT v.after_error), 0) AS planned_s,
    COALESCE(SUM(v.dur_s - v.covered_s) FILTER (WHERE v.status = 'no_comm'),   0) AS no_comm_s
  FROM cov v
  GROUP BY v.site_id
)
SELECT
  ids.site_id,
  ROUND((COALESCE(s.ready_s,0)       / 3600.0)::numeric, 2)::double precision,
  ROUND((COALESCE(s.operating_s,0)   / 3600.0)::numeric, 2)::double precision,
  ROUND((COALESCE(s.error_s,0)       / 3600.0)::numeric, 2)::double precision,
  ROUND((COALESCE(s.maintenance_s,0) / 3600.0)::numeric, 2)::double precision,
  ROUND((COALESCE(s.repair_s,0)      / 3600.0)::numeric, 2)::double precision,
  ROUND((COALESCE(s.planned_s,0)     / 3600.0)::numeric, 2)::double precision,
  ROUND((COALESCE(s.no_comm_s,0)     / 3600.0)::numeric, 2)::double precision,
  ROUND((COALESCE(x.excluded_s,0)    / 3600.0)::numeric, 2)::double precision,
  -- total כולל תחזוקה, נתק, ומה שהוצא — הוא כל הזמן שנמדד
  ROUND(((COALESCE(s.ready_s,0) + COALESCE(s.operating_s,0) + COALESCE(s.error_s,0)
        + COALESCE(s.maintenance_s,0) + COALESCE(s.no_comm_s,0)
        + COALESCE(x.excluded_s,0)) / 3600.0)::numeric, 2)::double precision,
  -- ============================================================
  -- measured = זמין + תקלה. **בלי תחזוקה ובלי נתק.**
  -- ============================================================
  -- ⚠️ חייב להישאר זהה ל-DOWN_STATUSES ב-shared/executive.mjs. שם מתועדת
  -- הסיבה במלואה; בקצרה: נתק פירושו שהסוכן/הרשת אינם מדווחים, והמחסום עצמו
  -- עשוי לעבוד — אי-ידיעה אינה כשל, ולכן היא יוצאת מהמדידה כמו תחזוקה.
  --
  -- ⚠️ אם משנים כאן בלי לשנות שם (או להפך), tools/parity.js ייפול על
  -- availability ו-measuredHours. זה בדיוק מה שהשער הזה קיים בשבילו.
  ROUND(((COALESCE(s.ready_s,0) + COALESCE(s.operating_s,0)
        + COALESCE(s.error_s,0)) / 3600.0)::numeric, 2)::double precision,
  CASE
    WHEN (COALESCE(s.ready_s,0) + COALESCE(s.operating_s,0)
        + COALESCE(s.error_s,0)) > 0
    THEN ROUND((((COALESCE(s.ready_s,0) + COALESCE(s.operating_s,0))
               / (COALESCE(s.ready_s,0) + COALESCE(s.operating_s,0)
                + COALESCE(s.error_s,0))) * 100)::numeric, 2)::double precision
    ELSE 0::double precision
  END
-- ============================================================
-- הנהג הוא טבלת האתרים ולא unnest, ומשתי סיבות
-- ============================================================
-- 1. **p_site_ids = NULL פירושו "כל האתרים".** אותה מוסכמה בדיוק כמו
--    loadRangeData, וקיימת מאותה סיבה: בלעדיה הקורא היה חייב לשלוף קודם
--    את רשימת המזהים ורק אז לקרוא לפונקציה — סיבוב רשת שלם בטור, במקום
--    שהכול ירוץ במקביל.
-- 2. תמיד חוזרת שורה לכל אתר *קיים*, גם לאתר בלי שום היסטוריה בטווח.
FROM (SELECT id AS site_id FROM sites
       WHERE p_site_ids IS NULL OR id = ANY(p_site_ids)) AS ids
LEFT JOIN secs s ON s.site_id = ids.site_id
-- ⚠️ LEFT ולא INNER: הרוב המוחלט של האתרים לא הוציאו כלום, ו-INNER היה
-- מוחק אותם מהתוצאה כולה — כלומר "לא הוצאת שום דבר" היה נקרא "אין אתר".
LEFT JOIN excl x ON x.site_id = ids.site_id;
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
DROP FUNCTION IF EXISTS public.site_segments_collapsed(integer[], text, text);

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
  ended_at   text,
  -- ⚠️ נחשף ולא מסונן כאן: הקיפול חייב לראות את המקטע כדי לדעת אם מה
  -- שאחריו הוא המשך. הצרכן מחליט. ראה statsFromData.
  excluded_at text
)
LANGUAGE sql
STABLE
AS $$
WITH src AS (
  -- ⚠️ **הסטטוס האפקטיבי, לא הגולמי.** מנהל יכול לסווג תקלה מחדש
  -- כתחזוקה (reclassify_status), והמקור נשמר ב-status לנצח. כל מדד
  -- חייב לקרוא את התוצאה — אחרת המסך אומר "תחזוקה" והזמינות סופרת
  -- תקלה, שני מספרים לאותו אירוע.
  -- ⚠️ והתיקון כאן ולא בלוגיקה: השאילתה מחזירה את הערך הנכון, ולכן
  -- אף חישוב במורד הזרם לא צריך להשתנות — לא ב-SQL ולא ב-JS.
  SELECT h.id, h.site_id, COALESCE(h.reclassified_to, h.status) AS status,
         h.started_at, h.ended_at, h.excluded_at
    FROM status_history h
   WHERE (p_site_ids IS NULL OR h.site_id = ANY(p_site_ids))
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
SELECT o.site_id, o.id, o.status, o.started_at, o.ended_at, o.excluded_at
  FROM observed o
 WHERE o.prev_status IS NULL OR o.status <> o.prev_status
UNION ALL
SELECT s.site_id, s.id, s.status, s.started_at, s.ended_at, s.excluded_at
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
-- ============================================================
-- ⚠️ פעולה בתוך חלון תחזוקה ידני אינה שירות
-- ============================================================
-- בתחזוקה **מהבקר** ה-MODE הוא 0, ולכן הגלאי בסוכן אינו מייצר פעולות
-- כלל — אין מה לספור. חלון ידני לא עשה כלום מזה: הבקר המשיך להזיז
-- רכבים והפעולות נספרו כשירות רגיל.
--
-- ההכרעה: חלון ידני מתנהג בדיוק כמו תחזוקה מהבקר. מה שקרה בתוכו הוא
-- בדיקה, לא שירות — עקבי עם מה שכבר הוכרע לתקלות (מושמטות ונרשמות
-- ב-suppressed_faults) ולזמן (הכיסוי הופך אותו לתחזוקה).
--
-- ⚠️ **חייבת להישאר זהה ל-opsOf ב-shared/executive.mjs.** שער ה-parity
-- משווה את שתיהן; הוא תפס בדיוק את ההבדל הזה כשה-JS השתנה לבדו.
--
-- ⚠️ גבול חצי-פתוח (< end): פעולה ברגע שהחלון נגמר היא כבר שירות.
-- ⚠️ חלון שסומן כניסוי אינו מכסה דבר — אותו כלל כמו בכל שאר המקומות.
CREATE OR REPLACE FUNCTION app.op_served(p_site_id integer, p_occurred_at text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, app, pg_temp
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.maintenance_windows w
     WHERE w.site_id = p_site_id
       AND w.excluded_at IS NULL
       AND p_occurred_at >= w.started_at
       AND p_occurred_at <  COALESCE(w.cancelled_at, w.expires_at)
  );
$$;

-- ============================================================
-- app.error_segments — הגדרה **אחת** לשאלה "מהי תקלה שנספרת"
-- ============================================================
-- ⚠️ חולצה מ-site_stats כדי ש-executive_series תוכל לחלוק אותה. לפני
-- החילוץ הייתי צריך לשכפל את הלוגיקה, וזה בדיוק "פורט שמגדיר מדד
-- מחדש" — שני מקומות שיסטו ביום שמישהו יתקן אחד מהם.
--
-- ⚠️ **וה-p_from/p_to כאן הם גבולות התקופה, לא של הדלי.** הקיפול חייב
-- לראות את ההקשר שלפני: תקלה שהתחילה קודם, נותקה ב-no_comm, וחזרה —
-- היא המשך ואסור שתיספר. נמדד: מגדל 1 ב-30/08 — error ב-27/08, no_comm
-- של 2.9 ימים, ואז error שוב. קריאה לדלי בודד לא רואה את הראשונה
-- וסופרת את השנייה כחדשה. השער parity-exec-series תפס בדיוק את זה.
CREATE OR REPLACE FUNCTION app.error_segments(
  p_site_ids integer[],
  p_from     text,
  p_to       text
)
RETURNS TABLE (
  site_id        integer,
  started_at     text,
  in_maintenance boolean
)
LANGUAGE sql
STABLE
AS $seg$
WITH err AS (
  SELECT c.site_id, c.started_at
    FROM public.site_segments_collapsed(p_site_ids, p_from, p_to) c
   WHERE c.status = 'error'
     -- ⚠️ **אחרי הקיפול ולא לפניו** — זהה ל-statsFromData. מקטע שהוצא
     -- עדיין משתתף בקיפול הריצוד, כי הוא ההקשר שקובע אם מה שאחריו הוא
     -- המשך. סינון מוקדם היה מזיז את ספירת שכניו.
     AND c.excluded_at IS NULL
     AND c.started_at >= p_from
     AND c.started_at < p_to
)
SELECT
  e.site_id,
  e.started_at,
  (EXISTS (
     SELECT 1 FROM maintenance_windows w
      WHERE w.site_id = e.site_id
        AND w.excluded_at IS NULL
        AND w.started_at <= e.started_at
        AND COALESCE(w.cancelled_at, w.expires_at) >= e.started_at)
   OR EXISTS (
     SELECT 1 FROM status_history m
      WHERE m.site_id = e.site_id
        AND COALESCE(m.reclassified_to, m.status) = 'maintenance'
        AND m.started_at <= e.started_at
        AND (m.ended_at IS NULL OR m.ended_at >= e.started_at))
  )
FROM err e;
$seg$;

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
   WHERE (p_site_ids IS NULL OR o.site_id = ANY(p_site_ids))
     -- ⚠️ הוצאה ידנית של מנהל. **לא** מוזגה ל-is_anomaly: זה שיפוט של
     -- הקליטה על סמך הנתון, וזו הצהרה של אדם. מיזוגם היה מוחק את ההבחנה.
     AND o.excluded_at IS NULL
     AND o.is_anomaly = 0
     AND o.start_end = 'end'
     -- מעבר פיזי אחד = פעולה אחת: ניסיון שנקטע והוחלף אינו נספר שוב
     AND o.superseded_by IS NULL
     -- ⚠️ חלון תחזוקה ידני — ראה app.op_served
     AND app.op_served(o.site_id, o.occurred_at)
     -- לקסיקוגרפי על TEXT — idx_operations_site_time נשאר בשימוש
     AND o.occurred_at >= p_from
     AND o.occurred_at < p_to
   GROUP BY o.site_id
),
-- ⚠️ **מקור אחד**: app.error_segments. הלוגיקה ישבה כאן, ו-
-- executive_series הייתה חייבת את אותה הגדרה — שכפול היה נפרד ביום
-- שמישהו יתקן אחד מהם, והתסמין הוא שני מספרי תקלות לאותו אתר.
classified AS (
  SELECT e.site_id, e.in_maintenance
    FROM app.error_segments(p_site_ids, p_from, p_to) e
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
-- כמו ב-site_uptime: הנהג הוא טבלת האתרים, כדי לתמוך ב-NULL (כל האתרים)
-- ולהחזיר שורה לכל אתר קיים גם בלי נתונים בטווח.
FROM (SELECT id AS site_id FROM sites
       WHERE p_site_ids IS NULL OR id = ANY(p_site_ids)) AS ids
LEFT JOIN ops o ON o.site_id = ids.site_id
LEFT JOIN agg a ON a.site_id = ids.site_id;
$$;

COMMENT ON FUNCTION public.site_stats(integer[], text, text) IS
  'פעולות, תקלות, תקלות-בתחזוקה ואחוז כשל לכל אתר בטווח. תרגום של statsFromData. '
  'התקלות עוברות דרך site_segments_collapsed; החרגת התחזוקה משני מקורות, גבולות כוללים.';


-- ============================================================
-- public.site_globals — הנתונים ה"גלובליים" של כל אתר
-- ============================================================
-- תרגום של getAllSitesGlobals (queries.js). זו הפונקציה שחסמה את המעבר
-- של הדשבורד לקריאה ישירה: בלעדיה fetchSitesDirect החזיר תמונה חלקית.
--
-- חמש השאילתות המקוריות מתאחדות כאן ל-CTE-ים, ו-ids הוא הנהג — כדי
-- שאתר בלי שום היסטוריה עדיין יקבל שורה, בדיוק כמו ש-at() ב-JS יצר
-- רשומה ריקה. אתר כזה הוא המקרה של אתר חדש שנרשם ועוד לא דיווח.
--
-- ⚠️ להבדיל משאר הפונקציות כאן, אין כאן טווח תאריכים: אלה נתונים "עד
-- עכשיו" ולא "בטווח". לכן אין סינון לקסיקלי על started_at — אבל גם אין
-- cast של עמודה, ולכן האינדקסים נשמרים.
-- ⚠️ DROP: הוספת current_fault_text משנה את **טיפוס ההחזרה**, ו-CREATE OR
-- REPLACE אינו יכול לשנות אותו. נכשל רק על מסד שכבר מכיל גרסה קודמת —
-- כלומר עובר בפיתוח נקי ונופל בפרודקשן.
DROP FUNCTION IF EXISTS public.site_globals(integer[]);

CREATE OR REPLACE FUNCTION public.site_globals(p_site_ids integer[] DEFAULT NULL)
RETURNS TABLE (
  site_id                     integer,
  last_fault_at               text,
  first_status_at             text,
  status_since                text,
  -- תיאור התקלה הנוכחית — או של זו שמטפלים בה כרגע. ראה open_seg למטה.
  current_fault_text          text,
  -- ⚠️ האם המקטע הפתוח הוא **תפעול תקלה** ולא תחזוקה מתוכננת. אותו כלל
  -- בדיוק כמו fault_text מעליו (ended_at = started_at), ולכן הוא מחושב
  -- באותו CTE — שני מקורות אמת לאותה שאלה היו מתפצלים בשקט.
  current_after_error         boolean,
  last_op_start_end           text,
  last_op_entry_exit          text,
  last_op_card_number         text,
  last_op_occurred_at         text,
  operations_since_last_error integer,
  maintenance_id              integer,
  maintenance_set_by_name     text,
  maintenance_set_by_role     text,
  maintenance_reason          text,
  maintenance_started_at      text,
  maintenance_duration_hours  double precision,
  maintenance_expires_at      text
)
LANGUAGE sql
STABLE
AS $$
WITH ids AS (
  SELECT id AS site_id FROM sites
   WHERE p_site_ids IS NULL OR id = ANY(p_site_ids)
),
-- התקלה האחרונה + המקטע הראשון אי-פעם
faults AS (
  SELECT h.site_id,
         MAX(h.started_at) FILTER (WHERE COALESCE(h.reclassified_to, h.status) = 'error') AS last_fault_at,
         MIN(h.started_at)                                   AS first_status_at
    FROM status_history h
    JOIN ids ON ids.site_id = h.site_id
   GROUP BY h.site_id
),
-- המצב הפתוח הנוכחי. DISTINCT ON = "שורה אחת לכל קבוצה" בלי N+1.
open_seg AS (
  -- ============================================================
  -- תיאור התקלה **שורד את המעבר לטיפול**
  -- ============================================================
  -- ⚠️ חייב להישאר זהה ל-getAllSitesGlobals ב-queries.js.
  --
  -- המקרה הנפוץ: הבקר נופל לתקלה, ומיד מישהו מעביר לתחזוקה כדי לטפל.
  -- מקטע התקלה **נסגר** ונפתח מקטע תחזוקה — ואיתו נעלם התיאור, בדיוק
  -- כשהוא הכי נחוץ: מי שרואה "בטיפול" רוצה לדעת **במה** מטפלים.
  --
  -- שני מקורות ב-COALESCE:
  --   1. התיאור של המקטע הפתוח — כשהאתר בתקלה עכשיו.
  --   2. התיאור של התקלה שנסגרה **בדיוק** כשהמקטע הזה נפתח.
  --
  -- ⚠️ ההתאמה על ended_at = started_at ולא על "התקלה האחרונה": הסוכן סוגר
  -- מקטע ופותח את הבא באותו סבב דגימה ועם אותו חותם. תקלה מלפני שעתיים
  -- אינה מה שמטפלים בו עכשיו, והצגתה הייתה שקר.
  SELECT DISTINCT ON (h.site_id) h.site_id, h.started_at,
         COALESCE(
           h.fault_text,
           (SELECT e.fault_text FROM status_history e
             WHERE e.site_id = h.site_id
               AND COALESCE(e.reclassified_to, e.status) = 'error'
               AND e.ended_at = h.started_at
             LIMIT 1)
         ) AS fault_text,
         EXISTS (
           SELECT 1 FROM status_history e
            WHERE e.site_id = h.site_id
              AND COALESCE(e.reclassified_to, e.status) = 'error'
              AND e.ended_at = h.started_at
         ) AS after_error
    FROM status_history h
    JOIN ids ON ids.site_id = h.site_id
   WHERE h.ended_at IS NULL
   ORDER BY h.site_id, h.started_at DESC
),
-- הפעולה האחרונה. שובר השוויון על id נשמר מה-JS: שתי פעולות באותה שנייה
-- הן מקרה אמיתי, ובלעדיו הבחירה ביניהן שרירותית.
last_op AS (
  SELECT DISTINCT ON (o.site_id)
         o.site_id, o.start_end, o.entry_exit, o.card_number, o.occurred_at
    FROM operations o
    JOIN ids ON ids.site_id = o.site_id
   ORDER BY o.site_id, o.occurred_at DESC, o.id DESC
),
-- כמה פעולות מאז התקלה האחרונה. LEFT JOIN ולא INNER: אתר שמעולם לא
-- נכשל צריך לספור את **כל** פעולותיו, לא אפס.
since_error AS (
  SELECT o.site_id, COUNT(*)::int AS n
    FROM operations o
    JOIN ids ON ids.site_id = o.site_id
    LEFT JOIN faults f ON f.site_id = o.site_id
   WHERE o.is_anomaly = 0 AND o.start_end = 'end' AND o.superseded_by IS NULL
     AND (f.last_fault_at IS NULL OR o.occurred_at > f.last_fault_at)
   GROUP BY o.site_id
),
-- תחזוקה ידנית פעילה כרגע. now() ולא פרמטר: ב-JS הזמן נלקח בתוך
-- הפונקציה עצמה, אז זו אותה סמנטיקה — ולכן הפונקציה STABLE ולא IMMUTABLE.
maint AS (
  SELECT DISTINCT ON (m.site_id) m.*
    FROM maintenance_windows m
    JOIN ids ON ids.site_id = m.site_id
   WHERE m.excluded_at IS NULL
     AND m.cancelled_at IS NULL
     -- ⚠️ **גם started_at, ולא רק expires_at.** כל עוד כל חלון התחיל מיד
     -- הבדיקה הזו הייתה מיותרת; מרגע שאפשר לתזמן למחר, חלון עתידי היה
     -- מסמן את האתר כבתחזוקה **עכשיו** — כלומר מוציא אותו מהמדידה יום
     -- לפני שמישהו נגע בו.
     AND m.started_at <= to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
     AND m.expires_at > to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
   ORDER BY m.site_id, m.expires_at DESC
)
SELECT
  ids.site_id,
  f.last_fault_at,
  f.first_status_at,
  s.started_at,
  s.fault_text,
  -- COALESCE: אתר בלי מקטע פתוח מקבל NULL מה-LEFT JOIN, והדשבורד מצפה
  -- לבוליאני. false = "לא תפעול תקלה", וזו התשובה הנכונה במקרה הזה.
  COALESCE(s.after_error, false),
  lo.start_end,
  lo.entry_exit,
  lo.card_number,
  lo.occurred_at,
  -- 0 ולא NULL: ב-JS blank() מאתחל ל-0, והדשבורד מציג את המספר הזה.
  COALESCE(se.n, 0)::int,
  m.id,
  m.set_by_name,
  m.set_by_role,
  m.reason,
  m.started_at,
  m.duration_hours,
  m.expires_at
FROM ids
LEFT JOIN faults      f  ON f.site_id  = ids.site_id
LEFT JOIN open_seg    s  ON s.site_id  = ids.site_id
LEFT JOIN last_op     lo ON lo.site_id = ids.site_id
LEFT JOIN since_error se ON se.site_id = ids.site_id
LEFT JOIN maint       m  ON m.site_id  = ids.site_id;
$$;

COMMENT ON FUNCTION public.site_globals(integer[]) IS
  'נתונים גלובליים לכל אתר: תקלה אחרונה, מקטע ראשון, מצב פתוח, פעולה אחרונה, '
  'פעולות מאז התקלה, ותחזוקה פעילה. תרגום של getAllSitesGlobals. ללא טווח תאריכים.';

-- ============================================================
-- public.recent_errors — התקלות האחרונות בכל המערכת
-- ============================================================
-- תרגום של getRecentErrors. נדרש כדי שמסך הבקרה יוכל להיקרא ישירות מהדשבורד
-- בלי לעבור דרך השרת — זה המסלול הכבד ביותר (נמדד: 1,096ms לחודש, 12 אתרים),
-- והוא זה שחוסם את ה-event loop ואיתו את הקליטה מ-MQTT כשמספר האתרים גדל.
--
-- ⚠️ "תחזוקה גוברת" — תקלה שהתחילה בתוך תחזוקה או בגבולה **אינה מוצגת**,
-- בדיוק כפי שאינה נספרת באחוז הכשל. שני המקורות נבדקים, וזה לא כפל:
--   1. מקטע maintenance שדווח מהבקר (status_history).
--   2. חלון תחזוקה ידני מהדשבורד (maintenance_windows).
-- אם רק אחד מהם ייבדק, אותה תקלה תיעלם ממדד אחד ותופיע במסך אחר — וזה
-- בדיוק סוג הסתירה שגורם לאבד אמון בשני המספרים.
--
-- הגבול **כולל** (<= / >=), כמו wasInMaintenanceMem ב-JS: תקלה שנרשמה בדיוק
-- ברגע שהתחזוקה התחילה או הסתיימה שייכת לתחזוקה.
-- ⚠️ DROP: הוספת fault_text משנה את **טיפוס ההחזרה**, ו-CREATE OR REPLACE
-- אינו יכול לשנות אותו — הוא נכשל רק על מסד שכבר מכיל גרסה קודמת. כלומר
-- עובר בפיתוח נקי ונופל בפרודקשן. אותה מלכודת בדיוק כמו ב-site_uptime.
DROP FUNCTION IF EXISTS public.recent_errors(integer);

CREATE OR REPLACE FUNCTION public.recent_errors(p_limit integer DEFAULT 10)
RETURNS TABLE (
  site_code   text,
  site_name   text,
  started_at  text,
  ended_at    text,
  ongoing     boolean,
  duration_seconds double precision,
  duration_minutes double precision,
  -- ⚠️ חייב להישאר זהה ל-getRecentErrors ב-queries.js. תיאור התקלה מהבקר;
  -- NULL = לא נקרא (תקלה היסטורית / סוכן ישן), '' = נקרא והיה ריק.
  fault_text  text
)
LANGUAGE sql
STABLE
AS $$
  SELECT s.code,
         s.site_name,
         h.started_at,
         h.ended_at,
         h.ended_at IS NULL AS ongoing,
         -- המשך המדויק בשניות: רוב ההשבתות קצרות, ובדקות מעוגלות כולן
         -- נראות "0 דק'" — כלומר ההבדל בין הבהוב של 3 שניות לתקלה של 50
         -- שניות אובד. התצוגה בוחרת יחידה (ראה formatOutage).
         GREATEST(0, EXTRACT(EPOCH FROM (
           COALESCE(h.ended_at::timestamptz, now()) - h.started_at::timestamptz
         )))::double precision AS duration_seconds,
         ROUND(GREATEST(0, EXTRACT(EPOCH FROM (
           COALESCE(h.ended_at::timestamptz, now()) - h.started_at::timestamptz
         )) / 60))::double precision AS duration_minutes,
         h.fault_text
    FROM status_history h
    JOIN sites s ON s.id = h.site_id
   WHERE COALESCE(h.reclassified_to, h.status) = 'error'
     AND NOT EXISTS (
       SELECT 1 FROM status_history m
        WHERE m.site_id = h.site_id AND COALESCE(m.reclassified_to, m.status) = 'maintenance'
          AND m.started_at <= h.started_at
          AND (m.ended_at IS NULL OR m.ended_at >= h.started_at))
     AND NOT EXISTS (
       SELECT 1 FROM maintenance_windows w
        WHERE w.site_id = h.site_id
          AND w.started_at <= h.started_at
          AND COALESCE(w.cancelled_at, w.expires_at) >= h.started_at)
   ORDER BY h.started_at DESC
   LIMIT p_limit;
$$;

COMMENT ON FUNCTION public.recent_errors(integer) IS
  'התקלות האחרונות בכל המערכת, ללא תקלות שהתרחשו בתחזוקה. תרגום של getRecentErrors.';

-- ============================================================
-- public.site_status_history — לוג שינויי המצב של אתר
-- ============================================================
-- תרגום של getStatusHistory. נדרש כדי שפאנל פרטי האתר ייקרא ישירות מהדשבורד.
--
-- שני כללים, ושניהם נלמדו מתקלות אמיתיות:
--
-- 1. **'בפעולה' מסונן — אבל רק כשיש פעולה שמסבירה אותו.** הסינון הגורף
--    הקודם הסתיר גם מקטע 'בפעולה' *יתום*, כזה שנוצר מ-resync של הסוכן בלי
--    שום פעולה. זה היה עיוור בדיוק לתקלה החשובה ביותר: אתר 1348 היה תקוע
--    ב'בפעולה' 11 שעות, וזה לא הופיע בפאנל כלל.
--    הסבילות (5 שניות) זהה ל-OP_PAIR_TOLERANCE_SECONDS: הסוכן מפרסם state
--    ו-operation באותו סבב אך לא באותה מילישנייה.
--
-- 2. **"תחזוקה גוברת"** — תקלה שהתחילה בתוך תחזוקה או בגבולה אינה מוצגת,
--    כמו שאינה נספרת. שני המקורות נבדקים (מקטע PLC + חלון ידני); בדיקת אחד
--    בלבד הייתה מעלימה תקלה ממסך אחד ומשאירה אותה באחר.
-- ⚠️ DROP: נוספו עמודות ל-RETURNS TABLE, ו-REPLACE אינו יכול לשנות טיפוס.
DROP FUNCTION IF EXISTS public.site_status_history(integer, integer);

CREATE OR REPLACE FUNCTION public.site_status_history(
  p_site_id integer,
  p_limit   integer DEFAULT 10
)
-- ⚠️ id נחשף כי בלעדיו אי אפשר לסמן שורה כניסוי — הכפתור בלוג צריך מזהה.
-- והשדות האחרים כדי שהשורה תוכל לומר "ניסוי · נוסה בידי X" בלי שאילתה נוספת.
RETURNS TABLE (id integer, status text, started_at text, ended_at text,
               excluded_at text, excluded_by text, exclusion_reason text)
LANGUAGE sql
STABLE
AS $$
  SELECT h.id, h.status, h.started_at, h.ended_at,
         h.excluded_at, h.excluded_by, h.exclusion_reason
    FROM status_history h
   WHERE h.site_id = p_site_id
     -- כלל 1: 'בפעולה' מוסתר רק אם יש פעולה שמסבירה אותו
     AND (h.status <> 'operating' OR NOT EXISTS (
           SELECT 1 FROM operations o
            WHERE o.site_id = h.site_id
              AND o.start_end = 'start'
              AND abs(EXTRACT(EPOCH FROM (
                    o.occurred_at::timestamptz - h.started_at::timestamptz))) <= 5))
     -- כלל 2: תקלה בזמן תחזוקה אינה מוצגת. גבול כולל, כמו wasInMaintenanceMem.
     AND NOT (COALESCE(h.reclassified_to, h.status) = 'error' AND (
           EXISTS (SELECT 1 FROM status_history m
                    WHERE m.site_id = h.site_id AND COALESCE(m.reclassified_to, m.status) = 'maintenance'
                      AND m.started_at <= h.started_at
                      AND (m.ended_at IS NULL OR m.ended_at >= h.started_at))
        OR EXISTS (SELECT 1 FROM maintenance_windows w
                    WHERE w.site_id = h.site_id
                      AND w.started_at <= h.started_at
                      AND COALESCE(w.cancelled_at, w.expires_at) >= h.started_at)))
   ORDER BY h.started_at DESC
   LIMIT p_limit;
$$;

COMMENT ON FUNCTION public.site_status_history(integer, integer) IS
  'לוג שינויי המצב של אתר, בלי ''בפעולה'' מוסבר ובלי תקלות שבתחזוקה. תרגום של getStatusHistory.';

-- ============================================================
-- Realtime על טבלת events — המחליף של ה-SSE
-- ============================================================
-- טבלת events היא **חוזה האירועים ולא התעבורה**: השרת כותב אליה שורה לכל
-- אירוע סמנטי, וכל קורא יכול להאזין. עד עכשיו היה קורא אחד (SSE מהשרת);
-- מכאן הדשבורד מאזין ישירות דרך Realtime.
--
-- זה מה שסוגר את הפער האחרון בתמונה: כל עוד קיים EventSource לשרת,
-- "הדשבורד מדבר רק עם Supabase" אינו נכון גם אם כל הקריאות עברו.
--
-- ⚠️ ההוספה לפרסום אינה מספיקה לבדה — Realtime מכבד RLS, ולכן מנוי מקבל
-- שורה רק אם המדיניות מתירה לו לקרוא אותה. `events` כבר מעניקה SELECT
-- ל-authenticated, וזו בדיוק ההגנה: מנוי אנונימי לא יקבל דבר.
--
-- ⚠️ ומדוע ה-SSE **לא נמחק**: הוא זרוע ב'. VITE_SUPABASE_DIRECT=false מחזיר
-- אליו, ולכן הוא חייב להישאר עובד.
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.events;
EXCEPTION
  WHEN duplicate_object THEN NULL;   -- כבר בפרסום
  WHEN undefined_object THEN NULL;   -- אין פרסום (Postgres נקי, לא Supabase)
END $$;

-- ============================================================
-- ⚠️ REPLICA IDENTITY FULL — **חובה**, ונמדד שהוא חובה
-- ============================================================
-- ההנחה הראשונה כאן הייתה שהוא מיותר: "מאזינים ל-INSERT בלבד, וזה מוסר את
-- השורה החדשה גם בזהות ברירת המחדל". **זה היה שגוי, ובדיקה חיה הוכיחה זאת** —
-- tools/smoke-realtime.js כתב אירוע אמיתי והמנוי לא קיבל אותו כלל תוך 15
-- שניות, למרות שהטבלה בפרסום ושהמדיניות היא USING (true).
--
-- הסיבה: Realtime **מעריך RLS עבור כל מנוי בנפרד**, וכדי לעשות זאת הוא צריך
-- את השורה המלאה מה-WAL. בזהות ברירת המחדל (PK בלבד) אין לו מה להעריך, והוא
-- פשוט לא מוסר — **בלי שגיאה, בלי אזהרה, בלי כלום.**
--
-- וזה בדיוק הכשל המסוכן ביותר במסך ניטור: לא הודעת שגיאה ולא סמל אפור, אלא
-- כרטיסים שקופאים על מצב ישן ונראים תקינים. זה כבר קרה כאן פעם אחת (אתר
-- 3501 הציג "בפעולה" בזמן שהלוג הראה "מוכן").
--
-- המחיר — שורות WAL גדולות יותר — זניח: events נושאת רטנציה של 7 ימים.

ALTER TABLE public.events REPLICA IDENTITY FULL;

-- ============================================================
-- public.report_monthly — דוח חודשי לטווח תאריכים חופשי
-- ============================================================
-- כמה פעולות וכמה תקלות בכל חודש, בין שני תאריכים שהמשתמשת בוחרת.
--
-- ⚠️ **מחושב מהנתונים החיים ולא מ-monthly_summary.** נמדד שהטבלה ההיא שגויה:
-- יולי הראה 633 פעולות מול 806 בפועל, ואוגוסט חסר בה לגמרי. היא נבנית בעבודה
-- יומית שלא רצה, ודוח שנשען עליה היה מדווח מספרים נמוכים מהאמת — בלי שום
-- סימן שמשהו חסר.
--
-- ⚠️ **"תחזוקה גוברת"** — תקלה שהתחילה בתוך תחזוקה או בגבולה אינה נספרת, בדיוק
-- כמו בכל מדד אחר. שני המקורות נבדקים (מקטע PLC + חלון ידני); בדיקת אחד בלבד
-- הייתה נותנת לדוח מספר תקלות שונה ממה שמופיע על המסך לאותה תקופה.
--
-- ⚠️ **superseded_by מוחרג** — ניסיון שנקטע והוחלף אינו פעולה נוספת. בלעדיו
-- הדוח היה סופר מעברים פיזיים פעמיים.
--
-- החודשים נגזרים מהנתונים עצמם (substr על TEXT), ולכן חודש בלי פעילות פשוט
-- אינו מופיע — ולא מוצג כשורת אפס מטעה.
CREATE OR REPLACE FUNCTION public.report_monthly(
  p_site_ids integer[],
  p_from     text,
  p_to       text
)
RETURNS TABLE (
  year_month  text,
  operations  integer,
  entries     integer,
  exits       integer,
  errors      integer,
  maintenance integer,
  sites       integer
)
LANGUAGE sql
STABLE
AS $$
WITH ops AS (
  SELECT substr(o.occurred_at, 1, 7) AS ym,
         COUNT(*)::int AS operations,
         COUNT(*) FILTER (WHERE o.entry_exit = 'entry')::int AS entries,
         COUNT(*) FILTER (WHERE o.entry_exit = 'exit')::int  AS exits,
         COUNT(DISTINCT o.site_id)::int AS sites
    FROM operations o
   WHERE (p_site_ids IS NULL OR o.site_id = ANY(p_site_ids))
     AND o.is_anomaly = 0
     AND o.superseded_by IS NULL
     AND o.start_end = 'end'
     -- לקסיקוגרפי על TEXT — האינדקס נשאר בשימוש
     AND o.occurred_at >= p_from
     AND o.occurred_at <  p_to
   GROUP BY 1
),
errs AS (
  SELECT substr(h.started_at, 1, 7) AS ym, COUNT(*)::int AS errors
    FROM status_history h
   WHERE (p_site_ids IS NULL OR h.site_id = ANY(p_site_ids))
     AND COALESCE(h.reclassified_to, h.status) = 'error'
     AND h.started_at >= p_from
     AND h.started_at <  p_to
     AND NOT EXISTS (
       SELECT 1 FROM status_history m
        WHERE m.site_id = h.site_id AND COALESCE(m.reclassified_to, m.status) = 'maintenance'
          AND m.started_at <= h.started_at
          AND (m.ended_at IS NULL OR m.ended_at >= h.started_at))
     AND NOT EXISTS (
       SELECT 1 FROM maintenance_windows w
        WHERE w.site_id = h.site_id
          AND w.started_at <= h.started_at
          AND COALESCE(w.cancelled_at, w.expires_at) >= h.started_at)
   GROUP BY 1
),
maint AS (
  SELECT substr(h.started_at, 1, 7) AS ym, COUNT(*)::int AS maintenance
    FROM status_history h
   WHERE (p_site_ids IS NULL OR h.site_id = ANY(p_site_ids))
     AND COALESCE(h.reclassified_to, h.status) = 'maintenance'
     AND h.started_at >= p_from
     AND h.started_at <  p_to
   GROUP BY 1
),
months AS (
  SELECT ym FROM ops
  UNION SELECT ym FROM errs
  UNION SELECT ym FROM maint
)
SELECT m.ym,
       COALESCE(o.operations, 0),
       COALESCE(o.entries, 0),
       COALESCE(o.exits, 0),
       COALESCE(e.errors, 0),
       COALESCE(t.maintenance, 0),
       COALESCE(o.sites, 0)
  FROM months m
  LEFT JOIN ops   o ON o.ym = m.ym
  LEFT JOIN errs  e ON e.ym = m.ym
  LEFT JOIN maint t ON t.ym = m.ym
 ORDER BY m.ym;
$$;

COMMENT ON FUNCTION public.report_monthly(integer[], text, text) IS
  'דוח חודשי לטווח חופשי: פעולות, כניסות, יציאות, תקלות ותחזוקה. מחושב מהנתונים החיים ולא מ-monthly_summary.';

-- ============================================================
-- public.report_by_site — דוח לכל אתר: תקלות ומחזורים
-- ============================================================
-- שורה לכל אתר בטווח תאריכים חופשי. הטווח נבחר ידנית וברוב המקרים הוא
-- כחודש — לפעמים 30 יום ולפעמים 31 — ולכן הוא פרמטר ולא תקופה קבועה.
--
-- ============================================================
-- ⚠️ המחזורים זמינים רק מרגע שהעמודה נוספה
-- ============================================================
-- מונה הבקר הגיע בכל הודעה מאז ומתמיד, אבל **לא נשמר לכל פעולה** — רק עדכן
-- סכום מצטבר על האתר. לכן אי אפשר לשחזר כמה מחזורים נעשו בחודש שחלף: המונה
-- אינו נגזר מהנתונים אלא מגיע מהבקר, ומה שלא נשמר אבד.
--
-- `cycles_from` / `cycles_to` מוחזרים במפורש כדי שהמסך יוכל לומר **על מה
-- המספר נשען**. כשאין קריאות בטווח שניהם NULL ו-cycles הוא NULL — ולא 0.
-- ההבחנה קריטית: "לא נמדד" ו"לא היו מחזורים" נראים זהה במספר אחד.
--
-- ⚠️ המחזורים נספרים גם על פעולות שאוחדו (superseded_by) ועל אנומליות: זה
-- **בלאי מכני** ולא ספירת פעולות חניה. המכונה זזה גם כשהמעבר לא נספר.
-- ⚠️ DROP לפני CREATE, ולא CREATE OR REPLACE בלבד. Postgres אינו מרשה
-- ל-REPLACE לשנות את **טיפוס ההחזרה** של פונקציה קיימת ("cannot change return
-- type of existing function"), ולכן הוספת עמודה לטבלה המוחזרת הייתה מפילה את
-- כל האתחול. עם DROP מקדים הקובץ נשאר מצב-יעד אידמפוטנטי גם כשהחתימה משתנה.
DROP FUNCTION IF EXISTS public.report_by_site(integer[], text, text);

CREATE OR REPLACE FUNCTION public.report_by_site(
  p_site_ids integer[],
  p_from     text,
  p_to       text
)
RETURNS TABLE (
  site_id     integer,
  code        text,
  site_name   text,
  operations  integer,
  errors      integer,
  error_hours double precision,
  maintenance integer,
  cycles       integer,
  cycles_from  integer,
  cycles_to    integer,
  cycle_reads  integer,
  -- ⚠️ פילוח התקלות לפי סוג: מערך jsonb של {text, count}, ממוין מהשכיח
  -- לנדיר. ראה fault_kinds למטה — ובעיקר למה הוא נגזר מאותן שורות בדיוק.
  fault_types  jsonb
)
LANGUAGE sql
STABLE
AS $$
WITH ids AS (
  SELECT s.id, s.code, s.site_name
    FROM sites s
   WHERE p_site_ids IS NULL OR s.id = ANY(p_site_ids)
),
ops AS (
  SELECT o.site_id, COUNT(*)::int AS operations
    FROM operations o
   WHERE o.is_anomaly = 0 AND o.superseded_by IS NULL AND o.start_end = 'end'
     AND o.occurred_at >= p_from AND o.occurred_at < p_to
     -- ⚠️ חלון תחזוקה ידני — ראה app.op_served
     AND app.op_served(o.site_id, o.occurred_at)
   GROUP BY o.site_id
),
-- המונה נמדד על **כל** הפעולות: בלאי מכני, לא ספירת חניות.
cyc AS (
  SELECT o.site_id,
         MIN(o.cycle_counter)::int AS c_from,
         MAX(o.cycle_counter)::int AS c_to,
         COUNT(*)::int AS readings
    FROM operations o
   WHERE o.cycle_counter IS NOT NULL
     AND o.occurred_at >= p_from AND o.occurred_at < p_to
   GROUP BY o.site_id
  -- ⚠️ **שתי קריאות לפחות.** הפרש נדרש שתי נקודות; עם קריאה אחת
  -- max-min הוא 0, וזה נקרא "המכונה לא זזה" בזמן שהמשמעות היא "אין מספיק
  -- מדידות". נמדד מיד עם תחילת האיסוף: אתרים עם קריאה בודדת הציגו 0.
  HAVING COUNT(*) >= 2
),
-- ============================================================
-- ⚠️ שורות התקלה נבחרות **פעם אחת**, ושני המדדים נגזרים מהן
-- ============================================================
-- הספירה, שעות ההשבתה והפילוח לפי סוג חייבים לתאר את אותה קבוצת שורות.
-- שכפול תנאי ה-WHERE לשתי שאילתות נפרדות עובד ביום שכותבים אותו ומתפצל
-- בשקט בשינוי הבא — והתוצאה על המסך היא פילוח שאינו מסתכם למספר התקלות
-- שלידו. דוח שסותר את עצמו גרוע מדוח בלי פילוח.
err_rows AS (
  SELECT h.site_id, h.fault_text, h.started_at, h.ended_at
    FROM status_history h
   WHERE COALESCE(h.reclassified_to, h.status) = 'error'
     AND h.started_at < p_to
     AND (h.ended_at IS NULL OR h.ended_at > p_from)
     -- "תחזוקה גוברת" — אותו כלל בדיוק כמו בכל מדד אחר.
     AND NOT EXISTS (
       SELECT 1 FROM status_history m
        WHERE m.site_id = h.site_id AND COALESCE(m.reclassified_to, m.status) = 'maintenance'
          AND m.started_at <= h.started_at
          AND (m.ended_at IS NULL OR m.ended_at >= h.started_at))
     AND NOT EXISTS (
       SELECT 1 FROM maintenance_windows w
        WHERE w.site_id = h.site_id
          AND w.started_at <= h.started_at
          AND COALESCE(w.cancelled_at, w.expires_at) >= h.started_at)
),
-- ============================================================
-- פילוח לפי סוג התקלה
-- ============================================================
-- ⚠️ תיאור חסר מקובץ תחת שם מפורש ולא מושמט. 'fault_text' מגיע מהבקר,
-- והוא ריק במקטעים ישנים ובגרסאות סוכן שקדמו לו. השמטתם הייתה גורמת
-- לפילוח לא להסתכם למספר התקלות — בדיוק הסתירה שהמבנה הזה נועד למנוע.
fault_kinds AS (
  SELECT site_id,
         jsonb_agg(
           jsonb_build_object('text', kind, 'count', n)
           ORDER BY n DESC, kind
         ) AS fault_types
    FROM (
      SELECT site_id,
             COALESCE(NULLIF(TRIM(fault_text), ''), 'ללא תיאור') AS kind,
             COUNT(*)::int AS n
        FROM err_rows
       GROUP BY site_id, COALESCE(NULLIF(TRIM(fault_text), ''), 'ללא תיאור')
    ) k
   GROUP BY site_id
),
errs AS (
  -- ⚠️ מ-err_rows ולא מ-status_history: הספירה והפילוח **חייבים** לתאר
  -- את אותן שורות. זו הנקודה היחידה שמבטיחה שהם יסתכמו זה לזה.
  SELECT h.site_id,
         COUNT(*)::int AS errors,
         -- שעות ההשבתה נחתכות לגבולות הטווח; מקטע פתוח נמשך עד סופו.
         (SUM(EXTRACT(EPOCH FROM (
            LEAST(COALESCE(h.ended_at, p_to)::timestamptz, p_to::timestamptz)
            - GREATEST(h.started_at::timestamptz, p_from::timestamptz)
          ))) / 3600.0)::double precision AS error_hours
    FROM err_rows h
   GROUP BY h.site_id
),
mnt AS (
  SELECT h.site_id, COUNT(*)::int AS maintenance
    FROM status_history h
   WHERE COALESCE(h.reclassified_to, h.status) = 'maintenance'
     AND h.started_at >= p_from AND h.started_at < p_to
   GROUP BY h.site_id
)
SELECT ids.id, ids.code, ids.site_name,
       COALESCE(o.operations, 0),
       COALESCE(e.errors, 0),
       ROUND(COALESCE(e.error_hours, 0)::numeric, 2)::double precision,
       COALESCE(m.maintenance, 0),
       -- NULL כשאין די קריאות מונה בטווח — ולא 0. ראה ההסבר למעלה.
       (c.c_to - c.c_from)::int,
       c.c_from, c.c_to, COALESCE(c.readings, 0),
       -- '[]' ולא NULL: אתר בלי תקלות מקבל רשימה ריקה, והמסך אינו
       -- צריך לטפל בשני מצבים שמשמעותם זהה.
       COALESCE(fk.fault_types, '[]'::jsonb)
  FROM ids
  LEFT JOIN ops  o ON o.site_id = ids.id
  LEFT JOIN cyc  c ON c.site_id = ids.id
  LEFT JOIN errs e ON e.site_id = ids.id
  LEFT JOIN mnt  m ON m.site_id = ids.id
  LEFT JOIN fault_kinds fk ON fk.site_id = ids.id
 ORDER BY ids.code;
$$;

COMMENT ON FUNCTION public.report_by_site(integer[], text, text) IS
  'דוח לכל אתר בטווח חופשי: פעולות, תקלות, שעות השבתה, תחזוקה ומחזורי מכונה.';

-- ============================================================
-- public.report_site_months — אתר × חודש
-- ============================================================
-- report_by_site מסכם את **כל** הטווח לשורה אחת לאתר. כשהטווח חוצה חודשים
-- (וזה המקרה הרגיל — "מ-5.7 עד היום") נשאלת מיד השאלה הבאה: **כמה פעולות
-- היו לאתר הזה בכל חודש**. הנתון קיים, הוא פשוט לא היה מפולח.
--
-- ⚠️ אותם כללים בדיוק כמו report_by_site ו-report_monthly: superseded_by
-- מוחרג, אנומליות מוחרגות, ו"תחזוקה גוברת" על תקלה. שלוש הפונקציות חייבות
-- להסכים — אחרת סכום השורות בטבלה אחת לא יתאים לשורה בטבלה שלידה.
CREATE OR REPLACE FUNCTION public.report_site_months(
  p_site_ids integer[],
  p_from     text,
  p_to       text
)
RETURNS TABLE (
  site_id    integer,
  code       text,
  year_month text,
  operations integer,
  entries    integer,
  exits      integer,
  errors     integer,
  cycles     integer
)
LANGUAGE sql
STABLE
AS $$
WITH ops AS (
  SELECT o.site_id, substr(o.occurred_at, 1, 7) AS ym,
         COUNT(*)::int AS operations,
         COUNT(*) FILTER (WHERE o.entry_exit = 'entry')::int AS entries,
         COUNT(*) FILTER (WHERE o.entry_exit = 'exit')::int  AS exits
    FROM operations o
   WHERE (p_site_ids IS NULL OR o.site_id = ANY(p_site_ids))
     AND o.is_anomaly = 0 AND o.superseded_by IS NULL AND o.start_end = 'end'
     AND o.occurred_at >= p_from AND o.occurred_at < p_to
   GROUP BY 1, 2
),
-- המונה נמדד על כל הפעולות (בלאי מכני), ודורש שתי קריאות לפחות באותו חודש.
cyc AS (
  SELECT o.site_id, substr(o.occurred_at, 1, 7) AS ym,
         (MAX(o.cycle_counter) - MIN(o.cycle_counter))::int AS cycles
    FROM operations o
   WHERE (p_site_ids IS NULL OR o.site_id = ANY(p_site_ids))
     AND o.cycle_counter IS NOT NULL
     AND o.occurred_at >= p_from AND o.occurred_at < p_to
   GROUP BY 1, 2
  HAVING COUNT(*) >= 2
),
errs AS (
  SELECT h.site_id, substr(h.started_at, 1, 7) AS ym, COUNT(*)::int AS errors
    FROM status_history h
   WHERE (p_site_ids IS NULL OR h.site_id = ANY(p_site_ids))
     AND COALESCE(h.reclassified_to, h.status) = 'error'
     AND h.started_at >= p_from AND h.started_at < p_to
     AND NOT EXISTS (
       SELECT 1 FROM status_history m
        WHERE m.site_id = h.site_id AND COALESCE(m.reclassified_to, m.status) = 'maintenance'
          AND m.started_at <= h.started_at
          AND (m.ended_at IS NULL OR m.ended_at >= h.started_at))
     AND NOT EXISTS (
       SELECT 1 FROM maintenance_windows w
        WHERE w.site_id = h.site_id
          AND w.started_at <= h.started_at
          AND COALESCE(w.cancelled_at, w.expires_at) >= h.started_at)
   GROUP BY 1, 2
),
keys AS (
  SELECT site_id, ym FROM ops
  UNION SELECT site_id, ym FROM errs
)
SELECT k.site_id, s.code, k.ym,
       COALESCE(o.operations, 0),
       COALESCE(o.entries, 0),
       COALESCE(o.exits, 0),
       COALESCE(e.errors, 0),
       c.cycles
  FROM keys k
  JOIN sites s ON s.id = k.site_id
  LEFT JOIN ops  o ON o.site_id = k.site_id AND o.ym = k.ym
  LEFT JOIN errs e ON e.site_id = k.site_id AND e.ym = k.ym
  LEFT JOIN cyc  c ON c.site_id = k.site_id AND c.ym = k.ym
 ORDER BY s.code, k.ym;
$$;

COMMENT ON FUNCTION public.report_site_months(integer[], text, text) IS
  'אתר × חודש: פעולות, כניסות, יציאות, תקלות ומחזורים. פילוח של report_by_site.';

-- ============================================================
-- אות החיים של השרת — המפתח היחיד שנחשף מתוך settings
-- ============================================================
-- ⚠️ **הצורך נמדד פעמיים.** ב-26.07 השרת היה למטה 15 שעות, וב-22.08 עוד
-- 14.7. בשני המקרים לא אבד נתון אחד — HiveMQ שמר הכול ומסר בהפעלה הבאה —
-- אבל **המסך הראה מצב ישן בלי לומר שהוא ישן**. זה מה שהפך תקלה של דקה
-- לבוקר שלם של חיפוש.
--
-- ⚠️ **ולמה זה לא נגזר מגיל הנתונים.** הסוכן משדר רק ב**שינוי** MODE, ולכן
-- לילה שקט באמת נראה זהה לשרת מת: אפס הודעות בשני המקרים. רק שורה שהשרת
-- כותב על עצמו מבחינה בין השניים.
--
-- ============================================================
-- ⚠️ SECURITY DEFINER, ומפתח אחד — לא מדיניות על הטבלה
-- ============================================================
-- ל-`settings` **אין מדיניות RLS במכוון**: היא מחזיקה את גיבוב קוד המנהל.
-- הוספת מדיניות כדי לחשוף ערך אחד הייתה פותחת את כל הטבלה. הדרך שנקבעה
-- בתיעוד היא בדיוק זו — פונקציה STABLE שמחזירה את המפתח הבודד הזה.
--
-- ⚠️ ולכן ה-WHERE כאן קבוע ואינו פרמטר: פונקציה שמקבלת שם מפתח הייתה
-- הופכת לחלון קריאה לכל הטבלה, כולל הגיבוב.
CREATE OR REPLACE FUNCTION public.server_heartbeat()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT value FROM settings WHERE key = 'server_heartbeat'
$$;

REVOKE ALL ON FUNCTION public.server_heartbeat() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.server_heartbeat() TO authenticated;

COMMENT ON FUNCTION public.server_heartbeat() IS
  'החותם האחרון שהשרת כתב על עצמו. NULL = מעולם לא נכתב. משמש את הדשבורד כדי לומר שהוא מציג נתונים ישנים.';

-- ============================================================
-- executive_series — כל מה שמסך "מנהל כללי" צריך, בקריאה אחת
-- ============================================================
-- ⚠️ **מה זה מחליף.** הזרוע הישירה שלפה שורות **גולמיות** והריצה עליהן
-- את computeExecutive בדפדפן. נמדד על הייצור:
--
--     חודש: 10,605 שורות · 6 נסיעות רשת סדרתיות
--     שנה : 14,361 שורות · 8 נסיעות
--
-- וכל זה כדי להפיק גרף של 30 נקודות. כאן: שורה לכל (דלי × אתר) —
-- 496 שורות, 71KB, קריאה אחת.
--
-- ============================================================
-- ⚠️ למה יש p_from/p_to **וגם** p_buckets
-- ============================================================
-- הגרסה הראשונה קראה ל-site_stats לכל דלי, וזה נכשל ב-parity על מקרה
-- אמיתי — מגדל 1, 30/08/2026:
--
--     error    27/08 08:05 → 13:15
--     no_comm  27/08 13:15 → 30/08 09:25    (2.9 ימים)
--     error    30/08 09:25 → פתוח           ← בדלי של היום
--
-- קיפול הריצוד מזהה את השלישית כ**המשך** של הראשונה ולכן אינו סופר
-- אותה. קריאה שרואה רק את הדלי אינה רואה את הראשונה: JS=1 מול SQL=2.
-- לכן **הקיפול רץ פעם אחת על כל התקופה**, והמקטעים ששרדו מחולקים
-- לדליים לפי started_at — בדיוק מה ש-statsFromData עושה.
--
-- ============================================================
-- ⚠️ הצורה: CTE-ים מקובצים, לא LATERAL לכל תא
-- ============================================================
-- הגרסה שקדמה קראה ל-site_uptime בתוך LATERAL שרץ לכל (דלי × אתר) —
-- 480 קריאות. **נמדד: 13,216ms**, כלומר איטי פי חמישה־עשר מהמסלול
-- שהוא בא להחליף. אותה תוצאה בדיוק, צורה אחרת: קריאה אחת לכל דלי
-- (30), וסריקה מקובצת אחת על operations.
--
-- זה לא כוונון — זו ההבחנה בין "נכון" ל"שמיש", ובלי מדידה היא נראית
-- כמו אותו קוד.
-- ⚠️ **הסרת החתימה הישנה חייבת לקדום.** `CREATE OR REPLACE` עם רשימת
-- פרמטרים שונה **יוצר פונקציה חדשה** ומשאיר את הקודמת חיה לצידה. קרה
-- כאן בפועל: הגרסה בת שני הפרמטרים — זו שנכשלה ב-parity על ספירת
-- התקלות של מגדל 1 — נשארה במסד אחרי שהוחלפה, ו-`pg_get_functiondef`
-- החזיר דווקא אותה.
--
-- ⚠️ שתי גרסאות של אותו מדד הן שני מספרים לאותו אירוע, וזה בדיוק הכשל
-- שכל קובץ ההנחיות בנוי סביבו. אותו דפוס כבר קיים ב-writes.postgres.sql
-- עבור submit_field_report.
DROP FUNCTION IF EXISTS public.executive_series(integer[], jsonb);

CREATE OR REPLACE FUNCTION public.executive_series(
  p_site_ids integer[],
  p_from     text,
  p_to       text,
  p_buckets  jsonb
)
RETURNS TABLE (
  bucket               integer,
  site_id              integer,
  operations           integer,
  errors               integer,
  entries              integer,
  exits                integer,
  maintenance_hours    double precision,
  availability_percent double precision,
  measured_hours       double precision
)
LANGUAGE sql
STABLE
AS $$
WITH b AS (
  -- ⚠️ WITH ORDINALITY שומר על סדר הדליים. בלעדיו הגרף היה מקבל את
  -- אותם מספרים בסדר אחר — נראה כמו נתונים שגויים, לא כמו באג מיון.
  SELECT (ord - 1)::integer AS bucket,
         e ->> 'from'       AS f,
         e ->> 'to'         AS t
    FROM jsonb_array_elements(p_buckets) WITH ORDINALITY AS x(e, ord)
),
ids AS (
  SELECT id AS site_id FROM sites
   WHERE p_site_ids IS NULL OR id = ANY(p_site_ids)
),
-- קריאה אחת לכל **דלי**, לא לכל תא. זה ההבדל בין 30 קריאות ל-480.
up AS (
  SELECT b.bucket, u.site_id, u.maintenance_hours, u.availability_percent, u.measured_hours
    FROM b
    CROSS JOIN LATERAL public.site_uptime(p_site_ids, b.f, b.t) u
),
-- סריקה מקובצת אחת על operations, במקום תת-שאילתה לכל תא.
ops AS (
  SELECT b.bucket,
         o.site_id,
         COUNT(*)::integer                                            AS operations,
         COUNT(*) FILTER (WHERE o.entry_exit = 'entry')::integer      AS entries,
         COUNT(*) FILTER (WHERE o.entry_exit = 'exit')::integer       AS exits
    FROM b
    JOIN operations o
      ON o.occurred_at >= b.f
     AND o.occurred_at < b.t
   WHERE (p_site_ids IS NULL OR o.site_id = ANY(p_site_ids))
     -- ⚠️ הסינון **חייב** להיות זהה לזה של site_stats — כולל
     -- app.op_served — אחרת כניסות+יציאות לא יסתכמו לסך הפעולות **על
     -- אותו מסך**, וזה נראה כמו טעות עיגול ולא כמו מקור שונה.
     AND o.excluded_at IS NULL
     AND o.is_anomaly = 0
     AND o.start_end = 'end'
     AND o.superseded_by IS NULL
     AND app.op_served(o.site_id, o.occurred_at)
   GROUP BY b.bucket, o.site_id
),
-- הקיפול, פעם אחת, על כל התקופה.
errs AS (
  SELECT e.site_id, e.started_at
    FROM app.error_segments(p_site_ids, p_from, p_to) e
   WHERE NOT e.in_maintenance
),
err_by_bucket AS (
  SELECT b.bucket, e.site_id, COUNT(*)::integer AS n
    FROM b JOIN errs e
      ON e.started_at >= b.f AND e.started_at < b.t
   GROUP BY b.bucket, e.site_id
)
-- ⚠️ הנהג הוא (דלי × אתר) ולא הנתונים: הגרף חייב להראות דלי עם אפס
-- פעולות, לא לדלג עליו.
SELECT
  b.bucket,
  ids.site_id,
  COALESCE(o.operations, 0),
  COALESCE(eb.n, 0),
  COALESCE(o.entries, 0),
  COALESCE(o.exits, 0),
  u.maintenance_hours,
  u.availability_percent,
  u.measured_hours
FROM b
CROSS JOIN ids
LEFT JOIN up            u  ON u.bucket  = b.bucket AND u.site_id  = ids.site_id
LEFT JOIN ops           o  ON o.bucket  = b.bucket AND o.site_id  = ids.site_id
LEFT JOIN err_by_bucket eb ON eb.bucket = b.bucket AND eb.site_id = ids.site_id;
$$;

COMMENT ON FUNCTION public.executive_series(integer[], text, text, jsonb) IS
  'שורה לכל (דלי × אתר) עבור מסך המנהל הכללי. הקיפול רץ פעם אחת על כל התקופה; זמינות נקראת פעם אחת לכל דלי.';

-- ============================================================
-- ⚠️ אותם נתונים בשורה אחת — כי PostgREST חותך ב-1,000 שורות
-- ============================================================
-- `executive_series` מחזירה שורה לכל (דלי × אתר). PostgREST מגביל כל תשובה
-- ל-1,000 שורות, וזה **אינו ניתן לעקיפה מהלקוח**: גם `Range: 0-9999` חוזר
-- עם `0-999`. התקרה היא הגדרת שרת.
--
-- ⚠️ נמדד בייצור: "השנה הנוכחית" ברזולוציה יומית = 243 דליים × 16 אתרים =
-- 3,888 שורות, מהן חזרו 1,000. **וסטטוס 200** — לא 206, לא שגיאה. לקוח
-- רגיל רואה תשובה מוצלחת לגמרי עם 26% מהנתונים.
--
-- ⚠️ וזה גרוע מחיתוך נקי: לפונקציה אין `ORDER BY`, ולכן אלה 1,000 שורות
-- **שרירותיות** מתוך 5,872. הגרף אינו נגמר באמצע — הוא מפוזר: דליים עם
-- נתונים ודליים באפס לסירוגין, בדפוס שנראה בדיוק כמו מכונה שקטה.
--
-- ⚠️ ההיגסה שב-getBucketRanges אינה יכולה לפתור את זה, ולא במקרה: התקרה
-- תלויה ב**מספר האתרים**, שאינו ידוע לשכבת המדדים, והיא תכונה של PostgREST
-- ולא החלטת מוצר. שתי הזרועות חייבות להחזיר את אותה צורה — הגסה מותנית
-- באתרים בזרוע אחת בלבד הייתה שוברת בדיוק את זה.
--
-- ⚠️ ודפדוף אינו אופציה בלי `ORDER BY` — עמודים היו חופפים ומדלגים בשקט.
-- שורה אחת היא הפתרון היחיד שאינו תלוי לא במיון ולא במספר האתרים.
CREATE OR REPLACE FUNCTION public.executive_series_json(
  p_site_ids integer[],
  p_from     text,
  p_to       text,
  p_buckets  jsonb
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  -- COALESCE כדי שתקופה בלי אף דלי תחזיר [] ולא NULL: הלקוח עושה .map.
  SELECT COALESCE(jsonb_agg(t), '[]'::jsonb)
    FROM public.executive_series(p_site_ids, p_from, p_to, p_buckets) t;
$$;

COMMENT ON FUNCTION public.executive_series_json(integer[], text, text, jsonb) IS
  'executive_series בשורה אחת — עוקף את תקרת 1,000 השורות של PostgREST, שחתכה בשקט כל טווח מעל 62 ימים ברזולוציה יומית.';
