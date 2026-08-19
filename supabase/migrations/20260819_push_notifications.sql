-- db/push.postgres.sql — התראות Push על כניסה למצב תקלה.
--
-- ============================================================
-- מה זה פותר, ולמה זה לא יכול לשבת בשרת
-- ============================================================
-- אנשי שירות צריכים לדעת שאתר נפל **כשהאפליקציה סגורה**. הצליל שקיים
-- היום עובד רק בלשונית פתוחה, וזו בדיוק הסיטואציה שאינה מתקיימת בשטח.
--
-- ⚠️ והשולח אינו יכול להיות ה-master: הוא נופל, וזה בדיוק הרגע שבו
-- ההתראה נחוצה. לכן השליחה היא Edge Function ב-Supabase, והטריגר כאן
-- הוא מה שמפעיל אותה.
--
-- ⚠️ **ומה שזה עדיין לא פותר, ויש לומר במפורש:** הקליטה מ-MQTT יושבת
-- ב-master. אם הוא למטה, התקלה **אינה מתגלה כלל** — ואין התראה על משהו
-- שאיש לא ידע עליו. המעבר ל-Edge Function מגן מפני "השרת רץ והשולח
-- נתקע", לא מפני שרת שנפל.

-- ============================================================
-- pg_net — קריאה **אסינכרונית** מתוך טריגר
-- ============================================================
-- ⚠️ זה הלב של העניין: הקריאה חייבת להיות אסינכרונית. טריגר סינכרוני
-- שנכשל היה מגלגל אחורה את **רישום התקלה עצמו** — כלומר התראה שנכשלה
-- הייתה מוחקת את הנתון. pg_net מכניס את הבקשה לתור, והטרנזקציה נסגרת
-- בלי קשר לתוצאה.
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ============================================================
-- מנויי ה-push — מכשיר אחד לכל שורה
-- ============================================================
-- ⚠️ FK ל-app_users ולא ל-auth.users: כלל 1 בשורש. FK לסכמת האימות אינו
-- עובר ב-pg_dump --schema=public, ומחיקתו היא חצי מהגירה.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            BIGSERIAL PRIMARY KEY,
  app_user_id   INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  -- הכתובת שאצל שירות ה-push מזהה את המכשיר. ⚠️ UNIQUE: אישור חוזר באותו
  -- דפדפן מחזיר את אותו endpoint, ובלי האילוץ היינו שולחים כפול לאותו מכשיר.
  endpoint      TEXT NOT NULL UNIQUE,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  user_agent    TEXT,
  created_at    TEXT NOT NULL,
  -- ⚠️ שירות ה-push מחזיר 410 Gone למכשיר שהוסר. סופרים כדי לנקות, ולא
  -- מוחקים על כשל בודד — ניתוק רשת חולף אינו מכשיר שנעלם.
  failure_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(app_user_id);

-- ============================================================
-- RLS — משתמש רואה ומוחק **רק את המכשירים שלו**
-- ============================================================
-- ⚠️ בשונה משאר הטבלאות, שבהן ההכרעה הייתה "כל אחד רואה הכול". כאן
-- endpoint הוא מזהה מכשיר: חשיפתו מאפשרת לשלוח הודעות לטלפון של מישהו
-- אחר, ומחיקתו משתיקה אותו בלי שידע. זה לא נתון תפעולי, זה מכשיר אישי.
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS push_own_select ON push_subscriptions;
CREATE POLICY push_own_select ON push_subscriptions
  FOR SELECT TO authenticated
  USING (app_user_id = (SELECT u.id FROM app_users u
                         WHERE u.supabase_uid::text = app.current_actor()
                           AND u.is_active));

DROP POLICY IF EXISTS push_own_insert ON push_subscriptions;
CREATE POLICY push_own_insert ON push_subscriptions
  FOR INSERT TO authenticated
  WITH CHECK (app_user_id = (SELECT u.id FROM app_users u
                              WHERE u.supabase_uid::text = app.current_actor()
                                AND u.is_active));

DROP POLICY IF EXISTS push_own_delete ON push_subscriptions;
CREATE POLICY push_own_delete ON push_subscriptions
  FOR DELETE TO authenticated
  USING (app_user_id = (SELECT u.id FROM app_users u
                         WHERE u.supabase_uid::text = app.current_actor()
                           AND u.is_active));

-- ============================================================
-- מניעת הצפה — הערך ב-settings, לא בקוד
-- ============================================================
-- ⚠️ **נשמר ב-settings בבקשת המשתמשת, וזו הבחירה הנכונה:** כיוון החלון
-- נעשה **אחרי** שרואים כמה התראות מגיעות בפועל, וזה בדיוק הרגע שבו לא
-- רוצים סבב פריסה של Edge Function. UPDATE אחד, מיידי.
--
-- ⚠️ ו-0 אינו מקרה מיוחד: הוא פשוט "בלי דילוג", כלומר כל תקלה נשלחת.
-- ⚠️ updated_at הוא NOT NULL בסכמה — השמטתו הפילה את כל האתחול, ולכן
-- גם את עליית השרת. אותו פורמט ISO כמו כל התאריכים כאן.
INSERT INTO settings (key, value, updated_at)
VALUES ('push_window_minutes', '10',
        to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
ON CONFLICT (key) DO NOTHING;

-- מתי נשלחה לאחרונה התראה על כל אתר. ⚠️ טבלה נפרדת ולא עמודה ב-sites:
-- זו עובדה על **ההתראות**, לא על האתר, ומחיקתה אינה נוגעת בנתוני האתר.
CREATE TABLE IF NOT EXISTS push_last_sent (
  site_id INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  sent_at TEXT NOT NULL
);

-- ⚠️ אין מדיניות RLS על שתי טבלאות העזר האלה, ובכוונה: הן נקראות ונכתבות
-- **רק** בידי ה-Edge Function, שרצה עם ה-Secret ועוקפת RLS ממילא. מדיניות
-- שמעניקה גישה לדפדפן הייתה פותחת אותן בלי שיש למי לקרוא מהן.
ALTER TABLE push_last_sent ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- לאיזה אתרים להתריע — העדפה אישית, לא הרשאה
-- ============================================================
-- ⚠️ **זה אינו סותר את ההכרעה ש"כל משתמש רואה כל אתר".** הראייה היא
-- הרשאה; זו העדפה — למי מותר להפריע לי באמצע הלילה. איש שירות שאחראי על
-- שלושה אתרים אינו צריך לקבל התראה על תשעה אחרים, והוא עדיין רואה את
-- כולם במסך.
--
-- ⚠️ **הכלל: אין שורות = כל האתרים.** זו ברירת המחדל וגם המקרה הנפוץ,
-- ולכן היא עולה אפס שורות ואפס תחזוקה. מי שבוחר אתרים מקבל שורה לכל אחד.
--
-- ⚠️ ולכן "לבחור אפס אתרים" אינו מצב אפשרי דרך המסך — הוא זהה ל"הכל",
-- ומי שרוצה לא לקבל התראות כלל מבטל את המנוי עצמו. שני מצבים שנראים
-- דומה ומשמעותם הפוכה, ולכן המסך חייב לומר זאת במפורש.
--
-- ⚠️ ההעדפה היא **לפי משתמש ולא לפי מכשיר**, למרות שהמנוי הוא לפי מכשיר:
-- העניין של אדם באתר אינו משתנה לפי איזה טלפון הוא מחזיק, והפרדה לפי
-- מכשיר הייתה נותנת תוצאות שונות בשקט בשני מכשירים של אותו אדם.
CREATE TABLE IF NOT EXISTS push_user_sites (
  app_user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  site_id     INTEGER NOT NULL REFERENCES sites(id)     ON DELETE CASCADE,
  PRIMARY KEY (app_user_id, site_id)
);

CREATE INDEX IF NOT EXISTS idx_push_sites_site ON push_user_sites(site_id);

-- ⚠️ אותה מדיניות כמו על המנויים, ומאותה סיבה: רשימת האתרים שאדם בחר
-- מלמדת על מה הוא אחראי. זו העדפה אישית, לא נתון תפעולי משותף.
ALTER TABLE push_user_sites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS push_sites_own_select ON push_user_sites;
CREATE POLICY push_sites_own_select ON push_user_sites
  FOR SELECT TO authenticated
  USING (app_user_id = (SELECT u.id FROM app_users u
                         WHERE u.supabase_uid::text = app.current_actor()
                           AND u.is_active));

DROP POLICY IF EXISTS push_sites_own_insert ON push_user_sites;
CREATE POLICY push_sites_own_insert ON push_user_sites
  FOR INSERT TO authenticated
  WITH CHECK (app_user_id = (SELECT u.id FROM app_users u
                              WHERE u.supabase_uid::text = app.current_actor()
                                AND u.is_active));

DROP POLICY IF EXISTS push_sites_own_delete ON push_user_sites;
CREATE POLICY push_sites_own_delete ON push_user_sites
  FOR DELETE TO authenticated
  USING (app_user_id = (SELECT u.id FROM app_users u
                         WHERE u.supabase_uid::text = app.current_actor()
                           AND u.is_active));

-- ============================================================
-- למי לשלוח על תקלה באתר מסוים
-- ============================================================
-- ⚠️ הפונקציה הזו היא **ההגדרה היחידה** של "מי מנוי לאתר", וה-Edge
-- Function קוראת לה במקום לשכפל את הכלל ב-TypeScript. שני עותקים של כלל
-- כזה נפרדים ביום שבו מישהו יתקן אחד מהם, והתסמין הוא התראה שלא הגיעה —
-- כשל שקט שאין עליו שום סימן.
CREATE OR REPLACE FUNCTION app.push_targets_for_site(p_site_id integer)
RETURNS TABLE (endpoint text, p256dh text, auth text, subscription_id bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
  SELECT s.endpoint, s.p256dh, s.auth, s.id
    FROM push_subscriptions s
    JOIN app_users u ON u.id = s.app_user_id
   WHERE u.is_active
     -- אין שורות בכלל = כל האתרים. יש שורות = רק מה שנבחר.
     AND (NOT EXISTS (SELECT 1 FROM push_user_sites f WHERE f.app_user_id = u.id)
          OR EXISTS (SELECT 1 FROM push_user_sites f
                      WHERE f.app_user_id = u.id AND f.site_id = p_site_id));
$$;

COMMENT ON FUNCTION app.push_targets_for_site(integer) IS
  'המכשירים שאמורים לקבל התראה על תקלה באתר. אין שורות ב-push_user_sites = כל האתרים.';

-- ============================================================
-- אילו סוגי התראות — וברירת המחדל הפוכה מזו של האתרים
-- ============================================================
-- ⚠️ **באתרים "אין שורות = הכל". כאן "אין שורות = תקלה בלבד".** ההיפוך
-- מכוון: לקבל התראה על אתר מיותר הוא רעש קטן, ולקבל **סוג** מיותר הוא
-- רעש שמכבה את כל המערכת.
--
-- ⚠️ והמספרים אינם תיאורטיים. נמדד בפרויקט הזה: אתר 2439 מנותק כרבע
-- מהזמן. מי שידליק no_comm יקבל עשרות התראות ביום, יכבה הכול — **כולל את
-- התקלות**. סוג רועש אחד הורג את המנגנון כולו, ולכן הוא לעולם לא ברירת
-- מחדל, והמסך חייב לומר כמה זה בערך ולא רק להציע תיבת סימון.
CREATE TABLE IF NOT EXISTS push_user_types (
  app_user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  -- fault | maintenance | no_comm
  kind        TEXT NOT NULL CHECK (kind IN ('fault', 'maintenance', 'no_comm')),
  PRIMARY KEY (app_user_id, kind)
);

ALTER TABLE push_user_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS push_types_own_select ON push_user_types;
CREATE POLICY push_types_own_select ON push_user_types
  FOR SELECT TO authenticated
  USING (app_user_id = (SELECT u.id FROM app_users u
                         WHERE u.supabase_uid::text = app.current_actor() AND u.is_active));

DROP POLICY IF EXISTS push_types_own_insert ON push_user_types;
CREATE POLICY push_types_own_insert ON push_user_types
  FOR INSERT TO authenticated
  WITH CHECK (app_user_id = (SELECT u.id FROM app_users u
                              WHERE u.supabase_uid::text = app.current_actor() AND u.is_active));

DROP POLICY IF EXISTS push_types_own_delete ON push_user_types;
CREATE POLICY push_types_own_delete ON push_user_types
  FOR DELETE TO authenticated
  USING (app_user_id = (SELECT u.id FROM app_users u
                         WHERE u.supabase_uid::text = app.current_actor() AND u.is_active));

-- ============================================================
-- היעדים — עכשיו גם לפי סוג
-- ============================================================
-- ⚠️ DROP ולא REPLACE: נוסף פרמטר, ו-CREATE OR REPLACE אינו יכול לשנות
-- חתימה. בלי ה-DROP היו נשארות **שתי** גרסאות, וקריאה עם ארגומנט אחד
-- הייתה ממשיכה לעבוד ולהתעלם מהסוג — כלומר להתריע על הכול בשקט.
DROP FUNCTION IF EXISTS app.push_targets_for_site(integer);

CREATE OR REPLACE FUNCTION app.push_targets_for_site(p_site_id integer, p_kind text)
RETURNS TABLE (endpoint text, p256dh text, auth text, subscription_id bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
  SELECT s.endpoint, s.p256dh, s.auth, s.id
    FROM push_subscriptions s
    JOIN app_users u ON u.id = s.app_user_id
   WHERE u.is_active
     -- אתרים: אין שורות = כל האתרים
     AND (NOT EXISTS (SELECT 1 FROM push_user_sites f WHERE f.app_user_id = u.id)
          OR EXISTS (SELECT 1 FROM push_user_sites f
                      WHERE f.app_user_id = u.id AND f.site_id = p_site_id))
     -- סוגים: אין שורות = תקלה בלבד
     AND (CASE
            WHEN EXISTS (SELECT 1 FROM push_user_types t WHERE t.app_user_id = u.id)
              THEN EXISTS (SELECT 1 FROM push_user_types t
                            WHERE t.app_user_id = u.id AND t.kind = p_kind)
            ELSE p_kind = 'fault'
          END);
$$;

COMMENT ON FUNCTION app.push_targets_for_site(integer, text) IS
  'מכשירים לקבלת התראה. אין שורות ב-push_user_sites = כל האתרים; אין ב-push_user_types = תקלה בלבד.';

-- ============================================================
-- מעטפת ב-public — כי supabase-js רואה רק אותו
-- ============================================================
-- ⚠️ ה-Edge Function קוראת דרך supabase-js, ו-PostgREST חושף **רק** את
-- schema public. הפונקציה ב-app אינה נגישה לה, והשגיאה שהתקבלה בפועל
-- הייתה "Could not find the function public.push_targets_for_site".
--
-- ⚠️ **וזו הפונקציה המסוכנת ביותר בקובץ הזה.** היא מחזירה endpoints של
-- **כל** המשתמשים — כלומר את המפתחות שמאפשרים לשלוח התראה לכל טלפון
-- במערכת. חשיפתה ל-authenticated הייתה מבטלת בבת אחת את כל מדיניות ה-RLS
-- שנכתבה מעליה, כי כל מי שמחובר היה מקבל את מה שהמדיניות מסתירה.
--
-- לכן: REVOKE מכולם, ו-GRANT ל-service_role **בלבד** — התפקיד שה-Edge
-- Function רצה בו, ושאינו קיים בדפדפן.
CREATE OR REPLACE FUNCTION public.push_targets_for_site(p_site_id integer, p_kind text)
RETURNS TABLE (endpoint text, p256dh text, auth text, subscription_id bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
  SELECT * FROM app.push_targets_for_site(p_site_id, p_kind);
$$;

REVOKE ALL ON FUNCTION public.push_targets_for_site(integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.push_targets_for_site(integer, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.push_targets_for_site(integer, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.push_targets_for_site(integer, text) TO service_role;

-- ============================================================
-- הטריגר — מה שהופך את זה לאוטומטי
-- ============================================================
-- ⚠️ **pg_net, כלומר אסינכרוני.** זה לא פרט מימוש: טריגר סינכרוני שנכשל
-- היה מגלגל אחורה את ה-INSERT שהפעיל אותו — כלומר **התראה שנכשלה הייתה
-- מוחקת את רישום התקלה עצמו**. net.http_post מכניס את הבקשה לתור ומחזיר
-- מיד; הטרנזקציה נסגרת בלי קשר לתוצאה.
--
-- ⚠️ ורק על **כניסה** למצב. שורה ב-status_history נוצרת רק במעבר —
-- state-handler.js:95 חוסם מצב זהה — ולכן עצם קיומה של השורה **הוא**
-- הכניסה. אין צורך להשוות למצב הקודם.
--
-- ⚠️ ותקלה בזמן תחזוקה אינה מגיעה לכאן כלל: היא נחסמת ב-state-handler.js:53
-- ונרשמת ב-suppressed_faults, בלי שורת status_history. הכלל נאכף בקליטה,
-- ולא צריך תנאי כאן.
CREATE OR REPLACE FUNCTION app.notify_push_on_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_site   record;
  v_kind   text;
BEGIN
  -- fault ו-no_comm בלבד. 'ready' ו-'operating' אינם אירועים להתריע עליהם,
  -- ו-'maintenance' מהבקר אינו פעולה של אדם ולכן אינו נכנס לסוג 'maintenance'.
  v_kind := CASE NEW.status WHEN 'error' THEN 'fault'
                            WHEN 'no_comm' THEN 'no_comm'
                            ELSE NULL END;
  IF v_kind IS NULL THEN RETURN NEW; END IF;

  SELECT s.code, s.site_name INTO v_site FROM sites s WHERE s.id = NEW.site_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  -- ⚠️ המפתח הציבורי בכותרת, ולא הסודי. הפונקציה עצמה משתמשת ב-service_role
  -- מתוך סביבתה; מה שנדרש כאן הוא רק להיכנס בשער של Edge Functions.
  PERFORM net.http_post(
    url     := 'https://xvfsikwaaaohnmldjbtv.supabase.co/functions/v1/notify-fault',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.push_anon_key', true)
    ),
    body    := jsonb_build_object(
      'site_id',    NEW.site_id,
      'site_code',  v_site.code,
      'site_name',  v_site.site_name,
      'kind',       v_kind,
      'fault_text', NEW.fault_text
    )
  );
  RETURN NEW;
END;
$fn$;

-- ============================================================
-- ⚠️ GRANT — מדיניות RLS אינה מעניקה גישה, היא רק מסננת שורות
-- ============================================================
-- זה נשכח, והתסמין היה "permission denied for table push_subscriptions"
-- על המסך. Postgres בודק קודם הרשאה ברמת הטבלה; בלי GRANT הוא חוסם לפני
-- שהמדיניות בכלל נבדקת. שלוש מדיניות מושלמות מעל טבלה בלי GRANT = אפס.
GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE push_subscriptions_id_seq TO authenticated;
GRANT SELECT, INSERT, DELETE ON push_user_sites TO authenticated;
GRANT SELECT, INSERT, DELETE ON push_user_types TO authenticated;

-- ⚠️ ו-push_last_sent נסגר במפורש: Supabase מעניקה הרשאות ברירת מחדל
-- לטבלאות חדשות ב-public, ולכן הוא **היה** נגיש לדפדפן בלי שביקשנו.
-- הוא נתון פנימי של השליחה ואין לו קורא בדפדפן.
REVOKE ALL ON push_last_sent FROM authenticated;
REVOKE ALL ON push_last_sent FROM anon;

-- ============================================================
-- my_app_user_id — ובאג שנתפס רק בבדיקה חיה
-- ============================================================
-- ⚠️ הקוד בדשבורד עשה `.from("app_users").select("id").limit(1)` כדי
-- למצוא את המשתמש הנוכחי. **זה מחזיר את השורה הראשונה בטבלה**, לא אותו:
-- app_users קריא לכל מחובר. התוצאה הייתה מזהה של מישהו אחר, ומדיניות
-- ה-INSERT דחתה ב-403 "violates row-level security" — שגיאה שנראית כמו
-- בעיית הרשאות ובאמת הייתה מזהה שגוי.
--
-- ⚠️ ולא נתפס בשום בדיקת מבנה: הקריאה תקינה, הטיפוס נכון, והתשובה היא
-- מספר. רק ניסיון כתיבה אמיתי כמשתמש מחובר חשף אותה.
CREATE OR REPLACE FUNCTION public.my_app_user_id()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
  SELECT u.id FROM app_users u
   WHERE u.supabase_uid::text = app.current_actor() AND u.is_active
   LIMIT 1
$fn$;

REVOKE ALL ON FUNCTION public.my_app_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_app_user_id() TO authenticated;

-- ============================================================
-- verified_at — כדי שנגיעה שקטה לא תישאר שקטה
-- ============================================================
-- ⚠️ **iOS מוחק PWA שלא נפתח כשבועיים, כולל ההרשמה להתראות.** איש שירות
-- שלא נכנס שבועיים יפסיק לקבל התראות — ולא יידע. הוא יניח שאין תקלות,
-- וזה הכשל הגרוע ביותר האפשרי כאן: שקט שנקרא כ"הכול בסדר".
--
-- העמודה הזו היא מה שמאפשר להבדיל. כל פתיחה של האפליקציה מאמתת את המנוי
-- מול pushManager ומעדכנת אותה; מנוי שלא אומת זמן רב מוצג במסך כלא-מכוסה.
--
-- ⚠️ זה **אינו** פותר את הבעיה — אין דרך להריץ קוד באפליקציה שנמחקה.
-- הוא רק הופך אובדן שקט לאובדן שרואים.
ALTER TABLE push_subscriptions
  ADD COLUMN IF NOT EXISTS verified_at TEXT;

-- מאתחלים לזמן היצירה: מנוי חדש אומת עכשיו בהגדרה.
UPDATE push_subscriptions SET verified_at = created_at WHERE verified_at IS NULL;

-- ============================================================
-- מחיקת משתמש — הכללים ב-SQL, לא ב-Edge Function
-- ============================================================
-- ⚠️ הגרסה הראשונה של הפונקציה עשתה את הכול דרך לקוח service_role: שולפת
-- מ-app_users, בודקת את המנעולים ב-TypeScript, ומוחקת. **נמדד: היא נכשלה
-- ב-"permission denied for table app_users"** — הלקוח בפונקציה אינו עוקף
-- RLS כפי שהונח.
--
-- התיקון אינו למצוא מפתח חזק יותר אלא ללכת בתבנית שכבר עובדת בכל הפרויקט:
-- SECURITY DEFINER עם בדיקת זהות בגוף הפונקציה, בדיוק כמו start_maintenance
-- ו-register_site.
--
-- ⚠️ ויתרון שלא היה קודם: **שני המנעולים חיים עכשיו במסד.** גם קריאה
-- ישירה שעוקפת את ה-Edge Function תיתקל בהם.
--
-- ⚠️ ושתי פונקציות ולא אחת, כי הסדר קריטי: בדיקה → מחיקה ב-Supabase →
-- מחיקה אצלנו. הסדר ההפוך משאיר, בכשל, משתמש שיכול להתחבר בלי שורת
-- app_users — מאומת, בלי זהות, ו-provision_app_user לא ייצור לו שורה כי
-- אין INSERT נוסף.

-- שלב 1: אוכף את כל הכללים ומחזיר את מה שצריך למחיקה ב-Supabase.
CREATE OR REPLACE FUNCTION public.delete_user_check(p_id integer)
RETURNS TABLE (uid text, email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp
AS $fn$
DECLARE me integer; t record; mgrs integer;
BEGIN
  IF NOT app.is_manager() THEN
    RAISE EXCEPTION 'הפעולה מותרת למנהלים בלבד' USING ERRCODE='insufficient_privilege';
  END IF;
  SELECT u.id INTO me FROM app_users u
   WHERE u.supabase_uid::text = app.current_actor() AND u.is_active;
  SELECT * INTO t FROM app_users WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'משתמש לא נמצא' USING ERRCODE='PT404'; END IF;

  -- ⚠️ מנהל שמשבית את עצמו יכול להיות מוחזר בידי אחר. מנהל שמוחק את עצמו
  -- כשאין מנהל נוסף אינו משאיר שום דרך חזרה מהממשק.
  IF t.id = me THEN
    RAISE EXCEPTION 'אי אפשר למחוק את עצמך' USING ERRCODE='check_violation';
  END IF;
  SELECT COUNT(*) INTO mgrs FROM app_users WHERE role='manager' AND is_active;
  IF t.role='manager' AND t.is_active AND mgrs <= 1 THEN
    RAISE EXCEPTION 'לא ניתן למחוק את המנהל הפעיל האחרון' USING ERRCODE='check_violation';
  END IF;

  RETURN QUERY SELECT t.supabase_uid::text, t.email;
END;
$fn$;

-- שלב 2: מוחק את השורה **וכותב את הביקורת באותה פעולה**, כך שהיא נרשמת
-- רק אם המחיקה באמת קרתה.
CREATE OR REPLACE FUNCTION public.delete_user_finish(p_id integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp
AS $fn$
DECLARE me integer; nm text; em text;
BEGIN
  IF NOT app.is_manager() THEN
    RAISE EXCEPTION 'הפעולה מותרת למנהלים בלבד' USING ERRCODE='insufficient_privilege';
  END IF;
  SELECT u.id, u.email INTO me, nm FROM app_users u
   WHERE u.supabase_uid::text = app.current_actor() AND u.is_active;
  SELECT email INTO em FROM app_users WHERE id = p_id;
  DELETE FROM app_users WHERE id = p_id;
  PERFORM app.record_write_audit('user.delete', nm, 'manager', 'user', p_id::text,
                                 jsonb_build_object('email', em, 'via', 'edge-function'));
  RETURN p_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.delete_user_check(integer)  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_user_finish(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_user_check(integer)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_user_finish(integer) TO authenticated;

-- ============================================================
-- ⚠️ delete_user — RPC אחד, בלי Edge Function ובלי שרת
-- ============================================================
-- שתי הגרסאות הקודמות נכשלו, וכל אחת לימדה משהו:
--   1. לקוח service_role ב-Edge Function → "permission denied for table
--      app_users". ההנחה שהוא עוקף RLS לא החזיקה.
--   2. פיצול לשתי RPC + Edge Function → עבד, אבל דרש **פריסה** שאינה
--      עוברת ב-git: תיקון נדחף ל-main ולא הגיע לייצור עד שמישהו הריץ
--      פקודה ידנית. זה בדיוק הפער שהחזיר את אותה שגיאה שוב ושוב.
--
-- RPC מוחל ברגע שהוא נוצר במסד. אין מה לפרוס.
--
-- ⚠️ **ויתרון אמיתי מעבר לנוחות: הכול בטרנזקציה אחת.** הגרסה הקודמת מחקה
-- ב-Supabase ואז אצלנו בשתי קריאות נפרדות, וכשל בין השתיים היה משאיר
-- משתמש שיכול להתחבר בלי שורת זהות — מאומת, בלי מי שהוא. כאן שתי
-- המחיקות מתחייבות יחד או נכשלות יחד.
--
-- ⚠️ ומחיקה ישירה מ-auth.users: זה מה שה-Admin API עושה מתחת לפני השטח,
-- והיא מותרת כאן כי הפונקציה בבעלות postgres. זה מה שמסיר את הצורך
-- ב-Secret key לגמרי — הפעולה היחידה שנשארה שדרשה אותו.
CREATE OR REPLACE FUNCTION public.delete_user(p_id integer)
RETURNS TABLE (id integer, email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, auth, pg_temp
AS $fn$
DECLARE me integer; nm text; t record; mgrs integer;
BEGIN
  IF NOT app.is_manager() THEN
    RAISE EXCEPTION 'הפעולה מותרת למנהלים בלבד' USING ERRCODE='insufficient_privilege';
  END IF;
  SELECT u.id, u.email INTO me, nm FROM app_users u
   WHERE u.supabase_uid::text = app.current_actor() AND u.is_active;
  SELECT * INTO t FROM app_users WHERE app_users.id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'משתמש לא נמצא' USING ERRCODE='PT404'; END IF;

  -- ⚠️ מנהל שמשבית את עצמו יכול להיות מוחזר בידי אחר. מנהל שמוחק את עצמו
  -- כשאין מנהל נוסף אינו משאיר שום דרך חזרה מהממשק.
  IF t.id = me THEN
    RAISE EXCEPTION 'אי אפשר למחוק את עצמך' USING ERRCODE='check_violation';
  END IF;
  SELECT COUNT(*) INTO mgrs FROM app_users WHERE role='manager' AND is_active;
  IF t.role='manager' AND t.is_active AND mgrs <= 1 THEN
    RAISE EXCEPTION 'לא ניתן למחוק את המנהל הפעיל האחרון' USING ERRCODE='check_violation';
  END IF;

  -- ⚠️ הביקורת **לפני** המחיקה, כי אחריה t.email כבר לא ניתן לשליפה —
  -- והיא בתוך אותה טרנזקציה, כך שהיא נסוגה יחד עם כישלון.
  PERFORM app.record_write_audit('user.delete', nm, 'manager', 'user', p_id::text,
                                 jsonb_build_object('email', t.email, 'role', t.role, 'via', 'rpc'));

  DELETE FROM app_users WHERE app_users.id = p_id;
  IF t.supabase_uid IS NOT NULL THEN
    DELETE FROM auth.users WHERE auth.users.id = t.supabase_uid;
  END IF;

  RETURN QUERY SELECT p_id, t.email;
END;
$fn$;

REVOKE ALL ON FUNCTION public.delete_user(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_user(integer) TO authenticated;

-- הפונקציות של הגרסה הקודמת נמחקות: פונקציה נטושה היא מה שמישהו ימצא
-- בעוד שנה ויקרא לה.
DROP FUNCTION IF EXISTS public.delete_user_check(integer);
DROP FUNCTION IF EXISTS public.delete_user_finish(integer);

-- ============================================================
-- קוד המנהל — צעד אישור, לא הגנה
-- ============================================================
-- ⚠️ **ההגנה האמיתית היא app.require_manager() בתוך פונקציות הכתיבה.**
-- בקר שינסה לרשום או למחוק אתר יקבל 403 מהמסד, בין אם הקוד בידיו ובין
-- אם לא. נבדק חי.
--
-- מה שהקוד כן: **צעד אישור לפני פעולה בלתי-הפיכה.** מחיקת אתר מוחקת
-- היסטוריה, ושינוי `code` מפנה מחדש את הודעות ה-MQTT — שתיהן בלי ביטול,
-- ולחיצה מקרית עליהן יקרה.
--
-- ⚠️ **והגיבוב לעולם אינו מגיע לדפדפן.** ההשוואה כאן; מה שנשלח הוא הקוד
-- ומה שחוזר true/false. זו בדיוק הסיבה ש-`settings` היא הטבלה היחידה בלי
-- מדיניות RLS — נמדד: קריאה ישירה אליה מהדפדפן מחזירה 403.
--
-- ⚠️ ו-sha256 מובנה ולא pgcrypto: אותו אלגוריתם בדיוק שהשרת השתמש בו
-- (crypto.createHash("sha256")...digest("hex")), ולכן הקוד הקיים ממשיך
-- לעבוד בלי איפוס. נמדד מול הגיבוב שכבר במסד.
CREATE OR REPLACE FUNCTION public.verify_admin_code(p_code text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp
AS $fn$
DECLARE h text;
BEGIN
  IF app.current_actor() IS NULL THEN
    RAISE EXCEPTION 'נדרשת הזדהות' USING ERRCODE='insufficient_privilege';
  END IF;
  SELECT value INTO h FROM settings WHERE key='admin_code_hash';
  IF h IS NULL THEN RETURN false; END IF;
  -- ⚠️ מחזיר false ואינו זורק: "קוד שגוי" אינו תקלה. זריקה הייתה נראית
  -- במסך כנפילת רשת, ומי שהקליד לא נכון היה מחפש בעיה שאינה קיימת.
  RETURN h = encode(sha256(convert_to(coalesce(p_code,''),'utf8')),'hex');
END;
$fn$;

CREATE OR REPLACE FUNCTION public.set_admin_code(p_current text, p_new text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp
AS $fn$
DECLARE h text;
BEGIN
  IF NOT app.is_manager() THEN
    RAISE EXCEPTION 'הפעולה מותרת למנהלים בלבד' USING ERRCODE='insufficient_privilege';
  END IF;
  IF length(coalesce(p_new,'')) < 4 THEN
    RAISE EXCEPTION 'הקוד החדש קצר מדי' USING ERRCODE='check_violation';
  END IF;
  SELECT value INTO h FROM settings WHERE key='admin_code_hash';
  IF h IS NOT NULL AND h <> encode(sha256(convert_to(coalesce(p_current,''),'utf8')),'hex') THEN
    RAISE EXCEPTION 'הקוד הנוכחי שגוי' USING ERRCODE='insufficient_privilege';
  END IF;
  INSERT INTO settings (key, value, updated_at)
  VALUES ('admin_code_hash', encode(sha256(convert_to(p_new,'utf8')),'hex'),
          to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at;
  RETURN true;
END;
$fn$;

REVOKE ALL ON FUNCTION public.verify_admin_code(text)      FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_admin_code(text, text)   FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_admin_code(text)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_admin_code(text, text) TO authenticated;
