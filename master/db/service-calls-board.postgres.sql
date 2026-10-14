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
-- ממולאות על ידי פונקציית ה-Edge (wizenet) מתוך ה-API שלהם. closed — מה נחשב סגור; ראו wizenet_lookups_save.
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
-- ⚠️ נרשם **רק אחרי** שוויזנט אישרו (ראו פונקציית ה-Edge): רישום לפני האישור היה מציג על המסך סטטוס
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
-- המצב הנוכחי של כל קריאה
-- ============================================================
-- שורה לכל ticket_number: השורה האחרונה שהגיעה מוויזנט, והשינוי האחרון שלנו בכל שדה — אם הוא חדש יותר
-- ממנה. open — לפי הרשימה (ראו בראש הקובץ).
CREATE OR REPLACE FUNCTION app.service_calls_current()
RETURNS TABLE (ticket text, site_id integer, site_code text, project text, payload jsonb, received_at text,
               status_id text, type_id text, open boolean, changed_by text, changed_at text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
  WITH last_in AS (
    SELECT DISTINCT ON (btrim(c.payload ->> 'ticket_number'))
           btrim(c.payload ->> 'ticket_number') AS ticket, c.payload, c.received_at
      FROM service_calls c
     WHERE c.payload IS NOT NULL AND NULLIF(btrim(c.payload ->> 'ticket_number'), '') IS NOT NULL
     ORDER BY btrim(c.payload ->> 'ticket_number'), c.id DESC
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
  )
  SELECT c.ticket, s.id, s.code, c.project, c.payload, c.received_at, c.status_id, c.type_id,
         NOT COALESCE((SELECT w.closed FROM wizenet_lookups w WHERE w.kind = 'status' AND w.id = c.status_id), false),
         c.changed_by, c.changed_at
    FROM cur c
    LEFT JOIN sites s ON s.code = c.project
$$;
REVOKE ALL ON FUNCTION app.service_calls_current() FROM PUBLIC;

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
  WITH w AS (SELECT to_char(now() - make_interval(hours => LEAST(GREATEST(COALESCE(p_hours, 24), 1), 168)),
                            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS since)
  SELECT c.site_id,
         count(*) FILTER (WHERE c.open)::int,
         count(*) FILTER (WHERE c.received_at > w.since)::int,
         to_char(min(COALESCE(app.wizenet_ts(c.payload ->> 'opened_at'), c.received_at::timestamptz))
                   FILTER (WHERE c.open) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    FROM app.service_calls_current() c, w
   WHERE c.site_id IS NOT NULL AND (SELECT app.is_staff())
     AND (c.open OR c.received_at > w.since)
   GROUP BY c.site_id
$$;
REVOKE ALL ON FUNCTION public.service_call_counts(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.service_call_counts(integer) TO authenticated;

-- הקריאות הפתוחות של אתר, מהישנה לחדשה, עם שמות הסטטוס והסוג. ⚠️ jsonb יחיד (PostgREST חותך ב-1,000 שורות).
-- ⚠️ p_hours (14/10/2026): כשניתן — גם מה שנסגר בחלון הזה, כדי שהחלון מהכרטיס יראה את מה שקרה
-- היום ולא רק את מה שעוד פתוח. בלי הפרמטר ההתנהגות כשהייתה (פתוחות בלבד), וקריאה ישנה עדיין נפתרת.
DROP FUNCTION IF EXISTS public.service_calls_open(text);
CREATE OR REPLACE FUNCTION public.service_calls_open(p_site_code text, p_hours integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_since text := CASE WHEN p_hours IS NULL THEN NULL
                  ELSE to_char(now() - make_interval(hours => LEAST(GREATEST(p_hours, 1), 168)),
                               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END;
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
             'changed_at', c.changed_at)
           -- פתוחות קודם, ובתוכן הישנה למעלה: מה שעוד דורש טיפול בראש הרשימה
           ORDER BY c.open DESC, COALESCE(NULLIF(btrim(c.payload ->> 'opened_at'), ''), c.received_at), c.ticket)
      FROM app.service_calls_current() c
     WHERE c.site_code = btrim(COALESCE(p_site_code, ''))
       AND (c.open OR (v_since IS NOT NULL AND c.received_at > v_since))
  ), '[]'::jsonb);
END $fn$;
REVOKE ALL ON FUNCTION public.service_calls_open(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.service_calls_open(text, integer) TO authenticated;

-- ============================================================
-- "קריאות היום" — כל הקריאות מה-24 שעות האחרונות (14/10/2026)
-- ============================================================
-- ⚠️ בעלת המוצר, אחרי שהתכונה עלתה: "לא רואים כלום". וזה היה נכון — מדדנו 22 קריאות ביום הראשון,
-- מהן 18 כבר סגורות ו-3 לקודים שאין להם אתר אצלנו, ולכן הופיעה **גלולה אחת** על כרטיס אחד מ-78.
-- הסימון על הכרטיס עונה על "מה פתוח עכשיו"; זה עונה על "מה קרה היום" — כולל סגורות, וכולל קודים
-- שאין להם אתר, שאחרת אינם נראים בשום מקום (רבע מהקריאות ביום הראשון).
-- ⚠️ jsonb יחיד, כמו service_calls_open: PostgREST חותך ב-1,000 שורות.
-- ⚠️ הטווח מוגבל ל-168 שעות: זו פונקציה שרצה מהכותרת, ולא דלת לכל ההיסטוריה.
CREATE OR REPLACE FUNCTION public.service_calls_recent(p_hours integer DEFAULT 24)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE v_h integer := LEAST(GREATEST(COALESCE(p_hours, 24), 1), 168);
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
             'changed_at', c.changed_at)
           -- החדשה למעלה: מי שפותח את הרשימה שואל "מה קרה עכשיו"
           ORDER BY c.received_at DESC, c.ticket DESC)
      FROM app.service_calls_current() c
     WHERE c.received_at > to_char(now() - make_interval(hours => v_h), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ), '[]'::jsonb);
END $fn$;
REVOKE ALL ON FUNCTION public.service_calls_recent(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.service_calls_recent(integer) TO authenticated;

-- כמה קריאות היו ב-24 השעות — למספר על הכפתור בכותרת. ⚠️ אינה זורקת, כמו service_call_counts:
-- היא נטענת עם הלוח, וכשל כאן לא יפיל אותו.
CREATE OR REPLACE FUNCTION public.service_calls_recent_count(p_hours integer DEFAULT 24)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
  SELECT count(*)::int FROM app.service_calls_current() c
   WHERE (SELECT app.is_staff())
     AND c.received_at > to_char(now() - make_interval(hours => LEAST(GREATEST(COALESCE(p_hours, 24), 1), 168)),
                                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
REVOKE ALL ON FUNCTION public.service_calls_recent_count(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.service_calls_recent_count(integer) TO authenticated;

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
-- כתיבה — דרך פונקציית ה-Edge, בזהות הקורא
-- ============================================================
-- שמירת רשימה שנשלפה מוויזנט: [{ "id": "...", "name": "..." }, ...]. מעדכנת שמות ומוסיפה חדשים; ⚠️ closed
-- של שורה קיימת **אינו נדרס** — מי שסימן "סגורה" ביד לא יאבד את זה בטעינה הבאה. בשורה חדשה — ניחוש לפי השם
-- (סגור / בוטל / הסתיים / טופל), שאותו בודקים בעין לפני שמדליקים את התכונה.
CREATE OR REPLACE FUNCTION public.wizenet_lookups_save(p_kind text, p_items jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_staff();
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
REVOKE ALL ON FUNCTION public.wizenet_lookups_save(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wizenet_lookups_save(text, jsonb) TO authenticated;

-- רישום שינוי שוויזנט כבר אישר. ⚠️ ערך חייב להיות ברשימה, כשיש רשימה — ערך שאינו שם היה נשמר ומוצג
-- כמספר; כשאין רשימה בכלל (לפני הטעינה הראשונה) — נבדק אצל ויזנט בלבד ("not found").
CREATE OR REPLACE FUNCTION public.service_call_record_change(p_ticket text, p_field text, p_value text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_staff();
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
  VALUES (v_ticket, p_field, v_value, v_actor, app.current_app_user(), v_now);
  PERFORM app.record_write_audit('service_call.' || p_field, v_actor, app.current_app_role(), 'service_call',
    v_ticket, jsonb_build_object('value', v_value));
  PERFORM app.record_write_event(COALESCE(v_site, '*'), 'service_calls',
    jsonb_build_object('type', 'service_calls', 'code', v_site, 'action', p_field));
  RETURN v_now;
END $fn$;
REVOKE ALL ON FUNCTION public.service_call_record_change(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.service_call_record_change(text, text, text) TO authenticated;

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
