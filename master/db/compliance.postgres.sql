-- ============================================================
-- db/compliance.postgres.sql — בודק מוסמך, תחזוקה מונעת, והרמזור לכל אתר
-- ============================================================
-- שתי לשוניות בחלון האתר ושתי נורות בכרטיס:
--   • **בודק מוסמך** — תסקירי בודק (PDF), הליקויים שבהם, וסגירתם בראיה.
--   • **תחזוקה מונעת** — ביקור לפי רשימת בדיקה, עם צילומים וחתימה.
--
-- מאז 06/10/2026 הדשבורד באתר החי קורא לו — הבודק המוסמך בלבד; התחזוקה המונעת
-- בנויה ומוסתרת (PM_ENABLED ב-dashboard/src/utils/compliance.js). הוא מוחל רק דרך
-- `tools/apply-sql.js` (master אינו רץ), ושער ההשוואה מכסה אותו.
--
-- ============================================================
-- ⚠️ איך משנים טבלה כאן אחר כך — קראו לפני שנוגעים
-- ============================================================
--   • **לעולם אל תערכו CHECK בתוך CREATE TABLE.** `CREATE TABLE IF NOT EXISTS`
--     מדלג על כל הטבלה כשהיא קיימת, ולכן השינוי לא יגיע לייצור לעולם —
--     והקובץ ימשיך "לעבור" בלי לומר דבר.
--   • במקום זה, בסוף החלק של הטבלה:
--       ALTER TABLE t DROP CONSTRAINT IF EXISTS x;
--       ALTER TABLE t ADD CONSTRAINT x CHECK (...) NOT VALID;
--     ואז, **כפקודה נפרדת**: ALTER TABLE t VALIDATE CONSTRAINT x;
--   • עמודה חדשה: `ALTER TABLE t ADD COLUMN IF NOT EXISTS ...`.
--   • ההרצה היבשה של `tools/apply-sql.js` משווה מעתה גם אילוצים, טריגרים,
--     RLS, הרשאות ואינדקסים של הטבלאות האלה (`CON_SQL` ב-tools/lib/sql-shape.js),
--     ולכן שינוי שדולג יופיע שם כפער — לא ייעלם בשקט.
--
-- ============================================================
-- מוסכמות הקובץ
-- ============================================================
--   • תאריך לוח שנה = DATE; חותמת אירוע = TEXT ב-ISO-UTC, כמו בכל הפרויקט.
--   • כל פונקציה: `SET search_path = public, app, pg_temp`.
--   • כל פונקציית plpgsql עם RETURNS TABLE: `#variable_conflict use_column`,
--     וכל עמודה מסויגת.
--   • ⚠️ **כל RETURNS TABLE מקדים DROP FUNCTION IF EXISTS** ואחריו REVOKE/GRANT.
--     הוספת עמודה אינה ניתנת ל-CREATE OR REPLACE, והשגיאה עוצרת את כל הקובץ —
--     כלומר גם את כל מה שאחריה (התקדים: writes.postgres.sql, delete_site).
--   • כל אילוץ נושא שם — אחרת אין דרך להחליף אותו בתבנית שלמעלה.
--   • אין כאן תזמוני pg_cron. ההתראות (P5) והגיזום יגיעו בנפרד.
--
-- ============================================================
-- ⚠️ D2: כל הטבלאות כאן **סגורות**
-- ============================================================
-- RLS מופעל, **אין אף מדיניות ואין אף הרשאה** — לא ל-anon, לא ל-authenticated
-- ולא ל-service_role. זה מכוון, וזה מה שהמפרט קורא לו D2:
--   (א) שום `select("*")` מהדפדפן לא ימשוך את `data_b64` (עד 14MB לשורה);
--   (ב) הסוכנים וזהות הקליטה נעצרים בשער אחד (`app.require_staff()`);
--   (ג) כל קריאה היא RPC חסום-גודל.
-- כל הקריאות והכתיבות עוברות דרך פונקציות SECURITY DEFINER למטה.
-- ⚠️ ואף אחת מהטבלאות האלה לא תצורף ל-`supabase_realtime`.

-- ============================================================
-- 1.1 עזרים
-- ============================================================

-- צוות אנושי בלבד. ⚠️ שני התנאים חיים: בייצור לזהות הקליטה (intake) יש שורת operator פעילה
-- ב-app_users (provision_app_user יוצר שורה לכל משתמש auth) — ההערה ב-service-calls.postgres.sql:27-30
-- אינה נכונה. אל תמחקו את NOT app.is_intake_client() כ"קוד מת".
CREATE OR REPLACE FUNCTION app.is_staff() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM app_users u
                  WHERE u.supabase_uid::text = app.current_actor()
                    AND u.is_active AND u.role IN ('manager','operator'))
     AND NOT app.is_intake_client();
$$;
REVOKE ALL ON FUNCTION app.is_staff() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_staff() TO authenticated;

CREATE OR REPLACE FUNCTION app.require_staff() RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
BEGIN
  IF app.current_actor() IS NULL THEN
    RAISE EXCEPTION 'נדרשת הזדהות' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT app.is_staff() THEN
    RAISE EXCEPTION 'אין הרשאה למסך זה' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN app.actor_display_name();
END $fn$;
REVOKE ALL ON FUNCTION app.require_staff() FROM PUBLIC;

-- "היום" הוא היום בישראל — לא CURRENT_DATE (UTC). ב-22:30Z כבר מחר כאן.
CREATE OR REPLACE FUNCTION app.compliance_today_at(p_ts timestamptz) RETURNS date
LANGUAGE sql STABLE AS $$ SELECT (p_ts AT TIME ZONE 'Asia/Jerusalem')::date $$;
CREATE OR REPLACE FUNCTION app.compliance_today() RETURNS date
LANGUAGE sql STABLE AS $$ SELECT app.compliance_today_at(now()) $$;
CREATE OR REPLACE FUNCTION app.compliance_now_iso() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

CREATE OR REPLACE FUNCTION app.compliance_setting_int(p_key text, p_default integer) RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE v integer;
BEGIN
  SELECT NULLIF(s.value,'')::integer INTO v FROM settings s WHERE s.key = p_key;
  RETURN COALESCE(v, p_default);
EXCEPTION WHEN others THEN RETURN p_default;
END $fn$;
REVOKE ALL ON FUNCTION app.compliance_setting_int(text, integer) FROM PUBLIC;

-- NULL = אין go-live: "אין תסקיר" נשאר אפור. מתאריך זה ואילך — אדום.
CREATE OR REPLACE FUNCTION app.compliance_go_live() RETURNS date
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE v date;
BEGIN
  SELECT NULLIF(s.value,'')::date INTO v FROM settings s WHERE s.key = 'compliance_go_live';
  RETURN v;
EXCEPTION WHEN others THEN RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION app.compliance_go_live() FROM PUBLIC;

-- ⚠️ ההגדרה היחידה של צבעי הרמזור. אין ספים בדשבורד ואין ספים בהתראות —
-- כולם קוראים לפונקציה הזו (D10). שינוי סף = שינוי כאן בלבד.
CREATE OR REPLACE FUNCTION app.compliance_warn_days() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 30 $$;
CREATE OR REPLACE FUNCTION app.pm_interval_months()   RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 6 $$;
CREATE OR REPLACE FUNCTION app.compliance_light(p_due date, p_today date, p_warn integer, p_go_live date)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_due IS NULL THEN
                CASE WHEN p_go_live IS NOT NULL AND p_today >= p_go_live THEN 'expired' ELSE 'none' END
              WHEN p_due < p_today THEN 'expired'
              WHEN p_due - p_today <= p_warn THEN 'soon'
              ELSE 'ok' END
$$;
-- ⚠️ שבעה מצבים לנורת הבודק (בעלת המוצר, 06/10/2026), מהחמור: expired (אדום) > overdue (כתום)
-- > awaiting (צהוב חזק) > soon (צהוב) > fixing (ירוק) > ok (שחור-לבן) > none (אפור).
-- התחזוקה המונעת והתוקף הטהור משתמשים רק ב-ok/soon/expired/none — הסדר היחסי שלהם נשמר.
CREATE OR REPLACE FUNCTION app.light_rank(p text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p WHEN 'expired' THEN 6 WHEN 'overdue' THEN 5 WHEN 'awaiting' THEN 4 WHEN 'soon' THEN 3
                WHEN 'fixing' THEN 2 WHEN 'ok' THEN 1 ELSE 0 END $$;
CREATE OR REPLACE FUNCTION app.cycle_rank(p text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p WHEN 'open' THEN 4 WHEN 'awaiting_clean' THEN 3 WHEN 'review' THEN 2 WHEN 'clean' THEN 1 ELSE 0 END $$;

-- בדיקת base64 על טקסט שכבר חולץ פעם אחת (לא jsonb — 14MB לא מחולצים ארבע פעמים).
-- ⚠️ ה-mime שהלקוח מצהיר עליו אינו ראיה: בודקים את הבתים הראשונים (magic).
CREATE OR REPLACE FUNCTION app.b64_check(p_mime text, p_data text, p_allowed text[], p_max_bytes integer, p_what text)
RETURNS integer LANGUAGE plpgsql IMMUTABLE SET search_path = public, app, pg_temp AS $fn$
DECLARE v_bytes integer;
BEGIN
  IF p_mime IS NULL OR NOT (p_mime = ANY (p_allowed)) THEN
    RAISE EXCEPTION 'סוג קובץ לא נתמך (%)', p_what USING ERRCODE = 'check_violation'; END IF;
  IF COALESCE(p_data,'') = '' THEN RAISE EXCEPTION 'קובץ ריק (%)', p_what USING ERRCODE = 'check_violation'; END IF;
  IF p_data !~ '^[A-Za-z0-9+/]+={0,2}$' THEN
    RAISE EXCEPTION 'הקובץ אינו בקידוד תקין (%)', p_what USING ERRCODE = 'check_violation'; END IF;
  IF NOT ((p_mime = 'application/pdf' AND left(p_data,7)  = 'JVBERi0')
       OR (p_mime = 'image/jpeg'      AND left(p_data,4)  = '/9j/')
       OR (p_mime = 'image/webp'      AND left(p_data,5)  = 'UklGR')
       OR (p_mime = 'image/png'       AND left(p_data,11) = 'iVBORw0KGgo')) THEN
    RAISE EXCEPTION 'תוכן הקובץ אינו תואם לסוגו (%)', p_what USING ERRCODE = 'check_violation'; END IF;
  v_bytes := (length(p_data) * 3) / 4
           - CASE WHEN right(p_data,2) = '==' THEN 2 WHEN right(p_data,1) = '=' THEN 1 ELSE 0 END;
  IF v_bytes > p_max_bytes THEN
    RAISE EXCEPTION 'הקובץ גדול מדי (%: מעל % KB) — לסרוק ב-150 dpi בגווני אפור', p_what, p_max_bytes / 1024
      USING ERRCODE = 'check_violation'; END IF;
  RETURN v_bytes;
END $fn$;
REVOKE ALL ON FUNCTION app.b64_check(text, text, text[], integer, text) FROM PUBLIC;

-- מחיקה קשיחה (purge, prune) מסמנת את עצמה כדי לעבור את הטריגרים שמקבעים ראיות.
-- ⚠️ set_config(..., true) — מקומי לטרנזקציה בלבד. לעולם לא ברמת session.
CREATE OR REPLACE FUNCTION app.compliance_purging() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.compliance_purge', true), '') = 'on' $$;

-- הקוד העדכני של האתר (אחרי update_site), ואם נמחק — ה-snapshot.
CREATE OR REPLACE FUNCTION app.compliance_code(p_site_id integer, p_snapshot text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
  SELECT COALESCE((SELECT s.code FROM sites s WHERE s.id = p_site_id), p_snapshot) $$;
REVOKE ALL ON FUNCTION app.compliance_code(integer, text) FROM PUBLIC;

-- ⚠️ מנהל **שעבר את הגורם השני** כשהוא נדרש — אותו תנאי בדיוק כמו app.require_mfa().
-- הענפים ש"רק מנהל" רואה בהם (קובץ של תסקיר שנמחק, ביקור שנמחק, זריקת טיוטה של
-- אחר) הם כוח של מנהל; is_manager() לבדו היה נותן אותם לסשן aal1 שכל
-- require_manager() באותו קובץ דוחה.
CREATE OR REPLACE FUNCTION app.compliance_verified_manager() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
  SELECT app.is_manager()
     AND (NOT app.mfa_required() OR NOT app.came_from_token() OR COALESCE(app.current_aal(), 'aal1') = 'aal2')
$$;
REVOKE ALL ON FUNCTION app.compliance_verified_manager() FROM PUBLIC;

-- טקסט חופשי עם תקרה. ⚠️ D2(ג): כל קריאה חסומת-גודל — ושדה בלי תקרה שחוזר
-- ב-inspection_site / pm_site הופך כל רשימה לכמה MB לכל איש צוות.
CREATE OR REPLACE FUNCTION app.compliance_text(p text, p_max integer, p_what text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = public, app, pg_temp AS $fn$
DECLARE v text := NULLIF(btrim(COALESCE(p,'')),'');
BEGIN
  IF v IS NOT NULL AND length(v) > p_max THEN
    RAISE EXCEPTION '% ארוך מדי (עד % תווים)', p_what, p_max USING ERRCODE = 'check_violation'; END IF;
  RETURN v;
END $fn$;
REVOKE ALL ON FUNCTION app.compliance_text(text, integer, text) FROM PUBLIC;

-- סיבה: 2–500 תווים. p_required=false → NULL מותר (ואז הקורא בוחר ברירת מחדל).
CREATE OR REPLACE FUNCTION app.compliance_reason(p text, p_required boolean DEFAULT true) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = public, app, pg_temp AS $fn$
DECLARE v text := NULLIF(btrim(COALESCE(p,'')),'');
BEGIN
  IF v IS NULL AND NOT p_required THEN RETURN NULL; END IF;
  IF v IS NULL OR length(v) < 2 THEN RAISE EXCEPTION 'חובה לציין סיבה' USING ERRCODE = 'check_violation'; END IF;
  IF length(v) > 500 THEN RAISE EXCEPTION 'הסיבה ארוכה מדי (עד 500 תווים)' USING ERRCODE = 'check_violation'; END IF;
  RETURN v;
END $fn$;
REVOKE ALL ON FUNCTION app.compliance_reason(text, boolean) FROM PUBLIC;

-- ============================================================
-- 1.2 בודק מוסמך — טבלאות
-- ============================================================

-- ⚠️ תסקיר שייך ל**מתקן**, לא לאתר ("מספר מתקן" בראש התסקיר).
-- באתר עם שני מתקנים, תסקיר בתוקף של אחד לא יסתיר תסקיר שפג של השני:
-- נורת האתר = המתקן הגרוע ביותר.
CREATE TABLE IF NOT EXISTS inspection_machines (
  site_id        INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  machine_key    TEXT NOT NULL,
  label          TEXT,
  created_at     TEXT NOT NULL,
  retired_at     TEXT, retired_by TEXT, retired_reason TEXT,
  CONSTRAINT inspection_machines_pk PRIMARY KEY (site_id, machine_key),
  CONSTRAINT inspection_machines_key_shape CHECK (length(machine_key) BETWEEN 1 AND 40 AND machine_key = btrim(machine_key)),
  CONSTRAINT inspection_machines_retired_shape CHECK ((retired_at IS NULL) = (retired_by IS NULL)
                                                     AND (retired_at IS NULL OR length(btrim(retired_reason)) >= 2))
);

-- ⚠️ purged_at: מחיקת הבתים של קובץ שכל התסקירים שלו נמחקו (compliance_purge).
-- השורה עצמה נשארת, כי inspection_reports.file_id מצביע עליה (NOT NULL); הבתים
-- מוחלפים בכותרת PDF ריקה ('JVBERi0=' = "%PDF-") שעוברת את אילוץ ה-magic.
CREATE TABLE IF NOT EXISTS inspection_files (
  id          BIGSERIAL PRIMARY KEY,
  site_id     INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  site_code   TEXT NOT NULL,
  mime        TEXT NOT NULL CONSTRAINT inspection_files_mime CHECK (mime = 'application/pdf'),
  file_name   TEXT,
  data_b64    TEXT NOT NULL,
  byte_size   INTEGER NOT NULL CONSTRAINT inspection_files_size_pos CHECK (byte_size > 0),
  content_md5 TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  purged_at   TEXT, purged_by TEXT,
  CONSTRAINT inspection_files_magic CHECK (left(data_b64,7) = 'JVBERi0' AND length(data_b64) <= 13981016)  -- 10 MB ceiling
);
CREATE INDEX IF NOT EXISTS idx_inspection_files_site_md5 ON inspection_files(site_id, content_md5);

CREATE TABLE IF NOT EXISTS inspection_reports (
  id                  BIGSERIAL PRIMARY KEY,
  client_id           UUID NOT NULL,
  site_id             INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  site_code           TEXT NOT NULL,
  machine_key         TEXT NOT NULL,
  file_id             BIGINT NOT NULL REFERENCES inspection_files(id),       -- כמה תסקירים יכולים לחלוק PDF אחד
  kind                TEXT NOT NULL CONSTRAINT inspection_reports_kind CHECK (kind IN ('periodic','followup')),
  followup_of         BIGINT REFERENCES inspection_reports(id),
  inspected_on        DATE NOT NULL,
  valid_until         DATE,                                                 -- NULL רק בבדיקה חוזרת שיורשת
  validity_source     TEXT NOT NULL,
  declared_clean      BOOLEAN NOT NULL,
  report_number       TEXT, inspector_name TEXT, inspector_license TEXT, machine_no TEXT,
  parse_meta          JSONB,       -- {parser, confidence, notes:[code], extract, parsed:{inspectedAt,validUntil,validitySource}}
  note                TEXT,
  uploaded_by         TEXT NOT NULL,
  uploaded_by_user_id INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL,
  updated_at TEXT, updated_by TEXT,
  deleted_at TEXT, deleted_by TEXT, deleted_reason TEXT,
  CONSTRAINT inspection_reports_client_uq UNIQUE (client_id),
  CONSTRAINT inspection_reports_followup_shape CHECK ((kind = 'periodic') = (followup_of IS NULL)),
  -- ⚠️ D5: תוקף נלקח מהמסמך, ולעולם אינו "ברירת מחדל שנה". בדיקה חוזרת בלי
  -- תוקף משלה שומרת NULL ('inherited') ונפתרת מול האב בזמן קריאה — כך
  -- שעריכת תאריך האב מזיזה אותה איתו.
  CONSTRAINT inspection_reports_validity_shape CHECK (
       (kind = 'periodic' AND valid_until IS NOT NULL AND validity_source IN ('document','next_inspection','manual'))
    OR (kind = 'followup' AND valid_until IS NULL AND validity_source = 'inherited')
    OR (kind = 'followup' AND valid_until IS NOT NULL AND validity_source IN ('document','next_inspection','manual'))),
  CONSTRAINT inspection_reports_validity_range CHECK (valid_until IS NULL
    OR (valid_until > inspected_on AND valid_until <= inspected_on + 800)),
  CONSTRAINT inspection_reports_deleted_shape CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)
    AND (deleted_at IS NULL OR length(btrim(deleted_reason)) >= 2))
);
CREATE INDEX IF NOT EXISTS idx_inspection_reports_site ON inspection_reports(site_id, machine_key, inspected_on DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_inspection_reports_followup ON inspection_reports(followup_of) WHERE followup_of IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inspection_reports_file ON inspection_reports(file_id);

CREATE TABLE IF NOT EXISTS inspection_defects (
  id                  BIGSERIAL PRIMARY KEY,
  report_id           BIGINT NOT NULL REFERENCES inspection_reports(id) ON DELETE CASCADE,
  seq                 INTEGER NOT NULL,
  body                TEXT NOT NULL CONSTRAINT inspection_defects_body CHECK (length(btrim(body)) BETWEEN 2 AND 2000),
  urgent              BOOLEAN NOT NULL DEFAULT FALSE,
  due_on              DATE,
  status              TEXT NOT NULL DEFAULT 'open' CONSTRAINT inspection_defects_status CHECK (status IN ('open','done')),
  closure_no          INTEGER NOT NULL DEFAULT 1 CONSTRAINT inspection_defects_closure_pos CHECK (closure_no >= 1),
  done_at TEXT, done_by TEXT,
  done_by_user_id     INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
  done_by_name        TEXT,
  done_note           TEXT CONSTRAINT inspection_defects_note CHECK (done_note IS NULL OR length(done_note) <= 1000),
  done_photo_id       BIGINT,
  closed_by_report_id BIGINT REFERENCES inspection_reports(id),
  done_request_id     UUID,
  created_at          TEXT NOT NULL,
  deleted_at TEXT, deleted_by TEXT, deleted_reason TEXT,
  -- ⚠️ מוחלף ב-1.4א (06/10/2026): תמונה אינה חובה עוד. ההגדרה כאן נשארת כי CREATE TABLE IF NOT
  -- EXISTS אינו נוגע בטבלה קיימת — מה שקובע הוא ה-DROP/ADD שם.
  CONSTRAINT inspection_defects_done_shape CHECK (
       (status = 'open' AND done_at IS NULL AND done_by IS NULL AND done_by_name IS NULL
        AND done_photo_id IS NULL AND closed_by_report_id IS NULL AND done_request_id IS NULL)
    OR (status = 'done' AND done_at IS NOT NULL AND done_by IS NOT NULL AND length(btrim(done_by_name)) >= 2
        AND ((done_photo_id IS NOT NULL) <> (closed_by_report_id IS NOT NULL)))),
  CONSTRAINT inspection_defects_deleted_shape CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)
    AND (deleted_at IS NULL OR (status = 'open' AND length(btrim(deleted_reason)) >= 2)))
);
CREATE INDEX IF NOT EXISTS idx_inspection_defects_report ON inspection_defects(report_id, seq);

CREATE TABLE IF NOT EXISTS inspection_defect_photos (
  id          BIGSERIAL PRIMARY KEY,
  client_id   UUID NOT NULL,
  defect_id   BIGINT NOT NULL REFERENCES inspection_defects(id) ON DELETE CASCADE,
  closure_no  INTEGER NOT NULL,
  mime        TEXT NOT NULL CONSTRAINT inspection_defect_photos_mime CHECK (mime IN ('image/jpeg','image/webp')),
  data_b64    TEXT NOT NULL,
  thumb_b64   TEXT,
  byte_size   INTEGER NOT NULL CONSTRAINT inspection_defect_photos_size_pos CHECK (byte_size > 0),
  uploaded_by TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  purged_at   TEXT,
  CONSTRAINT inspection_defect_photos_client_uq UNIQUE (client_id),
  CONSTRAINT inspection_defect_photos_owner UNIQUE (defect_id, closure_no, id),
  CONSTRAINT inspection_defect_photos_magic CHECK (
       (mime = 'image/jpeg' AND left(data_b64,4) = '/9j/')
    OR (mime = 'image/webp' AND left(data_b64,5) = 'UklGR')),
  CONSTRAINT inspection_defect_photos_size CHECK (length(data_b64) <= 1398104
    AND (thumb_b64 IS NULL OR (left(thumb_b64,4) = '/9j/' AND length(thumb_b64) <= 54616)))
);

-- ⚠️ D8: המפתח המורכב מבטיח שהתמונה שייכת ל**ליקוי הזה** ול**סגירה הנוכחית**.
-- גם UPDATE ישיר של superuser אינו יכול להצביע על תמונה של ליקוי אחר או של
-- סגירה קודמת (אחרי פתיחה מחדש).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inspection_defects_done_photo_fk') THEN
    ALTER TABLE inspection_defects ADD CONSTRAINT inspection_defects_done_photo_fk
      FOREIGN KEY (id, closure_no, done_photo_id)
      REFERENCES inspection_defect_photos(defect_id, closure_no, id);   -- NO ACTION: הראיה אינה נמחקת
  END IF;
END $$;

-- תמונות אינן משתנות; נמחקות רק בסגירה הנוכחית של ליקוי פתוח, או ב-purge.
CREATE OR REPLACE FUNCTION app.inspection_photo_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
BEGIN
  IF app.compliance_purging() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'תמונת ראיה אינה ניתנת לשינוי' USING ERRCODE = 'check_violation'; END IF;
  IF NOT EXISTS (SELECT 1 FROM inspection_defects d WHERE d.id = OLD.defect_id
                  AND d.status = 'open' AND d.closure_no = OLD.closure_no) THEN
    RAISE EXCEPTION 'תמונת ראיה של סגירה קודמת אינה נמחקת' USING ERRCODE = 'check_violation'; END IF;
  RETURN OLD;
END $fn$;
REVOKE ALL ON FUNCTION app.inspection_photo_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS inspection_defect_photos_guard ON inspection_defect_photos;
CREATE TRIGGER inspection_defect_photos_guard BEFORE UPDATE OR DELETE ON inspection_defect_photos
  FOR EACH ROW EXECUTE FUNCTION app.inspection_photo_guard();

-- ============================================================
-- 1.3 תחזוקה מונעת — טבלאות
-- ============================================================

-- ============================================================
-- רשימות תחזוקה — משותפת, לפי סוג מתקן, לסוטפין — ושיוך לאתר (07/10/2026)
-- ============================================================
-- עד כאן הייתה רשימה **אחת** לכל האתרים (D15). בעלת המוצר: "יש דברים שמשותפים כמעט
-- לכל האתרים, ויש פעולות תחזוקה שרלוונטיות לסוג המתקן" — ולאתר חדש: "תצטרכי לשאול
-- איזו תחזוקה לצרף לו, לרוב התשובה תהיה כמו פרויקט אחר".
--
-- ⚠️ **אתר בלי שיוך מקבל את רשימת ברירת המחדל (is_default) — וזו בדיוק ההתנהגות
-- הקודמת.** הרשימה הגלובלית הפכה לרשימת ברירת המחדל, כל פריט קיים שויך אליה, ושום
-- אתר לא משנה את מה שהוא מקבל עד שמשייכים אותו במפורש.
CREATE TABLE IF NOT EXISTS pm_templates (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL CONSTRAINT pm_templates_name CHECK (length(btrim(name)) BETWEEN 2 AND 60),
  seq INTEGER NOT NULL DEFAULT 0,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_templates_name ON pm_templates (lower(btrim(name))) WHERE active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_templates_default ON pm_templates (is_default) WHERE is_default;
INSERT INTO pm_templates (name, seq, is_default, updated_at, updated_by)
SELECT 'משותף', 0, true, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'מערכת'
 WHERE NOT EXISTS (SELECT 1 FROM pm_templates t WHERE t.is_default);

CREATE TABLE IF NOT EXISTS pm_checklist_items (
  id SERIAL PRIMARY KEY,
  seq INTEGER NOT NULL,
  label TEXT NOT NULL CONSTRAINT pm_checklist_items_label CHECK (length(btrim(label)) BETWEEN 2 AND 300),
  hint TEXT CONSTRAINT pm_checklist_items_hint CHECK (hint IS NULL OR length(hint) <= 500),
  kind TEXT NOT NULL CONSTRAINT pm_checklist_items_kind CHECK (kind IN ('check','photo','check_photo')),
  required BOOLEAN NOT NULL DEFAULT TRUE,
  min_photos INTEGER NOT NULL DEFAULT 0 CONSTRAINT pm_checklist_items_min CHECK (min_photos BETWEEN 0 AND 6),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
  -- D15: פריט רשות אינו יכול לדרוש תמונות; פריט צילום חובה דורש לפחות אחת.
  CONSTRAINT pm_checklist_items_photo_shape CHECK (
       (kind = 'check' AND min_photos = 0)
    OR (kind <> 'check' AND required AND min_photos >= 1)
    OR (kind <> 'check' AND NOT required AND min_photos = 0))
);

-- כל פריט שייך לרשימה. פריט קיים (מלפני 07/10/2026), או פריט שנכתב בלי רשימה →
-- רשימת ברירת המחדל: "הרשימה הגלובלית" של קודם היא היא רשימת ברירת המחדל.
CREATE OR REPLACE FUNCTION app.pm_default_template_id() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
  SELECT t.id FROM pm_templates t WHERE t.is_default
$$;
REVOKE ALL ON FUNCTION app.pm_default_template_id() FROM PUBLIC;
ALTER TABLE pm_checklist_items ADD COLUMN IF NOT EXISTS template_id INTEGER REFERENCES pm_templates(id);
ALTER TABLE pm_checklist_items ALTER COLUMN template_id SET DEFAULT app.pm_default_template_id();
UPDATE pm_checklist_items SET template_id = app.pm_default_template_id() WHERE template_id IS NULL;
ALTER TABLE pm_checklist_items ALTER COLUMN template_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pm_checklist_items_template ON pm_checklist_items(template_id) WHERE active;

-- קבוצה בתוך רשימה (07/10/2026): "יחידת כוח", "מעלית אנכית". במסמך סוטפין ביקשו שהביקור
-- יוצג כשורות (מעלית / שאטל / דולי / לובי) שנפתחות בלחיצה ונהיות ירוקות כשהכול בוצע.
-- ריק = הפריט בקבוצה בשם הרשימה — כך רשימה בלי קבוצות היא קבוצה אחת.
ALTER TABLE pm_checklist_items ADD COLUMN IF NOT EXISTS section TEXT;
ALTER TABLE pm_checklist_items DROP CONSTRAINT IF EXISTS pm_checklist_items_section;
ALTER TABLE pm_checklist_items ADD CONSTRAINT pm_checklist_items_section
  CHECK (section IS NULL OR length(btrim(section)) BETWEEN 1 AND 60) NOT VALID;
ALTER TABLE pm_checklist_items VALIDATE CONSTRAINT pm_checklist_items_section;

-- אילו רשימות אתר מקבל. אין שורות → רשימת ברירת המחדל (app.pm_site_template_ids).
CREATE TABLE IF NOT EXISTS pm_site_templates (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  template_id INTEGER NOT NULL REFERENCES pm_templates(id) ON DELETE CASCADE,
  PRIMARY KEY (site_id, template_id)
);

-- ⚠️ ביקור שהוגש ונמחק רך — מותר לו להישאר בלי חתימה, כי compliance_purge
-- מוחק אותה (D18). ביקור חי שהוגש מהדשבורד בלי חתימה עדיין אינו ניתן לביטוי.
CREATE TABLE IF NOT EXISTS pm_visits (
  id BIGSERIAL PRIMARY KEY,
  client_id UUID,                                  -- העלאות היסטוריות (idempotency)
  site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  site_code TEXT NOT NULL,
  source TEXT NOT NULL CONSTRAINT pm_visits_source CHECK (source IN ('dashboard','historical')),
  status TEXT NOT NULL CONSTRAINT pm_visits_status CHECK (status IN ('draft','submitted')),
  performed_on DATE, performer_name TEXT, vendor TEXT,
  note TEXT CONSTRAINT pm_visits_note CHECK (note IS NULL OR length(note) <= 2000),
  signature_b64 TEXT,
  started_by TEXT NOT NULL,
  started_by_user_id INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  submitted_by TEXT,
  submitted_by_user_id INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
  submitted_at TEXT,
  submit_request_id UUID,
  deleted_at TEXT, deleted_by TEXT, deleted_reason TEXT,
  CONSTRAINT pm_visits_client_uq UNIQUE (client_id),
  CONSTRAINT pm_visits_shape CHECK (
       (source = 'historical' AND status = 'submitted' AND performed_on IS NOT NULL AND signature_b64 IS NULL)
    OR (source = 'dashboard'  AND status = 'draft' AND submitted_at IS NULL AND deleted_at IS NULL)
    OR (source = 'dashboard'  AND status = 'submitted' AND performed_on IS NOT NULL
        AND length(btrim(performer_name)) >= 2 AND submitted_at IS NOT NULL
        AND (signature_b64 IS NOT NULL OR deleted_at IS NOT NULL))),
  CONSTRAINT pm_visits_signature CHECK (signature_b64 IS NULL
    OR (left(signature_b64,11) = 'iVBORw0KGgo' AND length(signature_b64) <= 273068)),
  CONSTRAINT pm_visits_deleted_shape CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)
    AND (deleted_at IS NULL OR length(btrim(deleted_reason)) >= 2))
);
-- ⚠️ טיוטה אחת לאתר — גם מול INSERT ישיר. שני טכנאים שפותחים ביקור באותו רגע
-- מקבלים את אותה טיוטה (ON CONFLICT ... DO NOTHING ובחירה חוזרת).
CREATE UNIQUE INDEX IF NOT EXISTS uq_pm_visits_one_draft ON pm_visits(site_id) WHERE status = 'draft';
CREATE INDEX IF NOT EXISTS idx_pm_visits_site ON pm_visits(site_id, performed_on DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS pm_visit_items (
  id BIGSERIAL PRIMARY KEY,
  visit_id BIGINT NOT NULL REFERENCES pm_visits(id) ON DELETE CASCADE,
  template_item_id INTEGER REFERENCES pm_checklist_items(id) ON DELETE SET NULL,
  seq INTEGER NOT NULL, label TEXT NOT NULL, hint TEXT,
  kind TEXT NOT NULL CONSTRAINT pm_visit_items_kind CHECK (kind IN ('check','photo','check_photo')),
  required BOOLEAN NOT NULL, min_photos INTEGER NOT NULL,
  checked BOOLEAN NOT NULL DEFAULT FALSE,
  note TEXT CONSTRAINT pm_visit_items_note CHECK (note IS NULL OR length(note) <= 1000),
  updated_at TEXT, updated_by TEXT,
  CONSTRAINT pm_visit_items_owner UNIQUE (id, visit_id)
);
CREATE INDEX IF NOT EXISTS idx_pm_visit_items_visit ON pm_visit_items(visit_id, seq);
-- שם הקבוצה **בעת פתיחת הביקור** (הקבוצה של הפריט, או שם הרשימה). צילום ולא הפניה:
-- שינוי שם ברשימה אחר כך אינו מזיז פריטים בביקור פתוח. NULL = ביקור מלפני הקבוצות.
ALTER TABLE pm_visit_items ADD COLUMN IF NOT EXISTS section TEXT;

CREATE TABLE IF NOT EXISTS pm_files (
  id BIGSERIAL PRIMARY KEY,
  client_id UUID,
  visit_id BIGINT NOT NULL REFERENCES pm_visits(id) ON DELETE CASCADE,
  visit_item_id BIGINT,
  kind TEXT NOT NULL CONSTRAINT pm_files_kind CHECK (kind IN ('pdf','photo')),
  mime TEXT NOT NULL, file_name TEXT, data_b64 TEXT NOT NULL, thumb_b64 TEXT,
  byte_size INTEGER NOT NULL CONSTRAINT pm_files_size_pos CHECK (byte_size > 0),
  content_md5 TEXT, uploaded_by TEXT NOT NULL, created_at TEXT NOT NULL,
  CONSTRAINT pm_files_client_uq UNIQUE (client_id),
  CONSTRAINT pm_files_item_fk FOREIGN KEY (visit_item_id, visit_id)
    REFERENCES pm_visit_items(id, visit_id) ON DELETE CASCADE,
  CONSTRAINT pm_files_shape CHECK (
       (kind = 'pdf' AND mime = 'application/pdf' AND left(data_b64,7) = 'JVBERi0'
        AND length(data_b64) <= 13981016 AND visit_item_id IS NULL AND thumb_b64 IS NULL)
    OR (kind = 'photo' AND client_id IS NOT NULL AND visit_item_id IS NOT NULL AND length(data_b64) <= 1398104
        AND ((mime = 'image/jpeg' AND left(data_b64,4) = '/9j/') OR (mime = 'image/webp' AND left(data_b64,5) = 'UklGR'))
        AND (thumb_b64 IS NULL OR (left(thumb_b64,4) = '/9j/' AND length(thumb_b64) <= 54616))))
);
CREATE INDEX IF NOT EXISTS idx_pm_files_visit ON pm_files(visit_id);
CREATE INDEX IF NOT EXISTS idx_pm_files_md5 ON pm_files(content_md5) WHERE content_md5 IS NOT NULL;

-- ⚠️ ביקור שנחתם אינו משתנה — גם לא ב-UPDATE ישיר: לא השורה עצמה (app.pm_visit_guard)
-- ולא הפריטים והקבצים שלה (app.pm_child_guard). חריגים: purge, והכנסת ה-PDF של ביקור היסטורי.
--
-- בשורת הביקור מותר לשנות רק: מחיקה רכה (deleted_*), ושיוך לאתר (site_id/site_code —
-- delete_site מאפס דרך ה-FK, compliance_reattach מחזיר). ב-purge — רק איפוס החתימה.
CREATE OR REPLACE FUNCTION app.pm_visit_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE v_free text[] := ARRAY['deleted_at','deleted_by','deleted_reason','site_id','site_code'];
BEGIN
  IF OLD.status IS DISTINCT FROM 'submitted' THEN RETURN COALESCE(NEW, OLD); END IF;
  IF app.compliance_purging() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF (to_jsonb(NEW) - v_free - 'signature_b64') = (to_jsonb(OLD) - v_free - 'signature_b64')
       AND (NEW.signature_b64 IS NULL OR NEW.signature_b64 IS NOT DISTINCT FROM OLD.signature_b64) THEN
      RETURN NEW; END IF;
    RAISE EXCEPTION 'הביקור כבר הוגש' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - v_free) = (to_jsonb(OLD) - v_free) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'הביקור כבר הוגש' USING ERRCODE = 'check_violation';
END $fn$;
REVOKE ALL ON FUNCTION app.pm_visit_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS pm_visits_guard ON pm_visits;
CREATE TRIGGER pm_visits_guard BEFORE UPDATE OR DELETE ON pm_visits
  FOR EACH ROW EXECUTE FUNCTION app.pm_visit_guard();

CREATE OR REPLACE FUNCTION app.pm_child_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE v_vid bigint; v_status text; v_source text;
BEGIN
  IF app.compliance_purging() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'DELETE' THEN v_vid := OLD.visit_id; ELSE v_vid := NEW.visit_id; END IF;
  SELECT v.status, v.source INTO v_status, v_source FROM pm_visits v WHERE v.id = v_vid;
  -- גם UPDATE שמעביר שורה מביקור שהוגש לטיוטה נחסם: בודקים את שני הצדדים
  IF TG_OP = 'UPDATE' AND OLD.visit_id IS DISTINCT FROM NEW.visit_id
     AND EXISTS (SELECT 1 FROM pm_visits v WHERE v.id = OLD.visit_id AND v.status = 'submitted') THEN
    RAISE EXCEPTION 'הביקור כבר הוגש' USING ERRCODE = 'check_violation'; END IF;
  IF v_status IS DISTINCT FROM 'submitted' THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_TABLE_NAME = 'pm_files' AND TG_OP = 'INSERT' AND NEW.kind = 'pdf' AND v_source = 'historical'
     AND NOT EXISTS (SELECT 1 FROM pm_files f WHERE f.visit_id = v_vid AND f.kind = 'pdf') THEN
    RETURN NEW; END IF;
  RAISE EXCEPTION 'הביקור כבר הוגש' USING ERRCODE = 'check_violation';
END $fn$;
REVOKE ALL ON FUNCTION app.pm_child_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS pm_visit_items_guard ON pm_visit_items;
CREATE TRIGGER pm_visit_items_guard BEFORE INSERT OR UPDATE OR DELETE ON pm_visit_items
  FOR EACH ROW EXECUTE FUNCTION app.pm_child_guard();
DROP TRIGGER IF EXISTS pm_files_guard ON pm_files;
CREATE TRIGGER pm_files_guard BEFORE INSERT OR UPDATE OR DELETE ON pm_files
  FOR EACH ROW EXECUTE FUNCTION app.pm_child_guard();

-- ============================================================
-- 1.4 היסטוריה — סגורה; מחזיקה את הטקסט החופשי ש-audit_log אסור לו (D22)
-- ============================================================
-- ⚠️ audit_log קריא לכל מאומת שאינו `user.*` — כולל סוכנים וזהות הקליטה
-- (security.postgres.sql, audit_log_read_authenticated). לכן שם רק מזהים,
-- ספירות ושמות שדות; גוף ליקוי, סיבה, שם מבצע, לפני/אחרי — רק כאן.
CREATE TABLE IF NOT EXISTS compliance_history (
  id BIGSERIAL PRIMARY KEY,
  site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  site_code TEXT NOT NULL,
  area TEXT NOT NULL CONSTRAINT compliance_history_area CHECK (area IN ('inspection','pm')),
  entity TEXT NOT NULL, entity_id BIGINT, action TEXT NOT NULL,
  actor TEXT NOT NULL, actor_user_id INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
  at TEXT NOT NULL, before JSONB, after JSONB, reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_compliance_history_site ON compliance_history(site_id, id DESC);

-- ============================================================
-- 1.4א תוספות אחרי היצירה — בתבנית שבראש הקובץ (ADD COLUMN IF NOT EXISTS; DROP/ADD NOT VALID/VALIDATE)
-- ============================================================

-- D23: יצירת ליקוי ידנית חוזרת על עצמה כשהתגובה אבדה — client_id מזהה את הניסיון החוזר
ALTER TABLE inspection_defects ADD COLUMN IF NOT EXISTS client_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS uq_inspection_defects_client ON inspection_defects(client_id) WHERE client_id IS NOT NULL;

-- ⚠️ תקרות לטקסט חופשי (D2(ג)). שדה בלי תקרה חוזר ב-inspection_site / pm_site /
-- site_compliance לכל איש צוות — בקר אחד עם שם מבצע של 2MB הופך כל טעינה ל-2MB.
-- ה-RPC בודקים את אותן תקרות עם הודעה בעברית; כאן זו הערבות גם מול כתיבה ישירה.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('inspection_machines', 'inspection_machines_text_caps',
       'label IS NULL OR length(label) <= 80) AND (retired_reason IS NULL OR length(retired_reason) <= 500'),
    ('inspection_files', 'inspection_files_text_caps', 'file_name IS NULL OR length(file_name) <= 200'),
    ('inspection_reports', 'inspection_reports_text_caps',
       '(report_number IS NULL OR length(report_number) <= 60) AND (inspector_license IS NULL OR length(inspector_license) <= 60)'
       || ' AND (machine_no IS NULL OR length(machine_no) <= 60) AND (inspector_name IS NULL OR length(inspector_name) <= 100)'
       || ' AND (note IS NULL OR length(note) <= 2000) AND (deleted_reason IS NULL OR length(deleted_reason) <= 500)'
       || ' AND (parse_meta IS NULL OR octet_length(parse_meta::text) <= 4096)'),
    ('inspection_defects', 'inspection_defects_text_caps',
       '(done_by_name IS NULL OR length(done_by_name) <= 100) AND (deleted_reason IS NULL OR length(deleted_reason) <= 500)'),
    ('pm_visits', 'pm_visits_text_caps',
       '(performer_name IS NULL OR length(performer_name) <= 100) AND (vendor IS NULL OR length(vendor) <= 100)'
       || ' AND (deleted_reason IS NULL OR length(deleted_reason) <= 500)'),
    ('pm_files', 'pm_files_text_caps', 'file_name IS NULL OR length(file_name) <= 200'),
    ('compliance_history', 'compliance_history_text_caps', 'reason IS NULL OR length(reason) <= 500')
  ) AS x(t, n, expr) LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', c.t, c.n);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((%s)) NOT VALID', c.t, c.n, c.expr);
    EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', c.t, c.n);
  END LOOP;
END $$;

-- ⚠️ "בוצע" בלי תמונה — מותר מ-06/10/2026. בעלת המוצר, על חלון "סימון ליקוי כבוצע": "אני רוצה
-- שזה יהיה אופציונלי, כלומר יהיה אפשר להמשיך גם בלי להעלות תמונה ולציין מי תיקן". שם המבצע
-- נשאר חובה — מי תיקן. מה שעדיין אינו ניתן לביטוי: שתי ראיות יחד (תמונה וגם תסקיר חוזר).
-- הסגירה עדיין אינה "נקי": המחזור ממתין לתסקיר נקי מהבודק (awaiting_clean).
ALTER TABLE inspection_defects DROP CONSTRAINT IF EXISTS inspection_defects_done_shape;
ALTER TABLE inspection_defects ADD CONSTRAINT inspection_defects_done_shape CHECK (
     (status = 'open' AND done_at IS NULL AND done_by IS NULL AND done_by_name IS NULL
      AND done_photo_id IS NULL AND closed_by_report_id IS NULL AND done_request_id IS NULL)
  -- ⚠️ "IS NOT NULL" מפורש: length(NULL) הוא NULL, ו-CHECK מקבל NULL כהצלחה. עד היום תנאי
  -- הראיה (XOR) הפך את הביטוי ל-FALSE והסתיר את זה; בלעדיו "בוצע" בלי שם עבר (נתפס בבדיקה 14).
  OR (status = 'done' AND done_at IS NOT NULL AND done_by IS NOT NULL
      AND done_by_name IS NOT NULL AND length(btrim(done_by_name)) >= 2
      AND NOT (done_photo_id IS NOT NULL AND closed_by_report_id IS NOT NULL))) NOT VALID;
ALTER TABLE inspection_defects VALIDATE CONSTRAINT inspection_defects_done_shape;

-- ============================================================
-- 1.5 נעילה — RLS בלי מדיניות, בלי הרשאות (D2)
-- ============================================================
-- ⚠️ היעדר המדיניות **מכוון**. אל "תתקנו" בהוספת policy או GRANT SELECT:
-- זה בדיוק מה שהיה חושף את data_b64 ל-select("*") ואת הטבלאות לסוכנים.
DO $$ DECLARE t text; s text; BEGIN
  FOREACH t IN ARRAY ARRAY['inspection_machines','inspection_files','inspection_reports','inspection_defects',
                           'inspection_defect_photos','pm_checklist_items','pm_visits','pm_visit_items','pm_files',
                           'compliance_history','pm_templates','pm_site_templates'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC, anon, authenticated, service_role', t);
    s := NULL;
    IF EXISTS (SELECT 1 FROM information_schema.columns c
                WHERE c.table_schema = 'public' AND c.table_name = t AND c.column_name = 'id') THEN
      s := pg_get_serial_sequence(t, 'id');
    END IF;
    IF s IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated, service_role', s);
    END IF;
  END LOOP;
END $$;

-- ============================================================
-- עזרי כתיבה משותפים
-- ============================================================

-- שורת היסטוריה. site_code: הקוד העדכני (או ה-snapshot אם האתר נמחק).
CREATE OR REPLACE FUNCTION app.compliance_log(p_site_id integer, p_site_code text, p_area text, p_entity text,
  p_entity_id bigint, p_action text, p_actor text, p_before jsonb, p_after jsonb, p_reason text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
  INSERT INTO compliance_history (site_id, site_code, area, entity, entity_id, action, actor, actor_user_id,
                                  at, before, after, reason)
  VALUES (p_site_id, COALESCE(app.compliance_code(p_site_id, p_site_code), '*'), p_area, p_entity, p_entity_id,
          p_action, COALESCE(p_actor, '?'), app.current_app_user(), app.compliance_now_iso(), p_before, p_after, p_reason);
$$;
REVOKE ALL ON FUNCTION app.compliance_log(integer, text, text, text, bigint, text, text, jsonb, jsonb, text) FROM PUBLIC;

-- אירוע חי (D20). הקוד נקבע ע"י הקורא דרך app.compliance_code, כך שאתר
-- ששונה שמו מפרסם בקוד החדש.
CREATE OR REPLACE FUNCTION app.compliance_event(p_code text, p_area text, p_action text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
  SELECT app.record_write_event(p_code, 'compliance',
    jsonb_build_object('type','compliance','code',p_code,'area',p_area,'action',p_action));
$$;
REVOKE ALL ON FUNCTION app.compliance_event(text, text, text) FROM PUBLIC;

-- ============================================================
-- 3. מצב — app.compliance_machine_rows → app.compliance_rows → public.site_compliance
-- ============================================================
-- (מוגדר לפני ה-RPC, כי inspection_site ו-pm_site מחזירים את השורה הזו.)
DROP FUNCTION IF EXISTS public.site_compliance(integer[]);
DROP FUNCTION IF EXISTS app.compliance_rows(integer[], date);
DROP FUNCTION IF EXISTS app.compliance_machine_rows(integer[], date);

-- מצב לכל מתקן פעיל (לא retired) — מקור אחד לכרטיס, לטאב ולהתראה.
CREATE FUNCTION app.compliance_machine_rows(p_site_ids integer[], p_today date)
RETURNS TABLE (site_id integer, machine_key text, label text, periodic_id bigint, valid_until date,
               validity_state text, light text, cycle text, open_n integer, overdue_n integer, due_soon_n integer,
               awaiting_since date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
WITH mach AS (SELECT m.site_id AS sid, m.machine_key AS mk, m.label FROM inspection_machines m
               WHERE m.retired_at IS NULL AND (p_site_ids IS NULL OR m.site_id = ANY (p_site_ids))),
live AS (SELECT r.* FROM inspection_reports r JOIN mach m ON m.sid = r.site_id AND m.mk = r.machine_key
          WHERE r.deleted_at IS NULL),
-- ⚠️ התוקף = התקופתי **האחרון**, לא max(valid_until): בדיקה חוזרת קצרה יותר מחליפה את הישנה.
cyc  AS (SELECT DISTINCT ON (l.site_id, l.machine_key) l.site_id AS sid, l.machine_key AS mk, l.id AS pid, l.valid_until AS pvu
           FROM live l WHERE l.kind = 'periodic' ORDER BY l.site_id, l.machine_key, l.inspected_on DESC, l.id DESC),
cr   AS (SELECT c.sid, c.mk, l.id AS rid, l.kind, l.inspected_on, l.valid_until, l.declared_clean
           FROM cyc c JOIN live l ON l.id = c.pid OR l.followup_of = c.pid),
-- תוקף = התקופתי האחרון, ודורס אותו רק follow-up עם תוקף משלו (inherited = NULL, לעולם לא דורס)
ovr  AS (SELECT DISTINCT ON (cr.sid, cr.mk) cr.sid, cr.mk, cr.valid_until AS fvu FROM cr
          WHERE cr.kind = 'followup' AND cr.valid_until IS NOT NULL ORDER BY cr.sid, cr.mk, cr.inspected_on DESC, cr.rid DESC),
lastr AS (SELECT DISTINCT ON (cr.sid, cr.mk) cr.sid, cr.mk, cr.rid, cr.declared_clean FROM cr
          ORDER BY cr.sid, cr.mk, cr.inspected_on DESC, cr.rid DESC),
dq   AS (SELECT cr.sid, cr.mk,
                count(*) FILTER (WHERE d.status = 'open')::int AS open_n,
                count(*) FILTER (WHERE d.status = 'open' AND d.due_on < p_today)::int AS overdue_n,
                -- מועד תיקון בעוד 30 יום או פחות (היום עצמו כלול — עוד לא באיחור)
                count(*) FILTER (WHERE d.status = 'open' AND d.due_on >= p_today
                                   AND d.due_on - p_today <= app.compliance_warn_days())::int AS due_soon_n,
                max(app.compliance_today_at(d.done_at::timestamptz)) AS last_done
           FROM cr JOIN inspection_defects d ON d.report_id = cr.rid AND d.deleted_at IS NULL GROUP BY cr.sid, cr.mk),
-- ⚠️ כולל ליקויים שנמחקו. בעלת המוצר, 06/10/2026, על אתר שבו ליקוי נמחק בסיבה "טופל" והתסקיר
-- המקורי סומן נקי: "אם תקנו את הליקויים — אז באמת אין ליקויים, אבל צריך מסמך נקי שמעלה בודק
-- מוסמך שוב ומאשר". תסקיר שנרשמו בו ליקויים ממתין לתסקיר נקי, גם כשכולם נמחקו.
lastd AS (SELECT lr.sid, lr.mk, count(d.id)::int AS n FROM lastr lr
            LEFT JOIN inspection_defects d ON d.report_id = lr.rid GROUP BY lr.sid, lr.mk),
-- ⚠️ D7/D9: "נקי" הוא עובדה על המסמך (declared_clean), לא ספירת שורות שנותרו.
-- מחיקת הליקוי האחרון → awaiting_clean (ראו lastd), לא clean. review נשאר רק לתסקיר שמעולם
-- לא נרשם בו ליקוי ושסימון ה"נקי" שלו בוטל — שם החזרת הסימון בעריכה היא תיקון לגיטימי.
per  AS (SELECT m.sid, m.mk, m.label, c.pid, COALESCE(o.fvu, c.pvu) AS vu,
                CASE WHEN c.pid IS NULL THEN 'none'
                     WHEN COALESCE(q.open_n,0) > 0 THEN 'open'
                     WHEN lr.declared_clean THEN 'clean'
                     WHEN COALESCE(ld.n,0) > 0 THEN 'awaiting_clean'
                     ELSE 'review' END AS cyc,
                COALESCE(q.open_n,0) AS open_n, COALESCE(q.overdue_n,0) AS overdue_n,
                COALESCE(q.due_soon_n,0) AS due_soon_n, q.last_done
           FROM mach m LEFT JOIN cyc c ON c.sid = m.sid AND c.mk = m.mk
           LEFT JOIN ovr o ON o.sid = m.sid AND o.mk = m.mk
           LEFT JOIN lastr lr ON lr.sid = m.sid AND lr.mk = m.mk
           LEFT JOIN lastd ld ON ld.sid = m.sid AND ld.mk = m.mk
           LEFT JOIN dq q ON q.sid = m.sid AND q.mk = m.mk)
-- ⚠️ הנורה אינה התוקף: התוקף (validity_state) נשאר טהור, כדי שהתווית תוכל לומר "בתוקף · עבר
-- מועד תיקון" ולא "לא בתוקף". בעלת המוצר, 06/10/2026 — תשעה מקרים, שבעה מצבים, ובכל אחד צבע אחר:
--   expired  (אדום)       — המסמך לא בתוקף, מה שלא יהיה עם הליקויים (מקרים 5, 6, 7).
--   overdue  (כתום)       — בתוקף, וליקוי פתוח עבר את מועד התיקון: due_on < היום (מקרה 3).
--   awaiting (צהוב חזק)   — בתוקף, ואין ליקוי פתוח אבל המחזור לא נקי: הליקויים טופלו ומחכים לתסקיר
--                           נקי מהבודק, או "לבדיקה" (מקרה 8). "צהוב יותר חזק מהצהוב של 4 ו-9".
--   soon     (צהוב)       — המסמך פג בעוד 30 יום או פחות (מקרה 4), או שמועד התיקון של ליקוי פתוח
--                           בעוד 30 יום או פחות, היום כלול (מקרה 9).
--   fixing   (ירוק)       — בתוקף, ויש ליקויים פתוחים שמועד התיקון שלהם רחוק מחודש (מקרה 1).
--   ok       (שחור-לבן)   — בתוקף, אין ליקויים פתוחים, והמחזור נקי (מקרה 2).
--   none     (אפור)       — אין תסקיר ו-go-live לא נקבע (ללא שינוי).
-- כשכמה חלים יחד — החמור קובע, לפי app.light_rank. ⚠️ awaiting לפני soon: מסמך שעומד לפוג
-- כשהליקויים כבר טופלו הוא צהוב חזק (בשניהם צריך לזמן את הבודק). המחזור awaiting_clean/review
-- כבר אומר שאין ליקוי פתוח (cycle open קודם לו), ולכן fixing אינו יכול להתנגש בו.
SELECT p.sid, p.mk, p.label, p.pid, p.vu, v.vs,
       CASE WHEN v.vs IN ('expired', 'none') THEN v.vs
            WHEN p.overdue_n > 0 THEN 'overdue'
            WHEN p.cyc IN ('awaiting_clean', 'review') THEN 'awaiting'
            WHEN v.vs = 'soon' OR p.due_soon_n > 0 THEN 'soon'
            WHEN p.open_n > 0 THEN 'fixing'
            ELSE 'ok' END,
       p.cyc, p.open_n, p.overdue_n, p.due_soon_n, CASE WHEN p.cyc = 'awaiting_clean' THEN p.last_done END
  FROM per p CROSS JOIN LATERAL (SELECT app.compliance_light(p.vu, p_today, app.compliance_warn_days(),
                                                             app.compliance_go_live()) AS vs) v
$$;
REVOKE ALL ON FUNCTION app.compliance_machine_rows(integer[], date) FROM PUBLIC;

CREATE FUNCTION app.compliance_rows(p_site_ids integer[], p_today date)
RETURNS TABLE (site_id integer, site_code text, site_name text,
               inspection_state text, inspection_validity_state text, inspection_valid_until date,
               inspection_days_left integer, inspection_missing boolean, inspection_cycle text,
               inspection_awaiting_since date, open_defects integer, overdue_defects integer, due_soon_defects integer,
               machines integer, machines_detail jsonb,
               pm_state text, pm_missing boolean, pm_last_on date, pm_last_visit_id bigint, pm_due_on date,
               pm_days_left integer, pm_draft_id bigint, pm_draft_last_activity text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
WITH s AS (SELECT si.id, si.code, si.site_name FROM sites si WHERE p_site_ids IS NULL OR si.id = ANY (p_site_ids)),
mr AS (SELECT * FROM app.compliance_machine_rows(p_site_ids, p_today)),
-- נורת האתר = המתקן הגרוע ביותר; התוקף המוצג = המוקדם מבין המתקנים
agg AS (SELECT mr.site_id AS sid, count(*)::int AS n, min(mr.valid_until) AS vu,
               (array_agg(mr.light ORDER BY app.light_rank(mr.light) DESC))[1] AS light,
               (array_agg(mr.validity_state ORDER BY app.light_rank(mr.validity_state) DESC))[1] AS vstate,
               (array_agg(mr.cycle ORDER BY app.cycle_rank(mr.cycle) DESC))[1] AS cyc,
               sum(mr.open_n)::int AS open_n, sum(mr.overdue_n)::int AS overdue_n, sum(mr.due_soon_n)::int AS due_soon_n,
               min(mr.awaiting_since) AS aw,
               -- 'validity' לצד 'state': בלעדיו התווית של מתקן אדום אינה יודעת אם פג או שיש ליקוי באיחור
               jsonb_agg(jsonb_build_object('key',mr.machine_key,'label',mr.label,'valid_until',mr.valid_until,
                         'state',mr.light,'validity',mr.validity_state,'cycle',mr.cycle,
                         'open',mr.open_n,'overdue',mr.overdue_n,'due_soon',mr.due_soon_n)
                         ORDER BY mr.machine_key) AS detail
          FROM mr GROUP BY mr.site_id),
-- D11: טיוטות לעולם אינן נספרות; רק ביקור שהוגש ולא נמחק
pmv AS (SELECT DISTINCT ON (v.site_id) v.site_id AS sid, v.id AS vid, v.performed_on FROM pm_visits v
         WHERE v.status = 'submitted' AND v.deleted_at IS NULL AND v.site_id IN (SELECT s.id FROM s)
         ORDER BY v.site_id, v.performed_on DESC, v.id DESC),
dr AS (SELECT v.site_id AS sid, v.id AS vid, v.last_activity_at FROM pm_visits v
        WHERE v.status = 'draft' AND v.site_id IN (SELECT s.id FROM s)),
-- ⚠️ אתר שכל המתקנים שלו הוצאו משימוש **אינו** "אין תסקיר": אין בו מה לבדוק.
-- בלי זה מנהל שפירק במפורש את המעלית היחידה היה מקבל נורה אדומה (אחרי go-live)
-- ושורת "חסר" בסיכום. [FLIP] — החלטת ברירת מחדל, ממתינה לאישור הבעלים.
ret AS (SELECT m.site_id AS sid FROM inspection_machines m WHERE m.site_id IN (SELECT s.id FROM s)
         GROUP BY m.site_id HAVING bool_and(m.retired_at IS NOT NULL)),
cfg AS (SELECT app.compliance_warn_days() AS warn, app.compliance_go_live() AS go_live)
SELECT s.id, s.code, s.site_name,
       COALESCE(a.light, CASE WHEN ret.sid IS NOT NULL THEN 'none' END,
                app.compliance_light(NULL, p_today, cfg.warn, cfg.go_live)),
       COALESCE(a.vstate, CASE WHEN ret.sid IS NOT NULL THEN 'none' END,
                app.compliance_light(NULL, p_today, cfg.warn, cfg.go_live)),
       a.vu, a.vu - p_today, a.vu IS NULL AND ret.sid IS NULL, COALESCE(a.cyc, 'none'), a.aw,
       COALESCE(a.open_n,0), COALESCE(a.overdue_n,0), COALESCE(a.due_soon_n,0), COALESCE(a.n,0),
       COALESCE(a.detail,'[]'::jsonb),
       app.compliance_light(pd.due, p_today, cfg.warn, cfg.go_live), pmv.vid IS NULL, pmv.performed_on, pmv.vid,
       pd.due, pd.due - p_today, dr.vid, dr.last_activity_at
  FROM s CROSS JOIN cfg
  LEFT JOIN agg a ON a.sid = s.id
  LEFT JOIN ret ON ret.sid = s.id
  LEFT JOIN pmv ON pmv.sid = s.id
  LEFT JOIN dr ON dr.sid = s.id
  LEFT JOIN LATERAL (SELECT (pmv.performed_on + make_interval(months => app.pm_interval_months()))::date AS due) pd ON true
 ORDER BY s.id
$$;
REVOKE ALL ON FUNCTION app.compliance_rows(integer[], date) FROM PUBLIC;

-- ⚠️ לעולם אינה זורקת: מי שאינו צוות מקבל אפס שורות. הכרטיס קורא לה בתוך
-- Promise.all כקריאה שאינה קטלנית (D19) — שגיאה כאן לא תפיל את רשימת האתרים.
CREATE FUNCTION public.site_compliance(p_site_ids integer[] DEFAULT NULL)
RETURNS TABLE (site_id integer, site_code text, site_name text,
               inspection_state text, inspection_validity_state text, inspection_valid_until date,
               inspection_days_left integer, inspection_missing boolean, inspection_cycle text,
               inspection_awaiting_since date, open_defects integer, overdue_defects integer, due_soon_defects integer,
               machines integer, machines_detail jsonb,
               pm_state text, pm_missing boolean, pm_last_on date, pm_last_visit_id bigint, pm_due_on date,
               pm_days_left integer, pm_draft_id bigint, pm_draft_last_activity text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
  SELECT * FROM app.compliance_rows(p_site_ids, app.compliance_today()) WHERE (SELECT app.is_staff())
$$;
REVOKE ALL ON FUNCTION public.site_compliance(integer[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.site_compliance(integer[]) TO authenticated;

-- ============================================================
-- 2.1 בודק מוסמך — RPC
-- ============================================================

-- סגירת כל הליקויים הפתוחים במחזור על סמך תסקיר חוזר נקי (D24). משותף
-- ל-inspection_upload (תיבת הסימון) ול-inspection_close_by_report.
CREATE OR REPLACE FUNCTION app.inspection_close_cycle(p_report_id bigint, p_actor text, p_reason text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE v_r inspection_reports%ROWTYPE; v_ids bigint[]; v_now text := app.compliance_now_iso();
BEGIN
  SELECT r.* INTO v_r FROM inspection_reports r WHERE r.id = p_report_id;
  IF NOT FOUND OR v_r.deleted_at IS NOT NULL OR v_r.kind <> 'followup' OR NOT v_r.declared_clean THEN
    RAISE EXCEPTION 'סגירת ליקויים אפשרית רק בתסקיר חוזר נקי' USING ERRCODE = 'check_violation'; END IF;
  WITH c AS (SELECT r.id FROM inspection_reports r
              WHERE r.deleted_at IS NULL
                AND (r.id = v_r.followup_of
                     OR (r.followup_of = v_r.followup_of AND r.inspected_on <= v_r.inspected_on))),
       u AS (UPDATE inspection_defects d
                SET status = 'done', done_at = v_now, done_by = p_actor, done_by_user_id = app.current_app_user(),
                    done_by_name = p_actor, closed_by_report_id = p_report_id
              WHERE d.report_id IN (SELECT c.id FROM c) AND d.status = 'open' AND d.deleted_at IS NULL
              RETURNING d.id)
  SELECT array_agg(u.id ORDER BY u.id) INTO v_ids FROM u;
  IF v_ids IS NOT NULL THEN
    PERFORM app.compliance_log(v_r.site_id, v_r.site_code, 'inspection', 'report', p_report_id, 'close_cycle',
      p_actor, NULL, jsonb_build_object('defect_ids', to_jsonb(v_ids)), COALESCE(p_reason, 'תסקיר חוזר נקי'));
  END IF;
  RETURN COALESCE(array_length(v_ids, 1), 0);
END $fn$;
REVOKE ALL ON FUNCTION app.inspection_close_cycle(bigint, text, text) FROM PUBLIC;

-- ⚠️ D8/D24: closed_by_report_id חייב להצביע על תסקיר חוזר **חי ומוצהר נקי**. כשהראיה
-- נעלמת (מחיקת התסקיר, או ביטול הצהרת "נקי") הליקויים שנסגרו בה נפתחים מחדש — אחרת
-- תסקיר שהועלה לאתר/מתקן הלא נכון היה סוגר ליקויים לתמיד, והמסך היה מציג "נסגר בתסקיר
-- חוזר נקי" בלי תסקיר מאחוריו. אותו UPDATE יחיד כמו inspection_defect_reopen.
CREATE OR REPLACE FUNCTION app.inspection_reopen_closed_by(p_report_id bigint, p_actor text, p_reason text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE v_r inspection_reports%ROWTYPE; v_ids bigint[];
BEGIN
  SELECT r.* INTO v_r FROM inspection_reports r WHERE r.id = p_report_id;
  WITH u AS (UPDATE inspection_defects d
                SET status = 'open', closure_no = d.closure_no + 1, done_at = NULL, done_by = NULL,
                    done_by_user_id = NULL, done_by_name = NULL, done_note = NULL, done_photo_id = NULL,
                    closed_by_report_id = NULL, done_request_id = NULL
              WHERE d.closed_by_report_id = p_report_id AND d.status = 'done' AND d.deleted_at IS NULL
              RETURNING d.id)
  SELECT array_agg(u.id ORDER BY u.id) INTO v_ids FROM u;
  IF v_ids IS NOT NULL THEN
    PERFORM app.compliance_log(v_r.site_id, v_r.site_code, 'inspection', 'report', p_report_id, 'reopen_cycle',
      p_actor, jsonb_build_object('defect_ids', to_jsonb(v_ids)), NULL, p_reason);
  END IF;
  RETURN COALESCE(array_length(v_ids, 1), 0);
END $fn$;
REVOKE ALL ON FUNCTION app.inspection_reopen_closed_by(bigint, text, text) FROM PUBLIC;

-- ------------------------------------------------------------
-- inspection_site — כל מה שהלשונית צריכה, בלי base64
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.inspection_site(p_site_code text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_staff();
  v_today date := app.compliance_today();
  v_site integer; v_code text; v_name text;
BEGIN
  SELECT s.id, s.code, s.site_name INTO v_site, v_code, v_name FROM sites s WHERE s.code = btrim(COALESCE(p_site_code,''));
  IF v_site IS NULL THEN RAISE EXCEPTION 'אתר לא נמצא: %', p_site_code USING ERRCODE = 'PT404'; END IF;
  RETURN jsonb_build_object(
    'site', jsonb_build_object('id', v_site, 'code', v_code, 'name', v_name),
    'status', (SELECT to_jsonb(r) FROM app.compliance_rows(ARRAY[v_site], v_today) r),
    'machines', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'key', m.machine_key, 'label', m.label, 'retired_at', m.retired_at,
               'state', mr.light, 'validity_state', mr.validity_state, 'cycle', mr.cycle,
               'valid_until', mr.valid_until, 'periodic_id', mr.periodic_id,
               'open', mr.open_n, 'overdue', mr.overdue_n, 'due_soon', mr.due_soon_n,
               'awaiting_since', mr.awaiting_since)
             ORDER BY m.machine_key)
        FROM inspection_machines m
        LEFT JOIN app.compliance_machine_rows(ARRAY[v_site], v_today) mr ON mr.machine_key = m.machine_key
       WHERE m.site_id = v_site), '[]'::jsonb),
    'reports', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', r.id, 'machine_key', r.machine_key, 'kind', r.kind, 'followup_of', r.followup_of,
               'inspected_on', r.inspected_on, 'valid_until', r.valid_until,
               'effective_valid_until', COALESCE(r.valid_until, p.valid_until),
               'validity_source', r.validity_source, 'declared_clean', r.declared_clean,
               'report_number', r.report_number, 'inspector_name', r.inspector_name,
               'inspector_license', r.inspector_license, 'machine_no', r.machine_no, 'note', r.note,
               'parse_meta', r.parse_meta, 'uploaded_by', r.uploaded_by, 'created_at', r.created_at,
               'file', jsonb_build_object('id', f.id, 'file_name', f.file_name, 'byte_size', f.byte_size,
                                          'purged', f.purged_at IS NOT NULL),
               'defects', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'id', d.id, 'seq', d.seq, 'body', d.body, 'urgent', d.urgent, 'due_on', d.due_on,
                          'status', d.status, 'closure_no', d.closure_no, 'done_at', d.done_at,
                          -- מצב המועד מה-SQL, באותם כללים כמו overdue_n / due_soon_n — הדשבורד אינו מחשב סף
                          'due_state', CASE WHEN d.status = 'open' AND d.due_on < v_today THEN 'overdue'
                                             WHEN d.status = 'open' AND d.due_on - v_today <= app.compliance_warn_days()
                                             THEN 'soon' END,
                          'done_by_name', d.done_by_name, 'done_note', d.done_note,
                          'closed_by_report_id', d.closed_by_report_id,
                          'current_photos', (SELECT count(*)::int FROM inspection_defect_photos ph
                                              WHERE ph.defect_id = d.id AND ph.closure_no = d.closure_no),
                          'past_photos', (SELECT count(*)::int FROM inspection_defect_photos ph
                                           WHERE ph.defect_id = d.id AND ph.closure_no < d.closure_no))
                        ORDER BY d.seq, d.id)
                   FROM inspection_defects d WHERE d.report_id = r.id AND d.deleted_at IS NULL), '[]'::jsonb),
               -- לחלון העריכה: תסקיר שנרשמו בו ליקויים אינו מסומן נקי, גם כשכולם נמחקו (D7)
               'deleted_defects', (SELECT count(*)::int FROM inspection_defects d
                                    WHERE d.report_id = r.id AND d.deleted_at IS NOT NULL))
             ORDER BY r.inspected_on DESC, r.id DESC)
        FROM inspection_reports r
        JOIN inspection_files f ON f.id = r.file_id
        LEFT JOIN inspection_reports p ON p.id = r.followup_of
       WHERE r.site_id = v_site AND r.deleted_at IS NULL), '[]'::jsonb));
END $fn$;
REVOKE ALL ON FUNCTION public.inspection_site(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inspection_site(text) TO authenticated;

-- ------------------------------------------------------------
-- inspection_upload — תסקיר חדש (תקופתי או חוזר), עם הליקויים שבו
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.inspection_upload(text, jsonb, jsonb, jsonb);
CREATE FUNCTION public.inspection_upload(p_site_code text, p_meta jsonb, p_file jsonb DEFAULT NULL,
                                         p_defects jsonb DEFAULT '[]'::jsonb)
RETURNS TABLE (report_id bigint, file_id bigint, valid_until date, defects integer, closed integer, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
#variable_conflict use_column
DECLARE
  v_actor text := app.require_manager();
  v_code text := NULLIF(btrim(COALESCE(p_site_code,'')),'');
  v_today date := app.compliance_today();
  v_now text := app.compliance_now_iso();
  v_kind text := COALESCE(NULLIF(p_meta->>'kind',''),'periodic');
  v_parse jsonb := COALESCE(p_meta->'parse','{}'::jsonb);
  v_client uuid; v_insp date; v_valid date; v_dl integer; v_clean boolean; v_close boolean;
  v_pinsp date; v_pvalid date; v_psrc text;
  v_site integer; v_mk text; v_src text; v_parent bigint; v_parent_insp date;
  v_mime text; v_data text; v_bytes integer; v_md5 text; v_fid bigint; v_id bigint;
  v_n integer := 0; v_closed integer := 0; v_d jsonb; v_body text; v_urg boolean; v_due date; v_cnt integer;
  v_req_key text; v_req_no text; v_pno text; v_label text; v_note text; v_rnum text; v_iname text; v_ilic text;
  v_fname text; v_pstore jsonb; v_max_live date; v_retired text;
BEGIN
  IF p_meta IS NULL OR jsonb_typeof(p_meta) <> 'object' THEN
    RAISE EXCEPTION 'פרטי התסקיר אינם תקינים' USING ERRCODE = 'check_violation'; END IF;
  BEGIN
    v_client := NULLIF(p_meta->>'client_id','')::uuid;
    v_insp   := NULLIF(p_meta->>'inspected_on','')::date;
    v_valid  := NULLIF(p_meta->>'valid_until','')::date;
    v_dl     := COALESCE(NULLIF(p_meta->>'default_deadline_days','')::int, 45);
    v_clean  := COALESCE(NULLIF(p_meta->>'confirm_clean','')::boolean, false);
    v_close  := COALESCE(NULLIF(p_meta->>'close_open_defects','')::boolean, false);
  EXCEPTION WHEN others THEN RAISE EXCEPTION 'פרטי התסקיר אינם תקינים' USING ERRCODE = 'check_violation'; END;
  BEGIN  -- פלט המפענח: אם לא תקין, פשוט לא משמש להוכחת מקור
    v_pinsp := NULLIF(v_parse#>>'{parsed,inspectedAt}','')::date;
    v_pvalid := NULLIF(v_parse#>>'{parsed,validUntil}','')::date;
    v_psrc := v_parse#>>'{parsed,validitySource}';
  EXCEPTION WHEN others THEN v_pinsp := NULL; v_pvalid := NULL; v_psrc := NULL; END;
  IF v_psrc IS NOT NULL AND v_psrc NOT IN ('document','next_inspection') THEN v_psrc := NULL; END IF;
  IF v_client IS NULL THEN RAISE EXCEPTION 'חסר מזהה בקשה' USING ERRCODE = 'check_violation'; END IF;

  -- replay: התגובה אבדה בדרך, הלקוח שולח שוב.
  -- ⚠️ למשתנים נפרדים: SELECT INTO בלי שורה מאפס את היעדים ל-NULL, והיה
  -- מוחק את v_valid שנקרא מהבקשה — כל העלאה חדשה הייתה נדחית "בלי תוקף".
  -- ⚠️ והתשובה החוזרת אומרת אמת: כמה ליקויים **חיים** יש, וכמה נסגרו בתסקיר הזה —
  -- לקוח שאיבד את התגובה הראשונה לא יגיד למנהל "לא נסגר דבר" על סגירה שקרתה.
  DECLARE v_rid bigint; v_rfid bigint; v_rvalid date;
  BEGIN
    SELECT r.id, r.file_id, r.valid_until INTO v_rid, v_rfid, v_rvalid FROM inspection_reports r WHERE r.client_id = v_client;
    IF v_rid IS NOT NULL THEN
      SELECT count(*)::int INTO v_cnt FROM inspection_defects d WHERE d.report_id = v_rid AND d.deleted_at IS NULL;
      SELECT count(*)::int INTO v_closed FROM inspection_defects d WHERE d.closed_by_report_id = v_rid;
      RETURN QUERY SELECT v_rid, v_rfid, v_rvalid, v_cnt, v_closed, true; RETURN;
    END IF;
  END;

  -- טקסט חופשי — תקרות (D2(ג)); אותן תקרות כמו ה-CHECK בטבלאות
  v_label := app.compliance_text(p_meta->>'machine_label', 80, 'שם המתקן');
  v_note  := app.compliance_text(p_meta->>'note', 2000, 'ההערה');
  v_rnum  := app.compliance_text(p_meta->>'report_number', 60, 'מספר התסקיר');
  v_iname := app.compliance_text(p_meta->>'inspector_name', 100, 'שם הבודק');
  v_ilic  := app.compliance_text(p_meta->>'inspector_license', 60, 'מספר רישיון הבודק');
  v_req_key := app.compliance_text(p_meta->>'machine_key', 40, 'מספר המתקן');
  v_req_no  := app.compliance_text(p_meta->>'machine_no', 60, 'מספר המתקן');
  -- ⚠️ parse_meta נשמר מרשימה מותרת, לא "הכול חוץ מ-rawLines": rawLines מקונן (section.rawLines),
  -- blob, lines — כל מה שהמפענח יוסיף מחר היה נשמר וחוזר ב-inspection_site לכל איש צוות.
  v_pstore := jsonb_strip_nulls(jsonb_build_object(
    'parser', CASE WHEN jsonb_typeof(v_parse->'parser') IN ('string','number') THEN left(v_parse->>'parser', 20) END,
    'confidence', CASE WHEN jsonb_typeof(v_parse->'confidence') IN ('string','number') THEN left(v_parse->>'confidence', 20) END,
    'notes', CASE WHEN jsonb_typeof(v_parse->'notes') = 'array' THEN (
               SELECT jsonb_agg(left(COALESCE(CASE jsonb_typeof(x.e) WHEN 'string' THEN x.e #>> '{}' END, x.e->>'code'), 40)
                                ORDER BY x.o)
                 FROM jsonb_array_elements(v_parse->'notes') WITH ORDINALITY AS x(e, o)
                WHERE x.o <= 20 AND (jsonb_typeof(x.e) = 'string'
                                     OR (jsonb_typeof(x.e) = 'object' AND jsonb_typeof(x.e->'code') = 'string'))) END,
    'extract', CASE WHEN jsonb_typeof(v_parse->'extract') = 'string' THEN left(v_parse->>'extract', 80) END,
    'parsed', jsonb_strip_nulls(jsonb_build_object('inspectedAt', v_pinsp, 'validUntil', v_pvalid, 'validitySource', v_psrc))));
  IF v_pstore = '{"parsed": {}}'::jsonb THEN v_pstore := NULL; END IF;

  SELECT s.id INTO v_site FROM sites s WHERE s.code = v_code;
  IF v_site IS NULL THEN RAISE EXCEPTION 'אתר לא נמצא: %', p_site_code USING ERRCODE = 'PT404'; END IF;
  IF v_kind NOT IN ('periodic','followup') THEN RAISE EXCEPTION 'סוג תסקיר לא תקין' USING ERRCODE = 'check_violation'; END IF;
  IF v_insp IS NULL OR v_insp > v_today OR v_insp < DATE '2000-01-01' THEN
    RAISE EXCEPTION 'תאריך בדיקה לא תקין' USING ERRCODE = 'check_violation'; END IF;
  IF v_dl NOT BETWEEN 0 AND 365 THEN RAISE EXCEPTION 'מועד תיקון ברירת מחדל לא תקין' USING ERRCODE = 'check_violation'; END IF;

  IF v_kind = 'followup' THEN
    BEGIN v_parent := NULLIF(p_meta->>'followup_of','')::bigint;
    EXCEPTION WHEN others THEN RAISE EXCEPTION 'תסקיר אב לא תקין' USING ERRCODE = 'check_violation'; END;
    -- ⚠️ D6: הבדיקה החוזרת שייכת ל**מתקן**. המתקן המבוקש = machine_key, ואם אין —
    -- machine_no (כמו בענף התקופתי, שגוזר ממנו את המפתח). בלי אף אחד מהם באתר
    -- עם יותר ממתקן פעיל אחד — שגיאה, לא ניחוש: ניחוש שגוי עם close_open_defects
    -- היה סוגר את הליקויים של המתקן **השני**.
    IF v_parent IS NULL THEN
      IF v_req_key IS NULL AND v_req_no IS NULL
         AND (SELECT count(*) FROM inspection_machines m WHERE m.site_id = v_site AND m.retired_at IS NULL) > 1 THEN
        RAISE EXCEPTION 'באתר יש יותר ממתקן אחד — יש לבחור מתקן לבדיקה החוזרת' USING ERRCODE = 'check_violation'; END IF;
      SELECT r.id INTO v_parent FROM inspection_reports r
       WHERE r.site_id = v_site AND r.kind = 'periodic' AND r.deleted_at IS NULL
         AND (v_req_key IS NULL OR r.machine_key = v_req_key)
         AND (v_req_key IS NOT NULL OR v_req_no IS NULL OR r.machine_key = v_req_no OR r.machine_no = v_req_no)
         AND r.inspected_on <= v_insp
       ORDER BY r.inspected_on DESC, r.id DESC LIMIT 1;
    END IF;
    SELECT r.machine_key, r.inspected_on, r.machine_no INTO v_mk, v_parent_insp, v_pno FROM inspection_reports r
     WHERE r.id = v_parent AND r.site_id = v_site AND r.kind = 'periodic' AND r.deleted_at IS NULL;
    IF v_mk IS NULL THEN
      RAISE EXCEPTION 'אין תסקיר תקופתי למתקן לשייך אליו את הבדיקה החוזרת' USING ERRCODE = 'check_violation'; END IF;
    -- אב מפורש ומתקן מפורש שאינם מסכימים — שגיאה, לא דריסה שקטה של המתקן שנבחר
    IF (v_req_key IS NOT NULL AND v_req_key <> v_mk)
       OR (v_req_key IS NULL AND v_req_no IS NOT NULL AND v_req_no <> v_mk AND v_req_no IS DISTINCT FROM v_pno) THEN
      RAISE EXCEPTION 'התסקיר התקופתי שנבחר שייך למתקן אחר (%)', v_mk USING ERRCODE = 'check_violation'; END IF;
    IF v_insp < v_parent_insp THEN
      RAISE EXCEPTION 'בדיקה חוזרת אינה יכולה להיות לפני התסקיר התקופתי' USING ERRCODE = 'check_violation'; END IF;
  ELSE
    v_mk := COALESCE(v_req_key, v_req_no, '1');
    IF length(v_mk) > 40 THEN RAISE EXCEPTION 'מספר מתקן ארוך מדי' USING ERRCODE = 'check_violation'; END IF;
    -- ⚠️ D5: אין ברירת מחדל של שנה. כפתור "+12 חודשים" בממשק שולח תאריך, והוא נרשם 'manual'.
    IF v_valid IS NULL THEN
      RAISE EXCEPTION 'יש להזין את תאריך התוקף מהמסמך' USING ERRCODE = 'check_violation'; END IF;
  END IF;

  -- D25: המקור נגזר בשרת. "מהמסמך" רק אם התאריך זהה לזה שפוענח.
  v_src := CASE WHEN v_valid IS NULL THEN 'inherited'
                WHEN v_valid = v_pvalid AND v_psrc = 'next_inspection' THEN 'next_inspection'
                WHEN v_valid = v_pvalid THEN 'document'
                ELSE 'manual' END;
  IF v_valid IS NOT NULL AND (v_valid <= v_insp OR v_valid > v_insp + 800) THEN
    RAISE EXCEPTION 'תאריך התוקף חייב להיות אחרי תאריך הבדיקה ועד כשנתיים ממנו' USING ERRCODE = 'check_violation'; END IF;

  IF jsonb_typeof(COALESCE(p_defects,'[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'רשימת ליקויים לא תקינה' USING ERRCODE = 'check_violation'; END IF;
  v_cnt := jsonb_array_length(COALESCE(p_defects,'[]'::jsonb));
  IF v_cnt > 100 THEN RAISE EXCEPTION 'יותר מ-100 ליקויים' USING ERRCODE = 'check_violation'; END IF;
  IF v_cnt = 0 AND NOT v_clean THEN
    RAISE EXCEPTION 'לא הוזנו ליקויים — יש לאשר במפורש שהתסקיר נקי' USING ERRCODE = 'check_violation'; END IF;
  IF v_cnt > 0 AND v_clean THEN
    RAISE EXCEPTION 'התסקיר סומן נקי אבל הוזנו ליקויים' USING ERRCODE = 'check_violation'; END IF;
  IF v_close AND (v_kind <> 'followup' OR NOT v_clean) THEN
    RAISE EXCEPTION 'סגירת ליקויים אפשרית רק בתסקיר חוזר נקי' USING ERRCODE = 'check_violation'; END IF;

  IF p_file IS NOT NULL THEN
    v_mime := p_file->>'mime'; v_data := p_file->>'data';               -- חילוץ אחד
    v_bytes := app.b64_check(v_mime, v_data, ARRAY['application/pdf'],
                             app.compliance_setting_int('compliance_pdf_max_bytes', 8388608), 'קובץ התסקיר');
    v_md5 := md5(v_data);
    SELECT f.id INTO v_fid FROM inspection_files f
     WHERE f.site_id = v_site AND f.content_md5 = v_md5 AND f.purged_at IS NULL ORDER BY f.id LIMIT 1;
    IF v_fid IS NULL THEN
      INSERT INTO inspection_files (site_id, site_code, mime, file_name, data_b64, byte_size, content_md5, uploaded_by, created_at)
      VALUES (v_site, v_code, 'application/pdf', left(NULLIF(btrim(p_file->>'name'),''), 200), v_data, v_bytes, v_md5, v_actor, v_now)
      RETURNING inspection_files.id INTO v_fid;
    END IF;   -- else: אותם בתים כבר שמורים (מתקן אחר / תסקיר שנמחק) — אין עותק שני
  ELSE
    BEGIN v_fid := NULLIF(p_meta->>'file_id','')::bigint;
    EXCEPTION WHEN others THEN v_fid := NULL; END;
    IF v_fid IS NULL OR NOT EXISTS (SELECT 1 FROM inspection_files f
                                     WHERE f.id = v_fid AND f.site_id = v_site AND f.purged_at IS NULL) THEN
      RAISE EXCEPTION 'קובץ התסקיר לא נמצא' USING ERRCODE = 'PT404'; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM inspection_reports r WHERE r.file_id = v_fid AND r.machine_key = v_mk
              AND r.kind = v_kind AND r.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'הקובץ הזה כבר הועלה למתקן הזה (קובץ %)', v_fid USING ERRCODE = 'PT409'; END IF;

  -- תסקיר תקופתי **חדש** למתקן שהוצא משימוש מחזיר אותו לשימוש. ⚠️ "חדש" = מאוחר מכל
  -- תקופתי חי של המתקן, או מיום ההוצאה ואילך. העלאת ארכיון (תסקיר ישן, מילוי לאחור)
  -- אינה מחזירה מתקן שפורק — אחרת המתקן חוזר לצבוע את נורת האתר בתוקף הישן שלו.
  SELECT m.retired_at INTO v_retired FROM inspection_machines m WHERE m.site_id = v_site AND m.machine_key = v_mk;
  SELECT max(r.inspected_on) INTO v_max_live FROM inspection_reports r
   WHERE r.site_id = v_site AND r.machine_key = v_mk AND r.kind = 'periodic' AND r.deleted_at IS NULL;
  INSERT INTO inspection_machines (site_id, machine_key, label, created_at)
  VALUES (v_site, v_mk, v_label, v_now)
  ON CONFLICT (site_id, machine_key) DO UPDATE
     SET retired_at = CASE WHEN v_kind = 'periodic' AND (v_max_live IS NULL OR v_insp > v_max_live
                                OR v_insp >= app.compliance_today_at(v_retired::timestamptz))
                           THEN NULL ELSE inspection_machines.retired_at END,
         retired_by = CASE WHEN v_kind = 'periodic' AND (v_max_live IS NULL OR v_insp > v_max_live
                                OR v_insp >= app.compliance_today_at(v_retired::timestamptz))
                           THEN NULL ELSE inspection_machines.retired_by END,
         retired_reason = CASE WHEN v_kind = 'periodic' AND (v_max_live IS NULL OR v_insp > v_max_live
                                OR v_insp >= app.compliance_today_at(v_retired::timestamptz))
                           THEN NULL ELSE inspection_machines.retired_reason END;

  INSERT INTO inspection_reports (client_id, site_id, site_code, machine_key, file_id, kind, followup_of, inspected_on,
         valid_until, validity_source, declared_clean, report_number, inspector_name, inspector_license, machine_no,
         parse_meta, note, uploaded_by, uploaded_by_user_id, created_at)
  VALUES (v_client, v_site, v_code, v_mk, v_fid, v_kind, CASE WHEN v_kind = 'followup' THEN v_parent END, v_insp,
         v_valid, v_src, v_clean, v_rnum, v_iname, v_ilic, v_req_no,
         v_pstore, v_note, v_actor, app.current_app_user(), v_now)
  RETURNING inspection_reports.id INTO v_id;

  FOR v_d IN SELECT e FROM jsonb_array_elements(COALESCE(p_defects,'[]'::jsonb)) e LOOP
    v_n := v_n + 1;
    IF jsonb_typeof(v_d) <> 'object' THEN RAISE EXCEPTION 'ליקוי % אינו תקין', v_n USING ERRCODE = 'check_violation'; END IF;
    v_body := NULLIF(btrim(COALESCE(v_d->>'body','')),'');
    IF v_body IS NULL OR length(v_body) < 2 THEN RAISE EXCEPTION 'ליקוי % ריק', v_n USING ERRCODE = 'check_violation'; END IF;
    IF length(v_body) > 2000 THEN RAISE EXCEPTION 'ליקוי % ארוך מדי', v_n USING ERRCODE = 'check_violation'; END IF;
    BEGIN
      v_urg := COALESCE(NULLIF(v_d->>'urgent','')::boolean, false);
      v_due := NULLIF(v_d->>'due_on','')::date;   -- נשלח רק אם המשתמש ערך את השדה
    EXCEPTION WHEN others THEN RAISE EXCEPTION 'תאריך יעד או דחיפות לא תקינים בליקוי %', v_n USING ERRCODE = 'check_violation'; END;
    INSERT INTO inspection_defects (report_id, seq, body, urgent, due_on, created_at)
    VALUES (v_id, v_n, v_body, v_urg, COALESCE(v_due, CASE WHEN v_urg THEN v_insp ELSE v_insp + v_dl END), v_now);
  END LOOP;

  IF v_close THEN v_closed := app.inspection_close_cycle(v_id, v_actor, 'תסקיר חוזר נקי'); END IF;

  PERFORM app.record_write_audit('inspection.upload', v_actor, app.current_app_role(), 'site', v_code,
    jsonb_build_object('report_id', v_id, 'file_id', v_fid, 'kind', v_kind, 'machine_key', v_mk,
                       'validity_source', v_src, 'declared_clean', v_clean, 'defects', v_n, 'closed', v_closed,
                       'bytes', v_bytes));
  PERFORM app.compliance_event(v_code, 'inspection', 'upload');
  RETURN QUERY SELECT v_id, v_fid, v_valid, v_n, v_closed, false;
END $fn$;
REVOKE ALL ON FUNCTION public.inspection_upload(text, jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inspection_upload(text, jsonb, jsonb, jsonb) TO authenticated;

-- ------------------------------------------------------------
-- inspection_report_update — עריכת פרטי תסקיר (לא kind ולא followup_of)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.inspection_report_update(p_report_id bigint, p_meta jsonb, p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_manager();
  v_today date := app.compliance_today();
  v_now text := app.compliance_now_iso();
  v_old inspection_reports%ROWTYPE; v_new inspection_reports%ROWTYPE;
  v_reason text := NULLIF(btrim(COALESCE(p_reason,'')),'');
  v_fields text[] := '{}'; v_before jsonb := '{}'::jsonb; v_after jsonb := '{}'::jsonb;
  v_parent_insp date; v_min_child date; v_live integer; v_code text; f text; v_reopened integer := 0;
BEGIN
  IF p_meta IS NULL OR jsonb_typeof(p_meta) <> 'object' THEN
    RAISE EXCEPTION 'פרטי התסקיר אינם תקינים' USING ERRCODE = 'check_violation'; END IF;
  SELECT r.* INTO v_old FROM inspection_reports r WHERE r.id = p_report_id FOR UPDATE;
  IF NOT FOUND OR v_old.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'התסקיר לא נמצא' USING ERRCODE = 'PT404'; END IF;
  IF (p_meta ? 'kind' AND p_meta->>'kind' IS DISTINCT FROM v_old.kind)
     OR (p_meta ? 'followup_of' AND NULLIF(p_meta->>'followup_of','') IS DISTINCT FROM v_old.followup_of::text) THEN
    RAISE EXCEPTION 'אי אפשר לשנות סוג תסקיר או שיוך לתסקיר אב — יש למחוק ולהעלות מחדש' USING ERRCODE = 'check_violation'; END IF;
  v_new := v_old;

  BEGIN
    IF p_meta ? 'inspected_on' THEN v_new.inspected_on := NULLIF(p_meta->>'inspected_on','')::date; END IF;
    IF p_meta ? 'valid_until'  THEN v_new.valid_until  := NULLIF(p_meta->>'valid_until','')::date; END IF;
    IF p_meta ? 'declared_clean' THEN v_new.declared_clean := COALESCE(NULLIF(p_meta->>'declared_clean','')::boolean, false); END IF;
  EXCEPTION WHEN others THEN RAISE EXCEPTION 'פרטי התסקיר אינם תקינים' USING ERRCODE = 'check_violation'; END;
  IF p_meta ? 'report_number'     THEN v_new.report_number     := app.compliance_text(p_meta->>'report_number', 60, 'מספר התסקיר'); END IF;
  IF p_meta ? 'inspector_name'    THEN v_new.inspector_name    := app.compliance_text(p_meta->>'inspector_name', 100, 'שם הבודק'); END IF;
  IF p_meta ? 'inspector_license' THEN v_new.inspector_license := app.compliance_text(p_meta->>'inspector_license', 60, 'מספר רישיון הבודק'); END IF;
  IF p_meta ? 'machine_no'        THEN v_new.machine_no        := app.compliance_text(p_meta->>'machine_no', 60, 'מספר המתקן'); END IF;
  IF p_meta ? 'note'              THEN v_new.note              := app.compliance_text(p_meta->>'note', 2000, 'ההערה'); END IF;
  IF v_reason IS NOT NULL AND length(v_reason) > 500 THEN
    RAISE EXCEPTION 'הסיבה ארוכה מדי (עד 500 תווים)' USING ERRCODE = 'check_violation'; END IF;
  IF p_meta ? 'machine_key' THEN
    v_new.machine_key := NULLIF(btrim(p_meta->>'machine_key'),'');
    IF v_new.machine_key IS NULL OR length(v_new.machine_key) > 40 THEN
      RAISE EXCEPTION 'מספר מתקן לא תקין' USING ERRCODE = 'check_violation'; END IF;
    IF v_old.kind = 'followup' AND v_new.machine_key <> v_old.machine_key THEN
      RAISE EXCEPTION 'בדיקה חוזרת יורשת את המתקן מהתסקיר התקופתי' USING ERRCODE = 'check_violation'; END IF;
    -- ⚠️ העברה למתקן שהוצא משימוש הייתה מעלימה תסקיר בתוקף מהנורה (המתקן הפעיל
    -- נמחק כשהתרוקן, והיעד אינו נספר). קודם מחזירים את המתקן — בהעלאה או בביטול.
    IF v_new.machine_key <> v_old.machine_key AND EXISTS (
         SELECT 1 FROM inspection_machines m WHERE m.site_id = v_old.site_id
            AND m.machine_key = v_new.machine_key AND m.retired_at IS NOT NULL) THEN
      RAISE EXCEPTION 'המתקן % הוצא משימוש — אי אפשר להעביר אליו תסקיר', v_new.machine_key
        USING ERRCODE = 'check_violation'; END IF;
  END IF;

  -- תאריך בדיקה
  IF v_new.inspected_on IS NULL OR v_new.inspected_on > v_today OR v_new.inspected_on < DATE '2000-01-01' THEN
    RAISE EXCEPTION 'תאריך בדיקה לא תקין' USING ERRCODE = 'check_violation'; END IF;
  IF v_old.kind = 'followup' THEN
    SELECT p.inspected_on INTO v_parent_insp FROM inspection_reports p WHERE p.id = v_old.followup_of;
    IF v_new.inspected_on < v_parent_insp THEN
      RAISE EXCEPTION 'בדיקה חוזרת אינה יכולה להיות לפני התסקיר התקופתי' USING ERRCODE = 'check_violation'; END IF;
  ELSE
    SELECT min(c.inspected_on) INTO v_min_child FROM inspection_reports c
     WHERE c.followup_of = v_old.id AND c.deleted_at IS NULL;
    IF v_min_child IS NOT NULL AND v_new.inspected_on > v_min_child THEN
      RAISE EXCEPTION 'תסקיר תקופתי אינו יכול להיות אחרי בדיקה חוזרת שלו' USING ERRCODE = 'check_violation'; END IF;
  END IF;

  -- תוקף: ערך שנערך נרשם 'manual'; NULL מותר רק בבדיקה חוזרת ('inherited')
  IF v_new.valid_until IS DISTINCT FROM v_old.valid_until THEN
    IF v_new.valid_until IS NULL THEN
      IF v_old.kind = 'periodic' THEN
        RAISE EXCEPTION 'יש להזין את תאריך התוקף מהמסמך' USING ERRCODE = 'check_violation'; END IF;
      v_new.validity_source := 'inherited';
    ELSE
      v_new.validity_source := 'manual';
    END IF;
  END IF;
  IF v_new.valid_until IS NOT NULL
     AND (v_new.valid_until <= v_new.inspected_on OR v_new.valid_until > v_new.inspected_on + 800) THEN
    RAISE EXCEPTION 'תאריך התוקף חייב להיות אחרי תאריך הבדיקה ועד כשנתיים ממנו' USING ERRCODE = 'check_violation'; END IF;

  -- D7: "נקי" רק בתסקיר שמעולם לא נרשם בו ליקוי, ועם סיבה (זה מה שסוגר מחזור).
  -- ⚠️ גם ליקוי שנמחק נספר: "מחיקה בסיבה 'טופל' + סימון התסקיר המקורי נקי" הדליקה ירוק בלי
  -- שום מסמך מהבודק (06/10/2026). תסקיר נקי מהבודק מעלים כבדיקה חוזרת; ליקויים שהוזנו
  -- בטעות — מוחקים את התסקיר ומעלים אותו מחדש עם "אין ליקויים".
  IF v_new.declared_clean AND NOT v_old.declared_clean THEN
    SELECT count(*)::int INTO v_live FROM inspection_defects d WHERE d.report_id = v_old.id;
    IF v_live > 0 THEN
      RAISE EXCEPTION 'בתסקיר הזה נרשמו ליקויים, ולכן הוא אינו נקי — תסקיר נקי מהבודק מעלים כבדיקה חוזרת' USING ERRCODE = 'check_violation'; END IF;
    IF v_reason IS NULL OR length(v_reason) < 2 THEN
      RAISE EXCEPTION 'סימון תסקיר כנקי מחייב סיבה' USING ERRCODE = 'check_violation'; END IF;
  END IF;

  FOREACH f IN ARRAY ARRAY['inspected_on','valid_until','validity_source','declared_clean','report_number',
                           'inspector_name','inspector_license','machine_no','note','machine_key'] LOOP
    IF (to_jsonb(v_old)->f) IS DISTINCT FROM (to_jsonb(v_new)->f) THEN
      v_fields := v_fields || f;
      v_before := v_before || jsonb_build_object(f, to_jsonb(v_old)->f);
      v_after  := v_after  || jsonb_build_object(f, to_jsonb(v_new)->f);
    END IF;
  END LOOP;
  IF cardinality(v_fields) = 0 THEN RETURN; END IF;

  UPDATE inspection_reports r
     SET inspected_on = v_new.inspected_on, valid_until = v_new.valid_until, validity_source = v_new.validity_source,
         declared_clean = v_new.declared_clean, report_number = v_new.report_number,
         inspector_name = v_new.inspector_name, inspector_license = v_new.inspector_license,
         machine_no = v_new.machine_no, note = v_new.note, machine_key = v_new.machine_key,
         updated_at = v_now, updated_by = v_actor
   WHERE r.id = v_old.id;

  IF v_new.machine_key <> v_old.machine_key THEN
    -- הבדיקות החוזרות עוברות עם התקופתי; המתקן החדש נוצר, והישן נמחק אם התרוקן
    UPDATE inspection_reports r SET machine_key = v_new.machine_key, updated_at = v_now, updated_by = v_actor
     WHERE r.followup_of = v_old.id;
    IF v_old.site_id IS NOT NULL THEN
      INSERT INTO inspection_machines (site_id, machine_key, created_at) VALUES (v_old.site_id, v_new.machine_key, v_now)
      ON CONFLICT (site_id, machine_key) DO NOTHING;
      DELETE FROM inspection_machines m WHERE m.site_id = v_old.site_id AND m.machine_key = v_old.machine_key
         AND NOT EXISTS (SELECT 1 FROM inspection_reports r WHERE r.site_id = v_old.site_id
                          AND r.machine_key = v_old.machine_key AND r.deleted_at IS NULL);
    END IF;
  END IF;

  -- ⚠️ D24: ביטול "נקי" מבטל את הראיה — הליקויים שנסגרו בתסקיר הזה נפתחים מחדש
  IF v_old.declared_clean AND NOT v_new.declared_clean THEN
    v_reopened := app.inspection_reopen_closed_by(v_old.id, v_actor, COALESCE(v_reason, 'בוטל סימון נקי'));
  END IF;

  v_code := app.compliance_code(v_old.site_id, v_old.site_code);
  PERFORM app.compliance_log(v_old.site_id, v_old.site_code, 'inspection', 'report', v_old.id, 'update',
                             v_actor, v_before, v_after, v_reason);
  PERFORM app.record_write_audit('inspection.report_update', v_actor, app.current_app_role(), 'site', v_code,
    jsonb_build_object('report_id', v_old.id, 'fields', to_jsonb(v_fields), 'reopened', v_reopened));
  PERFORM app.compliance_event(v_code, 'inspection', 'report_update');
END $fn$;
REVOKE ALL ON FUNCTION public.inspection_report_update(bigint, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inspection_report_update(bigint, jsonb, text) TO authenticated;

-- ------------------------------------------------------------
-- inspection_report_delete — מחיקה רכה עם סיבה
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.inspection_report_delete(p_report_id bigint, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_manager();
  v_reason text := app.compliance_reason(p_reason);
  v_r inspection_reports%ROWTYPE; v_code text; v_reopened integer;
BEGIN
  SELECT r.* INTO v_r FROM inspection_reports r WHERE r.id = p_report_id FOR UPDATE;
  IF NOT FOUND OR v_r.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'התסקיר לא נמצא' USING ERRCODE = 'PT404'; END IF;
  IF v_r.kind = 'periodic' AND EXISTS (SELECT 1 FROM inspection_reports c
                                        WHERE c.followup_of = v_r.id AND c.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'יש לתסקיר הזה בדיקות חוזרות — יש למחוק אותן קודם' USING ERRCODE = 'check_violation'; END IF;
  UPDATE inspection_reports r SET deleted_at = app.compliance_now_iso(), deleted_by = v_actor, deleted_reason = v_reason
   WHERE r.id = v_r.id;
  -- ⚠️ D24: תסקיר חוזר נקי שנמחק אינו ממשיך לסגור ליקויים — הם נפתחים מחדש
  v_reopened := app.inspection_reopen_closed_by(v_r.id, v_actor, v_reason);
  IF v_r.site_id IS NOT NULL THEN
    DELETE FROM inspection_machines m WHERE m.site_id = v_r.site_id AND m.machine_key = v_r.machine_key
       AND NOT EXISTS (SELECT 1 FROM inspection_reports r WHERE r.site_id = v_r.site_id
                        AND r.machine_key = v_r.machine_key AND r.deleted_at IS NULL);
  END IF;
  v_code := app.compliance_code(v_r.site_id, v_r.site_code);
  PERFORM app.compliance_log(v_r.site_id, v_r.site_code, 'inspection', 'report', v_r.id, 'delete', v_actor,
    jsonb_build_object('kind', v_r.kind, 'machine_key', v_r.machine_key, 'inspected_on', v_r.inspected_on,
                       'valid_until', v_r.valid_until), NULL, v_reason);
  PERFORM app.record_write_audit('inspection.report_delete', v_actor, app.current_app_role(), 'site', v_code,
    jsonb_build_object('report_id', v_r.id, 'kind', v_r.kind, 'machine_key', v_r.machine_key, 'reopened', v_reopened));
  PERFORM app.compliance_event(v_code, 'inspection', 'report_delete');
END $fn$;
REVOKE ALL ON FUNCTION public.inspection_report_delete(bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inspection_report_delete(bigint, text) TO authenticated;

-- ------------------------------------------------------------
-- inspection_machine_retire — מתקן שהוצא משימוש אינו צובע את נורת האתר
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.inspection_machine_retire(p_site_code text, p_machine_key text, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_manager();
  v_reason text := app.compliance_reason(p_reason);
  v_site integer; v_code text; v_mk text := btrim(COALESCE(p_machine_key,''));
BEGIN
  SELECT s.id, s.code INTO v_site, v_code FROM sites s WHERE s.code = btrim(COALESCE(p_site_code,''));
  IF v_site IS NULL THEN RAISE EXCEPTION 'אתר לא נמצא: %', p_site_code USING ERRCODE = 'PT404'; END IF;
  UPDATE inspection_machines m SET retired_at = app.compliance_now_iso(), retired_by = v_actor, retired_reason = v_reason
   WHERE m.site_id = v_site AND m.machine_key = v_mk AND m.retired_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'המתקן לא נמצא' USING ERRCODE = 'PT404'; END IF;
  PERFORM app.compliance_log(v_site, v_code, 'inspection', 'machine', NULL, 'retire', v_actor,
    NULL, jsonb_build_object('machine_key', v_mk), v_reason);
  PERFORM app.record_write_audit('inspection.machine_retire', v_actor, app.current_app_role(), 'site', v_code,
    jsonb_build_object('machine_key', v_mk));
  PERFORM app.compliance_event(v_code, 'inspection', 'machine_retire');
END $fn$;
REVOKE ALL ON FUNCTION public.inspection_machine_retire(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inspection_machine_retire(text, text, text) TO authenticated;

-- ------------------------------------------------------------
-- inspection_defect_save — הוספה או עריכה של ליקוי פתוח
-- ------------------------------------------------------------
-- ⚠️ D23: יצירה נושאת p_client_id (uuid שנוצר פעם אחת במסך). תגובה שאבדה ונשלחה
-- שוב מחזירה את אותו ליקוי — לא ליקוי שני שרק מנהל יכול להסיר, ורק עם סיבה.
-- ⚠️ החתימה השתנתה: ה-DROP מוחק את הישנה (5 פרמטרים), אחרת היו שתיים חיות.
DROP FUNCTION IF EXISTS public.inspection_defect_save(bigint, bigint, text, boolean, date);
CREATE OR REPLACE FUNCTION public.inspection_defect_save(p_report_id bigint, p_defect_id bigint, p_body text,
                                                         p_urgent boolean, p_due_on date, p_client_id uuid DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_manager();
  v_body text := NULLIF(btrim(COALESCE(p_body,'')),'');
  v_r inspection_reports%ROWTYPE; v_d inspection_defects%ROWTYPE; v_id bigint; v_code text; v_seq integer;
  v_fields text[] := '{}'; v_prev_report bigint;
BEGIN
  IF v_body IS NULL OR length(v_body) < 2 OR length(v_body) > 2000 THEN
    RAISE EXCEPTION 'תיאור הליקוי חייב להיות בין 2 ל-2000 תווים' USING ERRCODE = 'check_violation'; END IF;
  IF p_defect_id IS NULL AND p_client_id IS NOT NULL THEN                           -- replay
    SELECT d.id, d.report_id INTO v_id, v_prev_report FROM inspection_defects d WHERE d.client_id = p_client_id;
    IF v_id IS NOT NULL THEN
      IF v_prev_report <> p_report_id THEN
        RAISE EXCEPTION 'מזהה הבקשה כבר שימש לליקוי בתסקיר אחר' USING ERRCODE = 'PT409'; END IF;
      RETURN v_id;
    END IF;
  END IF;
  SELECT r.* INTO v_r FROM inspection_reports r WHERE r.id = p_report_id FOR UPDATE;
  IF NOT FOUND OR v_r.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'התסקיר לא נמצא' USING ERRCODE = 'PT404'; END IF;
  IF v_r.declared_clean THEN
    RAISE EXCEPTION 'התסקיר סומן נקי — יש לבטל את הסימון בעריכת התסקיר' USING ERRCODE = 'check_violation'; END IF;
  v_code := app.compliance_code(v_r.site_id, v_r.site_code);

  IF p_defect_id IS NULL THEN
    IF p_client_id IS NULL THEN RAISE EXCEPTION 'חסר מזהה בקשה' USING ERRCODE = 'check_violation'; END IF;
    SELECT COALESCE(max(d.seq), 0) + 1 INTO v_seq FROM inspection_defects d WHERE d.report_id = v_r.id;
    INSERT INTO inspection_defects (report_id, seq, body, urgent, due_on, created_at, client_id)
    VALUES (v_r.id, v_seq, v_body, COALESCE(p_urgent, false),
            COALESCE(p_due_on, CASE WHEN COALESCE(p_urgent,false) THEN v_r.inspected_on ELSE v_r.inspected_on + 45 END),
            app.compliance_now_iso(), p_client_id)
    RETURNING inspection_defects.id INTO v_id;
    PERFORM app.compliance_log(v_r.site_id, v_r.site_code, 'inspection', 'defect', v_id, 'create', v_actor,
      NULL, jsonb_build_object('body', v_body, 'urgent', COALESCE(p_urgent,false), 'due_on', p_due_on), NULL);
    v_fields := ARRAY['body','urgent','due_on'];
  ELSE
    SELECT d.* INTO v_d FROM inspection_defects d WHERE d.id = p_defect_id FOR UPDATE;
    IF NOT FOUND OR v_d.deleted_at IS NOT NULL OR v_d.report_id <> v_r.id THEN
      RAISE EXCEPTION 'הליקוי לא נמצא' USING ERRCODE = 'PT404'; END IF;
    IF v_d.status <> 'open' THEN RAISE EXCEPTION 'אפשר לערוך רק ליקוי פתוח' USING ERRCODE = 'PT409'; END IF;
    UPDATE inspection_defects d SET body = v_body, urgent = COALESCE(p_urgent, v_d.urgent),
           due_on = COALESCE(p_due_on, v_d.due_on)
     WHERE d.id = v_d.id;
    IF v_body IS DISTINCT FROM v_d.body THEN v_fields := v_fields || 'body'::text; END IF;
    IF COALESCE(p_urgent, v_d.urgent) IS DISTINCT FROM v_d.urgent THEN v_fields := v_fields || 'urgent'::text; END IF;
    IF COALESCE(p_due_on, v_d.due_on) IS DISTINCT FROM v_d.due_on THEN v_fields := v_fields || 'due_on'::text; END IF;
    PERFORM app.compliance_log(v_r.site_id, v_r.site_code, 'inspection', 'defect', v_d.id, 'update', v_actor,
      jsonb_build_object('body', v_d.body, 'urgent', v_d.urgent, 'due_on', v_d.due_on),
      jsonb_build_object('body', v_body, 'urgent', COALESCE(p_urgent, v_d.urgent), 'due_on', COALESCE(p_due_on, v_d.due_on)),
      NULL);
    v_id := v_d.id;
  END IF;
  PERFORM app.record_write_audit('inspection.defect_save', v_actor, app.current_app_role(), 'site', v_code,
    jsonb_build_object('defect_id', v_id, 'report_id', v_r.id, 'fields', to_jsonb(v_fields)));
  PERFORM app.compliance_event(v_code, 'inspection', 'defect_save');
  RETURN v_id;
END $fn$;
REVOKE ALL ON FUNCTION public.inspection_defect_save(bigint, bigint, text, boolean, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inspection_defect_save(bigint, bigint, text, boolean, date, uuid) TO authenticated;

-- ------------------------------------------------------------
-- inspection_defect_delete — מחיקה רכה; רק ליקוי פתוח שאין לו אף תמונה
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.inspection_defect_delete(p_defect_id bigint, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_manager();
  v_reason text := app.compliance_reason(p_reason);
  v_d inspection_defects%ROWTYPE; v_r inspection_reports%ROWTYPE; v_code text;
BEGIN
  SELECT d.* INTO v_d FROM inspection_defects d WHERE d.id = p_defect_id FOR UPDATE;
  IF NOT FOUND OR v_d.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'הליקוי לא נמצא' USING ERRCODE = 'PT404'; END IF;
  SELECT r.* INTO v_r FROM inspection_reports r WHERE r.id = v_d.report_id;
  IF v_r.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'התסקיר נמחק' USING ERRCODE = 'PT404'; END IF;
  IF v_d.status <> 'open' THEN RAISE EXCEPTION 'אפשר למחוק רק ליקוי פתוח' USING ERRCODE = 'PT409'; END IF;
  IF EXISTS (SELECT 1 FROM inspection_defect_photos ph WHERE ph.defect_id = v_d.id) THEN
    RAISE EXCEPTION 'לליקוי יש תמונות — אי אפשר למחוק אותו' USING ERRCODE = 'check_violation'; END IF;
  UPDATE inspection_defects d SET deleted_at = app.compliance_now_iso(), deleted_by = v_actor, deleted_reason = v_reason
   WHERE d.id = v_d.id;
  v_code := app.compliance_code(v_r.site_id, v_r.site_code);
  PERFORM app.compliance_log(v_r.site_id, v_r.site_code, 'inspection', 'defect', v_d.id, 'delete', v_actor,
    jsonb_build_object('body', v_d.body, 'urgent', v_d.urgent, 'due_on', v_d.due_on), NULL, v_reason);
  PERFORM app.record_write_audit('inspection.defect_delete', v_actor, app.current_app_role(), 'site', v_code,
    jsonb_build_object('defect_id', v_d.id, 'report_id', v_r.id));
  PERFORM app.compliance_event(v_code, 'inspection', 'defect_delete');
END $fn$;
REVOKE ALL ON FUNCTION public.inspection_defect_delete(bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inspection_defect_delete(bigint, text) TO authenticated;

-- ------------------------------------------------------------
-- inspection_defect_photo_add — תמונה נשמרת מיד כשנבחרה (staging)
-- ------------------------------------------------------------
-- ⚠️ אין אירוע: צילום ביניים אינו שינוי מצב. האירוע יוצא ב-done.
CREATE OR REPLACE FUNCTION public.inspection_defect_photo_add(p_defect_id bigint, p_photo jsonb, p_client_id uuid)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_staff();
  v_row inspection_defects%ROWTYPE; v_pid bigint; v_bytes integer; v_cur integer; v_all integer;
  v_mime text; v_data text; v_thumb text; v_other bigint;
BEGIN
  IF p_client_id IS NULL THEN RAISE EXCEPTION 'חסר מזהה בקשה' USING ERRCODE = 'check_violation'; END IF;
  -- replay. ⚠️ לפי client_id בלבד: אותו מזהה על ליקוי אחר הוא שגיאת לקוח, ומגיע
  -- כ-PT409 בעברית ולא כ-23505 גולמי מהאינדקס הייחודי.
  SELECT ph.id, ph.defect_id INTO v_pid, v_other FROM inspection_defect_photos ph WHERE ph.client_id = p_client_id;
  IF v_pid IS NOT NULL THEN
    IF v_other <> p_defect_id THEN
      RAISE EXCEPTION 'מזהה התמונה כבר שימש לליקוי אחר' USING ERRCODE = 'PT409'; END IF;
    RETURN v_pid;
  END IF;
  SELECT d.* INTO v_row FROM inspection_defects d WHERE d.id = p_defect_id FOR UPDATE;
  IF NOT FOUND OR v_row.deleted_at IS NOT NULL
     OR EXISTS (SELECT 1 FROM inspection_reports r WHERE r.id = v_row.report_id AND r.deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'הליקוי לא נמצא' USING ERRCODE = 'PT404'; END IF;
  IF v_row.status <> 'open' THEN RAISE EXCEPTION 'הליקוי כבר סומן כבוצע' USING ERRCODE = 'PT409'; END IF;
  SELECT count(*) FILTER (WHERE ph.closure_no = v_row.closure_no)::int, count(*)::int INTO v_cur, v_all
    FROM inspection_defect_photos ph WHERE ph.defect_id = p_defect_id;
  IF v_cur >= 3 THEN RAISE EXCEPTION 'אפשר לצרף עד 3 תמונות' USING ERRCODE = 'check_violation'; END IF;
  IF v_all >= 12 THEN RAISE EXCEPTION 'הגעתם למספר התמונות המרבי לליקוי' USING ERRCODE = 'check_violation'; END IF;
  IF p_photo IS NULL OR jsonb_typeof(p_photo) <> 'object' THEN
    RAISE EXCEPTION 'תמונה לא תקינה' USING ERRCODE = 'check_violation'; END IF;
  v_mime := p_photo->>'mime'; v_data := p_photo->>'data'; v_thumb := NULLIF(p_photo->>'thumb','');
  v_bytes := app.b64_check(v_mime, v_data, ARRAY['image/jpeg','image/webp'], 1048576, 'תמונה');
  IF v_thumb IS NOT NULL THEN
    PERFORM app.b64_check('image/jpeg', v_thumb, ARRAY['image/jpeg'], 40960, 'תמונה מוקטנת'); END IF;
  INSERT INTO inspection_defect_photos (client_id, defect_id, closure_no, mime, data_b64, thumb_b64, byte_size, uploaded_by, created_at)
  VALUES (p_client_id, p_defect_id, v_row.closure_no, v_mime, v_data, v_thumb, v_bytes, v_actor, app.compliance_now_iso())
  RETURNING inspection_defect_photos.id INTO v_pid;
  RETURN v_pid;
END $fn$;
REVOKE ALL ON FUNCTION public.inspection_defect_photo_add(bigint, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inspection_defect_photo_add(bigint, jsonb, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.inspection_defect_photo_delete(p_photo_id bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_staff();
  v_ph inspection_defect_photos%ROWTYPE; v_d inspection_defects%ROWTYPE;
BEGIN
  SELECT ph.* INTO v_ph FROM inspection_defect_photos ph WHERE ph.id = p_photo_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'התמונה לא נמצאה' USING ERRCODE = 'PT404'; END IF;
  SELECT d.* INTO v_d FROM inspection_defects d WHERE d.id = v_ph.defect_id FOR UPDATE;
  IF v_d.deleted_at IS NOT NULL
     OR EXISTS (SELECT 1 FROM inspection_reports r WHERE r.id = v_d.report_id AND r.deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'הליקוי לא נמצא' USING ERRCODE = 'PT404'; END IF;
  IF v_d.status <> 'open' OR v_d.closure_no <> v_ph.closure_no THEN
    RAISE EXCEPTION 'תמונת ראיה של סגירה קודמת אינה נמחקת' USING ERRCODE = 'check_violation'; END IF;
  DELETE FROM inspection_defect_photos ph WHERE ph.id = v_ph.id;
END $fn$;
REVOKE ALL ON FUNCTION public.inspection_defect_photo_delete(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inspection_defect_photo_delete(bigint) TO authenticated;

-- ------------------------------------------------------------
-- inspection_defect_done — "בוצע": שם המבצע ותמונה — שניהם רשות (06/10/2026); בלי שם — המשתמש המחובר.
-- כשיש תמונות, הראשונה היא done_photo_id (D8: המפתח המורכב מבטיח שהיא של הליקוי ושל הסגירה הזו).
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.inspection_defect_done(bigint, text, text, uuid);
CREATE FUNCTION public.inspection_defect_done(p_defect_id bigint, p_done_by_name text, p_note text, p_request_id uuid)
RETURNS TABLE (defect_id bigint, photos integer, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
#variable_conflict use_column
DECLARE
  v_actor text := app.require_staff();
  v_name text := NULLIF(btrim(COALESCE(p_done_by_name,'')),'');
  v_note text := NULLIF(btrim(COALESCE(p_note,'')),'');
  v_row inspection_defects%ROWTYPE; v_first bigint; v_k integer; v_code text;
BEGIN
  -- ⚠️ שם המבצע — רשות (בעלת המוצר, 06/10/2026: "שיוכלו לעשות סמן כבוצע בלי למלא את הכל").
  -- בלי שם נרשם המשתמש המחובר — מהזהות המאומתת, לא מגוף הבקשה — כך שהשורה תמיד אומרת מי סימן,
  -- והאילוץ (done_by_name חובה) נשאר כמו שהוא.
  IF v_name IS NULL OR length(v_name) < 2 THEN
    v_name := COALESCE(NULLIF(btrim(app.actor_display_name()), ''), v_actor);
  END IF;
  IF length(v_name) > 100 THEN RAISE EXCEPTION 'שם המבצע ארוך מדי (עד 100 תווים)' USING ERRCODE = 'check_violation'; END IF;
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'חסר מזהה בקשה' USING ERRCODE = 'check_violation'; END IF;
  IF v_note IS NOT NULL AND length(v_note) > 1000 THEN
    RAISE EXCEPTION 'ההערה ארוכה מדי' USING ERRCODE = 'check_violation'; END IF;
  SELECT d.* INTO v_row FROM inspection_defects d WHERE d.id = p_defect_id FOR UPDATE;
  IF NOT FOUND OR v_row.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'הליקוי לא נמצא' USING ERRCODE = 'PT404'; END IF;
  SELECT app.compliance_code(r.site_id, r.site_code) INTO v_code FROM inspection_reports r
   WHERE r.id = v_row.report_id AND r.deleted_at IS NULL;
  IF v_code IS NULL THEN RAISE EXCEPTION 'התסקיר נמחק' USING ERRCODE = 'PT404'; END IF;
  IF v_row.status = 'done' THEN
    IF v_row.done_request_id = p_request_id THEN                                     -- replay, not an error
      RETURN QUERY SELECT p_defect_id, (SELECT count(*)::int FROM inspection_defect_photos ph
                                         WHERE ph.defect_id = p_defect_id AND ph.closure_no = v_row.closure_no), true;
      RETURN; END IF;
    RAISE EXCEPTION 'הליקוי כבר סומן כבוצע' USING ERRCODE = 'PT409';
  END IF;
  SELECT min(ph.id), count(*)::int INTO v_first, v_k FROM inspection_defect_photos ph
   WHERE ph.defect_id = p_defect_id AND ph.closure_no = v_row.closure_no;
  UPDATE inspection_defects d SET status = 'done', done_at = app.compliance_now_iso(), done_by = v_actor,
         done_by_user_id = app.current_app_user(), done_by_name = v_name, done_note = v_note,
         done_photo_id = v_first, done_request_id = p_request_id
   WHERE d.id = p_defect_id;
  -- ⚠️ D22: בלי שם ובלי הערה ב-audit_log — רק מזהים וספירה
  PERFORM app.record_write_audit('inspection.defect_done', v_actor, app.current_app_role(), 'site', v_code,
    jsonb_build_object('defect_id', p_defect_id, 'report_id', v_row.report_id, 'photos', v_k));
  PERFORM app.compliance_event(v_code, 'inspection', 'defect_done');
  RETURN QUERY SELECT p_defect_id, v_k, false;
END $fn$;
REVOKE ALL ON FUNCTION public.inspection_defect_done(bigint, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inspection_defect_done(bigint, text, text, uuid) TO authenticated;

-- ------------------------------------------------------------
-- inspection_close_by_report — סגירה בתסקיר חוזר נקי (D24, [FLIP] Q9)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.inspection_close_by_report(p_report_id bigint, p_reason text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_manager();
  v_r inspection_reports%ROWTYPE; v_n integer; v_code text;
BEGIN
  SELECT r.* INTO v_r FROM inspection_reports r WHERE r.id = p_report_id FOR UPDATE;
  IF NOT FOUND OR v_r.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'התסקיר לא נמצא' USING ERRCODE = 'PT404'; END IF;
  v_n := app.inspection_close_cycle(v_r.id, v_actor, COALESCE(app.compliance_reason(p_reason, false), 'תסקיר חוזר נקי'));
  v_code := app.compliance_code(v_r.site_id, v_r.site_code);
  PERFORM app.record_write_audit('inspection.close_by_report', v_actor, app.current_app_role(), 'site', v_code,
    jsonb_build_object('report_id', v_r.id, 'closed', v_n));
  PERFORM app.compliance_event(v_code, 'inspection', 'close_by_report');
  RETURN v_n;
END $fn$;
REVOKE ALL ON FUNCTION public.inspection_close_by_report(bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inspection_close_by_report(bigint, text) TO authenticated;

-- ------------------------------------------------------------
-- inspection_defect_reopen — closure_no עולה; התמונות הישנות נשארות כהיסטוריה
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.inspection_defect_reopen(p_defect_id bigint, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_manager();
  v_reason text := app.compliance_reason(p_reason);
  v_d inspection_defects%ROWTYPE; v_r inspection_reports%ROWTYPE; v_code text;
BEGIN
  SELECT d.* INTO v_d FROM inspection_defects d WHERE d.id = p_defect_id FOR UPDATE;
  IF NOT FOUND OR v_d.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'הליקוי לא נמצא' USING ERRCODE = 'PT404'; END IF;
  SELECT r.* INTO v_r FROM inspection_reports r WHERE r.id = v_d.report_id;
  IF v_r.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'התסקיר נמחק' USING ERRCODE = 'PT404'; END IF;
  IF v_d.status <> 'done' THEN RAISE EXCEPTION 'הליקוי כבר פתוח' USING ERRCODE = 'PT409'; END IF;
  -- ⚠️ עדכון אחד: המפתח המורכב (id, closure_no, done_photo_id) היה נשבר בשני שלבים
  UPDATE inspection_defects d
     SET status = 'open', closure_no = d.closure_no + 1, done_at = NULL, done_by = NULL, done_by_user_id = NULL,
         done_by_name = NULL, done_note = NULL, done_photo_id = NULL, closed_by_report_id = NULL, done_request_id = NULL
   WHERE d.id = v_d.id;
  v_code := app.compliance_code(v_r.site_id, v_r.site_code);
  PERFORM app.compliance_log(v_r.site_id, v_r.site_code, 'inspection', 'defect', v_d.id, 'reopen', v_actor,
    jsonb_build_object('closure_no', v_d.closure_no, 'done_at', v_d.done_at, 'done_by_name', v_d.done_by_name,
                       'done_note', v_d.done_note, 'closed_by_report_id', v_d.closed_by_report_id),
    jsonb_build_object('closure_no', v_d.closure_no + 1), v_reason);
  PERFORM app.record_write_audit('inspection.defect_reopen', v_actor, app.current_app_role(), 'site', v_code,
    jsonb_build_object('defect_id', v_d.id, 'report_id', v_r.id));
  PERFORM app.compliance_event(v_code, 'inspection', 'defect_reopen');
END $fn$;
REVOKE ALL ON FUNCTION public.inspection_defect_reopen(bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inspection_defect_reopen(bigint, text) TO authenticated;

-- ============================================================
-- 2.2 תחזוקה מונעת — RPC
-- ============================================================

-- ⚠️ כל פעולה שמשנה טיוטה עוברת כאן: נעילת הביקור (FOR NO KEY UPDATE),
-- בדיקה חוזרת שהוא עדיין טיוטה, וקידום last_activity_at. כך המשנים
-- מסודרים מול ההגשה (FOR UPDATE) ומול עצמם, והתקרות נספרות תחת הנעילה.
CREATE OR REPLACE FUNCTION app.pm_draft_lock(p_visit_id bigint) RETURNS pm_visits
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE v pm_visits%ROWTYPE;
BEGIN
  SELECT pv.* INTO v FROM pm_visits pv WHERE pv.id = p_visit_id FOR NO KEY UPDATE;
  IF NOT FOUND OR v.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'הביקור לא נמצא' USING ERRCODE = 'PT404'; END IF;
  IF v.status <> 'draft' THEN RAISE EXCEPTION 'הביקור כבר הוגש' USING ERRCODE = 'check_violation'; END IF;
  UPDATE pm_visits pv SET last_activity_at = app.compliance_now_iso() WHERE pv.id = v.id;
  RETURN v;
END $fn$;
REVOKE ALL ON FUNCTION app.pm_draft_lock(bigint) FROM PUBLIC;

-- מותר לזרוק/להתחיל מחדש טיוטה: מנהל, מי שפתח אותה, או כל צוות אחרי 48 שעות שקט
CREATE OR REPLACE FUNCTION app.pm_may_discard(p_visit pm_visits) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
  SELECT app.compliance_verified_manager()   -- ⚠️ לא is_manager(): ראו ההגדרה
      OR (p_visit.started_by_user_id IS NOT NULL AND p_visit.started_by_user_id = app.current_app_user())
      OR p_visit.last_activity_at::timestamptz < now() - interval '48 hours'
$$;
REVOKE ALL ON FUNCTION app.pm_may_discard(pm_visits) FROM PUBLIC;

-- ------------------------------------------------------------
-- pm_site — מה שהלשונית צריכה, בלי base64. זול מספיק לסקירה חוזרת (D16).
-- ------------------------------------------------------------
-- ------------------------------------------------------------
-- אילו רשימות אתר מקבל — במקום אחד (07/10/2026)
-- ------------------------------------------------------------
-- שויך במפורש → הרשימות הפעילות שלו, לפי seq. לא שויך (או שכל מה ששויך הושבת) →
-- רשימת ברירת המחדל. כל מי שבונה ביקור או מציג "כמה פריטים" עובר כאן, אחרת
-- הכרטיס יאמר דבר אחד והביקור יצולם מדבר אחר.
CREATE OR REPLACE FUNCTION app.pm_site_template_ids(p_site_id integer) RETURNS integer[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
  SELECT COALESCE(
    (SELECT array_agg(t.id ORDER BY t.seq, t.id)
       FROM pm_site_templates st JOIN pm_templates t ON t.id = st.template_id
      WHERE st.site_id = p_site_id AND t.active),
    (SELECT array_agg(t.id) FROM pm_templates t WHERE t.is_default AND t.active),
    '{}'::integer[])
$$;
REVOKE ALL ON FUNCTION app.pm_site_template_ids(integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.pm_site(p_site_code text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_staff();
  v_site integer; v_code text; v_name text; v_draft jsonb;
BEGIN
  SELECT s.id, s.code, s.site_name INTO v_site, v_code, v_name FROM sites s WHERE s.code = btrim(COALESCE(p_site_code,''));
  IF v_site IS NULL THEN RAISE EXCEPTION 'אתר לא נמצא: %', p_site_code USING ERRCODE = 'PT404'; END IF;
  SELECT jsonb_build_object('id', v.id, 'started_by', v.started_by, 'started_by_user_id', v.started_by_user_id,
           'started_at', v.started_at, 'last_activity_at', v.last_activity_at,
           'items', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                       'id', i.id, 'seq', i.seq, 'label', i.label, 'hint', i.hint, 'kind', i.kind,
                       'section', i.section, 'required', i.required, 'min_photos', i.min_photos, 'checked', i.checked, 'note', i.note,
                       'updated_by', i.updated_by, 'updated_at', i.updated_at,
                       'photos', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', f.id, 'client_id', f.client_id,
                                                                               'byte_size', f.byte_size) ORDER BY f.id)
                                             FROM pm_files f WHERE f.visit_item_id = i.id AND f.kind = 'photo'), '[]'::jsonb))
                     ORDER BY i.seq, i.id) FROM pm_visit_items i WHERE i.visit_id = v.id), '[]'::jsonb))
    INTO v_draft
    FROM pm_visits v WHERE v.site_id = v_site AND v.status = 'draft';
  RETURN jsonb_build_object(
    'site', jsonb_build_object('id', v_site, 'code', v_code, 'name', v_name),
    'status', (SELECT to_jsonb(r) FROM app.compliance_rows(ARRAY[v_site], app.compliance_today()) r),
    'template_count', (SELECT count(*)::int FROM pm_checklist_items t
                        WHERE t.active AND t.template_id = ANY (app.pm_site_template_ids(v_site))),
    -- הרשימות שהאתר מקבל (07/10/2026), ו-templates_assigned = שויך במפורש (false = ברירת המחדל)
    'templates', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) ORDER BY x.o), '[]'::jsonb)
                    FROM unnest(app.pm_site_template_ids(v_site)) WITH ORDINALITY AS x(tid, o)
                    JOIN pm_templates t ON t.id = x.tid),
    'templates_assigned', EXISTS (SELECT 1 FROM pm_site_templates st JOIN pm_templates t ON t.id = st.template_id
                                   WHERE st.site_id = v_site AND t.active),
    -- שם התצוגה של הקורא, כפי שנכתב ב-updated_by / started_by. הדפדפן מכיר רק את
    -- המייל — בלי זה עריכה של המשתמש עצמו הוצגה "עודכן ע״י <השם שלו>".
    'me', v_actor,
    'draft', v_draft,
    'visits', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', v.id, 'source', v.source, 'performed_on', v.performed_on, 'performer_name', v.performer_name,
               'vendor', v.vendor, 'note', v.note, 'submitted_by', v.submitted_by, 'submitted_at', v.submitted_at,
               'items_total', (SELECT count(*)::int FROM pm_visit_items i WHERE i.visit_id = v.id),
               'items_checked', (SELECT count(*)::int FROM pm_visit_items i WHERE i.visit_id = v.id AND i.checked),
               -- ⚠️ "בוצע" = וי היכן שנדרש וי, ומספר התמונות הנדרש. items_checked אינו
               -- סופר פריט צילום בלבד (אין לו וי), וביקור שלם נקרא "3/5".
               'items_done', (SELECT count(*)::int FROM pm_visit_items i WHERE i.visit_id = v.id
                                AND (i.kind = 'photo' OR i.checked)
                                AND (SELECT count(*) FROM pm_files f WHERE f.visit_item_id = i.id AND f.kind = 'photo') >= i.min_photos),
               'photo_count', (SELECT count(*)::int FROM pm_files f WHERE f.visit_id = v.id AND f.kind = 'photo'),
               'has_signature', v.signature_b64 IS NOT NULL,
               'file', (SELECT jsonb_build_object('id', f.id, 'file_name', f.file_name, 'byte_size', f.byte_size)
                          FROM pm_files f WHERE f.visit_id = v.id AND f.kind = 'pdf' ORDER BY f.id LIMIT 1))
             ORDER BY v.performed_on DESC, v.id DESC)
        FROM pm_visits v WHERE v.site_id = v_site AND v.status = 'submitted' AND v.deleted_at IS NULL), '[]'::jsonb));
END $fn$;
REVOKE ALL ON FUNCTION public.pm_site(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_site(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.pm_visit_detail(p_visit_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_staff();
  v pm_visits%ROWTYPE;
BEGIN
  SELECT pv.* INTO v FROM pm_visits pv WHERE pv.id = p_visit_id;
  IF NOT FOUND OR (v.deleted_at IS NOT NULL AND NOT app.compliance_verified_manager()) THEN
    RAISE EXCEPTION 'הביקור לא נמצא' USING ERRCODE = 'PT404'; END IF;
  RETURN jsonb_build_object(
    'id', v.id, 'site_code', app.compliance_code(v.site_id, v.site_code), 'source', v.source, 'status', v.status,
    'performed_on', v.performed_on, 'performer_name', v.performer_name, 'vendor', v.vendor, 'note', v.note,
    'started_by', v.started_by, 'started_at', v.started_at, 'submitted_by', v.submitted_by,
    'submitted_at', v.submitted_at, 'has_signature', v.signature_b64 IS NOT NULL,
    'deleted_at', v.deleted_at, 'deleted_reason', v.deleted_reason,
    'file', (SELECT jsonb_build_object('id', f.id, 'file_name', f.file_name, 'byte_size', f.byte_size)
               FROM pm_files f WHERE f.visit_id = v.id AND f.kind = 'pdf' ORDER BY f.id LIMIT 1),
    'items', COALESCE((SELECT jsonb_agg(jsonb_build_object(
               'id', i.id, 'seq', i.seq, 'label', i.label, 'hint', i.hint, 'kind', i.kind, 'required', i.required,
               'section', i.section, 'min_photos', i.min_photos, 'checked', i.checked, 'note', i.note,
               'photos', COALESCE((SELECT jsonb_agg(f.id ORDER BY f.id) FROM pm_files f
                                    WHERE f.visit_item_id = i.id AND f.kind = 'photo'), '[]'::jsonb))
             ORDER BY i.seq, i.id) FROM pm_visit_items i WHERE i.visit_id = v.id), '[]'::jsonb));
END $fn$;
REVOKE ALL ON FUNCTION public.pm_visit_detail(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_visit_detail(bigint) TO authenticated;

-- ------------------------------------------------------------
-- רשימות התחזוקה (D15 → 07/10/2026: כמה רשימות, ושיוך לאתר)
-- ------------------------------------------------------------
-- ⚠️ p_template_id ריק = רשימת ברירת המחדל. כך כל קורא קיים (העורך, הבדיקות) ממשיך
-- לעבוד על מה שהיה "הרשימה" — ורק מי שמבקש רשימה אחרת מקבל אחרת.
CREATE OR REPLACE FUNCTION app.pm_template_resolve(p_template_id integer) RETURNS pm_templates
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE v pm_templates%ROWTYPE;
BEGIN
  IF p_template_id IS NULL THEN
    SELECT t.* INTO v FROM pm_templates t WHERE t.is_default AND t.active;
  ELSE
    SELECT t.* INTO v FROM pm_templates t WHERE t.id = p_template_id AND t.active;
  END IF;
  IF v.id IS NULL THEN RAISE EXCEPTION 'רשימת התחזוקה לא נמצאה' USING ERRCODE = 'PT404'; END IF;
  RETURN v;
END $fn$;
REVOKE ALL ON FUNCTION app.pm_template_resolve(integer) FROM PUBLIC;

DROP FUNCTION IF EXISTS public.pm_template();
CREATE OR REPLACE FUNCTION public.pm_template(p_template_id integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE v_actor text := app.require_staff(); v_t pm_templates;
BEGIN
  v_t := app.pm_template_resolve(p_template_id);
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'seq', t.seq, 'label', t.label, 'hint', t.hint,
                                    'section', t.section, 'kind', t.kind, 'required', t.required, 'min_photos', t.min_photos,
                                    'updated_at', t.updated_at, 'updated_by', t.updated_by) ORDER BY t.seq, t.id)
                     FROM pm_checklist_items t WHERE t.active AND t.template_id = v_t.id), '[]'::jsonb);
END $fn$;
REVOKE ALL ON FUNCTION public.pm_template(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_template(integer) TO authenticated;

-- כל הרשימות, לבורר בעורך ולשיוך באתר: כמה פריטים, וכמה אתרים שויכו אליה במפורש.
CREATE OR REPLACE FUNCTION public.pm_templates_list() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE v_actor text := app.require_staff();
BEGIN
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'id', t.id, 'name', t.name, 'seq', t.seq, 'is_default', t.is_default,
             'item_count', (SELECT count(*)::int FROM pm_checklist_items i WHERE i.active AND i.template_id = t.id),
             'site_count', (SELECT count(*)::int FROM pm_site_templates st WHERE st.template_id = t.id))
           ORDER BY t.is_default DESC, t.seq, t.id)
         FROM pm_templates t WHERE t.active), '[]'::jsonb);
END $fn$;
REVOKE ALL ON FUNCTION public.pm_templates_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_templates_list() TO authenticated;

CREATE OR REPLACE FUNCTION public.pm_template_create(p_name text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_manager();
  v_now text := app.compliance_now_iso();
  v_name text := btrim(COALESCE(p_name, ''));
  v_id integer;
BEGIN
  IF length(v_name) NOT BETWEEN 2 AND 60 THEN
    RAISE EXCEPTION 'שם הרשימה חייב להיות בין 2 ל-60 תווים' USING ERRCODE = 'check_violation'; END IF;
  IF EXISTS (SELECT 1 FROM pm_templates t WHERE t.active AND lower(btrim(t.name)) = lower(v_name)) THEN
    RAISE EXCEPTION 'כבר קיימת רשימה בשם "%"', v_name USING ERRCODE = 'PT409'; END IF;
  INSERT INTO pm_templates (name, seq, updated_at, updated_by)
  VALUES (v_name, COALESCE((SELECT max(t.seq) FROM pm_templates t), 0) + 1, v_now, v_actor)
  RETURNING pm_templates.id INTO v_id;
  PERFORM app.compliance_log(NULL, '*', 'pm', 'template', v_id, 'create', v_actor, NULL,
    jsonb_build_object('name', v_name), NULL);
  PERFORM app.record_write_audit('pm.template_create', v_actor, app.current_app_role(), 'settings', 'pm_template',
    jsonb_build_object('template_id', v_id));   -- D22: מזהים בלבד, לא השם
  RETURN v_id;
END $fn$;
REVOKE ALL ON FUNCTION public.pm_template_create(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_template_create(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.pm_template_rename(p_template_id integer, p_name text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_manager();
  v_name text := btrim(COALESCE(p_name, ''));
  v_t pm_templates;
BEGIN
  v_t := app.pm_template_resolve(p_template_id);
  IF length(v_name) NOT BETWEEN 2 AND 60 THEN
    RAISE EXCEPTION 'שם הרשימה חייב להיות בין 2 ל-60 תווים' USING ERRCODE = 'check_violation'; END IF;
  IF EXISTS (SELECT 1 FROM pm_templates t WHERE t.active AND t.id <> v_t.id AND lower(btrim(t.name)) = lower(v_name)) THEN
    RAISE EXCEPTION 'כבר קיימת רשימה בשם "%"', v_name USING ERRCODE = 'PT409'; END IF;
  UPDATE pm_templates t SET name = v_name, updated_at = app.compliance_now_iso(), updated_by = v_actor
   WHERE t.id = v_t.id;
  PERFORM app.compliance_log(NULL, '*', 'pm', 'template', v_t.id, 'rename', v_actor,
    jsonb_build_object('name', v_t.name), jsonb_build_object('name', v_name), NULL);
END $fn$;
REVOKE ALL ON FUNCTION public.pm_template_rename(integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_template_rename(integer, text) TO authenticated;

-- הרשימה שנשלחת היא מצב היעד **של רשימה אחת**: פריט עם id מתעדכן, בלי id נוסף,
-- ומה שלא נשלח מושבת (לא נמחק — ביקורים קיימים מצביעים עליו).
--
-- ⚠️ p_expected_at — ה-updated_at המאוחר **ברשימה הזו** שהעורך טען ('' = נטענה ריקה).
-- מצב יעד שלם מעורך ישן היה מבטל בשקט שמירה של מנהל אחר: פריטים שהוסיף
-- מושבתים, ופריטים שהסיר חוזרים — וכל ביקור שייפתח אחר כך יורש את זה. לכן
-- שמירה שאינה מהגרסה הנוכחית נדחית ב-PT409. NULL = בלי בדיקה (קורא ישן).
-- ⚠️ ונעילת הטבלה: בלעדיה שתי שמירות במקביל היו קוראות את אותה גרסה ושתיהן עוברות.
--
-- ⚠️ סכום min_photos של פריטי החובה ≤ 40 — התקרה של pm_visit_photo_add (v_all >= 40).
-- כאן לכל רשימה; ביקור שמצרף כמה רשימות נבדק שוב בפתיחה (pm_visit_start).
DROP FUNCTION IF EXISTS public.pm_template_save(jsonb);
DROP FUNCTION IF EXISTS public.pm_template_save(jsonb, text);
CREATE OR REPLACE FUNCTION public.pm_template_save(p_items jsonb, p_expected_at text DEFAULT NULL,
                                                   p_template_id integer DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_manager();
  v_now text := app.compliance_now_iso();
  v_t pm_templates;
  v_before jsonb; v_after jsonb; v_keep integer[] := '{}';
  v_e jsonb; v_ord bigint; v_id integer; v_label text; v_hint text; v_kind text; v_req boolean; v_min integer;
  v_sec text; v_n integer; v_cur text; v_who text; v_photos integer;
BEGIN
  v_t := app.pm_template_resolve(p_template_id);
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'רשימת הבדיקה אינה תקינה' USING ERRCODE = 'check_violation'; END IF;
  IF jsonb_array_length(p_items) > 100 THEN
    RAISE EXCEPTION 'יותר מ-100 פריטים' USING ERRCODE = 'check_violation'; END IF;
  LOCK TABLE pm_checklist_items IN SHARE ROW EXCLUSIVE MODE;
  IF p_expected_at IS NOT NULL THEN
    SELECT t.updated_at, t.updated_by INTO v_cur, v_who
      FROM pm_checklist_items t WHERE t.active AND t.template_id = v_t.id
     ORDER BY t.updated_at DESC, t.id DESC LIMIT 1;
    IF COALESCE(v_cur, '') <> p_expected_at THEN
      RAISE EXCEPTION 'רשימת הבדיקה עודכנה בינתיים ע״י % — יש לטעון אותה מחדש לפני השמירה',
        COALESCE(v_who, 'מנהל אחר') USING ERRCODE = 'PT409';
    END IF;
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', t.id, 'label', t.label, 'kind', t.kind, 'required', t.required,
                                               'min_photos', t.min_photos, 'section', t.section) ORDER BY t.seq, t.id), '[]'::jsonb)
    INTO v_before FROM pm_checklist_items t WHERE t.active AND t.template_id = v_t.id;

  FOR v_e, v_ord IN SELECT e, o FROM jsonb_array_elements(p_items) WITH ORDINALITY AS x(e, o) LOOP
    IF jsonb_typeof(v_e) <> 'object' THEN RAISE EXCEPTION 'פריט % אינו תקין', v_ord USING ERRCODE = 'check_violation'; END IF;
    BEGIN
      v_id  := NULLIF(v_e->>'id','')::integer;
      v_req := COALESCE(NULLIF(v_e->>'required','')::boolean, true);
      v_min := COALESCE(NULLIF(v_e->>'min_photos','')::integer, 0);
    EXCEPTION WHEN others THEN RAISE EXCEPTION 'פריט % אינו תקין', v_ord USING ERRCODE = 'check_violation'; END;
    v_label := btrim(COALESCE(v_e->>'label',''));
    v_hint  := NULLIF(btrim(COALESCE(v_e->>'hint','')),'');
    v_kind  := COALESCE(NULLIF(v_e->>'kind',''),'check');
    v_sec   := NULLIF(btrim(COALESCE(v_e->>'section','')),'');
    IF length(v_label) NOT BETWEEN 2 AND 300 THEN
      RAISE EXCEPTION 'שם פריט % חייב להיות בין 2 ל-300 תווים', v_ord USING ERRCODE = 'check_violation'; END IF;
    IF v_hint IS NOT NULL AND length(v_hint) > 500 THEN
      RAISE EXCEPTION 'הסבר פריט % ארוך מדי', v_ord USING ERRCODE = 'check_violation'; END IF;
    IF v_sec IS NOT NULL AND length(v_sec) > 60 THEN
      RAISE EXCEPTION 'שם הקבוצה בפריט % ארוך מדי (עד 60 תווים)', v_ord USING ERRCODE = 'check_violation'; END IF;
    IF v_kind NOT IN ('check','photo','check_photo') THEN
      RAISE EXCEPTION 'סוג פריט % לא תקין', v_ord USING ERRCODE = 'check_violation'; END IF;
    IF v_min NOT BETWEEN 0 AND 6 THEN
      RAISE EXCEPTION 'מספר תמונות בפריט % חייב להיות 0–6', v_ord USING ERRCODE = 'check_violation'; END IF;
    IF v_kind = 'check' THEN v_min := 0;
    ELSIF v_req AND v_min < 1 THEN
      RAISE EXCEPTION 'פריט צילום חובה (%) דורש לפחות תמונה אחת', v_ord USING ERRCODE = 'check_violation';
    ELSIF NOT v_req AND v_min <> 0 THEN
      RAISE EXCEPTION 'פריט רשות (%) אינו יכול לדרוש תמונות', v_ord USING ERRCODE = 'check_violation';
    END IF;
    IF v_id IS NOT NULL THEN
      -- ⚠️ רק פריט **של הרשימה הזו**: id של פריט מרשימה אחרת היה מעביר אותו לכאן בשקט.
      UPDATE pm_checklist_items t SET seq = v_ord::int, label = v_label, hint = v_hint, kind = v_kind, required = v_req,
             min_photos = v_min, section = v_sec, active = true, updated_at = v_now, updated_by = v_actor
       WHERE t.id = v_id AND t.template_id = v_t.id;
      IF NOT FOUND THEN RAISE EXCEPTION 'פריט % לא נמצא ברשימה הזו', v_ord USING ERRCODE = 'PT404'; END IF;
    ELSE
      INSERT INTO pm_checklist_items (template_id, seq, label, hint, kind, required, min_photos, section, active, updated_at, updated_by)
      VALUES (v_t.id, v_ord::int, v_label, v_hint, v_kind, v_req, v_min, v_sec, true, v_now, v_actor)
      RETURNING pm_checklist_items.id INTO v_id;
    END IF;
    v_keep := v_keep || v_id;
  END LOOP;
  UPDATE pm_checklist_items t SET active = false, updated_at = v_now, updated_by = v_actor
   WHERE t.active AND t.template_id = v_t.id AND NOT (t.id = ANY (v_keep));

  SELECT COALESCE(sum(t.min_photos), 0)::int INTO v_photos
    FROM pm_checklist_items t WHERE t.active AND t.required AND t.template_id = v_t.id;
  IF v_photos > 40 THEN
    RAISE EXCEPTION 'סך התמונות הנדרשות בביקור (%) עולה על 40 — אף ביקור לא יוכל להיות מוגש', v_photos
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*)::int, COALESCE(jsonb_agg(jsonb_build_object('id', t.id, 'label', t.label, 'kind', t.kind,
                                 'required', t.required, 'min_photos', t.min_photos, 'section', t.section)
                                 ORDER BY t.seq, t.id), '[]'::jsonb)
    INTO v_n, v_after FROM pm_checklist_items t WHERE t.active AND t.template_id = v_t.id;
  PERFORM app.compliance_log(NULL, '*', 'pm', 'template', v_t.id, 'save', v_actor, v_before, v_after, NULL);
  PERFORM app.record_write_audit('pm.template_save', v_actor, app.current_app_role(), 'settings', 'pm_template',
    jsonb_build_object('item_count', v_n, 'template_id', v_t.id));   -- D22: מזהים וספירות בלבד
  RETURN v_n;
END $fn$;
REVOKE ALL ON FUNCTION public.pm_template_save(jsonb, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_template_save(jsonb, text, integer) TO authenticated;

-- ------------------------------------------------------------
-- שיוך רשימות לאתר — "כמו פרויקט אחר" (07/10/2026)
-- ------------------------------------------------------------
-- מצב יעד: הרשימות שנשלחו הן מה שהאתר מקבל מעכשיו. מערך ריק / NULL = חזרה לברירת
-- המחדל. "כמו אתר אחר" נעשה בדפדפן: קוראים את הרשימות שלו (pm_site) ושולחים לכאן.
-- ⚠️ ביקור שכבר נפתח אינו משתנה — הפריטים שלו צולמו ברגע הפתיחה.
CREATE OR REPLACE FUNCTION public.pm_site_templates_set(p_site_code text, p_template_ids integer[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_manager();
  v_site integer; v_code text; v_before integer[]; v_ids integer[] := COALESCE(p_template_ids, '{}');
  v_photos integer;
BEGIN
  SELECT s.id, s.code INTO v_site, v_code FROM sites s WHERE s.code = btrim(COALESCE(p_site_code,''));
  IF v_site IS NULL THEN RAISE EXCEPTION 'אתר לא נמצא: %', p_site_code USING ERRCODE = 'PT404'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_ids) x(id) WHERE NOT EXISTS
               (SELECT 1 FROM pm_templates t WHERE t.id = x.id AND t.active)) THEN
    RAISE EXCEPTION 'אחת הרשימות לא נמצאה' USING ERRCODE = 'PT404'; END IF;
  SELECT COALESCE(sum(i.min_photos), 0)::int INTO v_photos
    FROM pm_checklist_items i WHERE i.active AND i.required AND i.template_id = ANY (v_ids);
  IF v_photos > 40 THEN
    RAISE EXCEPTION 'הרשימות יחד דורשות % תמונות — יותר מ-40, ואף ביקור לא יוכל להיות מוגש', v_photos
      USING ERRCODE = 'check_violation'; END IF;
  SELECT COALESCE(array_agg(st.template_id ORDER BY st.template_id), '{}') INTO v_before
    FROM pm_site_templates st WHERE st.site_id = v_site;
  DELETE FROM pm_site_templates st WHERE st.site_id = v_site;
  INSERT INTO pm_site_templates (site_id, template_id) SELECT DISTINCT v_site, x FROM unnest(v_ids) x;
  PERFORM app.compliance_log(v_site, v_code, 'pm', 'site_templates', NULL, 'set', v_actor,
    jsonb_build_object('template_ids', v_before), jsonb_build_object('template_ids', v_ids), NULL);
  PERFORM app.record_write_audit('pm.site_templates_set', v_actor, app.current_app_role(), 'site', v_code,
    jsonb_build_object('template_ids', v_ids));
  PERFORM app.compliance_event(v_code, 'pm', 'site_templates');
  RETURN cardinality(v_ids);
END $fn$;
REVOKE ALL ON FUNCTION public.pm_site_templates_set(text, integer[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_site_templates_set(text, integer[]) TO authenticated;

-- ------------------------------------------------------------
-- pm_visit_start — טיוטה אחת לאתר; הפריטים מצולמים מהרשימה ברגע הפתיחה
-- ------------------------------------------------------------
-- ⚠️ p_expect_visit_id / p_expect_activity — הטיוטה שהמשתמש **ראה** ואישר לזרוק
-- (המזהה וה-last_activity_at שעל הכרטיס). "התחלה מחדש" זורקת את הטיוטה שקיימת
-- **עכשיו**, והכרטיס עלול להיות ישן: אין אירוע על שמירת טיוטה (D20), ו-window.confirm
-- חוסם. בלי הבדיקה כאן מנהל היה מוחק טיוטה חדשה של טכנאי אחר — או את אותה טיוטה
-- אחרי שטכנאי חזר לעבוד בה — עם כל הסימונים והתמונות. בדיקה בדפדפן לפני הקריאה
-- רק מצמצמת את החלון; תחת ה-FOR UPDATE כאן הוא נסגר. אי-התאמה → PT409, בלי מחיקה.
-- NULL = בלי בדיקה (קורא ישן); הדשבורד שולח תמיד בהתחלה מחדש.
DROP FUNCTION IF EXISTS public.pm_visit_start(text, boolean);
DROP FUNCTION IF EXISTS public.pm_visit_start(text, boolean, bigint, text);
CREATE FUNCTION public.pm_visit_start(p_site_code text, p_restart boolean DEFAULT false,
                                      p_expect_visit_id bigint DEFAULT NULL, p_expect_activity text DEFAULT NULL)
RETURNS TABLE (visit_id bigint, created boolean, started_at text, last_activity_at text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
#variable_conflict use_column
DECLARE
  v_actor text := app.require_staff();
  v_now text := app.compliance_now_iso();
  v_site integer; v_code text; v_old pm_visits%ROWTYPE; v_id bigint; v_items integer; v_photos integer;
  v_tpls integer[];
BEGIN
  SELECT s.id, s.code INTO v_site, v_code FROM sites s WHERE s.code = btrim(COALESCE(p_site_code,''));
  IF v_site IS NULL THEN RAISE EXCEPTION 'אתר לא נמצא: %', p_site_code USING ERRCODE = 'PT404'; END IF;
  -- הרשימות של **האתר** (07/10/2026) — לא שויך → ברירת המחדל, כמו קודם
  v_tpls := app.pm_site_template_ids(v_site);
  IF (SELECT COALESCE(sum(t.min_photos), 0) FROM pm_checklist_items t
       WHERE t.active AND t.required AND t.template_id = ANY (v_tpls)) > 40 THEN
    RAISE EXCEPTION 'רשימות האתר יחד דורשות יותר מ-40 תמונות — אף ביקור לא יוכל להיות מוגש'
      USING ERRCODE = 'check_violation'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pm_checklist_items t WHERE t.active AND t.template_id = ANY (v_tpls)) THEN
    RAISE EXCEPTION 'רשימת הבדיקה ריקה — מנהל צריך להגדיר אותה תחילה' USING ERRCODE = 'check_violation'; END IF;

  SELECT v.* INTO v_old FROM pm_visits v WHERE v.site_id = v_site AND v.status = 'draft' FOR UPDATE;
  IF COALESCE(p_restart, false) AND p_expect_visit_id IS NOT NULL THEN
    IF v_old.id IS NULL THEN
      RAISE EXCEPTION 'הטיוטה כבר אינה קיימת — אפשר להתחיל ביקור חדש' USING ERRCODE = 'PT409';
    ELSIF v_old.id <> p_expect_visit_id THEN
      RAISE EXCEPTION 'הטיוטה השתנתה בינתיים — % פתח ביקור חדש. יש לבדוק אותו לפני שמתחילים מחדש',
        COALESCE(v_old.started_by, 'משתמש אחר') USING ERRCODE = 'PT409';
    ELSIF p_expect_activity IS NOT NULL AND v_old.last_activity_at IS DISTINCT FROM p_expect_activity THEN
      RAISE EXCEPTION 'הטיוטה השתנתה בינתיים — עבדו בה אחרי שנטענה. יש לבדוק אותה לפני שמתחילים מחדש'
        USING ERRCODE = 'PT409';
    END IF;
  END IF;
  IF v_old.id IS NOT NULL THEN
    IF NOT COALESCE(p_restart, false) THEN
      RETURN QUERY SELECT v_old.id, false, v_old.started_at, v_old.last_activity_at; RETURN;
    END IF;
    IF NOT app.pm_may_discard(v_old) THEN
      RAISE EXCEPTION 'רק מי שפתח את הביקור או מנהל יכולים להתחיל מחדש (או אחרי 48 שעות ללא פעילות)'
        USING ERRCODE = 'insufficient_privilege'; END IF;
    SELECT count(*)::int INTO v_items FROM pm_visit_items i WHERE i.visit_id = v_old.id;
    SELECT count(*)::int INTO v_photos FROM pm_files f WHERE f.visit_id = v_old.id;
    DELETE FROM pm_visits v WHERE v.id = v_old.id;
    PERFORM app.compliance_log(v_site, v_code, 'pm', 'visit', v_old.id, 'discard', v_actor,
      jsonb_build_object('items', v_items, 'photos', v_photos, 'started_by', v_old.started_by,
                         'started_at', v_old.started_at), NULL, 'התחלה מחדש');
    PERFORM app.record_write_audit('pm.visit_discard', v_actor, app.current_app_role(), 'site', v_code,
      jsonb_build_object('visit_id', v_old.id, 'item_count', v_items, 'photos', v_photos));
    PERFORM app.compliance_event(v_code, 'pm', 'visit_discard');
  END IF;

  INSERT INTO pm_visits (site_id, site_code, source, status, started_by, started_by_user_id, started_at, last_activity_at)
  VALUES (v_site, v_code, 'dashboard', 'draft', v_actor, app.current_app_user(), v_now, v_now)
  ON CONFLICT (site_id) WHERE status = 'draft' DO NOTHING
  RETURNING pm_visits.id INTO v_id;
  IF v_id IS NULL THEN   -- מישהו אחר פתח באותו רגע — מקבלים את הטיוטה שלו
    SELECT v.* INTO v_old FROM pm_visits v WHERE v.site_id = v_site AND v.status = 'draft';
    RETURN QUERY SELECT v_old.id, false, v_old.started_at, v_old.last_activity_at; RETURN;
  END IF;
  -- ⚠️ סדר הרשימות כפי שהאתר מקבל אותן, ובתוך כל רשימה — הסדר שלה. seq ממוספר מחדש
  -- ברצף, כי כל רשימה ממספרת מ-1 ושני "פריט 1" היו מתערבבים בטופס.
  -- section: הקבוצה של הפריט, ובלעדיה שם הרשימה — כך כל פריט בביקור חדש שייך לקבוצה.
  INSERT INTO pm_visit_items (visit_id, template_item_id, seq, label, hint, kind, required, min_photos, section)
  SELECT v_id, t.id, (row_number() OVER (ORDER BY x.o, t.seq, t.id))::int, t.label, t.hint, t.kind, t.required, t.min_photos,
         COALESCE(NULLIF(btrim(t.section), ''), tp.name)
    FROM unnest(v_tpls) WITH ORDINALITY AS x(tid, o)
    JOIN pm_checklist_items t ON t.template_id = x.tid AND t.active
    JOIN pm_templates tp ON tp.id = x.tid
   ORDER BY x.o, t.seq, t.id;
  GET DIAGNOSTICS v_items = ROW_COUNT;
  PERFORM app.record_write_audit('pm.visit_start', v_actor, app.current_app_role(), 'site', v_code,
    jsonb_build_object('visit_id', v_id, 'item_count', v_items));
  -- ⚠️ D20: פתיחה וזריקה של טיוטה משנות את שורת הכרטיס (pm_draft_id — תג "לא הוגש"),
  -- ולכן מפרסמות. שמירות הטיוטה (וי, הערה, צילום) — לא.
  PERFORM app.compliance_event(v_code, 'pm', 'visit_start');
  RETURN QUERY SELECT v_id, true, v_now, v_now;
END $fn$;
REVOKE ALL ON FUNCTION public.pm_visit_start(text, boolean, bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_visit_start(text, boolean, bigint, text) TO authenticated;

-- ⚠️ שתי פונקציות ולא אחת: סימון וי והערה נשלחים מהתור המקומי בנפרד,
-- וכל אחת נוגעת **רק** בשדה שלה — הערה שנשמרת לא תמחק וי שסומן.
-- ⚠️ ואין אירוע: שמירת טיוטה אינה שינוי מצב (D20); הטופס סוקר את pm_site.
CREATE OR REPLACE FUNCTION public.pm_visit_item_check(p_item_id bigint, p_checked boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE v_actor text := app.require_staff(); v_vid bigint; v pm_visits%ROWTYPE;
BEGIN
  SELECT i.visit_id INTO v_vid FROM pm_visit_items i WHERE i.id = p_item_id;
  IF v_vid IS NULL THEN RAISE EXCEPTION 'הפריט לא נמצא' USING ERRCODE = 'PT404'; END IF;
  v := app.pm_draft_lock(v_vid);
  UPDATE pm_visit_items i SET checked = COALESCE(p_checked, false), updated_at = app.compliance_now_iso(), updated_by = v_actor
   WHERE i.id = p_item_id;
END $fn$;
REVOKE ALL ON FUNCTION public.pm_visit_item_check(bigint, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_visit_item_check(bigint, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.pm_visit_item_note(p_item_id bigint, p_note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE v_actor text := app.require_staff(); v_vid bigint; v pm_visits%ROWTYPE;
        v_note text := NULLIF(btrim(COALESCE(p_note,'')),'');
BEGIN
  IF v_note IS NOT NULL AND length(v_note) > 1000 THEN
    RAISE EXCEPTION 'ההערה ארוכה מדי' USING ERRCODE = 'check_violation'; END IF;
  SELECT i.visit_id INTO v_vid FROM pm_visit_items i WHERE i.id = p_item_id;
  IF v_vid IS NULL THEN RAISE EXCEPTION 'הפריט לא נמצא' USING ERRCODE = 'PT404'; END IF;
  v := app.pm_draft_lock(v_vid);
  UPDATE pm_visit_items i SET note = v_note, updated_at = app.compliance_now_iso(), updated_by = v_actor
   WHERE i.id = p_item_id;
END $fn$;
REVOKE ALL ON FUNCTION public.pm_visit_item_note(bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_visit_item_note(bigint, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.pm_visit_photo_add(p_item_id bigint, p_photo jsonb, p_client_id uuid)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_staff();
  v_vid bigint; v pm_visits%ROWTYPE; v_fid bigint; v_item integer; v_all integer; v_sum bigint; v_bytes integer;
  v_mime text; v_data text; v_thumb text; v_other bigint;
BEGIN
  IF p_client_id IS NULL THEN RAISE EXCEPTION 'חסר מזהה בקשה' USING ERRCODE = 'check_violation'; END IF;
  -- replay — לפי client_id בלבד (ראו inspection_defect_photo_add).
  -- ⚠️ ולפני כל בדיקה אחרת, גם של p_photo: הדשבורד שואל כך (p_photo = NULL) אם
  -- תמונה שהוסרה במכשיר כבר הגיעה לשרת — photoUndo ב-complianceDirect.js. בדיקה
  -- שתוקדם לכאן תהפוך כל תשובה ל"לא בשרת", ותמונה שהוסרה תישאר בביקור החתום.
  SELECT f.id, f.visit_item_id INTO v_fid, v_other FROM pm_files f WHERE f.client_id = p_client_id;
  IF v_fid IS NOT NULL THEN
    IF v_other IS DISTINCT FROM p_item_id THEN
      RAISE EXCEPTION 'מזהה התמונה כבר שימש לפריט אחר' USING ERRCODE = 'PT409'; END IF;
    RETURN v_fid;
  END IF;
  SELECT i.visit_id INTO v_vid FROM pm_visit_items i WHERE i.id = p_item_id;
  IF v_vid IS NULL THEN RAISE EXCEPTION 'הפריט לא נמצא' USING ERRCODE = 'PT404'; END IF;
  v := app.pm_draft_lock(v_vid);
  SELECT count(*) FILTER (WHERE f.visit_item_id = p_item_id)::int, count(*)::int, COALESCE(sum(f.byte_size),0)
    INTO v_item, v_all, v_sum FROM pm_files f WHERE f.visit_id = v_vid AND f.kind = 'photo';
  IF v_item >= 6 THEN RAISE EXCEPTION 'אפשר לצרף עד 6 תמונות לפריט' USING ERRCODE = 'check_violation'; END IF;
  -- ⚠️ אותו 40 כמו ב-pm_template_save (סכום min_photos) — שני המספרים זזים יחד
  IF v_all >= 40 THEN RAISE EXCEPTION 'אפשר לצרף עד 40 תמונות לביקור' USING ERRCODE = 'check_violation'; END IF;
  IF p_photo IS NULL OR jsonb_typeof(p_photo) <> 'object' THEN
    RAISE EXCEPTION 'תמונה לא תקינה' USING ERRCODE = 'check_violation'; END IF;
  v_mime := p_photo->>'mime'; v_data := p_photo->>'data'; v_thumb := NULLIF(p_photo->>'thumb','');
  v_bytes := app.b64_check(v_mime, v_data, ARRAY['image/jpeg','image/webp'], 1048576, 'תמונה');
  IF v_thumb IS NOT NULL THEN
    PERFORM app.b64_check('image/jpeg', v_thumb, ARRAY['image/jpeg'], 40960, 'תמונה מוקטנת'); END IF;
  IF v_sum + v_bytes > 15728640 THEN
    RAISE EXCEPTION 'נפח התמונות בביקור עבר 15MB' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO pm_files (client_id, visit_id, visit_item_id, kind, mime, data_b64, thumb_b64, byte_size, uploaded_by, created_at)
  VALUES (p_client_id, v_vid, p_item_id, 'photo', v_mime, v_data, v_thumb, v_bytes, v_actor, app.compliance_now_iso())
  RETURNING pm_files.id INTO v_fid;
  RETURN v_fid;
END $fn$;
REVOKE ALL ON FUNCTION public.pm_visit_photo_add(bigint, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_visit_photo_add(bigint, jsonb, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.pm_visit_photo_delete(p_file_id bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE v_actor text := app.require_staff(); v_vid bigint; v pm_visits%ROWTYPE;
BEGIN
  SELECT f.visit_id INTO v_vid FROM pm_files f WHERE f.id = p_file_id AND f.kind = 'photo';
  IF v_vid IS NULL THEN RAISE EXCEPTION 'התמונה לא נמצאה' USING ERRCODE = 'PT404'; END IF;
  v := app.pm_draft_lock(v_vid);
  DELETE FROM pm_files f WHERE f.id = p_file_id;
END $fn$;
REVOKE ALL ON FUNCTION public.pm_visit_photo_delete(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_visit_photo_delete(bigint) TO authenticated;

-- ------------------------------------------------------------
-- pm_visit_submit — הגשה וחתימה. אחריה הביקור אינו משתנה (טריגרים, §1.3).
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.pm_visit_submit(bigint, text, jsonb, date, text, uuid);
CREATE FUNCTION public.pm_visit_submit(p_visit_id bigint, p_performer_name text, p_signature jsonb,
                                       p_performed_on date, p_note text, p_request_id uuid)
RETURNS TABLE (visit_id bigint, performed_on date, next_due_on date, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
#variable_conflict use_column
DECLARE
  v_actor text := app.require_staff();
  v_today date := app.compliance_today();
  v_name text := NULLIF(btrim(COALESCE(p_performer_name,'')),'');
  v_note text := NULLIF(btrim(COALESCE(p_note,'')),'');
  v pm_visits%ROWTYPE; v_missing text[]; v_list text; v_on date; v_started date; v_items integer; v_photos integer;
  v_code text;
BEGIN
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'חסר מזהה בקשה' USING ERRCODE = 'check_violation'; END IF;
  SELECT pv.* INTO v FROM pm_visits pv WHERE pv.id = p_visit_id FOR UPDATE;
  IF NOT FOUND OR v.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'הביקור לא נמצא' USING ERRCODE = 'PT404'; END IF;
  IF v.status = 'submitted' THEN
    IF v.submit_request_id = p_request_id THEN                                      -- replay
      RETURN QUERY SELECT v.id, v.performed_on,
                          (v.performed_on + make_interval(months => app.pm_interval_months()))::date, true;
      RETURN; END IF;
    RAISE EXCEPTION 'הביקור כבר הוגש' USING ERRCODE = 'PT409';
  END IF;

  -- פריטי חובה חסרים: וי שלא סומן, או פחות תמונות מהנדרש. ⚠️ "required AND"
  -- בשני הענפים — פריט רשות עם 0 תמונות אינו חוסם הגשה.
  SELECT array_agg(i.label ORDER BY i.seq, i.id) INTO v_missing FROM pm_visit_items i
   WHERE i.visit_id = v.id AND i.required
     AND ((i.kind IN ('check','check_photo') AND NOT i.checked)
          OR (SELECT count(*) FROM pm_files f WHERE f.visit_item_id = i.id AND f.kind = 'photo') < i.min_photos);
  IF v_missing IS NOT NULL THEN
    v_list := array_to_string(v_missing[1:5], ', ');
    IF cardinality(v_missing) > 5 THEN v_list := v_list || ' ועוד ' || (cardinality(v_missing) - 5); END IF;
    RAISE EXCEPTION 'חסרים פריטי חובה: %', v_list USING ERRCODE = 'check_violation';
  END IF;
  IF v_name IS NULL OR length(v_name) < 2 THEN RAISE EXCEPTION 'חובה לציין את שם המבצע' USING ERRCODE = 'check_violation'; END IF;
  IF length(v_name) > 100 THEN RAISE EXCEPTION 'שם המבצע ארוך מדי (עד 100 תווים)' USING ERRCODE = 'check_violation'; END IF;
  IF v_note IS NOT NULL AND length(v_note) > 2000 THEN RAISE EXCEPTION 'ההערה ארוכה מדי' USING ERRCODE = 'check_violation'; END IF;
  IF p_signature IS NULL OR jsonb_typeof(p_signature) <> 'object' THEN
    RAISE EXCEPTION 'חסרה חתימה' USING ERRCODE = 'check_violation'; END IF;
  PERFORM app.b64_check(p_signature->>'mime', p_signature->>'data', ARRAY['image/png'], 204800, 'חתימה');

  v_on := COALESCE(p_performed_on, v_today);
  v_started := app.compliance_today_at(v.started_at::timestamptz);
  IF v_on > v_today OR v_on < v_started THEN
    RAISE EXCEPTION 'תאריך הביצוע חייב להיות בין פתיחת הביקור להיום' USING ERRCODE = 'check_violation'; END IF;
  IF v_started < v_on - 7 THEN
    RAISE EXCEPTION 'הביקור נפתח לפני יותר משבוע — יש להתחיל מחדש' USING ERRCODE = 'check_violation'; END IF;

  UPDATE pm_visits pv SET status = 'submitted', performed_on = v_on, performer_name = v_name,
         note = COALESCE(v_note, pv.note), signature_b64 = p_signature->>'data',
         submitted_by = v_actor, submitted_by_user_id = app.current_app_user(),
         submitted_at = app.compliance_now_iso(), submit_request_id = p_request_id,
         last_activity_at = app.compliance_now_iso()
   WHERE pv.id = v.id;

  SELECT count(*)::int INTO v_items FROM pm_visit_items i WHERE i.visit_id = v.id;
  SELECT count(*)::int INTO v_photos FROM pm_files f WHERE f.visit_id = v.id AND f.kind = 'photo';
  v_code := app.compliance_code(v.site_id, v.site_code);
  PERFORM app.record_write_audit('pm.visit_submit', v_actor, app.current_app_role(), 'site', v_code,
    jsonb_build_object('visit_id', v.id, 'item_count', v_items, 'photos', v_photos));
  PERFORM app.compliance_event(v_code, 'pm', 'visit_submit');
  RETURN QUERY SELECT v.id, v_on, (v_on + make_interval(months => app.pm_interval_months()))::date, false;
END $fn$;
REVOKE ALL ON FUNCTION public.pm_visit_submit(bigint, text, jsonb, date, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_visit_submit(bigint, text, jsonb, date, text, uuid) TO authenticated;

-- זריקת טיוטה (מחיקה קשיחה). הטריגרים מתירים — ההורה טיוטה.
CREATE OR REPLACE FUNCTION public.pm_visit_discard(p_visit_id bigint, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_staff();
  v_reason text := COALESCE(app.compliance_reason(p_reason, false), 'בוטל');
  v pm_visits%ROWTYPE; v_items integer; v_photos integer; v_code text;
BEGIN
  SELECT pv.* INTO v FROM pm_visits pv WHERE pv.id = p_visit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'הביקור לא נמצא' USING ERRCODE = 'PT404'; END IF;
  IF v.status <> 'draft' THEN RAISE EXCEPTION 'הביקור כבר הוגש' USING ERRCODE = 'check_violation'; END IF;
  IF NOT app.pm_may_discard(v) THEN
    RAISE EXCEPTION 'רק מי שפתח את הביקור או מנהל יכולים לבטל אותו (או אחרי 48 שעות ללא פעילות)'
      USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT count(*)::int INTO v_items FROM pm_visit_items i WHERE i.visit_id = v.id;
  SELECT count(*)::int INTO v_photos FROM pm_files f WHERE f.visit_id = v.id;
  DELETE FROM pm_visits pv WHERE pv.id = v.id;
  v_code := app.compliance_code(v.site_id, v.site_code);
  PERFORM app.compliance_log(v.site_id, v.site_code, 'pm', 'visit', v.id, 'discard', v_actor,
    jsonb_build_object('items', v_items, 'photos', v_photos, 'started_by', v.started_by, 'started_at', v.started_at),
    NULL, v_reason);
  PERFORM app.record_write_audit('pm.visit_discard', v_actor, app.current_app_role(), 'site', v_code,
    jsonb_build_object('visit_id', v.id, 'item_count', v_items, 'photos', v_photos));
  PERFORM app.compliance_event(v_code, 'pm', 'visit_discard');
END $fn$;
REVOKE ALL ON FUNCTION public.pm_visit_discard(bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_visit_discard(bigint, text) TO authenticated;

-- העלאת PDF של ביקור שנעשה לפני המערכת (מילוי לאחור)
DROP FUNCTION IF EXISTS public.pm_historical_upload(text, jsonb, jsonb);
CREATE FUNCTION public.pm_historical_upload(p_site_code text, p_meta jsonb, p_file jsonb)
RETURNS TABLE (visit_id bigint, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
#variable_conflict use_column
DECLARE
  v_actor text := app.require_manager();
  v_now text := app.compliance_now_iso();
  v_client uuid; v_on date; v_site integer; v_code text; v_id bigint; v_bytes integer; v_md5 text; v_dup bigint;
  v_data text; v_note text;
BEGIN
  BEGIN
    v_client := NULLIF(p_meta->>'client_id','')::uuid;
    v_on := NULLIF(p_meta->>'performed_on','')::date;
  EXCEPTION WHEN others THEN RAISE EXCEPTION 'פרטי הביקור אינם תקינים' USING ERRCODE = 'check_violation'; END;
  IF v_client IS NULL THEN RAISE EXCEPTION 'חסר מזהה בקשה' USING ERRCODE = 'check_violation'; END IF;
  SELECT v.id INTO v_id FROM pm_visits v WHERE v.client_id = v_client;
  IF v_id IS NOT NULL THEN RETURN QUERY SELECT v_id, true; RETURN; END IF;           -- replay
  SELECT s.id, s.code INTO v_site, v_code FROM sites s WHERE s.code = btrim(COALESCE(p_site_code,''));
  IF v_site IS NULL THEN RAISE EXCEPTION 'אתר לא נמצא: %', p_site_code USING ERRCODE = 'PT404'; END IF;
  IF v_on IS NULL OR v_on > app.compliance_today() OR v_on < DATE '2000-01-01' THEN
    RAISE EXCEPTION 'תאריך הביצוע לא תקין' USING ERRCODE = 'check_violation'; END IF;
  v_note := NULLIF(btrim(COALESCE(p_meta->>'note','')),'');
  IF v_note IS NOT NULL AND length(v_note) > 2000 THEN RAISE EXCEPTION 'ההערה ארוכה מדי' USING ERRCODE = 'check_violation'; END IF;
  IF p_file IS NULL OR jsonb_typeof(p_file) <> 'object' THEN
    RAISE EXCEPTION 'חסר קובץ' USING ERRCODE = 'check_violation'; END IF;
  v_data := p_file->>'data';
  v_bytes := app.b64_check(p_file->>'mime', v_data, ARRAY['application/pdf'],
                           app.compliance_setting_int('compliance_pdf_max_bytes', 8388608), 'קובץ הביקור');
  v_md5 := md5(v_data);
  SELECT v.id INTO v_dup FROM pm_files f JOIN pm_visits v ON v.id = f.visit_id
   WHERE v.site_id = v_site AND v.deleted_at IS NULL AND f.content_md5 = v_md5 ORDER BY v.id LIMIT 1;
  IF v_dup IS NOT NULL THEN
    RAISE EXCEPTION 'הקובץ הזה כבר הועלה לאתר (ביקור %)', v_dup USING ERRCODE = 'PT409'; END IF;
  INSERT INTO pm_visits (client_id, site_id, site_code, source, status, performed_on, performer_name, vendor, note,
                         started_by, started_by_user_id, started_at, last_activity_at,
                         submitted_by, submitted_by_user_id, submitted_at)
  VALUES (v_client, v_site, v_code, 'historical', 'submitted', v_on,
          app.compliance_text(p_meta->>'performer_name', 100, 'שם המבצע'), app.compliance_text(p_meta->>'vendor', 100, 'שם הספק'),
          v_note, v_actor, app.current_app_user(), v_now, v_now, v_actor, app.current_app_user(), v_now)
  RETURNING pm_visits.id INTO v_id;
  INSERT INTO pm_files (visit_id, kind, mime, file_name, data_b64, byte_size, content_md5, uploaded_by, created_at)
  VALUES (v_id, 'pdf', 'application/pdf', left(NULLIF(btrim(COALESCE(p_file->>'name','')),''), 200), v_data, v_bytes, v_md5,
          v_actor, v_now);
  PERFORM app.record_write_audit('pm.historical_upload', v_actor, app.current_app_role(), 'site', v_code,
    jsonb_build_object('visit_id', v_id, 'bytes', v_bytes));
  PERFORM app.compliance_event(v_code, 'pm', 'historical_upload');
  RETURN QUERY SELECT v_id, false;
END $fn$;
REVOKE ALL ON FUNCTION public.pm_historical_upload(text, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_historical_upload(text, jsonb, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.pm_visit_delete(p_visit_id bigint, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_manager();
  v_reason text := app.compliance_reason(p_reason);
  v pm_visits%ROWTYPE; v_code text;
BEGIN
  SELECT pv.* INTO v FROM pm_visits pv WHERE pv.id = p_visit_id FOR UPDATE;
  IF NOT FOUND OR v.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'הביקור לא נמצא' USING ERRCODE = 'PT404'; END IF;
  IF v.status = 'draft' THEN
    RAISE EXCEPTION 'טיוטה מבוטלת ולא נמחקת' USING ERRCODE = 'check_violation'; END IF;
  UPDATE pm_visits pv SET deleted_at = app.compliance_now_iso(), deleted_by = v_actor, deleted_reason = v_reason
   WHERE pv.id = v.id;
  v_code := app.compliance_code(v.site_id, v.site_code);
  PERFORM app.compliance_log(v.site_id, v.site_code, 'pm', 'visit', v.id, 'delete', v_actor,
    jsonb_build_object('performed_on', v.performed_on, 'performer_name', v.performer_name, 'source', v.source),
    NULL, v_reason);
  PERFORM app.record_write_audit('pm.visit_delete', v_actor, app.current_app_role(), 'site', v_code,
    jsonb_build_object('visit_id', v.id));
  PERFORM app.compliance_event(v_code, 'pm', 'visit_delete');
END $fn$;
REVOKE ALL ON FUNCTION public.pm_visit_delete(bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_visit_delete(bigint, text) TO authenticated;

-- ============================================================
-- 2.3 קוראים משותפים וכלי מנהל
-- ============================================================

-- תמונות מוקטנות. הורה שנמחק רך → PT404 למי שאינו מנהל.
DROP FUNCTION IF EXISTS public.compliance_thumbs(text, bigint);
CREATE FUNCTION public.compliance_thumbs(p_kind text, p_owner_id bigint)
RETURNS TABLE (id bigint, owner_id bigint, closure_no integer, mime text, thumb_b64 text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
#variable_conflict use_column
DECLARE
  v_actor text := app.require_staff();
  v_mgr boolean := app.compliance_verified_manager(); v_del boolean; v_cl integer;
BEGIN
  IF p_kind IN ('defect','defect_history') THEN
    SELECT (d.deleted_at IS NOT NULL OR r.deleted_at IS NOT NULL), d.closure_no INTO v_del, v_cl
      FROM inspection_defects d JOIN inspection_reports r ON r.id = d.report_id WHERE d.id = p_owner_id;
    IF v_cl IS NULL OR (v_del AND NOT v_mgr) THEN RAISE EXCEPTION 'לא נמצא' USING ERRCODE = 'PT404'; END IF;
    IF p_kind = 'defect' THEN
      RETURN QUERY SELECT ph.id, ph.defect_id, ph.closure_no, ph.mime, ph.thumb_b64 FROM inspection_defect_photos ph
                    WHERE ph.defect_id = p_owner_id AND ph.closure_no = v_cl ORDER BY ph.id LIMIT 3;
    ELSE
      RETURN QUERY SELECT ph.id, ph.defect_id, ph.closure_no, ph.mime, ph.thumb_b64 FROM inspection_defect_photos ph
                    WHERE ph.defect_id = p_owner_id AND ph.closure_no < v_cl ORDER BY ph.id DESC LIMIT 9;
    END IF;
  ELSIF p_kind = 'pm_visit' THEN
    SELECT (v.deleted_at IS NOT NULL) INTO v_del FROM pm_visits v WHERE v.id = p_owner_id;
    IF v_del IS NULL OR (v_del AND NOT v_mgr) THEN RAISE EXCEPTION 'לא נמצא' USING ERRCODE = 'PT404'; END IF;
    RETURN QUERY SELECT f.id, f.visit_item_id, NULL::integer, f.mime, f.thumb_b64 FROM pm_files f
                  WHERE f.visit_id = p_owner_id AND f.kind = 'photo' ORDER BY f.id LIMIT 40;
  ELSE
    RAISE EXCEPTION 'סוג לא מוכר: %', p_kind USING ERRCODE = 'check_violation';
  END IF;
END $fn$;
REVOKE ALL ON FUNCTION public.compliance_thumbs(text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compliance_thumbs(text, bigint) TO authenticated;

-- הקובץ המלא. ⚠️ הדלת היחידה שמחזירה data_b64.
DROP FUNCTION IF EXISTS public.compliance_file(text, bigint);
CREATE FUNCTION public.compliance_file(p_kind text, p_id bigint)
RETURNS TABLE (mime text, file_name text, data_b64 text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
#variable_conflict use_column
DECLARE
  v_actor text := app.require_staff();
  v_mgr boolean := app.compliance_verified_manager(); v_ok boolean;
BEGIN
  IF p_kind = 'inspection_pdf' THEN
    SELECT (f.purged_at IS NULL AND (v_mgr OR EXISTS (SELECT 1 FROM inspection_reports r
                                                       WHERE r.file_id = f.id AND r.deleted_at IS NULL)))
      INTO v_ok FROM inspection_files f WHERE f.id = p_id;
    IF NOT COALESCE(v_ok, false) THEN RAISE EXCEPTION 'הקובץ לא נמצא' USING ERRCODE = 'PT404'; END IF;
    RETURN QUERY SELECT f.mime, f.file_name, f.data_b64 FROM inspection_files f WHERE f.id = p_id;
  ELSIF p_kind = 'defect_photo' THEN
    SELECT (ph.purged_at IS NULL AND (v_mgr OR (d.deleted_at IS NULL AND r.deleted_at IS NULL)))
      INTO v_ok FROM inspection_defect_photos ph
      JOIN inspection_defects d ON d.id = ph.defect_id JOIN inspection_reports r ON r.id = d.report_id
     WHERE ph.id = p_id;
    IF NOT COALESCE(v_ok, false) THEN RAISE EXCEPTION 'הקובץ לא נמצא' USING ERRCODE = 'PT404'; END IF;
    RETURN QUERY SELECT ph.mime, NULL::text, ph.data_b64 FROM inspection_defect_photos ph WHERE ph.id = p_id;
  ELSIF p_kind IN ('pm_pdf','pm_photo') THEN
    SELECT (v_mgr OR v.deleted_at IS NULL) INTO v_ok
      FROM pm_files f JOIN pm_visits v ON v.id = f.visit_id
     WHERE f.id = p_id AND f.kind = CASE WHEN p_kind = 'pm_pdf' THEN 'pdf' ELSE 'photo' END;
    IF NOT COALESCE(v_ok, false) THEN RAISE EXCEPTION 'הקובץ לא נמצא' USING ERRCODE = 'PT404'; END IF;
    RETURN QUERY SELECT f.mime, f.file_name, f.data_b64 FROM pm_files f WHERE f.id = p_id;
  ELSIF p_kind = 'pm_signature' THEN
    SELECT (v.signature_b64 IS NOT NULL AND (v_mgr OR v.deleted_at IS NULL)) INTO v_ok FROM pm_visits v WHERE v.id = p_id;
    IF NOT COALESCE(v_ok, false) THEN RAISE EXCEPTION 'הקובץ לא נמצא' USING ERRCODE = 'PT404'; END IF;
    RETURN QUERY SELECT 'image/png'::text, NULL::text, v.signature_b64 FROM pm_visits v WHERE v.id = p_id;
  ELSE
    RAISE EXCEPTION 'סוג לא מוכר: %', p_kind USING ERRCODE = 'check_violation';
  END IF;
END $fn$;
REVOKE ALL ON FUNCTION public.compliance_file(text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compliance_file(text, bigint) TO authenticated;

-- ההיסטוריה המלאה (כולל הטקסט החופשי) — לצוות בלבד, לא דרך audit_log
CREATE OR REPLACE FUNCTION public.compliance_history_list(p_site_code text, p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_staff();
  v_code text := btrim(COALESCE(p_site_code,''));
  v_site integer; v_lim integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 200);
BEGIN
  SELECT s.id INTO v_site FROM sites s WHERE s.code = v_code;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', x.id, 'area', x.area, 'entity', x.entity, 'entity_id', x.entity_id,
                                        'action', x.action, 'actor', x.actor, 'at', x.at, 'before', x.before,
                                        'after', x.after, 'reason', x.reason) ORDER BY x.id DESC)
      FROM (SELECT h.* FROM compliance_history h
             WHERE (v_site IS NOT NULL AND h.site_id = v_site)
                OR (v_site IS NULL AND h.site_id IS NULL AND h.site_code = v_code)
             ORDER BY h.id DESC LIMIT v_lim) x), '[]'::jsonb);
END $fn$;
REVOKE ALL ON FUNCTION public.compliance_history_list(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compliance_history_list(text, integer) TO authenticated;

-- כמה מקום הקבצים תופסים (מטא-דאטה בלבד; לא קורא את הבתים)
DROP FUNCTION IF EXISTS public.compliance_storage();
CREATE FUNCTION public.compliance_storage()
RETURNS TABLE (db_bytes bigint, blob_bytes bigint, blob_rows bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
#variable_conflict use_column
DECLARE v_actor text := app.require_manager();
BEGIN
  RETURN QUERY
  WITH b AS (
    SELECT f.byte_size::bigint AS n FROM inspection_files f WHERE f.purged_at IS NULL
    UNION ALL SELECT ph.byte_size::bigint FROM inspection_defect_photos ph WHERE ph.purged_at IS NULL
    UNION ALL SELECT f.byte_size::bigint FROM pm_files f
    UNION ALL SELECT ((length(v.signature_b64) * 3) / 4)::bigint FROM pm_visits v WHERE v.signature_b64 IS NOT NULL)
  SELECT pg_database_size(current_database())::bigint, COALESCE(sum(b.n), 0)::bigint, count(*)::bigint FROM b;
END $fn$;
REVOKE ALL ON FUNCTION public.compliance_storage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compliance_storage() TO authenticated;

-- ⚠️ D18: אתר שנמחק אינו מוחק את התסקירים — site_id הופך NULL והקוד נשמר.
-- כאן רואים אותם, ומחזירים אותם לאתר (גם אם נרשם מחדש בקוד אחר).
DROP FUNCTION IF EXISTS public.compliance_orphans();
CREATE FUNCTION public.compliance_orphans()
RETURNS TABLE (site_code text, reports integer, files integer, visits integer, history integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
#variable_conflict use_column
DECLARE v_actor text := app.require_manager();
BEGIN
  RETURN QUERY
  WITH o AS (
    SELECT r.site_code AS c, 1 AS r, 0 AS f, 0 AS v, 0 AS h FROM inspection_reports r WHERE r.site_id IS NULL
    UNION ALL SELECT f.site_code, 0, 1, 0, 0 FROM inspection_files f WHERE f.site_id IS NULL
    UNION ALL SELECT v.site_code, 0, 0, 1, 0 FROM pm_visits v WHERE v.site_id IS NULL
    UNION ALL SELECT h.site_code, 0, 0, 0, 1 FROM compliance_history h WHERE h.site_id IS NULL AND h.site_code <> '*')
  SELECT o.c, sum(o.r)::int, sum(o.f)::int, sum(o.v)::int, sum(o.h)::int FROM o GROUP BY o.c ORDER BY o.c;
END $fn$;
REVOKE ALL ON FUNCTION public.compliance_orphans() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compliance_orphans() TO authenticated;

CREATE OR REPLACE FUNCTION public.compliance_reattach(p_old_code text, p_site_code text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_manager();
  v_old text := btrim(COALESCE(p_old_code,''));
  v_site integer; v_code text; v_r integer; v_f integer; v_v integer; v_h integer;
BEGIN
  SELECT s.id, s.code INTO v_site, v_code FROM sites s WHERE s.code = btrim(COALESCE(p_site_code,''));
  IF v_site IS NULL THEN RAISE EXCEPTION 'אתר לא נמצא: %', p_site_code USING ERRCODE = 'PT404'; END IF;
  IF v_old = '' OR v_old = '*' THEN RAISE EXCEPTION 'קוד ישן לא תקין' USING ERRCODE = 'check_violation'; END IF;
  -- טיוטה יתומה מול טיוטה קיימת באתר היעד: האינדקס הייחודי היה נופל באמצע
  IF EXISTS (SELECT 1 FROM pm_visits v WHERE v.site_id IS NULL AND v.site_code = v_old AND v.status = 'draft')
     AND EXISTS (SELECT 1 FROM pm_visits v WHERE v.site_id = v_site AND v.status = 'draft') THEN
    RAISE EXCEPTION 'לשני האתרים יש ביקור פתוח — יש לסגור אחד מהם קודם' USING ERRCODE = 'PT409'; END IF;
  UPDATE inspection_reports r SET site_id = v_site, site_code = v_code WHERE r.site_id IS NULL AND r.site_code = v_old;
  GET DIAGNOSTICS v_r = ROW_COUNT;
  UPDATE inspection_files f SET site_id = v_site, site_code = v_code WHERE f.site_id IS NULL AND f.site_code = v_old;
  GET DIAGNOSTICS v_f = ROW_COUNT;
  UPDATE pm_visits v SET site_id = v_site, site_code = v_code WHERE v.site_id IS NULL AND v.site_code = v_old;
  GET DIAGNOSTICS v_v = ROW_COUNT;
  UPDATE compliance_history h SET site_id = v_site, site_code = v_code WHERE h.site_id IS NULL AND h.site_code = v_old;
  GET DIAGNOSTICS v_h = ROW_COUNT;
  -- שורות המתקנים נמחקו עם האתר (CASCADE) — משחזרים מהתסקירים החיים
  INSERT INTO inspection_machines (site_id, machine_key, created_at)
  SELECT DISTINCT v_site, r.machine_key, app.compliance_now_iso() FROM inspection_reports r
   WHERE r.site_id = v_site AND r.deleted_at IS NULL
  ON CONFLICT (site_id, machine_key) DO NOTHING;
  IF v_r + v_f + v_v + v_h = 0 THEN RAISE EXCEPTION 'אין רשומות יתומות לקוד %', v_old USING ERRCODE = 'PT404'; END IF;
  PERFORM app.compliance_log(v_site, v_code, 'inspection', 'site', v_site, 'reattach', v_actor,
    jsonb_build_object('site_code', v_old), jsonb_build_object('site_code', v_code), NULL);
  PERFORM app.record_write_audit('inspection.reattach', v_actor, app.current_app_role(), 'site', v_code,
    jsonb_build_object('reports', v_r, 'files', v_f, 'visits', v_v, 'history', v_h));
  PERFORM app.compliance_event(v_code, 'inspection', 'reattach');
  RETURN v_r + v_f + v_v + v_h;
END $fn$;
REVOKE ALL ON FUNCTION public.compliance_reattach(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compliance_reattach(text, text) TO authenticated;

-- ------------------------------------------------------------
-- compliance_purge — מחיקת הבתים של הורה שכבר נמחק רך
-- ------------------------------------------------------------
-- kinds:
--   'inspection_file' (p_id = file id) — רק כשאין אף תסקיר חי שמצביע עליו. הבתים
--      מוחלפים בכותרת ריקה ו-purged_at נרשם (השורה נשארת: file_id הוא NOT NULL).
--      תמונות הליקויים של התסקירים שנמחקו מטוהרות איתו באותה דרך — השורות
--      נשארות כי המפתח המורכב של "בוצע" מצביע עליהן.
--   'pm_visit' (p_id = visit id) — ביקור שנמחק רך: קבציו נמחקים והחתימה מתאפסת.
CREATE OR REPLACE FUNCTION public.compliance_purge(p_kind text, p_id bigint, p_reason text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_manager();
  v_reason text := app.compliance_reason(p_reason);
  v_now text := app.compliance_now_iso();
  v_f inspection_files%ROWTYPE; v pm_visits%ROWTYPE; v_ph integer := 0; v_n integer := 0; v_code text;
BEGIN
  PERFORM set_config('app.compliance_purge', 'on', true);
  IF p_kind = 'inspection_file' THEN
    SELECT f.* INTO v_f FROM inspection_files f WHERE f.id = p_id FOR UPDATE;
    IF NOT FOUND OR v_f.purged_at IS NOT NULL THEN RAISE EXCEPTION 'הקובץ לא נמצא' USING ERRCODE = 'PT404'; END IF;
    IF EXISTS (SELECT 1 FROM inspection_reports r WHERE r.file_id = v_f.id AND r.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'יש תסקיר חי שמצביע על הקובץ — יש למחוק אותו קודם' USING ERRCODE = 'check_violation'; END IF;
    -- ⚠️ mime מתאפס יחד עם הבתים: כותרת JPEG ריקה בשורת webp נופלת באילוץ ה-magic
    UPDATE inspection_defect_photos ph SET mime = 'image/jpeg', data_b64 = '/9j/', thumb_b64 = NULL, byte_size = 3, purged_at = v_now
     WHERE ph.purged_at IS NULL AND ph.defect_id IN (
       SELECT d.id FROM inspection_defects d JOIN inspection_reports r ON r.id = d.report_id WHERE r.file_id = v_f.id);
    GET DIAGNOSTICS v_ph = ROW_COUNT;
    UPDATE inspection_files f SET data_b64 = 'JVBERi0=', byte_size = 5, purged_at = v_now, purged_by = v_actor
     WHERE f.id = v_f.id;
    v_n := 1 + v_ph;
    v_code := app.compliance_code(v_f.site_id, v_f.site_code);
    PERFORM app.compliance_log(v_f.site_id, v_f.site_code, 'inspection', 'file', v_f.id, 'purge', v_actor,
      jsonb_build_object('file_name', v_f.file_name, 'byte_size', v_f.byte_size), jsonb_build_object('photos', v_ph),
      v_reason);
    PERFORM app.record_write_audit('inspection.purge', v_actor, app.current_app_role(), 'site', v_code,
      jsonb_build_object('kind', p_kind, 'file_id', v_f.id, 'photos', v_ph, 'bytes', v_f.byte_size));
  ELSIF p_kind = 'pm_visit' THEN
    SELECT pv.* INTO v FROM pm_visits pv WHERE pv.id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'הביקור לא נמצא' USING ERRCODE = 'PT404'; END IF;
    IF v.deleted_at IS NULL THEN
      RAISE EXCEPTION 'אפשר לטהר רק ביקור שנמחק' USING ERRCODE = 'check_violation'; END IF;
    DELETE FROM pm_files f WHERE f.visit_id = v.id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    UPDATE pm_visits pv SET signature_b64 = NULL WHERE pv.id = v.id;
    v_code := app.compliance_code(v.site_id, v.site_code);
    PERFORM app.compliance_log(v.site_id, v.site_code, 'pm', 'visit', v.id, 'purge', v_actor,
      NULL, jsonb_build_object('files', v_n), v_reason);
    PERFORM app.record_write_audit('pm.purge', v_actor, app.current_app_role(), 'site', v_code,
      jsonb_build_object('kind', p_kind, 'visit_id', v.id, 'files', v_n));
  ELSE
    RAISE EXCEPTION 'סוג לא מוכר: %', p_kind USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('app.compliance_purge', '', true);
  RETURN v_n;
END $fn$;
REVOKE ALL ON FUNCTION public.compliance_purge(text, bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compliance_purge(text, bigint, text) TO authenticated;
