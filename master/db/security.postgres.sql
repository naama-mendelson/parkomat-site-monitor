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
-- לשם את תפקיד ה-Postgres, ודריסה שלו הייתה שוברת את PostgREST עצמו.
CREATE OR REPLACE FUNCTION app.current_role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
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
