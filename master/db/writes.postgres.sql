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

-- ============================================================
-- ניהול משתמשים — מה שכן יכול לעבור, ומה שלא
-- ============================================================
-- ⚠️ **הזמנה ומחיקה אינן כאן, וזה לא חוסר.** יצירת משתמש ומחיקתו ב-GoTrue
-- דורשות את ה-Admin API, כלומר את מפתח ה-Secret — והכלל בשורש CLAUDE.md
-- אוסר עליו להגיע לדפדפן, כי הוא עוקף RLS לחלוטין. לכן `POST
-- /api/users/invite` ו-`DELETE /api/users/:id` **נשארים בשרת**, וזו התשובה
-- לשאלה "למה ניהול המשתמשים לא ישר ב-Supabase": חלקו כן, שני חלקים לא.
--
-- מה שכן עובר: **השבתה, החזרה לפעילות, ושינוי תפקיד** — כולן כתיבות ל-
-- `app_users` ולא נוגעות ב-GoTrue.
--
-- ============================================================
-- ⚠️ ומה שאִפשר את זה: התפקיד כבר אינו נקרא מהאסימון
-- ============================================================
-- קודם, שינוי תפקיד היה חייב לעדכן **שני** מקומות — `app_users` ו-
-- `app_metadata` — כי התביעה שבאסימון היא מה שהדשבורד קרא. הסנכרון השני
-- דורש את ה-Admin API, ולכן כל המסלול היה תקוע בשרת.
--
-- מרגע ש-`public.my_role()` קיים והדשבורד קורא ממנו, `app_users` הוא צד
-- אחד של אמת — והתביעה היא רק הערך ההתחלתי שממנו `provision_app_user`
-- בונה שורה חדשה.
--
-- ⚠️ **המחיר, במפורש:** `app_metadata` בלוח הבקרה של Supabase יישאר עם
-- התפקיד הישן. מי שיסתכל שם יראה נתון שאינו הסמכות. זו הסיבה שהשרת עדיין
-- מסנכרן אותו במסלול שלו — ומי שמשנה תפקיד מהמסלול הישיר מקבל אכיפה
-- נכונה ותצוגה נכונה, ורק ה-app_metadata מתיישן.
--
-- ============================================================
-- ⚠️ שני מגני הנעילה — מפורטים כאן **ושם**, וזו כפילות מודעת
-- ============================================================
-- הכללים חיים ב-`auth/deactivation.js` (`canDeactivate` / `canChangeRole`)
-- ונבדקים שם כהתנהגות. כאן הם נכתבים שוב, כי הדפדפן אינו עובר בשרת.
--
-- ⚠️ **ופער בין שני העותקים הוא בדיוק הכשל שהם נועדו למנוע:** כלל שנשמר
-- בזרוע אחת ולא בשנייה פירושו שאפשר להשאיר את המערכת בלי אף מנהל — דרך
-- המסלול שלא עודכן. לכן `tools/check-writes.js` בודק את שני המגנים **חי**
-- מול המסד, ולא רק את פונקציות ה-JS.

-- ============================================================
-- ⚠️ שמות הפלט מתחילים ב-`out_`, וזה מכוון
-- ============================================================
-- `RETURNS TABLE (id integer, …)` הופך `id` למשתנה, ואז `WHERE id = …` הוא
-- `column reference "id" is ambiguous` (42702) → PostgREST **400**. זה קרה
-- כאן בפועל ב-`update_site`, וזה נראה כמו "רק העדכון שבור" ולא כמו שגיאת
-- שם.
--
-- הסמכה (`WHERE app_users.id = …`) פותרת את זה, והיא נעשית גם כאן. אבל
-- תחילית בשמות הפלט הופכת את התקלה ל**בלתי אפשרית** במקום ל"נמנעת
-- במשמעת" — והמחיר הוא שם שדה מכוער אחד ב-JSON, שמתאם דק ממילא ממפה.

-- ============================================================
-- public.set_user_active — השבתה והחזרה
-- ============================================================
DROP FUNCTION IF EXISTS public.set_user_active(integer, boolean);

CREATE OR REPLACE FUNCTION public.set_user_active(
  p_user_id integer,
  p_active  boolean
)
RETURNS TABLE (out_id integer, out_email text, out_is_active boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_actor_name text := app.require_manager();
  v_actor_id   integer := app.current_app_user();
  v_email      text;
  v_role       text;
  v_managers   integer;
BEGIN
  IF p_user_id IS NULL OR p_active IS NULL THEN
    RAISE EXCEPTION 'חסר מזהה משתמש או מצב' USING ERRCODE = 'check_violation';
  END IF;

  SELECT u.email, u.role INTO v_email, v_role FROM app_users u WHERE u.id = p_user_id;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'משתמש לא נמצא' USING ERRCODE = 'PT404';
  END IF;

  -- ⚠️ המגנים חלים על **השבתה בלבד**. החזרה לפעילות אינה מסירה הרשאות
  -- מאיש, ולכן אין ממה להגן — ובדיקה כאן הייתה חוסמת בדיוק את הפעולה
  -- שמחלצת ממצב תקוע.
  IF p_active = false THEN
    IF p_user_id = v_actor_id THEN
      RAISE EXCEPTION 'אי אפשר להשבית את עצמך' USING ERRCODE = 'check_violation';
    END IF;

    IF v_role = 'manager' THEN
      SELECT COUNT(*)::int INTO v_managers
        FROM app_users u WHERE u.role = 'manager' AND u.is_active;
      IF v_managers <= 1 THEN
        RAISE EXCEPTION 'לא ניתן להשבית את המנהל הפעיל האחרון'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  -- ⚠️ `disabled_by` הוא FK ל-app_users(id) — מזהה מספרי ולא מייל. העברת
  -- שם הפילה בעבר כל השבתה על שגיאת טיפוס, וזה נראה כמו "הכפתור לא עובד".
  UPDATE app_users
     SET is_active   = p_active,
         disabled_at = CASE WHEN p_active THEN NULL
                            ELSE to_char(now() AT TIME ZONE 'UTC',
                                         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
         disabled_by = CASE WHEN p_active THEN NULL ELSE v_actor_id END
   WHERE app_users.id = p_user_id;

  -- ⚠️ התחילית `user.` נושאת את כל ההרשאה: מדיניות audit_log מסתירה
  -- `user.%` מבקרים. פעולה שתיקרא אחרת תהיה גלויה לכולם בלי שום סימן.
  PERFORM app.record_write_audit(
    CASE WHEN p_active THEN 'user.enable' ELSE 'user.disable' END,
    v_actor_name, app.current_app_role(), 'user', p_user_id::text,
    jsonb_build_object('email', v_email, 'is_active', p_active));

  RETURN QUERY SELECT p_user_id, v_email, p_active;
END;
$fn$;

-- ============================================================
-- public.set_user_role — שינוי תפקיד
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_user_role(
  p_user_id integer,
  p_role    text
)
RETURNS TABLE (out_id integer, out_email text, out_role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_actor_name text := app.require_manager();
  v_actor_id   integer := app.current_app_user();
  v_email      text;
  v_role       text;
  v_managers   integer;
BEGIN
  IF p_role NOT IN ('operator', 'manager') THEN
    RAISE EXCEPTION 'תפקיד לא תקין' USING ERRCODE = 'check_violation';
  END IF;

  SELECT u.email, u.role INTO v_email, v_role FROM app_users u WHERE u.id = p_user_id;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'משתמש לא נמצא' USING ERRCODE = 'PT404';
  END IF;

  IF v_role = p_role THEN
    RAISE EXCEPTION 'זה כבר התפקיד שלו' USING ERRCODE = 'check_violation';
  END IF;

  -- ⚠️ **הורדה ממנהל לבקר היא אותה סכנה בדיוק כמו השבתה** — שתיהן מסירות
  -- את יכולת הניהול. כלל שמגן רק על ההשבתה משאיר דלת פתוחה: מורידים את
  -- המנהל האחרון לבקר, ואין מי שיחזיר. העלאה תמיד מותרת.
  IF p_role = 'operator' THEN
    IF p_user_id = v_actor_id THEN
      RAISE EXCEPTION 'אי אפשר להוריד את עצמך מתפקיד מנהל'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT COUNT(*)::int INTO v_managers
      FROM app_users u WHERE u.role = 'manager' AND u.is_active;
    IF v_managers <= 1 THEN
      RAISE EXCEPTION 'לא ניתן להוריד את המנהל הפעיל האחרון'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  UPDATE app_users SET role = p_role WHERE app_users.id = p_user_id;

  PERFORM app.record_write_audit('user.role', v_actor_name, app.current_app_role(),
                                 'user', p_user_id::text,
                                 jsonb_build_object('email', v_email,
                                                    'from', v_role, 'to', p_role));

  RETURN QUERY SELECT p_user_id, v_email, p_role;
END;
$fn$;

REVOKE ALL ON FUNCTION public.set_user_active(integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_user_role(integer, text)      FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.set_user_active(integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_user_role(integer, text)      TO authenticated;

-- ============================================================
-- public.list_users — רשימת המשתמשים, כולל כניסה אחרונה
-- ============================================================
-- ⚠️ **הקריאה הפשוטה מ-`app_users` דרך PostgREST לא הייתה מספיקה**, וזה
-- מה שחייב פונקציה: `last_sign_in_at` יושב ב-`auth.users`, ו-PostgREST
-- חושף רק את `public`. השרת שלף אותו דרך ה-Admin API, כלומר עם מפתח
-- ה-Secret — שאסור לו להגיע לדפדפן.
--
-- ⚠️ ולמה זה שדה שכדאי להילחם עליו: הוא התשובה לשאלה "האם המשתמש הזה
-- בכלל השתמש במערכת". בלעדיו רשימת המשתמשים אינה יכולה להבדיל בין מי
-- שעובד כאן כל יום לבין הזמנה שנשלחה ואף פעם לא נפתחה.
--
-- ============================================================
-- ⚠️ המחיר: JOIN ל-auth.users, וזה החיבור היחיד כאן ל-Supabase
-- ============================================================
-- הכלל בשורש CLAUDE.md אוסר **FK** ל-`auth.users` ואוסר `auth.*` בתוך
-- פונקציות מדדים ומדיניות. זו אינה אף אחת מהשתיים — אבל היא כן נשענת על
-- סכמה שלא תיסע ב-`pg_dump --schema=public --schema=app`.
--
-- העלות בהגירה מפורשת ומוגדרת: **שורת JOIN אחת**. `app_users` נשאר טבלת
-- המשתמשים הקנונית, `supabase_uid` נשאר עמודה בלי FK, וכל השאר בפונקציה
-- הוא שלנו. אותו דפוס בדיוק כמו הטריגרים על `auth.users`.
--
-- ⚠️ ו-`LEFT JOIN` ולא `JOIN`: משתמש שנוצר אצלנו ואין לו עדיין שורת auth
-- (או שנמחק משם) חייב להופיע ברשימה. `INNER` היה **מעלים אותו** — כלומר
-- מסתיר בדיוק את השורה החריגה שמנהל צריך לראות.
CREATE OR REPLACE FUNCTION public.list_users()
RETURNS TABLE (
  out_id              integer,
  out_email           text,
  out_full_name       text,
  out_role            text,
  out_is_active       boolean,
  out_created_at      text,
  out_disabled_at     text,
  out_last_sign_in_at text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
BEGIN
  -- ⚠️ בפנים ולא במדיניות: SECURITY DEFINER עוקף RLS, ולכן זו ההגנה
  -- היחידה. המדיניות על app_users מתירה קריאה לכל משתמש פעיל, אבל הנתיב
  -- בשרת היה מוגבל למנהלים — וכאן נשמרת אותה החלטה.
  PERFORM app.require_manager();

  RETURN QUERY
    SELECT u.id, u.email, u.full_name, u.role, u.is_active,
           u.created_at, u.disabled_at,
           to_char(au.last_sign_in_at AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      FROM app_users u
      LEFT JOIN auth.users au ON au.id = u.supabase_uid
     ORDER BY u.id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.list_users() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_users() TO authenticated;

-- ============================================================
-- סימון דיווח כ**ניסוי** — למנהלים בלבד
-- ============================================================
--
-- ⚠️ **"ניסוי" ולא "בוטל", וזו לא בחירת מילים.** "בוטל" מתאר פעולה
-- מנהלית ומזמין את השאלה "מי הרשה"; "ניסוי" מתאר **מה קרה בפועל** —
-- מישהו הקפיץ את הדלת כדי לבדוק שהמערכת עובדת. מי שיקרא את הלוג בעוד
-- חצי שנה צריך לדעת את זה, לא את מי אישר.
--
-- ⚠️ ולכן גם השם של מי שסימן אינו "מי מחק" אלא **מי ניסה**.
-- "הקפצתי דלתות חניון כדי לבדוק שהמערכת עובדת, ועכשיו אני רוצה להסיר את
-- זה מהסטטיסטיקה." שתי ישויות נכנסות לכאן:
--
--   'operation' → שורה ב-operations      (פעולת בדיקה מנפחת את מונה הפעולות)
--   'fault'     → מקטע error ב-status_history (תקלה מכוונת מנפחת אחוז כשל)
--
-- ⚠️ **סימון, לא מחיקה.** הדרישה הייתה "שיהיה כתוב מה בוטל ועל ידי מי",
-- ומחיקה הופכת את זה לבלתי אפשרי — אין על מה לכתוב. השורה נשארת, ולוג
-- הפעילות מציג אותה עם השם של מי שהוציא אותה.
--
-- ⚠️ **מנהל בלבד, בשונה מתחזוקה.** תחזוקה היא ייחוס-במקום-מנע: היא הפיכה,
-- פגה מעצמה, וכל טכנאי צריך אותה בשטח. הוצאה מהסטטיסטיקה משנה את המספרים
-- שעליהם מסתכלים — אחוז כשל וזמינות — ואין לה תפוגה. מי שיכול להוריד את
-- אחוז הכשל של אתר צריך להיות אותו מעגל שיכול למחוק אתר.
--
-- ⚠️ ולמה `restore` קיימת: בלעדיה טעות אחת היא לצמיתות. היא מנקה את שלוש
-- העמודות יחד — שחזור שמשאיר `excluded_by` מאוכלס נראה כמו שורה שהוצאה
-- ועדיין נספרת, וזה בדיוק המצב שאי אפשר להסביר.

CREATE OR REPLACE FUNCTION app.test_target_table(p_kind text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE lower(COALESCE(p_kind, ''))
           WHEN 'operation' THEN 'operations'
           WHEN 'fault'     THEN 'status_history'
           -- ⚠️ חלון תחזוקה הוא יעד שלישי, ולא סתם עוד שורה: הוא **מכסה**
           -- זמן של מקטעים אחרים והופך אותו לתחזוקה. סימונו כניסוי מסיר
           -- גם את הכיסוי — ראה הסינון ב-win CTE וב-cover שב-JS.
           WHEN 'maintenance' THEN 'maintenance_windows'
         END;
$fn$;

DROP FUNCTION IF EXISTS public.mark_as_test(text, bigint, text);

CREATE OR REPLACE FUNCTION public.mark_as_test(
  p_kind   text,
  p_id     bigint,
  p_reason text DEFAULT NULL
)
RETURNS TABLE (kind text, id bigint, excluded_at text, excluded_by text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_actor  text := app.require_manager();
  v_table  text := app.test_target_table(p_kind);
  v_now    text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_reason text := NULLIF(TRIM(COALESCE(p_reason, '')), '');
  v_code   text;
  v_prev   text;
BEGIN
  IF v_table IS NULL THEN
    RAISE EXCEPTION 'סוג דיווח לא תקין: %', p_kind USING ERRCODE = 'check_violation';
  END IF;

  -- ⚠️ EXECUTE עם שם טבלה מתוך רשימה סגורה (exclusion_target), ולא
  -- מחרוזת מהלקוח. שתי הטבלאות זהות במבנה הרלוונטי, וכתיבת שתי פונקציות
  -- כמעט־זהות הייתה מזמינה תיקון שנעשה רק באחת מהן.
  EXECUTE format(
    'SELECT s.code, t.excluded_at FROM %I t JOIN sites s ON s.id = t.site_id WHERE t.id = $1',
    v_table
  ) INTO v_code, v_prev USING p_id;

  IF v_code IS NULL THEN
    RAISE EXCEPTION 'דיווח לא נמצא' USING ERRCODE = 'PT404';
  END IF;
  IF v_prev IS NOT NULL THEN
    -- 409 ולא 400: הבקשה תקינה, המצב כבר כזה. לרוב שתי לחיצות על אותו כפתור.
    RAISE EXCEPTION 'הדיווח כבר הוצא מהסטטיסטיקה' USING ERRCODE = 'PT409';
  END IF;

  EXECUTE format(
    'UPDATE %I SET excluded_at = $1, excluded_by = $2, exclusion_reason = $3 WHERE id = $4',
    v_table
  ) USING v_now, v_actor, v_reason, p_id;

  PERFORM app.record_write_audit('report.mark-test', v_actor, app.current_app_role(),
                                 p_kind, p_id::text,
                                 jsonb_build_object('site', v_code, 'reason', v_reason));
  PERFORM app.record_write_event(v_code, 'report-marked-test',
                                 jsonb_build_object('type','report-marked-test','code',v_code,
                                                    'kind',p_kind,'id',p_id));

  RETURN QUERY SELECT p_kind, p_id, v_now, v_actor;
END;
$fn$;

DROP FUNCTION IF EXISTS public.unmark_test(text, bigint);

CREATE OR REPLACE FUNCTION public.unmark_test(p_kind text, p_id bigint)
RETURNS TABLE (kind text, id bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_actor text := app.require_manager();
  v_table text := app.test_target_table(p_kind);
  v_code  text;
  v_prev  text;
BEGIN
  IF v_table IS NULL THEN
    RAISE EXCEPTION 'סוג דיווח לא תקין: %', p_kind USING ERRCODE = 'check_violation';
  END IF;

  EXECUTE format(
    'SELECT s.code, t.excluded_at FROM %I t JOIN sites s ON s.id = t.site_id WHERE t.id = $1',
    v_table
  ) INTO v_code, v_prev USING p_id;

  IF v_code IS NULL THEN
    RAISE EXCEPTION 'דיווח לא נמצא' USING ERRCODE = 'PT404';
  END IF;
  IF v_prev IS NULL THEN
    RAISE EXCEPTION 'הדיווח אינו מוצא מהסטטיסטיקה' USING ERRCODE = 'PT409';
  END IF;

  -- ⚠️ שלוש העמודות יחד. ניקוי חלקי משאיר שורה שנספרת אבל נושאת שם של מי
  -- שהוציא אותה — מצב שאי אפשר להסביר למי שקורא את הלוג.
  EXECUTE format(
    'UPDATE %I SET excluded_at = NULL, excluded_by = NULL, exclusion_reason = NULL WHERE id = $1',
    v_table
  ) USING p_id;

  PERFORM app.record_write_audit('report.unmark-test', v_actor, app.current_app_role(),
                                 p_kind, p_id::text,
                                 jsonb_build_object('site', v_code));
  PERFORM app.record_write_event(v_code, 'report-unmarked-test',
                                 jsonb_build_object('type','report-unmarked-test','code',v_code,
                                                    'kind',p_kind,'id',p_id));

  RETURN QUERY SELECT p_kind, p_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.mark_as_test(text, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.unmark_test(text, bigint)       FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.mark_as_test(text, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unmark_test(text, bigint)       TO authenticated;

-- ============================================================
-- חלון תחזוקה מתוזמן — עם שעת התחלה מפורשת
-- ============================================================
-- ⚠️ **גרסה נוספת ולא שינוי של הקיימת.** `start_maintenance` בת שלושת
-- הפרמטרים נקראת מהדשבורד ומהשער; שינוי חתימתה היה שובר את שניהם ביום
-- שבו הדשבורד עדיין לא נפרס. שתי החתימות חיות זו לצד זו.
--
-- ⚠️ **וזה שינוי אמיתי במודל, לא נוחות:** עד עכשיו כל חלון התחיל **עכשיו**,
-- ולכן "יש חלון" ו"האתר בתחזוקה" היו אותו דבר. חלון עתידי מפריד ביניהם:
-- הוא קיים ברשימה, ואינו משפיע על המדדים עד שיגיע זמנו.
--
-- כל השאר כבר עובד עם זה בלי שינוי: חישוב הזמינות מצטלב לפי
-- started_at/expires_at, ולכן חלון שטרם התחיל פשוט אינו חופף לתקופה
-- הנמדדת. וגם דיכוי התקלות — הוא בודק `started_at <= now`.
CREATE OR REPLACE FUNCTION public.schedule_maintenance(
  p_site_code text,
  p_start_at  timestamptz,
  p_end_at    timestamptz,
  p_reason    text DEFAULT NULL
)
RETURNS TABLE (id integer, started_at text, expires_at text, set_by_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_name    text := app.actor_display_name();
  v_role    text;
  v_site_id integer;
  v_hours   numeric;
  v_started text;
  v_expires text;
  v_id      integer;
BEGIN
  -- ⚠️ אותו כלל כמו בפתיחה מיידית: **כל משתמש פעיל**, בלי דרישת תפקיד.
  -- ההחלטה היא ייחוס במקום מנע — אנשי שירות מתזמנים בשטח.
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'נדרשת הזדהות' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_role := app.current_app_role();

  IF p_start_at IS NULL OR p_end_at IS NULL THEN
    RAISE EXCEPTION 'חסרה שעת התחלה או סיום' USING ERRCODE = 'check_violation';
  END IF;
  IF p_end_at <= p_start_at THEN
    RAISE EXCEPTION 'שעת הסיום חייבת להיות אחרי שעת ההתחלה'
      USING ERRCODE = 'check_violation';
  END IF;

  v_hours := EXTRACT(EPOCH FROM (p_end_at - p_start_at)) / 3600.0;
  -- ⚠️ אותה תקרה של 720 שעות. חלון ארוך יותר משתיק אתר לחודש, ובלי גבול
  -- טעות הקלדה בתאריך הופכת ל"האתר נעלם מהמדדים" בלי שאיש ישים לב.
  IF v_hours > 720 THEN
    RAISE EXCEPTION 'החלון ארוך מ-720 שעות' USING ERRCODE = 'check_violation';
  END IF;

  -- ⚠️ **גבול על העבר, ולא רק על העתיד.** חלון שמתחיל שבוע אחורה היה
  -- משנה למפרע זמינות שכבר דווחה — מספרים שאנשים כבר ראו. שעה של חסד
  -- מכסה תיקון של מי שהתחיל לתעד באיחור.
  IF p_start_at < now() - interval '1 hour' THEN
    RAISE EXCEPTION 'לא ניתן לתזמן חלון שהתחיל לפני יותר משעה'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT s.id INTO v_site_id FROM sites s WHERE s.code = p_site_code;
  IF v_site_id IS NULL THEN
    RAISE EXCEPTION 'אתר לא נמצא: %', p_site_code USING ERRCODE = 'PT404';
  END IF;

  v_started := to_char(p_start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_expires := to_char(p_end_at   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  INSERT INTO maintenance_windows
    (site_id, set_by_name, set_by_role, reason, started_at, duration_hours, expires_at)
  VALUES
    (v_site_id, v_name, v_role, NULLIF(TRIM(COALESCE(p_reason, '')), ''),
     v_started, ROUND(v_hours, 2), v_expires)
  RETURNING maintenance_windows.id INTO v_id;

  PERFORM app.record_write_audit('maintenance.schedule', v_name, v_role,
                                 'site', p_site_code,
                                 jsonb_build_object('start_at', v_started,
                                                    'end_at', v_expires,
                                                    'hours', ROUND(v_hours, 2)));
  PERFORM app.record_write_event(p_site_code, 'maintenance',
                                 jsonb_build_object('type', 'maintenance',
                                                    'code', p_site_code,
                                                    'scheduled', true));

  RETURN QUERY SELECT v_id, v_started, v_expires, v_name;
END;
$fn$;

REVOKE ALL ON FUNCTION public.schedule_maintenance(text, timestamptz, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.schedule_maintenance(text, timestamptz, timestamptz, text) TO authenticated;
