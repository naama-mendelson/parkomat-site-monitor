-- ============================================================
-- db/tasks.postgres.sql — משימות של אתר: לביצוע → בטיפול → בוצעה, עם ההיסטוריה המלאה
-- ============================================================
-- בעלת המוצר, 06/10/2026: "יש המון משימות שנפתחות כל יום בשירות" — לקשרי לקוחות
-- ("להודיע ללקוח שהוא לא חנה כמו שצריך") ולטכני ("יש לגרז… להחליף…", בעיקר לאתר
-- ספציפי).
--
-- ⚠️ **כפתור אחד לכל אתר, ושלושה מצבים** (בעלת המוצר, 11/10/2026: "שלכל אתר יהיה כפתור
-- משימות... שלוש אופציות 1- משימה שצריך לעשות 2- משימה בתהליך 3- משימה שנעשתה... ושיראו את
-- כל ההסטוריה של המשימות"). מ-06/10 היו לכל כרטיס שני כפתורים, אחד לכל סוג; עכשיו חלון
-- אחד לאתר, והסוג — 'customer' או 'technical' — היה תכונה של המשימה, שנבחרה בהוספה.
-- (גרסה ראשונה עם שני כפתורים כלליים בכותרת נבנתה ב-06/10 ונזנחה לפני שעלתה.)
--
-- ⚠️ **בחירת הסוג הוסרה (בעלת המוצר, 12/10/2026, על "קשרי לקוחות / טכני" בטופס: "תעיף את זה").**
-- משימה חדשה נשמרת עם kind = NULL. העמודה, האילוץ והפרמטר נשארים: חבילה ישנה בדפדפן עוד שולחת
-- סוג, ו-NULL מותר בכל מקום (task_add, tasks_list, task_counts). אין כאן ברירת מחדל "טכני" — סוג
-- שאיש לא בחר הוא נתון שקרי.
--
-- ⚠️ **המצב נגזר ולא נשמר:** done_at → בוצעה; אחרת started_at → בטיפול; אחרת לביצוע.
-- עמודת "מצב" הייתה מאפשרת 'done' בלי מי ומתי — מצב שאסור שיהיה אפשר לבטא.
--
-- ⚠️ **"בוצעה" סופי** — אין פתיחה מחדש, גם לא למנהל: מה שנסגר הוא היסטוריה של השירות.
-- ⚠️ **ומשימה פתוחה אפשר למחוק לגמרי** — "X" (12/10/2026, task_delete בסוף הקובץ): המשימה וכל
-- ההיסטוריה שלה — רק מנהל, או מי שרשאי לסמן "בוצעה" (app.can_delete_task). עד אז לא היה כאן DELETE בכלל.
-- "בטיפול" הפיך ("החזרה לביצוע"; מ-12/10 — לחיצה שנייה על ⏳), ולכן ההיסטוריה
-- יושבת ב-task_history ולא בעמודות: started_* הן המצב של עכשיו, והחזרה מאפסת אותן — היומן
-- זוכר שהמשימה הייתה בטיפול, אצל מי ומתי.
--
-- ⚠️ **רק החשבון sherut@parkomat.co.il מסמן "בוצעה"** (בעלת המוצר, 11/10/2026: "רק מי
-- שמתחבר מתוך sherut@parkomat.co.il") — בשני הסוגים, וגם מנהל אחר לא. "לטיפול" ו"החזרה
-- לביצוע" — לכל איש צוות. הכלל כולו במקום **אחד**: app.can_close_task.
--
-- מוסכמות: כמו compliance.postgres.sql — טבלאות סגורות (RLS בלי מדיניות, בלי הרשאות),
-- כל גישה דרך RPC עם app.require_staff(), תאריכים TEXT ב-ISO-UTC, אירוע ב-events
-- לכל כתיבה (type='tasks') כדי שכל מסך פתוח יתעדכן.

CREATE TABLE IF NOT EXISTS tasks (
  id              BIGSERIAL PRIMARY KEY,
  client_id       UUID NOT NULL,
  kind            TEXT,                          -- NULL = בלי סוג (מ-12/10/2026 — אין בחירה)
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

-- "בטיפול" (11/10/2026) — מי לקח ומתי. נוסף אחרי היצירה, ולכן כאן ולא ב-CREATE TABLE.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS started_at TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS started_by TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS started_by_user INTEGER;
-- בלי סוג (12/10/2026). ⚠️ כאן ולא רק ב-CREATE TABLE — בייצור הטבלה קיימת וה-CREATE מדולג.
ALTER TABLE tasks ALTER COLUMN kind DROP NOT NULL;

-- ⚠️ אילוצים בשם, מחוץ ל-CREATE TABLE — אחרת שינוי עתידי לא יגיע לייצור (ראו compliance)
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_kind_chk;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_chk CHECK (kind IS NULL OR kind IN ('customer', 'technical')) NOT VALID;
ALTER TABLE tasks VALIDATE CONSTRAINT tasks_kind_chk;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_body_chk;
ALTER TABLE tasks ADD CONSTRAINT tasks_body_chk CHECK (length(btrim(body)) BETWEEN 2 AND 2000) NOT VALID;
ALTER TABLE tasks VALIDATE CONSTRAINT tasks_body_chk;
-- בוצעה = שני השדות יחד, לעולם לא אחד בלי השני
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_done_chk;
ALTER TABLE tasks ADD CONSTRAINT tasks_done_chk CHECK ((done_at IS NULL) = (done_by IS NULL)) NOT VALID;
ALTER TABLE tasks VALIDATE CONSTRAINT tasks_done_chk;
-- וכך גם בטיפול
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_started_chk;
ALTER TABLE tasks ADD CONSTRAINT tasks_started_chk CHECK ((started_at IS NULL) = (started_by IS NULL)) NOT VALID;
ALTER TABLE tasks VALIDATE CONSTRAINT tasks_started_chk;

CREATE UNIQUE INDEX IF NOT EXISTS tasks_client_uq ON tasks (client_id);
CREATE INDEX IF NOT EXISTS tasks_open_idx ON tasks (kind, created_at) WHERE done_at IS NULL;
CREATE INDEX IF NOT EXISTS tasks_site_idx ON tasks (site_id) WHERE done_at IS NULL;
CREATE INDEX IF NOT EXISTS tasks_done_idx ON tasks (done_at) WHERE done_at IS NOT NULL;

-- ============================================================
-- ההיסטוריה — שורה לכל מעבר: נפתחה, לטיפול, הוחזרה לביצוע, בוצעה
-- ============================================================
-- ⚠️ בלי ON DELETE: מחיקה ידנית של משימה שיש לה היסטוריה תיכשל בקול במקום להעלים את
-- ההיסטוריה איתה. המחיקה היחידה היא task_delete ("X"), שמוחקת את ההיסטוריה במפורש.
CREATE TABLE IF NOT EXISTS task_history (
  id            BIGSERIAL PRIMARY KEY,
  task_id       BIGINT NOT NULL REFERENCES tasks(id),
  action        TEXT NOT NULL,
  actor         TEXT NOT NULL,                   -- שם מזוהה, כמו created_by
  actor_user_id INTEGER,
  at            TEXT NOT NULL
);
ALTER TABLE task_history DROP CONSTRAINT IF EXISTS task_history_action_chk;
ALTER TABLE task_history ADD CONSTRAINT task_history_action_chk
  CHECK (action IN ('created', 'started', 'unstarted', 'done')) NOT VALID;
ALTER TABLE task_history VALIDATE CONSTRAINT task_history_action_chk;
CREATE INDEX IF NOT EXISTS task_history_task_idx ON task_history (task_id, id);

-- סגורות: RLS בלי מדיניות, ובלי הרשאות לאף תפקיד של PostgREST
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_history ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE r text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tasks', 'task_history'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
        EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM %I', pg_get_serial_sequence(t, 'id'), r);
      END IF;
    END LOOP;
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
  END LOOP;
END $$;

-- משימה שנוצרה לפני היומן (06/10–11/10) מקבלת את מה שהעמודות שלה יודעות: נפתחה, ואם
-- נסגרה — בוצעה. ⚠️ רק למשימה שאין לה אף שורה, כך שהחלה חוזרת אינה מכפילה.
INSERT INTO task_history (task_id, action, actor, actor_user_id, at)
SELECT t.id, v.action, v.actor, v.uid, v.at
  FROM tasks t
 CROSS JOIN LATERAL (VALUES (1, 'created', t.created_by, t.created_by_user, t.created_at),
                            (2, 'started', t.started_by, t.started_by_user, t.started_at),
                            (3, 'done',    t.done_by,    t.done_by_user,    t.done_at)) v(n, action, actor, uid, at)
 WHERE v.at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM task_history h WHERE h.task_id = t.id)
 ORDER BY t.id, v.n;

-- ============================================================
-- מי רשאי לסמן "בוצעה" — המקום היחיד
-- ============================================================
-- רק sherut@parkomat.co.il (11/10/2026), בשני הסוגים — p_kind נשאר כדי שכלל לפי סוג יהיה
-- שינוי כאן בלבד. שום מקום אחר לא צריך להשתנות: tasks_list מחזיר can_close לכל שורה,
-- והמסך מציג את הכפתור לפיו. ("לטיפול" ו"החזרה לביצוע" — לכל איש צוות: הם לא סוגרים.)
-- ⚠️ המייל נקרא מ-app_users לפי הזהות המאומתת (כמו is_staff), לא מהאסימון ולא מהשם המוצג:
-- full_name הוא טקסט חופשי, ומשתמש שהשם שלו "sherut@parkomat.co.il" אינו החשבון.
CREATE OR REPLACE FUNCTION app.can_close_task(p_kind text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
  SELECT app.is_staff()
     AND EXISTS (SELECT 1 FROM app_users u
                  WHERE u.supabase_uid::text = app.current_actor()
                    AND u.is_active
                    AND lower(btrim(u.email)) = 'sherut@parkomat.co.il')
$$;
REVOKE ALL ON FUNCTION app.can_close_task(text) FROM PUBLIC;

-- ============================================================
-- מי רשאי למחוק ("X") — המקום היחיד
-- ============================================================
-- בעלת המוצר, 12/10/2026: "תן אופציה למנהלים למחוק משימה". עד אז X היה באותו כלל כמו V (רק sherut@).
-- עכשיו: כל מנהל — ובנוסף מי שרשאי לסמן בוצעה, כך ש-sherut@ מוחק גם אם יורד יום אחד מדרגת מנהל.
-- ⚠️ הדרגה מ-app_users (app.is_manager → current_app_role), לא מהאסימון: מנהל שהורד לבקר מאבד את
-- המחיקה מיד, לא כשהאסימון שלו פג. V ("בוצעה") לא השתנה — רק sherut@.
CREATE OR REPLACE FUNCTION app.can_delete_task(p_kind text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
  SELECT app.is_staff() AND (app.is_manager() OR app.can_close_task(p_kind))
$$;
REVOKE ALL ON FUNCTION app.can_delete_task(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.task_event(p_code text, p_kind text, p_action text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
  SELECT app.record_write_event(COALESCE(p_code, '*'), 'tasks',
    jsonb_build_object('type', 'tasks', 'code', p_code, 'kind', p_kind, 'action', p_action));
$$;
REVOKE ALL ON FUNCTION app.task_event(text, text, text) FROM PUBLIC;

-- שורת היסטוריה. ⚠️ כאן ולא ב-audit_log: audit_log קריא לכל משתמש פעיל ומחזיק מזהים בלבד.
CREATE OR REPLACE FUNCTION app.task_log(p_task bigint, p_action text, p_actor text, p_at text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
  INSERT INTO task_history (task_id, action, actor, actor_user_id, at)
  VALUES (p_task, p_action, p_actor, app.current_app_user(), p_at);
$$;
REVOKE ALL ON FUNCTION app.task_log(bigint, text, text, text) FROM PUBLIC;

-- ============================================================
-- קריאה
-- ============================================================
-- ⚠️ jsonb יחיד ולא RETURNS TABLE: PostgREST חותך ב-1,000 שורות בשקט, ומשימות שבוצעו
-- רק מצטברות. כאן: כל הפתוחות (לביצוע ובטיפול, לפי state), ומאלה שבוצעו — p_done_limit
-- האחרונות (NULL = כולן: "שיראו את כל ההסטוריה"), ו-done_total, כך שהמסך יודע כמה יש.
-- לכל משימה — history: כל המעברים שלה, מהראשון לאחרון.
-- ⚠️ המפתחות open / done / done_total נשארו כמו לפני שלושת המצבים: חבילה ישנה בדפדפן
-- ממשיכה לעבוד (משימה בטיפול נראית אצלה פתוחה, וזה נכון).
DROP FUNCTION IF EXISTS public.tasks_list(text, text);
CREATE OR REPLACE FUNCTION public.tasks_list(p_kind text DEFAULT NULL, p_site_code text DEFAULT NULL,
                                             p_done_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_site integer;
  v_code text := NULLIF(btrim(COALESCE(p_site_code, '')), '');
  -- פעם אחת לסוג, לא לכל שורה (can_close_task קורא את app_users)
  v_close_c boolean;
  v_close_t boolean;
  v_close_n boolean;
  v_del_c boolean;
  v_del_t boolean;
  v_del_n boolean;
BEGIN
  PERFORM app.require_staff();
  IF p_kind IS NOT NULL AND p_kind NOT IN ('customer', 'technical') THEN
    RAISE EXCEPTION 'סוג משימה לא מוכר: %', p_kind USING ERRCODE = 'check_violation';
  END IF;
  IF p_done_limit IS NOT NULL AND p_done_limit < 0 THEN
    RAISE EXCEPTION 'מספר משימות לא תקין: %', p_done_limit USING ERRCODE = 'check_violation';
  END IF;
  IF v_code IS NOT NULL THEN
    SELECT s.id INTO v_site FROM sites s WHERE s.code = v_code;
    IF v_site IS NULL THEN RAISE EXCEPTION 'אתר לא נמצא: %', v_code USING ERRCODE = 'PT404'; END IF;
  END IF;
  v_close_c := app.can_close_task('customer');
  v_close_t := app.can_close_task('technical');
  v_close_n := app.can_close_task(NULL);
  v_del_c := app.can_delete_task('customer');
  v_del_t := app.can_delete_task('technical');
  v_del_n := app.can_delete_task(NULL);
  RETURN (
    WITH f AS (
      SELECT t.*, s.code AS cur_code, s.site_name AS cur_name
        FROM tasks t LEFT JOIN sites s ON s.id = t.site_id
       WHERE (p_kind IS NULL OR t.kind = p_kind)
         AND (v_site IS NULL OR t.site_id = v_site)
    ),
    -- ⚠️ החיתוך לפני בניית השורות: ההיסטוריה נשלפת רק למשימות שנשלחות
    pick AS (
      SELECT f.*, false AS is_done FROM f WHERE f.done_at IS NULL
      UNION ALL
      (SELECT f.*, true FROM f WHERE f.done_at IS NOT NULL
        ORDER BY f.done_at DESC, f.id DESC LIMIT p_done_limit)
    ),
    row_of AS (
      SELECT p.id, p.is_done, p.done_at, p.created_at,
             jsonb_build_object('id', p.id, 'kind', p.kind,
               'state', CASE WHEN p.done_at IS NOT NULL THEN 'done'
                             WHEN p.started_at IS NOT NULL THEN 'in_progress' ELSE 'todo' END,
               'site_code', COALESCE(p.cur_code, p.site_code), 'site_name', p.cur_name,
               'body', p.body, 'created_by', p.created_by, 'created_at', p.created_at,
               'started_at', p.started_at, 'started_by', p.started_by,
               'done_at', p.done_at, 'done_by', p.done_by,
               'can_close', CASE p.kind WHEN 'customer' THEN v_close_c WHEN 'technical' THEN v_close_t ELSE v_close_n END,
               -- "X" — כלל משלו (12/10/2026: גם מנהלים); המסך צובע ומסביר לפיו
               'can_delete', CASE p.kind WHEN 'customer' THEN v_del_c WHEN 'technical' THEN v_del_t ELSE v_del_n END,
               'history', COALESCE((SELECT jsonb_agg(jsonb_build_object('action', h.action, 'by', h.actor, 'at', h.at)
                                                     ORDER BY h.at, h.id)
                                      FROM task_history h WHERE h.task_id = p.id), '[]'::jsonb)) AS j
        FROM pick p
    )
    SELECT jsonb_build_object(
      -- "טבלה צומחת": הוותיקה למעלה, החדשה נוספת בסוף
      'open', COALESCE((SELECT jsonb_agg(r.j ORDER BY r.created_at, r.id) FROM row_of r WHERE NOT r.is_done), '[]'::jsonb),
      'done', COALESCE((SELECT jsonb_agg(r.j ORDER BY r.done_at DESC, r.id DESC) FROM row_of r WHERE r.is_done), '[]'::jsonb),
      'done_total', (SELECT count(*) FROM f WHERE f.done_at IS NOT NULL)
    )
  );
END $fn$;
REVOKE ALL ON FUNCTION public.tasks_list(text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tasks_list(text, text, integer) TO authenticated;

-- מספרי המשימות הפתוחות (לביצוע + בטיפול) — שורה לכל אתר×סוג; הכרטיס מחבר את כל השורות של אתר.
-- ⚠️ משימה בלי סוג (מ-12/10) מגיעה בשורה עם kind = 'none', **לא NULL**: מסך שעוד מריץ את החבילה
-- הקודמת (קיר, טאב פתוח, PWA — sw.js לא מרענן) סופר ב-countsBySite הישן רק שורה שיש לה סוג
-- (`if (!r.kind) continue`), כך שעם NULL כל משימה חדשה הייתה נעלמת מהמספר בכרטיס עד רענון. החבילה
-- החדשה מתעלמת מהסוג ממילא. (נמצא בסקירה לפני הפריסה, 12/10/2026.)
-- ⚠️ לעולם אינה זורקת: מי שאינו צוות מקבל אפס שורות (כמו site_compliance) — הכפתורים
-- נטענים יחד עם רשימת האתרים, ושגיאה כאן לא תפיל אותה.
DROP FUNCTION IF EXISTS public.task_counts();
CREATE FUNCTION public.task_counts()
RETURNS TABLE (kind text, site_id integer, open integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
  SELECT COALESCE(t.kind, 'none'), t.site_id, count(*)::int
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
  v_now text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_site integer;
  v_id bigint;
BEGIN
  -- NULL = בלי סוג (12/10/2026); סוג שנשלח חייב להיות מוכר
  IF p_kind IS NOT NULL AND p_kind NOT IN ('customer', 'technical') THEN
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
  VALUES (v_client, p_kind, v_site, v_code, v_body, v_actor, app.current_app_user(), v_now)
  RETURNING tasks.id INTO v_id;
  PERFORM app.task_log(v_id, 'created', v_actor, v_now);
  -- ⚠️ ביומן: מזהים בלבד, לא גוף המשימה (audit_log קריא לכל משתמש פעיל)
  PERFORM app.record_write_audit('task.add', v_actor, app.current_app_role(), 'task', v_id::text,
    jsonb_build_object('kind', p_kind, 'site_code', v_code));
  PERFORM app.task_event(v_code, p_kind, 'add');
  RETURN v_id;
END $fn$;
REVOKE ALL ON FUNCTION public.task_add(text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.task_add(text, text, text, uuid) TO authenticated;

-- "לטיפול": מי ומתי. ⚠️ משימה שכבר בטיפול — מחזירים את הקיים ולא דורסים את מי שלקח
-- (שני אנשים שלחצו יחד: הראשון לקח, והשני רואה אצל מי). משימה שבוצעה — PT409.
CREATE OR REPLACE FUNCTION public.task_start(p_id bigint)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_staff();
  v_t tasks%ROWTYPE;
  v_now text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  SELECT * INTO v_t FROM tasks t WHERE t.id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'המשימה לא נמצאה' USING ERRCODE = 'PT404'; END IF;
  IF v_t.done_at IS NOT NULL THEN RAISE EXCEPTION 'המשימה כבר בוצעה' USING ERRCODE = 'PT409'; END IF;
  IF v_t.started_at IS NOT NULL THEN RETURN v_t.started_at; END IF;
  UPDATE tasks SET started_at = v_now, started_by = v_actor, started_by_user = app.current_app_user()
   WHERE tasks.id = p_id;
  PERFORM app.task_log(p_id, 'started', v_actor, v_now);
  PERFORM app.record_write_audit('task.start', v_actor, app.current_app_role(), 'task', p_id::text,
    jsonb_build_object('kind', v_t.kind, 'site_code', v_t.site_code));
  PERFORM app.task_event((SELECT s.code FROM sites s WHERE s.id = v_t.site_id), v_t.kind, 'start');
  RETURN v_now;
END $fn$;
REVOKE ALL ON FUNCTION public.task_start(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.task_start(bigint) TO authenticated;

-- "החזרה לביצוע": בטיפול → לביצוע. העמודות מתאפסות, וההיסטוריה זוכרת. משימה שעוד לא
-- בטיפול — כלום (אידמפוטנטי); משימה שבוצעה — PT409 ("בוצעה" סופי).
CREATE OR REPLACE FUNCTION public.task_unstart(p_id bigint)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_staff();
  v_t tasks%ROWTYPE;
  v_now text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  SELECT * INTO v_t FROM tasks t WHERE t.id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'המשימה לא נמצאה' USING ERRCODE = 'PT404'; END IF;
  IF v_t.done_at IS NOT NULL THEN RAISE EXCEPTION 'המשימה כבר בוצעה' USING ERRCODE = 'PT409'; END IF;
  IF v_t.started_at IS NULL THEN RETURN; END IF;
  UPDATE tasks SET started_at = NULL, started_by = NULL, started_by_user = NULL WHERE tasks.id = p_id;
  PERFORM app.task_log(p_id, 'unstarted', v_actor, v_now);
  PERFORM app.record_write_audit('task.unstart', v_actor, app.current_app_role(), 'task', p_id::text,
    jsonb_build_object('kind', v_t.kind, 'site_code', v_t.site_code));
  PERFORM app.task_event((SELECT s.code FROM sites s WHERE s.id = v_t.site_id), v_t.kind, 'unstart');
END $fn$;
REVOKE ALL ON FUNCTION public.task_unstart(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.task_unstart(bigint) TO authenticated;

-- "בוצעה": מי ומתי — מלביצוע או מבטיפול. אידמפוטנטי: סימון שני מחזיר את הסימון הראשון ולא
-- דורס את שמו. started_* נשארות: המשימה הייתה בטיפול, וזה חלק ממה שקרה לה.
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
  PERFORM app.task_log(p_id, 'done', v_actor, v_now);
  PERFORM app.record_write_audit('task.done', v_actor, app.current_app_role(), 'task', p_id::text,
    jsonb_build_object('kind', v_t.kind, 'site_code', v_t.site_code));
  PERFORM app.task_event((SELECT s.code FROM sites s WHERE s.id = v_t.site_id), v_t.kind, 'done');
  RETURN v_now;
END $fn$;
REVOKE ALL ON FUNCTION public.task_done(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.task_done(bigint) TO authenticated;

-- "X": מחיקה לגמרי — המשימה וכל ההיסטוריה שלה (בעלת המוצר, 12/10/2026: "אני רוצה שיהיה X ו-V ליד
-- כל משימה", ועל ה-X בחרה "מחיקה לגמרי" על פני "ביטול" שנשאר בהיסטוריה).
-- ⚠️ מי רשאי — app.can_delete_task: כל מנהל, ו-sherut@ (12/10/2026: "תן אופציה למנהלים למחוק משימה"; עד
-- אז — אותו כלל כמו "בוצעה", רק sherut@).
-- ⚠️ רק משימה פתוחה: "בוצעה" סופי, והיסטוריית השירות לא נמחקת דרך מסך שהתיישן (מישהו סימן V בינתיים).
-- ⚠️ ה-FK מההיסטוריה נשאר בלי ON DELETE — מחיקה ידנית של משימה עדיין נכשלת בקול. כאן ההיסטוריה
-- נמחקת במפורש, באותה טרנזקציה.
-- נשאר אחריה: שורת audit_log אחת (מזהה בלבד, בלי גוף — כמו בכל פעולה), ואירוע לרענון המסכים.
-- משימה שכבר איננה — false ולא שגיאה: לחיצה כפולה, או שני מסכים, מגיעות לאותה תוצאה.
CREATE OR REPLACE FUNCTION public.task_delete(p_id bigint)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_staff();
  v_t tasks%ROWTYPE;
BEGIN
  SELECT * INTO v_t FROM tasks t WHERE t.id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF NOT app.can_delete_task(v_t.kind) THEN
    RAISE EXCEPTION 'אין הרשאה למחוק משימה זו' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_t.done_at IS NOT NULL THEN RAISE EXCEPTION 'המשימה כבר בוצעה' USING ERRCODE = 'PT409'; END IF;
  DELETE FROM task_history h WHERE h.task_id = p_id;
  DELETE FROM tasks WHERE tasks.id = p_id;
  PERFORM app.record_write_audit('task.delete', v_actor, app.current_app_role(), 'task', p_id::text,
    jsonb_build_object('kind', v_t.kind, 'site_code', v_t.site_code));
  PERFORM app.task_event((SELECT s.code FROM sites s WHERE s.id = v_t.site_id), v_t.kind, 'delete');
  RETURN true;
END $fn$;
REVOKE ALL ON FUNCTION public.task_delete(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.task_delete(bigint) TO authenticated;
