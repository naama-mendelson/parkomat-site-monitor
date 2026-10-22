-- ============================================================
-- לוח טכנאי השטח — שלב 1 (20/10/2026)
-- ============================================================
-- רכז הטכנאים ביקש להעביר את הלוח שלו לתוך הדשבורד: מצבים, "שלח לתקלה", הבחנה בין "הגיע" ל"נכנס", ויומן. בעלת המוצר
-- אישרה את שלב 1 עם ההמלצות (החלטות 1–8 בתוכנית), ובחרה "כרטיסים, כמו אצל הרכז":
--   1. מפעילים — עורכים ומנהלים (app.require_editor).       2. רואים — כל מי שמחובר, כמו המפה (app.require_staff).
--   3. שליחה אינה משימה — רשומה נפרדת (tech_dispatches).      4. שמונת המצבים שלו, והגיע / נכנס / סיים כזמנים על השליחה.
--   5. יעד שאינו אתר — טקסט חופשי, שנזכר לפעם הבאה.          6. מיקום הרכב נשמר בכל שליחה, הגעה, כניסה וסיום; הקואורדינטות
--      נמחקות אחרי 30 יום (app.prune_technicians).          7. יומן ושליחויות — 90 יום.
--   8. קודם לפיילוט: settings.technicians_board = 'all' או רשימת מיילים (כמו login_code_required). מי שלא ברשימה רואה את
--      המפה בלבד, כמו היום — והכתיבה סגורה בפניו.
--
-- ⚠️ **אין שורת events**, בכוונה (כמו vehicles): באנדל ישן מתייחס לסוג לא מוכר כ"טען הכול" — זה מה שהעמיס את המסד
-- ב-07/10. הלוח שואל את tech_board רק כשהוא פתוח ונראה.
-- ⚠️ **שום שם אמיתי במאגר** — הוא ציבורי. הטכנאים והרכבים שלהם מוזנים במסך הניהול של הלוח, והבדיקות משתמשות בשמות מומצאים.
-- ⚠️ שלוש הטבלאות סגורות (RLS בלי מדיניות ובלי הרשאות). קריאה וכתיבה רק דרך הפונקציות כאן, SECURITY DEFINER.

-- ============================================================
-- הטבלאות
-- ============================================================

-- טכנאי: שם, הרכב שלו באיתוראן, ומצב נוכחי. ⚠️ plate בלי FK ל-vehicles_live: ituran_ingest מוחק רכב שאיתוראן הורידו
-- מהחשבון, ו-FK היה עוצר את הסנכרון של כל הצי. טכנאי לא נמחק — מושבת (is_active), כדי שהיומן ימשיך לדעת מי הוא.
-- rev = הגרסה שהמסך טען: כל שינוי מעלה אותה, ומסך ישן מקבל PT409 במקום לשלוח טכנאי שמישהו אחר כבר שלח.
CREATE TABLE IF NOT EXISTS technicians (
  id           bigserial PRIMARY KEY,
  display_name text NOT NULL,
  plate        text,
  is_active    boolean NOT NULL DEFAULT true,
  status       text,                       -- NULL = עוד לא היה לו מצב מעולם
  status_at    timestamptz,
  status_by    text,
  rev          integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text NOT NULL,
  CONSTRAINT technicians_name_shape CHECK (length(display_name) BETWEEN 2 AND 60 AND display_name = btrim(display_name)),
  CONSTRAINT technicians_plate_shape CHECK (plate IS NULL OR (length(plate) BETWEEN 1 AND 20 AND plate = btrim(plate))),
  -- ⚠️ אותה רשימה ב-app.tech_statuses(), ב-tech_log_status למטה וב-TECH_STATUSES (dashboard/src/utils/technicians.js).
  -- הבדיקה ב-technicians.test.js משווה בין הארבע.
  CONSTRAINT technicians_status_chk CHECK (status IS NULL OR status IN
    ('free', 'en_route', 'on_site', 'feedback', 'break', 'evening', 'vacation', 'day_done')),
  CONSTRAINT technicians_status_shape CHECK ((status IS NULL) = (status_at IS NULL))
);
-- שם אחד ורכב אחד לכל טכנאי פעיל. המושבתים לא תופסים — כך רכב עובר לטכנאי אחר.
CREATE UNIQUE INDEX IF NOT EXISTS ux_technicians_active_name ON technicians (lower(display_name)) WHERE is_active;
CREATE UNIQUE INDEX IF NOT EXISTS ux_technicians_active_plate ON technicians (plate) WHERE is_active AND plate IS NOT NULL;

-- הטלפון של הטכנאי (21/10/2026, שלב 2 של "צא ל:"): המשתמש שהטלפון מתחבר בו, ומספר החיבור (phone_gen) שגדל בכל QR.
-- ⚠️ ALTER ולא בתוך ה-CREATE: מסד שהטבלה כבר קיימת בו מדלג על כל ה-CREATE.
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS app_user_id integer REFERENCES app_users(id) ON DELETE SET NULL;
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS phone_gen integer NOT NULL DEFAULT 0;
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS phone_paired_at timestamptz;   -- מתי נוצר ה-QR האחרון
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS phone_paired_by text;
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS phone_seen_at timestamptz;     -- מתי הטלפון פנה אלינו לאחרונה (tech_me)
-- משתמש אחד לטכנאי אחד. ⚠️ גם האינדקס של ה-FK: ON DELETE SET NULL בלי אינדקס סורק את הטבלה (הלקח של 19/10).
CREATE UNIQUE INDEX IF NOT EXISTS ux_technicians_phone_user ON technicians (app_user_id) WHERE app_user_id IS NOT NULL;

-- שליחה: לאן (אתר שלנו — עם תמונת מצב של הקוד והשם, ששורדת מחיקת אתר — או מקום חופשי), ושלושה זמנים: הגיע, נכנס, סיים.
-- ⚠️ "הגיע" ו"נכנס" הם זמנים ולא מצבים (החלטה 4): כך הם נפרדים מהיום הראשון, והסיכום (שלב 2) מודד נסיעה, המתנה ועבודה.
-- *_late = הזמן נכתב בדיעבד ("הגיע לפני 10 דק׳"), ולא ברגע הלחיצה. ticket = מספר קריאה בוויזנט — נשמר בלבד, לא נשלח לשם.
CREATE TABLE IF NOT EXISTS tech_dispatches (
  id            bigserial PRIMARY KEY,
  client_id     uuid NOT NULL UNIQUE,      -- לכל טיוטה: שליחה חוזרת של אותה בקשה מחזירה את מה שנוצר
  technician_id bigint NOT NULL REFERENCES technicians(id),
  site_id       integer REFERENCES sites(id) ON DELETE SET NULL,
  site_code     text,
  site_name     text,
  place         text,
  details       text,
  ticket        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text NOT NULL,
  arrived_at    timestamptz,
  arrived_by    text,
  arrived_late  boolean NOT NULL DEFAULT false,
  entered_at    timestamptz,
  entered_by    text,
  entered_late  boolean NOT NULL DEFAULT false,
  ended_at      timestamptz,
  ended_by      text,
  ended_late    boolean NOT NULL DEFAULT false,
  end_kind      text,                      -- done = סיים · cancelled = בוטלה · moved = נשלח לאתר אחר
  CONSTRAINT tech_dispatches_dest CHECK ((site_code IS NULL) <> (place IS NULL)),
  CONSTRAINT tech_dispatches_end_kind CHECK (end_kind IS NULL OR end_kind IN ('done', 'cancelled', 'moved')),
  CONSTRAINT tech_dispatches_end_shape CHECK ((ended_at IS NULL) = (end_kind IS NULL)),
  CONSTRAINT tech_dispatches_marks_shape CHECK ((arrived_at IS NULL) = (arrived_by IS NULL)
                                            AND (entered_at IS NULL) = (entered_by IS NULL)
                                            AND (ended_at IS NULL) = (ended_by IS NULL)),
  -- הסדר: נשלח ≤ הגיע ≤ נכנס ≤ סיים. "נכנס" בלי "הגיע" אינו קיים (הסימון קובע את שניהם).
  CONSTRAINT tech_dispatches_order CHECK (
        (arrived_at IS NULL OR arrived_at >= created_at)
    AND (entered_at IS NULL OR (arrived_at IS NOT NULL AND entered_at >= arrived_at))
    AND (ended_at IS NULL OR ended_at >= COALESCE(entered_at, arrived_at, created_at)))
);
-- שליחה פתוחה אחת לכל טכנאי. "אתר אחר" סוגר את הקודמת כ-moved באותה טרנזקציה.
CREATE UNIQUE INDEX IF NOT EXISTS ux_tech_dispatch_open ON tech_dispatches (technician_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_tech_dispatch_tech ON tech_dispatches (technician_id, created_at);
-- ⚠️ ה-FK ל-sites הוא ON DELETE SET NULL: בלי אינדקס, delete_site סורק את כל הטבלה (הלקח של 19/10 על operations).
CREATE INDEX IF NOT EXISTS ix_tech_dispatch_site ON tech_dispatches (site_id) WHERE site_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_tech_dispatch_ended ON tech_dispatches (ended_at) WHERE ended_at IS NOT NULL;

-- היומן: שורה לכל שינוי, עם מי עשה אותו ומאיפה הגיע (source). כ-300 שורות ביום.
-- ⚠️ תמונת המצב של הרכב (veh_*) — רק באבני הדרך של שליחה (נשלח / הגיע / נכנס / סיים), לא בהפסקה, בחופש או בסיום יום
-- (החלטה 6). ה-SQL מעתיק אותה מ-vehicles_live; הדפדפן לעולם לא שולח מיקום. הקואורדינטות והכתובת נמחקות אחרי 30 יום.
-- ⚠️ append-only: תיקון שעה הוא שורת correction חדשה (detail: mark, from, to), והשורה המקורית נשארת. הזמנים הקובעים הם
-- העמודות של tech_dispatches — הסיכום יקרא משם, לא מהיומן.
CREATE TABLE IF NOT EXISTS tech_log (
  id             bigserial PRIMARY KEY,
  technician_id  bigint NOT NULL REFERENCES technicians(id),
  at             timestamptz NOT NULL,     -- מתי זה קרה
  logged_at      timestamptz NOT NULL DEFAULT now(),   -- מתי זה נרשם (פער גדול = סומן בדיעבד)
  action         text NOT NULL,
  status_after   text,
  dispatch_id    bigint REFERENCES tech_dispatches(id) ON DELETE SET NULL,
  site_code      text,
  site_name      text,
  place          text,
  detail         jsonb,
  actor          text NOT NULL,
  actor_user_id  integer,
  source         text NOT NULL DEFAULT 'dispatcher',
  veh_plate      text,
  veh_lat        double precision,
  veh_lon        double precision,
  veh_located_at timestamptz,
  veh_state      text,
  veh_address    text,
  CONSTRAINT tech_log_action CHECK (action IN ('status', 'dispatch', 'arrived', 'entered', 'ended', 'vehicle', 'correction')),
  -- שלב 1 כותב רק dispatcher. השאר שמורים לשלבים הבאים (טכנאי בטלפון, GPS, הבקר באתר) — בלי מיגרציה כשיגיעו.
  CONSTRAINT tech_log_source CHECK (source IN ('dispatcher', 'self', 'gps', 'plc', 'system')),
  CONSTRAINT tech_log_status CHECK (status_after IS NULL OR status_after IN
    ('free', 'en_route', 'on_site', 'feedback', 'break', 'evening', 'vacation', 'day_done'))
);
CREATE INDEX IF NOT EXISTS ix_tech_log_at ON tech_log (at);
-- ⚠️ ה-FK לשליחה הוא ON DELETE SET NULL, והגריפה מוחקת שליחות ישנות — בלי אינדקס כל מחיקה סורקת את היומן.
CREATE INDEX IF NOT EXISTS ix_tech_log_dispatch ON tech_log (dispatch_id) WHERE dispatch_id IS NOT NULL;

-- סגורות: RLS בלי מדיניות, ובלי הרשאות לאף תפקיד של PostgREST (ברירת המחדל של Supabase מעניקה ALL לכל טבלה חדשה)
ALTER TABLE technicians ENABLE ROW LEVEL SECURITY;
ALTER TABLE tech_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE tech_log ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE r text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['technicians', 'tech_dispatches', 'tech_log'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
        EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM %I', pg_get_serial_sequence(t, 'id'), r);
      END IF;
    END LOOP;
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
  END LOOP;
END $$;

-- ============================================================
-- עזרים
-- ============================================================

-- שמונת המצבים, בסדר שלו: פנוי, בדרך לאתר, באתר, עובד במשוב, בהפסקה, עובד ערב, בחופש, סיים יום.
CREATE OR REPLACE FUNCTION app.tech_statuses()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$ SELECT ARRAY['free', 'en_route', 'on_site', 'feedback', 'break', 'evening', 'vacation', 'day_done']::text[] $$;

-- המצב של היום. מצב מיום קודם (בשעון ישראל) = "לא התחיל יום" (NULL) — חוץ מחופש, שנמשך, ומשליחה פתוחה, שהיא עובדה.
CREATE OR REPLACE FUNCTION app.tech_status_today(p_status text, p_at timestamptz, p_open boolean)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
           WHEN p_status IS NULL THEN NULL
           WHEN p_open OR p_status = 'vacation' THEN p_status
           WHEN (p_at AT TIME ZONE 'Asia/Jerusalem')::date = (now() AT TIME ZONE 'Asia/Jerusalem')::date THEN p_status
         END
$$;

-- הפיילוט (החלטה 8): 'all', או רשימת מיילים מופרדת בפסיקים — בלי רגישות לרווחים ולאותיות גדולות. בלי הגדרה = כבוי.
CREATE OR REPLACE FUNCTION app.tech_board_on()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
  SELECT COALESCE((
    SELECT lower(btrim(s.value)) = 'all'
        OR EXISTS (SELECT 1 FROM app_users u
                    WHERE u.id = app.current_app_user()
                      AND lower(btrim(u.email)) = ANY (SELECT lower(btrim(x)) FROM unnest(string_to_array(s.value, ',')) x))
      FROM settings s WHERE s.key = 'technicians_board'), false)
$$;
REVOKE ALL ON FUNCTION app.tech_board_on() FROM PUBLIC;

-- ⚠️ כל פונקציה שכותבת קוראת קודם ל-app.require_editor() בעצמה (המפקד ב-roles.test.js מחפש אותה בגוף הפונקציה), ואז לזו.
CREATE OR REPLACE FUNCTION app.tech_gate()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
BEGIN
  IF NOT app.tech_board_on() THEN
    RAISE EXCEPTION 'לוח הטכנאים אינו פעיל לחשבון הזה' USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$fn$;
REVOKE ALL ON FUNCTION app.tech_gate() FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.tech_iso(p timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$ SELECT to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') $$;

-- שעה מפורשת ("הגיע לפני 10 דק׳"), או עכשיו כשאין. הגבולות: לא בעתיד (דקה של סטיית שעון, ואז עכשיו), לא יותר מ-12 שעות
-- אחורה, ובין הרצפה לתקרה שהקורא נותן (למשל: לא לפני השליחה, ולא אחרי הכניסה). ההודעה אומרת מול מה.
CREATE OR REPLACE FUNCTION app.tech_when(p_at timestamptz, p_floor timestamptz, p_floor_what text,
                                         p_ceil timestamptz, p_ceil_what text)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
AS $fn$
DECLARE
  v timestamptz := LEAST(COALESCE(p_at, now()), now());
BEGIN
  IF p_at IS NOT NULL AND p_at > now() + interval '1 minute' THEN
    RAISE EXCEPTION 'השעה עוד לא הגיעה' USING ERRCODE = '22023';
  END IF;
  IF p_at IS NOT NULL AND p_at < now() - interval '12 hours' THEN
    RAISE EXCEPTION 'אפשר לסמן עד 12 שעות אחורה' USING ERRCODE = '22023';
  END IF;
  IF p_floor IS NOT NULL AND v < p_floor THEN
    RAISE EXCEPTION 'השעה מוקדמת מ% (%)', p_floor_what, to_char(p_floor AT TIME ZONE 'Asia/Jerusalem', 'HH24:MI')
      USING ERRCODE = '22023';
  END IF;
  IF p_ceil IS NOT NULL AND v > p_ceil THEN
    RAISE EXCEPTION 'השעה מאוחרת מ% (%)', p_ceil_what, to_char(p_ceil AT TIME ZONE 'Asia/Jerusalem', 'HH24:MI')
      USING ERRCODE = '22023';
  END IF;
  RETURN v;
END
$fn$;

-- שורה ביומן. ⚠️ תמונת הרכב רק כש-p_snapshot (אבני הדרך של שליחה); טכנאי בלי רכב, או רכב שאיתוראן הורידו — NULL-ים.
CREATE OR REPLACE FUNCTION app.tech_log_add(p_tech bigint, p_at timestamptz, p_action text, p_status_after text,
                                            p_dispatch bigint, p_detail jsonb, p_actor text, p_snapshot boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  t technicians;
  d tech_dispatches;
  v vehicles_live;
BEGIN
  SELECT * INTO t FROM technicians WHERE id = p_tech;
  IF p_dispatch IS NOT NULL THEN SELECT * INTO d FROM tech_dispatches WHERE id = p_dispatch; END IF;
  IF p_snapshot AND t.plate IS NOT NULL THEN SELECT * INTO v FROM vehicles_live WHERE license_plate = t.plate; END IF;
  INSERT INTO tech_log (technician_id, at, action, status_after, dispatch_id, site_code, site_name, place, detail,
                        actor, actor_user_id, source,
                        veh_plate, veh_lat, veh_lon, veh_located_at, veh_state, veh_address)
  -- המקור: הרכז, אלא אם מי שקרא קבע אחרת לטרנזקציה (app.tech_source): 'gps' ליציאה מהאתר, 'system' למשימה הבאה שהתחילה
  -- (21/10/2026). GUC ולא פרמטר: פרמטר נוסף היה יוצר חתימה שנייה לפונקציה שכולם קוראים לה.
  VALUES (p_tech, p_at, p_action, p_status_after, p_dispatch, d.site_code, d.site_name, d.place, p_detail,
          p_actor, app.current_app_user(), COALESCE(NULLIF(current_setting('app.tech_source', true), ''), 'dispatcher'),
          CASE WHEN p_snapshot THEN t.plate END, v.lat, v.lon, v.located_at,
          CASE WHEN v.license_plate IS NOT NULL THEN app.vehicle_state(v.motion, v.located_at, v.synced_at) END,
          v.address);
END
$fn$;
REVOKE ALL ON FUNCTION app.tech_log_add(bigint, timestamptz, text, text, bigint, jsonb, text, boolean) FROM PUBLIC;

-- טכנאי אחד כמו שהלוח מציג אותו: מצב, שליחה פתוחה, והרכב — דרך app.vehicle_json, אותו בונה של המפה (כללי המצב לא מתפצלים).
CREATE OR REPLACE FUNCTION app.tech_json(t technicians)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, app, pg_temp
AS $fn$
BEGIN
  -- ⚠️ plpgsql ולא sql: פונקציית sql עם FROM מתוכננת מחדש בכל קריאה, ו-38 קריאות בכל שאילתה של המסך עלו ~250 מ"ש (נמדד
  -- מקומית, 21/10/2026); plpgsql שומרת את התוכנית בין קריאות באותו חיבור.
  RETURN (  SELECT jsonb_build_object(
           'id', t.id, 'name', t.display_name, 'plate', t.plate, 'rev', t.rev,
           'status', t.status,
           'status_today', app.tech_status_today(t.status, t.status_at, d.id IS NOT NULL),
           'status_at', app.tech_iso(t.status_at), 'status_by', t.status_by,
           'dispatch', CASE WHEN d.id IS NOT NULL THEN jsonb_build_object(
               'id', d.id, 'site_id', d.site_id, 'site_code', d.site_code, 'site_name', d.site_name, 'place', d.place,
               'details', d.details, 'ticket', d.ticket,
               'created_at', app.tech_iso(d.created_at), 'created_by', d.created_by,
               'arrived_at', app.tech_iso(d.arrived_at), 'arrived_late', d.arrived_late,
               'entered_at', app.tech_iso(d.entered_at), 'entered_late', d.entered_late,
               -- הצפצוף (שלב 4): קיבל / כמה צפצופים / לכמה מכשירים הגיע / למה לא
               'acked_at', app.tech_iso(d.acked_at), 'push_count', d.push_count, 'push_last_at', app.tech_iso(d.push_last_at),
               'push_sent', d.push_sent, 'push_error', d.push_error, 'push_max', app.tech_push_max(),
               -- התחילה מ"המשימה הבאה" (21/10/2026) — המשימה שקדמה לה
               'follows', d.follows) END,
           -- המשימה הבאה בתור (לכל היותר אחת) — מתחילה כשהוא יוצא מהאתר של הנוכחית, או כשהנוכחית מסתיימת
           'next', (SELECT jsonb_build_object('site_code', n.site_code, 'site_name', n.site_name, 'place', n.place,
                                              'details', n.details, 'created_at', app.tech_iso(n.created_at),
                                              'created_by', n.created_by)
                      FROM tech_next n WHERE n.technician_id = t.id),
           -- הטלפון (שלב 2): paired = יש משתמש פעיל מקושר; seen_at = הטלפון פנה אלינו (עד אז ה-QR נוצר אבל לא נסרק)
           'phone', jsonb_build_object('paired', u.id IS NOT NULL AND u.is_active,
                                       'paired_at', app.tech_iso(t.phone_paired_at), 'paired_by', t.phone_paired_by,
                                       'seen_at', app.tech_iso(t.phone_seen_at),
                                       -- הטלפון הפעיל צפצוף (יש לו מנוי) — בלי זה שליחה לא תצפצף
                                       'push_ready', u.id IS NOT NULL AND u.is_active
                                                     AND EXISTS (SELECT 1 FROM tech_push_subs ps WHERE ps.app_user_id = u.id)),
           'vehicle', CASE WHEN v.license_plate IS NOT NULL THEN app.vehicle_json(v) END)
    FROM (SELECT 1) one
    LEFT JOIN tech_dispatches d ON d.technician_id = t.id AND d.ended_at IS NULL
    LEFT JOIN vehicles_live v ON v.license_plate = t.plate
    LEFT JOIN app_users u ON u.id = t.app_user_id
  );
END
$fn$;
REVOKE ALL ON FUNCTION app.tech_json(technicians) FROM PUBLIC;

-- ============================================================
-- הקריאה של הלוח — כל מי שמחובר (החלטה 2). jsonb אחד: בלי תקרת 1,000 השורות של PostgREST.
-- ============================================================
-- מי שלא בפיילוט מקבל {enabled: false} בלבד, והמסך מציג את המפה כמו היום. fleet = כל הרכבים (מספר וכינוי) — למסך הניהול
-- ולהצעות "רכבים בלי טכנאי". recent_places = המקומות החופשיים האחרונים (החלטה 5: "נזכר לפעם הבאה").
CREATE OR REPLACE FUNCTION public.tech_board()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
BEGIN
  PERFORM app.require_staff();
  IF NOT app.tech_board_on() THEN
    RETURN jsonb_build_object('enabled', false);
  END IF;
  RETURN jsonb_build_object(
    'enabled', true,
    'can_edit', app.can_edit(),
    'technicians', COALESCE((SELECT jsonb_agg(app.tech_json(t) ORDER BY t.display_name, t.id)
                               FROM technicians t WHERE t.is_active), '[]'::jsonb),
    'inactive', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.display_name, 'plate', t.plate,
                                                              'rev', t.rev) ORDER BY t.display_name, t.id)
                            FROM technicians t WHERE NOT t.is_active), '[]'::jsonb),
    'fleet', COALESCE((SELECT jsonb_agg(jsonb_build_object('plate', v.license_plate, 'name', v.nickname)
                                        ORDER BY v.license_plate)
                         FROM vehicles_live v), '[]'::jsonb),
    'recent_places', COALESCE((SELECT jsonb_agg(x.place ORDER BY x.last DESC)
                                 FROM (SELECT d.place, max(d.created_at) AS last
                                         FROM tech_dispatches d
                                        WHERE d.place IS NOT NULL AND d.created_at > now() - interval '90 days'
                                        GROUP BY d.place ORDER BY max(d.created_at) DESC LIMIT 12) x), '[]'::jsonb),
    'sync', (SELECT jsonb_build_object('last_ok_at', app.tech_iso(s.last_ok_at), 'last_error', s.last_error,
                                       'last_error_at', app.tech_iso(s.last_error_at))
               FROM vehicles_sync s WHERE s.id = 1),
    'now', app.tech_iso(now()));
END
$fn$;
REVOKE ALL ON FUNCTION public.tech_board() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tech_board() TO authenticated;

-- היומן של יום אחד בישראל (NULL = היום), החדש למעלה. late = נרשם יותר משתי דקות אחרי שקרה.
-- ⚠️ בלי קואורדינטות ובלי כתובת: הן נשמרות ללמידה של מיקומי האתרים (שלב 3), לא לתצוגה.
CREATE OR REPLACE FUNCTION public.tech_day(p_day date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_day  date := COALESCE(p_day, (now() AT TIME ZONE 'Asia/Jerusalem')::date);
  v_from timestamptz := v_day::timestamp AT TIME ZONE 'Asia/Jerusalem';
  v_to   timestamptz := (v_day + 1)::timestamp AT TIME ZONE 'Asia/Jerusalem';
BEGIN
  PERFORM app.require_staff();
  IF NOT app.tech_board_on() THEN
    RETURN jsonb_build_object('enabled', false);
  END IF;
  RETURN jsonb_build_object(
    'enabled', true,
    'day', to_char(v_day, 'YYYY-MM-DD'),
    'today', to_char((now() AT TIME ZONE 'Asia/Jerusalem')::date, 'YYYY-MM-DD'),
    'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                         'id', l.id, 'at', app.tech_iso(l.at), 'late', l.logged_at - l.at > interval '2 minutes',
                         'action', l.action, 'status_after', l.status_after,
                         'technician_id', l.technician_id, 'name', t.display_name,
                         'dispatch_id', l.dispatch_id, 'site_code', l.site_code, 'site_name', l.site_name,
                         'place', l.place, 'detail', l.detail, 'actor', l.actor)
                       ORDER BY l.at DESC, l.id DESC)
                        FROM tech_log l JOIN technicians t ON t.id = l.technician_id
                       WHERE l.at >= v_from AND l.at < v_to), '[]'::jsonb),
    'now', app.tech_iso(now()));
END
$fn$;
REVOKE ALL ON FUNCTION public.tech_day(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tech_day(date) TO authenticated;

-- ============================================================
-- הכתיבה — עורך או מנהל (החלטה 1), ורק מי שבפיילוט. כל אחת: require_editor, השער, נעילת שורת הטכנאי (FOR UPDATE), ושורת
-- audit עם מזהים בלבד (audit_log קריא לכל משתמש פעיל — בלי שמות).
-- ⚠️ סדר נעילה אחד בכל הפונקציות: קודם הטכנאי, אחר כך השליחה. בסדר הפוך שתי לחיצות במקביל היו נתקעות זו בזו.
-- ============================================================

-- הוספה (p_id NULL) או עריכה: שם, רכב, פעיל. רכב שמשתנה נרשם ביומן (vehicle) — זו ההיסטוריה של מי נסע על מה.
CREATE OR REPLACE FUNCTION public.tech_save(p_id bigint, p_name text, p_plate text, p_active boolean, p_rev integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_actor  text := app.require_editor();
  v_name   text := btrim(regexp_replace(COALESCE(p_name, ''), '\s+', ' ', 'g'));
  v_plate  text := NULLIF(btrim(regexp_replace(COALESCE(p_plate, ''), '\s+', ' ', 'g')), '');
  v_active boolean;
  v_other  text;
  t        technicians;
  v_fields text[] := ARRAY[]::text[];
BEGIN
  PERFORM app.tech_gate();
  IF length(v_name) < 2 OR length(v_name) > 60 THEN
    RAISE EXCEPTION 'שם הטכנאי: 2 עד 60 תווים' USING ERRCODE = '22023';
  END IF;
  IF v_plate IS NOT NULL AND length(v_plate) > 20 THEN
    RAISE EXCEPTION 'מספר הרכב ארוך מדי' USING ERRCODE = '22023';
  END IF;

  IF p_id IS NOT NULL THEN
    SELECT * INTO t FROM technicians WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'הטכנאי לא נמצא' USING ERRCODE = 'PT404'; END IF;
    IF p_rev IS NOT NULL AND t.rev <> p_rev THEN
      RAISE EXCEPTION 'הלוח השתנה בינתיים — טוען מחדש' USING ERRCODE = 'PT409';
    END IF;
  END IF;
  v_active := CASE WHEN p_id IS NULL THEN true ELSE COALESCE(p_active, t.is_active) END;

  IF p_id IS NOT NULL AND NOT v_active AND t.is_active
     AND EXISTS (SELECT 1 FROM tech_dispatches WHERE technician_id = t.id AND ended_at IS NULL) THEN
    RAISE EXCEPTION 'יש לטכנאי שליחה פתוחה — לסיים או לבטל אותה קודם' USING ERRCODE = 'PT409';
  END IF;
  IF v_active THEN
    IF EXISTS (SELECT 1 FROM technicians o WHERE o.is_active AND lower(o.display_name) = lower(v_name)
                                             AND o.id IS DISTINCT FROM p_id) THEN
      RAISE EXCEPTION 'כבר יש טכנאי פעיל בשם הזה' USING ERRCODE = 'PT409';
    END IF;
    SELECT o.display_name INTO v_other FROM technicians o
     WHERE o.is_active AND o.plate = v_plate AND o.id IS DISTINCT FROM p_id;
    IF v_other IS NOT NULL THEN
      RAISE EXCEPTION 'הרכב הזה כבר משויך ל%', v_other USING ERRCODE = 'PT409';
    END IF;
  END IF;

  IF p_id IS NULL THEN
    BEGIN
      INSERT INTO technicians (display_name, plate, created_by) VALUES (v_name, v_plate, v_actor) RETURNING * INTO t;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'כבר יש טכנאי פעיל עם השם או הרכב האלה' USING ERRCODE = 'PT409';
    END;
    IF v_plate IS NOT NULL THEN
      PERFORM app.tech_log_add(t.id, now(), 'vehicle', NULL, NULL, jsonb_build_object('from', NULL, 'to', v_plate),
                               v_actor, false);
    END IF;
    PERFORM app.record_write_audit('tech.add', v_actor, app.current_app_role(), 'technician', t.id::text, NULL);
    RETURN jsonb_build_object('id', t.id, 'rev', t.rev, 'changed', true);
  END IF;

  IF t.display_name IS DISTINCT FROM v_name THEN v_fields := v_fields || 'name'::text; END IF;
  IF t.plate IS DISTINCT FROM v_plate THEN v_fields := v_fields || 'plate'::text; END IF;
  IF t.is_active IS DISTINCT FROM v_active THEN v_fields := v_fields || 'active'::text; END IF;
  IF cardinality(v_fields) = 0 THEN
    RETURN jsonb_build_object('id', t.id, 'rev', t.rev, 'changed', false);
  END IF;

  BEGIN
    UPDATE technicians SET display_name = v_name, plate = v_plate, is_active = v_active, rev = rev + 1
     WHERE id = t.id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'כבר יש טכנאי פעיל עם השם או הרכב האלה' USING ERRCODE = 'PT409';
  END;
  IF 'plate' = ANY (v_fields) THEN
    PERFORM app.tech_log_add(t.id, now(), 'vehicle', NULL, NULL, jsonb_build_object('from', t.plate, 'to', v_plate),
                             v_actor, false);
  END IF;
  -- טכנאי שהושבת — גם הטלפון שלו (21/10/2026). בלי זה המשתמש היה נשאר פעיל, ו-QR מחדש אחרי החזרה היה מוצא קישור ישן.
  IF NOT v_active AND t.is_active AND t.app_user_id IS NOT NULL THEN
    UPDATE app_users SET is_active = false,
           disabled_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           disabled_by = app.current_app_user()
     WHERE id = t.app_user_id AND is_active;
    UPDATE technicians SET app_user_id = NULL, phone_paired_at = NULL, phone_paired_by = NULL, phone_seen_at = NULL
     WHERE id = t.id;
    DELETE FROM tech_push_subs WHERE app_user_id = t.app_user_id;
  END IF;
  -- טכנאי שהושבת — גם המשימה הבאה שלו (21/10/2026): היא לא תתחיל לעולם, ובחזרה היא כבר לא רלוונטית
  IF NOT v_active AND t.is_active THEN
    DELETE FROM tech_next WHERE technician_id = t.id;
  END IF;
  PERFORM app.record_write_audit('tech.save', v_actor, app.current_app_role(), 'technician', t.id::text,
                                 jsonb_build_object('fields', to_jsonb(v_fields)));
  RETURN jsonb_build_object('id', t.id, 'rev', t.rev + 1, 'changed', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.tech_save(bigint, text, text, boolean, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tech_save(bigint, text, text, boolean, integer) TO authenticated;

-- שינוי מצב: פנוי, משוב, הפסקה, ערב, חופש, סיים יום. ⚠️ "בדרך לאתר" ו"באתר" באים רק מהשליחה, ובזמן שליחה פתוחה אין שינוי
-- מצב בכלל — מסיימים או מבטלים אותה (tech_dispatch_end, עם המצב הבא). כך "בדרך" / "באתר" ⇔ יש שליחה פתוחה, תמיד; הפסקה
-- באמצע שליחה הייתה מחייבת "חזרה לשליחה" שאיש לא ביקש.
-- אותו מצב שוב (של היום) — כלום: בלי שורה, בלי audit, בלי rev. p_at = "לפני 10 דק׳": לא לפני המצב הנוכחי.
CREATE OR REPLACE FUNCTION public.tech_set_status(p_tech bigint, p_status text, p_at timestamptz, p_rev integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_actor text := app.require_editor();
  t       technicians;
  v_today text;
  v_at    timestamptz;
BEGIN
  PERFORM app.tech_gate();
  IF p_status IS NULL OR NOT (p_status = ANY (app.tech_statuses())) THEN
    RAISE EXCEPTION 'מצב לא מוכר' USING ERRCODE = '22023';
  END IF;
  IF p_status IN ('en_route', 'on_site') THEN
    RAISE EXCEPTION '"בדרך לאתר" ו"באתר" נקבעים מהשליחה' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO t FROM technicians WHERE id = p_tech FOR UPDATE;
  IF NOT FOUND OR NOT t.is_active THEN RAISE EXCEPTION 'הטכנאי לא נמצא' USING ERRCODE = 'PT404'; END IF;
  IF p_rev IS NOT NULL AND t.rev <> p_rev THEN
    RAISE EXCEPTION 'הלוח השתנה בינתיים — טוען מחדש' USING ERRCODE = 'PT409';
  END IF;
  IF EXISTS (SELECT 1 FROM tech_dispatches WHERE technician_id = t.id AND ended_at IS NULL) THEN
    RAISE EXCEPTION 'יש לטכנאי שליחה פתוחה — לסיים או לבטל אותה קודם' USING ERRCODE = 'PT409';
  END IF;
  v_today := app.tech_status_today(t.status, t.status_at, false);
  IF v_today IS NOT DISTINCT FROM p_status THEN
    RETURN jsonb_build_object('id', t.id, 'rev', t.rev, 'changed', false);
  END IF;
  v_at := app.tech_when(p_at, CASE WHEN v_today IS NOT NULL THEN t.status_at END, 'המצב הקודם', NULL, NULL);
  UPDATE technicians SET status = p_status, status_at = v_at, status_by = v_actor, rev = rev + 1 WHERE id = t.id;
  PERFORM app.tech_log_add(t.id, v_at, 'status', p_status, NULL, NULL, v_actor, false);
  PERFORM app.record_write_audit('tech.status', v_actor, app.current_app_role(), 'technician', t.id::text,
                                 jsonb_build_object('status', p_status));
  RETURN jsonb_build_object('id', t.id, 'rev', t.rev + 1, 'changed', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.tech_set_status(bigint, text, timestamptz, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tech_set_status(bigint, text, timestamptz, integer) TO authenticated;

-- שליחה לתקלה: אתר (לפי קוד) או מקום חופשי — אחד מהם — פרטי תקלה ומספר קריאה. ⚠️ שליחה פתוחה נסגרת כ"הועבר" באותה
-- טרנזקציה ("אתר אחר"). אותו client_id שוב (התשובה אבדה בדרך) מחזיר את מה שנוצר — ונבדק **אחרי** הנעילה, כדי ששתי
-- שליחות מקבילות של אותה בקשה לא ייצרו שתיים.
CREATE OR REPLACE FUNCTION public.tech_dispatch(p_tech bigint, p_site_code text, p_place text, p_details text,
                                               p_ticket text, p_client_id uuid, p_rev integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_actor   text := app.require_editor();
  v_code    text := NULLIF(btrim(COALESCE(p_site_code, '')), '');
  v_place   text := NULLIF(btrim(regexp_replace(COALESCE(p_place, ''), '\s+', ' ', 'g')), '');
  v_details text := NULLIF(btrim(COALESCE(p_details, '')), '');
  v_ticket  text := NULLIF(btrim(COALESCE(p_ticket, '')), '');
  t         technicians;
  s         sites;
  d         tech_dispatches;
  v_old     bigint;
BEGIN
  PERFORM app.tech_gate();
  IF p_client_id IS NULL THEN RAISE EXCEPTION 'חסר מזהה בקשה' USING ERRCODE = '22023'; END IF;
  SELECT * INTO t FROM technicians WHERE id = p_tech FOR UPDATE;
  IF NOT FOUND OR NOT t.is_active THEN RAISE EXCEPTION 'הטכנאי לא נמצא' USING ERRCODE = 'PT404'; END IF;

  SELECT * INTO d FROM tech_dispatches WHERE client_id = p_client_id;
  IF FOUND THEN
    IF d.technician_id <> t.id THEN
      RAISE EXCEPTION 'מזהה הבקשה כבר שימש לשליחה אחרת' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('id', t.id, 'dispatch_id', d.id, 'rev', t.rev, 'changed', false);
  END IF;

  IF p_rev IS NOT NULL AND t.rev <> p_rev THEN
    RAISE EXCEPTION 'הלוח השתנה בינתיים — טוען מחדש' USING ERRCODE = 'PT409';
  END IF;
  s := app.tech_dest_check(v_code, v_place, v_details, v_ticket);

  UPDATE tech_dispatches SET ended_at = now(), ended_by = v_actor, end_kind = 'moved'
   WHERE technician_id = t.id AND ended_at IS NULL
  RETURNING id INTO v_old;
  IF v_old IS NOT NULL THEN
    PERFORM app.tech_log_add(t.id, now(), 'ended', NULL, v_old, jsonb_build_object('end_kind', 'moved'), v_actor, false);
  END IF;

  -- היצירה, המצב "בדרך", היומן והצפצוף — app.tech_dispatch_create, אותו מסלול כמו המשימה הבאה כשהיא מתחילה (21/10/2026).
  -- ⚠️ המשימה הבאה (tech_next) נשארת בתור גם כשהנוכחית מוחלפת.
  d := app.tech_dispatch_create(t.id, p_client_id, s.id, s.code, s.site_name, v_place, v_details, v_ticket, v_actor, NULL);
  PERFORM app.record_write_audit('tech.dispatch', v_actor, app.current_app_role(), 'technician', t.id::text,
                                 jsonb_build_object('dispatch_id', d.id, 'site_code', s.code, 'moved_from', v_old));
  RETURN jsonb_build_object('id', t.id, 'dispatch_id', d.id, 'rev', t.rev + 1, 'changed', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.tech_dispatch(bigint, text, text, text, text, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tech_dispatch(bigint, text, text, text, text, uuid, integer) TO authenticated;

-- "הגיע" / "נכנס". הסימון הראשון קובע; לחיצה נוספת בלי שעה — כלום. שעה מפורשת על סימון קיים = תיקון (שורת correction
-- ביומן, והסימון מסומן "בדיעבד"). "הגיע" מעביר ל"באתר"; "נכנס" בלי "הגיע" קובע את שניהם באותה שעה.
CREATE OR REPLACE FUNCTION public.tech_dispatch_mark(p_dispatch bigint, p_mark text, p_at timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_actor text := app.require_editor();
  v_tech  bigint;
  t       technicians;
  d       tech_dispatches;
  v_at    timestamptz;
BEGIN
  PERFORM app.tech_gate();
  IF p_mark IS NULL OR p_mark NOT IN ('arrived', 'entered') THEN
    RAISE EXCEPTION 'סימון לא מוכר' USING ERRCODE = '22023';
  END IF;
  SELECT technician_id INTO v_tech FROM tech_dispatches WHERE id = p_dispatch;
  IF NOT FOUND THEN RAISE EXCEPTION 'השליחה לא נמצאה' USING ERRCODE = 'PT404'; END IF;
  SELECT * INTO t FROM technicians WHERE id = v_tech FOR UPDATE;
  SELECT * INTO d FROM tech_dispatches WHERE id = p_dispatch FOR UPDATE;
  IF d.ended_at IS NOT NULL THEN RAISE EXCEPTION 'השליחה כבר הסתיימה' USING ERRCODE = 'PT409'; END IF;

  IF p_mark = 'arrived' THEN
    IF d.arrived_at IS NULL THEN
      v_at := app.tech_when(p_at, d.created_at, 'השליחה', NULL, NULL);
      UPDATE tech_dispatches SET arrived_at = v_at, arrived_by = v_actor, arrived_late = (p_at IS NOT NULL) WHERE id = d.id;
      UPDATE technicians SET status = 'on_site', status_at = v_at, status_by = v_actor, rev = rev + 1 WHERE id = t.id;
      PERFORM app.tech_log_add(t.id, v_at, 'arrived', 'on_site', d.id, NULL, v_actor, true);
      PERFORM app.record_write_audit('tech.arrived', v_actor, app.current_app_role(), 'technician', t.id::text,
                                     jsonb_build_object('dispatch_id', d.id));
    ELSIF p_at IS NULL THEN
      RETURN jsonb_build_object('id', t.id, 'rev', t.rev, 'changed', false);
    ELSE
      v_at := app.tech_when(p_at, d.created_at, 'השליחה', d.entered_at, 'הכניסה');
      IF v_at = d.arrived_at THEN RETURN jsonb_build_object('id', t.id, 'rev', t.rev, 'changed', false); END IF;
      UPDATE tech_dispatches SET arrived_at = v_at, arrived_late = true WHERE id = d.id;
      -- "באתר מ-…" הולך עם ההגעה
      UPDATE technicians SET rev = rev + 1,
             status_at = CASE WHEN status = 'on_site' AND status_at = d.arrived_at THEN v_at ELSE status_at END
       WHERE id = t.id;
      PERFORM app.tech_log_add(t.id, now(), 'correction', NULL, d.id,
                               jsonb_build_object('mark', 'arrived', 'from', app.tech_iso(d.arrived_at),
                                                  'to', app.tech_iso(v_at)), v_actor, false);
      PERFORM app.record_write_audit('tech.correction', v_actor, app.current_app_role(), 'technician', t.id::text,
                                     jsonb_build_object('dispatch_id', d.id, 'mark', 'arrived'));
    END IF;
  ELSE
    IF d.entered_at IS NULL THEN
      IF d.arrived_at IS NULL THEN
        v_at := app.tech_when(p_at, d.created_at, 'השליחה', NULL, NULL);
        UPDATE tech_dispatches SET arrived_at = v_at, arrived_by = v_actor, arrived_late = (p_at IS NOT NULL)
         WHERE id = d.id;
        UPDATE technicians SET status = 'on_site', status_at = v_at, status_by = v_actor WHERE id = t.id;
        PERFORM app.tech_log_add(t.id, v_at, 'arrived', 'on_site', d.id, NULL, v_actor, false);
      ELSE
        v_at := app.tech_when(p_at, d.arrived_at, 'ההגעה', NULL, NULL);
      END IF;
      UPDATE tech_dispatches SET entered_at = v_at, entered_by = v_actor, entered_late = (p_at IS NOT NULL) WHERE id = d.id;
      UPDATE technicians SET rev = rev + 1 WHERE id = t.id;
      PERFORM app.tech_log_add(t.id, v_at, 'entered', NULL, d.id, NULL, v_actor, true);
      PERFORM app.record_write_audit('tech.entered', v_actor, app.current_app_role(), 'technician', t.id::text,
                                     jsonb_build_object('dispatch_id', d.id));
    ELSIF p_at IS NULL THEN
      RETURN jsonb_build_object('id', t.id, 'rev', t.rev, 'changed', false);
    ELSE
      v_at := app.tech_when(p_at, d.arrived_at, 'ההגעה', NULL, NULL);
      IF v_at = d.entered_at THEN RETURN jsonb_build_object('id', t.id, 'rev', t.rev, 'changed', false); END IF;
      UPDATE tech_dispatches SET entered_at = v_at, entered_late = true WHERE id = d.id;
      UPDATE technicians SET rev = rev + 1 WHERE id = t.id;
      PERFORM app.tech_log_add(t.id, now(), 'correction', NULL, d.id,
                               jsonb_build_object('mark', 'entered', 'from', app.tech_iso(d.entered_at),
                                                  'to', app.tech_iso(v_at)), v_actor, false);
      PERFORM app.record_write_audit('tech.correction', v_actor, app.current_app_role(), 'technician', t.id::text,
                                     jsonb_build_object('dispatch_id', d.id, 'mark', 'entered'));
    END IF;
  END IF;
  RETURN jsonb_build_object('id', t.id, 'rev', t.rev + 1, 'changed', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.tech_dispatch_mark(bigint, text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tech_dispatch_mark(bigint, text, timestamptz) TO authenticated;

-- סיום שליחה: done ("סיים") או cancelled ("ביטול"), והמצב הבא (ברירת המחדל: פנוי). אותו סיום שוב (לחיצה כפולה, שני
-- מסכים) — כלום; סיום אחר על שליחה שכבר הסתיימה — PT409.
CREATE OR REPLACE FUNCTION public.tech_dispatch_end(p_dispatch bigint, p_kind text, p_next_status text, p_at timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_actor text := app.require_editor();
  v_next  text := COALESCE(NULLIF(btrim(COALESCE(p_next_status, '')), ''), 'free');
  v_tech  bigint;
  t       technicians;
  d       tech_dispatches;
  v_at    timestamptz;
  v_started bigint;
BEGIN
  PERFORM app.tech_gate();
  IF p_kind IS NULL OR p_kind NOT IN ('done', 'cancelled') THEN
    RAISE EXCEPTION 'סיום לא מוכר' USING ERRCODE = '22023';
  END IF;
  IF NOT (v_next = ANY (app.tech_statuses())) OR v_next IN ('en_route', 'on_site') THEN
    RAISE EXCEPTION 'המצב אחרי הסיום אינו תקין' USING ERRCODE = '22023';
  END IF;
  SELECT technician_id INTO v_tech FROM tech_dispatches WHERE id = p_dispatch;
  IF NOT FOUND THEN RAISE EXCEPTION 'השליחה לא נמצאה' USING ERRCODE = 'PT404'; END IF;
  SELECT * INTO t FROM technicians WHERE id = v_tech FOR UPDATE;
  SELECT * INTO d FROM tech_dispatches WHERE id = p_dispatch FOR UPDATE;
  IF d.ended_at IS NOT NULL THEN
    IF d.end_kind = p_kind THEN RETURN jsonb_build_object('id', t.id, 'rev', t.rev, 'changed', false); END IF;
    RAISE EXCEPTION 'השליחה כבר הסתיימה' USING ERRCODE = 'PT409';
  END IF;
  v_at := app.tech_when(p_at, COALESCE(d.entered_at, d.arrived_at, d.created_at),
                        CASE WHEN d.entered_at IS NOT NULL THEN 'הכניסה'
                             WHEN d.arrived_at IS NOT NULL THEN 'ההגעה' ELSE 'השליחה' END, NULL, NULL);
  UPDATE tech_dispatches SET ended_at = v_at, ended_by = v_actor, ended_late = (p_at IS NOT NULL), end_kind = p_kind
   WHERE id = d.id;
  UPDATE technicians SET status = v_next, status_at = v_at, status_by = v_actor, rev = rev + 1 WHERE id = t.id;
  PERFORM app.tech_log_add(t.id, v_at, 'ended', v_next, d.id, jsonb_build_object('end_kind', p_kind), v_actor, true);
  PERFORM app.record_write_audit('tech.end', v_actor, app.current_app_role(), 'technician', t.id::text,
                                 jsonb_build_object('dispatch_id', d.id, 'end_kind', p_kind));
  -- המשימה הבאה מתחילה (21/10/2026) — אבל רק כשהטכנאי חוזר ל"פנוי": רכז שסיים עם "הפסקה" / "סיום יום" לא רוצה שהיא
  -- תצפצף עכשיו, והיא מחכה בתור.
  IF v_next = 'free' THEN
    v_started := app.tech_next_start(t.id, d.id, CASE p_kind WHEN 'done' THEN 'המשימה הסתיימה' ELSE 'המשימה בוטלה' END);
  END IF;
  RETURN jsonb_build_object('id', t.id, 'rev', (SELECT rev FROM technicians WHERE id = t.id), 'changed', true,
                            'next_started', v_started);
END
$fn$;
REVOKE ALL ON FUNCTION public.tech_dispatch_end(bigint, text, text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tech_dispatch_end(bigint, text, text, timestamptz) TO authenticated;

-- ============================================================
-- הטלפון של הטכנאי — שלב 2 של "צא ל:" (21/10/2026)
-- ============================================================
-- בעלת המוצר בחרה "סריקת QR מהכרטיס". לכל טכנאי משתמש משלו בתפקיד 'technician', שרואה רק את המשימה שלו: הוא לא
-- staff (is_staff), לא "משתמש פעיל" לקריאת הטבלות (is_active_user), ולא עורך. יצירת משתמש דורשת את ה-Secret key, ולכן
-- היא ב-Edge Function provision-technician — וכל ההחלטות כאן:
--   1. tech_phone_begin — בזהות הקורא: מי רשאי (עורך, בפיילוט), איזה טכנאי, ומספר חיבור חדש (phone_gen).
--   2. הפונקציה יוצרת משתמש tech-<id>-<gen>@parkomat.co.il עם סיסמה אקראית, ומחזירה אותה פעם אחת (בתוך ה-QR).
--   3. tech_phone_link — בזהות השירות בלבד: מקשרת את המשתמש החדש לטכנאי, ומשביתה את הקודם.
-- ⚠️ **משתמש חדש לכל QR, ולא סיסמה חדשה לאותו משתמש.** אסימון גישה נשאר תקף עד שעה גם אחרי החלפת סיסמה; רק משתמש
-- מושבת נסגר מיד (current_app_user דורש is_active). כך טלפון שאבד, או צילום של QR ישן, אינם פותחים דבר מהרגע שנוצר
-- QR חדש או שנלחץ "ניתוק טלפון".
-- ⚠️ קוד הכניסה במייל אינו חל על הטכנאי (login_code_applies — רק מנהל / עורך / בקר): אין לו תיבת מייל, וטלפון שממתין
-- לקוד הוא טלפון שלא יצפצף.

CREATE OR REPLACE FUNCTION app.tech_phone_email(p_tech bigint, p_gen integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$ SELECT 'tech-' || p_tech || '-' || p_gen || '@parkomat.co.il' $$;

-- איזה טכנאי הקורא הזה. NULL לכל מי שאינו טלפון מחובר של טכנאי פעיל — ⚠️ וכל מי שקורא לה מתייחס ל-NULL ככישלון
-- מפורש (כמו app.agent_site_id), לא כ"אין הגבלה".
CREATE OR REPLACE FUNCTION app.technician_id()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
  SELECT t.id FROM technicians t
   WHERE t.app_user_id = app.current_app_user()
     AND t.is_active
     AND app.current_app_role() = 'technician'
$$;
REVOKE ALL ON FUNCTION app.technician_id() FROM PUBLIC;

-- 1. בקשת QR (עורך, בפיילוט). מגדילה את מספר החיבור, ורושמת ב-audit מי ביקש — הפעולה של הרכז היא כאן.
-- ⚠️ rev אינו עולה כאן: רק החיבור עצמו (link) משנה את מה שהכרטיס מציג. בקשה שנכשלה בדרך משאירה מספר חיבור שלא נוצל.
CREATE OR REPLACE FUNCTION public.tech_phone_begin(p_tech bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_actor text := app.require_editor();
  t       technicians;
  v_old   uuid;
BEGIN
  PERFORM app.tech_gate();
  SELECT * INTO t FROM technicians WHERE id = p_tech FOR UPDATE;
  IF NOT FOUND OR NOT t.is_active THEN RAISE EXCEPTION 'הטכנאי לא נמצא' USING ERRCODE = 'PT404'; END IF;
  UPDATE technicians SET phone_gen = phone_gen + 1 WHERE id = t.id;
  SELECT u.supabase_uid INTO v_old FROM app_users u WHERE u.id = t.app_user_id;
  PERFORM app.record_write_audit('tech.phone_qr', v_actor, app.current_app_role(), 'technician', t.id::text,
                                 jsonb_build_object('gen', t.phone_gen + 1));
  RETURN jsonb_build_object('technician_id', t.id, 'name', t.display_name, 'gen', t.phone_gen + 1,
                            'email', app.tech_phone_email(t.id, t.phone_gen + 1), 'old_uid', v_old, 'actor', v_actor);
END
$fn$;
REVOKE ALL ON FUNCTION public.tech_phone_begin(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tech_phone_begin(bigint) TO authenticated;

-- 3. החיבור (שירות בלבד — אחרי שהפונקציה יצרה את המשתמש). ⚠️ רק המשתמש של מספר החיבור הנוכחי: QR שנוצר במקביל
-- (מספר גבוה יותר) מנצח, והישן נדחה ב-PT409 — הפונקציה מוחקת אז את המשתמש שיצרה.
CREATE OR REPLACE FUNCTION public.tech_phone_link(p_tech bigint, p_gen integer, p_uid uuid, p_actor text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  t     technicians;
  v_new app_users;
  v_old integer;
BEGIN
  SELECT * INTO t FROM technicians WHERE id = p_tech FOR UPDATE;
  IF NOT FOUND OR NOT t.is_active THEN RAISE EXCEPTION 'הטכנאי לא נמצא' USING ERRCODE = 'PT404'; END IF;
  IF p_gen IS NULL OR t.phone_gen <> p_gen THEN
    RAISE EXCEPTION 'נוצר בינתיים QR חדש לטכנאי הזה' USING ERRCODE = 'PT409';
  END IF;
  SELECT * INTO v_new FROM app_users WHERE supabase_uid = p_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'המשתמש של הטלפון לא נמצא' USING ERRCODE = 'PT404'; END IF;
  IF lower(v_new.email) <> app.tech_phone_email(t.id, p_gen) THEN
    RAISE EXCEPTION 'המשתמש אינו של החיבור הזה' USING ERRCODE = '22023';
  END IF;
  v_old := t.app_user_id;
  IF v_old IS NOT NULL AND v_old <> v_new.id THEN
    UPDATE app_users SET is_active = false,
           disabled_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
     WHERE id = v_old AND is_active;
    DELETE FROM tech_push_subs WHERE app_user_id = v_old;   -- הטלפון הקודם לא יצפצף יותר
  END IF;
  UPDATE app_users SET role = 'technician', is_active = true, full_name = t.display_name, site_id = NULL,
         disabled_at = NULL, disabled_by = NULL
   WHERE id = v_new.id;
  UPDATE technicians SET app_user_id = v_new.id, phone_paired_at = now(), phone_paired_by = NULLIF(btrim(p_actor), ''),
         phone_seen_at = NULL, rev = rev + 1
   WHERE id = t.id;
  RETURN jsonb_build_object('ok', true, 'technician_id', t.id, 'rev', t.rev + 1, 'replaced', v_old IS NOT NULL);
END
$fn$;
REVOKE ALL ON FUNCTION public.tech_phone_link(bigint, integer, uuid, text) FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.tech_phone_link(bigint, integer, uuid, text) TO service_role;
  END IF;
END $$;

-- ניתוק טלפון (עורך, בפיילוט): המשתמש מושבת — הטלפון נסגר מיד, גם עם אסימון תקף. QR חדש יוצר משתמש חדש.
CREATE OR REPLACE FUNCTION public.tech_phone_unpair(p_tech bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_actor text := app.require_editor();
  t       technicians;
BEGIN
  PERFORM app.tech_gate();
  SELECT * INTO t FROM technicians WHERE id = p_tech FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'הטכנאי לא נמצא' USING ERRCODE = 'PT404'; END IF;
  IF t.app_user_id IS NULL THEN RETURN jsonb_build_object('id', t.id, 'rev', t.rev, 'changed', false); END IF;
  UPDATE app_users SET is_active = false,
         disabled_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         disabled_by = app.current_app_user()
   WHERE id = t.app_user_id AND is_active;
  UPDATE technicians SET app_user_id = NULL, phone_paired_at = NULL, phone_paired_by = NULL, phone_seen_at = NULL,
         rev = rev + 1
   WHERE id = t.id;
  DELETE FROM tech_push_subs WHERE app_user_id = t.app_user_id;   -- והוא לא יצפצף יותר
  PERFORM app.record_write_audit('tech.phone_unpair', v_actor, app.current_app_role(), 'technician', t.id::text, NULL);
  RETURN jsonb_build_object('id', t.id, 'rev', t.rev + 1, 'changed', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.tech_phone_unpair(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tech_phone_unpair(bigint) TO authenticated;

-- מה הטלפון רואה: מי הוא, והמשימה הפתוחה — לאן (עם מיקום האתר, לניווט), מה, מתי ומי שלח. ⚠️ גם כותבת: "הטלפון נראה"
-- (phone_seen_at), לכל היותר פעם בדקה — כך הכרטיס יודע אם ה-QR נסרק ואם הטלפון עוד בחיים.
-- ⚠️ בלי שער הפיילוט: הוא שער לרכזים, וטכנאי קיים רק אם רכז בפיילוט חיבר אותו.
CREATE OR REPLACE FUNCTION public.tech_me()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_id bigint := app.technician_id();
  t    technicians;
  d    tech_dispatches;
  s    sites;
BEGIN
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'הטלפון אינו מחובר לטכנאי — יש לסרוק QR חדש מהכרטיס' USING ERRCODE = '42501';
  END IF;
  UPDATE technicians SET phone_seen_at = now()
   WHERE id = v_id AND (phone_seen_at IS NULL OR phone_seen_at < now() - interval '1 minute');
  SELECT * INTO t FROM technicians WHERE id = v_id;
  SELECT * INTO d FROM tech_dispatches WHERE technician_id = v_id AND ended_at IS NULL;
  IF d.site_id IS NOT NULL THEN SELECT * INTO s FROM sites WHERE id = d.site_id; END IF;
  RETURN jsonb_build_object(
    'id', t.id, 'name', t.display_name, 'plate', t.plate,
    'dispatch', CASE WHEN d.id IS NOT NULL THEN jsonb_build_object(
        'id', d.id, 'site_code', d.site_code, 'site_name', d.site_name, 'place', d.place, 'details', d.details,
        'created_at', app.tech_iso(d.created_at), 'created_by', d.created_by,
        'arrived_at', app.tech_iso(d.arrived_at), 'acked_at', app.tech_iso(d.acked_at), 'lat', s.lat, 'lon', s.lon,
        'follows', d.follows) END,
    -- המשימה הבאה (21/10/2026): הטכנאי רואה לאן ייסע אחרי זו. היא תתחיל לבד כשייצא מהאתר.
    'next', (SELECT jsonb_build_object('site_code', n.site_code, 'site_name', n.site_name, 'place', n.place, 'details', n.details)
               FROM tech_next n WHERE n.technician_id = t.id),
    'push_devices', (SELECT count(*)::int FROM tech_push_subs ps WHERE ps.app_user_id = t.app_user_id),
    'now', app.tech_iso(now()));
END
$fn$;
REVOKE ALL ON FUNCTION public.tech_me() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tech_me() TO authenticated;

-- "ניתוק הטלפון הזה" — מהטלפון עצמו (21/10/2026, בדיקת הבאגים). עד אז הטלפון רק מחק את הפרטים ויצא: המשתמש נשאר פעיל
-- ומקושר, המנוי לצפצוף נשאר, והטלפון המשיך לצפצף על כל משימה — והכרטיס אמר "צפצוף מופעל". עכשיו כמו "ניתוק טלפון" בכרטיס:
-- המנויים נמחקים, הקישור נמחק, והמשתמש מושבת. ⚠️ בלי שער הפיילוט (כמו tech_me) — ניתוק אסור שייחסם. טלפון שכבר מנותק — לא שגיאה.
CREATE OR REPLACE FUNCTION public.tech_self_unpair()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_tech bigint := app.technician_id();
  v_user integer := app.current_app_user();
BEGIN
  IF v_tech IS NULL OR v_user IS NULL THEN RETURN jsonb_build_object('changed', false); END IF;
  PERFORM 1 FROM technicians WHERE id = v_tech FOR UPDATE;
  DELETE FROM tech_push_subs WHERE app_user_id = v_user;
  UPDATE technicians SET app_user_id = NULL, phone_paired_at = NULL, phone_paired_by = NULL, phone_seen_at = NULL, rev = rev + 1
   WHERE id = v_tech AND app_user_id = v_user;
  UPDATE app_users SET is_active = false,
         disabled_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         disabled_by = v_user
   WHERE id = v_user AND is_active;
  PERFORM app.record_write_audit('tech.phone_self_unpair', 'טלפון של טכנאי', 'technician', 'technician', v_tech::text, NULL);
  RETURN jsonb_build_object('changed', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.tech_self_unpair() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tech_self_unpair() TO authenticated;

-- ============================================================
-- הצפצוף — שלב 4 של "צא ל:" (21/10/2026)
-- ============================================================
-- בעלת המוצר: "בסופו של דבר אני רוצה שזה יצפצף לאותו טכנאי", ובחרה: Web Push (התקנה מ-Chrome), צפצוף חוזר כל 2 דקות
-- עד 3 פעמים עד "קיבלתי". כל ההחלטות כאן; ה-Edge Function ‏notify-tech רק שולחת:
--   1. tech_dispatch → app.tech_push_request: net.http_post ל-notify-tech (אחרי ה-commit), עם הסוד המשותף של ה-push.
--   2. notify-tech → tech_push_claim (שירות בלבד): האם לשלוח (פתוחה, לא אושרה, פחות מ-3, לא לפני 90 שניות), למי (המנויים
--      של הטלפון של הטכנאי) ומה — וסופרת את הניסיון.
--   3. notify-tech שולחת לכל מנוי → tech_push_result: כמה הגיעו, ומנויים שנעלמו (410/404) נמחקים.
--   4. pg_cron כל דקה → app.tech_push_repeat: שליחה פתוחה שלא אושרה, 2 דקות אחרי הצפצוף הקודם, עד 3.
--   5. הטכנאי לוחץ "קיבלתי" → tech_self_ack: acked_at — הצפצוף נעצר, והכרטיס אצל הרכז אומר "קיבל".
-- ⚠️ צפצוף שנכשל לעולם אינו מכשיל שליחה: הבקשה בתוך EXCEPTION, והשגיאה נרשמת ב-push_error ומוצגת בכרטיס.
-- ⚠️ טבלת מנויים משלו (tech_push_subs) ולא push_subscriptions של התראות התקלות: זו נוצרה רק במיגרציה של Supabase (apply-sql
-- אינו רואה אותה, וגם לא הבדיקות), ומדיניות ה-RLS שלה פתוחה למשתמשים פעילים — שהטלפון של טכנאי אינו.

ALTER TABLE tech_dispatches ADD COLUMN IF NOT EXISTS acked_at timestamptz;          -- "קיבלתי" בטלפון
ALTER TABLE tech_dispatches ADD COLUMN IF NOT EXISTS push_count integer NOT NULL DEFAULT 0;
ALTER TABLE tech_dispatches ADD COLUMN IF NOT EXISTS push_last_at timestamptz;      -- מתי נשלח הצפצוף האחרון
ALTER TABLE tech_dispatches ADD COLUMN IF NOT EXISTS push_sent integer;             -- לכמה מכשירים הוא הגיע
ALTER TABLE tech_dispatches ADD COLUMN IF NOT EXISTS push_error text;               -- למה לא (מוצג לרכז)
-- ⚠️ 21/10/2026 (בדיקת הבאגים): כמה בקשות יצאו ל-notify-tech, ומתי האחרונה. push_count נספר רק אחרי claim — פונקציה שלא
-- ענתה (סוד שגוי, לא פרוסה, נפלה) השאירה אותו 0, והתזכורת שלחה בקשה כל דקה בלי סוף, בלי שגיאה בכרטיס.
ALTER TABLE tech_dispatches ADD COLUMN IF NOT EXISTS push_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE tech_dispatches ADD COLUMN IF NOT EXISTS push_requested_at timestamptz;

CREATE TABLE IF NOT EXISTS tech_push_subs (
  id          bigserial PRIMARY KEY,
  app_user_id integer NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  endpoint    text NOT NULL UNIQUE,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tech_push_subs_shape CHECK (endpoint ~ '^https://' AND length(endpoint) <= 1000
                                         AND length(p256dh) BETWEEN 20 AND 200 AND length(auth) BETWEEN 8 AND 100)
);
CREATE INDEX IF NOT EXISTS ix_tech_push_subs_user ON tech_push_subs (app_user_id);
ALTER TABLE tech_push_subs ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON tech_push_subs FROM %I', r);
      EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM %I', pg_get_serial_sequence('tech_push_subs', 'id'), r);
    END IF;
  END LOOP;
  REVOKE ALL ON tech_push_subs FROM PUBLIC;
END $$;

CREATE OR REPLACE FUNCTION app.tech_push_max() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 3 $$;
CREATE OR REPLACE FUNCTION app.tech_push_every() RETURNS interval LANGUAGE sql IMMUTABLE AS $$ SELECT interval '2 minutes' $$;
-- תקרת בקשות לשליחה אחת: 3 צפצופים ועוד 2 ניסיונות לפונקציה שלא ענתה
CREATE OR REPLACE FUNCTION app.tech_push_attempts_max() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 5 $$;

-- הבקשה ל-notify-tech. ⚠️ net.http_post נשלח רק אחרי ה-commit (pg_net), כך שהפונקציה רואה את השליחה. בלי סוד או מפתח —
-- הצפצוף לא נשלח, והכרטיס אומר למה (לא שקט).
CREATE OR REPLACE FUNCTION app.tech_push_request(p_dispatch bigint)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_secret text := (SELECT value FROM settings WHERE key = 'push_caller_secret');
  v_key    text := (SELECT value FROM settings WHERE key = 'push_anon_key');
BEGIN
  -- כל בקשה נספרת (גם כשהצפצוף אינו מוגדר) — כך לתזכורת יש תקרה גם כשהפונקציה לא עונה
  UPDATE tech_dispatches SET push_attempts = push_attempts + 1, push_requested_at = now() WHERE id = p_dispatch;
  IF COALESCE(btrim(v_secret), '') = '' OR COALESCE(btrim(v_key), '') = '' THEN
    UPDATE tech_dispatches SET push_error = 'הצפצוף אינו מוגדר במערכת' WHERE id = p_dispatch;
    RETURN NULL;
  END IF;
  RETURN net.http_post(
    url     := 'https://xvfsikwaaaohnmldjbtv.supabase.co/functions/v1/notify-tech',
    body    := jsonb_build_object('dispatch_id', p_dispatch),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || btrim(v_key),
      'x-parkomat-push-secret', btrim(v_secret)),
    timeout_milliseconds := 20000);
END
$fn$;
REVOKE ALL ON FUNCTION app.tech_push_request(bigint) FROM PUBLIC;

-- המנוי של הטלפון (הטכנאי בלבד): אותו endpoint שוב — מתעדכן (המפתחות מתחלפים כשהדפדפן מחדש מנוי).
CREATE OR REPLACE FUNCTION public.tech_push_subscribe(p_endpoint text, p_p256dh text, p_auth text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_tech bigint := app.technician_id();
  v_user integer := app.current_app_user();
  v_n    integer;
BEGIN
  IF v_tech IS NULL THEN
    RAISE EXCEPTION 'הטלפון אינו מחובר לטכנאי — יש לסרוק QR חדש מהכרטיס' USING ERRCODE = '42501';
  END IF;
  IF p_endpoint IS NULL OR p_endpoint !~ '^https://' OR length(p_endpoint) > 1000
     OR length(COALESCE(p_p256dh, '')) NOT BETWEEN 20 AND 200 OR length(COALESCE(p_auth, '')) NOT BETWEEN 8 AND 100 THEN
    RAISE EXCEPTION 'המנוי של הטלפון אינו תקין' USING ERRCODE = '22023';
  END IF;
  INSERT INTO tech_push_subs (app_user_id, endpoint, p256dh, auth)
  VALUES (v_user, p_endpoint, p_p256dh, p_auth)
  ON CONFLICT (endpoint) DO UPDATE SET app_user_id = EXCLUDED.app_user_id, p256dh = EXCLUDED.p256dh,
                                       auth = EXCLUDED.auth, created_at = now();
  SELECT count(*)::int INTO v_n FROM tech_push_subs WHERE app_user_id = v_user;
  RETURN jsonb_build_object('ok', true, 'devices', v_n);
END
$fn$;
REVOKE ALL ON FUNCTION public.tech_push_subscribe(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tech_push_subscribe(text, text, text) TO authenticated;

-- 2. האם לשלוח, למי ומה (שירות בלבד). ⚠️ "לא לפני 90 שניות" עוצר בקשה כפולה (שליחה + תזכורת באותה דקה), לא את התזכורת.
-- טלפון שלא הפעיל צפצוף — לא נספר כניסיון: אין מה לחזור עליו, והכרטיס אומר "הטלפון לא הפעיל צפצוף".
CREATE OR REPLACE FUNCTION public.tech_push_claim(p_dispatch bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  d      tech_dispatches;
  v_subs jsonb;
  v_n    integer;
  v_dest text;
BEGIN
  SELECT * INTO d FROM tech_dispatches WHERE id = p_dispatch FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('send', false, 'reason', 'gone'); END IF;
  IF d.ended_at IS NOT NULL THEN RETURN jsonb_build_object('send', false, 'reason', 'ended'); END IF;
  IF d.acked_at IS NOT NULL THEN RETURN jsonb_build_object('send', false, 'reason', 'acked'); END IF;
  -- הרכז סימן "הגיע" — הטכנאי כבר באתר, אין על מה לצפצף (21/10/2026, בדיקת הבאגים)
  IF d.arrived_at IS NOT NULL THEN RETURN jsonb_build_object('send', false, 'reason', 'arrived'); END IF;
  IF d.push_count >= app.tech_push_max() THEN RETURN jsonb_build_object('send', false, 'reason', 'max'); END IF;
  IF d.push_last_at IS NOT NULL AND d.push_last_at > now() - interval '90 seconds' THEN
    RETURN jsonb_build_object('send', false, 'reason', 'recent');
  END IF;
  SELECT jsonb_agg(jsonb_build_object('id', s.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth) ORDER BY s.id)
    INTO v_subs
    FROM technicians t
    JOIN app_users u ON u.id = t.app_user_id AND u.is_active AND u.role = 'technician'
    JOIN tech_push_subs s ON s.app_user_id = u.id
   WHERE t.id = d.technician_id AND t.is_active;
  IF v_subs IS NULL THEN
    UPDATE tech_dispatches SET push_error = 'הטלפון של הטכנאי לא הפעיל צפצוף' WHERE id = d.id;
    RETURN jsonb_build_object('send', false, 'reason', 'no_phone');
  END IF;
  v_n := d.push_count + 1;
  UPDATE tech_dispatches SET push_count = v_n, push_last_at = now(), push_error = NULL WHERE id = d.id;
  v_dest := CASE WHEN d.site_code IS NOT NULL THEN COALESCE(d.site_name, d.site_code) || ' · ' || d.site_code ELSE d.place END;
  RETURN jsonb_build_object(
    'send', true, 'n', v_n, 'dispatch_id', d.id,
    -- "המשימה הבאה:" — כשהשליחה התחילה מהתור, אחרי שיצא מהאתר הקודם (21/10/2026)
    'title', CASE WHEN v_n > 1 THEN 'תזכורת — משימה ממתינה: '
                  WHEN d.follows IS NOT NULL THEN 'המשימה הבאה: ' ELSE 'משימה חדשה: ' END || v_dest,
    'body', COALESCE(left(regexp_replace(d.details, '\s+', ' ', 'g'), 180), 'לפתוח את האפליקציה ולאשר קבלה'),
    'tag', 'dispatch-' || d.id,
    'subs', v_subs);
END
$fn$;
REVOKE ALL ON FUNCTION public.tech_push_claim(bigint) FROM PUBLIC, anon, authenticated;

-- 3. מה קרה בשליחה (שירות בלבד): לכמה הגיע, ומנויים שנעלמו — נמחקים (רק של הטכנאי של השליחה הזו).
CREATE OR REPLACE FUNCTION public.tech_push_result(p_dispatch bigint, p_sent integer, p_dead bigint[], p_error text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_user integer;
  v_del  integer := 0;
BEGIN
  SELECT t.app_user_id INTO v_user FROM tech_dispatches d JOIN technicians t ON t.id = d.technician_id WHERE d.id = p_dispatch;
  UPDATE tech_dispatches
     SET push_sent = GREATEST(COALESCE(p_sent, 0), 0),
         push_error = CASE WHEN COALESCE(p_sent, 0) > 0 THEN NULL
                           ELSE left(COALESCE(NULLIF(btrim(p_error), ''), 'הצפצוף לא הגיע לטלפון'), 200) END
   WHERE id = p_dispatch;
  IF v_user IS NOT NULL AND p_dead IS NOT NULL AND cardinality(p_dead) > 0 THEN
    DELETE FROM tech_push_subs WHERE id = ANY (p_dead) AND app_user_id = v_user;
    GET DIAGNOSTICS v_del = ROW_COUNT;
  END IF;
  RETURN jsonb_build_object('ok', true, 'removed', v_del);
END
$fn$;
REVOKE ALL ON FUNCTION public.tech_push_result(bigint, integer, bigint[], text) FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.tech_push_claim(bigint) TO service_role;
    GRANT EXECUTE ON FUNCTION public.tech_push_result(bigint, integer, bigint[], text) TO service_role;
  END IF;
END $$;

-- 4. התזכורת (pg_cron כל דקה): שליחה פתוחה שלא אושרה, שעברו 2 דקות מהצפצוף הקודם (או מהשליחה, אם הראשון לא יצא),
-- פחות מ-3 צפצופים, ושלטכנאי יש מנוי. ⚠️ כל בקשה בתוך EXCEPTION — אחת שנכשלה לא עוצרת את האחרות.
CREATE OR REPLACE FUNCTION app.tech_push_repeat()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  r   record;
  v_n integer := 0;
BEGIN
  -- בקשה שיצאה לפני 90 שניות ואף claim לא בא אחריה — הפונקציה לא ענתה. הכרטיס אומר זאת (עד 21/10 נשאר "שולח צפצוף…").
  UPDATE tech_dispatches d SET push_error = 'שירות הצפצוף לא ענה — הצפצוף לא נשלח'
   WHERE d.ended_at IS NULL AND d.push_error IS NULL
     AND d.push_requested_at IS NOT NULL AND d.push_requested_at <= now() - interval '90 seconds'
     AND (d.push_last_at IS NULL OR d.push_last_at < d.push_requested_at);
  FOR r IN
    SELECT d.id FROM tech_dispatches d
      JOIN technicians t ON t.id = d.technician_id AND t.is_active
     WHERE d.ended_at IS NULL AND d.acked_at IS NULL AND d.arrived_at IS NULL
       AND d.push_count < app.tech_push_max()
       AND d.push_attempts < app.tech_push_attempts_max()
       -- ⚠️ ה-claim חותם את push_last_at שנייה-שתיים אחרי תחילת הדקה, ולכן "2 דקות" בדיוק יצאו 118 שניות ונדחו לדקה
       -- הבאה (צפצופים ב-0, 2.5, 5.5 דקות). 20 שניות סובלנות; כפילות עוצר ה-claim (90 שניות).
       AND COALESCE(GREATEST(d.push_last_at, d.push_requested_at), d.created_at)
           <= now() - app.tech_push_every() + interval '20 seconds'
       AND EXISTS (SELECT 1 FROM tech_push_subs s JOIN app_users u ON u.id = s.app_user_id AND u.is_active
                    WHERE s.app_user_id = t.app_user_id)
  LOOP
    BEGIN
      PERFORM app.tech_push_request(r.id);
      v_n := v_n + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE tech_dispatches SET push_error = left('התזכורת לא נשלחה: ' || SQLERRM, 200) WHERE id = r.id;
    END;
  END LOOP;
  RETURN v_n;
END
$fn$;
REVOKE ALL ON FUNCTION app.tech_push_repeat() FROM PUBLIC;

-- 5. "קיבלתי" (הטכנאי, על השליחה שלו בלבד). פעם שנייה — כלום. שליחה שהסתיימה — PT409.
CREATE OR REPLACE FUNCTION public.tech_self_ack(p_dispatch bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_tech bigint := app.technician_id();
  d      tech_dispatches;
BEGIN
  IF v_tech IS NULL THEN
    RAISE EXCEPTION 'הטלפון אינו מחובר לטכנאי — יש לסרוק QR חדש מהכרטיס' USING ERRCODE = '42501';
  END IF;
  -- ⚠️ קודם הטכנאי, אחר כך השליחה — הסדר של כל הכותבים (ראה למעלה). בסדר ההפוך, "קיבלתי" ברגע שהרכז לוחץ "סיום" או
  -- "הגיע" נתקעו זה בזה, ואחד מהם קיבל 40P01 (נמצא בבדיקת הבאגים, 21/10/2026).
  PERFORM 1 FROM technicians WHERE id = v_tech FOR UPDATE;
  SELECT * INTO d FROM tech_dispatches WHERE id = p_dispatch AND technician_id = v_tech FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'המשימה לא נמצאה' USING ERRCODE = 'PT404'; END IF;
  IF d.ended_at IS NOT NULL THEN RAISE EXCEPTION 'המשימה כבר הסתיימה' USING ERRCODE = 'PT409'; END IF;
  IF d.acked_at IS NOT NULL THEN
    RETURN jsonb_build_object('changed', false, 'acked_at', app.tech_iso(d.acked_at));
  END IF;
  UPDATE tech_dispatches SET acked_at = now() WHERE id = d.id;
  UPDATE technicians SET rev = rev + 1 WHERE id = v_tech;
  -- ⚠️ שם קבוע ולא שם הטכנאי: היומן — מזהים בלבד (ראה למעלה)
  PERFORM app.record_write_audit('tech.ack', 'טלפון של טכנאי', 'technician', 'technician', v_tech::text,
                                 jsonb_build_object('dispatch_id', d.id));
  RETURN jsonb_build_object('changed', true, 'acked_at', app.tech_iso(now()));
END
$fn$;
REVOKE ALL ON FUNCTION public.tech_self_ack(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tech_self_ack(bigint) TO authenticated;

-- ============================================================
-- הגריפה (החלטה 7, ו-6 לקואורדינטות) — מ-pg_cron ב-cron.postgres.sql, פעם ביום.
-- ============================================================
-- ⚠️ קודם מוחקים את המיקום מהשורות שעברו 30 יום, ואז את מה שעבר 90. שליחה פתוחה לא נמחקת בשום גיל.
CREATE OR REPLACE FUNCTION app.prune_technicians(p_keep interval DEFAULT interval '90 days',
                                                 p_coords interval DEFAULT interval '30 days')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  n_coords integer;
  n_log    integer;
  n_disp   integer;
BEGIN
  UPDATE tech_log SET veh_lat = NULL, veh_lon = NULL, veh_address = NULL
   WHERE at < now() - p_coords AND (veh_lat IS NOT NULL OR veh_lon IS NOT NULL OR veh_address IS NOT NULL);
  GET DIAGNOSTICS n_coords = ROW_COUNT;
  DELETE FROM tech_log WHERE at < now() - p_keep;
  GET DIAGNOSTICS n_log = ROW_COUNT;
  DELETE FROM tech_dispatches WHERE ended_at < now() - p_keep;
  GET DIAGNOSTICS n_disp = ROW_COUNT;
  RETURN jsonb_build_object('coords', n_coords, 'log', n_log, 'dispatches', n_disp);
END
$fn$;
REVOKE ALL ON FUNCTION app.prune_technicians(interval, interval) FROM PUBLIC;

-- ============================================================
-- המשימה הבאה (21/10/2026)
-- ============================================================
-- הבעלת: "כשהוא יוצא מהאתר, אם יש לו משימה נוספת שהקצו לו, שיתזכר אותו לאיפה הוא צריך לנסוע למשימה הבאה". בחירותיה:
-- **רק משימה באה אחת** (באה חדשה מחליפה את הקודמת), ו**הבאה מתחילה לבד**: כשהרכב שלו יוצא מהאתר של המשימה הנוכחית,
-- הנוכחית נסגרת ("יצא מהאתר"), הבאה הופכת לשליחה רגילה, והטלפון מצפצף "המשימה הבאה: X" — עם ניווט ו"קיבלתי".
-- ⚠️ "יצא" = ביקור באתר של המשימה (vehicle_visits, נרשמים בכל סנכרון) שנגמר אחרי שהמשימה נשלחה, לפני 2 דקות לפחות, ואין
-- עכשיו ביקור פתוח שם. מי שנסע רגע להביא חלק — המשימה נסגרה מוקדם; זה הסיכון שהבעלת בחרה.
-- ⚠️ גם סיום ידני של הנוכחית (סיום / ביטול, כשהטכנאי חוזר ל"פנוי") מתחיל את הבאה — אחרת משימה ל"מקום אחר", שאין לה אתר
-- ולכן אין יציאה, הייתה תוקעת אותה. החלפת הנוכחית ("החלפה ושליחה") משאירה את הבאה בתור.
-- טבלה נפרדת ולא שורה ב-tech_dispatches: "שליחה פתוחה אחת לכל טכנאי" (ux_tech_dispatch_open), הצפצוף ו"קיבלתי" נשארים
-- כמו שהם — המשימה הבאה הופכת לשליחה רק כשהיא מתחילה (app.tech_next_start).
CREATE TABLE IF NOT EXISTS tech_next (
  technician_id bigint PRIMARY KEY REFERENCES technicians(id),
  client_id     uuid NOT NULL UNIQUE,      -- של הטיוטה; כשהבאה מתחילה הוא עובר לשליחה, וכך בקשה חוזרת מזוהה גם אחרי
  site_id       integer REFERENCES sites(id) ON DELETE SET NULL,
  site_code     text,
  site_name     text,
  place         text,
  details       text,
  ticket        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text NOT NULL,
  CONSTRAINT tech_next_dest CHECK ((site_code IS NULL) <> (place IS NULL))
);
-- ⚠️ ה-FK ל-sites הוא ON DELETE SET NULL: בלי אינדקס, delete_site סורק את הטבלה
CREATE INDEX IF NOT EXISTS ix_tech_next_site ON tech_next (site_id) WHERE site_id IS NOT NULL;
ALTER TABLE tech_next ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON tech_next FROM PUBLIC, anon, authenticated;
-- השליחה שקדמה לזו, כשזו התחילה מ"המשימה הבאה" — הכותרת בטלפון "המשימה הבאה:". ⚠️ הגריפה מוחקת שליחות ישנות → אינדקס.
ALTER TABLE tech_dispatches ADD COLUMN IF NOT EXISTS follows bigint REFERENCES tech_dispatches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_tech_dispatch_follows ON tech_dispatches (follows) WHERE follows IS NOT NULL;

-- היעד של שליחה או של משימה באה — אותם כללים בשני המקומות. מחזיר את האתר (שורה ריקה למקום שאינו אתר).
CREATE OR REPLACE FUNCTION app.tech_dest_check(p_code text, p_place text, p_details text, p_ticket text)
RETURNS sites
LANGUAGE plpgsql
STABLE
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  s sites;
BEGIN
  IF (p_code IS NULL) = (p_place IS NULL) THEN
    RAISE EXCEPTION 'יש לבחור אתר, או לכתוב מקום שאינו אתר — אחד מהם' USING ERRCODE = '22023';
  END IF;
  IF p_place IS NOT NULL AND (length(p_place) < 2 OR length(p_place) > 80) THEN
    RAISE EXCEPTION 'המקום: 2 עד 80 תווים' USING ERRCODE = '22023';
  END IF;
  IF p_details IS NOT NULL AND length(p_details) > 500 THEN
    RAISE EXCEPTION 'פרטי התקלה: עד 500 תווים' USING ERRCODE = '22023';
  END IF;
  IF p_ticket IS NOT NULL AND length(p_ticket) > 40 THEN
    RAISE EXCEPTION 'מספר הקריאה ארוך מדי' USING ERRCODE = '22023';
  END IF;
  IF p_code IS NOT NULL THEN
    SELECT * INTO s FROM sites WHERE code = p_code;
    IF NOT FOUND THEN RAISE EXCEPTION 'האתר לא נמצא: %', p_code USING ERRCODE = 'PT404'; END IF;
  END IF;
  RETURN s;
END
$fn$;
REVOKE ALL ON FUNCTION app.tech_dest_check(text, text, text, text) FROM PUBLIC;

-- יצירת שליחה: השורה, "בדרך", היומן והצפצוף. ⚠️ הקורא נעל את הטכנאי (FOR UPDATE) וסגר שליחה פתוחה קודם. הצפצוף בתוך
-- EXCEPTION: צפצוף שנכשל לא מכשיל שליחה — הסיבה נרשמת ומוצגת בכרטיס.
CREATE OR REPLACE FUNCTION app.tech_dispatch_create(p_tech bigint, p_client uuid, p_site_id integer, p_site_code text,
                                                    p_site_name text, p_place text, p_details text, p_ticket text,
                                                    p_actor text, p_follows bigint)
RETURNS tech_dispatches
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  d tech_dispatches;
BEGIN
  INSERT INTO tech_dispatches (client_id, technician_id, site_id, site_code, site_name, place, details, ticket, created_by, follows)
  VALUES (p_client, p_tech, p_site_id, p_site_code, p_site_name, p_place, p_details, p_ticket, p_actor, p_follows)
  RETURNING * INTO d;
  UPDATE technicians SET status = 'en_route', status_at = now(), status_by = p_actor, rev = rev + 1 WHERE id = p_tech;
  PERFORM app.tech_log_add(p_tech, now(), 'dispatch', 'en_route', d.id,
                           CASE WHEN p_follows IS NOT NULL THEN jsonb_build_object('follows', p_follows) END, p_actor, true);
  BEGIN
    PERFORM app.tech_push_request(d.id);
  EXCEPTION WHEN OTHERS THEN
    UPDATE tech_dispatches SET push_error = left('הצפצוף לא נשלח: ' || SQLERRM, 200) WHERE id = d.id;
  END;
  RETURN d;
END
$fn$;
REVOKE ALL ON FUNCTION app.tech_dispatch_create(bigint, uuid, integer, text, text, text, text, text, text, bigint) FROM PUBLIC;

-- המשימה הבאה הופכת לשליחה. ⚠️ הקורא נעל את הטכנאי וסגר את הנוכחית. אין באה, או שעדיין יש שליחה פתוחה — NULL ולא
-- שגיאה (שגיאה כאן הייתה מבטלת את הסיום שקרא לה). נשלח-ע"י של השליחה = מי שהכניס אותה לתור; היומן — מקור 'system'.
CREATE OR REPLACE FUNCTION app.tech_next_start(p_tech bigint, p_follows bigint, p_why text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  n     tech_next;
  d     tech_dispatches;
  v_src text := current_setting('app.tech_source', true);
BEGIN
  IF EXISTS (SELECT 1 FROM tech_dispatches WHERE technician_id = p_tech AND ended_at IS NULL) THEN RETURN NULL; END IF;
  DELETE FROM tech_next WHERE technician_id = p_tech RETURNING * INTO n;
  IF n.technician_id IS NULL THEN RETURN NULL; END IF;
  PERFORM set_config('app.tech_source', 'system', true);
  d := app.tech_dispatch_create(p_tech, n.client_id, n.site_id, n.site_code, n.site_name, n.place, n.details, n.ticket,
                                n.created_by, p_follows);
  PERFORM set_config('app.tech_source', COALESCE(v_src, ''), true);
  PERFORM app.record_write_audit('tech.next_start', 'מערכת — ' || p_why, 'system', 'technician', p_tech::text,
                                 jsonb_build_object('dispatch_id', d.id, 'follows', p_follows));
  RETURN d.id;
END
$fn$;
REVOKE ALL ON FUNCTION app.tech_next_start(bigint, bigint, text) FROM PUBLIC;

-- הרכז קובע לטכנאי את המשימה הבאה (עורך, בפיילוט). רק כשיש לו משימה פתוחה — בלי, שולחים ישר ("צא ל:"). רק אחת: באה
-- חדשה מחליפה את הקיימת. אותו client_id שוב (התשובה אבדה בדרך) — מה שכבר נשמר, גם אם הבאה כבר התחילה.
CREATE OR REPLACE FUNCTION public.tech_next_set(p_tech bigint, p_site_code text, p_place text, p_details text,
                                               p_ticket text, p_client_id uuid, p_rev integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_actor   text := app.require_editor();
  v_code    text := NULLIF(btrim(COALESCE(p_site_code, '')), '');
  v_place   text := NULLIF(btrim(regexp_replace(COALESCE(p_place, ''), '\s+', ' ', 'g')), '');
  v_details text := NULLIF(btrim(COALESCE(p_details, '')), '');
  v_ticket  text := NULLIF(btrim(COALESCE(p_ticket, '')), '');
  t         technicians;
  s         sites;
  v_owner   bigint;
  v_had     boolean := false;
BEGIN
  PERFORM app.tech_gate();
  IF p_client_id IS NULL THEN RAISE EXCEPTION 'חסר מזהה בקשה' USING ERRCODE = '22023'; END IF;
  SELECT * INTO t FROM technicians WHERE id = p_tech FOR UPDATE;
  IF NOT FOUND OR NOT t.is_active THEN RAISE EXCEPTION 'הטכנאי לא נמצא' USING ERRCODE = 'PT404'; END IF;

  SELECT technician_id INTO v_owner FROM tech_next WHERE client_id = p_client_id;
  IF v_owner IS NULL THEN SELECT technician_id INTO v_owner FROM tech_dispatches WHERE client_id = p_client_id; END IF;
  IF v_owner IS NOT NULL THEN
    IF v_owner <> t.id THEN RAISE EXCEPTION 'מזהה הבקשה כבר שימש לשליחה אחרת' USING ERRCODE = '22023'; END IF;
    RETURN jsonb_build_object('id', t.id, 'rev', t.rev, 'changed', false);
  END IF;

  IF p_rev IS NOT NULL AND t.rev <> p_rev THEN
    RAISE EXCEPTION 'הלוח השתנה בינתיים — טוען מחדש' USING ERRCODE = 'PT409';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tech_dispatches WHERE technician_id = t.id AND ended_at IS NULL) THEN
    RAISE EXCEPTION 'אין לטכנאי משימה פתוחה — אפשר לשלוח אותו ישר' USING ERRCODE = 'PT409';
  END IF;
  s := app.tech_dest_check(v_code, v_place, v_details, v_ticket);
  DELETE FROM tech_next WHERE technician_id = t.id RETURNING true INTO v_had;
  INSERT INTO tech_next (technician_id, client_id, site_id, site_code, site_name, place, details, ticket, created_by)
  VALUES (t.id, p_client_id, s.id, s.code, s.site_name, v_place, v_details, v_ticket, v_actor);
  UPDATE technicians SET rev = rev + 1 WHERE id = t.id;
  PERFORM app.record_write_audit('tech.next', v_actor, app.current_app_role(), 'technician', t.id::text,
                                 jsonb_build_object('site_code', s.code, 'replaced', COALESCE(v_had, false)));
  RETURN jsonb_build_object('id', t.id, 'rev', t.rev + 1, 'changed', true, 'replaced', COALESCE(v_had, false));
END
$fn$;
REVOKE ALL ON FUNCTION public.tech_next_set(bigint, text, text, text, text, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tech_next_set(bigint, text, text, text, text, uuid, integer) TO authenticated;

-- ביטול המשימה הבאה (עורך, בפיילוט). אין באה — כלום, לא שגיאה (שני מסכים).
CREATE OR REPLACE FUNCTION public.tech_next_clear(p_tech bigint, p_rev integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_actor text := app.require_editor();
  t       technicians;
  v_code  text;
BEGIN
  PERFORM app.tech_gate();
  SELECT * INTO t FROM technicians WHERE id = p_tech FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'הטכנאי לא נמצא' USING ERRCODE = 'PT404'; END IF;
  IF NOT EXISTS (SELECT 1 FROM tech_next WHERE technician_id = t.id) THEN
    RETURN jsonb_build_object('id', t.id, 'rev', t.rev, 'changed', false);
  END IF;
  IF p_rev IS NOT NULL AND t.rev <> p_rev THEN
    RAISE EXCEPTION 'הלוח השתנה בינתיים — טוען מחדש' USING ERRCODE = 'PT409';
  END IF;
  DELETE FROM tech_next WHERE technician_id = t.id RETURNING site_code INTO v_code;
  UPDATE technicians SET rev = rev + 1 WHERE id = t.id;
  PERFORM app.record_write_audit('tech.next_clear', v_actor, app.current_app_role(), 'technician', t.id::text,
                                 jsonb_build_object('site_code', v_code));
  RETURN jsonb_build_object('id', t.id, 'rev', t.rev + 1, 'changed', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.tech_next_clear(bigint, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tech_next_clear(bigint, integer) TO authenticated;

-- הסריקה: טכנאי שיש לו משימה באה, והרכב שלו יצא מהאתר של המשימה הנוכחית. רצה בכל סנכרון של איתוראן, אחרי הביקורים
-- (ituran_ingest, בבלוק משלה). הנוכחית נסגרת כ"סיים" ע"י "יצא מהאתר" (היומן: מקור 'gps'), והבאה מתחילה.
-- ⚠️ סדר הנעילה כמו כל הכותבים: הטכנאי, ואחר כך השליחה. ⚠️ שעת הסיום = שעת היציאה (לא לפני ההגעה / הכניסה).
CREATE OR REPLACE FUNCTION app.tech_leave_scan(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  r     record;
  d     tech_dispatches;
  v_end timestamptz;
  v_src text;
  n     integer := 0;
BEGIN
  FOR r IN
    SELECT t.id AS tech_id, x.id AS disp_id, vv.ended_at AS left_at
      FROM technicians t
      JOIN tech_next nx ON nx.technician_id = t.id
      JOIN tech_dispatches x ON x.technician_id = t.id AND x.ended_at IS NULL AND x.site_id IS NOT NULL
      CROSS JOIN LATERAL (SELECT v.ended_at FROM vehicle_visits v
                           WHERE v.license_plate = t.plate AND v.site_id = x.site_id AND v.ended_at IS NOT NULL
                             AND v.ended_at >= x.created_at AND v.ended_at <= p_now - interval '2 minutes'
                           ORDER BY v.ended_at DESC LIMIT 1) vv
     WHERE t.is_active AND t.plate IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM vehicle_visits o
                        WHERE o.license_plate = t.plate AND o.site_id = x.site_id AND o.ended_at IS NULL)
       -- ⚠️ 22/10/2026: הרכב עדיין בטווח האתר — לא יצא, גם כשהביקור נסגר. "באתר" רק לרכב שנסע היום, ולכן ביקור שחוצה
       -- חצות (קריאת לילה) נסגר בחצות בלי שהטכנאי זז; בלי זה המשימה הבאה הייתה מתחילה, עם צפצוף, כשהוא עוד באתר.
       AND NOT EXISTS (SELECT 1 FROM vehicles_live l JOIN sites s ON s.id = x.site_id
                        WHERE l.license_plate = t.plate AND l.lat IS NOT NULL AND s.lat IS NOT NULL
                          AND app.geo_distance_m(l.lat, l.lon, s.lat, s.lon) <= app.site_radius_m(s.geo_precision))
  LOOP
    PERFORM 1 FROM technicians WHERE id = r.tech_id FOR UPDATE;
    SELECT * INTO d FROM tech_dispatches WHERE id = r.disp_id FOR UPDATE;
    CONTINUE WHEN d.ended_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM tech_next WHERE technician_id = r.tech_id);
    v_end := GREATEST(r.left_at, COALESCE(d.entered_at, d.arrived_at, d.created_at));
    UPDATE tech_dispatches SET ended_at = v_end, ended_by = 'יצא מהאתר', end_kind = 'done' WHERE id = d.id;
    v_src := current_setting('app.tech_source', true);
    PERFORM set_config('app.tech_source', 'gps', true);
    PERFORM app.tech_log_add(r.tech_id, v_end, 'ended', NULL, d.id,
                             jsonb_build_object('end_kind', 'done', 'auto', 'left_site'), 'יצא מהאתר', true);
    PERFORM set_config('app.tech_source', COALESCE(v_src, ''), true);
    PERFORM app.tech_next_start(r.tech_id, d.id, 'יצא מהאתר');
    n := n + 1;
  END LOOP;
  RETURN n;
END
$fn$;
REVOKE ALL ON FUNCTION app.tech_leave_scan(timestamptz) FROM PUBLIC;
