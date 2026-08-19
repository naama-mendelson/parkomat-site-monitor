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
