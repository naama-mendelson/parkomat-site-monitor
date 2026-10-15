-- db/wizenet-relay.postgres.sql — שינוי סטטוס וסוג של קריאה בוויזנט, דרך מחשבי אתרים (15/10/2026).
--
-- ============================================================
-- ⚠️ למה ממסר, ולמה דווקא מחשב באתר
-- ============================================================
-- ה-API של ויזנט (WIZEAPI) עונה רק לפניות מישראל (אלכס, ויזנט, 14/10/2026: "מוגבלת לפניות מישראל… לחלופין,
-- ניתן לבצע את הפניות דרך שרת בישראל"). פונקציות ה-Edge של Supabase רצות בחו"ל ובלי כתובת קבועה, ולכן נחסמו
-- (הבקשה פשוט לא נענתה עד קצב-הזמן). מחשבי האתרים נמצאים בישראל, ונמדד שמחשב בישראל עובר את החסימה בלי שום
-- החרגה אצלם (13/10: הרשימות נטענו ממחשב הפיתוח; 15/10: 302 ללא טוקן תוך 0.7 שנ׳, לעומת קצב-זמן מחו"ל).
--
-- בעלת המוצר בחרה (14/10/2026): אחד ממחשבי האתרים כממסר, ועוד כמה לגיבוי — במקום שרת בתשלום עם IP קבוע.
--
-- ============================================================
-- הזרימה
-- ============================================================
--   לחיצה בדשבורד → wizenet_request_update (בזהות הלוחץ, require_staff) → שורה ב-wizenet_requests
--   + "פעמון": שורה ב-events (type 'service_calls', action 'relay')
--   → הסוכן באתר-ממסר שומע את הפעמון ב-Realtime (או בבדיקה שלו כל דקה) → wizenet_claim
--   → שולח לוויזנט בדיוק את מה שב-calls → wizenet_complete עם התשובה הגולמית
--   → כאן מוחלט אם הצליח ("update successfully"), ורק אז נרשם השינוי (app.service_call_store_change).
--   הדשבורד שואל wizenet_request_status עד שהבקשה נסגרת.
--
-- ⚠️ **כל ההחלטות כאן, והסוכן טיפש.** הסוכן לא יודע מה זו "קריאה" או "סטטוס": הוא מקבל רשימת פניות
-- (func + body), שולח, ומחזיר סטטוס HTTP וטקסט. מה לשלוח, ומה נחשב הצלחה — SQL. כך שינוי בצד של ויזנט הוא
-- שינוי בקובץ הזה, ולא התקנה מחדש בשלושה מחשבים באתרים. (הסוכן כן מחזיק רשימת היתר של שמות הפונקציות —
-- הגנה כפולה: גם מי שמשתלט על המסד לא יגרום לממסר לקרוא לפונקציה אחרת של ויזנט עם הטוקן.)
--
-- ⚠️ **הפעמון עובר ב-events ולא בטבלה משלו**, ובסוג 'service_calls' ולא בסוג חדש: הדשבורד הישן (מסך קיר,
-- PWA שלא נטען מחדש) מתייחס לסוג שאינו מכיר כ"משהו השתנה — לטעון הכול", וזה בדיוק מה שהפיל את המסד ב-07/10.
-- על 'service_calls' הוא רק מרענן את מספר הקריאות — שאילתה אחת קלה. (וגם: events היא חוזה האירועים, כלל 8.)
--
-- ⚠️ **הטוקן של ויזנט אינו כאן.** הוא סוד של פונקציית ה-Edge (WIZENET_TOKEN), והממסר מקבל אותו ממנה לזיכרון
-- (פעולה relay_config, אחרי wizenet_relay_me). בטבלה הוא היה נוסע בכל pg_dump ובגיבוי היומי.

-- ============================================================
-- הממסרים — אילו אתרים
-- ============================================================
-- ⚠️ ההפעלה היא שורה כאן, ולא הגדרה באתר: אין מה להקליד במחשב (כמו הסיסמה שהיא המתג של המסלול הישיר).
-- סוכן בגרסה החדשה באתר שאינו כאן — אינו עושה דבר.
-- polled_at — מתי הממסר שאל לאחרונה (כל דקה, ובכל צלצול). זה סימן החיים שלו כממסר: הוא מוכיח שהגרסה החדשה רצה
-- ושהלולאה שלה חיה, ולא רק שהסוכן פועם.
CREATE TABLE IF NOT EXISTS wizenet_relays (
  site_id        integer PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  enabled        boolean NOT NULL DEFAULT true,
  polled_at      timestamptz,
  socket_ok      boolean,                 -- האם ה-WebSocket שלו היה מחובר בשאלה האחרונה (לאבחון בלבד)
  agent_version  text,
  added_at       timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- הבקשות
-- ============================================================
-- ⚠️ timestamptz ולא TEXT — חריגה מכוונת מהכלל של הקובץ, כמו ב-alive: אין כאן טווח לסרוק באינדקס, וכל ההשוואות
-- הן "לפני יותר מ-X" מול now().
CREATE TABLE IF NOT EXISTS wizenet_requests (
  id                 bigserial PRIMARY KEY,
  kind               text NOT NULL,
  ticket             text,
  field              text,
  value              text,
  calls              jsonb NOT NULL,          -- [{ "func": "...", "body": {...} }] — בדיוק מה שהממסר שולח
  state              text NOT NULL DEFAULT 'pending',
  requested_by       text NOT NULL,           -- השם המאומת של מי שלחץ (או "רענון יומי")
  requested_by_user  integer,
  created_at         timestamptz NOT NULL DEFAULT now(),
  claimed_site       integer REFERENCES sites(id) ON DELETE SET NULL,
  claimed_at         timestamptz,
  attempt            integer NOT NULL DEFAULT 0,
  finished_at        timestamptz,
  result             text,                    -- מה שהדשבורד מציג, בעברית
  response           text,                    -- התשובה הגולמית של ויזנט (חתוכה) — לאבחון כשמשהו נכשל
  -- ממסרים שניסו ולא הגיעו לוויזנט (רשת, תצורה) — הבקשה חוזרת לתור, ולא תילקח שוב על ידם. ראו wizenet_complete.
  failed_sites       integer[] NOT NULL DEFAULT '{}',
  CONSTRAINT wizenet_requests_kind CHECK (kind IN ('update', 'lookups')),
  CONSTRAINT wizenet_requests_state CHECK (state IN ('pending', 'claimed', 'done', 'failed', 'expired')),
  CONSTRAINT wizenet_requests_update_shape CHECK (
    kind <> 'update' OR (ticket IS NOT NULL AND field IN ('status', 'type') AND value IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_wizenet_requests_open ON wizenet_requests (id) WHERE state IN ('pending', 'claimed');
CREATE INDEX IF NOT EXISTS idx_wizenet_requests_created ON wizenet_requests (created_at);

-- ⚠️ שתי הטבלאות סגורות (RLS בלי מדיניות, בלי הרשאות): כל קריאה וכתיבה דרך RPC. לממסר אין SELECT על הבקשות —
-- הוא מקבל בדיוק את הבקשה שתפס, בלי שמות של מי שלחץ.
DO $$
DECLARE t text; r text;
BEGIN
  FOREACH t IN ARRAY ARRAY['wizenet_relays', 'wizenet_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
      END IF;
    END LOOP;
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
  END LOOP;
END $$;

-- ============================================================
-- שלושת השעונים
-- ============================================================
-- ⚠️ בקשה היא בקשה לרגע הזה, לא הוראה עומדת (הלקח מכפתור "הפעלה מחדש": בקשה #12 נתקעה יומיים, וביצוע שלה
-- באיחור היה מפיל את השרת בזמן אקראי). שינוי סטטוס שיוצא אחרי שעה עלול לדרוס את מה שהמוקד עשה בינתיים.
--   ttl   — בקשה שאף ממסר לא לקח תוך 2 דקות פגה, ולא תישלח.
--   lease — ממסר שלקח ולא החזיר תשובה תוך 2 דקות — ממסר אחר רשאי לקחת. ⚠️ 120 ולא 60 (סקירה, 15/10): המקרה הגרוע
--           של ממסר הוא כ-90 שנ׳ (התחברות, ניסיון חוזר על 401, הטוקן מפונקציית ה-Edge, ושתי פניות לוויזנט × 15 שנ׳).
--           בחכירה של 60 ממסר אחר היה לוקח ושולח שוב שינוי שכבר נעשה, וה"update successfully" של הראשון נדחה.
--   fresh — ממסר נחשב חי אם שאל ב-3 הדקות האחרונות (הוא שואל כל דקה; שלוש החמצות, כמו סריקת השתיקה).
CREATE OR REPLACE FUNCTION app.wizenet_request_ttl() RETURNS interval
LANGUAGE sql IMMUTABLE AS $$ SELECT interval '2 minutes' $$;
CREATE OR REPLACE FUNCTION app.wizenet_claim_lease() RETURNS interval
LANGUAGE sql IMMUTABLE AS $$ SELECT interval '120 seconds' $$;
CREATE OR REPLACE FUNCTION app.wizenet_relay_fresh() RETURNS interval
LANGUAGE sql IMMUTABLE AS $$ SELECT interval '3 minutes' $$;
REVOKE ALL ON FUNCTION app.wizenet_request_ttl() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.wizenet_claim_lease() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.wizenet_relay_fresh() FROM PUBLIC;

-- ============================================================
-- מי ממסר
-- ============================================================
-- ⚠️ האתר נגזר מהזהות (app.agent_site_id), לא מפרמטר — כמו ב-ingest_batch: סוכן אינו יכול להתחזות לממסר על
-- ידי שליחת מספר. agent_site_id מחזירה NULL לכל מי שאינו סוכן פעיל (כולל מנהל), ולכן גם כאן NULL = לא ממסר.
CREATE OR REPLACE FUNCTION app.wizenet_relay_site() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
  SELECT r.site_id FROM wizenet_relays r WHERE r.site_id = app.agent_site_id() AND r.enabled
$$;
REVOKE ALL ON FUNCTION app.wizenet_relay_site() FROM PUBLIC;

-- לסוכן: "האם אני ממסר?" — כדי לא לפתוח WebSocket באתר שאינו. ולפונקציית ה-Edge: האם למסור לקורא את הטוקן.
CREATE OR REPLACE FUNCTION public.wizenet_relay_me() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
  SELECT app.wizenet_relay_site() IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public.wizenet_relay_me() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wizenet_relay_me() TO authenticated;

CREATE OR REPLACE FUNCTION app.wizenet_relays_alive() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $$
  SELECT count(*)::integer FROM wizenet_relays r
   WHERE r.enabled AND r.polled_at > now() - app.wizenet_relay_fresh()
$$;
REVOKE ALL ON FUNCTION app.wizenet_relays_alive() FROM PUBLIC;

-- לדשבורד: האם יש היום דרך לוויזנט. ⚠️ מספרים בלבד — אילו אתרים הם ממסרים אינו עניין של המסך.
CREATE OR REPLACE FUNCTION public.wizenet_relays_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
BEGIN
  PERFORM app.require_staff();
  RETURN jsonb_build_object(
    'alive', app.wizenet_relays_alive(),
    'enabled', (SELECT count(*)::integer FROM wizenet_relays r WHERE r.enabled));
END $fn$;
REVOKE ALL ON FUNCTION public.wizenet_relays_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wizenet_relays_status() TO authenticated;

-- ============================================================
-- פקיעה
-- ============================================================
-- ⚠️ שני נוסחים, כי הם שתי אמיתות שונות: בקשה שאיש לא לקח — **לא נשלחה**. בקשה שממסר לקח ולא חזר — **לא ידוע**
-- אם נשלחה (אולי ויזנט קיבלו, והממסר נפל לפני שדיווח). "לא נשלח" על השנייה היה שולח את המשתמש ללחוץ שוב על
-- משהו שאולי כבר קרה.
-- ⚠️ בקשה שנלקחה אינה פגה כל עוד החכירה שלה בתוקף, גם אחרי 2 הדקות: הממסר אולי באמצע הפנייה, ותשובה שתגיע
-- אחרי שסימנו "פג" הייתה נדחית — והשינוי בוויזנט לא היה נרשם אצלנו.
CREATE OR REPLACE FUNCTION app.wizenet_expire() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE v_n integer;
BEGIN
  -- ⚠️ ונוסח שלישי: ממסרים ניסו ולא הגיעו לוויזנט (failed_sites) — אומרים למה, ולא "אף ממסר לא לקח"
  UPDATE wizenet_requests q
     SET state = 'expired', finished_at = now(),
         result = CASE
                    WHEN q.state = 'pending' AND cardinality(q.failed_sites) > 0
                      THEN 'לא נשלח לוויזנט — ' || COALESCE(q.result, 'הממסרים לא הגיעו לוויזנט')
                    WHEN q.state = 'pending' THEN 'לא נשלח לוויזנט — אף ממסר לא לקח את הבקשה תוך 2 דקות'
                    ELSE 'לא ידוע אם השינוי הגיע לוויזנט — הממסר שלקח את הבקשה לא החזיר תשובה' END
   WHERE q.created_at < now() - app.wizenet_request_ttl()
     AND (q.state = 'pending'
          OR (q.state = 'claimed' AND q.claimed_at < now() - app.wizenet_claim_lease()));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $fn$;
REVOKE ALL ON FUNCTION app.wizenet_expire() FROM PUBLIC;

-- ============================================================
-- הכנסה לתור — המקום היחיד
-- ============================================================
-- ⚠️ בלי ממסר חי — סירוב מיידי, ולא שורה שתחכה 2 דקות ותפוג: מי שלחץ צריך לדעת עכשיו, ולא אחרי שהלך.
-- ⚠️ ותקרה של 20 פתוחות: לחיצות חוזרות של מי שלא ראה תגובה הן 20 פניות לוויזנט עם הטוקן שלנו.
CREATE OR REPLACE FUNCTION app.wizenet_enqueue(p_kind text, p_ticket text, p_field text, p_value text,
                                               p_calls jsonb, p_actor text, p_actor_user integer)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE v_id bigint;
BEGIN
  PERFORM app.wizenet_expire();
  IF app.wizenet_relays_alive() = 0 THEN
    RAISE EXCEPTION 'אין כרגע ממסר פעיל לוויזנט — השינוי לא נשלח' USING ERRCODE = 'PT503';
  END IF;
  IF (SELECT count(*) FROM wizenet_requests q WHERE q.state IN ('pending', 'claimed')) >= 20 THEN
    RAISE EXCEPTION 'יותר מדי בקשות ממתינות לוויזנט — לנסות שוב בעוד דקה' USING ERRCODE = 'PT429';
  END IF;
  INSERT INTO wizenet_requests (kind, ticket, field, value, calls, requested_by, requested_by_user)
  VALUES (p_kind, p_ticket, p_field, p_value, p_calls, COALESCE(NULLIF(btrim(p_actor), ''), 'מערכת'), p_actor_user)
  RETURNING id INTO v_id;
  -- הפעמון. ⚠️ רק המספר — בלי קריאה, בלי ערך ובלי שם: events נקראת על ידי כל משתמש פעיל.
  PERFORM app.record_write_event('*', 'service_calls',
    jsonb_build_object('type', 'service_calls', 'code', NULL, 'action', 'relay', 'id', v_id));
  RETURN v_id;
END $fn$;
REVOKE ALL ON FUNCTION app.wizenet_enqueue(text, text, text, text, jsonb, text, integer) FROM PUBLIC;

-- שתי השאילתות של הרשימות. ⚠️ מזהי השאילתות (QRYID) אינם ידועים כאן — הם בסודות של פונקציית ה-Edge מאז
-- 13/10 — ולכן מקום-שמור ({{qry_status}}), שהממסר ממלא מהתצורה שקיבל יחד עם הטוקן. "kind" — כדי לדעת איזו
-- תשובה היא איזו רשימה; הממסר מתעלם ממנו.
CREATE OR REPLACE FUNCTION app.wizenet_lookup_calls() RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_array(
    jsonb_build_object('kind', 'status', 'func', 'wizeApp_getBIReportQuery', 'body', jsonb_build_object('QRYID', '{{qry_status}}')),
    jsonb_build_object('kind', 'type',   'func', 'wizeApp_getBIReportQuery', 'body', jsonb_build_object('QRYID', '{{qry_type}}')))
$$;
REVOKE ALL ON FUNCTION app.wizenet_lookup_calls() FROM PUBLIC;

-- ============================================================
-- מהדשבורד
-- ============================================================
-- ⚠️ הבדיקות כאן הן אלה שפונקציית ה-Edge עשתה לפני הפנייה לוויזנט, ועוד אחת: הקריאה חייבת להיות מוכרת לנו.
-- שינוי שוויזנט יאשרו אבל לא נוכל לרשום — עדיף לסרב לו מראש (הדשבורד ממילא לא מציג קריאה שאינה אצלנו).
CREATE OR REPLACE FUNCTION public.wizenet_request_update(p_ticket text, p_field text, p_value text)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_staff();
  v_ticket text := btrim(COALESCE(p_ticket, ''));
  v_value text := btrim(COALESCE(p_value, ''));
  v_id bigint;
BEGIN
  IF p_field IS NULL OR p_field NOT IN ('status', 'type') THEN
    RAISE EXCEPTION 'שדה לא מוכר' USING ERRCODE = 'check_violation';
  END IF;
  -- ⚠️ ויזנט דוחים callid שאינו מספר חיובי — אומרים את זה לפני שפונים אליהם
  IF v_ticket !~ '^[0-9]+$' OR v_ticket ~ '^0+$' THEN
    RAISE EXCEPTION 'מספר קריאה לא תקין' USING ERRCODE = 'check_violation';
  END IF;
  IF v_value !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'ערך לא תקין' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM wizenet_lookups w WHERE w.kind = p_field)
     AND NOT EXISTS (SELECT 1 FROM wizenet_lookups w WHERE w.kind = p_field AND w.id = v_value) THEN
    RAISE EXCEPTION 'ערך לא מוכר: %', v_value USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.service_calls_current() c WHERE c.ticket = v_ticket) THEN
    RAISE EXCEPTION 'הקריאה לא נמצאה' USING ERRCODE = 'PT404';
  END IF;

  v_id := app.wizenet_enqueue('update', v_ticket, p_field, v_value,
    jsonb_build_array(jsonb_build_object(
      'func', CASE p_field WHEN 'status' THEN 'wizeApp_updateCallStatus' ELSE 'wizeApp_updateCallType' END,
      'body', jsonb_build_object('callid', v_ticket,
                                 CASE p_field WHEN 'status' THEN 'callstatusid' ELSE 'calltypeid' END, v_value))),
    v_actor, app.current_app_user());
  PERFORM app.record_write_audit('wizenet.request', v_actor, app.current_app_role(), 'service_call', v_ticket,
    jsonb_build_object('field', p_field, 'value', v_value, 'request', v_id));
  RETURN v_id;
END $fn$;
REVOKE ALL ON FUNCTION public.wizenet_request_update(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wizenet_request_update(text, text, text) TO authenticated;

-- רענון רשימות הסטטוסים והסוגים מוויזנט — כל איש צוות, כמו קודם
CREATE OR REPLACE FUNCTION public.wizenet_request_lookups()
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_actor text := app.require_staff();
  v_id bigint;
BEGIN
  v_id := app.wizenet_enqueue('lookups', NULL, NULL, NULL, app.wizenet_lookup_calls(), v_actor, app.current_app_user());
  PERFORM app.record_write_audit('wizenet.request', v_actor, app.current_app_role(), 'wizenet', 'lookups',
    jsonb_build_object('request', v_id));
  RETURN v_id;
END $fn$;
REVOKE ALL ON FUNCTION public.wizenet_request_lookups() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wizenet_request_lookups() TO authenticated;

-- מה קרה לבקשה. ⚠️ כל איש צוות, לא רק מי ששלח: הבקשה אינה נושאת שום דבר שאינו כבר על המסך שלו.
-- ⚠️ VOLATILE (מריצה את הפקיעה): הדשבורד שואל עד שהבקשה נסגרת, ובלי ממסר חי איש אחר לא היה מפקיע אותה.
CREATE OR REPLACE FUNCTION public.wizenet_request_status(p_id bigint)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE v jsonb;
BEGIN
  PERFORM app.require_staff();
  PERFORM app.wizenet_expire();
  SELECT jsonb_build_object('id', q.id, 'kind', q.kind, 'state', q.state, 'result', q.result)
    INTO v FROM wizenet_requests q WHERE q.id = p_id;
  IF v IS NULL THEN RAISE EXCEPTION 'הבקשה לא נמצאה' USING ERRCODE = 'PT404'; END IF;
  RETURN v;
END $fn$;
REVOKE ALL ON FUNCTION public.wizenet_request_status(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wizenet_request_status(bigint) TO authenticated;

-- ============================================================
-- מהממסר
-- ============================================================
-- לקיחת הבקשה הבאה. ⚠️ FOR UPDATE SKIP LOCKED: שלושה ממסרים ששמעו את אותו פעמון באותה שנייה — אחד לוקח,
-- והשניים האחרים מקבלים NULL ולא ממתינים לנעילה. כל קריאה כאן היא גם סימן החיים של הממסר (polled_at).
CREATE OR REPLACE FUNCTION public.wizenet_claim(p_socket boolean DEFAULT NULL, p_version text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_site integer := app.wizenet_relay_site();
  v_id bigint;
  q wizenet_requests%ROWTYPE;
BEGIN
  IF v_site IS NULL THEN
    RAISE EXCEPTION 'האתר הזה אינו ממסר לוויזנט' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE wizenet_relays r
     SET polled_at = now(), socket_ok = p_socket,
         agent_version = COALESCE(NULLIF(btrim(p_version), ''), r.agent_version)
   WHERE r.site_id = v_site;
  PERFORM app.wizenet_expire();

  -- ⚠️ בקשה שהממסר הזה כבר ניסה ולא הגיע איתה לוויזנט — לא שלו עוד: אחרת ממסר בלי חיבור לוויזנט היה לוקח אותה
  -- שוב ושוב (הוא מרוקן את התור בלולאה), והגיבוי לא היה מקבל הזדמנות.
  SELECT w.id INTO v_id FROM wizenet_requests w
   WHERE (w.state = 'pending'
          OR (w.state = 'claimed' AND w.claimed_at < now() - app.wizenet_claim_lease()))
     AND NOT (v_site = ANY (w.failed_sites))
   ORDER BY w.id
   LIMIT 1
   FOR UPDATE SKIP LOCKED;
  IF v_id IS NULL THEN RETURN NULL; END IF;

  UPDATE wizenet_requests w
     SET state = 'claimed', claimed_site = v_site, claimed_at = now(), attempt = w.attempt + 1
   WHERE w.id = v_id
  RETURNING * INTO q;
  RETURN jsonb_build_object('id', q.id, 'attempt', q.attempt, 'calls', q.calls);
END $fn$;
REVOKE ALL ON FUNCTION public.wizenet_claim(boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wizenet_claim(boolean, text) TO authenticated;

-- ============================================================
-- פענוח התשובות של ויזנט
-- ============================================================
-- הודעות השגיאה של ויזנט (מקבצי ההסבר) — בעברית, כדי שמי שלחץ יבין מה קרה. הועבר מפונקציית ה-Edge כמות שהוא.
CREATE OR REPLACE FUNCTION app.wizenet_error_text(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN lower(COALESCE(p_text, '')) LIKE '%call not found%' THEN 'הקריאה לא נמצאה בוויזנט'
    WHEN lower(COALESCE(p_text, '')) LIKE '%callstatusid not found%'
      OR lower(COALESCE(p_text, '')) LIKE '%calltypeid not found%' THEN 'הערך שנבחר אינו קיים בוויזנט'
    WHEN lower(COALESCE(p_text, '')) LIKE '%go_to_wizenet%' THEN 'שגיאה במערכת של ויזנט — לנסות שוב מאוחר יותר'
    WHEN lower(COALESCE(p_text, '')) LIKE '%unauthorized%'
      OR lower(COALESCE(p_text, '')) LIKE '%token%' THEN 'ויזנט דחו את הטוקן'
    ELSE 'ויזנט החזירו שגיאה: ' || left(COALESCE(p_text, ''), 200)
  END
$$;
REVOKE ALL ON FUNCTION app.wizenet_error_text(text) FROM PUBLIC;

-- תשובה אחת מהממסר: { "status": 200, "text": "..." }, או { "error": "timeout" | "network", "detail": "..." }.
-- NULL = הפנייה עברה והחזירה 2xx; אחרת — הסיבה, בעברית. התוכן עצמו (update successfully, רשימה) נבדק אחר כך.
-- ⚠️ 3xx בנפרד: ויזנט עונים לבקשה בלי טוקן תקף בהפניה לדף ההתחברות (302, נמדד 15/10). הממסר אינו עוקב אחרי
-- הפניות — אחרת דף ה-HTML של ההתחברות היה מגיע כ-200 ונקרא כ"שגיאה" לא מובנת.
CREATE OR REPLACE FUNCTION app.wizenet_call_error(p_res jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_res IS NULL OR jsonb_typeof(p_res) <> 'object' THEN 'הממסר לא החזיר תשובה לפנייה'
    WHEN p_res ->> 'error' = 'timeout' THEN 'ויזנט לא ענו בזמן'
    -- הממסר לא שלח בכלל: חסר לו ערך למקום-שמור (מזהה שאילתה שלא הוגדר בסודות הפונקציה), או פונקציה שאינה
    -- ברשימת ההיתר שלו. אומרים מה — "אין חיבור" היה שולח לבדוק את הרשת באתר.
    WHEN p_res ->> 'error' = 'config' THEN 'חסרה הגדרה בממסר: ' || COALESCE(p_res ->> 'detail', '')
    WHEN p_res ? 'error' THEN 'אין חיבור לוויזנט מהממסר'
    -- ⚠️ COALESCE: בלי status, השוואה עם NULL היא NULL, ה-CASE היה ממשיך הלאה ומדווח "ויזנט החזירו שגיאה"
    WHEN COALESCE(p_res ->> 'status', '') !~ '^[0-9]{3}$' THEN 'הממסר לא החזיר תשובה לפנייה'
    WHEN (p_res ->> 'status')::integer BETWEEN 200 AND 299 THEN NULL
    WHEN (p_res ->> 'status')::integer BETWEEN 300 AND 399 THEN 'ויזנט דחו את הבקשה (הפניה להתחברות) — כנראה הטוקן'
    ELSE app.wizenet_error_text(p_res ->> 'text')
  END
$$;
REVOKE ALL ON FUNCTION app.wizenet_call_error(jsonb) FROM PUBLIC;

-- פענוח רשימה מוויזנט — אותו כלל בדיוק כמו parseLookup שהיה בפונקציית ה-Edge (13/10/2026).
-- ⚠️ מבנה התשובה לא תואר בקבצי ההסבר ("תוחזר הרשימה של המידע שביקשתם"). לכן הפענוח סובלני: מערך, או
-- המערך הראשון בתוך אובייקט; בכל שורה — מפתח שהוא id (או מסתיים ב-id) ומפתח של שם. שורה שאין בה שניהם — לא
-- נכנסת.
-- ⚠️ json ולא jsonb: "המפתח **הראשון** שמסתיים ב-id" תלוי בסדר המפתחות כפי שנכתבו. jsonb ממיין אותם (לפי אורך),
-- ושורה עם StatusId וגם TypeId הייתה בוחרת אחר ממה שהפונקציה הקודמת בחרה — על אותה תשובה בדיוק.
CREATE OR REPLACE FUNCTION app.wizenet_parse_lookup(p_text text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  v_body json;
  v_rows json;
  v_row json;
  v_keys text[];
  v_id_key text;
  v_name_key text;
  v_id text;
  v_name text;
  v_out jsonb := '[]'::jsonb;
BEGIN
  BEGIN
    v_body := p_text::json;
  EXCEPTION WHEN others THEN
    RETURN v_out;
  END;
  IF v_body IS NULL THEN RETURN v_out; END IF;
  v_rows := v_body;
  IF json_typeof(v_rows) = 'object' THEN
    SELECT e.value INTO v_rows
      FROM json_each(v_body) WITH ORDINALITY AS e(key, value, n)
     WHERE json_typeof(e.value) = 'array'
     ORDER BY e.n LIMIT 1;
  END IF;
  IF v_rows IS NULL OR json_typeof(v_rows) <> 'array' THEN RETURN v_out; END IF;

  FOR v_row IN SELECT x FROM json_array_elements(v_rows) AS x LOOP
    CONTINUE WHEN json_typeof(v_row) <> 'object';
    SELECT array_agg(k ORDER BY n) INTO v_keys FROM json_object_keys(v_row) WITH ORDINALITY AS t(k, n);
    CONTINUE WHEN v_keys IS NULL;
    v_id_key := COALESCE(
      (SELECT k FROM unnest(v_keys) WITH ORDINALITY AS u(k, n) WHERE lower(k) = 'id' ORDER BY n LIMIT 1),
      (SELECT k FROM unnest(v_keys) WITH ORDINALITY AS u(k, n) WHERE k ~* 'id$' ORDER BY n LIMIT 1),
      (SELECT k FROM unnest(v_keys) WITH ORDINALITY AS u(k, n) WHERE k ~ '^(קוד|מזהה)$' ORDER BY n LIMIT 1));
    v_name_key := COALESCE(
      (SELECT k FROM unnest(v_keys) WITH ORDINALITY AS u(k, n)
        WHERE k IS DISTINCT FROM v_id_key AND k ~* '(name|desc|title|שם|תיאור)' ORDER BY n LIMIT 1),
      CASE WHEN cardinality(v_keys) = 2 THEN
        (SELECT k FROM unnest(v_keys) WITH ORDINALITY AS u(k, n) WHERE k IS DISTINCT FROM v_id_key ORDER BY n LIMIT 1)
      END);
    CONTINUE WHEN v_id_key IS NULL OR v_name_key IS NULL;
    -- ⚠️ trim של JS מוריד גם שורה חדשה וטאב; btrim של Postgres — רק רווח
    v_id := regexp_replace(COALESCE(v_row ->> v_id_key, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g');
    v_name := regexp_replace(COALESCE(v_row ->> v_name_key, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g');
    IF v_id <> '' AND v_name <> '' THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_id, 'name', v_name));
    END IF;
  END LOOP;
  RETURN v_out;
END $fn$;
REVOKE ALL ON FUNCTION app.wizenet_parse_lookup(text) FROM PUBLIC;

-- ============================================================
-- התשובה מהממסר
-- ============================================================
-- p_results — תשובה לכל פנייה ב-calls, באותו סדר (ראו app.wizenet_call_error). ⚠️ רק הממסר שלקח, ורק בניסיון
-- שלקח (attempt): ממסר שהחכירה שלו פגה וממסר אחר לקח במקומו — התשובה המאוחרת שלו נדחית ({ accepted: false }),
-- אחרת שתי תשובות היו רושמות את אותו שינוי פעמיים, או תשובה ישנה הייתה דורסת חדשה.
CREATE OR REPLACE FUNCTION public.wizenet_complete(p_id bigint, p_attempt integer, p_results jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
DECLARE
  v_site integer := app.wizenet_relay_site();
  q wizenet_requests%ROWTYPE;
  v_state text := 'done';
  v_result text;
  v_response text;
  v_err text;
  v_res jsonb;
  v_call jsonb;
  v_items jsonb;
  v_lists jsonb := '{}'::jsonb;
  v_ns integer := 0;
  v_nt integer := 0;
  i integer;
BEGIN
  IF v_site IS NULL THEN
    RAISE EXCEPTION 'האתר הזה אינו ממסר לוויזנט' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO q FROM wizenet_requests w WHERE w.id = p_id FOR UPDATE;
  IF NOT FOUND OR q.state <> 'claimed' OR q.claimed_site IS DISTINCT FROM v_site
     OR q.attempt IS DISTINCT FROM p_attempt THEN
    RETURN jsonb_build_object('accepted', false);
  END IF;
  IF p_results IS NULL OR jsonb_typeof(p_results) <> 'array' THEN
    p_results := '[]'::jsonb;
  END IF;

  -- ============================================================
  -- ⚠️ הממסר לא הגיע לוויזנט — הבקשה חוזרת לתור, לממסר אחר
  -- ============================================================
  -- סקירה, 15/10/2026: ממסר שאינו מגיע לוויזנט (ספק אינטרנט שכתובתו אינה "ישראלית" בעיני ויזנט, DNS שבור באתר) עדיין
  -- "חי" — הוא שואל את התור — ולכן זוכה בחלקו מהצלצולים ומכשיל כל בקשה שלקח. בלי זה הגיבויים לא היו מקבלים אותן.
  -- "לא הגיע" = network / config: חיבור שנכשל, או הגדרה חסרה בממסר. ⚠️ לא קצב-זמן — שם אולי הגיע, ונאמר "לא ענו".
  -- update — רק כשהפנייה (היחידה) לא הגיעה. lookups — כל כשל כזה: שאילתת קריאה, ושליחה חוזרת אינה מזיקה. ⚠️ וגם
  -- כש"רשת" קרתה אחרי שהבקשה כבר יצאה (חיבור שנסגר לפני התשובה), שליחה חוזרת של אותו ערך לאותה קריאה אינה מזיקה.
  -- ⚠️ ורענון רשימות — גם בקצב-זמן (בדיקה, 15/10/2026): חסימה של ויזנט נראית כקצב-זמן, ושאילתת קריאה שנשלחת שוב
  -- אינה מזיקה. בעדכון קצב-זמן נשאר כשל — אולי השינוי כבר עבר.
  SELECT e.v INTO v_res FROM jsonb_array_elements(p_results) WITH ORDINALITY AS e(v, n)
   WHERE (e.v ->> 'error' IN ('network', 'config') OR (q.kind = 'lookups' AND e.v ->> 'error' = 'timeout'))
     AND (q.kind <> 'update' OR e.n = 1)
   ORDER BY e.n LIMIT 1;
  IF v_res IS NOT NULL THEN
    v_err := app.wizenet_call_error(v_res);
    UPDATE wizenet_requests w
       SET state = 'pending', claimed_site = NULL, claimed_at = NULL,
           failed_sites = array_append(w.failed_sites, v_site),
           result = v_err, response = left(v_res ->> 'detail', 2000)
     WHERE w.id = q.id
    RETURNING * INTO q;
    -- כל הממסרים החיים כבר ניסו — אין למי להעביר: נכשל עכשיו, עם הסיבה, ולא אחרי 2 דקות של המתנה
    IF NOT EXISTS (SELECT 1 FROM wizenet_relays r
                    WHERE r.enabled AND r.polled_at > now() - app.wizenet_relay_fresh()
                      AND NOT (r.site_id = ANY (q.failed_sites))) THEN
      UPDATE wizenet_requests w SET state = 'failed', finished_at = now() WHERE w.id = q.id;
      RETURN jsonb_build_object('accepted', true, 'state', 'failed', 'result', v_err);
    END IF;
    -- צלצול שוב: הבקשה פנויה, והממסרים האחרים צריכים לשמוע את זה עכשיו ולא בבדיקה של עוד דקה
    PERFORM app.record_write_event('*', 'service_calls',
      jsonb_build_object('type', 'service_calls', 'code', NULL, 'action', 'relay', 'id', q.id));
    RETURN jsonb_build_object('accepted', true, 'state', 'pending', 'result', v_err);
  END IF;
  v_res := NULL;

  IF q.kind = 'update' THEN
    v_res := p_results -> 0;
    v_err := app.wizenet_call_error(v_res);
    -- ⚠️ הצלחה רק במפורש ("update successfully"): תשובה 200 עם הודעת שגיאה בגוף היא שגיאה
    IF v_err IS NULL AND COALESCE(v_res ->> 'text', '') !~* 'update successfully' THEN
      v_err := app.wizenet_error_text(v_res ->> 'text');
    END IF;
    IF v_err IS NOT NULL THEN
      v_state := 'failed';
      v_result := v_err;
      v_response := left(COALESCE(v_res ->> 'text', v_res ->> 'detail'), 2000);
    ELSE
      -- ⚠️ כשל ברישום אינו מבטל את השינוי בוויזנט — הוא כבר קרה. לכן done, עם הסבר: המסך יתעדכן כשוויזנט
      -- ישלחו את העדכון שלהם. (כך גם בפונקציית ה-Edge, 13/10.)
      BEGIN
        PERFORM app.service_call_store_change(q.ticket, q.field, q.value, q.requested_by, q.requested_by_user);
        v_result := 'עודכן בוויזנט';
      EXCEPTION WHEN others THEN
        v_result := 'עודכן בוויזנט, אבל לא נרשם אצלנו — המסך יתעדכן כשוויזנט ישלחו את העדכון';
        v_response := left(SQLERRM, 500);
      END;
    END IF;

  ELSE  -- lookups
    -- ⚠️ שתי הרשימות נשמרות רק אם שתיהן פוענחו: אחרת אחת מתעדכנת והשנייה לא — חצי עבודה, בלי שום סימן.
    FOR i IN 0 .. jsonb_array_length(q.calls) - 1 LOOP
      v_call := q.calls -> i;
      v_res := p_results -> i;
      v_err := app.wizenet_call_error(v_res);
      IF v_err IS NOT NULL THEN
        v_state := 'failed';
        v_result := v_err;
        v_response := left(COALESCE(v_res ->> 'text', v_res ->> 'detail'), 2000);
        EXIT;
      END IF;
      v_items := app.wizenet_parse_lookup(v_res ->> 'text');
      IF jsonb_array_length(v_items) = 0 THEN
        v_state := 'failed';
        v_result := 'לא הצלחנו לקרוא את הרשימה מוויזנט';
        v_response := left(v_res ->> 'text', 2000);
        EXIT;
      END IF;
      v_lists := v_lists || jsonb_build_object(v_call ->> 'kind', v_items);
    END LOOP;
    IF v_state = 'done' THEN
      IF v_lists ? 'status' THEN v_ns := app.wizenet_lookups_store('status', v_lists -> 'status', q.requested_by); END IF;
      IF v_lists ? 'type' THEN v_nt := app.wizenet_lookups_store('type', v_lists -> 'type', q.requested_by); END IF;
      v_result := format('נטענו %s סטטוסים ו-%s סוגי קריאה', v_ns, v_nt);
      -- שם של סטטוס, וגם "סגור" של סטטוס חדש, משנים מה פתוח — המספרים בכרטיסים מתרעננים
      PERFORM app.record_write_event('*', 'service_calls',
        jsonb_build_object('type', 'service_calls', 'code', NULL, 'action', 'lookups'));
    END IF;
  END IF;

  UPDATE wizenet_requests w
     SET state = v_state, finished_at = now(), result = v_result, response = v_response
   WHERE w.id = q.id;
  RETURN jsonb_build_object('accepted', true, 'state', v_state, 'result', v_result);
END $fn$;
REVOKE ALL ON FUNCTION public.wizenet_complete(bigint, integer, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wizenet_complete(bigint, integer, jsonb) TO authenticated;

-- ============================================================
-- פעם ביום — רענון הרשימות, וגריפה
-- ============================================================
-- ⚠️ הרענון סוגר פער שהיה פתוח: סטטוס שוויזנט מוסיפים אינו ברשימה, ולכן נחשב "פתוח" — וכרטיס עם קריאה כזו
-- פועם לנצח (CLAUDE.md, "Does the pulse stop"). מעכשיו הוא נכנס לרשימה תוך יום, והשם שלו מוצג. "סגור" שלו —
-- עדיין ניחוש לפי השם, ובודקים אותו בעין.
-- ⚠️ בלי ממסר חי, או תור מלא — מדלגים בשקט: זו משימה מתוזמנת, ואין מי שיקרא את הסירוב. התור עצמו הוא שמסרב
-- (PT503 / PT429), ורק שני הסירובים האלה נבלעים כאן: "WHEN others" היה מסתיר גם באג אמיתי, והרענון היה מפסיק בלי
-- שאיש יידע. (בדיקת "ממסר חי" נפרדת כאן הייתה כפולה — מוטציה שהסירה אותה שרדה, כי התוצאה זהה.)
-- גריפה: 30 יום. הבקשות אינן היסטוריה של הקריאה (זו ב-service_call_changes) — הן יומן של הדרך לוויזנט.
CREATE OR REPLACE FUNCTION app.wizenet_daily() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS $fn$
BEGIN
  DELETE FROM wizenet_requests q WHERE q.created_at < now() - interval '30 days';
  BEGIN
    PERFORM app.wizenet_enqueue('lookups', NULL, NULL, NULL, app.wizenet_lookup_calls(), 'רענון יומי', NULL);
  EXCEPTION WHEN sqlstate 'PT503' OR sqlstate 'PT429' THEN
    NULL;   -- אין ממסר חי, או תור מלא — מחר
  END;
END $fn$;
REVOKE ALL ON FUNCTION app.wizenet_daily() FROM PUBLIC;
