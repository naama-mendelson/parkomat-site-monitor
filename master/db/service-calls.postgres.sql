-- db/service-calls.postgres.sql — קליטת קריאות שירות מאפליקציית הלקוחות.
--
-- ============================================================
-- ⚠️ הכתובת קבועה לנצח — ומכאן כל התכנון
-- ============================================================
-- צוות האפליקציה שולח היום את הקריאות ל-WIZENET, ואנחנו מבקשים שישלחו
-- אותן אלינו. הם שולחים **בדיוק את אותה בקשה**, ורק הכתובת מתחלפת —
-- כלומר הכתובת שנמסור להם היא חוזה שאי אפשר לשנות אחר כך.
--
-- ⚠️ **ולכן הדלת מקבלת הכול ואינה דוחה דבר.** טבלה עם שדות מוגדרים
-- מראש הייתה דוחה את ההודעה הראשונה שבה שדה אחד אינו כמצופה — וזו
-- בדיוק ההודעה שממנה אמורים ללמוד את המבנה. מה שנשמר הוא:
--
--   raw      — גוף הבקשה מילה במילה, גם אם אינו JSON תקין בכלל
--   payload  — אותו גוף מפורק, **כשהוא ניתן לפירוק**; אחרת NULL
--
-- משם אפשר להוסיף עמודות מסודרות (גם כעמודות מחושבות מעל `payload`)
-- בלי לגעת בכתובת, בלי לבקש מהם דבר, ובלי לאבד הודעה אחת.
--
-- ⚠️ **ו-`raw` אינו כפילות של `payload`.** jsonb מאבד סדר מפתחות, מאבד
-- מפתח כפול, ומנרמל מספרים. ביום שנצטרך להוכיח מה בדיוק הגיע — למשל
-- מול צוות האפליקציה — השאלה תהיה על הבתים שנשלחו, לא על הפירוק שלנו.
--
-- ============================================================
-- ⚠️ הזהות: משתמש ייעודי שאינו משתמש במערכת
-- ============================================================
-- הדרישה היא "משתמש עם INSERT בלבד". הוא **אינו** נרשם ב-`app_users`,
-- ובכוונה: הטבלה הזו היא רשימת בני האדם שיש להם גישה למערכת, וזהות של
-- מכונה שמוזרקת לתוכה תופיע ממילא בכל מסך ניהול משתמשים ותיראה כמו
-- אדם. במקום זה המזהה שלה יושב ב-`settings`, וההרשאה נגזרת ממנו.
--
-- ⚠️ וזה גם מה שהופך **ביטול** לשורה אחת: מחיקת המפתח `intake_user_id`
-- או כיבוי `intake_enabled` סוגרים את הדלת מיד, בלי להסתמך על כך שמישהו
-- יחליף כתובת אצל צד שלישי.

-- ============================================================
-- הטבלה
-- ============================================================
CREATE TABLE IF NOT EXISTS service_calls (
  id           bigserial PRIMARY KEY,

  -- ⚠️ טקסט ISO ב-UTC, כמו כל חותמות הזמן בפרויקט. עקביות חשובה כאן
  -- יותר מנוחות: כל השאילתות הקיימות מניחות את הצורה הזו.
  received_at  text NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),

  -- מי שלח. היום 'app'; ביום שיתווסף מקור שני, הוא לא יתחזה לראשון.
  source       text NOT NULL DEFAULT 'app',

  -- הגוף כפי שהתקבל, מילה במילה.
  raw          text NOT NULL,

  -- אותו גוף מפורק. NULL = הגיע משהו שאינו JSON — וזו עובדה ששווה לדעת,
  -- לא סיבה לדחות.
  payload      jsonb,

  -- הכותרות והכתובת, כדי ללמוד מה הם באמת שולחים. הסוד מהכתובת אינו
  -- נשמר כאן — ראה את הפונקציה שמכניסה.
  headers      jsonb,
  remote_ip    text,

  -- ⚠️ תקרה על הגוף: דלת פתוחה לאינטרנט בלי גבול גודל היא דרך למלא את
  -- המסד. 100KB הם פי כמה מכל קריאת שירות סבירה.
  CONSTRAINT service_calls_raw_size CHECK (octet_length(raw) <= 100000),

  -- אם הגיע JSON — הוא חייב להיות אובייקט. מערך או מחרוזת בודדת אינם
  -- קריאת שירות, והשמירה שלהם כ-payload הייתה שוברת כל עמודה מחושבת.
  CONSTRAINT service_calls_payload_object CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_service_calls_received ON service_calls (received_at DESC);

COMMENT ON TABLE service_calls IS
  'קריאות שירות מאפליקציית הלקוחות. raw הוא מקור האמת; payload הוא הפירוק.';

-- ============================================================
-- הזהות וכפתור הכיבוי
-- ============================================================
CREATE OR REPLACE FUNCTION app.intake_user_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
  SELECT nullif(trim(value), '') FROM settings WHERE key = 'intake_user_id';
$$;

-- ⚠️ ברירת המחדל היא **סגור**. מפתח שלא הוגדר פירושו שאין זהות קולטת,
-- ולא "כל אחד" — אותו כלל כמו בכל שאר ההרשאות כאן.
CREATE OR REPLACE FUNCTION app.is_intake_client()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
  SELECT app.intake_user_id() IS NOT NULL
     AND app.current_actor() IS NOT NULL
     AND app.current_actor() = app.intake_user_id();
$$;

-- ⚠️ כאן דווקא ברירת המחדל היא **פתוח**: הדגל קיים כדי לסגור דלת שעובדת,
-- ומפתח חסר אינו "כבוי". דגל שמתחיל כבוי היה מפיל את הקליטה ביום שמישהו
-- יריץ מסד נקי, והכשל היה נראה כמו בעיה אצל צוות האפליקציה.
CREATE OR REPLACE FUNCTION app.intake_enabled()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
  SELECT COALESCE((SELECT value FROM settings WHERE key = 'intake_enabled'), 'true') = 'true';
$$;

REVOKE ALL ON FUNCTION app.intake_user_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.is_intake_client() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.intake_enabled() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_intake_client() TO authenticated;
GRANT EXECUTE ON FUNCTION app.intake_enabled() TO authenticated;

-- ============================================================
-- ההרשאות: הכנסה בלבד לקולט, קריאה בלבד לצוות
-- ============================================================
ALTER TABLE service_calls ENABLE ROW LEVEL SECURITY;

-- ⚠️ **אין מדיניות UPDATE ואין DELETE — לאף אחד.** קריאה של לקוח היא
-- עובדה שהתקבלה, ואין סיבה שמישהו יערוך אותה דרך PostgREST. תיקון, אם
-- יידרש אי פעם, נעשה בכוונה ובכלי נפרד.
DROP POLICY IF EXISTS service_calls_insert_intake ON service_calls;
CREATE POLICY service_calls_insert_intake ON service_calls
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT app.is_intake_client()) AND (SELECT app.intake_enabled()));

-- ⚠️ והקולט **אינו** קורא: אין לו מדיניות SELECT, ולכן גם `Prefer:
-- return=representation` לא יחזיר לו את השורה. דלת שמכניסה ואינה מציצה.
DROP POLICY IF EXISTS service_calls_read_staff ON service_calls;
CREATE POLICY service_calls_read_staff ON service_calls
  FOR SELECT TO authenticated
  USING ((SELECT app.is_active_user()) AND NOT (SELECT app.is_intake_client()));

GRANT SELECT, INSERT ON service_calls TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE service_calls_id_seq TO authenticated;

-- ⚠️ anon אינו מקבל דבר, כמו בכל הפרויקט. הדלת החיצונית אינה נפתחת
-- למפתח הפרסום — היא נפתחת לזהות אחת ויחידה.
REVOKE ALL ON service_calls FROM anon;
