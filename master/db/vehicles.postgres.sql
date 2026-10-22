-- ============================================================
-- רכבי הטכנאים מאיתוראן — מפה חיה (20/10/2026)
-- ============================================================
-- בעלת המוצר: "יש לפרקומט רכבים של אנשי תחזוקה, על כל רכב יש איתוראן" → "כל מידע אפשרי הכלל" → שלב ראשון: מפה חיה,
-- ו"כל מי שמחובר" רואה אותה. איתוראן הקימו משתמש API (השם והסיסמה — בסודות של ה-Edge Function בלבד, לא במאגר:
-- הוא ציבורי); התיעוד: docs.ituran.com (OpenAPI ב-Stoplight).
--
-- הזרימה: pg_cron כל דקה → app.ituran_sync_request() → net.http_post ל-Edge Function ‏ituran-sync → היא מחזיקה את
-- הטוקן של איתוראן (בזיכרון, לא במסד), מושכת את כל הרכבים (GET /api/v2/vehicles עם LastLocation, Places, Events) ומעבירה
-- את התשובה **כמות שהיא** ל-public.ituran_ingest. כל הפענוח כאן (rule 3): אילו שדות, איזה שעון, מה נמחק, ומה המצב שמוצג.
-- (Driver הוסר 20/10/2026: אף רכב לא החזיר נהג — אין ביחידות זיהוי נהג.)
--
-- ⚠️ **שורה אחת לכל רכב, שמתעדכנת במקום — בלי היסטוריה.** ההיסטוריה כבר שמורה אצל איתוראן (דוח מלא, טיולים), ותבוקש
-- מהם כשיפתחו דוח; לשכפל אותה כאן היה מוסיף כ-55 אלף שורות ביום (38 רכבים × דקה) בלי קורא. אותו עיקרון כמו alive.
--
-- ⚠️ **השעון של איתוראן הוא שעון ישראל בלי אזור זמן** ("2026-10-20T12:58:46.64") — אותה מלכודת כמו ויזנט. נמדד:
-- ברכבים בנסיעה הפער מ-now() יצא 0–1 דקות רק כשהטקסט נקרא כשעון ישראל. app.ituran_ts ממיר דרך Asia/Jerusalem —
-- לא -3 שעות קבוע (ב-25/10 חוזרים ל-+2).
--
-- ⚠️ **אין שורת events**, בכוונה: באנדל ישן מתייחס לסוג לא מוכר כ"טען הכול" (זה מה שהעמיס את המסד ב-07/10), ו-1,440
-- סנכרונים ביום היו 1,440 טעינות מלאות בכל מסך. המפה שואלת את vehicles_live_list כל דקה, רק כשהיא פתוחה ונראית.

CREATE TABLE IF NOT EXISTS vehicles_live (
  license_plate text PRIMARY KEY,
  vehicle_id    integer,
  nickname      text,              -- שם הטכנאי + מספר הרכב, כמו שהוגדר באיתוראן
  make_name     text,
  model_name    text,
  motion        text,              -- parking / idle / driving / none
  lat           double precision,
  lon           double precision,
  address       text,              -- "רחוב, עיר" מאיתוראן
  speed         integer,           -- קמ"ש
  heading       integer,           -- 0–359
  odometer      numeric,
  located_at    timestamptz,       -- זמן המכשיר של הרשומה האחרונה שיש בה מיקום (לא "מתי איתוראן קיבלו" — ראו למטה)
  places        jsonb NOT NULL DEFAULT '[]'::jsonb,   -- המקומות (אזורים) שהרכב בתוכם — [{place_id, place_name}]
  driver        text,
  synced_at     timestamptz NOT NULL DEFAULT now()    -- מתי השורה נכתבה אצלנו
);
-- האירועים האחרונים של הרכב כמו שאיתוראן מחזירים ברשימה (עד ~5, האחרון מכל סוג) — מהם נגזרים "חונה מאז" ו"ניתוק מתח"
-- (20/10/2026). ⚠️ ADD COLUMN ולא בתוך ה-CREATE: בייצור הטבלה כבר קיימת, וה-CREATE מדולג כולו.
ALTER TABLE vehicles_live ADD COLUMN IF NOT EXISTS events jsonb NOT NULL DEFAULT '[]'::jsonb;

-- מצב הסנכרון — שורה אחת. המסך אומר ממנה "עודכן לפני X" או "הסנכרון נכשל: …".
CREATE TABLE IF NOT EXISTS vehicles_sync (
  id            integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_ok_at    timestamptz,
  vehicles      integer,
  last_error    text,
  last_error_at timestamptz,
  token_fetches bigint NOT NULL DEFAULT 0,   -- כמה פעמים הונפק טוקן חדש (מופע קר של הפונקציה) — כדי למדוד, לא לנחש
  last_token_at timestamptz
);
-- ⚠️ ADD COLUMN ולא בתוך ה-CREATE — בייצור הטבלה כבר קיימת. תקלה בסיכום היומי (vehicle-stats), שלא עוצרת את הסנכרון.
ALTER TABLE vehicles_sync ADD COLUMN IF NOT EXISTS stats_error text;
ALTER TABLE vehicles_sync ADD COLUMN IF NOT EXISTS stats_error_at timestamptz;
-- תקלה במעבר האוטומטי למשימה הבאה (21/10/2026) — גם היא לא עוצרת את הסנכרון, ומוצגת במסך הטכנאים
ALTER TABLE vehicles_sync ADD COLUMN IF NOT EXISTS advance_error text;
ALTER TABLE vehicles_sync ADD COLUMN IF NOT EXISTS advance_error_at timestamptz;

-- סגורות: RLS בלי מדיניות ובלי הרשאות (ברירת המחדל של Supabase מעניקה ALL לכל טבלה חדשה). קריאה רק דרך
-- vehicles_live_list, כתיבה רק דרך ituran_ingest / ituran_sync_failed.
ALTER TABLE vehicles_live ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicles_sync ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON vehicles_live, vehicles_sync FROM PUBLIC, anon, authenticated;

-- ============================================================
-- הרכבים שמוצגים בדשבורד — רק של טכנאי השירות (21/10/2026)
-- ============================================================
-- מהשירות, דרך הבעלת: אין צורך שיופיעו הרכבים של עובדי המשרד, ההתקנות וכו' — עם רשימת טכנאי השירות והטכנאים
-- שעובדים "לפעמים". הבעלת: "אל תציג אותם" (בלי "כל הרכבים"), ו"לפעמים" — כמו כולם, בלי סימון.
-- ⚠️ הרשימה היא נתונים, לא קוד: שמות ומספרי רכב לא נכנסים למאגר (ציבורי). עורך מתחזק אותה מהדשבורד ("רכבים ברשימה"
-- במסך הטכנאים). רכב שאינו ברשימה לא מופיע בשום מקום: הכרטיסים, המפה, "צריכים טכנאי עכשיו", "טכנאי באתר" בלוח.
-- הוא ממשיך להיות מסונכרן ונספר (vehicles_track), כדי שרכב שנוסף לרשימה יבוא עם הנתונים של היום.
-- ⚠️ רשימה ריקה = אף רכב לא מוצג. רכב חדש באיתוראן (טכנאי קיבל רכב חדש) לא מופיע עד שמוסיפים אותו.
-- בלי FK ל-vehicles_live: רכב שנעלם מתשובה של איתוראן נמחק משם, ושורה כאן לא צריכה להימחק איתו — כשיחזור, הוא מוצג.
CREATE TABLE IF NOT EXISTS fleet_shown (
  license_plate text PRIMARY KEY,
  added_at      timestamptz NOT NULL DEFAULT now(),
  added_by      text
);
ALTER TABLE fleet_shown ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON fleet_shown FROM PUBLIC, anon, authenticated;

-- המקום האחד לכלל. ⚠️ SQL פשוט ולא SECURITY DEFINER / SET — כדי שייפתח (inline) בתוך השאילתות שקוראות לו; כולן
-- SECURITY DEFINER בעצמן.
CREATE OR REPLACE FUNCTION app.fleet_shown(p_plate text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (SELECT 1 FROM public.fleet_shown f WHERE f.license_plate = p_plate)
$$;
REVOKE ALL ON FUNCTION app.fleet_shown(text) FROM PUBLIC;

-- טקסט של איתוראן → timestamptz. בלי אזור זמן = שעון ישראל; עם Z או היסט — כמו שהוא. טקסט שאינו תאריך → NULL ולא
-- חריגה: רכב אחד עם שדה משובש לא יפיל את הסנכרון של כולם.
CREATE OR REPLACE FUNCTION app.ituran_ts(p text)
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN p IS NULL OR btrim(p) = '' THEN NULL
    WHEN btrim(p) ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:?\d\d)$' THEN btrim(p)::timestamptz
    WHEN btrim(p) ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?$' THEN btrim(p)::timestamp AT TIME ZONE 'Asia/Jerusalem'
  END
$$;

-- ⚠️ השעה שחוזרת פעמיים (25/10/2026, ובכל סוף קיץ): 01:00–02:00 קורה פעמיים, ו-AT TIME ZONE בוחר את קריאת החורף. רשומה
-- מהמעבר הראשון (קיץ) נשמרה אז שעה בעתיד — והמצב הראה יחידה שותקת "בנסיעה" כשעה (הסקירה, 20/10). כאן: כשהקריאה יוצאת
-- יותר מ-5 דקות אחרי p_ref (רגע הקליטה / הסנכרון), והשעה הזו באמת כפולה (שעה קודם — אותה שעת קיר), לוקחים את קריאת הקיץ.
-- רק לטקסט בלי אזור זמן; עם Z או היסט — כמו שהוא.
CREATE OR REPLACE FUNCTION app.ituran_ts_at(p text, p_ref timestamptz)
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN t IS NULL OR p_ref IS NULL OR btrim(p) ~ '(Z|[+-]\d\d:?\d\d)$' THEN t
    WHEN t > p_ref + interval '5 minutes' AND t - interval '1 hour' <= p_ref + interval '5 minutes'
         AND (t - interval '1 hour') AT TIME ZONE 'Asia/Jerusalem' = t AT TIME ZONE 'Asia/Jerusalem'
      THEN t - interval '1 hour'
    ELSE t
  END
    FROM (SELECT app.ituran_ts(p) AS t) x
$$;

-- מספר מתוך JSON, או NULL — בלי ::numeric שזורק על ערך משובש
CREATE OR REPLACE FUNCTION app.ituran_num(p text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$ SELECT CASE WHEN btrim(p) ~ '^-?\d+(\.\d+)?$' THEN btrim(p)::numeric END $$;

-- ============================================================
-- המצב שמוצג — נקבע כאן, לא במסך (20/10/2026)
-- ============================================================
-- ⚠️ ה-motion_status של איתוראן הוא "מצב ההצתה + המהירות של הרשומה האחרונה", בלי תוקף: יחידה שהפסיקה לשדר באמצע נסיעה
-- (כנראה חניון תת-קרקעי) נשארת "driving" שעות. נמדד 20/10/2026 (23 סוכנים על צילום של כל הצי ועשר דגימות של דקה): 4 מתוך
-- 7 ה"זזים" היו תקועים 40 דקות עד 7 שעות — בעלת המוצר, על אחד מהם: "לא בנסיעה". כשההצתה דולקת, היחידה שולחת מיקום לפחות
-- כל 160 שניות בנסיעה ו-300 בעמידה (p99 כ-70 ו-62; 2,668 רשומות של 25 רכבים). חונה — כל 10 דקות עד כ-12 שעות, או בכלל לא.
-- הספים: נסיעה 5 דקות (פי 1.9 מהפער הארוך), מנוע דולק 10 (פי 2), "לא מדווח" 24 שעות (פי 2 מהפעימה הארוכה של חונה).
-- ⚠️ הגיל נמדד מול synced_at של השורה ולא מול now(): תקלה בסנכרון היא עניין של שורת הסנכרון במסך, לא סיבה להפוך את כל
-- הצי ל"לא מתעדכן".
CREATE OR REPLACE FUNCTION app.vehicle_state(p_motion text, p_located_at timestamptz, p_synced_at timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_located_at IS NULL THEN 'no_report'
    WHEN EXTRACT(EPOCH FROM (p_synced_at - p_located_at)) > 86400 THEN 'no_report'
    WHEN p_motion = 'driving' AND EXTRACT(EPOCH FROM (p_synced_at - p_located_at)) <= 300 THEN 'driving'
    WHEN p_motion = 'idle'    AND EXTRACT(EPOCH FROM (p_synced_at - p_located_at)) <= 600 THEN 'idle'
    WHEN p_motion IN ('driving', 'idle') THEN 'silent'
    WHEN p_motion = 'parking' THEN 'parking'
    ELSE 'unknown'
  END
$$;

-- שם אירוע מנורמל להשוואה: כל רווח — גם רווח קשיח (U+00A0), טאב ושורה חדשה — לרווח אחד, ורק אז חיתוך הקצוות.
-- ⚠️ בסדר הזה: btrim מוריד רק רווחים רגילים, וקודם חיתוך ואז צמצום השאיר טאב בסוף כרווח (הסקירה, 20/10). והרווח הקשיח —
-- כי "חיבור מתח" מוגדר בחשבון כ"חיבור" + רווח + U+00A0 + "מתח", ו-\s של Postgres לא תופס את U+00A0.
CREATE OR REPLACE FUNCTION app.ituran_event_name(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NULLIF(btrim(regexp_replace(translate(COALESCE(p_name, ''), chr(160) || chr(8199) || chr(8239), '   '), '\s+', ' ', 'g')), '')
$$;

-- סוג אירוע של איתוראן — לפי המזהה בחשבון של פרקומט, ואם האירועים הוגדרו מחדש — לפי השם (שאיתוראן מאפשרים לערוך,
-- ולכן המזהה קודם; המזהים אינם סוד).
--   ign_on / ign_off = הדלקה / כיבוי של הסוויץ' או המנוע;  moving / stop = הרכב בתנועה / נעצר (לפי GPS ותאוצה);
--   power_cut = ניתוק מתח או מתח מצבר נמוך;  power_ok = חיבור מתח.
-- ⚠️ ההצתה והתנועה נפרדות בכוונה: רכב שנגרר (גניבה) על סוללת גיבוי מייצר "בתנועה" / "בעצירה" — ואסור שזה יבטל התראת
-- ניתוק מתח. רק הצתה מוכיחה שהמתח חזר (הסקירה, 20/10).
CREATE OR REPLACE FUNCTION app.ituran_event_kind(p_id text, p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_id IN ('10181704', '12746436') OR n IN ('סגירת סוויץ', 'מנוע כבוי') THEN 'ign_off'
    WHEN p_id IN ('12746440', '5295693') OR n IN ('פתיחת סוויץ', 'מנוע עובד') THEN 'ign_on'
    WHEN p_id = '12746438' OR n = 'רכב בעצירה' THEN 'stop'
    WHEN p_id = '12746437' OR n = 'רכב בתנועה' THEN 'moving'
    WHEN p_id IN ('12746446', '12746445') OR n IN ('ניתוק מתח', 'מתח מצבר נמוך') THEN 'power_cut'
    WHEN p_id = '12746447' OR n = 'חיבור מתח' THEN 'power_ok'
  END
    FROM (SELECT app.ituran_event_name(p_name) AS n) x
$$;

-- מרחק במטרים בין שתי נקודות (haversine; בלי PostGIS — דלת היציאה). NULL באחת הנקודות → NULL.
CREATE OR REPLACE FUNCTION app.geo_distance_m(lat1 double precision, lon1 double precision,
                                              lat2 double precision, lon2 double precision)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT 2 * 6371000 * asin(LEAST(1, sqrt(power(sin(radians(lat2 - lat1) / 2), 2)
                                          + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2))))
$$;

-- "חונה מאז": כיבוי ההצתה/המנוע האחרון (ואם אין — העצירה האחרונה), בתנאי שהוא אחרי כל אירוע הדלקה ותנועה ובמרחק עד 200 מ'
-- מהמיקום הנוכחי. אחרת NULL, והמסך אומר "עודכן לפני X". נמדד: נותן זמן ל-27 מתוך 28 החונים; זה שלא — האירועים שלו
-- מלפני חודשיים ובמקום אחר, וזה נכון שלא יקבל.
-- ⚠️ למה לא מספיק located_at: יחידה חונה שולחת "אני כאן" כל 10 דקות עד 12 שעות, והוא מתקדם איתם — רכב שחנה אתמול ב-17:45
-- הוצג "עודכן לפני 4 דק'".
-- ⚠️ רשימת האירועים של איתוראן שומרת את האחרון מכל **זוג** (הדלקה/כיבוי, מנוע עובד/כבוי, תנועה/עצירה) — לא מכל סוג. אצל
-- רכב חונה נשארים רק הכיבויים (נמדד: 0 מ-30 חונים עם אירוע הדלקה). התנאי "אחרי כל הדלקה" חל כשהרכב הודלק שוב.
CREATE OR REPLACE FUNCTION app.vehicle_parked_since(p_events jsonb, p_lat double precision, p_lon double precision)
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
  WITH e AS (
    SELECT app.ituran_event_kind(x->>'event_id', x->>'event_name') AS kind,
           app.ituran_ts_at(x->>'time_start', now()) AS at,
           app.ituran_num(x #>> '{point,lat}')::double precision AS lat,
           app.ituran_num(x #>> '{point,lon}')::double precision AS lon
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_events) = 'array' THEN p_events ELSE '[]'::jsonb END) x
  ), near AS (
    SELECT kind, at FROM e
     WHERE kind IN ('ign_off', 'stop') AND at IS NOT NULL
       AND app.geo_distance_m(lat, lon, p_lat, p_lon) <= 200
       AND at >= COALESCE((SELECT max(at) FROM e WHERE kind IN ('ign_on', 'moving')), '-infinity'::timestamptz)
  )
  SELECT COALESCE((SELECT max(at) FROM near WHERE kind = 'ign_off'), (SELECT max(at) FROM near WHERE kind = 'stop'))
$$;

-- מתי הונע הרכב, אם הוא מונע עכשיו: ההדלקה האחרונה (פתיחת סוויץ' / מנוע עובד) שאין אחריה כיבוי. אחרת NULL.
-- הרשימה של איתוראן שומרת את האחרון מכל זוג (הדלקה/כיבוי), ולכן הדלקה חדשה מכל כיבוי = הרכב מונע מאז.
-- לתזכורת בהתנעה (technicians.postgres.sql, 22/10/2026).
CREATE OR REPLACE FUNCTION app.vehicle_ignition_on_at(p_events jsonb, p_ref timestamptz DEFAULT now())
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
  WITH e AS (
    SELECT app.ituran_event_kind(x->>'event_id', x->>'event_name') AS kind, app.ituran_ts_at(x->>'time_start', p_ref) AS at
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_events) = 'array' THEN p_events ELSE '[]'::jsonb END) x
  )
  SELECT on_at FROM (SELECT max(at) FILTER (WHERE kind = 'ign_on') AS on_at, max(at) FILTER (WHERE kind = 'ign_off') AS off_at FROM e) m
   WHERE on_at IS NOT NULL AND on_at > COALESCE(off_at, '-infinity'::timestamptz)
$$;

-- ניתוק מתח / מתח מצבר נמוך שלא בא אחריו חיבור מתח או הדלקה — שורה אחת (מתי התחיל, ושם האירוע כמו באיתוראן), או אף
-- שורה. נמדד 20/10/2026: אופנוע אחד דיווח ניתוק מתח ומתח מצבר נמוך ארבע וחמש דקות אחרי שכובה, ומאז היחידה מדווחת
-- לעיתים רחוקות — והמפה לא אמרה כלום. כשיש כמה, הראשון: מאז מתי הבעיה, ובשם שטכנאי מכיר.
-- ⚠️ כל אירוע הצתה אחרי הניתוק — הדלקה **או כיבוי** — מבטל אותו: רכב שהונע, המתח שלו חזר. כיבוי נחשב כי הרשימה שומרת רק
-- את האחרון מכל זוג: אצל רכב שהונע ואז חנה נשארים רק הכיבויים, ובלעדיהם ההתראה הייתה חוזרת אחרי כל חניה (הסקירה, 20/10).
-- "חיבור מתח" לא הופיע אצל אף רכב בכל הצילומים. ⚠️ תנועה ועצירה **לא** מבטלות: רכב שנגרר על סוללת גיבוי זז גם בלי מתח.
CREATE OR REPLACE FUNCTION app.vehicle_power_alert(p_events jsonb)
RETURNS TABLE (at timestamptz, name text)
LANGUAGE sql
STABLE
AS $$
  WITH e AS (
    SELECT app.ituran_event_kind(x->>'event_id', x->>'event_name') AS kind, app.ituran_ts_at(x->>'time_start', now()) AS at,
           app.ituran_event_name(x->>'event_name') AS name
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_events) = 'array' THEN p_events ELSE '[]'::jsonb END) x
  )
  SELECT e.at, COALESCE(e.name, 'תקלת מתח')
    FROM e
   WHERE e.kind = 'power_cut' AND e.at IS NOT NULL
     AND e.at > COALESCE((SELECT max(o.at) FROM e o WHERE o.kind IN ('power_ok', 'ign_on', 'ign_off')), '-infinity'::timestamptz)
   ORDER BY e.at
   LIMIT 1
$$;

-- ============================================================
-- הקליטה — לשירות בלבד (ה-Edge Function). p_vehicles = מערך הרכבים כמו שאיתוראן החזירו.
-- p_meta: { complete: true כשכל העמודים נמשכו, token_fresh: true כשהונפק טוקן חדש }.
-- ============================================================
CREATE OR REPLACE FUNCTION public.ituran_ingest(p_vehicles jsonb, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v        jsonb;
  v_plate  text;
  v_plates text[] := '{}';
  v_lat    double precision;
  v_lon    double precision;
  v_at     timestamptz;
  v_addr   text;
  v_speed  numeric;
  v_head   numeric;
  v_places jsonb;
  v_events jsonb;
  v_fresh  boolean := COALESCE((p_meta->>'token_fresh')::boolean, false);
BEGIN
  IF p_vehicles IS NULL OR jsonb_typeof(p_vehicles) <> 'array' THEN
    RAISE EXCEPTION 'ituran_ingest: p_vehicles חייב להיות מערך' USING ERRCODE = '22023';
  END IF;

  FOR v IN SELECT value FROM jsonb_array_elements(p_vehicles) LOOP
    v_plate := NULLIF(btrim(v->>'license_plate'), '');
    CONTINUE WHEN v_plate IS NULL;
    v_plates := v_plates || v_plate;
    v_lat := app.ituran_num(v #>> '{last_location,location,point,lat}');
    v_lon := app.ituran_num(v #>> '{last_location,location,point,lon}');
    -- 0,0 הוא "אין מיקום" (באוקיינוס האטלנטי), לא מיקום; וכך גם קואורדינטה אחת בלבד, או מחוץ לתחום
    IF v_lat IS NULL OR v_lon IS NULL OR (v_lat = 0 AND v_lon = 0) OR abs(v_lat) > 90 OR abs(v_lon) > 180 THEN
      v_lat := NULL; v_lon := NULL;
    END IF;
    -- ⚠️ רשומה בלי מיקום אינה "המיקום האחרון", ולכן גם הזמן שלה לא נרשם — אחרת היא הייתה דורסת מיקום ידוע ב-NULL
    -- ומעלימה את הרכב מהמפה. נמדד 20/10/2026: יחידה אחת עם תקלת GPS משדרת רשומות 0,0 עם מהירות וכיוון -999
    -- ו"!! Address not found !!".
    -- (ituran_ts_at: בשעה שחוזרת פעמיים ב-25/10 — קריאת הקיץ כשקריאת החורף בעתיד)
    v_at := CASE WHEN v_lat IS NOT NULL THEN app.ituran_ts_at(v #>> '{last_location,timestamp}', now()) END;
    v_addr := NULLIF(btrim(COALESCE(v #>> '{last_location,location,address,location}',
                                    concat_ws(', ', v #>> '{last_location,location,address,street}',
                                                    v #>> '{last_location,location,address,city}'))), '');
    IF v_addr LIKE '!!%' THEN v_addr := NULL; END IF;
    -- -999 = "לא ידוע"; והתחום חוסם גם מספר ענק, שה-::integer היה זורק עליו ומפיל את הסנכרון של כל הצי
    v_speed := app.ituran_num(v #>> '{last_location,speed}');
    v_head  := app.ituran_num(v #>> '{last_location,heading}');
    IF NOT (v_speed >= 0 AND v_speed < 1000) THEN v_speed := NULL; END IF;
    IF NOT (v_head >= 0 AND v_head <= 360) THEN v_head := NULL; END IF;
    -- NULL = השדה לא הגיע בתשובה הזו → נשאר מה שהיה (תשובה בלי Events לא תמחק את "חונה מאז")
    v_places := CASE WHEN jsonb_typeof(v->'places') = 'array' THEN v->'places' END;
    v_events := CASE WHEN jsonb_typeof(v->'events') = 'array' THEN v->'events' END;

    INSERT INTO vehicles_live AS t (license_plate, vehicle_id, nickname, make_name, model_name, motion,
                                    lat, lon, address, speed, heading, odometer, located_at, places, events, driver,
                                    synced_at)
    VALUES (
      v_plate,
      app.ituran_num(v->>'vehicle_id')::integer,
      NULLIF(btrim(v->>'nickname'), ''),
      NULLIF(btrim(v->>'make_name'), ''),
      NULLIF(btrim(v->>'model_name'), ''),
      NULLIF(btrim(v->>'motion_status'), ''),
      v_lat, v_lon,
      v_addr,
      round(v_speed)::integer,
      round(v_head)::integer,
      app.ituran_num(v #>> '{last_location,odometer}'),
      v_at,
      COALESCE(v_places, '[]'::jsonb),
      COALESCE(v_events, '[]'::jsonb),
      NULLIF(btrim(concat_ws(' ', v #>> '{current_driver,first_name}', v #>> '{current_driver,last_name}')), ''),
      now())
    ON CONFLICT (license_plate) DO UPDATE SET
      vehicle_id = EXCLUDED.vehicle_id,
      nickname   = EXCLUDED.nickname,
      make_name  = EXCLUDED.make_name,
      model_name = EXCLUDED.model_name,
      motion     = EXCLUDED.motion,
      events     = COALESCE(v_events, t.events),
      driver     = EXCLUDED.driver,
      synced_at  = EXCLUDED.synced_at,
      -- ⚠️ המיקום מתעדכן רק כשהגיע מיקום, ורק קדימה בזמן: תשובה בלי LastLocation לא תמחק מיקום ידוע, ותשובה ישנה
      -- שהגיעה באיחור לא תחזיר את הרכב לאחור. המקומות (האזורים) מחושבים אצלם מהמיקום, ולכן הולכים איתו.
      places     = CASE WHEN v_places IS NOT NULL AND EXCLUDED.located_at >= COALESCE(t.located_at, '-infinity')
                        THEN v_places ELSE t.places END,
      lat        = CASE WHEN EXCLUDED.located_at >= COALESCE(t.located_at, '-infinity') THEN EXCLUDED.lat ELSE t.lat END,
      lon        = CASE WHEN EXCLUDED.located_at >= COALESCE(t.located_at, '-infinity') THEN EXCLUDED.lon ELSE t.lon END,
      address    = CASE WHEN EXCLUDED.located_at >= COALESCE(t.located_at, '-infinity') THEN EXCLUDED.address ELSE t.address END,
      speed      = CASE WHEN EXCLUDED.located_at >= COALESCE(t.located_at, '-infinity') THEN EXCLUDED.speed ELSE t.speed END,
      heading    = CASE WHEN EXCLUDED.located_at >= COALESCE(t.located_at, '-infinity') THEN EXCLUDED.heading ELSE t.heading END,
      odometer   = CASE WHEN EXCLUDED.located_at >= COALESCE(t.located_at, '-infinity') THEN EXCLUDED.odometer ELSE t.odometer END,
      located_at = GREATEST(t.located_at, EXCLUDED.located_at);
  END LOOP;

  -- רכב שהוצא מהחשבון באיתוראן נעלם מהמפה — ⚠️ רק כשכל העמודים נמשכו, ורק כשחזר לפחות רכב אחד: תשובה חלקית או ריקה
  -- (תקלה אצלם) לא תמחק את כל הצי
  IF COALESCE((p_meta->>'complete')::boolean, false) AND cardinality(v_plates) > 0 THEN
    DELETE FROM vehicles_live WHERE license_plate <> ALL (v_plates);
  END IF;

  INSERT INTO vehicles_sync AS s (id, last_ok_at, vehicles, token_fetches, last_token_at)
  VALUES (1, now(), cardinality(v_plates), CASE WHEN v_fresh THEN 1 ELSE 0 END, CASE WHEN v_fresh THEN now() END)
  ON CONFLICT (id) DO UPDATE SET
    last_ok_at    = now(),
    vehicles      = cardinality(v_plates),
    token_fetches = s.token_fetches + CASE WHEN v_fresh THEN 1 ELSE 0 END,
    last_token_at = CASE WHEN v_fresh THEN now() ELSE s.last_token_at END;

  -- הסיכום היומי והביקורים באתרים (vehicle-stats.postgres.sql). ⚠️ בבלוק משלו: תקלה בסטטיסטיקה לעולם לא מפילה את
  -- סנכרון הצי — היא נרשמת ב-stats_error, והמסך אומר שהסטטיסטיקה לא התעדכנה.
  BEGIN
    PERFORM app.vehicles_track(now());
    UPDATE vehicles_sync SET stats_error = NULL, stats_error_at = NULL WHERE id = 1 AND stats_error IS NOT NULL;
  EXCEPTION WHEN others THEN
    UPDATE vehicles_sync SET stats_error = left(SQLERRM, 300), stats_error_at = now() WHERE id = 1;
  END;

  -- "המשימה הבאה" (technicians.postgres.sql, 21/10/2026): טכנאי שיצא מהאתר של המשימה שלו, ויש לו משימה באה — היא
  -- מתחילה. ⚠️ בבלוק משלו, אחרי הביקורים (שמהם הוא קורא): תקלה כאן לא מפילה את הסנכרון ולא את הסטטיסטיקה.
  BEGIN
    PERFORM app.tech_leave_scan(now());
    UPDATE vehicles_sync SET advance_error = NULL, advance_error_at = NULL WHERE id = 1 AND advance_error IS NOT NULL;
  EXCEPTION WHEN others THEN
    UPDATE vehicles_sync SET advance_error = left(SQLERRM, 300), advance_error_at = now() WHERE id = 1;
  END;

  -- התזכורת בהתנעה (technicians.postgres.sql, 22/10/2026): טכנאי עם משימה פתוחה שהניע את הרכב — צפצוף "לאן לנסוע".
  -- ⚠️ בבלוק משלו, אחרי היציאה מהאתר: תקלה כאן לא מפילה את הסנכרון ולא את המשימה הבאה. הצלחה לא מנקה את advance_error
  -- (שייך לסריקה הקודמת, שמנקה אותו בעצמה).
  BEGIN
    PERFORM app.tech_ignition_scan(now());
  EXCEPTION WHEN others THEN
    UPDATE vehicles_sync SET advance_error = left('תזכורת בהתנעה: ' || SQLERRM, 300), advance_error_at = now() WHERE id = 1;
  END;

  RETURN cardinality(v_plates);
END
$fn$;
REVOKE ALL ON FUNCTION public.ituran_ingest(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ituran_ingest(jsonb, jsonb) TO service_role;

-- איתוראן לא ענו / סירבו — נרשם, כדי שהמסך יגיד את זה ולא יציג מיקומים ישנים כאילו הם עכשוויים
CREATE OR REPLACE FUNCTION public.ituran_sync_failed(p_error text)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
  INSERT INTO vehicles_sync AS s (id, last_error, last_error_at) VALUES (1, left(COALESCE(p_error, '?'), 500), now())
  ON CONFLICT (id) DO UPDATE SET last_error = EXCLUDED.last_error, last_error_at = EXCLUDED.last_error_at
$$;
REVOKE ALL ON FUNCTION public.ituran_sync_failed(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ituran_sync_failed(text) TO service_role;

-- ============================================================
-- מיקומי אתרים — "לאיזה אתרים הם קרובים" (20/10/2026)
-- ============================================================
-- בעלת המוצר, על רכבי הטכנאים: "רק מיקומים ולאיזה אתרים הם קרובים". העמודות על sites (schema.postgres.sql:
-- lat / lon / geo_source / geo_precision / geo_set_at / geo_set_by). הבחירה שלה: הצעה משוערת מהכתובת שבשם לכל האתרים
-- (OpenStreetMap, tools/geocode-sites.js → site_geo_import), שעורך מאשר או מתקן על המפה (site_geo_set).
-- ⚠️ בלי שורת events, כמו כל השאר כאן: סימון 219 אתרים היה 219 טעינות מלאות בכל מסך פתוח. המפה קוראת בעצמה.

-- האתרים הקרובים לנקודה: עד p_limit, בטווח p_max_m מטרים, הקרוב ראשון. approx = מיקום האתר משוער (רחוב / אזור).
-- התיבה (lat ± מטרים/111,195, lon מתוקן ב-cos) רק מצמצמת; המרחק עצמו — app.geo_distance_m. LIMIT לפני הסינון לפי
-- הטווח נכון: מי שבתוך הטווח קרוב יותר מכל מי שמחוצה לו.
CREATE OR REPLACE FUNCTION app.near_sites(p_lat double precision, p_lon double precision,
                                          p_max_m double precision DEFAULT 1500, p_limit integer DEFAULT 3)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('code', n.code, 'name', n.site_name, 'm', round(n.m)::integer,
                                               'approx', n.geo_precision IN ('street', 'area'))
                            ORDER BY n.m), '[]'::jsonb)
    FROM (SELECT s.code, s.site_name, s.geo_precision, app.geo_distance_m(p_lat, p_lon, s.lat, s.lon) AS m
            FROM sites s
           WHERE p_lat IS NOT NULL AND p_lon IS NOT NULL AND s.lat IS NOT NULL
             AND s.lat BETWEEN p_lat - p_max_m / 111195.0 AND p_lat + p_max_m / 111195.0
             AND s.lon BETWEEN p_lon - p_max_m / (111195.0 * cos(radians(p_lat)))
                           AND p_lon + p_max_m / (111195.0 * cos(radians(p_lat)))
           ORDER BY 4
           LIMIT p_limit) n
   WHERE n.m <= p_max_m
$$;
REVOKE ALL ON FUNCTION app.near_sites(double precision, double precision, double precision, integer) FROM PUBLIC;

-- ============================================================
-- "באתר" (21/10/2026) — בעלת המוצר: "האם הוא נמצא באתר (אם הרכב שלו חונה ליד אתר שלנו)"
-- ============================================================
-- הרדיוס לפי דיוק מיקום האתר: אתר שמיקומו בבניין או מאושר ביד — 150 מ' (רחוב רחב ורכב שחונה מעבר לפינה); אתר שמיקומו
-- משוער לפי רחוב או אזור — 300 מ', ומסומן approx, כי הנקודה עצמה עלולה לזוז כמה מאות מטרים לאורך הרחוב.
-- נמדד בבוקר 21/10: 7 רכבים חונים בטווח 115–324 מ' מאתר; 6 מהם ליד אתר משוער.
CREATE OR REPLACE FUNCTION app.site_radius_m(p_precision text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$ SELECT CASE WHEN p_precision IN ('street', 'area') THEN 300 ELSE 150 END $$;

-- חניות הטכנאים (22/10/2026): אתרים שהטכנאים חונים לידם ולא מבקרים בהם — חנייה שם אינה "באתר" ואינה ביקור.
-- הבעלת, על 3488 (ליד המשרד; שלושה רכבים חנו שם מאז תחילת המעקב, ורכב שירות נספר שם "האתר שביקר בו הכי הרבה"):
-- "להוציא את 3488". רשימת קודים מופרדת בפסיקים ב-settings.tech_parking_sites; הזרע — אם אין עדיין ערך.
-- ⚠️ גם ביקור אמיתי באתר כזה לא נספר. "ליד" (near_sites) לא משתנה.
INSERT INTO settings (key, value, updated_at)
VALUES ('tech_parking_sites', '3488', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
ON CONFLICT (key) DO NOTHING;
CREATE OR REPLACE FUNCTION app.tech_parking_codes()
RETURNS text[]
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE((SELECT array_agg(btrim(x)) FROM settings s, unnest(string_to_array(s.value, ',')) x
                    WHERE s.key = 'tech_parking_sites' AND btrim(x) <> ''), '{}'::text[])
$$;
REVOKE ALL ON FUNCTION app.tech_parking_codes() FROM PUBLIC;

-- האתר שהנקודה בתוכו (הקרוב, אם יש כמה), או NULL: {site_id, code, name, m, approx}. ⚠️ בלי חניות הטכנאים.
CREATE OR REPLACE FUNCTION app.site_at(p_lat double precision, p_lon double precision)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object('site_id', n.id, 'code', n.code, 'name', n.site_name, 'm', round(n.m)::integer,
                            'approx', n.geo_precision IN ('street', 'area'))
    FROM (SELECT s.id, s.code, s.site_name, s.geo_precision, app.geo_distance_m(p_lat, p_lon, s.lat, s.lon) AS m
            FROM sites s
           WHERE p_lat IS NOT NULL AND p_lon IS NOT NULL AND s.lat IS NOT NULL
             AND s.code <> ALL (app.tech_parking_codes())
             AND s.lat BETWEEN p_lat - 300 / 111195.0 AND p_lat + 300 / 111195.0
             AND s.lon BETWEEN p_lon - 300 / (111195.0 * cos(radians(p_lat)))
                           AND p_lon + 300 / (111195.0 * cos(radians(p_lat)))) n
   WHERE n.m <= app.site_radius_m(n.geo_precision)
   ORDER BY n.m
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.site_at(double precision, double precision) FROM PUBLIC;

-- מה הרכב עושה, במילה אחת לציר היום ולסטטיסטיקה: drive (נוסע, או מנוע דולק שלא באתר — רמזור), site (עומד ליד אתר: חונה,
-- מנוע דולק, או שהשתתק שם — חניון תת-קרקעי), park (חונה במקום אחר), silent (השתתק במקום אחר), none (לא מדווח / לא ידוע).
CREATE OR REPLACE FUNCTION app.vehicle_kind(p_state text, p_at_site boolean)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
           WHEN p_state = 'driving' THEN 'drive'
           WHEN p_state IN ('parking', 'idle', 'silent') AND COALESCE(p_at_site, false) THEN 'site'
           WHEN p_state = 'idle' THEN 'drive'
           WHEN p_state = 'parking' THEN 'park'
           WHEN p_state = 'silent' THEN 'silent'
           ELSE 'none'
         END
$$;

-- האם הרכב עומד, כלומר יכול להיות "באתר": חונה, מנוע דולק, או השתתק. ⚠️ 21/10/2026 (בדיקת הבאגים): השתתקות נחשבה תמיד
-- עמידה ("חניון תת-קרקעי"), ויחידה שהפסיקה לשדר באמצע נסיעה, ליד אתר, נחשבה "באתר" שעות — עם האיקון בלוח. עכשיו השתתקות
-- נחשבת עמידה רק אם הדיווח האחרון היה איטי (עד 20 קמ"ש) או שאיתוראן לא אמרו "נוסע".
CREATE OR REPLACE FUNCTION app.vehicle_may_be_at_site(p_state text, p_motion text, p_speed integer)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_state IN ('parking', 'idle')
      OR (p_state = 'silent' AND (COALESCE(p_motion, '') <> 'driving' OR COALESCE(p_speed, 0) <= 20))
$$;

-- כל האתרים עם המיקום שלהם (או בלעדיו) — לשכבת האתרים במפה ולרשימת "דורשים בדיקה". כל מי שמחובר; jsonb אחד.
CREATE OR REPLACE FUNCTION public.site_locations_list()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
BEGIN
  PERFORM app.require_staff();
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'code', s.code, 'name', s.site_name, 'monitored', s.monitored IS NOT FALSE,
             'lat', s.lat, 'lon', s.lon, 'source', s.geo_source, 'precision', s.geo_precision,
             'set_at', s.geo_set_at, 'set_by', s.geo_set_by)
           ORDER BY s.code)
      FROM sites s), '[]'::jsonb);
END
$fn$;
REVOKE ALL ON FUNCTION public.site_locations_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.site_locations_list() TO authenticated;

-- עורך מסמן / מאשר / מנקה מיקום של אתר. אישור = אותן קואורדינטות, והמקור הופך ל-manual. NULL ו-NULL = ניקוי.
-- p_expected_at = geo_set_at שהמסך ראה ('' כשלא היה מיקום): מסך ישן מקבל PT409 במקום לדרוס סימון של מישהו אחר.
-- NULL = בלי בדיקה. ⚠️ התחום נבדק כאן עם הודעה בעברית לפני שה-CHECK זורק בלעדיה (היפוך lat/lon הוא הטעות הסבירה).
CREATE OR REPLACE FUNCTION public.site_geo_set(p_code text, p_lat double precision, p_lon double precision,
                                               p_expected_at text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_actor text := app.require_editor();
  v_id    integer;
  v_code  text;
  v_cur   text;
  v_now   text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_lat   double precision := CASE WHEN p_lat IS NOT NULL THEN round(p_lat::numeric, 6)::double precision END;
  v_lon   double precision := CASE WHEN p_lon IS NOT NULL THEN round(p_lon::numeric, 6)::double precision END;
BEGIN
  SELECT id, code, geo_set_at INTO v_id, v_code, v_cur FROM sites WHERE code = btrim(COALESCE(p_code, '')) FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'האתר לא נמצא' USING ERRCODE = 'PT404';
  END IF;
  IF p_expected_at IS NOT NULL AND COALESCE(v_cur, '') <> p_expected_at THEN
    RAISE EXCEPTION 'המיקום של האתר השתנה בינתיים — יש לרענן ולנסות שוב' USING ERRCODE = 'PT409';
  END IF;
  IF (v_lat IS NULL) <> (v_lon IS NULL) THEN
    RAISE EXCEPTION 'חסרה קואורדינטה — צריך גם קו רוחב וגם קו אורך' USING ERRCODE = '22023';
  END IF;
  IF v_lat IS NOT NULL AND NOT (v_lat BETWEEN 29.3 AND 33.4 AND v_lon BETWEEN 34.2 AND 35.95) THEN
    RAISE EXCEPTION 'המיקום מחוץ לישראל — אולי קו הרוחב וקו האורך הוחלפו' USING ERRCODE = '22023';
  END IF;
  UPDATE sites
     SET lat = v_lat, lon = v_lon,
         geo_source    = CASE WHEN v_lat IS NULL THEN NULL ELSE 'manual' END,
         geo_precision = CASE WHEN v_lat IS NULL THEN NULL ELSE 'pin' END,
         geo_set_at = v_now, geo_set_by = v_actor
   WHERE id = v_id;
  PERFORM app.record_write_audit('site.geo', v_actor, app.current_app_role(), 'site', v_code,
    jsonb_build_object('cleared', v_lat IS NULL));
  RETURN jsonb_build_object('code', v_code, 'lat', v_lat, 'lon', v_lon,
                            'source', CASE WHEN v_lat IS NULL THEN NULL ELSE 'manual' END,
                            'precision', CASE WHEN v_lat IS NULL THEN NULL ELSE 'pin' END,
                            'set_at', v_now, 'set_by', v_actor);
END
$fn$;
REVOKE ALL ON FUNCTION public.site_geo_set(text, double precision, double precision, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.site_geo_set(text, double precision, double precision, text) TO authenticated;

-- ייבוא ההצעות מהכתובת — לשירות בלבד (tools/geocode-sites.js מריץ אותו כ-postgres). p_rows = [{code, lat, lon, precision}].
-- ⚠️ לעולם לא דורס manual: מה שעורך סימן או אישר נשאר, גם בהרצה חוזרת של הכלי. שורה משובשת (בלי קוד, מחוץ לישראל,
-- דיוק לא מוכר) נספרת ולא מפילה את השאר. מחזיר מונים, כדי שהכלי יגיד מה קרה.
CREATE OR REPLACE FUNCTION public.site_geo_import(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  r       jsonb;
  v_code  text;
  v_lat   double precision;
  v_lon   double precision;
  v_prec  text;
  v_src   text;
  v_now   text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  n_upd   integer := 0;
  n_kept  integer := 0;
  n_bad   integer := 0;
  n_unk   integer := 0;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'site_geo_import: p_rows חייב להיות מערך' USING ERRCODE = '22023';
  END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    v_code := NULLIF(btrim(COALESCE(r->>'code', '')), '');
    v_lat  := app.ituran_num(r->>'lat');
    v_lon  := app.ituran_num(r->>'lon');
    v_prec := COALESCE(r->>'precision', '');
    IF v_code IS NULL OR v_lat IS NULL OR v_lon IS NULL OR v_prec NOT IN ('house', 'street', 'area')
       OR NOT (v_lat BETWEEN 29.3 AND 33.4 AND v_lon BETWEEN 34.2 AND 35.95) THEN
      n_bad := n_bad + 1;
      CONTINUE;
    END IF;
    SELECT geo_source INTO v_src FROM sites WHERE code = v_code;
    IF NOT FOUND THEN
      n_unk := n_unk + 1;
      CONTINUE;
    END IF;
    IF v_src = 'manual' THEN
      n_kept := n_kept + 1;
      CONTINUE;
    END IF;
    UPDATE sites
       SET lat = round(v_lat::numeric, 6)::double precision, lon = round(v_lon::numeric, 6)::double precision,
           geo_source = 'geocoded', geo_precision = v_prec, geo_set_at = v_now,
           geo_set_by = 'הצעה מהכתובת (OpenStreetMap)'
     WHERE code = v_code AND geo_source IS DISTINCT FROM 'manual';
    n_upd := n_upd + 1;
  END LOOP;
  RETURN jsonb_build_object('updated', n_upd, 'kept_manual', n_kept, 'invalid', n_bad, 'unknown_code', n_unk);
END
$fn$;
REVOKE ALL ON FUNCTION public.site_geo_import(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.site_geo_import(jsonb) TO service_role;

-- ============================================================
-- רכב אחד כמו שהוא מוצג — המפה (vehicles_live_list) ולוח הטכנאים (technicians.postgres.sql, app.tech_json) קוראים מכאן,
-- כדי שכללי המצב ("בנסיעה", "לא מתעדכן", "חונה מאז", ניתוק מתח, האתרים הקרובים) לא יתפצלו בין שני מסכים.
-- ============================================================
CREATE OR REPLACE FUNCTION app.vehicle_json(v vehicles_live)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, app, pg_temp
AS $fn$
BEGIN
  -- ⚠️ plpgsql ולא sql: פונקציית sql עם FROM מתוכננת מחדש בכל קריאה, ו-38 קריאות בכל שאילתה של המסך עלו ~250 מ"ש (נמדד
  -- מקומית, 21/10/2026); plpgsql שומרת את התוכנית בין קריאות באותו חיבור.
  RETURN (  SELECT jsonb_build_object(
           'plate', v.license_plate, 'name', v.nickname, 'make', v.make_name, 'model', v.model_name,
           -- motion = מה שאיתוראן אמרו; state = מה שמוצג (app.vehicle_state). המסך מתרגם את state ולא מחליט.
           'motion', v.motion, 'state', s.state,
           -- חונה → מתי כובה (NULL כשלא ידוע); לא מתעדכן / לא מדווח → הדיווח האחרון; בנסיעה / מנוע דולק → NULL
           'state_since', to_char(CASE s.state
                                    WHEN 'parking' THEN app.vehicle_parked_since(v.events, v.lat, v.lon)
                                    WHEN 'silent' THEN v.located_at
                                    WHEN 'no_report' THEN v.located_at
                                  END AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'power_alert', CASE WHEN pa.at IS NOT NULL
                               THEN jsonb_build_object('at', to_char(pa.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                                                       'name', pa.name) END,
           -- עד 3 אתרים בטווח 1.5 ק"מ מהמיקום (האחרון שידוע), הקרוב ראשון: [{code, name, m, approx}]
           'near', app.near_sites(v.lat, v.lon),
           -- עומד ליד אתר שלנו (חונה, מנוע דולק, או השתתק שם): {site_id, code, name, m, approx}; בנסיעה — NULL.
           -- ⚠️ ורק אם נסע היום (22/10/2026) — "היום" של הסנכרון שלו, כמו המצב (synced_at ולא now())
           'at_site', CASE WHEN app.vehicle_may_be_at_site(s.state, v.motion, v.speed)
                           THEN app.vehicle_site(v.license_plate, v.lat, v.lon, COALESCE(v.synced_at, now())) END,
           -- שם הטכנאי מלוח הרכז, כשמשויך לרכב (21/10/2026): כדי שהחיפוש, "צריכים טכנאי" והמפה יציגו את אותו שם כמו הכרטיס
           -- והאיקון בלוח — ולא את הכינוי באיתוראן. NULL בלי שיוך.
           'tech', (SELECT x.display_name FROM technicians x WHERE x.plate = v.license_plate AND x.is_active ORDER BY x.id LIMIT 1),
           'lat', v.lat, 'lon', v.lon, 'address', v.address, 'speed', v.speed,
           'heading', v.heading, 'odometer', v.odometer,
           'located_at', to_char(v.located_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'places', v.places, 'driver', v.driver,
           'synced_at', to_char(v.synced_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
    FROM (SELECT app.vehicle_state(v.motion, v.located_at, v.synced_at) AS state) s
    LEFT JOIN LATERAL app.vehicle_power_alert(v.events) pa ON true
  );
END
$fn$;
REVOKE ALL ON FUNCTION app.vehicle_json(vehicles_live) FROM PUBLIC;

-- ============================================================
-- הקריאה של המפה — כל מי שמחובר (בעלת המוצר, 20/10/2026: "כל מי שמחובר"), כלומר require_staff: מנהל, עורך, בקר.
-- jsonb אחד — בלי תקרת 1,000 השורות של PostgREST.
-- ============================================================
CREATE OR REPLACE FUNCTION public.vehicles_live_list()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  iso CONSTANT text := 'YYYY-MM-DD"T"HH24:MI:SS"Z"';
BEGIN
  PERFORM app.require_staff();
  RETURN jsonb_build_object(
    -- stats = מה הרכב עשה היום ובשבוע (vehicle-stats.postgres.sql): הביקור הנוכחי באתר, ק"מ, זמן נסיעה, ציר היום
    -- ⚠️ רק רכבי השירות (fleet_shown, 21/10/2026)
    'vehicles', COALESCE((SELECT jsonb_agg(app.vehicle_json(v) || jsonb_build_object('stats', app.vehicle_stats_json(v.license_plate))
                                           ORDER BY v.license_plate)
                            FROM vehicles_live v WHERE app.fleet_shown(v.license_plate)), '[]'::jsonb),
    -- האתרים שצריכים טכנאי עכשיו (תקלה / קריאה פתוחה) — ומי הכי קרוב לכל אחד
    'alerts', app.vehicle_alerts_json(),
    'sync', (SELECT jsonb_build_object(
                      'last_ok_at', to_char(s.last_ok_at AT TIME ZONE 'UTC', iso),
                      'vehicles', s.vehicles,
                      'last_error', s.last_error,
                      'last_error_at', to_char(s.last_error_at AT TIME ZONE 'UTC', iso),
                      'stats_error', s.stats_error,
                      'advance_error', s.advance_error)
               FROM vehicles_sync s WHERE s.id = 1),
    'now', to_char(now() AT TIME ZONE 'UTC', iso));
END
$fn$;
REVOKE ALL ON FUNCTION public.vehicles_live_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vehicles_live_list() TO authenticated;

-- "רכבים ברשימה" (fleet_list / fleet_shown_set, עורך ומנהל, 21/10/2026) הוחלף ב-22/10/2026 ב"ניהול טכנאים" — מנהל בלבד,
-- טכנאי = שם + הרכב שלו (public.tech_roster* ב-technicians.postgres.sql). הבעלת: "תן אופציה להוסיף עוד טכנאי ולמחוק — רק
-- למי שהוא מנהל". הטבלה fleet_shown והכלל app.fleet_shown לא השתנו.
DROP FUNCTION IF EXISTS public.fleet_list();
DROP FUNCTION IF EXISTS public.fleet_shown_set(text[], text[]);

-- ============================================================
-- הקריאה ל-Edge Function, מ-pg_cron (cron.postgres.sql). אותו דפוס כמו app.push_request: המפתח הפומבי עובר את השער,
-- והסוד המשותף (settings.ituran_caller_secret — טבלה בלי מדיניות, לא נגישה מהדפדפן) הוא מה שהפונקציה בודקת.
-- ⚠️ בלי סוד = הסנכרון לא הופעל עדיין: NULL בשקט, והמסך אומר "עוד לא הופעל" (אין שורה ב-vehicles_sync). בלי המפתח
-- הפומבי כשהסוד כן קיים — זו תקלה, והיא נרשמת.
-- ============================================================
CREATE OR REPLACE FUNCTION app.ituran_sync_request()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_secret text := (SELECT value FROM settings WHERE key = 'ituran_caller_secret');
  v_key    text := (SELECT value FROM settings WHERE key = 'push_anon_key');
BEGIN
  IF COALESCE(btrim(v_secret), '') = '' THEN RETURN NULL; END IF;
  IF COALESCE(btrim(v_key), '') = '' THEN
    PERFORM public.ituran_sync_failed('push_anon_key אינו מוגדר ב-settings — הסנכרון עם איתוראן לא נשלח');
    RETURN NULL;
  END IF;
  RETURN net.http_post(
    url     := 'https://xvfsikwaaaohnmldjbtv.supabase.co/functions/v1/ituran-sync',
    body    := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || btrim(v_key),
      'x-parkomat-ituran-secret', btrim(v_secret)),
    timeout_milliseconds := 30000);
END
$fn$;
REVOKE ALL ON FUNCTION app.ituran_sync_request() FROM PUBLIC;
