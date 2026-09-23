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

-- ============================================================
-- ⚠️ שני לוחות באותן טבלאות — ולא שתי טבלאות
-- ============================================================
-- ‏"רמזור רובוטי" ו"רמזור מכפילים" הם שני דשבורדים נפרדים לחלוטין:
-- עמודות שונות, שורות שונות, ואין ביניהם שום קשר תוכני. ובכל זאת הם
-- חולקים טבלה, כי **כל המכניקה זהה** — עריכת תא, הוספת שורה, הדבקה
-- מאקסל, הרשאת מנהל, RLS. טבלאות נפרדות היו מכפילות עשר פונקציות,
-- שתי מדיניות ושמונה־עשרה הרשאות, וכל תיקון עתידי היה צריך להיכתב
-- פעמיים — ומי ששוכח את השני מקבל לוח אחד שמתנהג אחרת מהשני.
--
-- ⚠️ **ו-`ADD COLUMN IF NOT EXISTS` ולא שינוי ב-`CREATE TABLE`.** הטבלאות
-- קיימות בייצור עם 153 שורות; `CREATE TABLE IF NOT EXISTS` פשוט לא היה
-- רץ, והעמודה לא הייתה נוספת לעולם.
--
-- ⚠️ **ברירת המחדל היא `robotic`, וזה מה שממלא את 153 השורות הקיימות.**
-- בלי ברירת מחדל הן היו מקבלות NULL, וכל שאילתה שמסננת לפי לוח הייתה
-- מחזירה לוח ריק — כלומר הלוח הקיים נעלם מהמסך ברגע ההחלה.
--
-- ⚠️ **ו-CHECK ולא טקסט חופשי.** שגיאת כתיב בשם הלוח יוצרת לוח שלישי
-- בלתי־נראה: השורות נכתבות, אף אחד לא רואה אותן, ואין שגיאה. הוספת לוח
-- בעתיד היא שורה אחת כאן, וזה המחיר הנכון מול כישלון שקט.
ALTER TABLE traffic_light_columns
  ADD COLUMN IF NOT EXISTS board TEXT NOT NULL DEFAULT 'robotic';
ALTER TABLE traffic_light_rows
  ADD COLUMN IF NOT EXISTS board TEXT NOT NULL DEFAULT 'robotic';

-- ⚠️ `DROP IF EXISTS` ואז `ADD`, ולא `DO $$ … EXCEPTION`. בלוק כזה כבר
-- נמחץ פעם אחת בפרויקט הזה — `DO $$` הפך ל-`DO $` בדרך, וכל
-- `cron.postgres.sql` נכשל להחלה **בשקט**. שתי שורות בלי ציטוט־דולר
-- עושות את אותו דבר ואי אפשר למחוץ אותן.
ALTER TABLE traffic_light_columns DROP CONSTRAINT IF EXISTS tl_cols_board_known;
ALTER TABLE traffic_light_columns
  ADD CONSTRAINT tl_cols_board_known CHECK (board IN ('robotic','multipliers'));

ALTER TABLE traffic_light_rows DROP CONSTRAINT IF EXISTS tl_rows_board_known;
ALTER TABLE traffic_light_rows
  ADD CONSTRAINT tl_rows_board_known CHECK (board IN ('robotic','multipliers'));

-- ⚠️ הלוח קודם למיקום באינדקס: כל שליפה מתחילה ב"איזה לוח", ואינדקס
-- שמתחיל ב-position היה נסרק במלואו כדי לסנן אחר כך.
--
-- ⚠️ **ו-DROP לפני CREATE, ולא `IF NOT EXISTS` לבדו.** שני האינדקסים
-- כבר קיימים בייצור בהגדרה הישנה `(position, id)`; `CREATE INDEX IF NOT
-- EXISTS` רואה את השם, מדלג, ומחזיר הצלחה — כלומר ההגדרה החדשה לא
-- הייתה נכנסת לעולם ואף שגיאה לא הייתה מופיעה.
DROP INDEX IF EXISTS idx_tl_rows_position;
DROP INDEX IF EXISTS idx_tl_cols_position;
CREATE INDEX IF NOT EXISTS idx_tl_rows_position ON traffic_light_rows (board, position, id);
CREATE INDEX IF NOT EXISTS idx_tl_cols_position ON traffic_light_columns (board, position, id);

-- ============================================================
-- RLS — קריאה לכל מחובר, כתיבה רק דרך הפונקציות
-- ============================================================
-- ⚠️ אין מדיניות כתיבה כלל. כל שינוי עובר בפונקציות `SECURITY DEFINER`
-- שבודקות `app.require_manager()`. כך אין דרך לכתוב ישירות מהדפדפן גם
-- אם מישהו יחזיק אסימון תקף — אותו דפוס בדיוק כמו ניהול האתרים.
ALTER TABLE traffic_light_columns ENABLE ROW LEVEL SECURITY;
ALTER TABLE traffic_light_rows    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tl_cols_read ON traffic_light_columns;
-- ⚠️ **`is_active_user()` ולא `true`** — אותו ביטוי כמו בכל טבלה אחרת (security.postgres.sql).
-- משתמש שהושבת מחזיק אסימון תקף עד שיפוג; `USING (true)` השאיר לו את כל הלוח —
-- אנשי קשר ו"מורשה כניסה למרתף". נמדד על Postgres 17 מקומי, 17/09/2026.
CREATE POLICY tl_cols_read ON traffic_light_columns FOR SELECT TO authenticated
  USING ((SELECT app.is_active_user()));

DROP POLICY IF EXISTS tl_rows_read ON traffic_light_rows;
CREATE POLICY tl_rows_read ON traffic_light_rows FOR SELECT TO authenticated
  USING ((SELECT app.is_active_user()));

GRANT SELECT ON traffic_light_columns TO authenticated;
GRANT SELECT ON traffic_light_rows    TO authenticated;

-- ============================================================
-- קריאה — הכול בקריאה אחת
-- ============================================================
-- ⚠️ שתי קריאות נפרדות (עמודות, שורות) יכולות להחזיר מצבים לא עקביים:
-- עמודה שנוספה בין שתי הקריאות מופיעה בכותרת בלי תא מתאים. קריאה אחת
-- מחזירה תמונה אחת.
-- ============================================================
-- ⚠️ SECURITY INVOKER — ולא DEFINER, וזה היה חור
-- ============================================================
-- הפונקציה הייתה `SECURITY DEFINER` בלי בדיקת זהות ובלי REVOKE. ברירת המחדל של
-- Postgres היא EXECUTE ל-PUBLIC, כלומר גם ל-`anon`, ו-DEFINER עוקף RLS — כך
-- שכל מי שמחזיק את המפתח הפומבי (הוא בכל דפדפן) קרא את הלוח כולו בלי להתחבר.
-- כקריאה בלבד אין לה שום צורך בהרשאות הבעלים: INVOKER מפעיל את מדיניות
-- הקריאה שלמעלה, ומשתמש מושבת מקבל לוח ריק.
-- ============================================================
-- ⚠️ DROP לפני CREATE — ולא `CREATE OR REPLACE` לבדו
-- ============================================================
-- הוספת פרמטר **אינה** מחליפה פונקציה, היא יוצרת **עומס יתר שני**.
-- ושתי גרסאות של אותה פונקציה גורמות ל-PostgREST לסרב לקריאה כולה —
-- זה בדיוק מה שקרה ב-17/09/2026, כשעותק ישן של `ingest_batch` חזר לחיים
-- ו**כל האתרים הפסיקו לכתוב**. לכן כל אחת מארבע הפונקציות שמקבלות
-- `p_board` נמחקת מפורשות קודם.
DROP FUNCTION IF EXISTS public.tl_board();

-- ⚠️ `DEFAULT 'robotic'` הוא מה שמאפשר לדשבורד ישן לעבוד מול SQL חדש:
-- קריאה בלי ארגומנט ממשיכה להחזיר את הלוח הרובוטי בדיוק כמו קודם.
-- הכיוון ההפוך — דשבורד חדש מול SQL ישן — נשבר, ולכן **ה-SQL מוחל
-- לפני שהדשבורד נדחף**. ראה ההערה בראש הקובץ הזה.
CREATE OR REPLACE FUNCTION public.tl_board(p_board text DEFAULT 'robotic')
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, app, pg_temp
AS $fn$
  SELECT jsonb_build_object(
    'board', COALESCE(NULLIF(btrim(p_board), ''), 'robotic'),
    'columns', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', c.id, 'key', c.key, 'label', c.label, 'kind', c.kind,
               'options', c.options, 'width', c.width, 'position', c.position)
             ORDER BY c.position, c.id)
        FROM traffic_light_columns c
       WHERE c.board = COALESCE(NULLIF(btrim(p_board), ''), 'robotic')), '[]'::jsonb),
    'rows', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', r.id, 'cells', r.cells, 'position', r.position)
             ORDER BY r.position, r.id)
        FROM traffic_light_rows r
       WHERE r.board = COALESCE(NULLIF(btrim(p_board), ''), 'robotic')), '[]'::jsonb)
  );
$fn$;

REVOKE ALL ON FUNCTION public.tl_board(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tl_board(text) TO authenticated;

-- ============================================================
-- עמודות — הוספה, שינוי, מחיקה
-- ============================================================
DROP FUNCTION IF EXISTS public.tl_add_column(text, text, jsonb);

CREATE OR REPLACE FUNCTION public.tl_add_column(
  p_label   text,
  p_kind    text DEFAULT 'text',
  p_options jsonb DEFAULT '[]'::jsonb,
  p_board   text  DEFAULT 'robotic'
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
  -- ⚠️ הלוח מנורמל פעם אחת: מחרוזת ריקה או NULL היא הלוח הרובוטי,
  -- כדי שקורא ישן שאינו מעביר דבר ימשיך לעבוד בדיוק כמו קודם.
  v_board text := COALESCE(NULLIF(btrim(p_board), ''), 'robotic');
BEGIN
  PERFORM app.require_manager();

  IF COALESCE(btrim(p_label), '') = '' THEN
    RAISE EXCEPTION 'שם העמודה חסר';
  END IF;

  -- ⚠️ המפתח נגזר מהזמן ולא מהתווית. תווית עברית הייתה מייצרת מפתח
  -- עברי ב-JSONB — עובד, אבל בלתי קריא בכל כלי אבחון. ותוויות כפולות
  -- ("הערות" פעמיים) הן מצב לגיטימי לגמרי בלוח כזה.
  v_key := 'c' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS');

  -- ⚠️ המיקום נספר **בתוך הלוח**. בלי הסינון, עמודה ראשונה בלוח חדש
  -- הייתה מקבלת את המיקום שאחרי העמודה האחרונה של הלוח השני — כלומר
  -- לוח ריק שמתחיל במיקום 16, ומיזוג עתידי של סדרים הופך לבלתי אפשרי.
  SELECT COALESCE(MAX(position), 0) + 1 INTO v_pos
    FROM traffic_light_columns WHERE board = v_board;

  INSERT INTO traffic_light_columns (key, label, kind, options, position, board)
  VALUES (v_key, btrim(p_label), COALESCE(p_kind, 'text'),
          COALESCE(p_options, '[]'::jsonb), v_pos, v_board)
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
DROP FUNCTION IF EXISTS public.tl_add_row(double precision);

CREATE OR REPLACE FUNCTION public.tl_add_row(
  p_after double precision DEFAULT NULL,
  p_board text             DEFAULT 'robotic'
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_pos double precision;
  v_id  bigint;
  -- ⚠️ הלוח מנורמל פעם אחת: מחרוזת ריקה או NULL היא הלוח הרובוטי,
  -- כדי שקורא ישן שאינו מעביר דבר ימשיך לעבוד בדיוק כמו קודם.
  v_board text := COALESCE(NULLIF(btrim(p_board), ''), 'robotic');
BEGIN
  PERFORM app.require_manager();

  IF p_after IS NULL THEN
    SELECT COALESCE(MAX(position), 0) + 1 INTO v_pos
      FROM traffic_light_rows WHERE board = v_board;
  ELSE
    -- ⚠️ הממוצע בין השורה שאחריה למי שבא אחריה — כך הוספה באמצע
    -- מעדכנת **שורה אחת** ולא את כל מה שמתחתיה.
    SELECT COALESCE(MIN(position), p_after + 2) INTO v_pos
      FROM traffic_light_rows WHERE board = v_board AND position > p_after;
    v_pos := (p_after + v_pos) / 2;
  END IF;

  INSERT INTO traffic_light_rows (position, board) VALUES (v_pos, v_board) RETURNING id INTO v_id;
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
DROP FUNCTION IF EXISTS public.tl_paste_rows(jsonb);

CREATE OR REPLACE FUNCTION public.tl_paste_rows(
  p_rows  jsonb,
  p_board text DEFAULT 'robotic'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_item  jsonb;
  v_pos   double precision;
  v_count integer := 0;
  -- ⚠️ הלוח מנורמל פעם אחת: מחרוזת ריקה או NULL היא הלוח הרובוטי,
  -- כדי שקורא ישן שאינו מעביר דבר ימשיך לעבוד בדיוק כמו קודם.
  v_board text := COALESCE(NULLIF(btrim(p_board), ''), 'robotic');
BEGIN
  PERFORM app.require_manager();

  IF jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'מצופה מערך שורות';
  END IF;

  -- ⚠️ תקרה. הדבקה של 50,000 שורות בטעות היא נזק שקשה לבטל ביד.
  IF jsonb_array_length(p_rows) > 500 THEN
    RAISE EXCEPTION 'יותר מ-500 שורות בהדבקה אחת';
  END IF;

  SELECT COALESCE(MAX(position), 0) INTO v_pos FROM traffic_light_rows WHERE board = v_board;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    v_pos := v_pos + 1;
    INSERT INTO traffic_light_rows (cells, position, board) VALUES (v_item, v_pos, v_board);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$fn$;

-- ⚠️ REVOKE לפני GRANT, כמו ב-writes.postgres.sql. הכתיבות בודקות
-- `require_manager()` ולכן אנונימי נדחה ממילא — אבל "נדחה בתוך הפונקציה" אינו
-- "אינו רשאי להריץ", והשני הוא מה ש-`check-security` יכול לאמת בלי לנחש.
REVOKE ALL ON FUNCTION public.tl_add_column(text, text, jsonb, text)       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tl_update_column(integer, text, text, jsonb, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tl_delete_column(integer)                    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tl_move_column(integer, double precision)    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tl_add_row(double precision, text)           FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tl_delete_row(bigint)                        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tl_move_row(bigint, double precision)        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tl_set_cell(bigint, text, jsonb)             FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tl_paste_rows(jsonb, text)                   FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.tl_add_column(text, text, jsonb, text)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.tl_update_column(integer, text, text, jsonb, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tl_delete_column(integer)                    TO authenticated;
GRANT EXECUTE ON FUNCTION public.tl_move_column(integer, double precision)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.tl_add_row(double precision, text)           TO authenticated;
GRANT EXECUTE ON FUNCTION public.tl_delete_row(bigint)                        TO authenticated;
GRANT EXECUTE ON FUNCTION public.tl_move_row(bigint, double precision)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.tl_set_cell(bigint, text, jsonb)             TO authenticated;
GRANT EXECUTE ON FUNCTION public.tl_paste_rows(jsonb, text)                   TO authenticated;
