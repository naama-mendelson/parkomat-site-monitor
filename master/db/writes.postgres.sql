-- ============================================================
-- db/writes.postgres.sql — פעולות כתיבה שהדפדפן קורא ישירות
-- ============================================================
-- עד כה כל כתיבה עברה בשרת ה-Node, שמתחבר כ-`postgres` עם `rolbypassrls`.
-- הקובץ הזה מעביר אותן ל-Postgres עצמו, כך שהדפדפן קורא להן דרך PostgREST
-- בלי שהשרת מתערב.
--
-- ============================================================
-- ⚠️ למה RPC ולא policies על הטבלה
-- ============================================================
-- הדרך "המתבקשת" היא `GRANT INSERT ON maintenance_windows` + policy. היא
-- שגויה כאן, משלוש סיבות בלתי-תלויות:
--
--   1. **האילוצים אינם תנאי שורה.** policy עונה על "האם מותר לכתוב את
--      השורה הזאת". היא אינה יכולה לחשב `expires_at`, לאכוף תקרה של 720
--      שעות, לכתוב שורת ביקורת, או לפרסם אירוע.
--
--   2. **`set_by_name` היה נשלט ע"י הלקוח.** כל מודל התחזוקה כאן הוא
--      "ייחוס במקום מנע" — ודפדפן שיכול לכתוב שם חופשי הורג את הייחוס.
--      כאן השם נגזר מהזהות המאומתת ו**מתעלם ממה שנשלח**.
--
--   3. **הרשאת טבלה היא רחבה מדי.** עם `GRANT UPDATE` אפשר לשנות כל
--      עמודה בכל שורה. ביטול תחזוקה צריך לגעת ב-`cancelled_at` בלבד.
--
-- ⚠️ ו-RPC נשאר **נייד**: זו פונקציית Postgres רגילה, היא נוסעת ב-`pg_dump`
-- ורצה על כל Postgres 15+. זה מה שמבדיל אותה מ-Edge Function, שאסורה
-- כאן במפורש (ראה הכלל בשורש CLAUDE.md).
--
-- ============================================================
-- ⚠️ SECURITY DEFINER — ולכן הבדיקה חייבת להיות **בפנים**
-- ============================================================
-- `SECURITY DEFINER` מריץ את הפונקציה בהרשאות הבעלים, כלומר **עוקף RLS**.
-- זה מה שמאפשר לה לכתוב בלי להעניק הרשאת טבלה — ובדיוק בגלל זה, בדיקת
-- הזהות חייבת להיות בגוף הפונקציה. בלעדיה כל מי שיש לו את המפתח הציבורי
-- יכול להשתיק כל אתר.
--
-- `search_path` מקובע, כמו בכל SECURITY DEFINER כאן.

-- ============================================================
-- שורת ביקורת — ועכשיו היא באמת נכתבת
-- ============================================================
-- ⚠️ נמדד לפני השינוי: `audit_log` הייתה **ריקה, 0 שורות**, ואף קוד ייצור
-- לא כתב אליה. שורת הביקורת של התחזוקה הייתה `console.log` בלבד — כלומר
-- היא נעלמה עם הקונטיינר, ולא הייתה שם ביום שמישהו שאל "מי השתיק את
-- האתר". המעבר ל-SQL הוא שיפור, לא שחזור.
--
-- ⚠️ `trust` הוא תמיד 'token' כאן, ובצדק: הדרך היחידה להגיע לפונקציות
-- האלה היא אסימון מאומת — `app.current_actor()` קורא את תביעת ה-JWT.
-- אין מסלול אנונימי ואין קוד משותף, ולכן **אין דרגת אמון נחותה יותר**.
--
-- ⚠️ ומה שכן אובד במעבר: **כתובת ה-IP.** השרת רשם אותה מ-`req.ip`; ל-SQL
-- אין גישה לכתובת הלקוח של PostgREST. זו פשרה אמיתית — הזהות מאומתת
-- וחזקה יותר מקודם, אבל המקום שממנו היא באה נעלם.
CREATE OR REPLACE FUNCTION app.record_write_audit(
  p_action      text,
  p_actor_name  text,
  p_actor_role  text,
  p_target_type text,
  p_target_id   text,
  p_details     jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
  INSERT INTO audit_log
    (at, actor_id, actor_name, actor_role, trust, action, target_type, target_id, details)
  VALUES (
    to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    (SELECT u.id FROM app_users u
      WHERE u.supabase_uid::text = app.current_actor() LIMIT 1),
    p_actor_name, p_actor_role, 'token',
    p_action, p_target_type, p_target_id, p_details
  );
$$;

-- ============================================================
-- אירוע — כדי שהעדכון החי ימשיך לעבוד
-- ============================================================
-- ⚠️ **בלי זה הפעולה תעבוד ואף מסך לא יתעדכן.** `events` היא חוזה
-- האירועים: SSE ו-Supabase Realtime שניהם קוראים ממנה. השרת כתב אליה
-- דרך `bus.publish`; כתיבה ישירה שאינה כותבת לשם משאירה את כל המסכים
-- על נתון ישן עד הרענון הבא.
--
-- ⚠️ והצורה זהה בדיוק ל-`recordEvent` ב-queries.js — site_id נשלף מהקוד,
-- ו-site_code נשמר לצידו (ה-FK הוא ON DELETE SET NULL, ולכן הקוד הוא מה
-- שנשאר אחרי מחיקת אתר).
CREATE OR REPLACE FUNCTION app.record_write_event(
  p_site_code text,
  p_type      text,
  p_payload   jsonb
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
  INSERT INTO events (site_id, site_code, type, payload, created_at)
  VALUES (
    (SELECT s.id FROM sites s WHERE s.code = p_site_code),
    p_site_code, p_type, p_payload,
    to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
$$;

-- ============================================================
-- מי הפועל — שם מאומת, ולא מה שנשלח
-- ============================================================
-- ⚠️ מחזיר את השם המלא אם קיים, ואחרת את המייל. **לא** מחזיר NULL בשקט:
-- `set_by_name` הוא `NOT NULL` בסכמה, ושורה בלי שם היא בדיוק מה שכל
-- מודל הייחוס בא למנוע.
CREATE OR REPLACE FUNCTION app.actor_display_name()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
  SELECT COALESCE(NULLIF(TRIM(u.full_name), ''), u.email)
    FROM app_users u
   WHERE u.supabase_uid::text = app.current_actor()
     AND u.is_active
   LIMIT 1
$$;

COMMENT ON FUNCTION app.actor_display_name() IS
  'שם הפועל לייחוס — מהזהות המאומתת, לא מגוף הבקשה.';

-- ============================================================
-- public.start_maintenance — פתיחת חלון תחזוקה
-- ============================================================
-- ⚠️ **כל משתמש פעיל, בלי דרישת תפקיד.** זו החלטת המוצר, ולא השמטה:
-- הכפתור בדשבורד מעולם לא היה מוגן לפי תפקיד, ואנשי שירות צריכים לפתוח
-- חלונות בשטח. הכלל הוא **ייחוס במקום מנע**.
--
-- ⚠️ ומה שכן נאכף: `is_active`. משתמש שהושבת אינו "בקר" — הוא אינו כלום.
-- זה בדיוק מה ש-identifyActor **לא** בדק, ולכן מושבת יכול היה להשתיק אתר.
DROP FUNCTION IF EXISTS public.start_maintenance(text, numeric, text);

CREATE OR REPLACE FUNCTION public.start_maintenance(
  p_site_code      text,
  p_duration_hours numeric,
  p_reason         text DEFAULT NULL
)
RETURNS TABLE (id integer, started_at text, expires_at text, set_by_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
DECLARE
  v_site_id integer;
  v_name    text;
  v_role    text;
  v_start   timestamptz := now();
  v_started text;
  v_expires text;
  v_id      integer;
BEGIN
  -- ⚠️ ראשית הזהות, ולפני כל דבר אחר: SECURITY DEFINER עוקף RLS, ולכן
  -- זו ההגנה היחידה שיש כאן.
  v_name := app.actor_display_name();
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'נדרשת הזדהות' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_role := app.current_app_role();

  -- ⚠️ אותה תקרה שבשרת (MAX_MAINTENANCE_HOURS = 720). 30 יום — מעבר לזה
  -- זו כבר לא תחזוקה, וזה גם משך שמשתיק אתר מהדוחות לחודש שלם.
  IF p_duration_hours IS NULL OR p_duration_hours <= 0 OR p_duration_hours > 720 THEN
    RAISE EXCEPTION 'משך לא תקין — מספר בין 0 ל-720 שעות'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT s.id INTO v_site_id FROM sites s WHERE s.code = p_site_code;
  IF v_site_id IS NULL THEN
    -- ⚠️ PT404 ולא no_data_found: PostgREST ממפה קודי SQLSTATE שמתחילים
    -- ב-PT לקוד HTTP שכתוב בשלוש הספרות. 'no_data_found' (P0002) הוחזר
    -- כ-**500**, כלומר "תקלת שרת" על קוד אתר שהוקלד שגוי — ושולח לחפש
    -- באג שאינו קיים.
    RAISE EXCEPTION 'אתר לא נמצא: %', p_site_code USING ERRCODE = 'PT404';
  END IF;

  -- ⚠️ **הזמנים מחושבים כאן ולא נשלחים.** לקוח ששולח expires_at יכול
  -- להאריך חלון ללא הגבלה ולעקוף את התקרה שנבדקה שורה למעלה.
  --
  -- ⚠️ והפורמט זהה בדיוק לזה של השרת: התאריכים בסכמה הם TEXT ISO-8601,
  -- וכל ההשוואות בפונקציות המדדים לקסיקליות. פורמט שונה היה מסתדר
  -- אחרת ושובר טווחים בשקט.
  v_started := to_char(v_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_expires := to_char((v_start + (p_duration_hours || ' hours')::interval) AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  INSERT INTO maintenance_windows
    (site_id, set_by_name, set_by_role, reason, started_at, duration_hours, expires_at)
  VALUES
    (v_site_id, v_name, v_role, NULLIF(TRIM(COALESCE(p_reason, '')), ''),
     v_started, p_duration_hours, v_expires)
  RETURNING maintenance_windows.id INTO v_id;

  PERFORM app.record_write_audit('maintenance.start', v_name, v_role,
                                 'site', p_site_code,
                                 jsonb_build_object('duration_hours', p_duration_hours,
                                                    'expires_at', v_expires));
  PERFORM app.record_write_event(p_site_code, 'maintenance',
                                 jsonb_build_object('type', 'maintenance',
                                                    'code', p_site_code,
                                                    'action', 'start'));

  RETURN QUERY SELECT v_id, v_started, v_expires, v_name;
END;
$$;

COMMENT ON FUNCTION public.start_maintenance(text, numeric, text) IS
  'פתיחת חלון תחזוקה מהדפדפן. השם נגזר מהזהות המאומתת; הזמנים מחושבים כאן.';

-- ============================================================
-- public.cancel_maintenance — ביטול החלון הפעיל
-- ============================================================
-- ⚠️ נוגע ב-`cancelled_at` בלבד. זו הסיבה שזו פונקציה ולא `GRANT UPDATE`:
-- הרשאת עמודה־כל היא רחבה מדי לפעולה שמשנה שדה אחד.
DROP FUNCTION IF EXISTS public.cancel_maintenance(text);

CREATE OR REPLACE FUNCTION public.cancel_maintenance(p_site_code text)
RETURNS TABLE (cancelled integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
DECLARE
  v_site_id integer;
  v_name    text;
  v_role    text;
  v_now     text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_count   integer;
BEGIN
  v_name := app.actor_display_name();
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'נדרשת הזדהות' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_role := app.current_app_role();

  SELECT s.id INTO v_site_id FROM sites s WHERE s.code = p_site_code;
  IF v_site_id IS NULL THEN
    RAISE EXCEPTION 'אתר לא נמצא: %', p_site_code USING ERRCODE = 'PT404';
  END IF;

  -- אותו תנאי בדיוק כמו ב-cancelMaintenance ב-JS: רק חלון פעיל ולא שפג.
  UPDATE maintenance_windows m
     SET cancelled_at = v_now
   WHERE m.site_id = v_site_id
     AND m.cancelled_at IS NULL
     AND m.expires_at > v_now;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- ⚠️ נרשם גם כשלא בוטל כלום. "ניסה לבטל ולא היה מה" הוא מידע — והשמטתו
  -- הייתה מסתירה בדיוק את המקרה שבו שני אנשים לחצו יחד.
  PERFORM app.record_write_audit('maintenance.cancel', v_name, v_role,
                                 'site', p_site_code,
                                 jsonb_build_object('rows', v_count));
  IF v_count > 0 THEN
    PERFORM app.record_write_event(p_site_code, 'maintenance',
                                   jsonb_build_object('type', 'maintenance',
                                                      'code', p_site_code,
                                                      'action', 'cancel'));
  END IF;

  RETURN QUERY SELECT v_count;
END;
$$;

COMMENT ON FUNCTION public.cancel_maintenance(text) IS
  'ביטול חלון תחזוקה פעיל מהדפדפן. נוגע ב-cancelled_at בלבד.';

-- ============================================================
-- ⚠️ הרשאות: EXECUTE בלבד, ואין GRANT על הטבלה
-- ============================================================
-- זה כל העניין. `authenticated` אינו יכול לכתוב ל-maintenance_windows
-- ישירות — הוא יכול רק לקרוא לשתי הפונקציות, שאוכפות את הכללים.
--
-- ⚠️ ומבטלים מ-PUBLIC: ברירת המחדל של Postgres היא `EXECUTE` ל-PUBLIC על
-- פונקציה חדשה, כלומר גם ל-`anon`. בלי ה-REVOKE כל מי שיש לו את המפתח
-- הציבורי היה יכול להשתיק אתר בלי להתחבר בכלל.
REVOKE ALL ON FUNCTION public.start_maintenance(text, numeric, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_maintenance(text)               FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.start_maintenance(text, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_maintenance(text)               TO authenticated;

-- ============================================================
-- כתיבת אתרים — למנהלים בלבד
-- ============================================================
-- ⚠️ **וכאן, בשונה מתחזוקה, כן נדרש תפקיד.** רישום ומחיקה של אתר משנים
-- את מפת המערכת: `code` הוא ה-{code} בנתיב ה-MQTT, ולכן שינויו קובע
-- **לאיזה אתר** משויכות ההודעות הנכנסות. מחיקה מוחקת היסטוריה.
--
-- עד כה זה היה מוגן ב-`x-admin-code` — סוד משותף אחד, שערכו `admin123`
-- מופיע בקוד הפתוח (DEFAULT_ADMIN_CODE ב-queries.js) ומעולם לא הוחלף.
-- `app.is_manager()` הוא תפקיד מאומת ואינו ניתן לזיוף מהלקוח.
--
-- ============================================================
-- ⚠️ ובאג שתוקן בדרך: insertSite ב-JS **מעולם לא עבד**
-- ============================================================
-- ה-INSERT שם מפרט שש עמודות ומספק שמונה מקומות:
--
--     INSERT INTO sites (code, site_name, registered_at, plc_type, is_new_site, tier)
--     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
--
-- נמדד מול המסד: "INSERT has more expressions than target columns". כלומר
-- POST /api/sites החזיר 500 על **כל** רישום אתר. זה לא נתפס באף בדיקה
-- כי אין שער שרושם אתר — 12 האתרים הקיימים נוספו דרך tools/add-test-site.js.

-- מי רשאי: תפקיד מנהל, ופעיל.
CREATE OR REPLACE FUNCTION app.require_manager()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_name text;
BEGIN
  v_name := app.actor_display_name();
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'נדרשת הזדהות' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- ⚠️ is_manager() קורא מ-app_users ולא מהאסימון. תפקיד שהורד נכנס
  -- לתוקף **מיד**, ולא כשהאסימון יפוג.
  IF NOT app.is_manager() THEN
    RAISE EXCEPTION 'הפעולה מותרת למנהלים בלבד' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_name;
END;
$fn$;

-- ============================================================
-- public.register_site
-- ============================================================
DROP FUNCTION IF EXISTS public.register_site(text, text, text, text, boolean);

CREATE OR REPLACE FUNCTION public.register_site(
  p_code      text,
  p_site_name text,
  p_plc_type  text    DEFAULT NULL,
  p_tier      text    DEFAULT 'basic',
  p_is_new    boolean DEFAULT true
)
RETURNS TABLE (id integer, code text, site_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_actor text := app.require_manager();
  v_name  text := NULLIF(TRIM(COALESCE(p_site_name, '')), '');
  v_tier  text := COALESCE(NULLIF(TRIM(COALESCE(p_tier, '')), ''), 'basic');
  v_plc   text := NULLIF(TRIM(COALESCE(p_plc_type, '')), '');
  v_id    integer;
BEGIN
  -- ⚠️ אותה תבנית בדיוק כמו SITE_CODE_PATTERN בשרת. הקוד נכנס לנתיב MQTT,
  -- ותו כמו '/' או '+' שם הוא תו-בקרה של הפרוטוקול.
  IF p_code IS NULL OR p_code !~ '^[A-Za-z0-9_-]{1,64}$' THEN
    RAISE EXCEPTION 'קוד אתר לא תקין — אותיות, ספרות, מקף וקו תחתון בלבד'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'חסר שם אתר' USING ERRCODE = 'check_violation';
  END IF;
  IF v_tier NOT IN ('vip', 'extended', 'basic') THEN
    RAISE EXCEPTION 'דרגת אתר לא תקינה' USING ERRCODE = 'check_violation';
  END IF;
  -- ⚠️ אותה רשימה כמו SITE_TYPE_KEYS ב-shared/site-types.mjs. NULL מותר —
  -- אתר בלי סוג מוגדר הוא מצב תקין (כך 12 האתרים הקיימים).
  IF v_plc IS NOT NULL AND v_plc NOT IN
     ('doli','matzbet-x','matzbet-y','xy','x','y','shuttle-y','shuttle-x') THEN
    RAISE EXCEPTION 'סוג מתקן לא תקין' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (SELECT 1 FROM sites s WHERE s.code = p_code) THEN
    -- PT409 → HTTP 409. "כבר קיים" אינו שגיאת קלט ואינו תקלת שרת.
    RAISE EXCEPTION 'אתר עם קוד זה כבר רשום: %', p_code USING ERRCODE = 'PT409';
  END IF;

  INSERT INTO sites (code, site_name, registered_at, plc_type, is_new_site, tier)
  VALUES (p_code, v_name,
          to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          v_plc, CASE WHEN p_is_new THEN 1 ELSE 0 END, v_tier)
  RETURNING sites.id INTO v_id;

  PERFORM app.record_write_audit('site.register', v_actor, app.current_app_role(),
                                 'site', p_code,
                                 jsonb_build_object('site_name', v_name, 'tier', v_tier,
                                                    'plc_type', v_plc, 'is_new', p_is_new));
  PERFORM app.record_write_event(p_code, 'site-added',
                                 jsonb_build_object('type','site-added','code',p_code,
                                                    'siteName',v_name));

  RETURN QUERY SELECT v_id, p_code, v_name;
END;
$fn$;

-- ============================================================
-- public.update_site
-- ============================================================
-- ⚠️ NULL = "אל תיגע", ולא "רוקן". זה מה שמאפשר לעדכן שם בלי לאבד סוג.
-- לרוקן סוג מתקן — מעבירים מחרוזת ריקה.
--
-- ============================================================
-- ⚠️ כל `WHERE` מסומך ב-`sites.` — וזה **לא** נוי
-- ============================================================
-- `RETURNS TABLE (id integer, ...)` מגדיר `id` כמשתנה פלט. `WHERE sites.id = v_id`
-- הוא לכן `column reference "id" is ambiguous` (42702), ש-PostgREST ממפה
-- ל-**400** — כלומר "הבקשה שגויה", על בקשה תקינה לחלוטין.
--
-- נמדד: כל עדכון החזיר 400 בעוד `register_site` (שאין בו WHERE) ו-
-- `delete_site` (שאין בו פרמטר פלט בשם `id`) עבדו. כלומר הבאג היה נראה
-- כמו "רק העדכון שבור" ולא כמו שגיאת שם.
DROP FUNCTION IF EXISTS public.update_site(text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.update_site(
  p_code      text,
  p_new_code  text DEFAULT NULL,
  p_site_name text DEFAULT NULL,
  p_tier      text DEFAULT NULL,
  p_plc_type  text DEFAULT NULL
)
RETURNS TABLE (id integer, code text, site_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_actor text := app.require_manager();
  v_id    integer;
  v_code  text;
  v_name  text;
BEGIN
  SELECT s.id, s.code, s.site_name INTO v_id, v_code, v_name
    FROM sites s WHERE s.code = p_code;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'אתר לא נמצא: %', p_code USING ERRCODE = 'PT404';
  END IF;

  IF p_new_code IS NOT NULL AND p_new_code <> p_code THEN
    IF p_new_code !~ '^[A-Za-z0-9_-]{1,64}$' THEN
      RAISE EXCEPTION 'קוד אתר לא תקין' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM sites s WHERE s.code = p_new_code) THEN
      RAISE EXCEPTION 'הקוד כבר בשימוש: %', p_new_code USING ERRCODE = 'PT409';
    END IF;
    UPDATE sites SET code = p_new_code WHERE sites.id = v_id;
    v_code := p_new_code;
  END IF;

  IF NULLIF(TRIM(COALESCE(p_site_name, '')), '') IS NOT NULL THEN
    UPDATE sites SET site_name = TRIM(p_site_name) WHERE sites.id = v_id;
    v_name := TRIM(p_site_name);
  END IF;

  IF p_tier IS NOT NULL THEN
    IF p_tier NOT IN ('vip', 'extended', 'basic') THEN
      RAISE EXCEPTION 'דרגת אתר לא תקינה' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE sites SET tier = p_tier WHERE sites.id = v_id;
  END IF;

  -- ⚠️ כאן מחרוזת ריקה **כן** משמעותית: היא מרוקנת את הסוג. NULL אינו
  -- נוגע. אותה סמנטיקה בדיוק כמו בשרת (plcType !== undefined).
  IF p_plc_type IS NOT NULL THEN
    IF NULLIF(TRIM(p_plc_type), '') IS NOT NULL
       AND TRIM(p_plc_type) NOT IN
       ('doli','matzbet-x','matzbet-y','xy','x','y','shuttle-y','shuttle-x') THEN
      RAISE EXCEPTION 'סוג מתקן לא תקין' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE sites SET plc_type = NULLIF(TRIM(p_plc_type), '') WHERE sites.id = v_id;
  END IF;

  PERFORM app.record_write_audit('site.update', v_actor, app.current_app_role(),
                                 'site', v_code,
                                 jsonb_build_object('from_code', p_code, 'new_code', p_new_code,
                                                    'site_name', p_site_name, 'tier', p_tier,
                                                    'plc_type', p_plc_type));
  PERFORM app.record_write_event(v_code, 'site-updated',
                                 jsonb_build_object('type','site-updated','code',v_code));

  RETURN QUERY SELECT v_id, v_code, v_name;
END;
$fn$;

-- ============================================================
-- public.delete_site
-- ============================================================
-- ⚠️ מחזיר מה נמחק **לפני** המחיקה, כי אחריה אי אפשר לספור. אותה החזרה
-- כמו deleteSite ב-JS, שהמסך מציג למשתמשת כאישור.
DROP FUNCTION IF EXISTS public.delete_site(text);

CREATE OR REPLACE FUNCTION public.delete_site(p_code text)
RETURNS TABLE (code text, site_name text, operations integer, status_history integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_actor text := app.require_manager();
  v_id    integer;
  v_name  text;
  v_ops   integer;
  v_hist  integer;
BEGIN
  SELECT s.id, s.site_name INTO v_id, v_name FROM sites s WHERE s.code = p_code;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'אתר לא נמצא: %', p_code USING ERRCODE = 'PT404';
  END IF;

  SELECT COUNT(*)::int INTO v_ops  FROM operations     WHERE site_id = v_id;
  SELECT COUNT(*)::int INTO v_hist FROM status_history WHERE site_id = v_id;

  -- ⚠️ האירוע נרשם **לפני** המחיקה: events.site_id הוא ON DELETE SET NULL,
  -- ולכן רישום אחריה היה מאבד את הקישור. site_code נשאר בכל מקרה.
  PERFORM app.record_write_audit('site.delete', v_actor, app.current_app_role(),
                                 'site', p_code,
                                 jsonb_build_object('site_name', v_name,
                                                    'operations', v_ops,
                                                    'status_history', v_hist));
  PERFORM app.record_write_event(p_code, 'site-deleted',
                                 jsonb_build_object('type','site-deleted','code',p_code));

  DELETE FROM sites WHERE sites.id = v_id;

  RETURN QUERY SELECT p_code, v_name, v_ops, v_hist;
END;
$fn$;

REVOKE ALL ON FUNCTION public.register_site(text, text, text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_site(text, text, text, text, text)      FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_site(text)                              FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.register_site(text, text, text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_site(text, text, text, text, text)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_site(text)                              TO authenticated;
