-- ============================================================
-- רכבי הטכנאים מאיתוראן — מפה חיה (20/10/2026)
-- ============================================================
-- בעלת המוצר: "יש לפרקומט רכבים של אנשי תחזוקה, על כל רכב יש איתוראן" → "כל מידע אפשרי הכלל" → שלב ראשון: מפה חיה,
-- ו"כל מי שמחובר" רואה אותה. איתוראן הקימו משתמש API (השם והסיסמה — בסודות של ה-Edge Function בלבד, לא במאגר:
-- הוא ציבורי); התיעוד: docs.ituran.com (OpenAPI ב-Stoplight).
--
-- הזרימה: pg_cron כל דקה → app.ituran_sync_request() → net.http_post ל-Edge Function ‏ituran-sync → היא מחזיקה את
-- הטוקן של איתוראן (בזיכרון, לא במסד), מושכת את כל הרכבים (GET /api/v2/vehicles עם LastLocation, Driver, Places) ומעבירה
-- את התשובה **כמות שהיא** ל-public.ituran_ingest. כל הפענוח כאן (rule 3): אילו שדות, איזה שעון, מה נמחק.
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
  located_at    timestamptz,       -- מתי איתוראן קיבלו את המיקום הזה
  places        jsonb NOT NULL DEFAULT '[]'::jsonb,   -- המקומות (אזורים) שהרכב בתוכם — [{place_id, place_name}]
  driver        text,
  synced_at     timestamptz NOT NULL DEFAULT now()    -- מתי השורה נכתבה אצלנו
);

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
    -- 0,0 הוא "אין מיקום" (באוקיינוס האטלנטי), לא מיקום
    IF v_lat = 0 AND v_lon = 0 THEN v_lat := NULL; v_lon := NULL; END IF;

    INSERT INTO vehicles_live AS t (license_plate, vehicle_id, nickname, make_name, model_name, motion,
                                    lat, lon, address, speed, heading, odometer, located_at, places, driver, synced_at)
    VALUES (
      v_plate,
      app.ituran_num(v->>'vehicle_id')::integer,
      NULLIF(btrim(v->>'nickname'), ''),
      NULLIF(btrim(v->>'make_name'), ''),
      NULLIF(btrim(v->>'model_name'), ''),
      NULLIF(btrim(v->>'motion_status'), ''),
      v_lat, v_lon,
      NULLIF(btrim(COALESCE(v #>> '{last_location,location,address,location}',
                            concat_ws(', ', v #>> '{last_location,location,address,street}',
                                            v #>> '{last_location,location,address,city}'))), ''),
      app.ituran_num(v #>> '{last_location,speed}')::integer,
      app.ituran_num(v #>> '{last_location,heading}')::integer,
      app.ituran_num(v #>> '{last_location,odometer}'),
      app.ituran_ts(v #>> '{last_location,timestamp}'),
      CASE WHEN jsonb_typeof(v->'places') = 'array' THEN v->'places' ELSE '[]'::jsonb END,
      NULLIF(btrim(concat_ws(' ', v #>> '{current_driver,first_name}', v #>> '{current_driver,last_name}')), ''),
      now())
    ON CONFLICT (license_plate) DO UPDATE SET
      vehicle_id = EXCLUDED.vehicle_id,
      nickname   = EXCLUDED.nickname,
      make_name  = EXCLUDED.make_name,
      model_name = EXCLUDED.model_name,
      motion     = EXCLUDED.motion,
      places     = EXCLUDED.places,
      driver     = EXCLUDED.driver,
      synced_at  = EXCLUDED.synced_at,
      -- ⚠️ המיקום מתעדכן רק כשהגיע מיקום, ורק קדימה בזמן: תשובה בלי LastLocation לא תמחק מיקום ידוע, ותשובה ישנה
      -- שהגיעה באיחור לא תחזיר את הרכב לאחור
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
               'motion', v.motion, 'lat', v.lat, 'lon', v.lon, 'address', v.address, 'speed', v.speed,
               'heading', v.heading, 'odometer', v.odometer,
               'located_at', to_char(v.located_at AT TIME ZONE 'UTC', iso),
               'places', v.places, 'driver', v.driver,
               'synced_at', to_char(v.synced_at AT TIME ZONE 'UTC', iso))
             ORDER BY v.license_plate)
        FROM vehicles_live v), '[]'::jsonb),
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
