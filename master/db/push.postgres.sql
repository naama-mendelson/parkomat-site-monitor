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
