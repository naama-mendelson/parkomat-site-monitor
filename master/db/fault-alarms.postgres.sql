-- ============================================================
-- fault-alarms.postgres.sql — אישור התראות תקלה
-- ============================================================
-- בקשת בעלת המוצר, 22/09/2026: "אני רוצה שיהיו חייבים לאשר הפעלת תקלות".
-- שלוש החלטות שלה, והן שקובעות את המבנה כאן:
--
--   1. **מאשרים התראה**, לא פעולה. כל כניסה לתקלה מחכה לאישור — גם אם
--      האתר כבר חזר לתקין. תקלה של 33 שניות היא בדיוק זו שאיש לא ראה.
--   2. **חלון שחוסם את המסך** עד האישור (בדשבורד — FaultAckModal).
--   3. **אישור אחד לכולם, עם שם.** מישהו מאשר פעם אחת, כל המסכים
--      מתעדכנים, ונשמר מי אישר ומתי. לכן זה במסד ולא בדפדפן.
--
-- ============================================================
-- ⚠️ מי יוצר את ההתראה — טריגר על `events`, ולא הדפדפן
-- ============================================================
-- הדפדפן היה המקום הטבעי: שם כבר מזוהה המעבר לתקלה (useFaultAlerts). אבל
-- עם שני מסכים פתוחים כל אחד היה יוצר שורה משלו — שתי התראות לתקלה אחת —
-- ותקלה שקרתה כשאף מסך לא היה פתוח לא הייתה נרשמת בכלל.
--
-- `events` הוא חוזה האירועים (כלל 8): כל מעבר מצב נכתב לשם, משני מסלולי
-- הקליטה (`app.ingest_state` הישיר ו-`bus.publish` של MQTT). טריגר כאן
-- תופס את שניהם במקום אחד, ובלי לגעת בקוד הקליטה.
--
-- ⚠️ **תקלה בזמן תחזוקה אינה מגיעה לכאן** — `ingest_state` חוזר מוקדם
-- (`suppressed`) לפני שהוא כותב אירוע. כלומר אין צורך בתנאי תחזוקה נוסף.
-- ============================================================

CREATE TABLE IF NOT EXISTS fault_alarms (
  id            BIGSERIAL PRIMARY KEY,
  site_id       INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  site_code     TEXT NOT NULL,                  -- דנורמלי, כמו ב-events: שורד מחיקת אתר
  -- ⚠️ UNIQUE: אירוע אחד — התראה אחת. מגן מפני הרצה כפולה של הטריגר או
  -- החלה חוזרת של הקובץ בזמן שאירוע נכתב.
  event_id      BIGINT UNIQUE,
  occurred_at   TEXT,                           -- מתי קרתה התקלה באתר (occurredAt)
  raised_at     TEXT NOT NULL,                  -- מתי נקלטה (created_at של האירוע)
  fault_text    TEXT,
  acked_at      TEXT,                           -- NULL = ממתינה לאישור
  acked_by      TEXT,                           -- השם שהוקלד: מי ישב מול המסך
  acked_by_name TEXT,                           -- החשבון המאומת שדרכו אושר
  acked_by_role TEXT
);

-- הדשבורד שואל רק "מה עדיין לא אושר" — אינדקס חלקי, שנשאר קטן לנצח.
CREATE INDEX IF NOT EXISTS idx_fault_alarms_open
  ON fault_alarms (id) WHERE acked_at IS NULL;

-- ============================================================
-- הטריגר
-- ============================================================
-- ⚠️ **רק מעבר אל תקלה**, לא כל אירוע שבו newStatus = 'error'. אתר שכבר
-- בתקלה ושולח שוב 'error' נכתב ל-events עם oldStatus = newStatus = 'error'
-- (`ingest_state`, "אין שינוי"), וכל הודעה כזו הייתה פותחת התראה חדשה.
--
-- ⚠️ **כישלון כאן לעולם אינו מפיל את הקליטה.** הטריגר רץ בתוך הטרנזקציה
-- שכותבת את מצב האתר; שגיאה שעולה ממנו הייתה מבטלת את העדכון עצמו, והאתר
-- היה מפסיק להתעדכן בגלל התראה. הבלוק הפנימי הוא תת-טרנזקציה: הכשל נבלע
-- ל-WARNING, והקליטה נמשכת. התראה חסרה היא הפסד; קליטה שנעצרה היא נזק.
CREATE OR REPLACE FUNCTION app.raise_fault_alarm()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
BEGIN
  IF NEW.payload ->> 'newStatus' = 'error'
     AND (NEW.payload ->> 'oldStatus') IS DISTINCT FROM 'error' THEN
    BEGIN
      INSERT INTO fault_alarms (site_id, site_code, event_id, occurred_at, raised_at, fault_text)
      VALUES (NEW.site_id, NEW.site_code, NEW.id,
              NEW.payload ->> 'occurredAt', NEW.created_at, NEW.payload ->> 'faultText')
      ON CONFLICT (event_id) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'fault_alarms: ההתראה לא נרשמה לאירוע % (%): %',
        NEW.id, NEW.site_code, SQLERRM;
    END;
  END IF;
  RETURN NULL;
END;
$fn$;

COMMENT ON FUNCTION app.raise_fault_alarm() IS
  'פותח התראה ממתינה לאישור על כל מעבר אל תקלה ב-events. כישלון נבלע — לא מפיל קליטה.';

DROP TRIGGER IF EXISTS events_raise_fault_alarm ON events;
CREATE TRIGGER events_raise_fault_alarm
  AFTER INSERT ON events
  FOR EACH ROW
  WHEN (NEW.type = 'state')
  EXECUTE FUNCTION app.raise_fault_alarm();

-- ============================================================
-- public.ack_fault_alarms — האישור
-- ============================================================
-- ⚠️ **אותה תבנית כמו start_maintenance, ומאותה סיבה:** הזהות מהחשבון
-- המאומת, **וגם** שם מוקלד. מסך בקרה אחד משרת כמה בקרים מאותו חשבון, ו"אושר
-- ע"י חדר הבקרה" אינו עונה על השאלה "מי ראה את זה".
--
-- ⚠️ **אישור של התראה שכבר אושרה אינו שגיאה** — מחזיר 0. שני מסכים
-- מאשרים באותה שנייה; השני צריך לראות "כבר אושר", לא "נכשל".
--
-- ⚠️ **סוכן אינו מאשר.** גם הוא משתמש פעיל ב-app_users (role='agent'),
-- ו-`actor_display_name` מחזיר לו שם. בלי הבדיקה הזו, סיסמה של אתר אחת
-- הייתה משתיקה את חלון האישור בכל המסכים.
DROP FUNCTION IF EXISTS public.ack_fault_alarms(bigint[], text);

CREATE OR REPLACE FUNCTION public.ack_fault_alarms(p_ids bigint[], p_acked_by text)
RETURNS TABLE (acked integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_name  text;
  v_role  text;
  v_by    text;
  v_now   text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_count integer;
  v_codes text[];
BEGIN
  v_name := app.actor_display_name();
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'נדרשת הזדהות' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_role := app.current_app_role();
  IF v_role = 'agent' THEN
    RAISE EXCEPTION 'סוכן אתר אינו מאשר תקלות' USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_by := NULLIF(TRIM(COALESCE(p_acked_by, '')), '');
  IF v_by IS NULL OR length(v_by) < 2 THEN
    RAISE EXCEPTION 'חובה לציין מי מאשר (שם מלא)' USING ERRCODE = 'check_violation';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RAISE EXCEPTION 'לא נבחרה התראה לאישור' USING ERRCODE = 'check_violation';
  END IF;

  WITH u AS (
    UPDATE fault_alarms f
       SET acked_at = v_now, acked_by = v_by, acked_by_name = v_name, acked_by_role = v_role
     WHERE f.id = ANY (p_ids) AND f.acked_at IS NULL
    RETURNING f.site_code
  )
  SELECT count(*)::int, array_agg(DISTINCT u.site_code) INTO v_count, v_codes FROM u;

  -- שורת תיעוד רק על מה שבאמת אושר עכשיו — לא על ניסיון שמצא הכול מאושר.
  IF v_count > 0 THEN
    PERFORM app.record_write_audit('fault.ack', v_name, v_role,
                                   'site', array_to_string(v_codes, ','),
                                   jsonb_build_object('alarm_ids', p_ids,
                                                      'acked_by', v_by,
                                                      'count', v_count));
  END IF;

  RETURN QUERY SELECT v_count;
END;
$fn$;

COMMENT ON FUNCTION public.ack_fault_alarms(bigint[], text) IS
  'אישור התראות תקלה. זהות מהחשבון + שם מוקלד; סוכן אינו מאשר; מאושרת כבר — 0, לא שגיאה.';

-- `authenticated` קיים תמיד כאן — security.postgres.sql יוצר אותו אם חסר, והקובץ
-- הזה מוחל אחריו. `anon` אינו מובטח מחוץ ל-Supabase, ולכן רק הוא עטוף.
REVOKE ALL ON FUNCTION public.ack_fault_alarms(bigint[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ack_fault_alarms(bigint[], text) TO authenticated;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.ack_fault_alarms(bigint[], text) FROM anon;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

-- ============================================================
-- קריאה, ו-Realtime
-- ============================================================
-- ⚠️ **כל משתמש פעיל רואה כל התראה** — אותו כלל כמו sites ("כל משתמש רואה
-- כל אתר"). אין כתיבה ישירה לאיש: יצירה בטריגר, אישור ב-RPC. GRANT UPDATE
-- היה מאפשר לדפדפן לכתוב acked_by כרצונו, וזה סוף הייחוס.
ALTER TABLE fault_alarms ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fault_alarms_read_authenticated ON fault_alarms;
CREATE POLICY fault_alarms_read_authenticated ON fault_alarms
  FOR SELECT TO authenticated USING ((SELECT app.is_active_user()));
GRANT SELECT ON fault_alarms TO authenticated;

-- ⚠️ **גם UPDATE נדחף, לא רק INSERT:** אישור במסך אחד הוא UPDATE, וכך
-- החלון נסגר בכל שאר המסכים באותה שנייה. REPLICA IDENTITY FULL נדרש ל-
-- Realtime עם RLS — ראה ההסבר ליד events ב-functions.postgres.sql.
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.fault_alarms;
EXCEPTION
  WHEN duplicate_object THEN NULL;   -- כבר בפרסום
  WHEN undefined_object THEN NULL;   -- אין פרסום (Postgres נקי, לא Supabase)
END $$;
ALTER TABLE fault_alarms REPLICA IDENTITY FULL;
