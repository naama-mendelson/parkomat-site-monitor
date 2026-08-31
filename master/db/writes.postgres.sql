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
-- ⚠️ **שתי החתימות נמחקות, וזה לא כפילות.** ההחלפה הגורפת ששינתה את
-- ההפניות שינתה גם את ה-DROP הזה, ואז הגרסה בת שלושת הפרמטרים שרדה
-- לצד החדשה — כלומר היה אפשר לקרוא לה ולעקוף את דרישת השם לגמרי.
DROP FUNCTION IF EXISTS public.start_maintenance(text, numeric, text);
-- ⚠️ גם החתימה בת ארבעת הפרמטרים: שינוי טיפוס ההחזרה מחייב DROP,
-- ו-CREATE OR REPLACE לבדו נכשל על מסד שכבר מחזיק גרסה קודמת.
DROP FUNCTION IF EXISTS public.start_maintenance(text, numeric, text, text);

CREATE OR REPLACE FUNCTION public.start_maintenance(
  p_site_code      text,
  p_duration_hours numeric,
  p_reason         text DEFAULT NULL,
  -- ============================================================
  -- ⚠️ מי בפועל — שדה נפרד, ולא תחליף לזהות המאומתת
  -- ============================================================
  -- `set_by_name` נגזר מהאסימון ולעולם לא מגוף הבקשה. זה הכלל שמפריד
  -- בין ייחוס להצהרה, והוא לא משתנה. אבל הוא עונה על "איזה **חשבון**
  -- עשה את זה", ולא על "**מי** עמד שם".
  --
  -- ⚠️ ובפועל: sherut@parkomat.co.il הוא תיבה משותפת, ולכל שמונת
  -- המשתמשים אין full_name — כך שכל חלון נרשם על כתובת מייל שאינה
  -- מזהה אדם. השדה הזה נשמר **לצד** החשבון ולא במקומו, כדי שמי שקורא
  -- את היומן ידע מה מאומת ומה נאמר.
  p_performed_by   text DEFAULT NULL
)
RETURNS TABLE (id integer, started_at text, expires_at text,
               set_by_name text, performed_by text)
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
  v_by      text;
BEGIN
  -- ⚠️ ראשית הזהות, ולפני כל דבר אחר: SECURITY DEFINER עוקף RLS, ולכן
  -- זו ההגנה היחידה שיש כאן.
  v_name := app.actor_display_name();
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'נדרשת הזדהות' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_role := app.current_app_role();

  -- ⚠️ **חובה, ולא רשות.** בלי אכיפה השדה היה נשאר ריק ברוב הפעמים,
  -- ואז הוא גרוע מכלום: הוא מבטיח מידע שאינו שם. שני תווים לפחות, כדי
  -- שרווח בודד לא ייחשב תשובה.
  v_by := NULLIF(TRIM(COALESCE(p_performed_by, '')), '');
  IF v_by IS NULL OR length(v_by) < 2 THEN
    RAISE EXCEPTION 'חובה לציין מי מבצע את התחזוקה (שם מלא)'
      USING ERRCODE = 'check_violation';
  END IF;

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
    (site_id, set_by_name, set_by_role, reason, started_at, duration_hours, expires_at,
     performed_by)
  VALUES
    (v_site_id, v_name, v_role, NULLIF(TRIM(COALESCE(p_reason, '')), ''),
     v_started, p_duration_hours, v_expires, v_by)
  RETURNING maintenance_windows.id INTO v_id;

  PERFORM app.record_write_audit('maintenance.start', v_name, v_role,
                                 'site', p_site_code,
                                 jsonb_build_object('duration_hours', p_duration_hours,
                                                    'expires_at', v_expires,
                                                    'performed_by', v_by));
  PERFORM app.record_write_event(p_site_code, 'maintenance',
                                 jsonb_build_object('type', 'maintenance',
                                                    'code', p_site_code,
                                                    'action', 'start'));

  RETURN QUERY SELECT v_id, v_started, v_expires, v_name, v_by;
END;
$$;

COMMENT ON FUNCTION public.start_maintenance(text, numeric, text, text) IS
  'פתיחת חלון תחזוקה מהדפדפן. השם נגזר מהזהות המאומתת; הזמנים מחושבים כאן.';

-- ============================================================
-- public.cancel_maintenance — ביטול החלון הפעיל
-- ============================================================
-- ⚠️ נוגע ב-`cancelled_at` בלבד. זו הסיבה שזו פונקציה ולא `GRANT UPDATE`:
-- הרשאת עמודה־כל היא רחבה מדי לפעולה שמשנה שדה אחד.
DROP FUNCTION IF EXISTS public.cancel_maintenance(text);
DROP FUNCTION IF EXISTS public.cancel_maintenance(text, text);

-- ⚠️ **גם הביטול דורש שם.** זו הפעולה שמחזירה אתר לספירה: מרגע
-- הביטול תקלות נספרות שוב והזמינות מושפעת. מי שסוגר חלון מוקדם עושה
-- החלטה תפעולית, ולא פחות מזו שפתחה אותו.
CREATE OR REPLACE FUNCTION public.cancel_maintenance(
  p_site_code    text,
  p_performed_by text DEFAULT NULL
)
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
  v_by      text;
BEGIN
  v_name := app.actor_display_name();
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'נדרשת הזדהות' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_role := app.current_app_role();

  -- אותה אכיפה בדיוק כמו בפתיחה: ריק, רווח או תו בודד נדחים.
  v_by := NULLIF(TRIM(COALESCE(p_performed_by, '')), '');
  IF v_by IS NULL OR length(v_by) < 2 THEN
    RAISE EXCEPTION 'חובה לציין מי מבטל את התחזוקה (שם מלא)'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT s.id INTO v_site_id FROM sites s WHERE s.code = p_site_code;
  IF v_site_id IS NULL THEN
    RAISE EXCEPTION 'אתר לא נמצא: %', p_site_code USING ERRCODE = 'PT404';
  END IF;

  -- אותו תנאי בדיוק כמו ב-cancelMaintenance ב-JS: רק חלון פעיל ולא שפג.
  UPDATE maintenance_windows m
     SET cancelled_at = v_now,
         cancelled_by = v_by
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

COMMENT ON FUNCTION public.cancel_maintenance(text, text) IS
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
REVOKE ALL ON FUNCTION public.start_maintenance(text, numeric, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_maintenance(text, text)               FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.start_maintenance(text, numeric, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_maintenance(text, text)               TO authenticated;

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
  -- ⚠️ הגורם השני נבדק **אחרי** התפקיד ולא לפניו: מי שאינו מנהל צריך
  -- לשמוע שהפעולה אינה שלו, לא שחסר לו קוד. הודעה על MFA למי שממילא
  -- אינו מורשה מזמינה אותו להירשם ל-TOTP ולנסות שוב לשווא.
  PERFORM app.require_mfa();

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

-- ============================================================
-- סיווג מחדש של תקלה לתחזוקה
-- ============================================================
-- ⚠️ **הסטטוס המקורי אינו נמחק.** `status` נשאר 'error' לנצח, ו-
-- `reclassified_to` הוא שכבה מעליו. זו הדרישה המפורשת: לראות **מה זה היה
-- לפני** ומי שינה — ו-UPDATE על status היה מוחק בדיוק את זה.
--
-- ⚠️ ולכן כל מדד חייב לקרוא `COALESCE(reclassified_to, status)`. שכחה
-- באחד מהם פירושה שהמסך אומר "תחזוקה" והזמינות סופרת תקלה — שני מספרים
-- לאותו אירוע, וזה הכשל שקשה ביותר לאתר.
--
-- ⚠️ ורק ל'maintenance': הפיכת תקלה ל'מוכן' הייתה **מוחקת אירוע** במקום
-- לסווגו מחדש, ואת זה כבר עושה סימון הניסוי — שם זה מפורש.
CREATE OR REPLACE FUNCTION public.reclassify_status(p_id integer, p_to text)
RETURNS TABLE (id integer, was text, now_is text, by_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_name text := app.actor_display_name();
  v_row  record;
BEGIN
  -- ⚠️ **מנהל בלבד.** בשונה מפתיחת תחזוקה, שהיא ייחוס-במקום-מנע, כאן
  -- משנים אירוע שכבר נרשם — והשינוי מוריד תקלה מאחוז הכשל.
  IF NOT app.is_manager() THEN
    RAISE EXCEPTION 'הפעולה מותרת למנהלים בלבד' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_row FROM status_history WHERE status_history.id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'השורה לא נמצאה' USING ERRCODE = 'PT404';
  END IF;

  -- p_to = NULL מבטל את הסיווג ומחזיר למקור.
  IF p_to IS NOT NULL AND p_to <> 'maintenance' THEN
    RAISE EXCEPTION 'ניתן לסווג מחדש רק לתחזוקה' USING ERRCODE = 'check_violation';
  END IF;
  IF p_to IS NOT NULL AND v_row.status <> 'error' THEN
    RAISE EXCEPTION 'רק מקטע תקלה ניתן לסיווג מחדש' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE status_history SET
    reclassified_to = p_to,
    reclassified_by = CASE WHEN p_to IS NULL THEN NULL ELSE v_name END,
    reclassified_at = CASE WHEN p_to IS NULL THEN NULL
      ELSE to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
  WHERE status_history.id = p_id;

  PERFORM app.record_write_audit(
    CASE WHEN p_to IS NULL THEN 'status.reclassify-undo' ELSE 'status.reclassify' END,
    v_name, 'manager', 'status', p_id::text,
    jsonb_build_object('was', v_row.status, 'to', p_to, 'at', v_row.started_at));

  RETURN QUERY SELECT p_id, v_row.status, COALESCE(p_to, v_row.status), v_name;
END;
$fn$;

REVOKE ALL ON FUNCTION public.reclassify_status(integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reclassify_status(integer, text) TO authenticated;

-- ============================================================
-- submit_field_report — דיווח מהשטח
-- ============================================================
-- ⚠️ **כל התקרות נאכפות כאן ולא בדפדפן.** הדפדפן דוחס תמונות לפני
-- השליחה כי זה חוסך רשת, אבל הוא אינו גבול — DevTools פתוח עוקף כל בדיקה
-- שיושבת שם. אותו עיקרון בדיוק כמו start_maintenance.
-- ⚠️ **ה-DROP חובה, ואינו קישוט.** הוספת פרמטר יוצרת **עומס** ולא
-- החלפה: הגרסה בת שלושת הפרמטרים הייתה שורדת לצד החדשה, וכל קורא
-- שיפנה אליה עוקף את דרישת השם לגמרי. זה בדיוק מה שקרה פעם
-- ב-start_maintenance, ולכן שם יש שני DROP ולא אחד.
DROP FUNCTION IF EXISTS public.submit_field_report(text, text, jsonb);

CREATE OR REPLACE FUNCTION public.submit_field_report(
  p_body      text,
  p_site_code text  DEFAULT NULL,
  -- מערך של {mime, data} — data הוא base64 נטו, בלי הקידומת data:.
  p_files     jsonb DEFAULT '[]'::jsonb,
  -- מי **בפועל**. חובה — ראה ההסבר ליד העמודה בסכימה.
  p_reported_by_name text DEFAULT NULL
)
RETURNS TABLE (id bigint, created_at text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
DECLARE
  v_actor   text;
  v_user_id integer;
  v_site_id integer;
  v_body    text;
  v_name    text;
  v_now     text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_id      bigint;
  v_file    jsonb;
  v_bytes   integer;
  v_count   integer := 0;
  v_total   integer := 0;
BEGIN
  -- ⚠️ הזהות ראשונה: SECURITY DEFINER עוקף RLS, ולכן זו ההגנה היחידה כאן.
  v_actor := app.actor_display_name();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'נדרשת הזדהות' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_user_id := app.current_app_user();

  -- ⚠️ **חובה, ולא רשות.** בלי אכיפה השדה היה נשאר ריק ברוב הפעמים,
  -- ואז הוא גרוע מכלום: הוא מבטיח מידע שאינו שם. שני תווים לפחות, כדי
  -- שרווח בודד לא ייחשב תשובה — אותו סף בדיוק כמו בתחזוקה.
  v_name := NULLIF(TRIM(COALESCE(p_reported_by_name, '')), '');
  IF v_name IS NULL OR length(v_name) < 2 THEN
    RAISE EXCEPTION 'חובה לציין שם' USING ERRCODE = 'check_violation';
  END IF;

  v_body := NULLIF(TRIM(COALESCE(p_body, '')), '');
  IF v_body IS NULL OR length(v_body) < 5 THEN
    RAISE EXCEPTION 'הדיווח קצר מדי — כתוב לפחות כמה מילים'
      USING ERRCODE = 'check_violation';
  END IF;
  -- ⚠️ תקרה על הטקסט: בלי גבול, הדבקה של לוג שלם נכנסת לטבלה ומתפוצצת
  -- על המסך שאמור להיות רשימה קריאה.
  IF length(v_body) > 4000 THEN
    RAISE EXCEPTION 'הדיווח ארוך מדי (מעל 4000 תווים)'
      USING ERRCODE = 'check_violation';
  END IF;

  -- אתר אופציונלי. קוד שהוקלד ואינו קיים הוא טעות ולא "בלי אתר" —
  -- שתיקה כאן הייתה מצמידה את הדיווח לשום מקום בלי שהמדווח ידע.
  IF NULLIF(TRIM(COALESCE(p_site_code, '')), '') IS NOT NULL THEN
    SELECT s.id INTO v_site_id FROM sites s WHERE s.code = TRIM(p_site_code);
    IF v_site_id IS NULL THEN
      RAISE EXCEPTION 'אתר לא נמצא: %', p_site_code USING ERRCODE = 'PT404';
    END IF;
  END IF;

  INSERT INTO field_reports (site_id, body, reported_by, reported_by_name,
                             reported_by_user_id, created_at, status)
  VALUES (v_site_id, v_body, v_actor, v_name, v_user_id, v_now, 'open')
  RETURNING field_reports.id INTO v_id;

  -- ============================================================
  -- ⚠️ הקבצים — תקרה לכל אחד, תקרה לסך הכול, ותקרה למספר
  -- ============================================================
  -- התוכנית החינמית היא 500MB וכל נתוני היישום הם ~1MB. תמונה אחת לא
  -- דחוסה מהטלפון היא 2–5MB, כלומר בלי תקרה עשרה דיווחים מכפילים את כל
  -- המסד. base64 מנפח ב-33%, ולכן הבדיקה על הגודל **אחרי** הפענוח.
  FOR v_file IN SELECT * FROM jsonb_array_elements(COALESCE(p_files, '[]'::jsonb))
  LOOP
    v_count := v_count + 1;
    IF v_count > 4 THEN
      RAISE EXCEPTION 'אפשר לצרף עד 4 תמונות' USING ERRCODE = 'check_violation';
    END IF;

    IF v_file->>'mime' IS NULL OR v_file->>'mime' NOT IN
       ('image/png', 'image/jpeg', 'image/webp') THEN
      -- ⚠️ רשימת היתר ולא רשימת איסור: קובץ שאינו תמונה נשמר כטקסט
      -- ומוצג ב-<img>, כלומר במקרה הטוב לא עובד ובמקרה הרע הוא וקטור.
      RAISE EXCEPTION 'סוג קובץ לא נתמך — רק PNG, JPEG או WEBP'
        USING ERRCODE = 'check_violation';
    END IF;

    -- אורך ה-base64 ×3/4 הוא גודל הבתים בפועל.
    v_bytes := (length(COALESCE(v_file->>'data', '')) * 3) / 4;
    IF v_bytes = 0 THEN
      RAISE EXCEPTION 'קובץ ריק' USING ERRCODE = 'check_violation';
    END IF;
    IF v_bytes > 2 * 1024 * 1024 THEN
      RAISE EXCEPTION 'תמונה גדולה מדי (מעל 2MB אחרי דחיסה)'
        USING ERRCODE = 'check_violation';
    END IF;
    v_total := v_total + v_bytes;
    IF v_total > 5 * 1024 * 1024 THEN
      RAISE EXCEPTION 'סך התמונות גדול מדי (מעל 5MB)'
        USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO field_report_files (report_id, mime, data_b64, byte_size, created_at)
    VALUES (v_id, v_file->>'mime', v_file->>'data', v_bytes, v_now);
  END LOOP;

  -- ⚠️ שורת ביקורת, בדיוק כמו כל כתיבה אחרת מהדפדפן.
  -- ⚠️ דרך app.record_write_audit ולא INSERT ישיר: העמודות האמיתיות הן
  -- actor_name/actor_role/trust/target_*, ו-INSERT מומצא היה נכשל רק
  -- **בזמן ריצה** — plpgsql אינו מאמת שמות עמודות ביצירת הפונקציה.
  PERFORM app.record_write_audit(
    'field_report.submit', v_actor, app.current_app_role(),
    'field_report', v_id::text,
    jsonb_build_object('site_code', p_site_code, 'files', v_count, 'by', v_name));

  RETURN QUERY SELECT v_id, v_now;
END;
$$;

-- ============================================================
-- resolve_field_report — סימון "טופל"
-- ============================================================
-- ⚠️ מנהלת בלבד: הדיווח נשלח אליה, וסגירתו היא ההחלטה שלה. בלי הגבלה
-- המדווח היה יכול לסגור את הדיווח של עצמו — ואז אין תיבה, יש רק רשימה.
CREATE OR REPLACE FUNCTION public.resolve_field_report(
  p_id   bigint,
  p_note text DEFAULT NULL
)
RETURNS TABLE (updated integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
DECLARE
  v_actor text;
  v_now   text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_n     integer;
BEGIN
  v_actor := app.actor_display_name();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'נדרשת הזדהות' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM app.require_manager();

  UPDATE field_reports
     SET status = 'done', resolved_at = v_now, resolved_by = v_actor,
         resolved_note = NULLIF(TRIM(COALESCE(p_note, '')), '')
   WHERE field_reports.id = p_id AND field_reports.status <> 'done';
  GET DIAGNOSTICS v_n = ROW_COUNT;

  IF v_n > 0 THEN
    PERFORM app.record_write_audit(
      'field_report.resolve', v_actor, app.current_app_role(),
      'field_report', p_id::text, NULL);
  END IF;

  -- ⚠️ 0 אינו כשל: ייתכן ששניים לחצו יחד, או שהוא כבר טופל. זריקה כאן
  -- הייתה הופכת מקרה תקין לשגיאה על המסך.
  RETURN QUERY SELECT v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_field_report(text, text, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.resolve_field_report(bigint, text)     FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_field_report(text, text, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_field_report(bigint, text)     TO authenticated;

-- ============================================================
-- mark_announcement_seen — "ראיתי, אל תציג לי שוב"
-- ============================================================
-- ⚠️ RPC ולא GRANT UPDATE על app_users. עם הרשאת עדכון ישירה הדפדפן היה
-- יכול לשנות **כל** עמודה בשורה שלו — כולל `role` ו-`is_active`. אותו
-- נימוק בדיוק שבגללו כל הכתיבות כאן הן פונקציות.
CREATE OR REPLACE FUNCTION public.mark_announcement_seen(p_key text)
RETURNS TABLE (seen text[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
DECLARE
  v_user_id integer;
  v_key     text;
BEGIN
  v_user_id := app.current_app_user();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'נדרשת הזדהות' USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_key := NULLIF(TRIM(COALESCE(p_key, '')), '');
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'חסר מזהה הכרזה' USING ERRCODE = 'check_violation';
  END IF;

  -- ⚠️ array_append לא היה מספיק: לחיצה כפולה (או שתי לשוניות פתוחות)
  -- הייתה מוסיפה את אותו מפתח פעמיים והמערך היה גדל בלי גבול. התנאי
  -- הופך את זה לאידמפוטנטי.
  UPDATE app_users u
     SET seen_announcements = array_append(u.seen_announcements, v_key)
   WHERE u.id = v_user_id
     AND NOT (v_key = ANY(u.seen_announcements));

  RETURN QUERY
    SELECT u.seen_announcements FROM app_users u WHERE u.id = v_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_announcement_seen(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_announcement_seen(text) TO authenticated;

-- ============================================================
-- my_seen_announcements — אילו הכרזות **אני** כבר ראיתי
-- ============================================================
-- ⚠️ RPC ולא `select` על app_users, ומלכודת מתועדת: הטבלה קריאה לכל
-- מחובר, ולכן `.select("seen_announcements").limit(1)` מחזיר את **השורה
-- הראשונה בטבלה** ולא את שלי. אותו באג בדיוק נפל פעם ב-pushDirect,
-- והתסמין שם היה 403 שנראה כמו בעיית הרשאות ובאמת היה מזהה שגוי.
--
-- כאן התסמין היה גרוע יותר: אין שגיאה בכלל — ההכרזה פשוט לא הייתה קופצת
-- למי שמישהו אחר כבר סגר אותה.
CREATE OR REPLACE FUNCTION public.my_seen_announcements()
RETURNS TABLE (seen text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
  SELECT u.seen_announcements FROM app_users u WHERE u.id = app.current_app_user();
$$;

REVOKE ALL ON FUNCTION public.my_seen_announcements() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_seen_announcements() TO authenticated;

-- ============================================================
-- publish_announcement — כתיבת הודעת מערכת
-- ============================================================
-- ⚠️ מנהלת בלבד. הודעה כזו קופצת על המסך של **כל** מי שנכנס ועוצרת אותו
-- עד שילחץ — זו הפרעה יזומה לכל החברה, ולא הערה בפינה.
CREATE OR REPLACE FUNCTION public.publish_announcement(
  p_title text,
  p_body  text
)
RETURNS TABLE (id bigint, created_at text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
DECLARE
  v_actor text;
  v_title text;
  v_body  text;
  v_now   text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_id    bigint;
BEGIN
  v_actor := app.actor_display_name();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'נדרשת הזדהות' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM app.require_manager();

  v_title := NULLIF(TRIM(COALESCE(p_title, '')), '');
  v_body  := NULLIF(TRIM(COALESCE(p_body, '')), '');
  IF v_title IS NULL OR length(v_title) < 2 THEN
    RAISE EXCEPTION 'חסרה כותרת להודעה' USING ERRCODE = 'check_violation';
  END IF;
  IF v_body IS NULL OR length(v_body) < 5 THEN
    RAISE EXCEPTION 'ההודעה קצרה מדי' USING ERRCODE = 'check_violation';
  END IF;
  IF length(v_title) > 120 OR length(v_body) > 2000 THEN
    RAISE EXCEPTION 'ההודעה ארוכה מדי (כותרת עד 120, גוף עד 2000)'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO announcements (title, body, created_by, created_at)
  VALUES (v_title, v_body, v_actor, v_now)
  RETURNING announcements.id INTO v_id;

  PERFORM app.record_write_audit(
    'announcement.publish', v_actor, app.current_app_role(),
    'announcement', v_id::text, jsonb_build_object('title', v_title));

  RETURN QUERY SELECT v_id, v_now;
END;
$$;

-- ============================================================
-- pending_announcement — ההודעה הראשונה שטרם ראיתי
-- ============================================================
-- ⚠️ ההצטלבות נעשית **כאן ולא בדפדפן**. שליחת כל ההודעות ללקוח כדי שיסנן
-- בעצמו הייתה עובדת, אבל היא גדלה בלי גבול עם השנים — ומי שנכנס בפעם
-- הראשונה היה מקבל את כל ההיסטוריה ורואה אותה אחת-אחת.
--
-- ⚠️ ORDER BY id — הישנה ביותר קודם. מי שהיה בחופשה יראה אותן לפי הסדר
-- שבו נכתבו, ולא מהסוף להתחלה.
CREATE OR REPLACE FUNCTION public.pending_announcement()
RETURNS TABLE (id bigint, title text, body text, created_at text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
  SELECT a.id, a.title, a.body, a.created_at
    FROM announcements a
   WHERE a.is_active
     AND NOT (a.id::text = ANY(
           SELECT unnest(u.seen_announcements) FROM app_users u
            WHERE u.id = app.current_app_user()))
     AND app.current_app_user() IS NOT NULL
   ORDER BY a.id
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.publish_announcement(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pending_announcement()          FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.publish_announcement(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pending_announcement()           TO authenticated;

-- ============================================================
-- broadcast_reload — רענון יזום לכל מי שפתוח
-- ============================================================
-- ⚠️ **זו הפרעה כפויה, ולכן מנהלת בלבד.** הדף נטען מחדש מתחת לידיים של
-- כל מי שמחובר, ומי שהיה באמצע כתיבה מאבד את מה שכתב. זה בדיוק מה שקרה
-- היום כשמישהו איבד דיווח — ההבדל היחיד הוא שכאן זה יזום.
--
-- ⚠️ ולכן הטיוטה נשמרת מקומית לפני הרענון (ראה FieldReports). בלי זה
-- הכלי הזה מייצר את התקלה שהוא נכתב אחריה.
--
-- ⚠️ דרך `events` ולא ערוץ משלו: זו טבלת חוזה האירועים של המערכת, כל
-- דשבורד כבר מנוי עליה, ואירוע רענון אינו סוד — אין כאן מה להדליף.
CREATE OR REPLACE FUNCTION public.broadcast_reload()
RETURNS TABLE (id bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
DECLARE
  v_actor text;
  v_now   text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_id    bigint;
BEGIN
  v_actor := app.actor_display_name();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'נדרשת הזדהות' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM app.require_manager();

  -- ⚠️ site_code הוא NOT NULL, ולכן אירוע כלל-מערכתי מקבל סמן ולא NULL.
  -- 'system' ולא קוד אתר אמיתי: applySiteUpdate בדשבורד מתאים אירועים
  -- לפי הקוד, וקוד קיים היה גורם לו לעדכן אתר אקראי בטעות.
  INSERT INTO events (site_code, type, payload, created_at)
  VALUES ('system', 'reload',
          jsonb_build_object('at', v_now, 'by', v_actor),
          v_now)
  RETURNING events.id INTO v_id;

  PERFORM app.record_write_audit(
    'dashboard.reload', v_actor, app.current_app_role(), 'dashboard', v_id::text, NULL);

  RETURN QUERY SELECT v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.broadcast_reload() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broadcast_reload() TO authenticated;

-- ============================================================
-- reply_to_field_report — תשובה בשיחה, לשני הכיוונים
-- ============================================================
-- ⚠️ **לא רק מנהלת.** מי שדיווח יכול לענות בחזרה — אחרת זו הודעה ולא
-- שיחה, ומי ששאלו אותו "באיזה שער בדיוק?" לא יכול לענות.
--
-- ⚠️ אבל **רק בשיחה שלו**: הבדיקה היא בדיוק זו שב-RLS — מנהלת, או בעל
-- הדיווח. בלעדיה כל מאומת היה יכול להשתחל לשיחה של אחר.
CREATE OR REPLACE FUNCTION public.reply_to_field_report(
  p_report_id bigint,
  p_body      text
)
RETURNS TABLE (id bigint, created_at text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
DECLARE
  v_actor  text;
  v_user   integer;
  v_body   text;
  v_now    text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_id     bigint;
  v_owner  integer;
  v_name   text;
BEGIN
  v_actor := app.actor_display_name();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'נדרשת הזדהות' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_user := app.current_app_user();

  v_body := NULLIF(TRIM(COALESCE(p_body, '')), '');
  IF v_body IS NULL OR length(v_body) < 1 THEN
    RAISE EXCEPTION 'התשובה ריקה' USING ERRCODE = 'check_violation';
  END IF;
  IF length(v_body) > 2000 THEN
    RAISE EXCEPTION 'התשובה ארוכה מדי (מעל 2000 תווים)' USING ERRCODE = 'check_violation';
  END IF;

  SELECT r.reported_by_user_id INTO v_owner
    FROM field_reports r WHERE r.id = p_report_id;
  IF NOT FOUND THEN
    -- ⚠️ PT404 ולא no_data_found: PostgREST ממפה P0002 ל-500, כלומר
    -- "תקלת שרת" על מזהה שכבר נמחק.
    RAISE EXCEPTION 'הדיווח לא נמצא' USING ERRCODE = 'PT404';
  END IF;

  IF NOT (app.is_manager() OR v_owner = v_user) THEN
    RAISE EXCEPTION 'אפשר לענות רק בשיחה שלך' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- ⚠️ השם המוקלד נלקח **מהדיווח עצמו** כשהמשיב הוא בעל הדיווח: הוא כבר
  -- אמר מי הוא, ואין סיבה לשאול שוב בכל הודעה.
  SELECT r.reported_by_name INTO v_name
    FROM field_reports r WHERE r.id = p_report_id AND r.reported_by_user_id = v_user;

  INSERT INTO field_report_replies (report_id, body, author, author_name, created_at)
  VALUES (p_report_id, v_body, v_actor, v_name, v_now)
  RETURNING field_report_replies.id INTO v_id;

  -- ⚠️ תשובה **פותחת מחדש** דיווח שנסגר: אם מישהו הוסיף פרט אחרי הסגירה,
  -- הוא הולך לאיבוד בתיבה של "טופל".
  UPDATE field_reports r
     SET status = 'open', resolved_at = NULL, resolved_by = NULL
   WHERE r.id = p_report_id AND r.status = 'done' AND NOT app.is_manager();

  RETURN QUERY SELECT v_id, v_now;
END;
$$;

REVOKE ALL ON FUNCTION public.reply_to_field_report(bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reply_to_field_report(bigint, text) TO authenticated;

-- ============================================================
-- delete_field_report — מחיקה, ולא רק "טופל"
-- ============================================================
-- ⚠️ מנהלת בלבד: זו התיבה שלה. מחיקה בידי המדווח הייתה מאפשרת לו למחוק
-- דיווח **אחרי** שנענה, ולהעלים את השיחה מתחת לידיים של מי שטיפל בו.
--
-- ⚠️ **מחיקה אמיתית ולא הסתרה.** דיווח אינו מדד — שום זמינות ושום אחוז
-- כשל אינם נשענים עליו — ולכן אין כאן את השיקול שהוליד את `excluded_at`.
-- הסתרה הייתה משאירה לבעל הדיווח שיחה פתוחה שהמנהלת כבר לא רואה, כלומר
-- שני מסכים שמספרים דברים שונים על אותה שיחה.
--
-- ⚠️ אבל **הביקורת שומרת את מה שנמחק**: מי כתב, מתי, ותחילת הטקסט. בלי
-- זה מחיקה היא היעלמות מוחלטת, ו-"לא נספר" ו"לא קרה" הם שני דברים שונים
-- גם כאן. התמונות והשיחה יורדות ב-CASCADE.
CREATE OR REPLACE FUNCTION public.delete_field_report(p_id bigint)
RETURNS TABLE (deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
DECLARE
  v_actor  text;
  v_row    field_reports%ROWTYPE;
  v_files  integer;
  v_count  integer;
BEGIN
  v_actor := app.actor_display_name();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'נדרשת הזדהות' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM app.require_manager();

  SELECT * INTO v_row FROM field_reports r WHERE r.id = p_id;
  IF NOT FOUND THEN
    -- ⚠️ 0 ולא שגיאה: שניים שלחצו יחד, או שכבר נמחק. זה לא כשל.
    RETURN QUERY SELECT 0;
    RETURN;
  END IF;

  SELECT COUNT(*)::int INTO v_files FROM field_report_files f WHERE f.report_id = p_id;

  -- ⚠️ הביקורת **לפני** המחיקה: אחריה אין ממה לבנות אותה.
  PERFORM app.record_write_audit(
    'field_report.delete', v_actor, app.current_app_role(),
    'field_report', p_id::text,
    jsonb_build_object(
      'by', COALESCE(v_row.reported_by_name, v_row.reported_by),
      'account', v_row.reported_by,
      'created_at', v_row.created_at,
      'files', v_files,
      -- מספיק כדי לזהות מה נמחק, ולא מספיק כדי לשמור עותק שלם.
      'excerpt', left(v_row.body, 120)));

  DELETE FROM field_reports r WHERE r.id = p_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN QUERY SELECT v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_field_report(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_field_report(bigint) TO authenticated;

-- ============================================================
-- הכפתור "הפעל מחדש את השרת" — שלוש פונקציות, שלושה קוראים שונים
-- ============================================================
-- ⚠️ **הכפתור נחוץ בדיוק כשהשרת לא עונה**, ולכן הוא אינו יכול לעבור
-- דרכו. הדשבורד כותב לטבלה ב-Supabase; סקריפט על מכונת השרת, שרץ
-- **מחוץ ל-Docker**, קורא ומבצע. שני הצדדים אינם מכירים זה את זה.
--
-- החלוקה: request מהדפדפן (מנהלת), claim ו-complete מהסקריפט בלבד.

-- מבקשת הפעלה מחדש. מנהלת בלבד.
CREATE OR REPLACE FUNCTION public.request_service_restart(p_reason text DEFAULT NULL)
RETURNS TABLE (id bigint, status text, message text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
DECLARE
  v_actor  text;
  v_now    text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_open   service_commands%ROWTYPE;
  v_id     bigint;
BEGIN
  v_actor := app.actor_display_name();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'נדרשת הזדהות' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM app.require_manager();

  -- ============================================================
  -- ⚠️ פקיעה **לפני** בדיקת הריסון — אחרת הכפתור נועל את עצמו
  -- ============================================================
  -- הפקיעה ישבה רק ב-claim_service_command, שאותה קורא **המבצע בלבד**.
  -- כשהמבצע אינו רץ, הבקשה נשארת pending לנצח, והריסון שמתחתיה מסרב
  -- ליצור בקשה חדשה — לעולם.
  --
  -- ⚠️ נמדד בייצור: בקשה #12 מ-30/08 16:27 נשארה תלויה, והכפתור הפסיק
  -- לעבוד בלי שום הודעה. כלומר **מנגנון החירום נכשל בשקט בדיוק כשהיה
  -- צריך אותו** — אותו דפוס של ההתראה שהחזירה 401.
  UPDATE service_commands c
     SET status = 'expired',
         finished_at = v_now,
         result = 'פגה — המבצע לא הגיב תוך 15 דקות'
   WHERE c.status = 'pending'
     AND c.requested_at < to_char((now() - interval '15 minutes') AT TIME ZONE 'UTC',
                                  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  -- ============================================================
  -- ⚠️ ריסון — והוא לא נימוס, הוא הגנה
  -- ============================================================
  -- הפעלה מחדש לוקחת דקה עד ארבע (Docker Desktop מרים מכונת WSL). מי
  -- שלא רואה תוצאה מיידית לוחצת שוב — וחמש בקשות בתור הן חמש הפעלות
  -- מחדש ברצף, כלומר הכפתור שנועד להציל הופך למי שמפיל.
  SELECT * INTO v_open FROM service_commands c
   WHERE c.status IN ('pending', 'running')
   ORDER BY c.id DESC LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT v_open.id, v_open.status,
      CASE v_open.status
        WHEN 'pending' THEN 'בקשה כבר ממתינה — המכונה תבצע אותה תוך דקה'
        ELSE 'הפעלה מחדש כבר רצה כרגע'
      END;
    RETURN;
  END IF;

  INSERT INTO service_commands (command, status, reason, requested_by, requested_at)
  VALUES ('restart', 'pending', nullif(btrim(coalesce(p_reason, '')), ''), v_actor, v_now)
  RETURNING service_commands.id INTO v_id;

  PERFORM app.record_write_audit(
    'service.restart_requested', v_actor, app.current_app_role(),
    'service_command', v_id::text,
    jsonb_build_object('reason', p_reason));

  RETURN QUERY SELECT v_id, 'pending'::text, 'הבקשה נשלחה — ההפעלה תתחיל תוך דקה'::text;
END;
$$;

-- הסקריפט על מכונת השרת תופס את הפקודה הבאה.
CREATE OR REPLACE FUNCTION public.claim_service_command()
RETURNS TABLE (id bigint, command text, reason text, requested_by text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
DECLARE
  v_now text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  -- ============================================================
  -- ⚠️ בקשה ישנה פגה ואינה מבוצעת
  -- ============================================================
  -- אם הסקריפט היה כבוי שעתיים, הבקשה שממתינה כבר אינה רלוונטית —
  -- ביצועה עכשיו יפיל את השרת בזמן אקראי, אולי דווקא כשהכול תקין.
  -- פקודה היא בקשה לרגע מסוים, לא הוראה עומדת.
  UPDATE service_commands c
     SET status = 'expired',
         finished_at = v_now,
         result = 'פגה — עברו יותר מ-15 דקות מהבקשה'
   WHERE c.status = 'pending'
     AND c.requested_at < to_char((now() - interval '15 minutes') AT TIME ZONE 'UTC',
                                  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  -- ⚠️ **אות חיים של המבצע.** בלעדיו אין שום דרך לדעת שהוא חי: הוא
  -- כותב למסד רק כשיש פקודה, ולכן "אין פקודות" ו"המבצע מת" נראים
  -- זהים לחלוטין. נמדד בייצור — בקשה שנתקעה יומיים בלי שאיש ידע.
  INSERT INTO settings (key, value, updated_at) VALUES ('poller_heartbeat', v_now, v_now)
    ON CONFLICT (key) DO UPDATE SET value = v_now, updated_at = v_now;

  -- ⚠️ FOR UPDATE SKIP LOCKED: אם אי-פעם ירוצו שני מבצעים (בטעות, או
  -- בזמן החלפת מכונה), הם לא ייקחו את אותה פקודה ולא יריצו שתי הפעלות
  -- מחדש במקביל.
  RETURN QUERY
  WITH next AS (
    SELECT c.id FROM service_commands c
     WHERE c.status = 'pending'
     ORDER BY c.id
     LIMIT 1
     FOR UPDATE SKIP LOCKED
  )
  UPDATE service_commands c
     SET status = 'running', claimed_at = v_now
    FROM next
   WHERE c.id = next.id
  RETURNING c.id, c.command, c.reason, c.requested_by;
END;
$$;

-- הסקריפט מדווח מה קרה.
CREATE OR REPLACE FUNCTION public.complete_service_command(
  p_id bigint, p_ok boolean, p_result text DEFAULT NULL)
RETURNS TABLE (updated integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
DECLARE
  v_now text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_n   integer;
BEGIN
  UPDATE service_commands c
     SET status = CASE WHEN p_ok THEN 'done' ELSE 'failed' END,
         finished_at = v_now,
         -- ⚠️ חיתוך ל-2000: הפלט של docker compose יכול להיות ארוך מאוד,
         -- והשורה הזו נקראת במסך. מה שחשוב נמצא בהתחלה ובסוף.
         result = left(coalesce(p_result, ''), 2000)
   WHERE c.id = p_id AND c.status = 'running';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN QUERY SELECT v_n;
END;
$$;

-- ============================================================
-- ⚠️ ההרשאות הן חצי מהתכנון
-- ============================================================
-- `request` פתוחה למאומתים — היא בודקת מנהלת בגוף שלה.
-- `claim` ו-`complete` **סגורות בפני הדפדפן לגמרי**: הן משנות מצב של
-- פקודה, ומשתמש שיקרא להן דרך PostgREST היה יכול לסמן "בוצע" על בקשה
-- שאיש לא ביצע — כלומר להשתיק את הכפתור בלי שאיש ידע. הסקריפט על
-- מכונת השרת מתחבר עם המפתח הסודי ורץ כ-service_role.
REVOKE ALL ON FUNCTION public.request_service_restart(text)               FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_service_command()                     FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_service_command(bigint, boolean, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.request_service_restart(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_service_command()                     TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_service_command(bigint, boolean, text) TO service_role;

-- ============================================================
-- service_health — האם המבצע על מכונת השרת בכלל חי
-- ============================================================
-- ⚠️ **זה מה שחסר, ובגללו כפתור החירום נכשל בשקט.** המבצע כותב למסד רק
-- כשיש פקודה לבצע, ולכן "אין פקודות" ו"המבצע מת" נראים זהים לחלוטין.
--
-- נמדד בייצור: בקשה #12 מ-30/08 16:27 נשארה `pending` יומיים. הכפתור
-- נלחץ, שום דבר לא קרה, ולא היה שום מקום לראות זאת. **מנגנון חירום
-- שנכשל בלי להכריז הוא בדיוק הכשל שהוא בא למנוע.**
--
-- `claim_service_command` כותבת עכשיו `poller_heartbeat` בכל הרצה — גם
-- כשאין מה לבצע — והפונקציה הזו מחזירה את גילו.
CREATE OR REPLACE FUNCTION public.service_health()
RETURNS TABLE (
  poller_seen_at   text,
  poller_age_secs  integer,
  open_command_id  bigint,
  open_status      text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
WITH hb AS (SELECT value AS v FROM settings WHERE key = 'poller_heartbeat')
SELECT
  (SELECT v FROM hb),
  -- ⚠️ NULL ולא 0 כשאין אות חיים: מבצע שטרם רץ מעולם אינו "רץ עכשיו".
  (SELECT EXTRACT(EPOCH FROM (now() - v::timestamptz))::integer FROM hb),
  (SELECT c.id     FROM service_commands c WHERE c.status IN ('pending','running') ORDER BY c.id DESC LIMIT 1),
  (SELECT c.status FROM service_commands c WHERE c.status IN ('pending','running') ORDER BY c.id DESC LIMIT 1);
$$;

-- ⚠️ נשלל מ-PUBLIC: מצב תפעולי אינו לאנונימיים. מנהלת בלבד קוראת
-- למסך הזה, וההגבלה נאכפת ב-RLS על הטבלה עצמה.
REVOKE ALL ON FUNCTION public.service_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.service_health() TO authenticated;

COMMENT ON FUNCTION public.service_health() IS
  'גיל אות החיים של המבצע על מכונת השרת — כדי שכפתור החירום לא ייכשל בשקט.';

-- ============================================================
-- request_service_ping — לבדוק את השרשרת בלי להפיל את השרת
-- ============================================================
-- ⚠️ **בלי זה אי אפשר לוודא שכפתור החירום עובד** — הדרך היחידה לבדוק
-- הייתה להפעיל את השרת מחדש באמת, כלומר להפיל את הקליטה לארבע דקות.
-- מנגנון שבדיקתו יקרה יותר מהתקלה שהוא מונע הוא מנגנון שלא בודקים,
-- ואז מגלים שהוא שבור בדיוק כשצריך אותו. נמדד: בקשה #12 נשארה תלויה
-- יומיים ואיש לא ידע.
--
-- `ping` עוברת את **אותו מסלול בדיוק** — טבלה, תפיסה, דיווח — ורק
-- הפעולה עצמה היא לא-כלום. אם היא חוזרת `done`, כל החוליות חיות.
CREATE OR REPLACE FUNCTION public.request_service_ping()
RETURNS TABLE (id bigint, status text, message text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
DECLARE
  v_actor text;
  v_now   text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_open  service_commands%ROWTYPE;
  v_id    bigint;
BEGIN
  v_actor := app.actor_display_name();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'נדרשת הזדהות' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM app.require_manager();

  -- אותה פקיעה כמו בבקשת ההפעלה מחדש, ומאותה סיבה.
  UPDATE service_commands c
     SET status = 'expired', finished_at = v_now,
         result = 'פגה — המבצע לא הגיב תוך 15 דקות'
   WHERE c.status = 'pending'
     AND c.requested_at < to_char((now() - interval '15 minutes') AT TIME ZONE 'UTC',
                                  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  SELECT * INTO v_open FROM service_commands c
   WHERE c.status IN ('pending', 'running') ORDER BY c.id DESC LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT v_open.id, v_open.status, 'כבר יש פקודה פתוחה — המתיני לה'::text;
    RETURN;
  END IF;

  INSERT INTO service_commands (command, status, reason, requested_by, requested_at)
  VALUES ('ping', 'pending', 'בדיקת חיבור', v_actor, v_now)
  RETURNING service_commands.id INTO v_id;

  RETURN QUERY SELECT v_id, 'pending'::text, 'נשלחה בדיקה — התשובה תגיע תוך דקה'::text;
END;
$$;

REVOKE ALL ON FUNCTION public.request_service_ping() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_service_ping() TO authenticated;
