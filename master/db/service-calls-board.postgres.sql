-- db/service-calls-board.postgres.sql — קריאות השירות של ויזנט על כרטיס האתר (13/10/2026).
--
-- בעלת המוצר: "סימון על כרטיס האתר", ושינוי סטטוס וסוג — "כל אחד". המייל ממחלקת השירות (24/09/2026): המוקדנים
-- רואים שהמערכת תקולה, אבל ייתכן שאף דייר לא פתח קריאה בוויזנט — ולכן שכבת הקריאות לצד נתוני המערכת.
--
-- ⚠️ **קובץ נפרד מ-service-calls.postgres.sql, ונטען אחרי tasks**: הוא משתמש ב-app.require_staff /
-- app.is_staff (compliance) וב-app.record_write_audit / record_write_event (writes). קובץ הקליטה נטען לפני
-- compliance, ופונקציית SQL שמפנה לפונקציה שעוד לא קיימת נכשלת ביצירה.
--
-- ============================================================
-- מה מגיע מוויזנט, ומה עושים איתו
-- ============================================================
-- ויזנט שולחים POST לכל פתיחה ולכל עדכון של קריאה, ולכן **שורה לכל אירוע**, לא לכל קריאה. המצב של קריאה
-- הוא השורה האחרונה שלה (לפי ticket_number), ומעליה — שינוי שעשינו מהדשבורד, אם הוא חדש יותר (ייתכן
-- שוויזנט לא שולחים עדכון על שינוי שבא מה-API; זו השאלה ששאלנו את ויזנט).
--
-- ⚠️ **השיוך לאתר: קוד הפרויקט.** שדה ייעודי (project_code) אם יגיע — גיל הציע לעבור אליו — ואחרת החלק
-- הראשון של parking_code ("1226-1-02" → "1226"). קריאה שלא נמצא לה אתר אינה נספרת על אף כרטיס.
--
-- ⚠️ **"פתוחה" = הסטטוס שלה אינו מסומן closed ברשימת הסטטוסים של ויזנט** (wizenet_lookups). סטטוס שאינו
-- ברשימה — פתוחה: עדיף להציג קריאה שאולי נסגרה מאשר להעלים אחת פתוחה. ⚠️ ולכן התכונה כבויה בדשבורד
-- (VITE_SERVICE_CALLS) עד שהרשימה נטענת מוויזנט וסומן בה מה סוגר קריאה.

-- ============================================================
-- הרשימות של ויזנט — סטטוסים וסוגי קריאה
-- ============================================================
-- ממולאות דרך הממסר (מחשב אתר; db/wizenet-relay.postgres.sql) מתוך ה-API שלהם. closed — מה נחשב סגור; ראו
-- app.wizenet_lookups_store.
CREATE TABLE IF NOT EXISTS wizenet_lookups (
  kind        text NOT NULL,
  id          text NOT NULL,
  name        text NOT NULL,
  closed      boolean NOT NULL DEFAULT false,
  updated_at  text NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  PRIMARY KEY (kind, id),
  CONSTRAINT wizenet_lookups_kind CHECK (kind IN ('status', 'type'))
);

-- ============================================================
-- שינויים שנעשו מהדשבורד — מי, מתי, מה
-- ============================================================
-- ⚠️ נרשם **רק אחרי** שוויזנט אישרו (app.wizenet_complete, מהממסר): רישום לפני האישור היה מציג על המסך סטטוס
-- שאינו קיים אצלם.
CREATE TABLE IF NOT EXISTS service_call_changes (
  id               bigserial PRIMARY KEY,
  ticket           text NOT NULL,
  field            text NOT NULL,
  value            text NOT NULL,
  changed_by       text NOT NULL,
  changed_by_user  integer,
  changed_at       text NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  CONSTRAINT service_call_changes_field CHECK (field IN ('status', 'type'))
);
CREATE INDEX IF NOT EXISTS idx_service_call_changes_ticket ON service_call_changes (ticket, id DESC);

-- ⚠️ שתי הטבלאות סגורות (RLS בלי מדיניות, בלי הרשאות), כמו המשימות: כל קריאה וכתיבה דרך RPC.
DO $$
DECLARE t text; r text;
BEGIN
  FOREACH t IN ARRAY ARRAY['wizenet_lookups', 'service_call_changes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
      END IF;
    END LOOP;
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
  END LOOP;
END $$;

-- קוד הפרויקט של קריאה — המקום היחיד שמחליט איך קריאה משויכת לאתר
CREATE OR REPLACE FUNCTION app.service_call_project(p jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(NULLIF(btrim(p ->> 'project_code'), ''),
                  NULLIF(btrim(split_part(btrim(COALESCE(p ->> 'parking_code', '')), '-', 1)), ''))
$$;
REVOKE ALL ON FUNCTION app.service_call_project(jsonb) FROM PUBLIC;

-- ⚠️ `app.wizenet_ts` — ההמרה משעון ויזנט (שעון ישראל עם סיומת Z מטעה) לזמן אמיתי — מוגדרת
-- ב-service-calls.postgres.sql, שנטען לפני הקובץ הזה. הטריגר של opened_il שם זקוק לה.

-- ============================================================
-- ⚠️ כפילות: אותו אדם, אותו טקסט, באותו רגע — קריאה אחת על המסך (14/10/2026)
-- ============================================================
-- בעלת המוצר: "אם יש קריאה מאותו בן אדם באותו זמן עם אותו טקסט אז אל תכתבי אותה פעמיים חבל".
--
-- **נמדד בייצור באותו יום, וזה גדול:** באתר 1312 נפתחו **שמונה** קריאות נפרדות ב-16 שניות — אותו
-- טלפון, אותו שם, "המתקן לא מגיב" מילה במילה (774526 עד 774533). באתר 1376 ארבע ב-8 שניות
-- ("טכנאי"), באתר 1197 ארבע ב-18 שניות ("בירור"), ועוד ארבעה זוגות ב-2–3 שניות. ויזנט עצמם מנקים
-- את זה בדיעבד: 15 קריאות מסומנות "מבוטל בשל כפילות" ואחת "קריאה כפולה".
--
-- ⚠️ **ולמה האיחוד כאן ולא בדלת הקליטה.** היא ביקשה "אל תכתבי", והתשובה היא: כל אחת מהשמונה היא
-- **מספר קריאה נפרד אצל ויזנט** עם מחזור חיים משל עצמו, וויזנט ישלחו עליה עדכון סטטוס אחר כך. שורה
-- שלא נשמרה פירושה שהעדכון ההוא יגיע כקריאה חדשה לגמרי — ויצוץ שוב על המסך, הפעם בלי שום דרך
-- לקשור אותו לקבוצה. ועוד: הדלת מתוכננת לקבל הכול ולא לדחות דבר (ראו שם), כי הכתובת היא חוזה. לכן
-- **נשמר הכול, מוצג פעם אחת** — והאיחוד יושב במקום היחיד שמחליט מהו המצב, כך שהספירה, הרשימה של
-- האתר ו"קריאות היום" מסכימות ביניהן בלי שאיש יצטרך לזכור לסנן.
--
-- מה מגדיר "אותה קריאה": אותו קוד פרויקט, אותו אדם, אותו טקסט, ופער של עד דקה מהקריאה שלפניה.
CREATE OR REPLACE FUNCTION app.service_call_dup_gap() RETURNS interval
-- ⚠️ דקה, ולא חמש. הפער **בין קריאות עוקבות** בכל הצרורות שנמדדו הוא 2–5 שניות, כלומר פי 12 מרווח
-- ביטחון; ומכיוון שהכלל משרשר (א' עם ב', ב' עם ג'), חלון רחב היה מאחד גם פנייה חוזרת אמיתית של
-- אדם שאיש לא חזר אליו. שתי פניות בהפרש שתי דקות הן שתי פניות.
LANGUAGE sql IMMUTABLE AS $$ SELECT interval '60 seconds' $$;
REVOKE ALL ON FUNCTION app.service_call_dup_gap() FROM PUBLIC;

-- ============================================================
-- המצב הנוכחי של כל קריאה
-- ============================================================
-- שורה לכל ticket_number: השורה האחרונה שהגיעה מוויזנט, והשינוי האחרון שלנו בכל שדה — אם הוא חדש יותר
-- ממנה. open — לפי הרשימה (ראו בראש הקובץ). ואחרי זה: כפילויות מאוחדות לשורה אחת, עם dup_n.
-- ⚠️ שינוי טיפוס ההחזרה (נוספה dup_n) אינו אפשרי ב-CREATE OR REPLACE — חייבים DROP קודם.
DROP FUNCTION IF EXISTS app.service_calls_current();
CREATE OR REPLACE FUNCTION app.service_calls_current()
RETURNS TABLE (ticket text, site_id integer, site_code text, project text, payload jsonb, received_at text,
               status_id text, type_id text, open boolean, changed_by text, changed_at text, dup_n integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
  WITH last_in AS (
    SELECT DISTINCT ON (btrim(c.payload ->> 'ticket_number'))
           btrim(c.payload ->> 'ticket_number') AS ticket, c.payload, c.received_at
      FROM service_calls c
     WHERE c.payload IS NOT NULL AND NULLIF(btrim(c.payload ->> 'ticket_number'), '') IS NOT NULL
     ORDER BY btrim(c.payload ->> 'ticket_number'), c.id DESC
  ),
  -- ============================================================
  -- ⚠️ השורה ה**ראשונה** של כל קריאה — ממנה נבנה מפתח הכפילות
  -- ============================================================
  -- נמדד בייצור (14/10/2026): **48 מתוך 76** הקריאות שינו את הטקסט שלהן בין השורה הראשונה
  -- לאחרונה — לא בתוכן אלא בקידוד. ויזנט שולחים את אותה הערה פעם כ-`<br>`, פעם כ-`<br />` עם
  -- שורה חדשה, ופעם מוברחת לגמרי כ-`&lt;br /&gt;`. צרור "טכנאי" באתר 1376 אוחד ל-3 במקום ל-4
  -- בדיוק מזה: לקריאה אחת מהארבע הגיעה גרסה מוברחת בשורה האחרונה.
  -- ⚠️ וניקוי טקסט לא היה מציל: אחרי שמסירים תגיות, `&lt;br /&gt;` מפוענח ל-`<br />` כטקסט
  -- מילולי — ונשאר שונה. מה שכן פותר הוא להשוות את מה שהיה **ברגע הפתיחה**, וזה גם הנכון
  -- עניינית: הכפילות היא עובדה על הפתיחה, לא על מה שהמוקד הוסיף אחר כך.
  first_in AS (
    SELECT DISTINCT ON (btrim(c.payload ->> 'ticket_number'))
           btrim(c.payload ->> 'ticket_number') AS ticket, c.payload AS payload0
      FROM service_calls c
     WHERE c.payload IS NOT NULL AND NULLIF(btrim(c.payload ->> 'ticket_number'), '') IS NOT NULL
     ORDER BY btrim(c.payload ->> 'ticket_number'), c.id        -- ASC — להבדיל מ-last_in
  ),
  last_ch AS (
    SELECT DISTINCT ON (ch.ticket, ch.field) ch.ticket, ch.field, ch.value, ch.changed_by, ch.changed_at
      FROM service_call_changes ch
     ORDER BY ch.ticket, ch.field, ch.id DESC
  ),
  cur AS (
    SELECT l.ticket, l.payload, l.received_at, app.service_call_project(l.payload) AS project,
           CASE WHEN st.changed_at > l.received_at THEN st.value ELSE NULLIF(btrim(l.payload ->> 'status'), '') END AS status_id,
           CASE WHEN ty.changed_at > l.received_at THEN ty.value ELSE NULLIF(btrim(l.payload ->> 'ticket_type'), '') END AS type_id,
           CASE WHEN GREATEST(COALESCE(st.changed_at, ''), COALESCE(ty.changed_at, '')) > l.received_at
                THEN CASE WHEN COALESCE(st.changed_at, '') >= COALESCE(ty.changed_at, '') THEN st.changed_by ELSE ty.changed_by END END AS changed_by,
           CASE WHEN GREATEST(COALESCE(st.changed_at, ''), COALESCE(ty.changed_at, '')) > l.received_at
                THEN GREATEST(COALESCE(st.changed_at, ''), COALESCE(ty.changed_at, '')) END AS changed_at
      FROM last_in l
      LEFT JOIN last_ch st ON st.ticket = l.ticket AND st.field = 'status'
      LEFT JOIN last_ch ty ON ty.ticket = l.ticket AND ty.field = 'type'
  ),
  flat AS (
    SELECT c.ticket, s.id AS site_id, s.code AS site_code, c.project, c.payload, c.received_at,
           c.status_id, c.type_id,
           NOT COALESCE((SELECT w.closed FROM wizenet_lookups w WHERE w.kind = 'status' AND w.id = c.status_id), false) AS open,
           c.changed_by, c.changed_at,
           COALESCE(app.wizenet_ts(COALESCE(f0.payload0 ->> 'opened_at', c.payload ->> 'opened_at')),
                    c.received_at::timestamptz) AS opened,
           f0.payload0
      FROM cur c
      LEFT JOIN sites s ON s.code = c.project
      JOIN first_in f0 ON f0.ticket = c.ticket
  ),
  -- ============================================================
  -- מפתח הקבוצה — **במקום אחד**
  -- ============================================================
  -- ⚠️ שלוש חלונות־פונקציה למטה חייבים לחלק לפי אותו דבר בדיוק. בגרסה הראשונה המפתח היה כתוב
  -- שלוש פעמים, ומוטציה שהסירה את האתר מאחד מהם **שרדה** את כל הבדיקות — כי השניים האחרים עוד
  -- חילקו נכון. כלומר הכפילות לא רק מכוערת: היא מסתירה שגיאה. עכשיו הוא נבנה פעם אחת.
  -- התו \x01 כמפריד, כדי ששדה לא יוכל להתחזות לגבול בין שדות.
  keyed AS (
    SELECT f.*,
           COALESCE(f.project, '~')
           -- מי: הטלפון בספרות בלבד ("052-000-0002" ו-"0520000002" הם אותו אדם); ובלי טלפון — השם.
           -- ⚠️ בלי שניהם נשאר '' — כלומר שתי פניות אנונימיות עם אותו טקסט באותו רגע **כן** מתאחדות.
           -- זו אותה תקלה אחת, וזה מה שנשאל.
           || E'\x01' || CASE
                WHEN regexp_replace(COALESCE(f.payload0 ->> 'phone', ''), '\D', '', 'g') <> ''
                  THEN 'p:' || regexp_replace(COALESCE(f.payload0 ->> 'phone', ''), '\D', '', 'g')
                ELSE 'n:' || lower(btrim(COALESCE(f.payload0 ->> 'first_name', '') || ' ' || COALESCE(f.payload0 ->> 'last_name', '')))
              END
           -- מה: התלונה וההערות. ⚠️ וכאן **ההגנה היחידה**: בלי טקסט בכלל אין במה להשוות, ולכן
           -- הקריאה היא קבוצה של עצמה. בלעדיה, שתי קריאות ריקות של אותו מתקשר באותה שנייה היו
           -- מתאחדות רק מפני ששתיהן ריקות — ומוקד שמתקשר בלי טקסט היה מאבד קריאות.
           || E'\x01' || CASE
                WHEN btrim(regexp_replace(COALESCE(f.payload0 ->> 'customer_complaint', '') || ' ' || COALESCE(f.payload0 ->> 'notes', ''), '\s+', ' ', 'g')) <> ''
                  -- ⚠️ רווחים מנורמלים (כולל שורות חדשות): "א  ב\n" ו-"א ב" הם אותו טקסט. זה **לא**
                  -- ניקוי HTML — ההשוואה היא על השורה הראשונה, ששם הקידוד זהה ממילא.
                  -- ⚠️ והנרמול **לפני** הקיצוץ: `btrim` בפוסטגרס מקצץ רווחים בלבד, לא שורות חדשות
                  -- ולא טאבים. בסדר ההפוך "\n" בסוף ההערה שרד את הקיצוץ, הפך לרווח נגרר, והקריאה
                  -- לא התאחדה עם זהה לה. נתפס בבדיקה.
                  THEN btrim(regexp_replace(COALESCE(f.payload0 ->> 'customer_complaint', '') || ' ' || COALESCE(f.payload0 ->> 'notes', ''), '\s+', ' ', 'g'))
                ELSE 'ticket:' || f.ticket
              END AS gkey
      FROM flat f
  ),
  -- קבוצה חדשה מתחילה כשהפער מהקריאה שלפניה גדול מהחלון (או שאין קריאה לפניה)
  gapped AS (
    SELECT k.*,
           CASE WHEN k.opened - lag(k.opened) OVER (PARTITION BY k.gkey ORDER BY k.opened, k.ticket)
                     <= app.service_call_dup_gap() THEN 0 ELSE 1 END AS newgrp
      FROM keyed k
  ),
  grouped AS (
    SELECT g.*, sum(g.newgrp) OVER (PARTITION BY g.gkey ORDER BY g.opened, g.ticket) AS grp
      FROM gapped g
  ),
  ranked AS (
    -- ⚠️ `open DESC` ראשון בסדר הבחירה: הנציגה היא הפתוחה הוותיקה, ולכן המצב המוצג (status_id)
    -- תמיד שייך לקריאה פתוחה כשהקבוצה פתוחה. בלי זה סגירה של הוותיקה מכבה את ההבהוב בעוד אחרת
    -- פתוחה.
    -- ⚠️ `bool_or` **עודף בכוונה** ביחס לסדר הזה (הנציגה כבר פתוחה אם מישהי פתוחה), ולכן מוטציה
    -- שמחליפה אותו ב-`g.open` שקולה ואינה נתפסת. הוא נשאר כי הוא **אומר את הכלל** — "קבוצה
    -- פתוחה אם אחת מהן פתוחה" — ולא משאיר אותו תלוי בסדר של ORDER BY רחוק.
    SELECT g.*,
           count(*)        OVER p AS n,
           bool_or(g.open) OVER p AS any_open,
           row_number()    OVER (PARTITION BY g.gkey, g.grp ORDER BY g.open DESC, g.opened, g.ticket) AS rn
      FROM grouped g
    WINDOW p AS (PARTITION BY g.gkey, g.grp)
  )
  SELECT r.ticket, r.site_id, r.site_code, r.project, r.payload, r.received_at,
         r.status_id, r.type_id, r.any_open, r.changed_by, r.changed_at, r.n::int
    FROM ranked r
   WHERE r.rn = 1
$$;
REVOKE ALL ON FUNCTION app.service_calls_current() FROM PUBLIC;

-- ============================================================
-- "24 השעות האחרונות" — הגדרה אחת לכל מי שסופר (15/10/2026)
-- ============================================================
-- ⚠️ קריאה שייכת לחלון אם **הדבר האחרון שקרה לה** בתוכו: השורה האחרונה מוויזנט (received_at), או השינוי שלנו
-- מהדשבורד (changed_at) — מה שמאוחר יותר. service_calls_current מחזירה changed_at רק כשהוא מאוחר מהשורה של
-- ויזנט, ולכן COALESCE(c.changed_at, c.received_at) הוא בדיוק "האחרון". בלי השינוי שלנו, סגירה **היום** של קריאה
-- ישנה הוציאה אותה מ"קריאות היום" ומהספירה (סקירה, 15/10/2026) — ובבנייה ישנה, בלי שום הסבר.
-- ⚠️ ותחילת החלון — כאן בלבד. ארבעה סופרים לפיה: הכרטיס (service_call_counts), החלון מהכרטיס בבנייה ישנה
-- (p_hours), הרשימה של "קריאות היום" והאריח. עותק לכל אחד היה נפרד בשקט מהשאר — וזה בדיוק המקום שבו האריח
-- והרשימה שהוא פותח חייבים להסכים. ⚠️ ובשעון UTC מפורש: to_char על timestamptz כותב באזור הזמן של הסשן,
-- וה-"Z" שבתבנית היה משקר בכל סשן שאינו UTC.
CREATE OR REPLACE FUNCTION app.service_calls_since(p_hours integer)
RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT to_char((now() AT TIME ZONE 'UTC') - make_interval(hours => LEAST(GREATEST(COALESCE(p_hours, 24), 1), 168)),
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
REVOKE ALL ON FUNCTION app.service_calls_since(integer) FROM PUBLIC;

-- ============================================================
-- קריאה — מהדשבורד
-- ============================================================
-- מספר הקריאות הפתוחות לכל אתר — לסימון על הכרטיס. ⚠️ לעולם אינה זורקת (כמו task_counts): הסימון נטען יחד
-- עם רשימת האתרים, ושגיאה כאן לא תפיל אותה. מי שאינו צוות — אפס שורות.
-- ⚠️ שתי ספירות ולא אחת (בעלת המוצר, 14/10/2026: "שזה יהיה על הכרטיס שמתאים לפי הקוד"): `open` —
-- קריאות שעדיין פתוחות, בכל גיל; `recent` — כל מה שהגיע ב-24 השעות, כולל סגורות. בלי השנייה, יום
-- שבו נפתחו ונסגרו שמונה קריאות השאיר שלושה כרטיסים מסומנים, והשאר נראו כאילו לא קרה בהם דבר.
-- ⚠️ `open` לא שינה משמעות, ו-p_hours ברירת-מחדל — בנייה ישנה שקוראת בלי ארגומנטים עדיין נפתרת
-- ומקבלת את אותה עמודה. העמודה הנוספת פשוט לא נקראת שם.
-- ⚠️ שינוי טיפוס ההחזרה (נוספה oldest_open) אינו אפשרי ב-CREATE OR REPLACE — חייבים להפיל
-- קודם את שתי החתימות הקיימות: זו שבלי ארגומנטים וזו שעם p_hours (נתפס בהחלה לייצור, 14/10).
DROP FUNCTION IF EXISTS public.service_call_counts();
DROP FUNCTION IF EXISTS public.service_call_counts(integer);
CREATE OR REPLACE FUNCTION public.service_call_counts(p_hours integer DEFAULT 24)
-- ⚠️ oldest_open — מתי נפתחה הקריאה הפתוחה **הוותיקה ביותר** של האתר, כזמן אמיתי. בעלת המוצר
-- (14/10/2026): "אני רוצה שיהיה כזה סטופר לפני כמה זמן נפתחה הפניה". הכרטיס מציג ממנו שעון
-- מתקתק, ולכן הוא חייב להיות UTC אמיתי ולא שעון הקיר של ויזנט.
-- ⚠️ נופל חזרה לשעת ההגעה אלינו כשאין opened_at: סטופר שמתחיל מאפס על נתון חסר הוא שקר.
RETURNS TABLE (site_id integer, open integer, recent integer, oldest_open text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
  WITH w AS (SELECT app.service_calls_since(p_hours) AS since)
  SELECT c.site_id,
         count(*) FILTER (WHERE c.open)::int,
         -- הדבר האחרון שקרה לקריאה — ויזנט או אנחנו (ראו app.service_calls_since)
         count(*) FILTER (WHERE COALESCE(c.changed_at, c.received_at) > w.since)::int,
         to_char(min(COALESCE(app.wizenet_ts(c.payload ->> 'opened_at'), c.received_at::timestamptz))
                   FILTER (WHERE c.open) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    FROM app.service_calls_current() c, w
   WHERE c.site_id IS NOT NULL AND (SELECT app.is_staff())
     AND (c.open OR COALESCE(c.changed_at, c.received_at) > w.since)
   GROUP BY c.site_id
$$;
REVOKE ALL ON FUNCTION public.service_call_counts(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.service_call_counts(integer) TO authenticated;

-- ============================================================
-- הקריאות של אתר — הבונה היחיד (15/10/2026)
-- ============================================================
-- בעלת המוצר: "כשלוחצים על כרטיס כדי לראות את הקריאות — יראו רק קריאות פתוחות, ויהיה כפתור 'להיסטוריה',
-- וכשלוחצים עליו רואים את הקריאות הקודמות שכבר נסגרו". שתי רשימות, ושורה אחת לכל קריאה באותה צורה בדיוק —
-- ⚠️ ולכן בונה אחד: עותק שני של 18 השדות היה נפרד בשקט מהראשון (שדה שנוסף לאחד ולא לשני — הוא מוצג רק
-- בפתוחות, או רק בהיסטוריה). שתי הפונקציות הציבוריות למטה הן עטיפות דקות.
--   p_history = false: פתוחות (בכל גיל), ועם p_hours — גם מה שנסגר בחלון הזה. פתוחות קודם, הישנה למעלה.
--   p_history = true:  הסגורות בלבד, החדשה למעלה (לפי מועד הפתיחה — "הקריאות הקודמות").
-- מחזיר { calls: [...], total: N } — total הוא כמה יש בכלל, לפני p_limit.
-- ⚠️ הסדר — לפי **הרגע האמיתי** של הפתיחה (opened_ts, אותו ביטוי כמו opened_utc לסטופר), ולא לפי הטקסט: opened_at
-- הוא שעון הקיר של ויזנט עם Z מטעה (שלוש שעות קדימה בקיץ), ו-received_at — UTC אמיתי. השוואת שני הטקסטים שמה קריאה
-- בלי opened_at במקום הלא נכון, וגם החליטה מי נכנסת למאה (סקירה, 15/10/2026).
CREATE OR REPLACE FUNCTION app.service_calls_site(p_site_code text, p_hours integer, p_history boolean, p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_since text := CASE WHEN p_hours IS NULL THEN NULL ELSE app.service_calls_since(p_hours) END;
  v_site text := btrim(COALESCE(p_site_code, ''));
BEGIN
  RETURN (
    WITH pick AS (
      SELECT c.*, COALESCE(app.wizenet_ts(c.payload ->> 'opened_at'), c.received_at::timestamptz) AS opened_ts
        FROM app.service_calls_current() c
       WHERE c.site_code = v_site
         AND CASE WHEN p_history THEN NOT c.open
                  ELSE c.open OR (v_since IS NOT NULL AND COALESCE(c.changed_at, c.received_at) > v_since) END
    ), ranked AS (
      SELECT k.*, row_number() OVER (ORDER BY
               -- פתוחות: מה שעוד דורש טיפול בראש הרשימה, ובתוכן הישנה למעלה
               CASE WHEN p_history THEN NULL ELSE NOT k.open END,
               CASE WHEN p_history THEN NULL ELSE k.opened_ts END,
               CASE WHEN p_history THEN NULL ELSE k.ticket END,
               -- היסטוריה: החדשה למעלה
               CASE WHEN p_history THEN k.opened_ts END DESC,
               CASE WHEN p_history THEN k.ticket END DESC) AS rn
        FROM pick k
    )
    SELECT jsonb_build_object(
      'total', (SELECT count(*)::int FROM pick),
      'calls', COALESCE(jsonb_agg(jsonb_build_object(
             'ticket', r.ticket,
             'opened_at', NULLIF(btrim(r.payload ->> 'opened_at'), ''),
             -- ⚠️ זמן אמיתי לסטופר. opened_at עצמו הוא שעון הקיר שלהם ואי אפשר לחשב ממנו משך.
             'opened_utc', to_char(r.opened_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
             'received_at', r.received_at,
             'parking_code', NULLIF(btrim(r.payload ->> 'parking_code'), ''),
             'first_name', r.payload ->> 'first_name',
             'last_name', r.payload ->> 'last_name',
             'phone', r.payload ->> 'phone',
             'complaint', r.payload ->> 'customer_complaint',
             'notes', r.payload ->> 'notes',
             'open', r.open,
             'status_id', r.status_id,
             'status_name', (SELECT w.name FROM wizenet_lookups w WHERE w.kind = 'status' AND w.id = r.status_id),
             'type_id', r.type_id,
             'type_name', (SELECT w.name FROM wizenet_lookups w WHERE w.kind = 'type' AND w.id = r.type_id),
             'changed_by', r.changed_by,
             'changed_at', r.changed_at,
             -- כמה קריאות זהות אוחדו לשורה הזו (1 = אין כפילות)
             'dup_n', r.dup_n) ORDER BY r.rn), '[]'::jsonb))
      FROM ranked r
     WHERE p_limit IS NULL OR r.rn <= p_limit
  );
END $fn$;
REVOKE ALL ON FUNCTION app.service_calls_site(text, integer, boolean, integer) FROM PUBLIC;

-- הקריאות הפתוחות של אתר, מהישנה לחדשה. ⚠️ jsonb יחיד (PostgREST חותך ב-1,000 שורות).
-- ⚠️ p_hours (14/10/2026): כשניתן — גם מה שנסגר בחלון הזה. בלי הפרמטר: פתוחות בלבד — וזה מה שהחלון מהכרטיס מבקש
-- מ-15/10 ("יראו רק קריאות פתוחות"). הפרמטר נשאר בשביל בנייה ישנה של הדשבורד (מסך קיר, PWA) שעוד שולחת אותו.
DROP FUNCTION IF EXISTS public.service_calls_open(text);
CREATE OR REPLACE FUNCTION public.service_calls_open(p_site_code text, p_hours integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
BEGIN
  PERFORM app.require_staff();
  RETURN app.service_calls_site(p_site_code, p_hours, false, NULL) -> 'calls';
END $fn$;
REVOKE ALL ON FUNCTION public.service_calls_open(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.service_calls_open(text, integer) TO authenticated;

-- "להיסטוריה" (15/10/2026): הקריאות של אתר שכבר נסגרו, החדשה למעלה. { calls, total }.
-- ⚠️ תקרה (100, ולכל היותר 500): הקריאות נצברות בלי רטנציה עדיין, ורשימה בלי גבול היא jsonb שגדל לנצח בכל
-- פתיחה. total — כמה יש בכלל, כדי שהחלון יאמר "מוצגות 100 האחרונות מתוך N" ולא יעלים את השאר בשקט.
CREATE OR REPLACE FUNCTION public.service_calls_history(p_site_code text, p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
BEGIN
  PERFORM app.require_staff();
  RETURN app.service_calls_site(p_site_code, NULL, true, LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500));
END $fn$;
REVOKE ALL ON FUNCTION public.service_calls_history(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.service_calls_history(text, integer) TO authenticated;

-- ============================================================
-- "קריאות היום" — כל הקריאות מה-24 שעות האחרונות (14/10/2026)
-- ============================================================
-- ⚠️ בעלת המוצר, אחרי שהתכונה עלתה: "לא רואים כלום". וזה היה נכון — מדדנו 22 קריאות ביום הראשון,
-- מהן 18 כבר סגורות ו-3 לקודים שאין להם אתר אצלנו, ולכן הופיעה **גלולה אחת** על כרטיס אחד מ-78.
-- הסימון על הכרטיס עונה על "מה פתוח עכשיו"; זה עונה על "מה קרה היום" — כולל סגורות, וכולל קודים
-- שאין להם אתר, שאחרת אינם נראים בשום מקום (רבע מהקריאות ביום הראשון).
-- ⚠️ jsonb יחיד, כמו service_calls_open: PostgREST חותך ב-1,000 שורות.
-- ⚠️ הטווח מוגבל ל-168 שעות: זו פונקציה שרצה מהכותרת, ולא דלת לכל ההיסטוריה.
-- ⚠️ 15/10/2026 — שתי קבוצות ברשימה אחת: מה שקרה בחלון (in_window = true — זה "קריאות היום", ורק זה נספר כך),
-- ועוד כל קריאה **פתוחה** בכל גיל (in_window = false), כי האריח אומר גם "כמה פתוחות" ומי שלוחץ צריך לראות אותן.
-- ⚠️ הגרסה הראשונה צירפה את הפתוחות הישנות גם **לספירה** של היום (סקירה, 15/10/2026): בבוקר שקט האריח היה
-- אומר "2 קריאות היום" על שתי קריאות מלפני שבוע — ו-TEST-001 (סטטוס לא מוכר, ולכן "פתוחה") הייתה "של היום" לנצח.
CREATE OR REPLACE FUNCTION public.service_calls_recent(p_hours integer DEFAULT 24)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE v_since text := app.service_calls_since(p_hours);
BEGIN
  PERFORM app.require_staff();
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'ticket', c.ticket,
             'opened_at', NULLIF(btrim(c.payload ->> 'opened_at'), ''),
             -- ⚠️ זמן אמיתי לסטופר. opened_at עצמו הוא שעון הקיר שלהם ואי אפשר לחשב ממנו משך.
             'opened_utc', to_char(COALESCE(app.wizenet_ts(c.payload ->> 'opened_at'), c.received_at::timestamptz)
                                     AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
             'received_at', c.received_at,
             'parking_code', NULLIF(btrim(c.payload ->> 'parking_code'), ''),
             'project', c.project,
             'site_code', c.site_code,
             'site_name', (SELECT s.site_name FROM sites s WHERE s.id = c.site_id),
             'first_name', c.payload ->> 'first_name',
             'last_name', c.payload ->> 'last_name',
             'phone', c.payload ->> 'phone',
             'complaint', c.payload ->> 'customer_complaint',
             'notes', c.payload ->> 'notes',
             'open', c.open,
             'status_id', c.status_id,
             'status_name', (SELECT w.name FROM wizenet_lookups w WHERE w.kind = 'status' AND w.id = c.status_id),
             'type_id', c.type_id,
             'type_name', (SELECT w.name FROM wizenet_lookups w WHERE w.kind = 'type' AND w.id = c.type_id),
             'changed_by', c.changed_by,
             'changed_at', c.changed_at,
             -- כמה קריאות זהות אוחדו לשורה הזו (1 = אין כפילות)
             'dup_n', c.dup_n,
             -- בחלון ("היום"), או כאן רק כי היא פתוחה (ראו למעלה)
             'in_window', COALESCE(c.changed_at, c.received_at) > v_since)
           -- החדשה למעלה: מי שפותח את הרשימה שואל "מה קרה עכשיו" — גם שינוי שלנו הוא "עכשיו"
           ORDER BY COALESCE(c.changed_at, c.received_at) DESC, c.ticket DESC)
      FROM app.service_calls_current() c
     -- ⚠️ ועוד כל קריאה פתוחה, בכל גיל: האריח אומר "כמה פתוחות", והרשימה שנפתחת ממנו חייבת להראות את אותן
     -- קריאות. נמדד ב-15/10: 14 פתוחות, ואחת מהן לא עודכנה ביממה — בלי זה היא לא הייתה כאן.
     WHERE COALESCE(c.changed_at, c.received_at) > v_since
        OR c.open
  ), '[]'::jsonb);
END $fn$;
REVOKE ALL ON FUNCTION public.service_calls_recent(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.service_calls_recent(integer) TO authenticated;

-- "קריאות היום" על האריח בכותרת (15/10/2026 — בעלת המוצר: "שיהיה כתוב כמה פתוחות"). { total, open }:
--   total — מה שקרה בחלון, **כמו שהיה** מ-14/10: "קריאות היום" ממשיך לספור את היום, ולא את כל מה שעוד פתוח.
--   open  — כל הפתוחות עכשיו, בכל גיל: "כמה דורשות טיפול". יכול להיות גדול מ-total (בוקר שקט, פתוחות מאתמול).
-- ⚠️ שתי הספירות על אותן שורות ובאותו תנאי כמו service_calls_recent (in_window / open), כדי שהמספרים על האריח
-- והרשימה שהוא פותח לא ייפרדו. ⚠️ אינה זורקת (מי שאינו צוות מקבל אפסים), כמו service_calls_recent_count.
CREATE OR REPLACE FUNCTION app.service_calls_recent_summary_raw(p_hours integer)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
  SELECT jsonb_build_object(
           'total', (count(*) FILTER (WHERE COALESCE(c.changed_at, c.received_at) > w.since))::int,
           'open', (count(*) FILTER (WHERE c.open))::int)
    FROM app.service_calls_current() c, (SELECT app.service_calls_since(p_hours) AS since) w
   WHERE (SELECT app.is_staff())
$$;
REVOKE ALL ON FUNCTION app.service_calls_recent_summary_raw(integer) FROM PUBLIC;

-- ============================================================
-- service_calls_board — הכרטיסים והכותרת בקריאה אחת (18/10/2026)
-- ============================================================
-- נמדד 18/10: 29 מסכים פתוחים, וכל אירוע קריאה הריץ בכל אחד **שתי** קריאות — service_call_counts ו-
-- service_calls_recent_summary — שכל אחת מהן מחשבת את app.service_calls_current() מחדש (~55 אלפיות). 56% מזמן
-- המסד בחלון של 10 דקות. כאן: המצב מחושב **פעם אחת** (CTE מוגשם), ושני החלקים נגזרים ממנו; הדשבורד קורא לזה
-- במקום לשתיים. ⚠️ אותן הגדרות בדיוק כמו בשתי הפונקציות הישנות (S16 משווה שורה-לשורה) — הן נשארות לבנייה ישנה
-- של הדשבורד (מסך קיר שלא נטען מחדש). ⚠️ אינה זורקת: מי שאינו צוות מקבל לוח ריק, כמו הספירה.
-- ============================================================
-- החמרה של קריאה פתוחה שלא טופלה (19/10/2026)
-- ============================================================
-- בעלת המוצר: "כשיש קריאה ככל שעובר זמן והיא לא טופלה המצב מחמיר… אתרים מכפילים כל 24 שעות… צבע הכרטיס מתחיל מלבן
-- ולאט לאט מחמיר בצבעי הרמזור עד שיכול להגיע לשחור. כך גם לגבי רובוטיים אבל כל שעה… זמן שלא בשעות השירות לא
-- מחושב… בהתאם לסוג השירות של כל אתר". ההחלטות שלה: 0 לבן · 1 צהוב · 2 כתום · 3 אדום · 4 אדום כהה ("שלא יגיע לשחור אלא הכי גרוע זה אדום כהה"); מכפיל = שלב לכל
-- **24 שעות שירות** (לא לכל יום שירות — בבסיסי זה שלב כל ~2.7 ימי עבודה); אתר בלי שעות שירות ("לא בשירות", "אין",
-- "תחזוקה בלבד", לא חובר לרמזור) — לא מחמיר, נשאר לבן; הצבע מוצג רק כש"קריאות פתוחות" לחוץ (הדשבורד).
--   • "לא טופלה" = עדיין פתוחה (הסטטוס שלה אינו מסומן סגור — אותה הגדרה כמו בכל מקום), והוותיקה באתר קובעת.
--   • סוג השירות — מה שהכרטיס מציג: COALESCE(agreement, plan) מ-site_service_links, שבו למכפיל גובר לוח המכפילים.
--   • "רובוטי" = אתר עם בקר (monitored), "מכפיל" = בלי בקר (גם סוטפין), כמו אריח "מכפילים גלויים".

-- שניות שירות בין שני רגעים לפי סוג השירות (basic/ext/vip), בשעון ישראל. סוג אחר או NULL — 0 (אין חלונות).
CREATE OR REPLACE FUNCTION app.service_seconds(p_kind text, p_from timestamptz, p_to timestamptz)
RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(sum(EXTRACT(EPOCH FROM w.ends_at - w.starts_at)), 0)
    FROM app.service_windows(p_kind, p_from, p_to) w
   WHERE p_from < p_to
$$;
REVOKE ALL ON FUNCTION app.service_seconds(text, timestamptz, timestamptz) FROM PUBLIC;

-- השלב: 0..4. רובוטי — שלב לכל שעת שירות; מכפיל — לכל 24 שעות שירות. טהורה.
CREATE OR REPLACE FUNCTION app.call_age_level(p_service_secs numeric, p_monitored boolean)
RETURNS integer
LANGUAGE sql IMMUTABLE AS $$
  SELECT LEAST(4, floor(GREATEST(COALESCE(p_service_secs, 0), 0)
                        / CASE WHEN p_monitored IS FALSE THEN 86400 ELSE 3600 END))::int
$$;
REVOKE ALL ON FUNCTION app.call_age_level(numeric, boolean) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.service_calls_board(p_hours integer DEFAULT 24)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
  WITH w AS (SELECT app.service_calls_since(p_hours) AS since),
  cur AS MATERIALIZED (
    SELECT c.* FROM app.service_calls_current() c WHERE (SELECT app.is_staff())
  ),
  sites AS (
    SELECT c.site_id,
           count(*) FILTER (WHERE c.open)::int AS open,
           count(*) FILTER (WHERE COALESCE(c.changed_at, c.received_at) > w.since)::int AS recent,
           min(COALESCE(app.wizenet_ts(c.payload ->> 'opened_at'), c.received_at::timestamptz))
             FILTER (WHERE c.open) AS oldest_ts
      FROM cur c, w
     WHERE c.site_id IS NOT NULL
       AND (c.open OR COALESCE(c.changed_at, c.received_at) > w.since)
     GROUP BY c.site_id
  ),
  -- סוג השירות רק לאתרים עם קריאה פתוחה (site_service_links סורקת את שני הלוחות)
  kinds AS MATERIALIZED (
    SELECT l.site_id, COALESCE(l.agreement, l.plan) AS kind
      FROM public.site_service_links() l
     WHERE EXISTS (SELECT 1 FROM sites s WHERE s.site_id = l.site_id AND s.oldest_ts IS NOT NULL)
  ),
  aged AS (
    SELECT s.*,
           to_char(s.oldest_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS oldest_open,
           CASE WHEN s.oldest_ts IS NULL THEN 0
                ELSE app.service_seconds(k.kind, s.oldest_ts, now()) END AS secs,
           st.monitored
      FROM sites s
      JOIN public.sites st ON st.id = s.site_id
      LEFT JOIN kinds k ON k.site_id = s.site_id
  )
  SELECT jsonb_build_object(
    -- ⚠️ age / age_hours נוספו (19/10/2026); site_id/open/recent/oldest_open — בדיוק כמו service_call_counts (S16)
    'sites', COALESCE((SELECT jsonb_agg(jsonb_build_object('site_id', a.site_id, 'open', a.open, 'recent', a.recent, 'oldest_open', a.oldest_open,
                                                           'age', app.call_age_level(a.secs, a.monitored),
                                                           'age_hours', round(a.secs / 3600, 1))
                                        ORDER BY a.site_id) FROM aged a), '[]'::jsonb),
    'summary', (SELECT jsonb_build_object(
                  'total', (count(*) FILTER (WHERE COALESCE(c.changed_at, c.received_at) > w.since))::int,
                  'open',  (count(*) FILTER (WHERE c.open))::int)
                  FROM cur c, w))
$$;
REVOKE ALL ON FUNCTION public.service_calls_board(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.service_calls_board(integer) TO authenticated;

-- כמה קריאות היו ב-24 השעות — למספר על הכפתור בכותרת. ⚠️ אינה זורקת, כמו service_call_counts:
-- היא נטענת עם הלוח, וכשל כאן לא יפיל אותו.
-- ⚠️ 15/10/2026: נשארת בשביל בנייה ישנה של הדשבורד. החדשה קוראת ל-service_calls_recent_summary (גם "כמה פתוחות").
-- אותו total בדיוק — מה שקרה בחלון — ולכן המספר במסך ישן לא שינה משמעות.
CREATE OR REPLACE FUNCTION public.service_calls_recent_count(p_hours integer DEFAULT 24)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
  SELECT (app.service_calls_recent_summary_raw(p_hours) ->> 'total')::int
$$;
REVOKE ALL ON FUNCTION public.service_calls_recent_count(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.service_calls_recent_count(integer) TO authenticated;

-- האריח "קריאות היום": { total, open } (ראו service_calls_recent_summary_raw למעלה)
CREATE OR REPLACE FUNCTION public.service_calls_recent_summary(p_hours integer DEFAULT 24)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
  SELECT app.service_calls_recent_summary_raw(p_hours)
$$;
REVOKE ALL ON FUNCTION public.service_calls_recent_summary(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.service_calls_recent_summary(integer) TO authenticated;

-- הרשימות — לבוררים בחלון
CREATE OR REPLACE FUNCTION public.wizenet_lookups_list()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
BEGIN
  PERFORM app.require_staff();
  RETURN jsonb_build_object(
    'status', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'closed', w.closed) ORDER BY w.name)
                          FROM wizenet_lookups w WHERE w.kind = 'status'), '[]'::jsonb),
    'type',   COALESCE((SELECT jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name) ORDER BY w.name)
                          FROM wizenet_lookups w WHERE w.kind = 'type'), '[]'::jsonb));
END $fn$;
REVOKE ALL ON FUNCTION public.wizenet_lookups_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wizenet_lookups_list() TO authenticated;

-- ============================================================
-- כתיבה — רק מהממסר, אחרי שוויזנט ענו (db/wizenet-relay.postgres.sql)
-- ============================================================
-- ⚠️ 15/10/2026: שתי הפונקציות כאן היו ציבוריות (public.wizenet_lookups_save, public.service_call_record_change),
-- כי פונקציית ה-Edge קראה להן בזהות הלוחץ. המשמעות: כל איש צוות יכול היה לרשום מהדפדפן "שינוי שוויזנט אישרו"
-- בלי שאיש פנה לוויזנט — המסך היה מציג סטטוס שאינו קיים אצלם. עכשיו השינוי עובר דרך מחשב אתר (ממסר), ורק
-- app.wizenet_complete קוראת לפונקציות האלה — אחרי שהממסר החזיר את התשובה של ויזנט. אין להן הרשאה לאיש.
DROP FUNCTION IF EXISTS public.wizenet_lookups_save(text, jsonb);
DROP FUNCTION IF EXISTS public.service_call_record_change(text, text, text);

-- שמירת רשימה שנשלפה מוויזנט: [{ "id": "...", "name": "..." }, ...]. מעדכנת שמות ומוסיפה חדשים; ⚠️ closed
-- של שורה קיימת **אינו נדרס** — מי שסימן "סגורה" ביד לא יאבד את זה בטעינה הבאה. בשורה חדשה — ניחוש לפי השם
-- (סגור / בוטל / הסתיים / טופל), שאותו בודקים בעין לפני שמדליקים את התכונה.
CREATE OR REPLACE FUNCTION app.wizenet_lookups_store(p_kind text, p_items jsonb, p_actor text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := COALESCE(NULLIF(btrim(p_actor), ''), 'מערכת');
  v_n integer;
BEGIN
  IF p_kind NOT IN ('status', 'type') THEN
    RAISE EXCEPTION 'סוג רשימה לא מוכר: %', p_kind USING ERRCODE = 'check_violation';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'רשימה לא תקינה' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO wizenet_lookups AS w (kind, id, name, closed)
  SELECT p_kind, btrim(e ->> 'id'), btrim(e ->> 'name'),
         p_kind = 'status' AND btrim(e ->> 'name') ~ '(סגור|נסגר|בוטל|הסתיים|טופל|הושלם)'
    FROM jsonb_array_elements(p_items) e
   WHERE NULLIF(btrim(e ->> 'id'), '') IS NOT NULL AND NULLIF(btrim(e ->> 'name'), '') IS NOT NULL
  ON CONFLICT (kind, id) DO UPDATE SET name = EXCLUDED.name,
    updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM app.record_write_audit('wizenet.lookups', v_actor, app.current_app_role(), 'wizenet', p_kind,
    jsonb_build_object('count', v_n));
  RETURN v_n;
END $fn$;
REVOKE ALL ON FUNCTION app.wizenet_lookups_store(text, jsonb, text) FROM PUBLIC;

-- רישום שינוי שוויזנט כבר אישר. ⚠️ ערך חייב להיות ברשימה, כשיש רשימה — ערך שאינו שם היה נשמר ומוצג
-- כמספר; כשאין רשימה בכלל (לפני הטעינה הראשונה) — נבדק אצל ויזנט בלבד ("not found").
-- ⚠️ השם והמשתמש — של מי **שלחץ**, ולא של הממסר שקורא לפונקציה: "שונה מהדשבורד ע״י" מציג אותם, והממסר
-- הוא רק הדרך. הם נלקחו מהזהות המאומתת ברגע הבקשה (wizenet_requests.requested_by).
CREATE OR REPLACE FUNCTION app.service_call_store_change(p_ticket text, p_field text, p_value text,
                                                         p_actor text, p_actor_user integer)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := COALESCE(NULLIF(btrim(p_actor), ''), 'מערכת');
  v_ticket text := NULLIF(btrim(COALESCE(p_ticket, '')), '');
  v_value text := NULLIF(btrim(COALESCE(p_value, '')), '');
  v_site text;
  v_now text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF p_field NOT IN ('status', 'type') THEN
    RAISE EXCEPTION 'שדה לא מוכר: %', p_field USING ERRCODE = 'check_violation';
  END IF;
  IF v_ticket IS NULL OR v_value IS NULL THEN
    RAISE EXCEPTION 'חסר מספר קריאה או ערך' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM wizenet_lookups w WHERE w.kind = p_field)
     AND NOT EXISTS (SELECT 1 FROM wizenet_lookups w WHERE w.kind = p_field AND w.id = v_value) THEN
    RAISE EXCEPTION 'ערך לא מוכר: %', v_value USING ERRCODE = 'check_violation';
  END IF;
  SELECT c.site_code INTO v_site FROM app.service_calls_current() c WHERE c.ticket = v_ticket;
  IF NOT FOUND THEN RAISE EXCEPTION 'הקריאה לא נמצאה' USING ERRCODE = 'PT404'; END IF;
  INSERT INTO service_call_changes (ticket, field, value, changed_by, changed_by_user, changed_at)
  VALUES (v_ticket, p_field, v_value, v_actor, p_actor_user, v_now);
  -- ⚠️ התפקיד — של מי שלחץ (מהטבלה), לא של הממסר: שורת ביקורת "בקר שינה סטטוס" ולא "סוכן שינה סטטוס"
  PERFORM app.record_write_audit('service_call.' || p_field, v_actor,
    COALESCE((SELECT u.role FROM app_users u WHERE u.id = p_actor_user), 'system'), 'service_call',
    v_ticket, jsonb_build_object('value', v_value, 'via', 'relay'));
  PERFORM app.record_write_event(COALESCE(v_site, '*'), 'service_calls',
    jsonb_build_object('type', 'service_calls', 'code', v_site, 'action', p_field));
  RETURN v_now;
END $fn$;
REVOKE ALL ON FUNCTION app.service_call_store_change(text, text, text, text, integer) FROM PUBLIC;

-- ============================================================
-- קריאה שהגיעה מוויזנט — אירוע, כדי שהסימון על הכרטיס יתעדכן מיד
-- ============================================================
-- ⚠️ טריגר ולא שינוי בפונקציית הקליטה: הקליטה היא "דלת דקה" (rule 3), ומה שקורה אחרי ההכנסה שייך למסד.
-- SECURITY DEFINER: הקולט אינו רשאי לכתוב ל-events.
CREATE OR REPLACE FUNCTION app.service_calls_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE v_code text;
BEGIN
  IF NEW.payload IS NOT NULL THEN
    SELECT s.code INTO v_code FROM sites s WHERE s.code = app.service_call_project(NEW.payload);
  END IF;
  PERFORM app.record_write_event(COALESCE(v_code, '*'), 'service_calls',
    jsonb_build_object('type', 'service_calls', 'code', v_code, 'action', 'received'));
  RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION app.service_calls_event() FROM PUBLIC;

DROP TRIGGER IF EXISTS service_calls_event ON service_calls;
CREATE TRIGGER service_calls_event AFTER INSERT ON service_calls
  FOR EACH ROW EXECUTE FUNCTION app.service_calls_event();

-- ============================================================
-- גריפה: קריאה סגורה נמחקת 30 יום אחרי שנסגרה (18/10/2026)
-- ============================================================
-- בעלת המוצר, כשהוצגה לה הטבלה (15/10): "אין צורך שישמרו"; ב-18/10: "תשמור אותם רק פתוחות" → "סגורות תשמור לחודש"
-- → "אחרי שהיא נסגרת". השורות נושאות שם, טלפון ותלונה של דייר, והצטברו בלי שום מדיניות — בניגוד לכל טבלה אחרת
-- (events 7 ימים, ingest_drops 14, הניקוי השנתי 12 חודשים). נמדד 18/10/2026: 1,615 שורות, 596 קריאות, 569 מהן
-- סגורות, 3.3 MB; אף אחת לא ישנה מ-30 יום (הטבלה מ-05/10).
--
-- הכללים, ולמה כל אחד:
-- - **קריאה פתוחה נשמרת בכל גיל.** "סגורה" = הסטטוס הנוכחי מסומן closed ב-wizenet_lookups — אותו כלל של
--   service_calls_current: השורה האחרונה של הכרטיס, ומעליה שינוי סטטוס מהדשבורד אם הוא חדש ממנה. סטטוס שאינו
--   ברשימה נחשב פתוח, ולכן **לעולם אינו נמחק**: עדיף לשמור קריאה שאולי נסגרה מלמחוק פתוחה.
-- - ⚠️ **הגיל נמדד מרגע הסגירה** (הבעלת: "אחרי שהיא נסגרת"), לא מהאירוע האחרון ולא מהפתיחה: תחילת הרצף האחרון
--   של שורות ויזנט בסטטוס סגור (עדכון נוסף מוויזנט על קריאה שכבר סגורה, למשל הערה, אינו מאריך), או שינוי מהדשבורד
--   שסגר אותה כשהשורה האחרונה של ויזנט עוד פתוחה. קריאה שנפתחה מחדש ונסגרה שוב נמדדת מהסגירה האחרונה.
--   הגרסה הראשונה (אותו יום, שעות ספורות) מדדה מהאירוע האחרון; הוחלפה לפי בקשתה.
-- - **כל השורות של הכרטיס נמחקות יחד**, גם האירועים הישנים שלו, וגם service_call_changes שלו. חצי היסטוריה של
--   כרטיס אינה היסטוריה. עדכון שוויזנט ישלחו עליו אחר כך ייכנס כשורה חדשה — עם הסטטוס שלו, ואם הוא סגור הוא סגור.
-- - **שורה בלי מספר כרטיס** (גוף שאינו JSON, או בלי ticket_number) הולכת לפי גיל בלבד: אין לה "מצב".
-- - ⚠️ קבוצת כפילויות (dup_n) אינה נשקלת: חברה סגורה בקבוצה שעוד פתוחה נמחקת אחרי 30 יום, והמונה ×N יורד
--   באחד. הקבוצה עצמה נשארת כל עוד אחת מהן פתוחה.
-- ⚠️ ההשוואה היא על הטקסט ISO עם "T" (to_char), לא על (now() - interval)::text — זה מכיל רווח ומונה את כל היום.
-- ⚠️ SECURITY DEFINER: הטבלאות סגורות (בלי הרשאות), ורק הבעלים מוחק. אין לה הרשאה לאיש; pg_cron רץ כבעלים.
CREATE OR REPLACE FUNCTION app.prune_service_calls(p_keep interval DEFAULT interval '30 days')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_cut  text := to_char((now() - p_keep) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_gone text[];
  v_n    integer := 0;
  v_m    integer := 0;
BEGIN
  -- ⚠️ הרשימה נקבעת פעם אחת, לפני שתי המחיקות: מחיקת השינויים משנה את "המצב" של כרטיס, ולכן חישוב חוזר
  -- אחריה היה עונה אחרת.
  WITH rows_ AS (
    SELECT btrim(c.payload ->> 'ticket_number') AS ticket, c.id, c.received_at,
           COALESCE((SELECT w.closed FROM wizenet_lookups w
                      WHERE w.kind = 'status' AND w.id = NULLIF(btrim(c.payload ->> 'status'), '')), false) AS closed
      FROM service_calls c
     WHERE c.payload IS NOT NULL AND NULLIF(btrim(c.payload ->> 'ticket_number'), '') IS NOT NULL
  ),
  last_in AS (
    SELECT DISTINCT ON (r.ticket) r.ticket, r.id, r.received_at, r.closed
      FROM rows_ r ORDER BY r.ticket, r.id DESC
  ),
  -- השורה הפתוחה האחרונה של כל כרטיס; מה שאחריה הוא הרצף הסגור הנוכחי
  last_open AS (
    SELECT r.ticket, max(r.id) AS id FROM rows_ r WHERE NOT r.closed GROUP BY r.ticket
  ),
  -- רגע הסגירה אצל ויזנט: תחילת הרצף הסגור שבסוף הכרטיס (ריק כשהשורה האחרונה פתוחה)
  wz_closed AS (
    SELECT r.ticket, min(r.received_at) AS closed_at
      FROM rows_ r LEFT JOIN last_open o ON o.ticket = r.ticket
     WHERE r.id > COALESCE(o.id, 0)
     GROUP BY r.ticket
  ),
  last_st AS (
    SELECT DISTINCT ON (ch.ticket) ch.ticket, ch.value, ch.changed_at,
           COALESCE((SELECT w.closed FROM wizenet_lookups w WHERE w.kind = 'status' AND w.id = ch.value), false) AS closed
      FROM service_call_changes ch
     WHERE ch.field = 'status'
     ORDER BY ch.ticket, ch.id DESC
  ),
  cur AS (
    SELECT l.ticket,
           -- המצב: שינוי מהדשבורד אם הוא חדש מהשורה האחרונה של ויזנט, אחרת ויזנט
           CASE WHEN st.changed_at > l.received_at THEN st.closed ELSE l.closed END AS closed,
           -- רגע הסגירה: ויזנט אם הרצף שלהם כבר סגור; אחרת השינוי מהדשבורד שסגר אותה
           CASE WHEN st.changed_at > l.received_at AND NOT l.closed THEN st.changed_at ELSE wz.closed_at END AS closed_at
      FROM last_in l
      LEFT JOIN last_st st ON st.ticket = l.ticket
      LEFT JOIN wz_closed wz ON wz.ticket = l.ticket
  )
  SELECT COALESCE(array_agg(c.ticket), '{}') INTO v_gone
    FROM cur c
   WHERE c.closed AND c.closed_at < v_cut;

  DELETE FROM service_call_changes ch WHERE ch.ticket = ANY (v_gone);

  DELETE FROM service_calls c
   WHERE c.payload IS NOT NULL AND btrim(c.payload ->> 'ticket_number') = ANY (v_gone);
  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- בלי מספר כרטיס — לפי גיל בלבד
  DELETE FROM service_calls c
   WHERE (c.payload IS NULL OR NULLIF(btrim(c.payload ->> 'ticket_number'), '') IS NULL)
     AND c.received_at < v_cut;
  GET DIAGNOSTICS v_m = ROW_COUNT;

  RETURN v_n + v_m;
END $fn$;
REVOKE ALL ON FUNCTION app.prune_service_calls(interval) FROM PUBLIC;
