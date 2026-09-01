-- ============================================================
-- db/ingest.postgres.sql — הקליטה, בדרך למסד
-- ============================================================
-- הקובץ הזה נבנה כדי שסוכן באתר יוכל לכתוב ישירות ל-Supabase, בלי שרת
-- באמצע. הוא נבנה **בפרוסות**, וכל פרוסה נכנסת רק אחרי ששער השוואה מוכיח
-- שהיא מסכימה עם המסלול הקיים על נתונים אמיתיים.
--
-- ⚠️ **זהו הקוד היחיד במערכת שנוגע בנתוני לקוחות בכתיבה.** 1,872 שורות
-- הקליטה ב-JS נולדו מכשלים שנמדדו בייצור, לא מתכנון מראש. פורט שלהן בלי
-- השוואה מדויקת הוא כתיבה מחדש על עיוור.

-- ============================================================
-- app.decide_cycle_update — פורט מדויק של decideCycleUpdate
-- ============================================================
-- המקור: `db/cycle-rules.js`. פונקציה **טהורה** בשני הצדדים — אין בה
-- קריאה למסד ואין לה תופעות לוואי — ולכן אפשר להשוות אותה ישירות, ערך
-- מול ערך, על אלפי מקרים. זו הסיבה שהיא הפרוסה הראשונה.
--
-- שבעה מצבים, וכל אחד מהם נולד ממשהו שקרה:
--
--   invalid       — מונה שאינו מספר שלם אי-שלילי. קריאת Modbus כושלת.
--   first         — אין בסיס. אתר **חדש** מתחיל מ-0 והערך נשמר כבסיס
--                   בלבד; אתר **ותיק** מאמץ את הערך ההיסטורי מהבקר.
--   backfill      — הודעה שקרתה לפני הקריאה האחרונה. הגיעה מאוחר, ואין
--                   לה מה לתרום למונה.
--   normal        — עלייה סבירה. מוסיפים את ההפרש.
--   jump_suspect  — עלייה מהירה מדי מכדי להיות פיזית.
--   reset         — ירידה לערך נמוך. אתחול בקר: מוסיפים את הערך החדש.
--   reset_suspect — ירידה לערך **גבוה**. לא נראה כמו אתחול.
--
-- ⚠️ בשני מצבי ה-suspect **לא מוסיפים כלום** אך **כן מזיזים את הבסיס**.
-- ניפוח cycle_total הוא קבוע ובלתי הפיך; ובלי הזזת הבסיס, בקר שהוחלף
-- באמת היה מייצר "חשד" בכל הודעה ותקוע בלוג לנצח.
--
-- ⚠️ **תקרה מוחלטת לא הייתה עובדת** — הסוכן יכול להיות מנותק שבועות,
-- ואז delta גדול הוא אמיתי לגמרי. לכן התקרה נגזרת מהזמן שחלף.
--
-- ⚠️ והרצפה (JUMP_FLOOR) קיימת כי שתי פעולות יכולות להירשם באותה שנייה:
-- בלעדיה elapsed=0 היה הופך כל delta לחשוד.
--
-- ⚠️ ההשוואה `p_occurred_at < p_last_ts` היא **לקסיקלית על TEXT**, בדיוק
-- כמו בצד ה-JS (השוואת מחרוזות ISO). זה גם הכלל בקובץ הפונקציות: לסנן
-- לקסיקלית, ולהמיר רק לחשבון.
CREATE OR REPLACE FUNCTION app.decide_cycle_update(
  p_last        integer,
  p_last_ts     text,
  p_total       integer,
  p_is_new_site integer,
  p_current     integer,
  p_occurred_at text
)
RETURNS TABLE (
  mode           text,
  total          integer,
  next_last      integer,
  do_write       boolean,
  ignored_amount integer
)
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  -- הקבועים חיים בשני מקומות, וזה מכוון: הצד השני הוא db/cycle-rules.js,
  -- ושער ההשוואה נופל אם הם נפרדים.
  RESET_PLAUSIBLE_MAX  constant integer := 100;
  MAX_CYCLES_PER_MINUTE constant integer := 3;
  JUMP_FLOOR           constant integer := 10;

  v_delta       integer;
  v_elapsed_min double precision;
  v_allowed     double precision;
BEGIN
  -- מונה פסול. ⚠️ NULL נכלל כאן: על הודעת start המונה עשוי להיות חסר.
  IF p_current IS NULL OR p_current < 0 THEN
    RETURN QUERY SELECT 'invalid'::text, p_total, p_last, false, 0;
    RETURN;
  END IF;

  -- אין בסיס — הקריאה הראשונה מהאתר הזה.
  IF p_last IS NULL THEN
    RETURN QUERY SELECT 'first'::text,
      CASE WHEN p_is_new_site = 0 THEN p_current ELSE p_total END,
      p_current, true, 0;
    RETURN;
  END IF;

  -- הודעה שקרתה לפני הקריאה האחרונה.
  IF p_last_ts IS NOT NULL AND p_occurred_at < p_last_ts THEN
    RETURN QUERY SELECT 'backfill'::text, p_total, p_last, false, 0;
    RETURN;
  END IF;

  IF p_current >= p_last THEN
    v_delta := p_current - p_last;

    IF p_last_ts IS NULL THEN
      -- אין ממה לגזור תקרה. אינסוף, כמו ב-JS.
      v_allowed := 'infinity'::double precision;
    ELSE
      v_elapsed_min := GREATEST(0,
        EXTRACT(EPOCH FROM (p_occurred_at::timestamptz - p_last_ts::timestamptz)) / 60.0);
      v_allowed := GREATEST(JUMP_FLOOR, CEIL(v_elapsed_min * MAX_CYCLES_PER_MINUTE));
    END IF;

    IF v_delta > v_allowed THEN
      RETURN QUERY SELECT 'jump_suspect'::text, p_total, p_current, true, v_delta;
      RETURN;
    END IF;

    RETURN QUERY SELECT 'normal'::text, p_total + v_delta, p_current, true, 0;
    RETURN;
  END IF;

  -- ירידה. נמוך = אתחול סביר; גבוה = חשוד.
  IF p_current <= RESET_PLAUSIBLE_MAX THEN
    RETURN QUERY SELECT 'reset'::text, p_total + p_current, p_current, true, 0;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'reset_suspect'::text, p_total, p_current, true, p_current;
END;
$fn$;

COMMENT ON FUNCTION app.decide_cycle_update(integer, text, integer, integer, integer, text) IS
  'פורט של decideCycleUpdate מ-db/cycle-rules.js. טהורה בשני הצדדים; parity-ingest-cycle משווה אותן ערך מול ערך.';

-- ============================================================
-- app.ingest_operation — מסלול התפעולים, פורט מ-operation-handler.js
-- ============================================================
-- הסדר כאן **הוא** ההתנהגות, ולא סגנון. כל שלב פורט מ-280 שורות שנולדו
-- ממדידות בשטח, ושינוי סדר הוא שינוי תוצאה.
--
-- ⚠️ **הכרטיס נקבע בפתיחה, לא בסגירה** — שני כשלים שנמדדו הובילו לזה:
--   1. סגירה ריקה: exit/start נשא כרטיס ב-100%, exit/end רק ב-67%.
--   2. סגירה עם הכרטיס של **הרכב הבא** — 86 מתוך 1,013 זוגות (8.5%),
--      ובחולדה 4 לבדה 66. זה גרוע יותר, כי הוא נראה כנתון תקין.
--
-- ⚠️ **כפילות יוצאת מיד** — ON CONFLICT DO NOTHING ולא תפיסת חריגה. בצד
-- ה-JS זה try/catch על 23505, ושם השגיאה מבטלת את הטרנזקציה כולה; כאן
-- ה-ON CONFLICT מונע אותה מלכתחילה, ולכן אין מה לבטל.
--
-- ⚠️ **תחזוקה גוברת** — פעולה בזמן חלון ידני לא תמשוך את הסטטוס
-- ל-operating. הכלל נאכף בצד ה-state מזמן ולא נאכף כאן; כלל שנאכף
-- במסלול אחד בלבד הוא כלל שלא נאכף.
CREATE OR REPLACE FUNCTION app.ingest_operation(
  p_site_id      integer,
  p_start_end    text,
  p_entry_exit   text,
  p_card         text,
  p_state        text,
  p_occurred_at  text,
  p_reported_at  text,
  p_cycle        integer
)
RETURNS TABLE (
  op_id         bigint,
  inserted      boolean,
  card_used     text,
  superseded    bigint,
  supersede_by  text,
  cycle_mode    text,
  cycle_total   integer,
  status_synced boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  -- חלונות הזמן. הצד השני הוא db/queries.js, והשער נופל אם הם נפרדים.
  CARD_INHERIT_WINDOW  constant interval := interval '2 hours';
  RETRY_MERGE_WINDOW   constant interval := interval '30 minutes';
  FLICKER_MERGE_WINDOW constant interval := interval '15 seconds';
  ISO                  constant text := 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

  v_card        text := COALESCE(p_card, '');
  v_anomaly     integer := CASE WHEN p_state = 'operating' THEN 0 ELSE 1 END;
  v_id          bigint;
  v_start_card  text;
  v_start_at    text;
  v_closed      boolean;
  v_cut         bigint := NULL;
  v_cut_by      text := NULL;
  v_open_at     text;
  v_backfill    boolean;
  v_site_status text;
  v_in_maint    boolean;
  v_synced      boolean := false;
  v_now         text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  -- ⚠️ סקלרים ולא record: record שלא הוקצה זורק "is not assigned yet"
  -- ברגע שנוגעים בו, וההקצאה קורית רק בענף ה-end. הודעת start הייתה
  -- מפילה את הפונקציה כולה.
  v_cyc_mode    text := NULL;
  v_cyc_total   integer := NULL;
  v_cyc         record;
  v_site        record;
BEGIN
  -- ---------- 1. ירושת הכרטיס מהפתיחה ----------
  IF p_start_end = 'end' THEN
    SELECT o.card_number, o.occurred_at INTO v_start_card, v_start_at
      FROM operations o
     WHERE o.site_id = p_site_id
       AND o.entry_exit = p_entry_exit
       AND o.start_end = 'start'
       AND o.card_number <> ''
       AND o.occurred_at <= p_occurred_at
       AND o.occurred_at >= to_char(
             (p_occurred_at::timestamptz - CARD_INHERIT_WINDOW) AT TIME ZONE 'UTC', ISO)
     ORDER BY o.occurred_at DESC, o.id DESC
     LIMIT 1;

    IF v_start_card IS NOT NULL THEN
      -- ⚠️ הפתיחה נלקחת רק אם **לא נסגרה כבר** בסגירה אחרת בינתיים.
      -- בלי זה, סגירה שנייה הייתה יורשת כרטיס של פעולה שהסתיימה.
      SELECT EXISTS (
        SELECT 1 FROM operations o2
         WHERE o2.site_id = p_site_id AND o2.entry_exit = p_entry_exit
           AND o2.start_end = 'end'
           AND o2.occurred_at > v_start_at AND o2.occurred_at < p_occurred_at
      ) INTO v_closed;

      IF NOT v_closed THEN v_card := v_start_card; END IF;
    END IF;
  END IF;

  -- ---------- 2. הכנסה עם דדופ ----------
  INSERT INTO operations (site_id, start_end, entry_exit, card_number, state,
                          is_anomaly, occurred_at, received_at, reported_at, cycle_counter)
  VALUES (p_site_id, p_start_end, p_entry_exit, v_card, p_state, v_anomaly,
          p_occurred_at, v_now, COALESCE(p_reported_at, p_occurred_at), p_cycle)
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RETURN QUERY SELECT NULL::bigint, false, v_card, NULL::bigint, NULL::text,
                        NULL::text, NULL::integer, false;
    RETURN;
  END IF;

  -- ---------- 3. סימן חיים — קדימה בלבד ----------
  UPDATE sites SET last_seen = p_occurred_at
   WHERE id = p_site_id AND (last_seen IS NULL OR last_seen < p_occurred_at);

  -- ---------- 4. איחוד ניסיון שנקטע ----------
  IF p_start_end = 'start' THEN
    -- ⚠️ ריצוד MODE נבדק **ראשון ובלי תנאי על הכרטיס**: הוא קורה באמצע
    -- מעבר אחד, ולעתים הרגיסטר טרם נקרא ולכן צד אחד ריק. נמדד: 33 מקרים,
    -- כולם 1–13 שניות, עם הטיה של פי שלושה ליציאות — מקור שיטתי לתפוסה
    -- שלילית.
    SELECT o.id INTO v_cut
      FROM operations o
     WHERE o.site_id = p_site_id AND o.entry_exit = p_entry_exit
       AND o.start_end = 'end' AND o.is_anomaly = 0 AND o.superseded_by IS NULL
       AND o.occurred_at < p_occurred_at
       AND o.occurred_at >= to_char(
             (p_occurred_at::timestamptz - FLICKER_MERGE_WINDOW) AT TIME ZONE 'UTC', ISO)
     ORDER BY o.occurred_at DESC, o.id DESC
     LIMIT 1;

    IF v_cut IS NOT NULL THEN
      v_cut_by := 'flicker';
    ELSIF v_card <> '' THEN
      -- ⚠️ רק אם לא היה ריצוד: שניהם מסמנים את אותה עמודה, ואיחוד כפול
      -- היה מנסה להחריג פעולה שכבר הוחרגה.
      --
      -- ⚠️ וה-JOIN דורש שהסגירה תיפול בדיוק על תחילת מקטע **תקלה**, דרך
      -- הסטטוס האפקטיבי ולא הגולמי. ניסיון חוזר מוגדר כ"נקטע בתקלה".
      SELECT o.id INTO v_cut
        FROM operations o
        JOIN status_history h
          ON h.site_id = o.site_id AND h.started_at = o.occurred_at
         AND COALESCE(h.reclassified_to, h.status) = 'error'
       WHERE o.site_id = p_site_id AND o.entry_exit = p_entry_exit
         AND o.card_number = v_card
         AND o.start_end = 'end' AND o.is_anomaly = 0 AND o.superseded_by IS NULL
         AND o.occurred_at < p_occurred_at
         AND o.occurred_at >= to_char(
               (p_occurred_at::timestamptz - RETRY_MERGE_WINDOW) AT TIME ZONE 'UTC', ISO)
       ORDER BY o.occurred_at DESC, o.id DESC
       LIMIT 1;
      IF v_cut IS NOT NULL THEN v_cut_by := 'retry'; END IF;
    END IF;

    IF v_cut IS NOT NULL THEN
      UPDATE operations SET superseded_by = v_id
       WHERE id = v_cut AND superseded_by IS NULL;
    END IF;
  END IF;

  -- ---------- 5. שומר backfill + תחזוקה גוברת ----------
  SELECT h.started_at INTO v_open_at
    FROM status_history h
   WHERE h.site_id = p_site_id AND h.ended_at IS NULL
   ORDER BY h.started_at DESC LIMIT 1;

  v_backfill := v_open_at IS NOT NULL AND p_occurred_at < v_open_at;

  SELECT s.status INTO v_site_status FROM sites s WHERE s.id = p_site_id;

  IF p_start_end = 'start' AND p_state <> v_site_status AND NOT v_backfill THEN
    SELECT v_site_status = 'maintenance' OR EXISTS (
      SELECT 1 FROM maintenance_windows m
       WHERE m.site_id = p_site_id AND m.cancelled_at IS NULL
         AND m.started_at <= v_now AND m.expires_at > v_now
    ) INTO v_in_maint;

    IF NOT v_in_maint THEN
      UPDATE status_history SET ended_at = p_occurred_at
       WHERE site_id = p_site_id AND ended_at IS NULL;
      INSERT INTO status_history (site_id, status, started_at)
      VALUES (p_site_id, p_state, p_occurred_at);
      UPDATE sites SET status = p_state WHERE id = p_site_id;
      v_synced := true;
    END IF;
  END IF;

  -- ---------- 6. מונה המחזורים — רק על end ----------
  IF p_start_end = 'end' THEN
    SELECT s.cycle_total, s.plc_cycle_last, s.cycle_last_ts, s.is_new_site
      INTO v_site FROM sites s WHERE s.id = p_site_id FOR UPDATE;

    SELECT * INTO v_cyc FROM app.decide_cycle_update(
      v_site.plc_cycle_last, v_site.cycle_last_ts, v_site.cycle_total,
      v_site.is_new_site, p_cycle, p_occurred_at);

    v_cyc_mode := v_cyc.mode;
    v_cyc_total := v_cyc.total;

    IF v_cyc.do_write THEN
      UPDATE sites SET cycle_total = v_cyc.total, plc_cycle_last = v_cyc.next_last,
                       cycle_last_ts = p_occurred_at
       WHERE id = p_site_id;
    END IF;
  END IF;

  RETURN QUERY SELECT v_id, true, v_card, v_cut, v_cut_by,
                      v_cyc_mode, v_cyc_total, v_synced;
END;
$fn$;

COMMENT ON FUNCTION app.ingest_operation(integer, text, text, text, text, text, text, integer) IS
  'פורט של operation-handler.js. parity-ingest-op משווה אותה מול המסלול הקיים על אותן הודעות.';

-- ============================================================
-- app.ingest_state — מסלול המצב, פורט מ-state-handler.js
-- ============================================================
-- שישה שלבים, וכל אחד מהם נולד מכשל שנמדד. הסדר הוא ההתנהגות.
--
-- ⚠️ **הצוואה המאוחרת** (שלב 1). הודעת no_comm אינה מגיעה מהאתר — הברוקר
-- מפרסם אותה בשמו כשהחיבור מת, ולכן **אין לה חותם זמן משלה** והשרת חותם
-- אותה ב"עכשיו". "עכשיו" הוא תמיד הזמן החדש ביותר שקיים, ולכן צוואה
-- שהתעכבה בתור עוברת את שומר ה-backfill (היא לא ישנה — היא "עכשיו"),
-- דורסת את המצב העדכני, ומסמנת כמנותק אתר שדיווח לפני שנייה.
-- הסף הוא 1.5 × keepalive של 60 שניות.
--
-- ⚠️ **תקלה בזמן תחזוקה מושמטת לגמרי** (שלב 3) — לא נרשמת כמקטע, ולכן
-- אינה נספרת באף מדד. אבל היא **כן** נרשמת ב-suppressed_faults, אחרת
-- המידע נעלם ואי אפשר לדעת בדיעבד שהיא קרתה.
--
-- ⚠️ **no_comm אינו מעדכן last_seen** (שלבים 5 ו-6). נתק אינו סימן חיים.
-- זו השורה שמפרידה בין "האתר שקט" ל"האתר נראה".
-- ⚠️ DROP לפני CREATE, ולא CREATE OR REPLACE לבדו: שינוי **שם** של עמודת
-- פלט ב-RETURNS TABLE נחשב שינוי טיפוס החזרה, ו-Postgres דוחה אותו ב-
-- "cannot change return type of existing function". בלי זה, מסד שכבר
-- מריץ גרסה ישנה פשוט לא יתעדכן — והשער ישווה מול פונקציה שאינה בקוד.
DROP FUNCTION IF EXISTS app.ingest_state(integer, text, text, text);

CREATE OR REPLACE FUNCTION app.ingest_state(
  p_site_id     integer,
  p_status      text,
  p_occurred_at text,
  p_fault_text  text DEFAULT NULL
)
RETURNS TABLE (
  applied     boolean,
  outcome     text,     -- applied / no_change / backfill / lwt_late / suppressed
  -- ⚠️ **at_used ולא occurred_at.** שם פלט ב-RETURNS TABLE הופך למשתנה,
  -- ואז ON CONFLICT (site_id, occurred_at) למטה אינו יודע אם הכוונה
  -- לעמודה או למשתנה — 42702, ומ-PostgREST זה חוזר כ-400. אותה מלכודת
  -- בדיוק שתועדה על uid=4096(AzureAD+נעמהמנדלסון) gid=4096 groups=4096 ב-writes.postgres.sql.
  at_used     text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  -- ⚠️ 1.5 × keepalive של 60 שניות. הצד השני הוא ingestion/lwt-order.js.
  LWT_MIN_SILENCE constant integer := 90;
  ISO             constant text := 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

  v_now      text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_at       text := p_occurred_at;
  v_site     record;
  v_silence  integer;
  v_open     record;
  v_in_maint boolean;
BEGIN
  SELECT s.id, s.status, s.last_seen INTO v_site
    FROM sites s WHERE s.id = p_site_id FOR UPDATE;

  IF v_site.id IS NULL THEN
    RETURN QUERY SELECT false, 'no_site'::text, v_at;
    RETURN;
  END IF;

  -- ---------- 1. צוואה מאוחרת ----------
  IF p_status = 'no_comm' THEN
    IF v_site.last_seen IS NOT NULL THEN
      v_silence := FLOOR(EXTRACT(EPOCH FROM (
        v_now::timestamptz - v_site.last_seen::timestamptz)))::integer;
      IF v_silence < LWT_MIN_SILENCE THEN
        RETURN QUERY SELECT false, 'lwt_late'::text, v_at;
        RETURN;
      END IF;
    END IF;

    -- ⚠️ החותם הוא **עכשיו**, מרוצף לשנייה שלמה. חוזה הסוכן הוא שניות,
    -- וחותם במילישניות שהשרת כותב נראה תמיד "חדש" מהסנכרון של הסוכן —
    -- אז שומר ה-backfill דוחה את הסנכרון והאתר נתקע ב-no_comm לנצח.
    v_at := to_char(date_trunc('second', now() AT TIME ZONE 'UTC'), ISO);
  END IF;

  -- ---------- 2. תקלה בזמן תחזוקה — מושמטת ----------
  IF p_status = 'error' THEN
    SELECT v_site.status = 'maintenance' OR EXISTS (
      SELECT 1 FROM maintenance_windows m
       WHERE m.site_id = p_site_id AND m.cancelled_at IS NULL
         AND m.started_at <= v_now AND m.expires_at > v_now
    ) INTO v_in_maint;

    IF v_in_maint THEN
      UPDATE sites SET last_seen = v_at
       WHERE id = p_site_id AND (last_seen IS NULL OR last_seen < v_at);

      -- ⚠️ נרשמת ללוג ולא נעלמת. בלי זה אי אפשר לדעת בדיעבד שהיא קרתה.
      INSERT INTO suppressed_faults (site_id, occurred_at, fault_text, reason, created_at)
      VALUES (p_site_id, v_at, p_fault_text,
              CASE WHEN v_site.status = 'maintenance' THEN 'plc' ELSE 'window' END, v_now)
      ON CONFLICT (site_id, occurred_at) DO NOTHING;

      RETURN QUERY SELECT false, 'suppressed'::text, v_at;
      RETURN;
    END IF;
  END IF;

  -- ---------- 3. שומר backfill ----------
  SELECT h.status, h.started_at INTO v_open
    FROM status_history h
   WHERE h.site_id = p_site_id AND h.ended_at IS NULL
   ORDER BY h.started_at DESC LIMIT 1;

  IF v_open.started_at IS NOT NULL AND v_at < v_open.started_at THEN
    RETURN QUERY SELECT false, 'backfill'::text, v_at;
    RETURN;
  END IF;

  -- ---------- 4. אין שינוי ----------
  IF p_status = v_site.status THEN
    IF p_status = 'no_comm' THEN
      -- ⚠️ נתק אינו סימן חיים — last_seen אינו זז.
      RETURN QUERY SELECT false, 'no_change'::text, v_at;
      RETURN;
    END IF;

    UPDATE sites SET last_seen = v_at
     WHERE id = p_site_id AND (last_seen IS NULL OR last_seen < v_at);

    -- ⚠️ תיאור תקלה שהגיע באיחור ממלא מקטע פתוח שנשאר בלי תיאור. הבקר
    -- מדווח את הטקסט אחרי ה-MODE, ולכן המקטע נפתח ריק ומתמלא רק כאן.
    IF p_status = 'error' AND COALESCE(p_fault_text, '') <> '' THEN
      UPDATE status_history SET fault_text = p_fault_text
       WHERE site_id = p_site_id AND ended_at IS NULL
         AND COALESCE(reclassified_to, status) = 'error'
         AND fault_text IS NULL;
    END IF;

    RETURN QUERY SELECT false, 'no_change'::text, v_at;
    RETURN;
  END IF;

  -- ---------- 5. אותו מצב במקטע הפתוח ----------
  -- ⚠️ שכפול מכוון של הבדיקה למעלה: `sites.status` ו-`status_history` הם
  -- שני מקורות, והם יכולים להיפרד. applyStateChange בודקת את המקטע.
  IF v_open.status IS NOT NULL AND v_open.status = p_status THEN
    RETURN QUERY SELECT false, 'no_change'::text, v_at;
    RETURN;
  END IF;

  -- ---------- 6. החלפת מקטע ----------
  UPDATE status_history SET ended_at = v_at
   WHERE site_id = p_site_id AND ended_at IS NULL;

  INSERT INTO status_history (site_id, status, started_at, fault_text)
  VALUES (p_site_id, p_status, v_at, p_fault_text);

  IF p_status = 'no_comm' THEN
    -- ⚠️ הסטטוס בלבד. נתק אינו סימן חיים.
    UPDATE sites SET status = p_status WHERE id = p_site_id;
  ELSE
    UPDATE sites SET status = p_status,
                     last_seen = CASE WHEN last_seen IS NULL OR last_seen < v_at
                                      THEN v_at ELSE last_seen END
     WHERE id = p_site_id;
  END IF;

  RETURN QUERY SELECT true, 'applied'::text, v_at;
END;
$fn$;

COMMENT ON FUNCTION app.ingest_state(integer, text, text, text) IS
  'פורט של state-handler.js + applyStateChange. parity-ingest-state משווה מול המסלול הקיים.';
