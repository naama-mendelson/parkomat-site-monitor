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
-- **מנהל** או **בקר**. אינו anon/authenticated — אלה תפקידי
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
-- updateUser, ולכן תפקיד משם היה מאפשר לכל אחד להעלות את עצמו למנהל.
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
  'התפקיד היישומי (מנהל/בקר), לא תפקיד ה-Postgres. ברירת מחדל anonymous.';

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
-- (ודרך רביעית: **קישור כניסה למייל** (Magic Link) — signInWithOtp עם
-- shouldCreateUser, שיוצר משתמש בבקשה הראשונה. גם היא אינה עוברת דרך
-- השרת. הטריגר חוסם אותה בדיוק כמו את השאר, וגם כל ספק שיתווסף בעתיד
-- בלי שיצטרכו לזכור להוסיף בדיקה.)
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
CREATE OR REPLACE FUNCTION app.enforce_user_creation()
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

  -- ============================================================
  -- הדומיין **הוא** ההרשאה: תפקיד בסיסי מוענק כאן, אוטומטית
  -- ============================================================
  -- ⚠️ שינוי החלטה. עד כה חסם טריגר נדחה כל מי שאין לו parkomat_role,
  -- כלומר כל מי שלא הוזמן ידנית. הוכרע ההפך: **מי שיש לו כתובת של החברה
  -- זכאי להיכנס**, ומה שנשאר להחליט הוא רק מה מותר לו — וזו הדרגה.
  --
  -- כתובת @parkomat.co.il מונפקת ע"י הארגון ורק לעובדים. הזמנה ידנית
  -- הייתה שכבה שנייה ששואלת בדיוק את אותה שאלה, ומי שנשכח בה פשוט לא
  -- הצליח להיכנס בלי שאיש ידע למה.
  --
  -- ============================================================
  -- ⚠️ למה כאן ולא בטריגר הנדחה
  -- ============================================================
  -- ההצעה הייתה לעדכן את app_metadata בזמן ה-commit. זה עובד, אבל פותח
  -- שאלה שאין עליה תשובה ודאית: **האם GoTrue כבר חתם את האסימון הראשון**
  -- כשהטריגר הנדחה רץ. אם כן, הכניסה הראשונה נושאת תביעה ריקה.
  --
  -- ב-BEFORE INSERT פשוט כותבים על NEW, והשורה **נולדת** עם התפקיד. אין
  -- UPDATE על auth.users, אין תלות בסדר, ואין חלון.
  --
  -- ⚠️ ורק כשחסר: מסלול ההזמנה קובע דרגה בעצמו (auth/admin.js), וכתיבה
  -- גורפת כאן הייתה דורסת מנהל שנוצר במפורש ומורידה אותו לבקר.
  --
  -- ⚠️ 'operator' ולא 'viewer'/'employee': יש שתי קבוצות בלבד במערכת
  -- (ראה app_users.role), ושם דרגה שלישי שאינו קיים בשום CHECK היה יוצר
  -- משתמש שאיש אינו יודע מה מותר לו.
  IF NEW.raw_app_meta_data IS NULL THEN
    NEW.raw_app_meta_data := jsonb_build_object('parkomat_role', 'operator');
  ELSIF NEW.raw_app_meta_data ->> 'parkomat_role' IS NULL THEN
    NEW.raw_app_meta_data :=
      NEW.raw_app_meta_data || jsonb_build_object('parkomat_role', 'operator');
  END IF;

  RETURN NEW;
END;
$$;

-- BEFORE INSERT בלבד: משתמשים **קיימים** אינם נבדקים ואינם נמחקים. שינוי
-- הרשימה בעתיד לא יינעל אף אחד שכבר בפנים — הוא רק ימנע חדשים.
-- שם ישן, מלפני שהכלל כלל גם חסימת הרשמה עצמית. נשאר ב-DROP כדי
-- שהרצה על מופע קיים תנקה אותו ולא תשאיר שני טריגרים פעילים.
DROP TRIGGER IF EXISTS enforce_email_domain ON auth.users;
DROP FUNCTION IF EXISTS app.enforce_email_domain();
DROP TRIGGER IF EXISTS enforce_user_creation ON auth.users;
CREATE TRIGGER enforce_user_creation
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION app.enforce_user_creation();

COMMENT ON FUNCTION app.enforce_user_creation() IS
  'חוסם יצירת משתמש שאינו מדומיין מאושר. חל על כל מסלולי היצירה. '
  'הלוגיקה ניידת; הטריגר על auth.users אינו.';

-- ============================================================
-- הזמנה-בלבד — **בוטל**, והטריגר הוסר
-- ============================================================
-- כאן ישב `enforce_invite_only`: טריגר אילוץ נדחה שדרש parkomat_role בזמן
-- ה-commit, כלומר חסם כל מי שלא הוזמן ידנית. הוא בוטל בהחלטת מוצר —
-- **הדומיין הוא ההרשאה**, ותפקיד בסיסי מוענק אוטומטית ב-BEFORE INSERT
-- שמעליו.
--
-- ⚠️ והוא לא רק מיותר אלא **בלתי-ניתן להגעה**: כל שורה שמגיעה לטריגר
-- הנדחה כבר עברה את בדיקת הדומיין וכבר נושאת parkomat_role, ולכן ענף
-- החסימה שלו לא היה נכנס לפעולה לעולם. קוד מת שנראה כמו הגנה פעילה הוא
-- גרוע יותר מהיעדר הגנה — מישהו יסתמך עליו.
--
-- ⚠️ ה-DROP נשאר לצמיתות ולא נמחק: הוא מה שמסיר את הטריגר ממופע שכבר
-- מכיל אותו. בלעדיו הפרודקשן היה ממשיך לחסום הרשמה עצמית בעוד הקוד
-- אומר שהיא פתוחה.
--
-- מה שנשאר סגור: `disable_signup` בלוח הבקרה של Supabase. אם ירצו לחסום
-- הרשמה בסיסמה ולהשאיר רק קישור למייל, זה המקום — לא כאן.
DROP TRIGGER IF EXISTS enforce_invite_only ON auth.users;
DROP FUNCTION IF EXISTS app.enforce_invite_only();

-- ============================================================
-- כל משתמש חדש מקבל שורת app_users — אוטומטית
-- ============================================================
-- ⚠️ בלי זה, משתמש שנכנס בקישור למייל מתחבר בהצלחה ורואה **מסך ריק**:
-- app.current_app_user() מחזיר NULL, ולכן אין לו זהות יישומית. אין
-- שגיאה, אין "אין הרשאה" — רק אפס אתרים. זה בדיוק התסמין שגורם למישהו
-- לחשוב שהמערכת נמחקה.
--
-- טריגר ולא קוד בשרת, מאותו טעם כמו הגבלת הדומיין: יש שלוש דרכים שמשתמש
-- נוצר בהן, והשרת רואה רק אחת מהן. כניסה ראשונה בקישור למייל אינה עוברת
-- דרכנו כלל.
--
-- ⚠️ **ON CONFLICT מקשר בלבד ואינו נוגע בדרגה.** משתמש שמנהל הזמין וקבע לו
-- דרגה, ואז נכנס לראשונה בקישור למייל, אינו רשאי לאבד אותה — ובוודאי
-- לא לרדת לבקר בשקט. מה שמתעדכן הוא supabase_uid, ורק אם הוא היה ריק.
CREATE OR REPLACE FUNCTION app.provision_app_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_catalog
AS $$
DECLARE
  v_role text;
BEGIN
  -- אין אף מנהל פעיל? הראשון שנכנס נהיה מנהל. בלי זה התקנה חדשה ננעלת
  -- על עצמה: כולם בקרים, ואין מי שימנה מנהל.
  IF EXISTS (SELECT 1 FROM app_users WHERE role = 'manager' AND is_active) THEN
    v_role := 'operator';
  ELSE
    v_role := 'manager';
  END IF;

  INSERT INTO app_users (email, full_name, role, supabase_uid, created_at)
  VALUES (
    NEW.email,
    NEW.raw_user_meta_data ->> 'full_name',
    v_role,
    NEW.id,
    to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
  ON CONFLICT (email) DO UPDATE
    SET supabase_uid = COALESCE(app_users.supabase_uid, EXCLUDED.supabase_uid);

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS provision_app_user ON auth.users;
CREATE TRIGGER provision_app_user
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION app.provision_app_user();

COMMENT ON FUNCTION app.provision_app_user() IS
  'יוצר שורת app_users לכל משתמש חדש. בלעדיה משתמש מחובר רואה מסך ריק. '
  'אינו נוגע בדרגה של שורה קיימת — רק מקשר supabase_uid.';

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

-- ============================================================
-- מי אני, ומה מותר לי לראות
-- ============================================================
-- ⚠️ **שלוש פונקציות, ולא תנאי משוכפל בכל מדיניות.** אותו שיקול בדיוק כמו
-- app.current_actor(): מדיניות שכותבת את הכלל בעצמה הופכת כל שינוי בכלל
-- לשכתוב של שבע מדיניות, ואת יום ההגירה למחקר.
--
-- ⚠️ SECURITY DEFINER, ו-search_path מוצמד. הן קוראות את app_users ואת
-- app_users — טבלה שיש עליה RLS משלה. בלי DEFINER המדיניות הייתה
-- שואלת טבלה שהמדיניות שלה שואלת את הפונקציה, וזו רקורסיה.
--
-- ⚠️ ואף אחת מהן אינה נוגעת ב-`sites` או ב-`audit_log` — הטבלאות שהמדיניות
-- שלהן קוראות להן. קריאה כזו הייתה רקורסיה ישירה.
CREATE OR REPLACE FUNCTION app.current_app_user()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
  SELECT u.id
    FROM app_users u
   WHERE u.supabase_uid::text = app.current_actor()
     AND u.is_active
   LIMIT 1
$$;

-- ============================================================
-- הדרגה נקראת מהטבלה, לא מהתביעה
-- ============================================================
-- ⚠️ app.current_role() קורא את parkomat_role מתוך ה-JWT. התביעה נחתמה
-- ברגע ההתחברות, ולכן **הורדת דרגה אינה נכנסת לתוקף עד שהמשתמש מתחבר
-- מחדש** — חלון של שעה או יותר שבו מי שהודח עדיין מנהל.
--
-- app_users.role הוא מקור האמת, והוא נקרא בכל בקשה.
--
-- התביעה עדיין נכתבת (ב-enforce_user_creation) ואינה מיותרת: היא מה
-- שמאפשר ל-RLS לעבוד גם בלי שאילתת טבלה, והיא הערך ההתחלתי שממנו
-- provision_app_user יוצר את השורה. **אבל היא לעולם לא הסמכות** —
-- אסימון בן שעה שנושא 'manager' אינו הופך בקר למנהל.
CREATE OR REPLACE FUNCTION app.current_app_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT u.role FROM app_users u
      WHERE u.supabase_uid::text = app.current_actor() AND u.is_active LIMIT 1),
    'anonymous'
  )
$$;

-- ⚠️ שתי קבוצות בלבד: manager ו-operator. הפונקציה נקראה is_executive
-- כשהיו שלוש דרגות; היא נמחקת במפורש כדי שלא תישאר קריאה אליה שמחזירה
-- false תמיד — כלומר מנהל שמאבד הרשאות בשקט.
--
-- ⚠️ **הדבר היחיד שנמחק כאן הוא השם הישן.** גרסה קודמת של השורה הזו כתבה
-- בטעות `DROP ... app.is_manager()` — הפונקציה החדשה — וכל עלייה נכשלה על
-- `cannot drop function because other objects depend on it`, כי מדיניות
-- ה-audit_log תלויה בה. השרת פשוט לא עלה.
--
-- ⚠️ ו-CREATE OR REPLACE על is_manager מתחתיה **חייב** להישאר REPLACE ולא
-- DROP: מרגע שמדיניות מצביעה על פונקציה, מחיקתה דורשת מחיקת המדיניות.
DROP FUNCTION IF EXISTS app.is_executive();

CREATE OR REPLACE FUNCTION app.is_manager()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$ SELECT app.current_app_role() = 'manager' $$;

-- ============================================================
-- can_see_site — **בוטלה**
-- ============================================================
-- כאן ישבה הפונקציה שהגבילה בקר לאתרים שהוקצו לו. הוכרע ההפך: **בקר
-- רואה את כל האתרים**, וההגבלה היחידה שנשארה היא על יומן הפעולות.
--
-- ⚠️ ה-DROP חייב לרוץ **אחרי** שהמדיניות שהצביעו עליה שוחזרו ל-USING
-- (true) — והן למטה בקובץ. לכן הוא אינו כאן אלא לצידן.
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

-- ============================================================
-- הטבלאות החדשות — RLS, מדיניות והרשאות
-- ============================================================
-- ⚠️ Supabase מדליק RLS אוטומטית על טבלאות חדשות, אבל **רק ב-Supabase**.
-- על Postgres רגיל הן היו נשארות פתוחות לגמרי — כלומר דלת היציאה הייתה
-- פותחת דלת אחרת. ההדלקה כאן מפורשת ואידמפוטנטית.
ALTER TABLE app_users  ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log  ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- app_users — כולם רואים מי במערכת
-- ============================================================
-- זו רשימת עובדי החברה, לא סוד. והיא נדרשת כדי להציג שם ליד כל שורת
-- ביקורת — שהוכרע שגלויה לכולם.
--
-- ⚠️ אין כאן מדיניות כתיבה, כלומר כתיבה **אסורה** לכל מי שאינו עוקף RLS.
-- ניהול המשתמשים עובר דרך השרת בלבד, שם יושבת גם בדיקת הדרגה. מדיניות
-- כתיבה כאן הייתה נותנת לדפדפן לשנות דרגות ישירות מול PostgREST.
DROP POLICY IF EXISTS app_users_read_authenticated ON app_users;
CREATE POLICY app_users_read_authenticated ON app_users
  FOR SELECT TO authenticated USING (true);

-- ============================================================
-- audit_log — בקר רואה הכול, חוץ מניהול המשתמשים
-- ============================================================
-- הכלל עבר שתי גרסאות לפני זו, וההבדל ביניהן מהותי:
--   1. `USING (true)` — הכול גלוי לכולם.
--   2. בקר רואה רק פעולות של בקרים. **רחב מדי** — הוא הסתיר גם תחזוקה
--      שמנהל הפעיל, וזה מידע תפעולי שבקר צריך.
--   3. וזה: בקר רואה **כל** פעולה, למעט ניהול משתמשים.
--
-- ההיגיון: מי נכנס למערכת ומי הוצא ממנה הוא עניין של הנהלה, ולא של מי
-- שמנטר אתרים. כל השאר — תחזוקה, רישום אתר, שינוי הגדרות — נוגע לעבודה
-- היומיומית וגלוי לכולם.
--
-- ⚠️⚠️ **התחילית `user.` נושאת את כל ההרשאה.** פעולה חדשה שתיקרא
-- `users.invite` או `invite.user` תהיה **גלויה לבקרים** — בלי שגיאה, בלי
-- סימן, ובלי שאיש ישים לב. זו הנקודה השברירית היחידה כאן, ולכן:
--
--   • כל פעולת ניהול משתמשים חייבת להתחיל ב-`user.`
--     (user.invite · user.disable · user.role)
--   • `tools/check-scope.js` בודק בדיוק את זה — שורת user.* מוסתרת
--     ושורת maintenance.* גלויה.
--
-- ⚠️ הסינון הוא על **הפעולה**, לא על דרגת הפועל. מנהל שמעביר אתר
-- לתחזוקה מופיע אצל כולם, כי זה מה שקרה באתר.
DROP POLICY IF EXISTS audit_log_read_authenticated ON audit_log;
CREATE POLICY audit_log_read_authenticated ON audit_log
  FOR SELECT TO authenticated
  USING (app.is_manager() OR action NOT LIKE 'user.%');

GRANT SELECT ON app_users, audit_log TO authenticated;
GRANT EXECUTE ON FUNCTION app.current_app_user()      TO authenticated;
GRANT EXECUTE ON FUNCTION app.current_app_role()      TO authenticated;
GRANT EXECUTE ON FUNCTION app.is_manager()          TO authenticated;
-- ⚠️ אחרי שהמדיניות שוחזרו: הפונקציה כבר אינה בשימוש ונמחקת כאן, לא
-- למעלה. מחיקה לפני שחזור המדיניות הייתה נכשלת על תלות.
DROP FUNCTION IF EXISTS app.can_see_site(integer);
