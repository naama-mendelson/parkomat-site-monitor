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

-- ============================================================
-- ⚠️ שעון ויזנט → זמן אמיתי
-- ============================================================
-- ויזנט שולחים **שעון ישראל** עם סיומת Z (נמדד 14/10/2026: updated_at הוא שנייה־שתיים לפני שעת
-- ההגעה שלנו ומסומן שלוש שעות קדימה; 87 מתוך 87 הודעות של הפיד). המחרוזת שלהם אינה UTC, ולכן
-- אי אפשר להמיר אותה ב-::timestamptz — זה היה מוסיף שלוש שעות על שלוש.
-- ⚠️ ולא מחסירים 3 שעות קבועות: ישראל היא UTC+3 בקיץ ו-UTC+2 בחורף, ומעבר השעון קרוב. כאן
-- הטקסט נקרא כשעון קיר מקומי ומומר דרך אזור הזמן — נכון בשני צדי המעבר.
-- ⚠️ מוגדרת **כאן** ולא ב-service-calls-board: הטריגר שלמטה והמילוי החד־פעמי קוראים לה, וקובץ
-- הלוח נטען אחרי הקובץ הזה. הגדרה שם היתה מפילה עלייה של מסד חדש (שחזור, מסד בדיקות).
CREATE OR REPLACE FUNCTION app.wizenet_ts(p text)
RETURNS timestamptz
-- ⚠️ STABLE ולא IMMUTABLE: ההמרה תלויה בבסיס הנתונים של אזורי הזמן, שיכול להתעדכן.
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}'
    -- ⚠️ המרה ישירה מטקסט ל-timestamp **בלי אזור**, ולא to_timestamp: הוא מחזיר timestamptz
    -- ומפרש את הטקסט באזור של הסשן, ואז AT TIME ZONE הולך לכיוון ההפוך ומוסיף שלוש שעות
    -- במקום להחסיר (נתפס בבדיקה S9).
    THEN (replace(substring(btrim(p), 1, 19), 'T', ' '))::timestamp AT TIME ZONE 'Asia/Jerusalem'
  END
$$;
REVOKE ALL ON FUNCTION app.wizenet_ts(text) FROM PUBLIC;

-- ============================================================
-- שתי עמודות קריאות־לעין: מתי הפנייה נפתחה, ומתי היא הגיעה אלינו
-- ============================================================
-- בעלת המוצר (14/10/2026), מול הטבלה במסך של Supabase: "תעשה לי בטבלה עמודה ששם כתוב באיזה
-- שעה הגיעה הפניה". `received_at` הוא טקסט UTC ("2026-10-14T09:56:48.800Z") — נכון, ובלתי קריא:
-- גם אינו שעון ישראל וגם אינו מופרד ליום ולשעה.
--
-- opened_il   — השעה שבה הפנייה **נפתחה אצל ויזנט**, בשעון ישראל. זה מה שהדייר חווה.
-- received_il — השעה שבה ההודעה הגיעה **אלינו**, בשעון ישראל.
--
-- ⚠️ **שתיים ולא אחת, וזו הנקודה:** הטבלה מחזיקה שורה לכל **אירוע** — גם שינוי סטטוס של קריאה
-- מלפני שבוע הוא שורה חדשה, ואז "מתי הגיעה" פירושו שני דברים שונים לגמרי. ההפרש ביניהן הוא
-- ההשהיה, וזו בדיוק השאלה שנשאלה באותו יום — "למה זה מגיע רק עכשיו?". נמדד בייצור: כשלוש שניות
-- בחציון מפתיחת הקריאה ועד שהיא כאן, והגרועה 11.5 שניות.
-- ⚠️ וזה **חסם עליון**: חותמות הזמן של ויזנט הן בשניות שלמות (0 מתוך 104 הודעות עם שבריר), ושלנו
-- במילישניות — כלומר האמת היא בין הנמדד פחות שנייה לנמדד. הרגל שלנו (חתימה שלהם → שורה כאן) היא
-- 1.4 שנ׳ בחציון ו-2.5 הגרועה; כל הפיזור יושב בתוך ויזנט.
--
-- ⚠️ למה טריגר ולא GENERATED: עמודה מחושבת חייבת ביטוי IMMUTABLE, והמרת אזור זמן היא STABLE.
-- ⚠️ ו-SECURITY DEFINER אינו נוי: המכניס היחיד לטבלה הזו הוא זהות הקליטה, ו-`app.wizenet_ts`
-- נשללה מ-PUBLIC — טריגר רגיל היה רץ בהרשאות של המכניס ונופל על "permission denied", כלומר
-- **כל קריאה חדשה היתה נדחית**. אותה סיבה ש-`app.service_calls_event` הוא DEFINER. נבדק ב-S10.
ALTER TABLE service_calls ADD COLUMN IF NOT EXISTS opened_il   text;
ALTER TABLE service_calls ADD COLUMN IF NOT EXISTS received_il text;

CREATE OR REPLACE FUNCTION app.service_calls_local() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
BEGIN
  -- ⚠️ opened_at של ויזנט הוא כבר שעון ישראל, ו-wizenet_ts קוראת אותו כשעון קיר; ה-AT TIME ZONE
  -- כאן רק מחזיר אותו לאותו שעון. הודעה בלי opened_at משאירה NULL — ולא את השעה שלנו, שהיתה
  -- נראית כמו שעת פתיחה אמיתית.
  NEW.opened_il := to_char(app.wizenet_ts(NEW.payload ->> 'opened_at') AT TIME ZONE 'Asia/Jerusalem',
                           'DD/MM/YYYY HH24:MI:SS');
  -- received_at הוא UTC אמיתי — כאן כן ממירים.
  NEW.received_il := to_char(NEW.received_at::timestamptz AT TIME ZONE 'Asia/Jerusalem',
                             'DD/MM/YYYY HH24:MI:SS');
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION app.service_calls_local() FROM PUBLIC;

DROP TRIGGER IF EXISTS service_calls_local ON service_calls;
CREATE TRIGGER service_calls_local BEFORE INSERT ON service_calls
  FOR EACH ROW EXECUTE FUNCTION app.service_calls_local();

-- מילוי השורות שכבר קיימות. אידמפוטנטי: רק מה שחסר.
-- ⚠️ התנאי הוא received_il ולא opened_il: השנייה היא NULL לגיטימית בהודעה בלי opened_at, ותנאי
-- עליה היה מרענן את אותן שורות בכל החלה.
UPDATE service_calls SET
  opened_il   = to_char(app.wizenet_ts(payload ->> 'opened_at') AT TIME ZONE 'Asia/Jerusalem', 'DD/MM/YYYY HH24:MI:SS'),
  received_il = to_char(received_at::timestamptz AT TIME ZONE 'Asia/Jerusalem', 'DD/MM/YYYY HH24:MI:SS')
 WHERE received_il IS NULL;
