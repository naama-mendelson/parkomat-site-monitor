-- ============================================================
-- db/tasks.postgres.sql — משימות: קשרי לקוחות וטכני, כלליות או של אתר
-- ============================================================
-- בעלת המוצר, 06/10/2026: "יש המון משימות שנפתחות כל יום בשירות" — לקשרי לקוחות
-- ("להודיע ללקוח שהוא לא חנה כמו שצריך") ולטכני ("יש לגרז… להחליף…", בעיקר לאתר
-- ספציפי).
--
-- ⚠️ **לכל כרטיס, שני כפתורים** (בעלת המוצר, 06/10/2026: "משימות קשרי לקוחות וטכני זה
-- אותו דבר ואני רוצה עבור כל כרטיס"): כל משימה שייכת לאתר אחד ולסוג אחד —
-- 'customer' או 'technical' — וכל כפתור פותח את הטבלה של האתר מאותו סוג. גרסה
-- ראשונה עם שני כפתורים כלליים בכותרת נבנתה באותו יום ונזנחה לפני שעלתה.
--
-- ⚠️ **משימה לא נמחקת** — היא מסומנת "בוצעה" (מי ומתי) ויורדת לאזור מקופל.
-- אין כאן DELETE בכלל, גם לא למנהל: מה שנפתח ונסגר הוא היסטוריה של השירות.
--
-- ⚠️ **מי מסמן "בוצעה" — עדיין לא הוחלט** ("נראה אחרי זה", 06/10/2026). הבקשה
-- המקורית: רק משתמש קשרי לקוחות מסמן משימת קשרי לקוחות. במערכת אין היום צוותים,
-- רק תפקידים. עד שיוחלט: כל איש צוות מסמן, ושמו נרשם (ייחוס, לא חסימה — כמו
-- בתחזוקה). ההגבלה תהיה שינוי במקום **אחד**: app.can_close_task.
--
-- מוסכמות: כמו compliance.postgres.sql — טבלה סגורה (RLS בלי מדיניות, בלי הרשאות),
-- כל גישה דרך RPC עם app.require_staff(), תאריכים TEXT ב-ISO-UTC, אירוע ב-events
-- לכל כתיבה (type='tasks') כדי שכל מסך פתוח יתעדכן.

CREATE TABLE IF NOT EXISTS tasks (
  id              BIGSERIAL PRIMARY KEY,
  client_id       UUID NOT NULL,
  kind            TEXT NOT NULL,
  site_id         INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  site_code       TEXT,                          -- snapshot: שורד מחיקת אתר (כמו events)
  body            TEXT NOT NULL,
  created_by      TEXT NOT NULL,                 -- שם מזוהה (app.actor_display_name), לא מוקלד
  created_by_user INTEGER,
  created_at      TEXT NOT NULL,
  done_at         TEXT,
  done_by         TEXT,
  done_by_user    INTEGER
);

-- ⚠️ אילוצים בשם, מחוץ ל-CREATE TABLE — אחרת שינוי עתידי לא יגיע לייצור (ראו compliance)
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_kind_chk;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_chk CHECK (kind IN ('customer', 'technical')) NOT VALID;
ALTER TABLE tasks VALIDATE CONSTRAINT tasks_kind_chk;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_body_chk;
ALTER TABLE tasks ADD CONSTRAINT tasks_body_chk CHECK (length(btrim(body)) BETWEEN 2 AND 2000) NOT VALID;
ALTER TABLE tasks VALIDATE CONSTRAINT tasks_body_chk;
-- בוצעה = שני השדות יחד, לעולם לא אחד בלי השני
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_done_chk;
ALTER TABLE tasks ADD CONSTRAINT tasks_done_chk CHECK ((done_at IS NULL) = (done_by IS NULL)) NOT VALID;
ALTER TABLE tasks VALIDATE CONSTRAINT tasks_done_chk;

CREATE UNIQUE INDEX IF NOT EXISTS tasks_client_uq ON tasks (client_id);
CREATE INDEX IF NOT EXISTS tasks_open_idx ON tasks (kind, created_at) WHERE done_at IS NULL;
CREATE INDEX IF NOT EXISTS tasks_site_idx ON tasks (site_id) WHERE done_at IS NULL;
CREATE INDEX IF NOT EXISTS tasks_done_idx ON tasks (done_at) WHERE done_at IS NOT NULL;

-- סגורה: RLS בלי מדיניות, ובלי הרשאות לאף תפקיד של PostgREST
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON tasks FROM %I', r);
      EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM %I', pg_get_serial_sequence('tasks', 'id'), r);
    END IF;
  END LOOP;
  REVOKE ALL ON tasks FROM PUBLIC;
END $$;

-- ============================================================
-- מי רשאי לסמן "בוצעה" — המקום היחיד
-- ============================================================
-- ⚠️ כרגע: כל איש צוות. כשבעלת המוצר תחליט על צוותים (קשרי לקוחות / טכני), כאן
-- נבדק השיוך — ושום מקום אחר לא צריך להשתנות: tasks_list מחזיר can_close לכל שורה,
-- והמסך מציג את הכפתור לפיו.
CREATE OR REPLACE FUNCTION app.can_close_task(p_kind text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
  SELECT app.is_staff()
$$;
REVOKE ALL ON FUNCTION app.can_close_task(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.task_event(p_code text, p_kind text, p_action text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
  SELECT app.record_write_event(COALESCE(p_code, '*'), 'tasks',
    jsonb_build_object('type', 'tasks', 'code', p_code, 'kind', p_kind, 'action', p_action));
$$;
REVOKE ALL ON FUNCTION app.task_event(text, text, text) FROM PUBLIC;

-- ============================================================
-- קריאה
-- ============================================================
-- ⚠️ jsonb יחיד ולא RETURNS TABLE: PostgREST חותך ב-1,000 שורות בשקט, ומשימות שבוצעו
-- רק מצטברות. כאן: כל הפתוחות, 200 האחרונות שבוצעו, ומספר כל שבוצעו — המסך מראה
-- "בוצעו (N)" נכון גם כשלא כולן נשלחו.
CREATE OR REPLACE FUNCTION public.tasks_list(p_kind text DEFAULT NULL, p_site_code text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_site integer;
  v_code text := NULLIF(btrim(COALESCE(p_site_code, '')), '');
BEGIN
  PERFORM app.require_staff();
  IF p_kind IS NOT NULL AND p_kind NOT IN ('customer', 'technical') THEN
    RAISE EXCEPTION 'סוג משימה לא מוכר: %', p_kind USING ERRCODE = 'check_violation';
  END IF;
  IF v_code IS NOT NULL THEN
    SELECT s.id INTO v_site FROM sites s WHERE s.code = v_code;
    IF v_site IS NULL THEN RAISE EXCEPTION 'אתר לא נמצא: %', v_code USING ERRCODE = 'PT404'; END IF;
  END IF;
  RETURN (
    WITH f AS (
      SELECT t.*, s.code AS cur_code, s.site_name AS cur_name
        FROM tasks t LEFT JOIN sites s ON s.id = t.site_id
       WHERE (p_kind IS NULL OR t.kind = p_kind)
         AND (v_site IS NULL OR t.site_id = v_site)
    ),
    row_of AS (
      SELECT f.id, f.done_at, f.created_at,
             jsonb_build_object('id', f.id, 'kind', f.kind,
               'site_code', COALESCE(f.cur_code, f.site_code), 'site_name', f.cur_name,
               'body', f.body, 'created_by', f.created_by, 'created_at', f.created_at,
               'done_at', f.done_at, 'done_by', f.done_by, 'can_close', app.can_close_task(f.kind)) AS j
        FROM f
    )
    SELECT jsonb_build_object(
      -- "טבלה צומחת": הוותיקה למעלה, החדשה נוספת בסוף
      'open', COALESCE((SELECT jsonb_agg(r.j ORDER BY r.created_at, r.id) FROM row_of r WHERE r.done_at IS NULL), '[]'::jsonb),
      'done', COALESCE((SELECT jsonb_agg(x.j ORDER BY x.done_at DESC, x.id DESC)
                          FROM (SELECT r.j, r.done_at, r.id FROM row_of r WHERE r.done_at IS NOT NULL
                                 ORDER BY r.done_at DESC, r.id DESC LIMIT 200) x), '[]'::jsonb),
      'done_total', (SELECT count(*) FROM row_of r WHERE r.done_at IS NOT NULL)
    )
  );
END $fn$;
REVOKE ALL ON FUNCTION public.tasks_list(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tasks_list(text, text) TO authenticated;

-- מספרי המשימות הפתוחות — שורה לכל אתר×סוג (שני הכפתורים בכל כרטיס).
-- ⚠️ לעולם אינה זורקת: מי שאינו צוות מקבל אפס שורות (כמו site_compliance) — הכפתורים
-- נטענים יחד עם רשימת האתרים, ושגיאה כאן לא תפיל אותה.
DROP FUNCTION IF EXISTS public.task_counts();
CREATE FUNCTION public.task_counts()
RETURNS TABLE (kind text, site_id integer, open integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
  SELECT t.kind, t.site_id, count(*)::int
    FROM tasks t
   WHERE t.done_at IS NULL AND t.site_id IS NOT NULL AND (SELECT app.is_staff())
   GROUP BY t.kind, t.site_id
$$;
REVOKE ALL ON FUNCTION public.task_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.task_counts() TO authenticated;

-- ============================================================
-- כתיבה
-- ============================================================
-- ⚠️ client_id: שליחה שנכשלה ברשת ונשלחה שוב לא יוצרת משימה כפולה.
CREATE OR REPLACE FUNCTION public.task_add(p_kind text, p_body text, p_site_code text DEFAULT NULL,
                                           p_client_id uuid DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_staff();
  v_body text := btrim(COALESCE(p_body, ''));
  v_code text := NULLIF(btrim(COALESCE(p_site_code, '')), '');
  v_client uuid := COALESCE(p_client_id, gen_random_uuid());
  v_site integer;
  v_id bigint;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('customer', 'technical') THEN
    RAISE EXCEPTION 'סוג משימה לא מוכר: %', p_kind USING ERRCODE = 'check_violation';
  END IF;
  IF length(v_body) < 2 THEN RAISE EXCEPTION 'תיאור המשימה ריק' USING ERRCODE = 'check_violation'; END IF;
  IF length(v_body) > 2000 THEN RAISE EXCEPTION 'תיאור המשימה ארוך מדי' USING ERRCODE = 'check_violation'; END IF;
  -- ⚠️ אתר חובה: משימה נפתחת מכרטיס של אתר — אין רשימה כללית שבה משימה בלי אתר תופיע
  IF v_code IS NULL THEN RAISE EXCEPTION 'נדרש אתר למשימה' USING ERRCODE = 'check_violation'; END IF;
  SELECT s.id INTO v_site FROM sites s WHERE s.code = v_code;
  IF v_site IS NULL THEN RAISE EXCEPTION 'אתר לא נמצא: %', v_code USING ERRCODE = 'PT404'; END IF;
  SELECT t.id INTO v_id FROM tasks t WHERE t.client_id = v_client;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;      -- שליחה חוזרת
  INSERT INTO tasks (client_id, kind, site_id, site_code, body, created_by, created_by_user, created_at)
  VALUES (v_client, p_kind, v_site, v_code, v_body, v_actor, app.current_app_user(),
          to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  RETURNING tasks.id INTO v_id;
  -- ⚠️ ביומן: מזהים בלבד, לא גוף המשימה (audit_log קריא לכל משתמש פעיל)
  PERFORM app.record_write_audit('task.add', v_actor, app.current_app_role(), 'task', v_id::text,
    jsonb_build_object('kind', p_kind, 'site_code', v_code));
  PERFORM app.task_event(v_code, p_kind, 'add');
  RETURN v_id;
END $fn$;
REVOKE ALL ON FUNCTION public.task_add(text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.task_add(text, text, text, uuid) TO authenticated;

-- "בוצעה": מי ומתי. אידמפוטנטי — סימון שני מחזיר את הסימון הראשון ולא דורס את שמו.
CREATE OR REPLACE FUNCTION public.task_done(p_id bigint)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_staff();
  v_t tasks%ROWTYPE;
  v_now text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  SELECT * INTO v_t FROM tasks t WHERE t.id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'המשימה לא נמצאה' USING ERRCODE = 'PT404'; END IF;
  IF v_t.done_at IS NOT NULL THEN RETURN v_t.done_at; END IF;
  IF NOT app.can_close_task(v_t.kind) THEN
    RAISE EXCEPTION 'אין הרשאה לסמן משימה זו כבוצעה' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE tasks SET done_at = v_now, done_by = v_actor, done_by_user = app.current_app_user() WHERE tasks.id = p_id;
  PERFORM app.record_write_audit('task.done', v_actor, app.current_app_role(), 'task', p_id::text,
    jsonb_build_object('kind', v_t.kind, 'site_code', v_t.site_code));
  PERFORM app.task_event((SELECT s.code FROM sites s WHERE s.id = v_t.site_id), v_t.kind, 'done');
  RETURN v_now;
END $fn$;
REVOKE ALL ON FUNCTION public.task_done(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.task_done(bigint) TO authenticated;
