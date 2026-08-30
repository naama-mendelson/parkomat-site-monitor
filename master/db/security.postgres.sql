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
  -- ⚠️ כאן **אין** הזרקת תפקיד, וזו ההחלטה — לא השמטה
  -- ============================================================
  -- קודם הוזרק כאן 'operator' לכל שורה שהגיעה בלי תפקיד, כדי לממש את
  -- הכלל "הדומיין הוא ההרשאה". הכלל התהפך: **בקר נכנס רק אם מנהל הוסיף
  -- אותו**; כתובת של החברה היא תנאי הכרחי ולא מספיק.
  --
  -- ⚠️ וההזרקה לא רק ייתרה את ההזמנה-בלבד אלא הפכה אותה **בלתי-ניתנת
  -- להגעה**: כל שורה הגיעה לטריגר הנדחה כשהיא כבר נושאת תפקיד, ולכן ענף
  -- החסימה לא נכנס לפעולה לעולם. שתי שכבות שנראות כמו הגנה כפולה, כשאחת
  -- מהן מנטרלת את השנייה בשקט.
  --
  -- ⚠️ המחיר, במפורש: כל יצירת משתמש **חייבת** לקבוע parkomat_role, אחרת
  -- היא נחסמת ב-commit. מסלול ההזמנה עושה זאת (auth/admin.js), וכל מסלול
  -- עתידי חייב לעשות זאת גם.
  --
  -- למה לא כאן, כלומר למה לא לבדוק את התפקיד ב-BEFORE INSERT: נמדד מול
  -- המופע האמיתי, בגשש שרק רשם ולא חסם — ב-INSERT שתי הדרכים מייצרות
  -- שורה **זהה**:
  --
  --     Admin API      raw_app_meta_data = {"provider":"email",...}
  --     הרשמה עצמית    raw_app_meta_data = {"provider":"email",...}
  --
  -- GoTrue כותב את app_metadata **אחרי** ה-INSERT, ולכן ההבחנה קיימת רק
  -- בזמן ה-commit. ראה enforce_invite_only למטה.

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

-- ⚠️ ה-DROP קודם ל-CREATE כי אין `CREATE OR REPLACE TRIGGER` ב-Postgres 14,
-- והקובץ הזה מורץ בכל עלייה. בלעדיו כל הפעלה שנייה נופלת על "כבר קיים".
DROP TRIGGER IF EXISTS enforce_invite_only ON auth.users;
DROP FUNCTION IF EXISTS app.enforce_invite_only();

-- ============================================================
-- הזמנה-בלבד — טריגר אילוץ **נדחה**
-- ============================================================
-- ⚠️ **נדחה ולא BEFORE INSERT, וזו כל הנקודה.** בזמן ה-INSERT שתי הדרכים
-- מייצרות שורה זהה (נמדד — ראה ההערה ב-enforce_user_creation). GoTrue
-- כותב את app_metadata של ה-Admin API מיד אחרי, באותה טרנזקציה, ולכן
-- **בזמן ה-commit** ההבדל כן קיים:
--
--     הוזמן דרך Admin API  →  parkomat_role קיים
--     נרשם בעצמו          →  parkomat_role חסר  ⟶ נחסם
--
-- ⚠️ ו-app_metadata אינו ניתן לכתיבה מהלקוח — זו אותה תכונה שכל מערכת
-- התפקידים נשענת עליה. מי שנרשם בעצמו אינו יכול לזייף אותו.
--
-- ⚠️ **מי שנחסם רואה הודעה גנרית של GoTrue** ("Unexpected failure") —
-- שגיאות מטריגר נדחה אינן מועברות כלשונן. זה מקובל: אף אחד לא אמור
-- להגיע לשם, ומסלול ההזמנה לעולם לא עובר בענף הזה.
CREATE OR REPLACE FUNCTION app.enforce_invite_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
DECLARE
  v_role text;
BEGIN
  -- ⚠️ **קוראים את השורה מהטבלה ולא מ-NEW, וזה לא ניואנס — זה כל התיקון.**
  -- ב-Postgres, `NEW` בטריגר נדחה הוא צילום של השורה **בזמן ה-INSERT**; הוא
  -- אינו נקרא מחדש ב-commit. GoTrue כותב את app_metadata ב-UPDATE שאחרי
  -- ה-INSERT, ולכן NEW נשאר ריק לנצח — והגרסה שהסתמכה עליו חסמה **גם את
  -- ההזמנה**. נמדד: Admin API החזיר 500 עם הודעת הטריגר.
  SELECT raw_app_meta_data ->> 'parkomat_role'
    INTO v_role
    FROM auth.users
   WHERE id = NEW.id;

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'משתמש חדש נוצר רק בהזמנה של מנהל';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER enforce_invite_only
  AFTER INSERT ON auth.users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.enforce_invite_only();

COMMENT ON FUNCTION app.enforce_invite_only() IS
  'חוסם הרשמה עצמית: בזמן commit חייב להיות parkomat_role, שרק ה-Admin API מציב.';

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
-- ============================================================
-- app.is_active_user() — האם למאומת הזה יש שורה **פעילה** אצלנו
-- ============================================================
-- ⚠️ **`authenticated` אינו שווה ל"רשאי".** משתמש שהושבת מחזיק אסימון
-- Supabase תקף עד שיפוג, וכל המדיניות היו `USING (true)` — כלומר
-- ההשבתה הסירה את גישתו **לשרת בלבד**, בעוד הדשבורד קורא ישירות מ-
-- PostgREST והמשיך להחזיר לו את כל הנתונים.
--
-- זה נוצר ברגע שנוספה ההשבתה: קודם לא הייתה דרך להשבית, ולכן ההבחנה
-- לא הייתה קיימת. הכפתור אמר "הושבת" ולא השבית.
--
-- ⚠️ ועובר דרך app.current_actor() ולא דרך auth.uid() — אותו כלל
-- שמאפשר למדיניות הזו לרוץ גם על Postgres רגיל.
CREATE OR REPLACE FUNCTION app.is_active_user()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM app_users u
     WHERE u.supabase_uid::text = app.current_actor()
       AND u.is_active
  );
$$;

GRANT EXECUTE ON FUNCTION app.is_active_user() TO authenticated;
-- sites
-- ============================================================
-- ⚠️ למה כל קריאה כאן עטופה ב-(SELECT ...)
-- ============================================================
-- `app.is_active_user()` ו-`app.is_manager()` הן STABLE, אבל בתוך USING
-- הן נקראות **לכל שורה שנסרקת**. נמדד דרך PostgREST על נתוני הייצור:
--
--     site_uptime   2,554–2,819ms  להחזרת 16 שורות (4KB)
--     חמש קריאות רצופות — כולן איטיות באותה מידה, כלומר לא התחלה קרה
--
-- ואותה שאילתה בדיוק דרך חיבור `postgres` רצה ב-123ms — כי ל-postgres
-- יש rolbypassrls, והמדיניות אינה נבדקת כלל. כלומר **כל ההפרש הוא
-- RLS**, ולא החישוב.
--
-- עטיפה ב-`(SELECT f())` הופכת את הקריאה ל-InitPlan: Postgres מעריך
-- אותה **פעם אחת לשאילתה** ומשווה את התוצאה לכל שורה. זה דפוס מתועד
-- של Supabase, והוא **אינו משנה מי רואה מה** — פונקציה STABLE מחזירה
-- את אותו ערך לאורך השאילתה בין כה וכה.
--
-- ⚠️ ולכן זה גם לא "אופטימיזציה שמרככת אבטחה": הביטוי זהה, רק מספר
-- ההערכות שונה. `check-security` מאמת שאיש לא קיבל גישה שלא הייתה לו.

DROP POLICY IF EXISTS sites_read_authenticated ON sites;
CREATE POLICY sites_read_authenticated ON sites
  FOR SELECT TO authenticated USING ((SELECT app.is_active_user()));

-- status_history
DROP POLICY IF EXISTS status_history_read_authenticated ON status_history;
CREATE POLICY status_history_read_authenticated ON status_history
  FOR SELECT TO authenticated USING ((SELECT app.is_active_user()));

-- operations
DROP POLICY IF EXISTS operations_read_authenticated ON operations;
CREATE POLICY operations_read_authenticated ON operations
  FOR SELECT TO authenticated USING ((SELECT app.is_active_user()));

-- maintenance_windows
DROP POLICY IF EXISTS maintenance_windows_read_authenticated ON maintenance_windows;
CREATE POLICY maintenance_windows_read_authenticated ON maintenance_windows
  FOR SELECT TO authenticated USING ((SELECT app.is_active_user()));

-- monthly_summary
DROP POLICY IF EXISTS monthly_summary_read_authenticated ON monthly_summary;
CREATE POLICY monthly_summary_read_authenticated ON monthly_summary
  FOR SELECT TO authenticated USING ((SELECT app.is_active_user()));

-- events — הדשבורד מאזין לזה (Realtime / replay), ולכן קריאה נדרשת
DROP POLICY IF EXISTS events_read_authenticated ON events;
CREATE POLICY events_read_authenticated ON events
  FOR SELECT TO authenticated USING ((SELECT app.is_active_user()));

-- ============================================================
-- suppressed_faults — תקלות שהושמטו בזמן תחזוקה
-- ============================================================
-- ⚠️ **בלי המדיניות הזו הזרוע הישירה מציגה לוג קצר יותר — בשקט.** Supabase
-- מפעיל RLS על כל טבלה חדשה אוטומטית (rls_auto_enable), וטבלה עם RLS ובלי
-- מדיניות מחזירה **אפס שורות** ולא שגיאה. השרת אינו מושפע (postgres הוא
-- rolbypassrls), ולכן הפער היה מתגלה רק ביום שמישהו הופך את המתג.
DROP POLICY IF EXISTS suppressed_faults_read_authenticated ON suppressed_faults;
CREATE POLICY suppressed_faults_read_authenticated ON suppressed_faults
  FOR SELECT TO authenticated USING ((SELECT app.is_active_user()));

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
-- ⚠️ suppressed_faults ברשימה: GRANT ו-POLICY הם שני שלבים נפרדים, ובלי
-- ה-GRANT התוצאה היא permission denied ולא אפס שורות — כלומר הלוג הישיר
-- נופל כולו, ולא רק מחסיר שורות.
GRANT SELECT ON sites, status_history, operations,
                maintenance_windows, monthly_summary, events,
                suppressed_faults TO authenticated;

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
  FOR SELECT TO authenticated USING ((SELECT app.is_active_user()));

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
  USING ((SELECT app.is_manager()) OR action NOT LIKE 'user.%');

GRANT SELECT ON app_users, audit_log TO authenticated;
GRANT EXECUTE ON FUNCTION app.current_app_user()      TO authenticated;
GRANT EXECUTE ON FUNCTION app.current_app_role()      TO authenticated;
GRANT EXECUTE ON FUNCTION app.is_manager()          TO authenticated;

-- ============================================================
-- public.my_role() — התפקיד שלי, מהמסד ולא מהאסימון
-- ============================================================
-- ⚠️ **PostgREST חושף רק את `public`.** `app.current_app_role()` מוענקת
-- ל-`authenticated` וזה נכון, אבל הדפדפן אינו יכול לקרוא לה — ולכן הוא
-- נשאר עם `parkomat_role` שבאסימון, שנכתב פעם אחת ותקף שעה.
--
-- ⚠️ וזה הפך למשמעותי כשמסך ניהול האתרים עבר להיפתח לפי תפקיד: מנהל
-- שהורד לבקר היה ממשיך לראות את המסך עד שהאסימון יפוג, וכל פעולה שם
-- הייתה מוחזרת ב-403. הכיוון ההפוך גרוע יותר — בקר שהועלה למנהל **לא**
-- היה רואה את המסך למרות שהמסד כבר מרשה לו.
--
-- מחזירה 'anonymous' כשאין שורה פעילה — וזו **תשובה** ולא כשל: כך נראה
-- משתמש שהושבת.
CREATE OR REPLACE FUNCTION public.my_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$ SELECT app.current_app_role() $$;

REVOKE ALL ON FUNCTION public.my_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_role() TO authenticated;
-- ⚠️ אחרי שהמדיניות שוחזרו: הפונקציה כבר אינה בשימוש ונמחקת כאן, לא
-- למעלה. מחיקה לפני שחזור המדיניות הייתה נכשלת על תלות.
DROP FUNCTION IF EXISTS app.can_see_site(integer);

-- ============================================================
-- אימות דו-שלבי — רמת הביטחון של האסימון
-- ============================================================
-- ⚠️ **החסימה בדפדפן אינה אבטחה.** AuthGate מציג מסך אתגר, וזו חוויית
-- משתמש: הוא נפתח מחדש בכלי פיתוח בשלוש שניות, ו-PostgREST ממילא מקבל
-- בקשות ישירות בלי שום דשבורד. מה שמגן הוא הבדיקה כאן.
--
-- GoTrue מטביע באסימון תביעת `aal`: `aal1` = סיסמה בלבד, `aal2` = נוסף
-- גורם שני שאומת באותה התחברות.

CREATE OR REPLACE FUNCTION app.current_aal()
RETURNS text
LANGUAGE sql
STABLE
AS $fn$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::json ->> 'aal', '');
$fn$;

-- ============================================================
-- ⚠️ שני מצבים שונים לגמרי — NULL אינו "aal1"
-- ============================================================
-- אין תביעות JWT כלל = הקריאה **לא** הגיעה מדפדפן. זהו השרת (מתחבר
-- כ-postgres) או שער בדיקה שמזריק זהות דרך ה-GUC `app.user_id`. שני
-- אלה כבר מחזיקים **פרטי גישה למסד** — גורם חזק יותר מ-TOTP, לא חלש
-- ממנו. לדרוש מהם aal2 היה עוצר את הקליטה ואת השערים בלי להוסיף הגנה.
--
-- ולכן הכלל הוא: **מי שהגיע עם אסימון — נמדד לפיו. מי שהגיע בלי — לא
-- עבר דרך GoTrue מלכתחילה.**
CREATE OR REPLACE FUNCTION app.came_from_token()
RETURNS boolean
LANGUAGE sql
STABLE
AS $fn$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '') <> '';
$fn$;

-- ============================================================
-- ⚠️ דגל, ולא אכיפה מיידית — וזה מה שמונע נעילה של כל השמונה
-- ============================================================
-- ביום שהפונקציה הזו נכתבה אף אחד משמונת המנהלים לא היה רשום ל-TOTP.
-- אכיפה מיד הייתה חוסמת את **כולם** מניהול האתרים ומניהול המשתמשים —
-- כולל את היכולת לבטל את האכיפה — כלומר תיקון אבטחה שמייצר תקלה מלאה.
--
-- הסדר הנכון: המסכים עולים, כולם נרשמים, ורק אז הדגל נדלק:
--     INSERT INTO settings (key, value, updated_at)
--     VALUES ('mfa_required_for_manager', 'true', now()::text)
--     ON CONFLICT (key) DO UPDATE SET value = 'true';
CREATE OR REPLACE FUNCTION app.mfa_required()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
  SELECT COALESCE(
    (SELECT lower(value) = 'true' FROM public.settings
      WHERE key = 'mfa_required_for_manager'),
    false);
$fn$;

-- הבדיקה עצמה. נקראת מתוך app.require_manager().
CREATE OR REPLACE FUNCTION app.require_mfa()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
BEGIN
  IF NOT app.mfa_required() THEN RETURN; END IF;
  IF NOT app.came_from_token() THEN RETURN; END IF;
  IF COALESCE(app.current_aal(), 'aal1') <> 'aal2' THEN
    RAISE EXCEPTION 'הפעולה דורשת אימות דו-שלבי — הקלד את הקוד מאפליקציית המאמת'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$fn$;

COMMENT ON FUNCTION app.require_mfa() IS
  'דורש aal2 לפעולות מנהל, אם הדגל mfa_required_for_manager דלוק. פטור לקריאות שלא הגיעו מאסימון.';

-- ============================================================
-- field_reports — קריאה למנהלת, ולמי שכתב את שלו
-- ============================================================
-- ⚠️ **זו החריגה היחידה מ-"כל משתמש רואה הכול".** הכלל הזה נכון לנתוני
-- האתרים — הם תיאור של מתקנים משותפים. דיווח מהשטח הוא **מכתב לאדם**,
-- והבקשה הייתה מפורשת: "שיגיע רק אליי".
--
-- ⚠️ ומי שכתב רואה את שלו, וזה לא ויתור על הכלל אלא חלק ממנו: בלי זה אין
-- לו שום דרך לדעת שהדיווח נקלט, והוא ישלח אותו שוב. תיבה שבולעת בשקט
-- מייצרת כפילויות ומאבדת אמון.
--
-- ⚠️ **אין מדיניות INSERT/UPDATE/DELETE בכלל.** הכתיבה עוברת רק דרך
-- ה-RPC (submit_field_report / resolve_field_report), בדיוק כמו התחזוקה:
-- כך התקרות, הזהות והביקורת נאכפות במקום אחד ואי אפשר לעקוף אותן
-- בפתיחת DevTools.
ALTER TABLE field_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS field_reports_read ON field_reports;
CREATE POLICY field_reports_read ON field_reports
  FOR SELECT TO authenticated
  USING (
    (SELECT app.is_active_user())
    AND ((SELECT app.is_manager()) OR reported_by_user_id = (SELECT app.current_app_user()))
  );

-- הקבצים יורשים את ההרשאה של הדיווח שהם שייכים אליו. ⚠️ בלי ה-EXISTS
-- הזה תמונה הייתה נגישה לכל מאומת שינחש מזהה — כלומר הגבלת הקריאה על
-- הטבלה שמעל הייתה חסרת ערך, כי כל התוכן האמיתי יושב כאן.
ALTER TABLE field_report_files ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS field_report_files_read ON field_report_files;
CREATE POLICY field_report_files_read ON field_report_files
  FOR SELECT TO authenticated
  USING (
    (SELECT app.is_active_user())
    AND EXISTS (
      SELECT 1 FROM field_reports r
       WHERE r.id = field_report_files.report_id
         AND ((SELECT app.is_manager()) OR r.reported_by_user_id = (SELECT app.current_app_user()))
    )
  );

GRANT SELECT ON field_reports      TO authenticated;
GRANT SELECT ON field_report_files TO authenticated;

-- ============================================================
-- announcements — כולם קוראים, רק מנהלת כותבת
-- ============================================================
-- ⚠️ קריאה פתוחה לכל מאומת, ובכוונה: הודעת מערכת נועדה **להיקרא על ידי
-- כולם**. זו אינה חריגה מהכלל אלא היישום שלו.
--
-- הכתיבה עוברת רק דרך `publish_announcement` — אין מדיניות INSERT.
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS announcements_read ON announcements;
CREATE POLICY announcements_read ON announcements
  FOR SELECT TO authenticated USING ((SELECT app.is_active_user()));

GRANT SELECT ON announcements TO authenticated;

-- ============================================================
-- field_report_replies — יורש את ההרשאה של הדיווח
-- ============================================================
-- ⚠️ בדיוק כמו התמונות: בלי ה-EXISTS הזה כל מאומת שינחש מזהה היה קורא
-- שיחה שאינה שלו, והגבלת הדיווח עצמו הייתה חסרת ערך.
ALTER TABLE field_report_replies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS field_report_replies_read ON field_report_replies;
CREATE POLICY field_report_replies_read ON field_report_replies
  FOR SELECT TO authenticated
  USING (
    (SELECT app.is_active_user())
    AND EXISTS (
      SELECT 1 FROM field_reports r
       WHERE r.id = field_report_replies.report_id
         AND ((SELECT app.is_manager()) OR r.reported_by_user_id = (SELECT app.current_app_user()))
    )
  );

GRANT SELECT ON field_report_replies TO authenticated;

-- ============================================================
-- service_commands — מנהלת רואה, ורק היא מבקשת
-- ============================================================
-- ⚠️ קריאה למנהלת בלבד ולא לכל מאומת. השורות מכילות `reason` שמישהי
-- הקלידה ואת שמה, וזו רשומת תפעול ולא מידע שכל משתמש צריך. הכתיבה
-- כולה עוברת ב-RPC — אין GRANT INSERT/UPDATE לאיש.
ALTER TABLE service_commands ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_commands_read ON service_commands;
CREATE POLICY service_commands_read ON service_commands
  FOR SELECT TO authenticated
  USING ((SELECT app.is_active_user()) AND (SELECT app.is_manager()));

GRANT SELECT ON service_commands TO authenticated;
