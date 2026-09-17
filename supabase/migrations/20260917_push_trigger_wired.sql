-- ============================================================
-- התראת תקלת אתר — הטריגר מחובר, ומזדהה
-- ============================================================
-- ⚠️ **שלושה דברים, וכל אחד לבדו הספיק כדי שאף התראת אתר לא תגיע:**
--
--   1. **אין `CREATE TRIGGER` בשום מקום בגיט.** c27f1cf ("הטריגר — התראה
--      נשלחת מעצמה כשאתר נופל") הוסיף את הפונקציה `app.notify_push_on_status`
--      בלבד; בכל ההיסטוריה של 20260819_push_notifications.sql אין שורת
--      TRIGGER אחת. אם קיים טריגר בייצור — הוא נוצר ביד ואינו נוסע ב-pg_dump.
--   2. **הכותרת הייתה NULL.** `'Bearer ' || current_setting('app.push_anon_key', true)`
--      — GUC שאי אפשר להגדיר ב-Supabase (permission denied to set parameter),
--      ו-`'x' || NULL` הוא NULL. `send_push` תוקן לקרוא מ-settings ב-359a448;
--      הטריגר נשאר עם הגרסה השבורה.
--   3. **notify-fault דוחה עכשיו קורא בלי `x-parkomat-push-secret`**, כי המפתח
--      הפומבי לבדו עבר את השער.
--
-- מכאן: הפונקציה עוברת דרך `app.push_request` (master/db/cron.postgres.sql),
-- שם המפתח והסוד נקראים מ-settings — מקום אחד לשני השולחים.
--
-- ============================================================
-- ⚠️ הטריגר **אינו רשאי להפיל את הקליטה**
-- ============================================================
-- הוא רץ בתוך הטרנזקציה שכותבת את שורת התקלה. חריגה כאן — `push_request`
-- שעוד לא הוחל (master לא עלה אחרי הפריסה), pg_net שאינו זמין — הייתה מגלגלת
-- אחורה את **רישום התקלה עצמו**. לכן כל הקריאה עטופה, והכישלון הוא WARNING.
--
-- ⚠️ **סדר הפריסה:**
--   1. `INSERT INTO settings (key, value, updated_at) VALUES ('push_caller_secret', '<סוד>', now()::text)`
--   2. `supabase secrets set PUSH_CALLER_SECRET=<אותו סוד>`
--   3. עליית master (מחילה את cron.postgres.sql עם `app.push_request`)
--   4. `supabase functions deploy notify-fault`
--   5. `supabase db push` (הקובץ הזה)
-- כל סדר אחר אינו מפיל את הקליטה — לכל היותר התראות לא יוצאות עד שהשלבים נסגרים.

CREATE OR REPLACE FUNCTION app.notify_push_on_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_site record;
  v_kind text;
BEGIN
  -- fault ו-no_comm בלבד. 'ready' ו-'operating' אינם אירועים להתריע עליהם,
  -- ו-'maintenance' מהבקר אינו פעולה של אדם ולכן אינו נכנס לסוג 'maintenance'.
  v_kind := CASE NEW.status WHEN 'error' THEN 'fault'
                            WHEN 'no_comm' THEN 'no_comm'
                            ELSE NULL END;
  IF v_kind IS NULL THEN RETURN NEW; END IF;

  SELECT s.code, s.site_name INTO v_site FROM sites s WHERE s.id = NEW.site_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  BEGIN
    PERFORM app.push_request(jsonb_build_object(
      'site_id',    NEW.site_id,
      'site_code',  v_site.code,
      'site_name',  v_site.site_name,
      'kind',       v_kind,
      'fault_text', NEW.fault_text));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'app.notify_push_on_status: ההתראה לא נשלחה (%), התקלה נרשמה', SQLERRM;
  END;
  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION app.notify_push_on_status() FROM PUBLIC;

DROP TRIGGER IF EXISTS notify_push_on_status ON status_history;
CREATE TRIGGER notify_push_on_status
  AFTER INSERT ON status_history
  FOR EACH ROW EXECUTE FUNCTION app.notify_push_on_status();
