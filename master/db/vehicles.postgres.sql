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

-- סגורות: RLS בלי מדיניות ובלי הרשאות (ברירת המחדל של Supabase מעניקה ALL לכל טבלה חדשה). קריאה רק דרך
-- vehicles_live_list, כתיבה רק דרך ituran_ingest / ituran_sync_failed.
ALTER TABLE vehicles_live ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicles_sync ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON vehicles_live, vehicles_sync FROM PUBLIC, anon, authenticated;

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

-- סוג אירוע של איתוראן — לפי המזהה בחשבון של פרקומט, ואם האירועים הוגדרו מחדש — לפי השם (שאיתוראן מאפשרים לערוך,
-- ולכן המזהה קודם; המזהים אינם סוד). off = כיבוי ההצתה או המנוע; stop = הרכב נעצר; on = הדלקה או תנועה.
-- ⚠️ "חיבור  מתח" מוגדר בחשבון עם שני רווחים — הרווחים מצומצמים לפני ההשוואה.
CREATE OR REPLACE FUNCTION app.ituran_event_kind(p_id text, p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_id IN ('10181704', '12746436') OR n IN ('סגירת סוויץ', 'מנוע כבוי') THEN 'off'
    WHEN p_id = '12746438' OR n = 'רכב בעצירה' THEN 'stop'
    WHEN p_id IN ('12746440', '5295693', '12746437') OR n IN ('פתיחת סוויץ', 'מנוע עובד', 'רכב בתנועה') THEN 'on'
    WHEN p_id IN ('12746446', '12746445') OR n IN ('ניתוק מתח', 'מתח מצבר נמוך') THEN 'power_cut'
    WHEN p_id = '12746447' OR n = 'חיבור מתח' THEN 'power_ok'
  END
    FROM (SELECT regexp_replace(btrim(COALESCE(p_name, '')), '\s+', ' ', 'g') AS n) x
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
CREATE OR REPLACE FUNCTION app.vehicle_parked_since(p_events jsonb, p_lat double precision, p_lon double precision)
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
  WITH e AS (
    SELECT app.ituran_event_kind(x->>'event_id', x->>'event_name') AS kind,
           app.ituran_ts(x->>'time_start') AS at,
           app.ituran_num(x #>> '{point,lat}')::double precision AS lat,
           app.ituran_num(x #>> '{point,lon}')::double precision AS lon
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_events) = 'array' THEN p_events ELSE '[]'::jsonb END) x
  ), near AS (
    SELECT kind, at FROM e
     WHERE kind IN ('off', 'stop') AND at IS NOT NULL
       AND app.geo_distance_m(lat, lon, p_lat, p_lon) <= 200
       AND at >= COALESCE((SELECT max(at) FROM e WHERE kind = 'on'), '-infinity'::timestamptz)
  )
  SELECT COALESCE((SELECT max(at) FROM near WHERE kind = 'off'), (SELECT max(at) FROM near WHERE kind = 'stop'))
$$;

-- ניתוק מתח / מתח מצבר נמוך שלא בא אחריו חיבור מתח או הדלקה — שורה אחת (מתי התחיל, ושם האירוע כמו באיתוראן), או אף
-- שורה. נמדד 20/10/2026: אופנוע אחד דיווח ניתוק מתח ומתח מצבר נמוך ארבע וחמש דקות אחרי שכובה, ומאז היחידה מדווחת
-- לעיתים רחוקות — והמפה לא אמרה כלום. כשיש כמה, הראשון: מאז מתי הבעיה, ובשם שטכנאי מכיר.
-- ⚠️ הדלקה אחרי הניתוק מבטלת אותו: רכב שהונע — המתח שלו חזר. בלי זה ההתראה הייתה נשארת לתמיד, כי "חיבור מתח" לא הופיע
-- אצל אף רכב בכל הצילומים (אולי האירוע אינו נשלח בכלל).
CREATE OR REPLACE FUNCTION app.vehicle_power_alert(p_events jsonb)
RETURNS TABLE (at timestamptz, name text)
LANGUAGE sql
STABLE
AS $$
  WITH e AS (
    SELECT app.ituran_event_kind(x->>'event_id', x->>'event_name') AS kind, app.ituran_ts(x->>'time_start') AS at,
           NULLIF(regexp_replace(btrim(COALESCE(x->>'event_name', '')), '\s+', ' ', 'g'), '') AS name
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_events) = 'array' THEN p_events ELSE '[]'::jsonb END) x
  )
  SELECT e.at, COALESCE(e.name, 'תקלת מתח')
    FROM e
   WHERE e.kind = 'power_cut' AND e.at IS NOT NULL
     AND e.at > COALESCE((SELECT max(o.at) FROM e o WHERE o.kind IN ('power_ok', 'on')), '-infinity'::timestamptz)
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
    v_at := CASE WHEN v_lat IS NOT NULL THEN app.ituran_ts(v #>> '{last_location,timestamp}') END;
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
    'vehicles', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'plate', v.license_plate, 'name', v.nickname, 'make', v.make_name, 'model', v.model_name,
               -- motion = מה שאיתוראן אמרו; state = מה שמוצג (app.vehicle_state). המסך מתרגם את state ולא מחליט.
               'motion', v.motion, 'state', s.state,
               -- חונה → מתי כובה (NULL כשלא ידוע); לא מתעדכן / לא מדווח → הדיווח האחרון; בנסיעה / מנוע דולק → NULL
               'state_since', to_char(CASE s.state
                                        WHEN 'parking' THEN app.vehicle_parked_since(v.events, v.lat, v.lon)
                                        WHEN 'silent' THEN v.located_at
                                        WHEN 'no_report' THEN v.located_at
                                      END AT TIME ZONE 'UTC', iso),
               'power_alert', CASE WHEN pa.at IS NOT NULL
                                   THEN jsonb_build_object('at', to_char(pa.at AT TIME ZONE 'UTC', iso), 'name', pa.name) END,
               'lat', v.lat, 'lon', v.lon, 'address', v.address, 'speed', v.speed,
               'heading', v.heading, 'odometer', v.odometer,
               'located_at', to_char(v.located_at AT TIME ZONE 'UTC', iso),
               'places', v.places, 'driver', v.driver,
               'synced_at', to_char(v.synced_at AT TIME ZONE 'UTC', iso))
             ORDER BY v.license_plate)
        FROM vehicles_live v
        CROSS JOIN LATERAL (SELECT app.vehicle_state(v.motion, v.located_at, v.synced_at) AS state) s
        LEFT JOIN LATERAL app.vehicle_power_alert(v.events) pa ON true), '[]'::jsonb),
    'sync', (SELECT jsonb_build_object(
                      'last_ok_at', to_char(s.last_ok_at AT TIME ZONE 'UTC', iso),
                      'vehicles', s.vehicles,
                      'last_error', s.last_error,
                      'last_error_at', to_char(s.last_error_at AT TIME ZONE 'UTC', iso))
               FROM vehicles_sync s WHERE s.id = 1),
    'now', to_char(now() AT TIME ZONE 'UTC', iso));
END
$fn$;
REVOKE ALL ON FUNCTION public.vehicles_live_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vehicles_live_list() TO authenticated;

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
