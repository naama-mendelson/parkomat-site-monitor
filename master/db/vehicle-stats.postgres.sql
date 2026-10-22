-- ============================================================
-- מה הטכנאים עשו היום — סיכום יומי, ביקורים באתרים, ומי הכי קרוב לתקלה (21/10/2026)
-- ============================================================
-- בעלת המוצר: "כרטיס לכל טכנאי. לכל טכנאי רואים איפה הוא נמצא, האם הוא נמצא באתר (אם הרכב שלו חונה ליד אתר שלנו),
-- ועוד כל פרט וסטטיסטיקה שאתה יכול להביא".
--
-- ⚠️ vehicles_live נשאר שורה אחת לרכב, בלי מסלול. מה שנשמר כאן הוא **סיכום**, לא היסטוריית מיקומים:
--   vehicle_days   — שורה לרכב ליום (בשעון ישראל): ק"מ (מד המרחק של איתוראן), זמן נסיעה, זמן באתרים, עצירות, מהירות
--                    שיא, יציאה ראשונה ותנועה אחרונה, וציר היום — מקטעים [סוג, דקה מתחילת היום, דקה, קוד אתר].
--                    כ-38 שורות ביום.
--   vehicle_visits — שורה לכל ביקור באתר: איזה אתר, מתי הגיע, עד מתי. כמה ביום לכל רכב.
-- **אין כאן קואורדינטות.** הדגימה היא כל סנכרון (פעם בדקה): app.vehicles_track נקראת מסוף ituran_ingest, בבלוק שתקלה
-- בו לא מפילה את הסנכרון.
-- ⚠️ שמירה: ביקורים — 90 יום; סיכומים יומיים — 13 חודשים, ציר היום שבהם — 90 יום (החלטה 7 בתוכנית הטכנאים).
-- ⚠️ בלי שורת events, כמו כל הרכבים: המסך שואל רק כשהוא פתוח.

CREATE TABLE IF NOT EXISTS vehicle_days (
  license_plate text NOT NULL,
  day           date NOT NULL,                 -- היום בישראל
  first_seen    timestamptz NOT NULL,
  last_seen     timestamptz NOT NULL,          -- הדגימה האחרונה שנספרה
  first_move    timestamptz,                   -- הפעם הראשונה ביום שנסע
  last_move     timestamptz,                   -- הפעם האחרונה שנסע
  odo_start     numeric,                       -- מד המרחק בדגימה הראשונה של היום (ק"מ)
  odo_last      numeric,
  drive_s       integer NOT NULL DEFAULT 0,    -- שניות בנסיעה (כולל מנוע דולק שלא באתר)
  site_s        integer NOT NULL DEFAULT 0,    -- שניות ליד אתרים שלנו
  stops         integer NOT NULL DEFAULT 0,    -- כמה פעמים עצר אחרי נסיעה
  max_speed     integer,
  last_kind     text NOT NULL,
  last_site     text,
  segments      jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (license_plate, day),
  CONSTRAINT vehicle_days_kind CHECK (last_kind IN ('drive', 'site', 'park', 'silent', 'none'))
);
CREATE INDEX IF NOT EXISTS ix_vehicle_days_day ON vehicle_days (day);

CREATE TABLE IF NOT EXISTS vehicle_visits (
  id            bigserial PRIMARY KEY,
  license_plate text NOT NULL,
  site_id       integer REFERENCES sites(id) ON DELETE SET NULL,
  site_code     text NOT NULL,                 -- תמונת מצב: שורדת מחיקת אתר
  site_name     text,
  approx        boolean NOT NULL DEFAULT false, -- מיקום האתר משוער (לפי רחוב / אזור)
  started_at    timestamptz NOT NULL,
  last_at       timestamptz NOT NULL,          -- הדגימה האחרונה שבה עוד היה שם
  ended_at      timestamptz,                   -- NULL = עדיין שם
  no_signal     boolean NOT NULL DEFAULT false, -- השתתק שם לפחות פעם (חניון תת-קרקעי)
  CONSTRAINT vehicle_visits_order CHECK (last_at >= started_at AND (ended_at IS NULL OR ended_at >= started_at))
);
-- ביקור פתוח אחד לכל רכב
CREATE UNIQUE INDEX IF NOT EXISTS ux_vehicle_visit_open ON vehicle_visits (license_plate) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_vehicle_visits_plate_start ON vehicle_visits (license_plate, started_at);
CREATE INDEX IF NOT EXISTS ix_vehicle_visits_start ON vehicle_visits (started_at);
-- ⚠️ ה-FK ל-sites הוא ON DELETE SET NULL: בלי אינדקס, delete_site סורק את כל הטבלה
CREATE INDEX IF NOT EXISTS ix_vehicle_visits_site ON vehicle_visits (site_id) WHERE site_id IS NOT NULL;

-- סגורות, כמו vehicles_live: קריאה רק דרך vehicles_live_list, כתיבה רק מ-app.vehicles_track
ALTER TABLE vehicle_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_visits ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON vehicle_days, vehicle_visits FROM %I', r);
      EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM %I', pg_get_serial_sequence('vehicle_visits', 'id'), r);
    END IF;
  END LOOP;
  REVOKE ALL ON vehicle_days, vehicle_visits FROM PUBLIC;
END $$;

CREATE OR REPLACE FUNCTION app.iso_z(p timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$ SELECT to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') $$;

-- ק"מ ביום ממד המרחק — NULL כשאין, או כשההפרש אינו סביר (מד שאופס, יחידה שהוחלפה)
CREATE OR REPLACE FUNCTION app.vehicle_day_km(p_start numeric, p_last numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$ SELECT CASE WHEN p_last - p_start BETWEEN 0 AND 1500 THEN round((p_last - p_start)::numeric, 1) END $$;

-- ביקור שהסתיים: נסגר בדגימה האחרונה שבה עוד היה שם. ⚠️ ביקור של פחות משתי דקות נמחק — רמזור או חנייה רגעית ליד
-- אתר אינם ביקור. ⚠️ שתי פקודות ולא UPDATE בתוך WITH ו-DELETE אחריו: באותה פקודה שני החלקים לא רואים זה את זה, וה-DELETE
-- על שורה שה-WITH כבר עדכן פשוט לא קורה (הבדיקה תפסה את זה — הרמזור נשאר ביקור).
CREATE OR REPLACE FUNCTION app.vehicle_visit_close(p_id bigint)
RETURNS void
LANGUAGE sql
AS $$
  DELETE FROM vehicle_visits WHERE id = p_id AND ended_at IS NULL AND last_at - started_at < interval '2 minutes';
  UPDATE vehicle_visits SET ended_at = last_at WHERE id = p_id AND ended_at IS NULL;
$$;
REVOKE ALL ON FUNCTION app.vehicle_visit_close(bigint) FROM PUBLIC;

-- ביקור "עכשיו": התחיל לפני 2 דקות לפחות (לא רמזור ליד אתר) ועודכן ב-15 הדקות האחרונות (הסנכרון לא נעצר — אחרת טכנאי
-- שאולי כבר עזב נשאר "באתר"). המקום האחד לכלל (21/10/2026, בדיקת הבאגים): האיקון בלוח (tech_on_site) ו"צריכים טכנאי
-- עכשיו" (vehicle_alerts_json). עד אז רק האיקון בדק את זה.
CREATE OR REPLACE FUNCTION app.visit_current(p_started timestamptz, p_last timestamptz, p_now timestamptz DEFAULT now())
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT p_started <= p_now - interval '2 minutes' AND p_last > p_now - interval '15 minutes'
$$;

-- ============================================================
-- שני טכנאים באותו אתר (22/10/2026)
-- ============================================================
-- הבעלת: "יכול להיות שיהיו שני טכנאים באותו אתר. לכן אם יש שני טכנאים ממש קרובים לאתר מסוים — שים אותם באותו אתר".
-- נמדד לפני: בבוקר 22/10 שני רכבים עמדו 33 מ' זה מזה, ושלוש דקות אחד נרשם ב-1163 והשני ב-1343 (48 מ' בין האתרים);
-- ב-21/10 שניים פוצלו בין 3458 ל-3461 (56 מ') כמעט שלוש שעות. כל רכב קיבל את האתר הקרוב *אליו*, ובין שני אתרים צמודים
-- שני טכנאים באותו מקום התפצלו.
-- הכלל, לרכב עומד שיש אתר בטווח שלו ("האם הוא באתר" לא משתנה כאן — רק "באיזה"):
--   1. לטכנאי של הרכב יש משימה פתוחה לאתר שבטווח — האתר של המשימה. הרכז יודע לאן שלח, ו"יצא מהאתר" של המשימה הבאה
--      נמדד מול אותו אתר.
--   2. רכבי שירות עומדים אחרים עד app.fleet_together_m() (100 מ') ממנו, שגם להם אתר בטווח: משימה פתוחה של אחד מהם
--      לאתר שבטווח של שניהם; אחרת הביקור הפתוח שהתחיל ראשון, אצלו או אצלם, באתר שבטווח שלו — מי שהגיע קודם קבע,
--      והשני מצטרף. בלי ביקור פתוח — האתר הקרוב למרכז ביניהם.
--   3. אחרת — הקרוב אליו (app.site_at).
-- המקום האחד לכלל: הביקורים (vehicles_track) והמסך (vehicle_json → at_site), ולכן גם "טכנאי באתר" בלוח.
-- ⚠️ שכן = רכב ברשימת רכבי השירות (fleet_shown): רכב משרד שחונה ליד לא מושך טכנאי לאתר אחר.
CREATE OR REPLACE FUNCTION app.fleet_together_m() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 100 $$;

CREATE OR REPLACE FUNCTION app.vehicle_site(p_plate text, p_lat double precision, p_lon double precision)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_own  jsonb := app.site_at(p_lat, p_lon);
  v_site jsonb;
  v_near text[];
  v_lat  double precision;
  v_lon  double precision;
  v_r    double precision := app.fleet_together_m();
BEGIN
  IF v_own IS NULL THEN RETURN NULL; END IF;

  -- 1. המשימה הפתוחה של הטכנאי שלו, לאתר שבטווח
  SELECT jsonb_build_object('site_id', s.id, 'code', s.code, 'name', s.site_name,
                            'm', round(app.geo_distance_m(p_lat, p_lon, s.lat, s.lon))::integer,
                            'approx', s.geo_precision IN ('street', 'area'))
    INTO v_site
    FROM technicians t
    JOIN tech_dispatches d ON d.technician_id = t.id AND d.ended_at IS NULL
    JOIN sites s ON s.id = d.site_id
   WHERE t.is_active AND t.plate = p_plate AND s.lat IS NOT NULL
     AND app.geo_distance_m(p_lat, p_lon, s.lat, s.lon) <= app.site_radius_m(s.geo_precision)
   LIMIT 1;
  IF v_site IS NOT NULL THEN RETURN v_site; END IF;

  -- 2. שכנים: רכבי שירות עומדים עד 100 מ', שגם להם אתר בטווח
  SELECT array_agg(l.license_plate ORDER BY l.license_plate) INTO v_near
    FROM vehicles_live l
   WHERE l.license_plate <> p_plate AND l.lat IS NOT NULL AND l.lon IS NOT NULL
     AND l.lat BETWEEN p_lat - v_r / 111195.0 AND p_lat + v_r / 111195.0
     AND app.geo_distance_m(p_lat, p_lon, l.lat, l.lon) <= v_r
     AND app.fleet_shown(l.license_plate)
     AND app.vehicle_may_be_at_site(app.vehicle_state(l.motion, l.located_at, l.synced_at), l.motion, l.speed)
     AND app.site_at(l.lat, l.lon) IS NOT NULL;
  IF v_near IS NULL THEN RETURN v_own; END IF;

  -- שכן שהטכנאי שלו נשלח לאתר שבטווח של שניהם — לשם: המשימה שהרכז נתן קובעת לשניהם. ⚠️ בלי זה הסדר שבו הסנכרון עובר
  -- על הרכבים קבע: מי שעובר ראשון פותח ביקור באתר הקרוב אליו, והשני — שנשלח לאתר הצמוד — נשאר שם לבד.
  SELECT jsonb_build_object('site_id', s.id, 'code', s.code, 'name', s.site_name,
                            'm', round(app.geo_distance_m(p_lat, p_lon, s.lat, s.lon))::integer,
                            'approx', s.geo_precision IN ('street', 'area'))
    INTO v_site
    FROM technicians t
    JOIN tech_dispatches d ON d.technician_id = t.id AND d.ended_at IS NULL
    JOIN sites s ON s.id = d.site_id
    JOIN vehicles_live l ON l.license_plate = t.plate
   WHERE t.is_active AND t.plate = ANY (v_near) AND s.lat IS NOT NULL
     AND app.geo_distance_m(p_lat, p_lon, s.lat, s.lon) <= app.site_radius_m(s.geo_precision)
     AND app.geo_distance_m(l.lat, l.lon, s.lat, s.lon) <= app.site_radius_m(s.geo_precision)
   ORDER BY d.created_at, d.id
   LIMIT 1;
  IF v_site IS NOT NULL THEN RETURN v_site; END IF;

  -- הביקור הפתוח שהתחיל ראשון — אצלו או אצל שכן — באתר שבטווח שלו
  SELECT jsonb_build_object('site_id', s.id, 'code', s.code, 'name', s.site_name,
                            'm', round(app.geo_distance_m(p_lat, p_lon, s.lat, s.lon))::integer,
                            'approx', s.geo_precision IN ('street', 'area'))
    INTO v_site
    FROM vehicle_visits vv
    JOIN sites s ON s.id = vv.site_id
   WHERE vv.ended_at IS NULL AND (vv.license_plate = p_plate OR vv.license_plate = ANY (v_near))
     AND s.lat IS NOT NULL
     AND app.geo_distance_m(p_lat, p_lon, s.lat, s.lon) <= app.site_radius_m(s.geo_precision)
   ORDER BY vv.started_at, vv.id
   LIMIT 1;
  IF v_site IS NOT NULL THEN RETURN v_site; END IF;

  -- בלי ביקור פתוח — האתר הקרוב למרכז ביניהם, אם הוא בטווח שלו
  SELECT avg(g.lat), avg(g.lon) INTO v_lat, v_lon
    FROM (SELECT p_lat AS lat, p_lon AS lon
          UNION ALL SELECT l.lat, l.lon FROM vehicles_live l WHERE l.license_plate = ANY (v_near)) g;
  v_site := app.site_at(v_lat, v_lon);
  IF v_site IS NOT NULL THEN
    SELECT jsonb_build_object('site_id', s.id, 'code', s.code, 'name', s.site_name,
                              'm', round(app.geo_distance_m(p_lat, p_lon, s.lat, s.lon))::integer,
                              'approx', s.geo_precision IN ('street', 'area'))
      INTO v_site
      FROM sites s
     WHERE s.id = (v_site ->> 'site_id')::integer
       AND app.geo_distance_m(p_lat, p_lon, s.lat, s.lon) <= app.site_radius_m(s.geo_precision);
    IF v_site IS NOT NULL THEN RETURN v_site; END IF;
  END IF;
  RETURN v_own;
END
$fn$;
REVOKE ALL ON FUNCTION app.vehicle_site(text, double precision, double precision) FROM PUBLIC;

-- ============================================================
-- הדגימה — פעם בסנכרון, לכל רכב שהגיע בו
-- ============================================================
-- הזמן שבין הדגימה הקודמת לזו שייך למה שהרכב עשה **בקודמת** (המצב נמשך עד שהשתנה), עד 5 דקות: פער ארוך יותר (סנכרון
-- שנפל) נרשם בציר כ-none, ולא כנסיעה של שעתיים.
CREATE OR REPLACE FUNCTION app.vehicles_track(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_day     date := (p_now AT TIME ZONE 'Asia/Jerusalem')::date;
  v_day0    timestamptz := ((p_now AT TIME ZONE 'Asia/Jerusalem')::date)::timestamp AT TIME ZONE 'Asia/Jerusalem';
  v_min     integer := floor(EXTRACT(EPOCH FROM p_now - v_day0) / 60)::integer;
  r         record;
  d         vehicle_days;
  o         vehicle_visits;
  pv        vehicle_visits;
  v_prev_end timestamptz;
  v_state   text;
  v_at      jsonb;
  v_kind    text;
  v_site    text;
  v_segs    jsonb;
  v_last    jsonb;
  v_n       integer;
  v_end     integer;
  v_ext     integer;
  v_gap     boolean;
  v_delta   integer;
  v_speed   integer;
  v_ps      timestamptz;
  v_count   integer := 0;
BEGIN
  FOR r IN SELECT * FROM vehicles_live
            WHERE synced_at > p_now - interval '2 minutes' AND synced_at <= p_now + interval '1 minute' LOOP
    v_state := app.vehicle_state(r.motion, r.located_at, r.synced_at);
    -- ⚠️ השתתק — נחשב עמידה רק אם הדיווח האחרון היה איטי או שלא נסע (app.vehicle_may_be_at_site, 21/10/2026)
    -- ⚠️ איזה אתר — app.vehicle_site: משימה פתוחה, ושני טכנאים צמודים באותו אתר (22/10/2026)
    v_at := CASE WHEN app.vehicle_may_be_at_site(v_state, r.motion, r.speed) THEN app.vehicle_site(r.license_plate, r.lat, r.lon) END;
    v_kind := app.vehicle_kind(v_state, v_at IS NOT NULL);
    v_site := v_at ->> 'code';
    v_speed := CASE WHEN v_state = 'driving' AND r.speed BETWEEN 1 AND 250 THEN r.speed END;

    SELECT * INTO d FROM vehicle_days WHERE license_plate = r.license_plate AND day = v_day FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO vehicle_days (license_plate, day, first_seen, last_seen, first_move, last_move, odo_start, odo_last,
                                max_speed, last_kind, last_site, segments)
      VALUES (r.license_plate, v_day, p_now, p_now,
              CASE WHEN v_kind = 'drive' THEN p_now END, CASE WHEN v_kind = 'drive' THEN p_now END,
              r.odometer, r.odometer, v_speed, v_kind, v_site,
              jsonb_build_array(jsonb_build_array(v_kind, v_min, v_min, v_site)));
    ELSIF p_now > d.last_seen THEN
      v_delta := LEAST(EXTRACT(EPOCH FROM p_now - d.last_seen), 300)::integer;
      v_segs := d.segments;
      v_n := jsonb_array_length(v_segs);
      v_gap := false;
      IF v_n = 0 THEN
        v_segs := jsonb_build_array(jsonb_build_array(v_kind, v_min, v_min, v_site));
      ELSE
        v_last := v_segs -> (v_n - 1);
        v_end := (v_last ->> 2)::integer;
        v_ext := LEAST(v_min, v_end + 5);
        v_segs := jsonb_set(v_segs, ARRAY[(v_n - 1)::text, '2'], to_jsonb(v_ext));
        -- ⚠️ תקרה של 400 מקטעים ליום: רכב שמהבהב בין מצבים לא יגדיל את השורה בלי סוף (המקטע האחרון פשוט מתארך)
        IF v_min - v_end > 5 AND v_n < 400 THEN
          v_segs := v_segs || jsonb_build_array(jsonb_build_array('none', v_ext, v_min, NULL));
          v_gap := true;
        END IF;
        IF (v_gap OR (v_last ->> 0) IS DISTINCT FROM v_kind OR (v_last ->> 3) IS DISTINCT FROM v_site)
           AND jsonb_array_length(v_segs) < 400 THEN
          v_segs := v_segs || jsonb_build_array(jsonb_build_array(v_kind, v_min, v_min, v_site));
        ELSIF NOT v_gap THEN
          v_segs := jsonb_set(v_segs, ARRAY[(jsonb_array_length(v_segs) - 1)::text, '2'], to_jsonb(v_min));
        END IF;
      END IF;
      UPDATE vehicle_days SET
        last_seen  = p_now,
        first_move = COALESCE(first_move, CASE WHEN v_kind = 'drive' THEN p_now END),
        last_move  = CASE WHEN v_kind = 'drive' THEN p_now ELSE last_move END,
        odo_start  = COALESCE(odo_start, r.odometer),
        odo_last   = COALESCE(r.odometer, odo_last),
        drive_s    = drive_s + CASE WHEN d.last_kind = 'drive' THEN v_delta ELSE 0 END,
        site_s     = site_s + CASE WHEN d.last_kind = 'site' THEN v_delta ELSE 0 END,
        stops      = stops + CASE WHEN v_kind IN ('site', 'park') AND d.last_kind = 'drive' THEN 1 ELSE 0 END,
        max_speed  = GREATEST(max_speed, v_speed),
        last_kind  = v_kind,
        last_site  = v_site,
        segments   = v_segs
      WHERE license_plate = r.license_plate AND day = v_day;
    END IF;

    -- הביקור באתר
    SELECT * INTO o FROM vehicle_visits WHERE license_plate = r.license_plate AND ended_at IS NULL FOR UPDATE;
    IF v_kind = 'site' THEN
      IF o.id IS NOT NULL AND o.site_code = v_site THEN
        UPDATE vehicle_visits SET last_at = GREATEST(last_at, p_now), no_signal = no_signal OR v_state = 'silent'
         WHERE id = o.id;
      ELSE
        IF o.id IS NOT NULL THEN PERFORM app.vehicle_visit_close(o.id); END IF;
        -- ⚠️ 21/10/2026 (בדיקת הבאגים): רכב חונה שהמיקום שלו קפץ רגע אל מחוץ לטווח, או סנכרון אחד בלי מצב, סגרו את הביקור,
        -- והחזרה פתחה ביקור שני — חופף, עם אותה שעת הגעה — ו"ביקורים באתרים" נספרו פעמיים. חזרה לאותו אתר בתוך 15 דקות,
        -- בלי ביקור אחר באמצע, פותחת מחדש את אותו ביקור.
        pv := NULL;
        SELECT * INTO pv FROM vehicle_visits
         WHERE license_plate = r.license_plate AND ended_at IS NOT NULL AND site_code = v_site
           AND ended_at >= p_now - interval '15 minutes'
         ORDER BY ended_at DESC LIMIT 1 FOR UPDATE;
        IF pv.id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vehicle_visits x
                                              WHERE x.license_plate = r.license_plate AND x.id <> pv.id AND x.started_at > pv.ended_at) THEN
          UPDATE vehicle_visits SET ended_at = NULL, last_at = GREATEST(last_at, p_now), no_signal = no_signal OR v_state = 'silent'
           WHERE id = pv.id;
        ELSE
          -- חונה: ההגעה היא כיבוי ההצתה ("חונה מאז"), אם היה ב-12 השעות האחרונות; אחרת — הדגימה הזו.
          -- ⚠️ ולא לפני סוף הביקור הקודם של הרכב — אחרת שני ביקורים חופפים (כיבוי ההצתה יכול להיות ישן מהביקור הקודם).
          v_ps := CASE WHEN v_state = 'parking' THEN app.vehicle_parked_since(r.events, r.lat, r.lon) END;
          SELECT max(ended_at) INTO v_prev_end FROM vehicle_visits WHERE license_plate = r.license_plate AND ended_at IS NOT NULL;
          INSERT INTO vehicle_visits (license_plate, site_id, site_code, site_name, approx, started_at, last_at, no_signal)
          VALUES (r.license_plate, (v_at ->> 'site_id')::integer, v_site, v_at ->> 'name', COALESCE((v_at ->> 'approx')::boolean, false),
                  -- ⚠️ GREATEST/LEAST מתעלמים מ-NULL: בלי ביקור קודם GREATEST מחזיר את שעת ההגעה, ו-LEAST בחוץ רק מגביל לעכשיו
                  LEAST(GREATEST(COALESCE(CASE WHEN v_ps >= p_now - interval '12 hours' AND v_ps <= p_now THEN v_ps END, p_now),
                                 v_prev_end), p_now),
                  p_now, v_state = 'silent');
        END IF;
      END IF;
    ELSIF o.id IS NOT NULL THEN
      PERFORM app.vehicle_visit_close(o.id);
    END IF;
    v_count := v_count + 1;
  END LOOP;

  -- רכב שהוצא מהחשבון באיתוראן — הביקור הפתוח שלו נסגר, ולא נשאר "באתר" לנצח
  PERFORM app.vehicle_visit_close(v.id)
     FROM vehicle_visits v
    WHERE v.ended_at IS NULL AND NOT EXISTS (SELECT 1 FROM vehicles_live l WHERE l.license_plate = v.license_plate);
  RETURN v_count;
END
$fn$;
REVOKE ALL ON FUNCTION app.vehicles_track(timestamptz) FROM PUBLIC;

-- ============================================================
-- מה הכרטיס מציג לרכב אחד — הביקור הנוכחי, היום, והשבוע
-- ============================================================
-- visit  = הביקור הפתוח: {code, name, since, approx, no_signal}
-- today  = {km, drive_s, site_s, stops, max_speed, first_move, last_move, segments, day_start, day_minutes, now_min}
-- visits = הביקורים שהתחילו היום (שתי דקות לפחות, או הפתוח): [{code, name, from, to, open, approx, no_signal}]
-- week   = שבעה ימים, הישן ראשון, כולל היום: [{day, km, drive_s, visits, sites}]
CREATE OR REPLACE FUNCTION app.vehicle_stats_json(p_plate text, p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, app, pg_temp
AS $fn$
BEGIN
  -- ⚠️ plpgsql ולא sql: פונקציית sql עם FROM מתוכננת מחדש בכל קריאה, ו-38 קריאות בכל שאילתה של המסך עלו ~250 מ"ש (נמדד
  -- מקומית, 21/10/2026); plpgsql שומרת את התוכנית בין קריאות באותו חיבור.
  RETURN (  WITH b AS (
    SELECT (p_now AT TIME ZONE 'Asia/Jerusalem')::date AS today,
           ((p_now AT TIME ZONE 'Asia/Jerusalem')::date)::timestamp AT TIME ZONE 'Asia/Jerusalem' AS day0,
           (((p_now AT TIME ZONE 'Asia/Jerusalem')::date + 1)::timestamp AT TIME ZONE 'Asia/Jerusalem') AS day1
  )
  SELECT jsonb_build_object(
    'visit', (SELECT jsonb_build_object('code', o.site_code, 'name', o.site_name, 'since', app.iso_z(o.started_at),
                                        'approx', o.approx, 'no_signal', o.no_signal)
                FROM vehicle_visits o WHERE o.license_plate = p_plate AND o.ended_at IS NULL),
    'today', (SELECT jsonb_build_object(
                       'km', app.vehicle_day_km(d.odo_start, d.odo_last),
                       'drive_s', d.drive_s, 'site_s', d.site_s, 'stops', d.stops, 'max_speed', d.max_speed,
                       'first_move', app.iso_z(d.first_move), 'last_move', app.iso_z(d.last_move),
                       'segments', d.segments)
                FROM vehicle_days d WHERE d.license_plate = p_plate AND d.day = b.today),
    'day_start', app.iso_z(b.day0),
    'day_minutes', round(EXTRACT(EPOCH FROM b.day1 - b.day0) / 60)::integer,
    'now_min', floor(EXTRACT(EPOCH FROM p_now - b.day0) / 60)::integer,
    'visits', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                                 'code', o.site_code, 'name', o.site_name, 'from', app.iso_z(o.started_at),
                                 'to', app.iso_z(COALESCE(o.ended_at, o.last_at)), 'open', o.ended_at IS NULL,
                                 'approx', o.approx, 'no_signal', o.no_signal) ORDER BY o.started_at)
                          FROM vehicle_visits o
                         WHERE o.license_plate = p_plate AND o.started_at >= b.day0
                           AND (o.ended_at IS NULL OR o.ended_at - o.started_at >= interval '2 minutes')), '[]'::jsonb),
    -- ⚠️ הביקורים של השבוע בסריקה אחת לכל רכב (GROUP BY יום בישראל), ולא שתי ספירות לכל יום: 14 שאילתות לרכב × 38 רכבים
    -- היו רוב הזמן של הרשימה (נמדד מקומית: 322 מ"ש לשאילתה).
    'week', (SELECT jsonb_agg(jsonb_build_object(
                       'day', to_char(g.day, 'YYYY-MM-DD'),
                       'km', app.vehicle_day_km(d.odo_start, d.odo_last),
                       'drive_s', COALESCE(d.drive_s, 0),
                       'visits', COALESCE(w.n, 0),
                       'sites', COALESCE(w.s, 0),
                       'tracked', d.day IS NOT NULL) ORDER BY g.day)
               FROM generate_series(b.today - 6, b.today, interval '1 day') AS gs(t)
               CROSS JOIN LATERAL (SELECT gs.t::date AS day) g
               LEFT JOIN vehicle_days d ON d.license_plate = p_plate AND d.day = g.day
               LEFT JOIN (SELECT (o.started_at AT TIME ZONE 'Asia/Jerusalem')::date AS day,
                                 count(*)::integer AS n, count(DISTINCT o.site_code)::integer AS s
                            FROM vehicle_visits o
                           WHERE o.license_plate = p_plate
                             AND o.started_at >= (b.today - 6)::timestamp AT TIME ZONE 'Asia/Jerusalem'
                             AND (o.ended_at IS NULL OR o.ended_at - o.started_at >= interval '2 minutes')
                           GROUP BY 1) w ON w.day = g.day))
    FROM b
  );
END
$fn$;
REVOKE ALL ON FUNCTION app.vehicle_stats_json(text, timestamptz) FROM PUBLIC;

-- ============================================================
-- "מי הכי קרוב" — האתרים שצריכים טכנאי עכשיו, ולכל אחד שלושת הרכבים הקרובים
-- ============================================================
-- צריך טכנאי = בתקלה (sites.status = 'error', אתר עם בקר) או עם קריאה פתוחה בוויזנט (אותה הגדרה כמו בכל הדשבורד:
-- app.service_calls_current). on_site = רכבים שכבר עומדים שם (ביקור פתוח). רכב "לא מדווח" (יממה בלי דיווח) לא נספר.
CREATE OR REPLACE FUNCTION app.vehicle_alerts_json()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
  WITH calls AS (
    SELECT c.site_id, count(*)::integer AS n
      FROM app.service_calls_current() c
     WHERE c.open AND c.site_id IS NOT NULL
     GROUP BY c.site_id
  ), need AS (
    SELECT s.id, s.code, s.site_name, s.lat, s.lon, s.geo_precision,
           (s.status = 'error' AND s.monitored IS NOT FALSE) AS fault, COALESCE(c.n, 0) AS calls
      FROM sites s LEFT JOIN calls c ON c.site_id = s.id
     WHERE (s.status = 'error' AND s.monitored IS NOT FALSE) OR c.n > 0
  ), veh AS (
    -- ⚠️ רק רכבי השירות (fleet_shown, 21/10/2026) — רכב משרד שעובר ליד אתר בתקלה אינו "הכי קרוב"
    SELECT v.license_plate, v.lat, v.lon, app.vehicle_state(v.motion, v.located_at, v.synced_at) AS state
      FROM vehicles_live v WHERE v.lat IS NOT NULL AND app.fleet_shown(v.license_plate)
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'code', n.code, 'name', n.site_name, 'fault', n.fault, 'calls', n.calls,
           'located', n.lat IS NOT NULL, 'approx', COALESCE(n.geo_precision IN ('street', 'area'), false),
           'on_site', (SELECT COALESCE(jsonb_agg(o.license_plate ORDER BY o.started_at), '[]'::jsonb)
                         FROM vehicle_visits o
                        WHERE o.ended_at IS NULL AND o.site_id = n.id AND app.visit_current(o.started_at, o.last_at)
                          AND app.fleet_shown(o.license_plate)),
           -- ⚠️ בלי מי שכבר באתר הזה — לפני ה-LIMIT, אחרת רכב שעומד באתר תפס מקום מתוך שלושת "הקרובים" (21/10/2026)
           'nearest', (SELECT COALESCE(jsonb_agg(jsonb_build_object('plate', q.license_plate, 'm', q.m, 'state', q.state)
                                                 ORDER BY q.m), '[]'::jsonb)
                         FROM (SELECT x.license_plate, x.state,
                                      round(app.geo_distance_m(n.lat, n.lon, x.lat, x.lon))::integer AS m
                                 FROM veh x
                                WHERE n.lat IS NOT NULL AND x.state <> 'no_report'
                                  AND NOT EXISTS (SELECT 1 FROM vehicle_visits o2
                                                   WHERE o2.ended_at IS NULL AND o2.site_id = n.id
                                                     AND o2.license_plate = x.license_plate
                                                     AND app.visit_current(o2.started_at, o2.last_at))
                                ORDER BY 3 LIMIT 3) q))
         ORDER BY n.fault DESC, n.calls DESC, n.site_name), '[]'::jsonb)
    FROM need n
$$;
REVOKE ALL ON FUNCTION app.vehicle_alerts_json() FROM PUBLIC;

-- ============================================================
-- "טכנאי באתר" על כרטיסי האתרים בלוח (21/10/2026)
-- ============================================================
-- הבעלת, על לוח האתרים: "שיהיה כזה סמל שטכנאי באתר", ואז "תשים איקון טכנאי באתר". המקור: הביקורים הפתוחים, שנרשמים
-- כבר כל דקה (vehicles_track). אין כאן חישוב מחדש.
-- ⚠️ ביקור שנפתח לפני פחות מ-2 דקות לא נספר (רמזור ליד אתר; אותו כלל כמו מחיקת ביקור קצר בסגירה). ביקור שלא עודכן
-- 15 דקות לא נספר (הסנכרון נעצר; לא להראות טכנאי שאולי כבר עזב).
-- ⚠️ תצוגה בלבד: לא משנה את מצב האתר (ההעברה האוטומטית לתחזוקה כשטכנאי באתר הושהתה, 18/10).
-- קל: שורה לכל רכב שעומד באתר (≈38 לכל היותר). כל מסך גלוי שואל כל 2 דקות.
CREATE OR REPLACE FUNCTION public.tech_on_site()
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
             'site_id', vv.site_id, 'code', vv.site_code, 'plate', vv.license_plate,
             'nickname', vl.nickname, 'tech', t.display_name,
             'since', app.iso_z(vv.started_at), 'no_signal', vv.no_signal)
           ORDER BY vv.site_code, vv.started_at)
      FROM vehicle_visits vv
      JOIN vehicles_live vl ON vl.license_plate = vv.license_plate
      LEFT JOIN LATERAL (SELECT x.display_name FROM technicians x
                          WHERE x.plate = vv.license_plate AND x.is_active ORDER BY x.id LIMIT 1) t ON true
     WHERE vv.ended_at IS NULL
       AND vv.site_id IS NOT NULL
       AND app.visit_current(vv.started_at, vv.last_at)
       -- ⚠️ רק רכבי השירות (21/10/2026): רכב משרד שחונה ליד אתר אינו "טכנאי באתר"
       AND app.fleet_shown(vv.license_plate)), '[]'::jsonb);
END
$fn$;
REVOKE ALL ON FUNCTION public.tech_on_site() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tech_on_site() TO authenticated;

-- ============================================================
-- הגריפה — מ-pg_cron (cron.postgres.sql), פעם ביום
-- ============================================================
CREATE OR REPLACE FUNCTION app.prune_vehicle_stats(p_visits interval DEFAULT interval '90 days',
                                                   p_days interval DEFAULT interval '400 days',
                                                   p_segments interval DEFAULT interval '90 days')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  n_visits integer;
  n_days   integer;
  n_segs   integer;
  v_today  date := (now() AT TIME ZONE 'Asia/Jerusalem')::date;
BEGIN
  DELETE FROM vehicle_visits WHERE ended_at IS NOT NULL AND ended_at < now() - p_visits;
  GET DIAGNOSTICS n_visits = ROW_COUNT;
  DELETE FROM vehicle_days WHERE day < (v_today - p_days)::date;
  GET DIAGNOSTICS n_days = ROW_COUNT;
  UPDATE vehicle_days SET segments = '[]'::jsonb WHERE day < (v_today - p_segments)::date AND segments <> '[]'::jsonb;
  GET DIAGNOSTICS n_segs = ROW_COUNT;
  RETURN jsonb_build_object('visits', n_visits, 'days', n_days, 'segments', n_segs);
END
$fn$;
REVOKE ALL ON FUNCTION app.prune_vehicle_stats(interval, interval, interval) FROM PUBLIC;
