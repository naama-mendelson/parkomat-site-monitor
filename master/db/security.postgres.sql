-- security.postgres.sql — זהות ומדיניות שורה. נטען אחרי functions.postgres.sql.
--
-- ============================================================
-- הקובץ הזה קיים כדי שדלת היציאה תישאר פתוחה
-- ============================================================
-- ברגע שהדשבורד ידבר עם בסיס הנתונים ישירות, ההרשאות חייבות להיאכף
-- **בבסיס הנתונים** — הסתרת כפתור אינה אבטחה. הדרך המקובלת ב-Supabase היא
-- לכתוב auth.uid() בכל מדיניות. זו בדיוק המלכודת: auth.uid() קיים רק
-- ב-Supabase, ומאגר עם ארבעים מדיניות שמשתמשות בו הוא מאגר שנעול.
--
-- הפתרון הוא הפניה אחת. app.current_actor() קורא את תביעות ה-JWT אם הן
-- קיימות, ואם לא — נופל ל-GUC ברמת הטרנזקציה. שתי הדרכים הן *אותו מנגנון*:
-- גם auth.uid() של Supabase הוא בסך הכול קריאה של
-- current_setting('request.jwt.claims'), ש-PostgREST מציב מתוך ה-JWT.
--
-- המחיר: כעשרים שורות SQL. התמורה: אותו קובץ מדיניות בדיוק רץ על Postgres
-- רגיל, בלי שכתוב.
--
-- ⚠️ מגבלה שצריך להכיר: Supabase Realtime מאשר הרשאות דרך ה-JWT, לא דרך
-- GUC. כלומר מסלול ה-GUC משמש רק קריאות שעוברות דרך שכבת שרת שמציבה אותו.
-- במצב הפעיל ה-JWT הוא מה שחי, ולכן שום דבר לא אובד.

CREATE SCHEMA IF NOT EXISTS app;

-- ============================================================
-- app.current_actor() — מי מבצע את הפעולה
-- ============================================================
-- סדר החיפוש מכוון:
--   1. תביעת 'sub' מתוך request.jwt.claims — מה ש-PostgREST/Supabase מציב.
--   2. app.user_id — GUC שמוצב ע"י שכבת אימות עצמית (SET LOCAL בטרנזקציה).
-- NULL = אין זהות. מדיניות שנשענת על זהות תדחה, וזה הכיוון הבטוח.
--
-- ה-true בפרמטר השני של current_setting הוא missing_ok: בלעדיו הקריאה
-- *זורקת* כשההגדרה אינה קיימת, וזה קורה בכל שאילתה שלא עברה דרך PostgREST
-- — כלומר כל הקליטה. STABLE ולא IMMUTABLE: הערך תלוי בהקשר החיבור.
CREATE OR REPLACE FUNCTION app.current_actor()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claims', true)::json ->> 'sub', ''),
    NULLIF(current_setting('app.user_id', true), '')
  );
$$;

-- ============================================================
-- app.current_role() — התפקיד היישומי, לא תפקיד ה-Postgres
-- ============================================================
-- בקר / מנהל בקרה / מנכ"ל. **אינו** anon/authenticated — אלה תפקידי
-- Postgres, וההבחנה חשובה: תפקיד Postgres אומר "האם התחברת", והתפקיד
-- היישומי אומר "מה מותר לך".
--
-- התביעה נקראת parkomat_role ולא role, כי 'role' תפוס: Supabase מכניס
-- לשם את תפקיד ה-Postgres ('authenticated'), ודריסה שלו הייתה שוברת את
-- PostgREST עצמו.
--
-- ============================================================
-- הוא יושב בתוך app_metadata, ולא כתביעה עליונה
-- ============================================================
-- נבדק מול אסימון אמיתי: Supabase מקנן את app_metadata כאובייקט ואינו
-- משטח אותו. קריאה של התביעה העליונה בלבד הייתה מחזירה NULL תמיד, ולכן
-- כל מדיניות שתישען על התפקיד הייתה מתנהגת כאילו לאיש אין תפקיד.
--
-- הסדר: app_metadata קודם (מה שקיים בפועל), אחריו תביעה עליונה — כי
-- Custom Access Token Hook כן יכול לשטח אותה בעתיד.
--
-- **user_metadata אינו נקרא בכוונה**: המשתמש יכול לערוך אותו בעצמו דרך
-- updateUser, ולכן תפקיד משם היה מאפשר לכל אחד להעלות את עצמו למנכ"ל.
-- app_metadata ניתן לשינוי רק דרך ה-Admin API.
CREATE OR REPLACE FUNCTION app.current_role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claims', true)::json
             -> 'app_metadata' ->> 'parkomat_role', ''),
    NULLIF(current_setting('request.jwt.claims', true)::json ->> 'parkomat_role', ''),
    NULLIF(current_setting('app.role', true), ''),
    'anonymous'
  );
$$;

COMMENT ON FUNCTION app.current_actor() IS
  'מזהה המשתמש: תביעת sub מה-JWT, ואם אין — ה-GUC app.user_id. NULL = אין זהות. '
  'ההפניה הזו היא מה שמאפשר לאותן מדיניות לרוץ גם על Postgres שאינו Supabase.';
COMMENT ON FUNCTION app.current_role() IS
  'התפקיד היישומי (בקר/מנהל/מנכ"ל), לא תפקיד ה-Postgres. ברירת מחדל anonymous.';

-- ============================================================
-- הגבלת דומיין — רק מיילים של החברה יכולים להיכנס
-- ============================================================
-- ============================================================
-- למה טריגר על בסיס הנתונים, ולא בדיקה בנתיב ההזמנה
-- ============================================================
-- יש **שלוש** דרכים שמשתמש נוצר בהן, ובדיקה בנתיב ההזמנה שלנו חוסמת רק
-- אחת מהן:
--   1. POST /api/users/invite — הנתיב שלנו.
--   2. **הרשמה עצמית ב-/auth/v1/signup** — disable_signup הוא false בפרויקט,
--      כלומר הנקודה הזו פתוחה לכל אדם באינטרנט. היא אינה עוברת דרך השרת
--      שלנו כלל, ולכן היא הסיבה המרכזית שהכלל יושב כאן: בלעדיו כל אחד
--      נרשם, מקבל authenticated, ורואה את נתוני כל האתרים.
--   3. ה-Admin API.
--
-- (הייתה כאן גם דרך רביעית — התחברות עם Google, שיוצרת משתמש בכניסה
-- הראשונה. היא הוסרה מהמוצר. הטריגר היה חוסם גם אותה, ויחסום כל ספק
-- חיצוני שיתווסף בעתיד, בלי שיצטרכו לזכור להוסיף בדיקה.)
--
-- טריגר לפני INSERT על auth.users חוסם את כל השלוש, כולל דרכים שטרם
-- קיימות. זה המקום היחיד שאי אפשר לעקוף.
--
-- ============================================================
-- הפרדה שמשרתת את דלת היציאה
-- ============================================================
-- **הלוגיקה** יושבת ב-app (סכמה שלנו) ולכן היא ניידת ונוסעת ב-pg_dump.
-- **הקישור** הוא טריגר על auth.users — סכמה של Supabase, ולכן הוא *אינו*
-- נוסע ב-dump. במעבר להתקנה עצמית צריך ליצור מחדש את הטריגר בלבד, ולא
-- לכתוב מחדש את הכלל. זו גם הסיבה שזה טריגר ואינו מפתח זר: FK ל-auth.users
-- אסור כאן (ראה CLAUDE.md), טריגר הוא קישור הפיך.
--
-- ⚠️ ל-pg_dump צריך **גם** את הסכמה app:
--     pg_dump --schema=public --schema=app

-- ============================================================
-- דומיין אחד בדיוק: parkomat.co.il
-- ============================================================
-- בגרסה קודמת הותרו כאן שני דומיינים, כי בפועל היו בשימוש גם parkomat.com
-- וגם parkomat.co.il והגבלה לאחד הייתה נועלת בחוץ את בעל השני. **זה נסגר
-- כהחלטה**: הדומיין הרשמי הוא parkomat.co.il בלבד, וחשבון ה-.com נמחק
-- כחלק מאותו שינוי — אחרת הכלל היה מוכרז ולא נאכף, שכן טריגר BEFORE INSERT
-- אינו מונע התחברות של מי שכבר בפנים.
--
-- הרשימה נשארת מערך ולא ערך יחיד: הרחבה עתידית (רכישה, מיזוג, דומיין
-- משנה) היא הוספת איבר, לא שינוי מבנה.
--
-- לשינוי: עורכים כאן ומפעילים מחדש — הקובץ נטען בכל עלייה, והוא מצב היעד.
-- ⚠️ צמצום הרשימה **אינו** מנתק מי שכבר קיים; צריך גם למחוק את החשבון.
CREATE OR REPLACE FUNCTION app.allowed_email_domains()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY['parkomat.co.il'];
$$;

-- ============================================================
-- למה SECURITY DEFINER, ובלעדיו הטריגר חוסם את *כולם*
-- ============================================================
-- GoTrue מתחבר לבסיס הנתונים כ-supabase_auth_admin, ולסכמה app יש USAGE
-- רק ל-postgres ול-authenticated. בלי SECURITY DEFINER גוף הטריגר נכשל על
-- permission denied בכל יצירת משתמש — כולל מדומיין מאושר. התסמין הוא
-- "Database error creating new user" בלי שום רמז לסיבה.
--
-- ⚠️ זה נתפס רק כי הבדיקה כללה גם מקרה שאמור **לעבור**: חסימת gmail
-- "הצליחה" מהסיבה הלא נכונה. בדיקה שלילית בלבד הייתה מדווחת ירוק ונועלת
-- את כל החברה בחוץ.
--
-- הבחירה היא SECURITY DEFINER ולא GRANT ל-supabase_auth_admin, משתי סיבות:
-- לא להרחיב לרול של Supabase גישה לכל הסכמה app, ולא לקבע שם של רול
-- ספציפי ל-Supabase בקוד שלנו — בהתקנה עצמית הרול הזה אינו קיים.
--
-- search_path מקובע: חובה ב-SECURITY DEFINER, אחרת מי שיכול ליצור אובייקט
-- בסכמה קודמת בנתיב יכול להחליף את split_part ולהריץ קוד כ-postgres.
CREATE OR REPLACE FUNCTION app.enforce_email_domain()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_catalog
AS $$
DECLARE
  domain text;
BEGIN
  -- אין אימייל (למשל התחברות טלפונית) — לא חוסמים. הכלל הוא על דומיינים,
  -- ולא "חייב אימייל".
  IF NEW.email IS NULL OR NEW.email = '' THEN
    RETURN NEW;
  END IF;

  -- lower כי דומיינים אינם תלויי-רישיות, ומשתמש שיקליד @Parkomat.com אינו
  -- אמור להיחסם.
  domain := lower(split_part(NEW.email, '@', 2));

  IF NOT (domain = ANY (app.allowed_email_domains())) THEN
    -- ההודעה מגיעה למשתמש דרך GoTrue, ולכן היא מנוסחת אליו ולא ללוג.
    RAISE EXCEPTION 'רק כתובות דואר של החברה יכולות להתחבר (%)',
      array_to_string(app.allowed_email_domains(), ', ')
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- BEFORE INSERT בלבד: משתמשים **קיימים** אינם נבדקים ואינם נמחקים. שינוי
-- הרשימה בעתיד לא יינעל אף אחד שכבר בפנים — הוא רק ימנע חדשים.
DROP TRIGGER IF EXISTS enforce_email_domain ON auth.users;
CREATE TRIGGER enforce_email_domain
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION app.enforce_email_domain();

COMMENT ON FUNCTION app.enforce_email_domain() IS
  'חוסם יצירת משתמש שאינו מדומיין מאושר. חל על כל מסלולי היצירה — הרשמה, '
  'Admin API והנתיב שלנו. הלוגיקה ניידת; הטריגר על auth.users אינו.';

-- ============================================================
-- תפקיד authenticated — נוצר אם חסר
-- ============================================================
-- Supabase יוצר anon/authenticated/service_role בעצמו. Postgres רגיל לא,
-- ולכן CREATE POLICY ... TO authenticated היה נכשל שם. הבלוק הזה הופך את
-- הקובץ להרצה גם על מסד נקי — וזו כל הנקודה של מצב היציאה.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END
$$;

-- ============================================================
-- מדיניות קריאה — מאומת רואה הכול, בשלב הזה
-- ============================================================
-- **RLS כבר מופעל** על כל הטבלאות: Supabase מדליק אותו אוטומטית לטבלאות
-- חדשות (ראה הפונקציה rls_auto_enable שלהם). מה שלא היה זה מדיניות — ובלי
-- מדיניות, טבלה עם RLS מחזירה אפס שורות לכל מי שאינו עוקף.
--
-- לכן היום הדשבורד עובד: הוא עובר דרך השרת, שמתחבר כ-postgres עם
-- rolbypassrls = true. ברגע שהדשבורד יתחבר ישירות, בלי המדיניות כאן הוא
-- היה מקבל מסך ריק בלי שום שגיאה.
--
-- ============================================================
-- "מאומת רואה הכול" הוא **החלטה**, לא מציין-מקום
-- ============================================================
-- הוכרע במפורש: כל המשתמשים רואים את כל האתרים. אין תת-קבוצות ואין טבלת
-- שיוך משתמש↔אתר, ולכן אין USING שמסנן לפי זהות — `USING (true)` הוא
-- הביטוי המדויק של הכלל ולא קיצור דרך.
--
-- מה זה חוסך: הכלל הקל להתהדק ואי אפשר לחזור ממנו בזול. טבלת שיוך שנוספת
-- מראש "ליתר ביטחון" מחייבת החלטה על כל שורה בה, ומדיניות שמסננת לפי
-- זהות מחייבת שכל שאילתה תישא זהות — כולל הקליטה, שאין לה.
--
-- app.current_role() קיים ואינו מיותר: הוא נדרש ברגע שתהיה הבחנה בין
-- *קריאה* (שווה לכולם) לבין *כתיבה* (שאינה). ההידוק יקרה בקובץ הזה בלבד.
--
-- כתיבה אינה מקבלת מדיניות בכלל, כלומר אסורה. הקליטה והניהול עוברים דרך
-- השרת שעוקף RLS, ולכן שום דבר קיים לא נשבר.

-- sites
DROP POLICY IF EXISTS sites_read_authenticated ON sites;
CREATE POLICY sites_read_authenticated ON sites
  FOR SELECT TO authenticated USING (true);

-- status_history
DROP POLICY IF EXISTS status_history_read_authenticated ON status_history;
CREATE POLICY status_history_read_authenticated ON status_history
  FOR SELECT TO authenticated USING (true);

-- operations
DROP POLICY IF EXISTS operations_read_authenticated ON operations;
CREATE POLICY operations_read_authenticated ON operations
  FOR SELECT TO authenticated USING (true);

-- maintenance_windows
DROP POLICY IF EXISTS maintenance_windows_read_authenticated ON maintenance_windows;
CREATE POLICY maintenance_windows_read_authenticated ON maintenance_windows
  FOR SELECT TO authenticated USING (true);

-- monthly_summary
DROP POLICY IF EXISTS monthly_summary_read_authenticated ON monthly_summary;
CREATE POLICY monthly_summary_read_authenticated ON monthly_summary
  FOR SELECT TO authenticated USING (true);

-- events — הדשבורד מאזין לזה (Realtime / replay), ולכן קריאה נדרשת
DROP POLICY IF EXISTS events_read_authenticated ON events;
CREATE POLICY events_read_authenticated ON events
  FOR SELECT TO authenticated USING (true);

-- ============================================================
-- settings — **אין מדיניות, וזה מכוון**
-- ============================================================
-- הטבלה מחזיקה את גיבוב קוד המנהל (ADMIN_KEY). קריאה שלה ע"י הדשבורד
-- תיתן לכל מאומת את הגיבוב לתקיפה במנותק. RLS מופעל ואין מדיניות, ולכן
-- היא סגורה לכל מי שאינו עוקף — כלומר לשרת בלבד.
--
-- אם יתווסף אי-פעם ערך שהדשבורד *כן* צריך, אין להוסיף מדיניות על הטבלה
-- כולה. הדרך הנכונה היא פונקציה STABLE שמחזירה את המפתח המסוים.

-- הרשאות ברמת הטבלה נדרשות *בנוסף* ל-RLS: RLS מסנן שורות, GRANT קובע אם
-- מותר לגשת לטבלה בכלל. בלי זה התוצאה היא permission denied ולא אפס שורות.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA app TO authenticated;
GRANT SELECT ON sites, status_history, operations,
                maintenance_windows, monthly_summary, events TO authenticated;

-- פונקציות המדדים — הדשבורד יקרא להן ישירות דרך PostgREST.
-- הן STABLE ולא נוגעות ב-auth.*, ולכן הן רצות תחת המדיניות שלמעלה.
GRANT EXECUTE ON FUNCTION public.site_uptime(integer[], text, text)             TO authenticated;
GRANT EXECUTE ON FUNCTION public.site_segments_collapsed(integer[], text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.site_stats(integer[], text, text)              TO authenticated;
GRANT EXECUTE ON FUNCTION app.current_actor()                                   TO authenticated;
GRANT EXECUTE ON FUNCTION app.current_role()                                    TO authenticated;
