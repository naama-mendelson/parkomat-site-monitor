-- ============================================================
-- רמזור — טבלה חופשית שהמנהל עורך מהדשבורד
-- ============================================================
-- לוח בסגנון Monday: שורות, עמודות שהמשתמש מגדיר, ותאים חופשיים.
--
-- ⚠️ **העמודות אינן עמודות SQL, ובכוונה.** "הוסף עמודה" מהדפדפן היה
-- אומר `ALTER TABLE` מהדפדפן — כלומר DDL בידי מי שמחזיק אסימון, וזו
-- הרשאה שאי אפשר להחזיר לאחור. עמודה כאן היא **שורה בטבלת הגדרות**,
-- והתאים יושבים ב-JSONB. המחיר: אי אפשר לאנדקס תא בודד. התמורה:
-- הוספת עמודה היא INSERT רגיל, ומחיקתה אינה משנה שום סכימה.
--
-- ⚠️ **ומחיקת עמודה אינה מוחקת את התאים.** הערכים נשארים ב-JSONB תחת
-- המפתח הישן. עמודה שנמחקה בטעות מוחזרת בהוספה מחדש עם אותו `key`,
-- והנתונים חוזרים איתה. מחיקה ששורפת מידע היא מחיקה שאיש לא יעז ללחוץ.

-- ============================================================
-- עמודות
-- ============================================================
CREATE TABLE IF NOT EXISTS traffic_light_columns (
  id         SERIAL PRIMARY KEY,
  -- ⚠️ מפתח יציב ונפרד מהתווית: שינוי שם עמודה אסור לו לנתק את התאים
  -- שכבר נכתבו. ב-Monday שינוי שם הוא פעולה שגרתית לגמרי.
  key        TEXT NOT NULL UNIQUE,
  label      TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'text'
             CHECK (kind IN ('text','number','date','status','checkbox','link')),
  -- אפשרויות ל-status: [{"value":"vip","label":"VIP","color":"#00c875"}]
  options    JSONB NOT NULL DEFAULT '[]'::jsonb,
  width      INTEGER NOT NULL DEFAULT 180 CHECK (width BETWEEN 60 AND 900),
  position   DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- שורות
-- ============================================================
-- ⚠️ `position` הוא `double precision` ולא `integer`, וזה לא קפריזה:
-- גרירת שורה לאמצע הרשימה עם מיקום שלם מחייבת לעדכן את **כל** השורות
-- שאחריה. עם מספר ממשי מספיק לתת לה את הממוצע בין שכנותיה — עדכון
-- שורה אחת במקום מאה.
CREATE TABLE IF NOT EXISTS traffic_light_rows (
  id         BIGSERIAL PRIMARY KEY,
  cells      JSONB NOT NULL DEFAULT '{}'::jsonb,
  position   DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tl_rows_position ON traffic_light_rows (position, id);
CREATE INDEX IF NOT EXISTS idx_tl_cols_position ON traffic_light_columns (position, id);

-- ============================================================
-- RLS — קריאה לכל מחובר, כתיבה רק דרך הפונקציות
-- ============================================================
-- ⚠️ אין מדיניות כתיבה כלל. כל שינוי עובר בפונקציות `SECURITY DEFINER`
-- שבודקות `app.require_manager()`. כך אין דרך לכתוב ישירות מהדפדפן גם
-- אם מישהו יחזיק אסימון תקף — אותו דפוס בדיוק כמו ניהול האתרים.
ALTER TABLE traffic_light_columns ENABLE ROW LEVEL SECURITY;
ALTER TABLE traffic_light_rows    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tl_cols_read ON traffic_light_columns;
CREATE POLICY tl_cols_read ON traffic_light_columns FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS tl_rows_read ON traffic_light_rows;
CREATE POLICY tl_rows_read ON traffic_light_rows FOR SELECT TO authenticated USING (true);

GRANT SELECT ON traffic_light_columns TO authenticated;
GRANT SELECT ON traffic_light_rows    TO authenticated;

-- ============================================================
-- קריאה — הכול בקריאה אחת
-- ============================================================
-- ⚠️ שתי קריאות נפרדות (עמודות, שורות) יכולות להחזיר מצבים לא עקביים:
-- עמודה שנוספה בין שתי הקריאות מופיעה בכותרת בלי תא מתאים. קריאה אחת
-- מחזירה תמונה אחת.
CREATE OR REPLACE FUNCTION public.tl_board()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
  SELECT jsonb_build_object(
    'columns', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', c.id, 'key', c.key, 'label', c.label, 'kind', c.kind,
               'options', c.options, 'width', c.width, 'position', c.position)
             ORDER BY c.position, c.id)
        FROM traffic_light_columns c), '[]'::jsonb),
    'rows', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', r.id, 'cells', r.cells, 'position', r.position)
             ORDER BY r.position, r.id)
        FROM traffic_light_rows r), '[]'::jsonb)
  );
$fn$;

GRANT EXECUTE ON FUNCTION public.tl_board() TO authenticated;

-- ============================================================
-- עמודות — הוספה, שינוי, מחיקה
-- ============================================================
CREATE OR REPLACE FUNCTION public.tl_add_column(
  p_label   text,
  p_kind    text DEFAULT 'text',
  p_options jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_key text;
  v_pos double precision;
  v_id  integer;
BEGIN
  PERFORM app.require_manager();

  IF COALESCE(btrim(p_label), '') = '' THEN
    RAISE EXCEPTION 'שם העמודה חסר';
  END IF;

  -- ⚠️ המפתח נגזר מהזמן ולא מהתווית. תווית עברית הייתה מייצרת מפתח
  -- עברי ב-JSONB — עובד, אבל בלתי קריא בכל כלי אבחון. ותוויות כפולות
  -- ("הערות" פעמיים) הן מצב לגיטימי לגמרי בלוח כזה.
  v_key := 'c' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS');

  SELECT COALESCE(MAX(position), 0) + 1 INTO v_pos FROM traffic_light_columns;

  INSERT INTO traffic_light_columns (key, label, kind, options, position)
  VALUES (v_key, btrim(p_label), COALESCE(p_kind, 'text'),
          COALESCE(p_options, '[]'::jsonb), v_pos)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'key', v_key);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.tl_update_column(
  p_id      integer,
  p_label   text  DEFAULT NULL,
  p_kind    text  DEFAULT NULL,
  p_options jsonb DEFAULT NULL,
  p_width   integer DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
BEGIN
  PERFORM app.require_manager();

  -- ⚠️ COALESCE על כל שדה: הקורא שולח רק את מה שהשתנה. עדכון שדורש
  -- את כל השדות הופך "שינוי רוחב" לסיכון של דריסת האפשרויות.
  UPDATE traffic_light_columns
     SET label   = COALESCE(NULLIF(btrim(p_label), ''), label),
         kind    = COALESCE(p_kind, kind),
         options = COALESCE(p_options, options),
         width   = COALESCE(p_width, width)
   WHERE id = p_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'עמודה % אינה קיימת', p_id;
  END IF;
END;
$fn$;

-- ⚠️ **מחיקת עמודה מסירה את ההגדרה בלבד.** הערכים נשארים ב-JSONB תחת
-- המפתח הישן, ולכן הוספה מחדש של עמודה עם אותו `key` מחזירה אותם.
-- מחיקה ששורפת מידע היא מחיקה שאיש לא יעז ללחוץ, ולוח כזה חי על
-- ניסוי וטעייה.
CREATE OR REPLACE FUNCTION public.tl_delete_column(p_id integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
BEGIN
  PERFORM app.require_manager();
  DELETE FROM traffic_light_columns WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'עמודה % אינה קיימת', p_id;
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.tl_move_column(p_id integer, p_position double precision)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
BEGIN
  PERFORM app.require_manager();
  UPDATE traffic_light_columns SET position = p_position WHERE id = p_id;
END;
$fn$;

-- ============================================================
-- שורות
-- ============================================================
CREATE OR REPLACE FUNCTION public.tl_add_row(p_after double precision DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_pos double precision;
  v_id  bigint;
BEGIN
  PERFORM app.require_manager();

  IF p_after IS NULL THEN
    SELECT COALESCE(MAX(position), 0) + 1 INTO v_pos FROM traffic_light_rows;
  ELSE
    -- ⚠️ הממוצע בין השורה שאחריה למי שבא אחריה — כך הוספה באמצע
    -- מעדכנת **שורה אחת** ולא את כל מה שמתחתיה.
    SELECT COALESCE(MIN(position), p_after + 2) INTO v_pos
      FROM traffic_light_rows WHERE position > p_after;
    v_pos := (p_after + v_pos) / 2;
  END IF;

  INSERT INTO traffic_light_rows (position) VALUES (v_pos) RETURNING id INTO v_id;
  RETURN v_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.tl_delete_row(p_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
BEGIN
  PERFORM app.require_manager();
  DELETE FROM traffic_light_rows WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'שורה % אינה קיימת', p_id;
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.tl_move_row(p_id bigint, p_position double precision)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
BEGIN
  PERFORM app.require_manager();
  UPDATE traffic_light_rows SET position = p_position, updated_at = now() WHERE id = p_id;
END;
$fn$;

-- ============================================================
-- תא בודד — הפעולה הנפוצה ביותר
-- ============================================================
-- ⚠️ **תא ולא שורה.** שליחת השורה כולה בכל הקשה הופכת שני עורכים
-- בו-זמנית למחיקה הדדית: מי שסיים אחרון דורס את מה שהאחר כתב בתא אחר
-- לגמרי. `jsonb_set` נוגע במפתח אחד.
--
-- ⚠️ וערך ריק **מוחק את המפתח** במקום לשמור מחרוזת ריקה, אחרת ה-JSONB
-- מתמלא במפתחות ריקים של עמודות שנמחקו מזמן.
CREATE OR REPLACE FUNCTION public.tl_set_cell(
  p_row   bigint,
  p_key   text,
  p_value jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
BEGIN
  PERFORM app.require_manager();

  IF p_value IS NULL OR p_value = 'null'::jsonb OR p_value = '""'::jsonb THEN
    UPDATE traffic_light_rows
       SET cells = cells - p_key, updated_at = now()
     WHERE id = p_row;
  ELSE
    UPDATE traffic_light_rows
       SET cells = jsonb_set(COALESCE(cells, '{}'::jsonb), ARRAY[p_key], p_value, true),
           updated_at = now()
     WHERE id = p_row;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'שורה % אינה קיימת', p_row;
  END IF;
END;
$fn$;

-- ============================================================
-- הדבקה מרובה — כי היא הדרך שבה הלוח ימולא בפועל
-- ============================================================
-- ⚠️ מילוי לוח של 40 שורות ידרוש מאות קריאות `tl_set_cell`. פונקציה
-- אחת שמקבלת מערך שורות היא ההבדל בין הדבקה שעובדת להדבקה שנתקעת.
-- אותו נימוק בדיוק שבגללו `ingest_batch` מקבלת אצווה ולא הודעה.
CREATE OR REPLACE FUNCTION public.tl_paste_rows(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_item  jsonb;
  v_pos   double precision;
  v_count integer := 0;
BEGIN
  PERFORM app.require_manager();

  IF jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'מצופה מערך שורות';
  END IF;

  -- ⚠️ תקרה. הדבקה של 50,000 שורות בטעות היא נזק שקשה לבטל ביד.
  IF jsonb_array_length(p_rows) > 500 THEN
    RAISE EXCEPTION 'יותר מ-500 שורות בהדבקה אחת';
  END IF;

  SELECT COALESCE(MAX(position), 0) INTO v_pos FROM traffic_light_rows;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    v_pos := v_pos + 1;
    INSERT INTO traffic_light_rows (cells, position) VALUES (v_item, v_pos);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.tl_add_column(text, text, jsonb)             TO authenticated;
GRANT EXECUTE ON FUNCTION public.tl_update_column(integer, text, text, jsonb, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tl_delete_column(integer)                    TO authenticated;
GRANT EXECUTE ON FUNCTION public.tl_move_column(integer, double precision)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.tl_add_row(double precision)                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.tl_delete_row(bigint)                        TO authenticated;
GRANT EXECUTE ON FUNCTION public.tl_move_row(bigint, double precision)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.tl_set_cell(bigint, text, jsonb)             TO authenticated;
GRANT EXECUTE ON FUNCTION public.tl_paste_rows(jsonb)                         TO authenticated;
