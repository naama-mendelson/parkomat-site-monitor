-- ============================================================
-- שעות שירות — הזמינות נמדדת רק בתוך חלון ההסכם
-- ============================================================
-- ⚠️ **החלטת מוצר, לא תיקון חישוב.** תקלה שקרתה בשבת באתר עם הסכם
-- בסיסי אינה זמן שבו השירות נכשל — אין שירות בשבת. עד היום היא נספרה
-- ככשל מלא, וזה עיוות את המספר לרעה בדיוק באתרים שקנו פחות שירות.
--
--   בסיסי   א'-ה'  08:00-17:00                      45 שעות בשבוע
--   מורחב   א'-ה'  07:00-22:00 · ו'  08:00-13:00    80 שעות בשבוע
--   VIP     א'-ה'  07:00-22:00 · ו'-ש' 08:00-22:00  103 שעות בשבוע
--
-- ⚠️ **שעון ישראל, לא UTC — וזה לא פרט טכני.** כל החותמים במסד הם
-- UTC, והפרש השעון הוא **שעתיים בחורף ושלוש בקיץ**. חישוב נאיבי היה
-- מזיז כל חלון שירות בשעתיים-שלוש: תקלה שנפתחה ב-08:00 בבוקר הייתה
-- נספרת כאילו קרתה ב-05:00 — מחוץ לשעות השירות, כלומר **נעלמת
-- לחלוטין מהמדד**. ו-`AT TIME ZONE 'Asia/Jerusalem'` מטפל במעבר
-- שעון הקיץ בעצמו; טבלת היסטים ידנית הייתה נשברת פעמיים בשנה.
--
-- ⚠️ **חגים אינם כאן, וזה פער ידוע.** יום כיפור ייספר כיום חול רגיל
-- באתר בסיסי. הוספת לוח שנה עברי היא החלטה נפרדת — נרשם כדי שלא
-- ייראה כמו תקלה כשמישהו ישים לב.

-- ============================================================
-- app.service_windows — חלונות השירות בטווח נתון
-- ============================================================
-- מחזירה את חלונות השירות **בפועל** בין שני חותמים, כבר חתוכים
-- לגבולות הטווח. פונקציה טהורה: אין בה קריאה לאף טבלה, ולכן אפשר
-- לבדוק אותה מול מספרים ידועים בלי לגעת בנתוני לקוחות.
DROP FUNCTION IF EXISTS app.service_windows(text, timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION app.service_windows(
  p_kind text,
  p_from timestamptz,
  p_to   timestamptz
)
RETURNS TABLE (starts_at timestamptz, ends_at timestamptz)
LANGUAGE sql
STABLE
AS $fn$
WITH kind AS (
  -- ⚠️ נרמול: הרמזור מכיל "vip"/"VIP"/"ext" ורווחים בקצוות. ערך לא
  -- מוכר **אינו** נופל לברירת מחדל שקטה — הוא מחזיר אפס חלונות, ומי
  -- שקורא לפונקציה מחליט מה לעשות עם זה. ברירת מחדל שקטה כאן הייתה
  -- מייצרת מדד שנראה תקין ומחושב על חלון שאיש לא בחר.
  SELECT lower(btrim(coalesce(p_kind, ''))) AS k
),
days AS (
  -- יום אחד לפני ואחרי, כדי שחלון שמתחיל לפני הטווח וממשיך לתוכו
  -- ייחתך נכון ולא ייעלם.
  SELECT generate_series(
           (p_from AT TIME ZONE 'Asia/Jerusalem')::date - 1,
           (p_to   AT TIME ZONE 'Asia/Jerusalem')::date + 1,
           interval '1 day')::date AS d
),
spans AS (
  SELECT d,
         extract(dow FROM d)::int AS dow,
         CASE
           -- א'-ה' (0=ראשון .. 4=חמישי)
           WHEN extract(dow FROM d)::int BETWEEN 0 AND 4 THEN
             CASE (SELECT k FROM kind)
               WHEN 'basic' THEN time '08:00'
               WHEN 'ext'   THEN time '07:00'
               WHEN 'vip'   THEN time '07:00'
             END
           -- שישי
           WHEN extract(dow FROM d)::int = 5 THEN
             CASE (SELECT k FROM kind)
               WHEN 'ext' THEN time '08:00'
               WHEN 'vip' THEN time '08:00'
             END
           -- שבת
           WHEN extract(dow FROM d)::int = 6 THEN
             CASE (SELECT k FROM kind)
               WHEN 'vip' THEN time '08:00'
             END
         END AS t_start,
         CASE
           WHEN extract(dow FROM d)::int BETWEEN 0 AND 4 THEN
             CASE (SELECT k FROM kind)
               WHEN 'basic' THEN time '17:00'
               WHEN 'ext'   THEN time '22:00'
               WHEN 'vip'   THEN time '22:00'
             END
           WHEN extract(dow FROM d)::int = 5 THEN
             CASE (SELECT k FROM kind)
               WHEN 'ext' THEN time '13:00'
               WHEN 'vip' THEN time '22:00'
             END
           WHEN extract(dow FROM d)::int = 6 THEN
             CASE (SELECT k FROM kind)
               WHEN 'vip' THEN time '22:00'
             END
         END AS t_end
    FROM days
)
SELECT GREATEST((d + t_start) AT TIME ZONE 'Asia/Jerusalem', p_from) AS starts_at,
       LEAST   ((d + t_end)   AT TIME ZONE 'Asia/Jerusalem', p_to)   AS ends_at
  FROM spans
 WHERE t_start IS NOT NULL
   -- חיתוך לטווח: רק חלונות שבאמת חופפים אותו
   AND (d + t_end)   AT TIME ZONE 'Asia/Jerusalem' > p_from
   AND (d + t_start) AT TIME ZONE 'Asia/Jerusalem' < p_to
 ORDER BY 1;
$fn$;

COMMENT ON FUNCTION app.service_windows(text, timestamptz, timestamptz) IS
  'חלונות שעות השירות (basic/ext/vip) בטווח נתון, בשעון Asia/Jerusalem. טהורה.';

-- ============================================================
-- app.service_agreement — ההסכם של אתר, מתוך לוח הרמזור
-- ============================================================
-- ⚠️ **החיבור הוא לפי קוד ולא לפי שם, וזה נמדד.** התאמה לפי שם נתנה
-- 5 מתוך 23, ושתי המלכודות שלה חמורות: "ז'בוטינסקי" מול "ז'בוטניסקי"
-- לא יתאימו לעולם **בשקט**, ו-"הירקון 72" מול "הירקון 224" הם בניינים
-- שונים שהתאמה מקורבת הייתה מזווגת. זיווג שגוי מדווח זמינות של אתר
-- אחד על חשבון אחר — גרוע בהרבה מהיעדר זיווג.
--
-- ⚠️ **ואתר בלי שורה ברמזור מחזיר NULL, לא ברירת מחדל.** 23 מתוך 28
-- האתרים כאלה היום. NULL פירושו "לא הוגדר הסכם", והקורא מחליט —
-- והבחירה שנעשתה היא להשאיר אותם על 24/7 כפי שהיו, כלומר שינוי חל
-- **רק** על אתר שמישהו חיבר במפורש.
CREATE OR REPLACE FUNCTION app.service_agreement(p_site_id integer)
RETURNS text
LANGUAGE sql
STABLE
AS $fn$
  WITH keys AS (
    SELECT
      (SELECT key FROM traffic_light_columns WHERE label = 'קוד אתר'  LIMIT 1) AS k_code,
      -- ⚠️ "להתייחס כ" ולא "סוג הסכם שירות במקור": הראשונה היא ההחלטה
      -- התפעולית ("איך להתייחס לאתר הזה"), השנייה היא מה שנחתם. הן
      -- נבדלות היום ב-3 אתרים.
      (SELECT key FROM traffic_light_columns WHERE label = 'להתייחס כ' LIMIT 1) AS k_kind
  )
  -- ⚠️ **התא מחזיק רשימת קודים, לא קוד יחיד.** לקוח אחד יכול להחזיק
  -- כמה חניונים תחת אותו הסכם שירות, ואותה שורה בלוח מתארת את כולם —
  -- אותם אנשי קשר, אותה אחריות, אותו הסכם. שורה כפולה לכל אתר פירושה
  -- שעדכון פרט אחד צריך להיעשות בכמה מקומות, ומי שיעדכן אחד מהם
  -- יישאר עם לוח שסותר את עצמו.
  --
  -- הפרדה בפסיקים, והרווחים נזרקים: "1275, 2439" ו-"1275,2439" הם
  -- אותו דבר, כי מי שמקליד ביד יכתוב את שניהם.
  SELECT lower(btrim(r.cells ->> k.k_kind))
    FROM traffic_light_rows r, keys k, sites s
   WHERE s.id = p_site_id
     AND s.code = ANY(
           string_to_array(
             replace(replace(btrim(coalesce(r.cells ->> k.k_code, '')),
                             chr(32), ''), chr(9), ''),
             ','))
     AND btrim(coalesce(r.cells ->> k.k_kind, '')) <> ''
   LIMIT 1;
$fn$;

COMMENT ON FUNCTION app.service_agreement(integer) IS
  'סוג הסכם השירות של אתר לפי עמודת "קוד אתר" בלוח הרמזור. NULL = לא חובר.';

-- ============================================================
-- public.site_uptime_service — זמינות בתוך שעות השירות בלבד
-- ============================================================
-- ⚠️ **פונקציה נפרדת ולא שינוי של `site_uptime`, וזו החלטה.**
-- ‏`site_uptime` מזינה כל מסך במערכת ויש לה שער השוואה מול הצד ב-JS.
-- שינוי שלה במקום היה מזיז את כל המספרים בבת אחת, בלי דרך להשוות
-- לפני ואחרי. כאן אפשר להריץ את השתיים זו לצד זו ולראות את ההפרש.
--
-- ⚠️ **ההגדרה זהה ל-`site_uptime` במכוון:**
--   ‏(ready + operating) / (ready + operating + error)
-- תחזוקה ו-no_comm מוחרגים לחלוטין, בדיוק כמו שם. מה שמשתנה הוא
-- **הזמן שנכנס לחישוב** — רק מה שנחתך עם חלון השירות.
--
-- ⚠️ **אתר בלי הסכם מחזיר NULL בכל השדות ולא אפס.** אפס נקרא
-- "מושבת לגמרי"; NULL נקרא "לא נמדד". זו אותה הבחנה ש-`site_uptime`
-- כבר עושה כש-`measured_hours = 0`.
DROP FUNCTION IF EXISTS public.site_uptime_service(integer[], text, text);

CREATE OR REPLACE FUNCTION public.site_uptime_service(
  p_site_ids integer[],
  p_from     text,
  p_to       text
)
RETURNS TABLE (
  site_id              integer,
  agreement            text,
  service_hours        double precision,
  ready_hours          double precision,
  operating_hours      double precision,
  error_hours          double precision,
  maintenance_hours    double precision,
  no_comm_hours        double precision,
  measured_hours       double precision,
  availability_percent double precision
)
LANGUAGE sql
STABLE
AS $fn$
WITH ids AS (
  SELECT s.id, app.service_agreement(s.id) AS kind
    FROM sites s
   WHERE p_site_ids IS NULL OR s.id = ANY(p_site_ids)
),
win AS (
  SELECT ids.id AS site_id, w.starts_at, w.ends_at
    FROM ids
    CROSS JOIN LATERAL app.service_windows(
      ids.kind, p_from::timestamptz, p_to::timestamptz) w
   WHERE ids.kind IS NOT NULL
),
segs AS (
  -- ⚠️ הסינון על ה-TEXT נשאר לקסיקלי כדי לשמור על האינדקס; ההמרה
  -- ל-timestamptz קורית **אחרי** הסינון, רק על השורות שנבחרו.
  SELECT h.site_id,
         COALESCE(h.reclassified_to, h.status)      AS st,
         h.started_at::timestamptz                  AS s,
         COALESCE(h.ended_at, p_to)::timestamptz    AS e
    FROM status_history h
    JOIN ids ON ids.id = h.site_id
   WHERE h.started_at < p_to
     AND COALESCE(h.ended_at, p_to) > p_from
),
cut AS (
  SELECT segs.site_id, segs.st,
         extract(epoch FROM (
           LEAST(segs.e, win.ends_at) - GREATEST(segs.s, win.starts_at))) AS sec
    FROM segs
    JOIN win ON win.site_id = segs.site_id
   WHERE LEAST(segs.e, win.ends_at) > GREATEST(segs.s, win.starts_at)
),
agg AS (
  SELECT site_id,
         sum(sec) FILTER (WHERE st = 'ready')       / 3600.0 AS ready_h,
         sum(sec) FILTER (WHERE st = 'operating')   / 3600.0 AS operating_h,
         sum(sec) FILTER (WHERE st = 'error')       / 3600.0 AS error_h,
         sum(sec) FILTER (WHERE st = 'maintenance') / 3600.0 AS maint_h,
         sum(sec) FILTER (WHERE st = 'no_comm')     / 3600.0 AS nocomm_h
    FROM cut GROUP BY site_id
),
svc AS (
  SELECT site_id, sum(extract(epoch FROM (ends_at - starts_at))) / 3600.0 AS hours
    FROM win GROUP BY site_id
)
SELECT ids.id,
       ids.kind,
       svc.hours::double precision,
       COALESCE(agg.ready_h, 0)::double precision,
       COALESCE(agg.operating_h, 0)::double precision,
       COALESCE(agg.error_h, 0)::double precision,
       COALESCE(agg.maint_h, 0)::double precision,
       COALESCE(agg.nocomm_h, 0)::double precision,
       (COALESCE(agg.ready_h,0) + COALESCE(agg.operating_h,0)
        + COALESCE(agg.error_h,0))::double precision,
       -- ⚠️ NULL ולא 0 כשלא נמדד דבר, בדיוק כמו ב-site_uptime:
       -- "0%" נקרא כ"מושבת לגמרי" כשהמשמעות היא "איננו יודעים".
       CASE
         WHEN COALESCE(agg.ready_h,0) + COALESCE(agg.operating_h,0)
              + COALESCE(agg.error_h,0) > 0
         THEN round((100.0 * (COALESCE(agg.ready_h,0) + COALESCE(agg.operating_h,0))
              / (COALESCE(agg.ready_h,0) + COALESCE(agg.operating_h,0)
                 + COALESCE(agg.error_h,0)))::numeric, 2)::double precision
         ELSE NULL
       END
  FROM ids
  LEFT JOIN agg ON agg.site_id = ids.id
  LEFT JOIN svc ON svc.site_id = ids.id
 WHERE ids.kind IS NOT NULL
 ORDER BY ids.id;
$fn$;

COMMENT ON FUNCTION public.site_uptime_service(integer[], text, text) IS
  'זמינות בתוך שעות השירות של ההסכם בלבד. מחזירה שורה רק לאתר שחובר ברמזור.';

REVOKE ALL ON FUNCTION public.site_uptime_service(integer[], text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.site_uptime_service(integer[], text, text) TO authenticated;
