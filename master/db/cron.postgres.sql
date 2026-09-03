-- db/cron.postgres.sql — התחזוקה היומית, בתוך בסיס הנתונים.
--
-- ============================================================
-- למה זה עבר מה-master לכאן
-- ============================================================
-- התחזוקה רצה ב-`dailyMaintenance` שב-master.js, על טיימר של התהליך:
-- `setTimeout(10s)` בעלייה ואז `setInterval(24h)`. שלוש תוצאות שאף אחת
-- מהן אינה רצויה:
--
--   • **התזמון נדד.** כל הפעלה מחדש הריצה אותה מיד, והשעה נקבעה לפי
--     הרגע שבו הקונטיינר במקרה עלה.
--   • **שרת שמופעל מחדש בתדירות גבוהה מיממה לא הריץ אותה לעולם** בטיימר
--     של 24 השעות — רק בזה של העלייה.
--   • ⚠️ **ושרת שלמטה פשוט לא הריץ אותה.** ב-22.08 הוא היה למטה 14.7
--     שעות; אילו זה היה חופף לשעת הריצה, הניקוי לא היה קורה — בלי שום סימן.
--
-- כאן זו שעה קבועה בתוך Postgres, ואינה תלויה בשאלה אם השרת חי.
--
-- ============================================================
-- ⚠️ מה **לא** עבר, ולמה
-- ============================================================
-- **הגיבוי** — היה `console.log` ותו לא. הגיבוי המקומי הושבת במעבר
-- ל-Supabase, שמגבה בעצמו. נמחק ולא הועבר; אין מה להעביר.
--
-- **הסיכום החודשי** — נמחק ולא הועבר, וזו החלטה ולא השמטה. הטבלה
-- `monthly_summary` נקראת רק בשני נתיבי שרת רדומים שהדשבורד אינו קורא,
-- והיא **מתועדת כשגויה** (`report_monthly` הועבר ממנה לחישוב מהנתונים
-- החיים בדיוק בגלל זה: "יולי הראה 633 פעולות מול 806 בפועל"). ⚠️ נמדד
-- גם למה: היא חותכת חודשים לפי **שעון מקומי** בעוד כל השאר לפי UTC —
-- יולי 801 מול 806. העברת חישוב שגוי ל-SQL הייתה מקבעת אותו.
--
-- ============================================================
-- ⚠️ הרצה חוזרת בטוחה
-- ============================================================
-- שתי הפונקציות מוחקות לפי חתך זמן, ולכן הרצה כפולה אינה מזיקה. זה מה
-- שאיפשר להריץ אותן כאן **לצד** ה-master לפני שהוסרו משם, בלי חלון שבו
-- אחת מהן רצה פעמיים או אף פעם.

-- ============================================================
-- גריפת events — רטנציה של שבוע
-- ============================================================
-- ⚠️ **חייב להמשיך לרוץ.** הטבלה נועדה ל-replay אחרי ניתוק (דקות עד
-- שעות), לא להיסטוריה — וההיסטוריה האמיתית יושבת ב-status_history
-- וב-operations. בלי גריפה היא גדלה לנצח, ו-Supabase Realtime מנוי
-- עליה: טבלה שתופחת היא גם עלות אחסון וגם מנוי שנעשה כבד.
CREATE OR REPLACE FUNCTION app.prune_events(p_retention_days integer DEFAULT 7)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
DECLARE
  v_cutoff text;
  v_n integer;
BEGIN
  -- חתך כמחרוזת ISO — הפורמט שבו created_at נשמר. השוואה לקסיקלית
  -- שומרת על האינדקס, כמו בכל שאר הפונקציות כאן.
  v_cutoff := to_char((now() - make_interval(days => p_retention_days)) AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  DELETE FROM events WHERE created_at < v_cutoff;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- ============================================================
-- ניקוי נתונים גולמיים מעל שנה
-- ============================================================
-- ⚠️ 12 חודשים, אותו ערך בדיוק שהיה ב-cleanup-old-data.js. שינוי הערך
-- כאן הוא שינוי מדיניות שמירת נתונים, לא כוונון — ולכן הוא נשאר כפי שהיה.
--
-- ⚠️ **החתך הוא תחילת החודש, ולא "לפני 365 יום".** כך שומרים תמיד שנה
-- שלמה של חודשים מלאים, ולא זנב חלקי שמעוות דוחות חודשיים.
CREATE OR REPLACE FUNCTION app.cleanup_old_data(p_retention_months integer DEFAULT 12)
RETURNS TABLE (deleted_operations integer, deleted_status integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
DECLARE
  v_cutoff text;
  v_ops integer;
  v_st  integer;
BEGIN
  v_cutoff := to_char(date_trunc('month', now() AT TIME ZONE 'UTC')
                      - make_interval(months => p_retention_months), 'YYYY-MM-DD');

  DELETE FROM operations WHERE occurred_at < v_cutoff;
  GET DIAGNOSTICS v_ops = ROW_COUNT;

  -- ⚠️ רק מקטעים **סגורים**: מקטע פתוח הוא המצב הנוכחי של האתר, וגילו
  -- אינו מעיד על כלום. מחיקתו הייתה מוחקת את המצב החי של אתר שקט.
  DELETE FROM status_history WHERE ended_at IS NOT NULL AND ended_at < v_cutoff;
  GET DIAGNOSTICS v_st = ROW_COUNT;

  RETURN QUERY SELECT v_ops, v_st;
END;
$$;

-- ============================================================
-- לוח הזמנים
-- ============================================================
-- ⚠️ **בקובץ SQL ולא בממשק של Supabase** — כלל 6 ב-CLAUDE.md הראשי.
-- תזמון שקיים רק בממשק אינו נוסע ב-pg_dump, ואינו קיים בגיט: ביום
-- שמקימים מופע חדש הוא פשוט לא שם, ואיש לא יודע שחסר.
--
-- 03:17 UTC ולא 03:00: שעה עגולה היא הרגע שבו כל עבודה מתוזמנת בעולם
-- רצה יחד. שבע-עשרה דקות אחריה זה שקט.
--
-- unschedule לפני schedule — אחרת הרצה חוזרת של הקובץ מייצרת כפילויות.
DO $$
BEGIN
  PERFORM cron.unschedule('parkomat-prune-events');
EXCEPTION WHEN OTHERS THEN NULL;
END
$$;

DO $$
BEGIN
  PERFORM cron.unschedule('parkomat-cleanup-old');
EXCEPTION WHEN OTHERS THEN NULL;
END
$$;

SELECT cron.schedule('parkomat-prune-events', '17 3 * * *', 'SELECT app.prune_events(7)');
SELECT cron.schedule('parkomat-cleanup-old',  '37 3 * * *', 'SELECT app.cleanup_old_data(12)');

-- ============================================================
-- גריפת ingest_drops — רטנציה של 14 יום
-- ============================================================
-- ⚠️ ארוך יותר מ-`events` (שבוע) ובכוונה: זו טבלת אבחון, והשאלה שנשאלת
-- ממנה היא "מה נזרק אצל אתר X בשבוע שעבר". רטנציה של שבוע הייתה מוחקת את
-- התשובה בדיוק כשמישהו מתחיל לחפש אותה — וזה מה שקרה עם לוג הקונטיינר.
CREATE OR REPLACE FUNCTION app.prune_ingest_drops(p_retention_days integer DEFAULT 14)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $$
DECLARE
  v_cutoff text;
  v_n integer;
BEGIN
  v_cutoff := to_char((now() - make_interval(days => p_retention_days)) AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  DELETE FROM ingest_drops WHERE at < v_cutoff;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

DO $$
BEGIN
  PERFORM cron.unschedule('parkomat-prune-ingest-drops');
EXCEPTION WHEN OTHERS THEN NULL;
END
$$;

SELECT cron.schedule('parkomat-prune-ingest-drops', '47 3 * * *', 'SELECT app.prune_ingest_drops(14)');

-- ============================================================
-- שומר הקליטה — ההתראה שהייתה חוסכת יום שלם
-- ============================================================
-- ב-22.08 השרת היה למטה 14.7 שעות. ב-23.08 אתר היה בתקלה שלוש שעות והמסך
-- הראה "בפעולה". בשני המקרים לא אבד נתון — אבד **הזמן עד שמישהו ידע**.
--
-- ============================================================
-- ⚠️ למה **לא** מתריעים על שתיקה, למרות שזה המתבקש
-- ============================================================
-- נמדד על שבוע נתונים אמיתי, ושתי המדידות שללו את התכנון הראשון:
--
--   • **פער p95 לכל אתר: 5 עד 40 שעות.** הסוכן משדר רק ב**שינוי** MODE,
--     ולכן חניון שקט בלילה מייצר אפס הודעות. כל סף שהיה תופס את 1284
--     בשלוש שעות היה מצייץ על אתרים תקינים לחלוטין.
--   • **גם גלובלית זה לא עבד:** בשבוע אחד היו 5 פערים מעל 3 שעות ו-8
--     מעל שעתיים — לילות וסופי שבוע. סף כזה מלמד להתעלם ממנו תוך ימים.
--
-- ============================================================
-- ⚠️ ולכן שני אותות **ודאיים** במקום אחד סטטיסטי
-- ============================================================
--   1. **גיל אות החיים.** השרת כותב שורה על עצמו כל 20 שניות, **בלי קשר
--      לתנועה**. שקט בלילה אינו משפיע עליו — ולכן זהו האות היחיד שמבחין
--      בין "אין מה לדווח" לבין "אין מי שידווח".
--   2. **שורות ב-ingest_drops.** הודעה שנזרקה היא **אירוע**, לא היעדר
--      אירוע. אפס התראות שווא, ובדיוק המקרה של 23.08.
--
-- ⚠️ **וזה חייב לרוץ ב-Postgres ולא ב-master.** שומר שיושב בתוך התהליך
-- שהוא בא לשמור עליו מת יחד איתו — וזה בדיוק המצב שבו הוא נחוץ.
-- ============================================================
-- שליחת התראה — ובעיקר, כישלון שמכריז על עצמו
-- ============================================================
-- ⚠️ **הגרסה הקודמת שתקה במשך חודשים.** הכותרת נבנתה כך:
--
--     'Bearer ' || current_setting('app.push_anon_key', true)
--
-- וב-SQL, שרשור עם NULL הוא NULL — לא 'Bearer '. ההגדרה מעולם לא
-- נקבעה, ולכן **כל הכותרת נעלמה** ו-Supabase החזיר:
--
--     {"code":"UNAUTHORIZED_NO_AUTH_HEADER"}
--
-- נמדד ב-net._http_response: 401 בכל קריאה. השומר ירה נאמנה כל עשר
-- דקות במשך נפילה של 2.5 ימים, ואיש לא ידע.
--
-- ⚠️ וה-true השני ב-current_setting אומר "אל תזרוק אם חסר" — כלומר
-- **המערכת תוכננה לשתוק** כשההגדרה חסרה. זה השורש, ולא המפתח החסר:
-- הגדרה חסרה חייבת להיות רועשת, אחרת היא מתגלה רק באסון.
--
-- לכן כאן: מפתח חסר מייצר WARNING **וגם** שורה ב-settings שאפשר לשאול
-- עליה, והפונקציה מחזירה NULL כדי שהקורא יידע שלא נשלח כלום.
CREATE OR REPLACE FUNCTION app.send_push(
  p_kind       text,
  p_site_name  text,
  p_fault_text text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $push$
DECLARE
  -- ============================================================
  -- ⚠️ המפתח יושב ב-settings, לא ב-GUC — וזה לא סגנון
  -- ============================================================
  -- הניסיון הראשון היה `ALTER DATABASE ... SET app.push_anon_key`.
  -- Supabase דוחה אותו: **permission denied to set parameter**. התפקיד
  -- `postgres` שם אינו superuser.
  --
  -- ⚠️ ושורה ב-settings היא גם הפתרון הנכון יותר: היא **נוסעת
  -- ב-pg_dump**, בעוד ש-GUC ברמת המסד נשאר מאחור. כלומר ביום שנצא
  -- מ-Supabase ההתראות ימשיכו לעבוד, במקום להישבר בשקט.
  --
  -- ⚠️ והמפתח הזה הוא ה-publishable — הוא נשלח לכל דפדפן בכל טעינה
  -- של הדשבורד. אין כאן סוד ש-settings חושפת.
  --
  -- ה-GUC נשאר כנפילה־לאחור, למקרה שמישהו כן הגדיר אותו.
  v_key text := coalesce(
    (SELECT value FROM settings WHERE key = 'push_anon_key'),
    current_setting('app.push_anon_key', true));
  v_req bigint;
  v_now text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  -- ⚠️ coalesce ואז השוואה למחרוזת ריקה: גם NULL וגם '' הם "אין מפתח",
  -- ו-'' היה עובר בדיקת IS NOT NULL ושולח 'Bearer ' ריק — כלומר אותו
  -- כשל בדיוק, בתחפושת אחרת.
  IF coalesce(v_key, '') = '' THEN
    INSERT INTO settings (key, value, updated_at)
    VALUES ('alert_last_error', 'app.push_anon_key אינו מוגדר — התראות אינן נשלחות', v_now)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;
    RAISE WARNING 'app.send_push: app.push_anon_key אינו מוגדר — ההתראה לא נשלחה';
    RETURN NULL;
  END IF;

  SELECT net.http_post(
    url     := 'https://xvfsikwaaaohnmldjbtv.supabase.co/functions/v1/notify-fault',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key),
    body    := jsonb_build_object(
      'site_id', 0, 'site_code', '—', 'site_name', p_site_name,
      'kind', p_kind, 'fault_text', p_fault_text)
  ) INTO v_req;

  -- ⚠️ מזהה הבקשה נשמר כדי שאפשר יהיה לשאול **אחר כך** מה חזר.
  -- pg_net אסינכרוני: הצלחת ה-POST כאן אינה אומרת שהצד השני קיבל,
  -- וזו בדיוק הסיבה שהכשל הקודם היה בלתי נראה.
  INSERT INTO settings (key, value, updated_at)
  VALUES ('alert_last_request', v_req::text, v_now)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;

  RETURN v_req;
END;
$push$;

-- ============================================================
-- האם ההתראות באמת עובדות — שאלה שאפשר לשאול
-- ============================================================
-- ⚠️ בלי הפונקציה הזו אין דרך לדעת. "נשלחה בקשה" ו"ההתראה הגיעה" הם
-- שני דברים שונים, ובמשך חודשים ההבדל ביניהם היה בלתי נראה: pg_net
-- אסינכרוני, אז הכשל חוזר לטבלה ולא לקורא.
--
-- מחזירה שורה אחת: האם המפתח קיים, מה חזר בבקשה האחרונה, וכמה מנויים
-- בכלל רשומים — כי התראה תקינה שאין לה נמען היא עדיין שתיקה.
CREATE OR REPLACE FUNCTION app.alert_health()
RETURNS TABLE (
  key_present     boolean,
  subscribers     integer,
  last_request_id bigint,
  last_status     integer,
  last_at         timestamptz,
  last_error      text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, net, pg_temp
AS $health$
DECLARE
  v_req bigint;
BEGIN
  SELECT value::bigint INTO v_req FROM settings WHERE key = 'alert_last_request';

  RETURN QUERY
  SELECT
    coalesce((SELECT value FROM settings WHERE key = 'push_anon_key'),
             current_setting('app.push_anon_key', true), '') <> '',
    (SELECT COUNT(*)::int FROM push_subscriptions),
    v_req,
    (SELECT r.status_code FROM net._http_response r WHERE r.id = v_req),
    (SELECT r.created    FROM net._http_response r WHERE r.id = v_req),
    (SELECT s.value      FROM settings s WHERE s.key = 'alert_last_error');
END;
$health$;

-- ============================================================
-- app.mark_silent_agents — אתר שהפסיק לומר "אני חי"
-- ============================================================
-- ⚠️ **זה מה שמחליף את הצוואה של MQTT.** היום, כשמחשב באתר מת, HiveMQ
-- מפרסם את הצוואה של הגשר ו-master מתרגם אותה ל-`no_comm`. ברגע
-- ש-master יורד אין מי שיאזין — הגשר עדיין יפרסם, ואיש לא ישמע.
--
-- ⚠️ ואי אפשר לזהות היעדר בלי אחד משניים: חיבור מוחזק שמישהו מבחין
-- שנפל, או צד שמדבר בקביעות ומישהו מבחין בשתיקתו. הצוואה של MQTT היא
-- **השנייה** — הברוקר סופר PINGREQ שלא הגיע (keepalive 60 שניות, וכלל
-- 90 השניות הוא 1.5 × זה). כאן אותו מנגנון בדיוק, רק שהשעון אצלנו.
--
-- ⚠️ **ורק אתרים שיש להם סוכן עם זהות.** אתר שעדיין על MQTT בלבד לעולם
-- לא יכתוב לטבלת `alive`, וסריקה תמימה הייתה מסמנת את כל 16 האתרים
-- כמתים ברגע שהיא נדלקת. הסימן הוא שורת `app_users` עם role='agent' —
-- כלומר "אתר שאנחנו מצפים ממנו לדופק" מוגדר על ידי מה שהוקם בפועל,
-- ולא ברשימה שצריך לתחזק.
CREATE OR REPLACE FUNCTION app.mark_silent_agents(
  p_stale_minutes integer DEFAULT 3
)
RETURNS TABLE (site_code text, quiet_minutes integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_now text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  RETURN QUERY
  WITH expected AS (
    -- אתרים שיש להם סוכן פעיל עם זהות, ושכבר דיברו לפחות פעם אחת.
    -- ⚠️ **`LEFT JOIN` ותנאי `IS NOT NULL`, ולא `JOIN` פשוט.** סוכן שהוקם
    -- ועוד לא נפרס אין לו שורה ב-`alive` כלל, והיעדר שורה **אינו** "מת" —
    -- התראה עליו היא רעש על התקנה שטרם קרתה. `JOIN` היה מסנן אותו בשקט,
    -- וזו התנהגות נכונה שנשענת על מקריות: ביום שמישהו יוסיף שורת ברירת
    -- מחדל בהרשמת אתר, כל אתר חדש היה נדלק אדום ברגע ההרשמה.
    SELECT s.id, s.code, s.status, a.seen_at
      FROM sites s
      JOIN app_users u ON u.site_id = s.id AND u.role = 'agent' AND u.is_active
      LEFT JOIN alive a ON a.site_id = s.id
     WHERE a.seen_at IS NOT NULL
  ), silent AS (
    SELECT e.id, e.code,
           (EXTRACT(EPOCH FROM (now() - e.seen_at)) / 60)::integer AS quiet
      FROM expected e
     WHERE e.seen_at < now() - make_interval(mins => p_stale_minutes)
       -- ⚠️ **הגנה בעומק, ולא ההגנה — וזה נמדד.** כתבתי כאן שהתנאי הוא
       -- מה שמונע מקטע נתק חדש בכל סריקה. מוטציה הראתה אחרת: הסרתו
       -- השאירה את השער ירוק, כי `app.ingest_state` **כבר** מחזיר
       -- `no_change` כששולחים לו את המצב הקיים, ואינו פותח מקטע.
       --
       -- התנאי נשאר כי הוא חוסך קריאה מיותרת בכל סריקה על כל אתר מנותק,
       -- אבל מי ששומר על הזמינות הוא שומר האי-שינוי שם. תיאור לא מדויק
       -- של מי מגן על מה הוא בדיוק איך שמישהו מוחק את ההגנה האמיתית.
       AND e.status <> 'no_comm'
       -- ⚠️ ותחזוקה גוברת. אתר שמישהו הכניס לתחזוקה אמור להיות שקט.
       AND e.status <> 'maintenance'
  )
  SELECT s.code, s.quiet FROM silent s;

  -- ============================================================
  -- ⚠️ הסימון עובר ב-ingest_state ולא ב-UPDATE ישיר
  -- ============================================================
  -- שם יושבים כל הכללים: סגירת המקטע הפתוח, פתיחת החדש, שמירת
  -- `last_seen` (ש-`no_comm` **אינו** מעדכן — נתק אינו סימן חיים),
  -- והאירוע ל-`events`. UPDATE ישיר על `sites.status` היה משנה את הצ'יפ
  -- על המסך ומשאיר את ההיסטוריה בלי המקטע — כלומר זמינות שלא יודעת
  -- שהאתר היה מנותק.
  PERFORM app.ingest_state(e.id, 'no_comm', v_now, NULL)
     FROM sites e
     JOIN app_users u ON u.site_id = e.id AND u.role = 'agent' AND u.is_active
     JOIN alive a     ON a.site_id = e.id
    WHERE a.seen_at < now() - make_interval(mins => p_stale_minutes)
      AND e.status NOT IN ('no_comm', 'maintenance');
END;
$fn$;

REVOKE ALL ON FUNCTION app.mark_silent_agents(integer) FROM PUBLIC;


-- ============================================================
-- app.detect_blackout — האם המערכת כולה חשוכה
-- ============================================================
-- ⚠️ **הכלל הזה נגזר ממדידה, לא מהערכה.** נמדד על 30 יום:
--
--   • שתיקה של אתר **בודד** אינה סימן: ההפסקה המקסימלית לאתר היא
--     61–68 שעות ברוטינה, כי הסוכן משדר רק על שינוי MODE ואלה חניונים
--     בלילות ובסופי שבוע. סף שימנע רעש ארוך מהתקלה שמחפשים.
--
--   • "אפס אתרים משדרים" לבדו אינו סימן: זה המצב **33% מהזמן**.
--
--   • אבל **אורך הרצף** מפריד נקי. שלושת הרצפים הארוכים ביותר היו
--     115.0, 59.5 ו-17.0 שעות — כולם נפילות אמיתיות. הרביעי כבר
--     4.0 שעות, שהוא לילה רגיל. בין 4 ל-17 אין כלום.
--
-- שני כללים, ולכל אחד תפקיד אחר:
--
--   איטי  — אפס אתרים מעל p_slow_hours (ברירת מחדל 6). תמיד פעיל,
--           מרווח של 50% מעל הלילה הארוך ביותר שנמדד.
--
--   מהיר  — 43 מתוך 168 שעות-בשבוע **מעולם** לא היו בהן אפס אתרים
--           ב-4 שבועות, וב-30 מהן המינימום היה ≥3. בשעה כזו, שעה של
--           שתיקה מוחלטת היא חסרת תקדים. משהה ~שעה, מכסה ~30 שעות בשבוע.
--
-- ⚠️ **ומה זה לא תופס, במפורש:** אתר **בודד** שמת. את זה רק צוואה
-- (MQTT היום) או דופק תופסים. זו סיבה טובה לא למהר לפרוש את HiveMQ.
--
-- ⚠️ p_at קיים כדי שאפשר יהיה להריץ את הכלל על **רגע היסטורי** ולבדוק
-- מה הוא היה אומר. כלל שלא נבחן על נפילה אמיתית הוא ניחוש.
CREATE OR REPLACE FUNCTION app.detect_blackout(
  p_at             timestamptz DEFAULT now(),
  p_slow_hours     numeric     DEFAULT 6,
  p_fast_min_sites integer     DEFAULT 0   -- 0 = הכלל המהיר כבוי
)
RETURNS TABLE (kind text, quiet_hours numeric, detail text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_last   timestamptz;
  v_quiet  numeric;
  v_solid  integer;
BEGIN
  -- ⚠️ שני המקורות, לא אחד: אתר יכול לדווח מצב בלי אף תפעול (לילה עם
  -- מעבר ל-ready), ותפעול בלי שינוי מצב. שתיקה היא היעדר **שניהם**.
  SELECT GREATEST(
           (SELECT MAX(received_at::timestamptz) FROM operations
             WHERE received_at < to_char(p_at, 'YYYY-MM-DD"T"HH24:MI:SS')),
           (SELECT MAX(started_at::timestamptz) FROM status_history
             WHERE started_at < to_char(p_at, 'YYYY-MM-DD"T"HH24:MI:SS')))
    INTO v_last;

  IF v_last IS NULL THEN RETURN; END IF;
  v_quiet := ROUND((EXTRACT(EPOCH FROM (p_at - v_last)) / 3600)::numeric, 1);

  -- ---- הכלל האיטי ----
  IF v_quiet >= p_slow_hours THEN
    RETURN QUERY SELECT 'blackout'::text, v_quiet,
      ('אף אתר לא שידר ' || v_quiet || ' שעות')::text;
    RETURN;
  END IF;

  -- ---- הכלל המהיר ----
  -- ⚠️ הבסיס נלקח מ-28 הימים שלפני p_at, ולכן נפילה **ארוכה** מנמיכה
  -- אותו בעצמה. זה מקובל: המהיר נועד לתפוס את השעה הראשונה, ובנקודה
  -- הזו הבסיס עדיין נקי. אחרי זה האיטי תופס ממילא.
  -- ⚠️ **הרשת חייבת לכלול שעות עם אפס — וזה היה באג.** הגרסה הראשונה
  -- עשתה MIN על תוצאת GROUP BY של האירועים עצמם, ושעה בלי אף אירוע
  -- אינה מייצרת שורה. כלומר המינימום רץ רק על השעות שכן היו בהן נתונים
  -- ולעולם לא היה 0.
  --
  -- ⚠️ **וזה נתפס בבדיקה על ההיסטוריה, לא בקריאה:** הכלל התריע ב-03:00
  -- בארבעה לילות רגילים וטען ש"תמיד משדרים כאן ≥5 אתרים" — על שלוש
  -- לפנות בוקר. כלל שמסתמך על בסיס שאינו יכול להיות אפס יתריע בדיוק
  -- בשעות השקטות, שהן בדיוק אלה שהוא אמור לפטור.
  -- ⚠️ **ולא MIN, אלא "כמה מהשבועות" — כי MIN אינו עמיד.**
  -- נמדד: אחרי תיקון הרשת, MIN התאפס כמעט בכל שעה-בשבוע והכלל המהיר
  -- חדל לירות. הסיבה אינה שהשעות רועשות — היא ש**בחלון של 4 שבועות
  -- היו שלוש נפילות**, וכל אחת מאפסת את המינימום של השעות שהיא כיסתה.
  -- סטטיסטיקה שנפילה אחת הורסת אינה בסיס להשוואה מול נפילות.
  SELECT COUNT(*) FILTER (WHERE cnt >= p_fast_min_sites) INTO v_solid FROM (
    SELECT g.h, (
      SELECT COUNT(DISTINCT e.site_id) FROM (
        SELECT site_id, received_at::timestamptz AS t FROM operations
         WHERE received_at >= to_char(p_at - interval '28 days', 'YYYY-MM-DD"T"HH24:MI:SS')
           AND received_at <  to_char(p_at - interval '1 hour',  'YYYY-MM-DD"T"HH24:MI:SS')
        UNION ALL
        SELECT site_id, started_at::timestamptz FROM status_history
         WHERE started_at >= to_char(p_at - interval '28 days', 'YYYY-MM-DD"T"HH24:MI:SS')
           AND started_at <  to_char(p_at - interval '1 hour',  'YYYY-MM-DD"T"HH24:MI:SS')
      ) e WHERE e.t >= g.h AND e.t < g.h + interval '1 hour') AS cnt
      FROM generate_series(date_trunc('hour', p_at - interval '28 days'),
                           date_trunc('hour', p_at - interval '1 hour'),
                           interval '1 hour') AS g(h)
     WHERE EXTRACT(DOW  FROM g.h) = EXTRACT(DOW  FROM p_at)
       AND EXTRACT(HOUR FROM g.h) = EXTRACT(HOUR FROM p_at)
  ) z;

  -- ⚠️ 3 מתוך 4 השבועות, ולא 4 מתוך 4: נפילה אחת בהיסטוריה לא תשתיק
  -- את הכלל, אבל שעה שבאמת שקטה לפעמים כן תפטור אותו.
  -- ⚠️ **והוא כבוי כברירת מחדל (p_fast_min_sites = 0), וזו מסקנה
  -- ממדידה ולא זהירות.** נבחן על ההיסטוריה: הוא אכן מקדים את הזיהוי
  -- של נפילת DELL008 מ-5 שעות ל-2 — ומייצר גם שתי התראות ב-**03:00**
  -- בלילות רגילים. התראה שגויה בשלוש לפנות בוקר היא בדיוק זו שמלמדת
  -- אנשים להשתיק, ואז גם הנכונה הבאה מושתקת.
  --
  -- ⚠️ והסיבה העמוקה: **אין חלון היסטורי נקי לכייל מולו.** ב-4 השבועות
  -- שנמדדו היו שלוש נפילות רב-יומיות. כלל של שעה אחת דורש בסיס נקי,
  -- והבסיס עצמו מלא בחורים. כשיצטבר חודש בלי נפילה — להעביר 3 ולבחון שוב.
  IF p_fast_min_sites > 0 AND v_solid >= 3 AND v_quiet >= 1 THEN
    RETURN QUERY SELECT 'blackout_fast'::text, v_quiet,
      ('שעה שב-' || v_solid || ' מתוך 4 השבועות שידרו בה לפחות ' ||
       p_fast_min_sites || ' אתרים — וכעת אף אחד, ' || v_quiet || ' שעות')::text;
  END IF;
END;
$fn$;

REVOKE ALL ON FUNCTION app.detect_blackout(timestamptz, numeric, integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.check_ingestion_health(
  p_heartbeat_stale_minutes integer DEFAULT 10,
  p_drop_window_minutes     integer DEFAULT 15
)
RETURNS TABLE (alerted text, detail text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, app, pg_temp
AS $fn$
DECLARE
  v_beat      text;
  v_age_min   numeric;
  v_drops     integer;
  v_last      text;
  v_now       text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  -- ⚠️ v_key הוכרז כאן ומעולם לא שימש. במקומו: מזהה הבקשה, שהוא מה
  -- שמבדיל בין "נשלח" ל"נחסם" — ההבחנה שכל התיקון הזה עומד עליה.
  v_req       bigint;
  v_blk       record;
BEGIN
  -- ============================================================
  -- 1. השרת חדל לדווח על עצמו
  -- ============================================================
  SELECT value INTO v_beat FROM settings WHERE key = 'server_heartbeat';

  -- ⚠️ NULL אינו "מת": שרת שטרם נפרס עם התכונה לא כתב מעולם, והתראה עליו
  -- הייתה מצייצת על מערכת תקינה — כלומר בדיוק ההתראה שמלמדת להתעלם.
  IF v_beat IS NOT NULL THEN
    v_age_min := EXTRACT(EPOCH FROM (now() - v_beat::timestamptz)) / 60;

    IF v_age_min > p_heartbeat_stale_minutes THEN
      -- ⚠️ דה-דופ: בלעדיו ההתראה חוזרת בכל הרצה, וטלפון שמצייץ כל עשר
      -- דקות כל הלילה הוא טלפון שמשתיקים — ואז גם ההתראה הבאה תושתק.
      SELECT value INTO v_last FROM settings WHERE key = 'alert_last_heartbeat';
      IF v_last IS NULL OR EXTRACT(EPOCH FROM (now() - v_last::timestamptz)) / 60 > 60 THEN
        v_req := app.send_push(
          'no_comm', 'מערכת הניטור',
          'השרת אינו מדווח על עצמו ' || round(v_age_min) || ' דקות — ייתכן שהקליטה מושבתת');

        -- ============================================================
        -- ⚠️ הדה-דופ נרשם רק אם באמת נשלח משהו
        -- ============================================================
        -- קודם הוא נרשם תמיד. כלומר כישלון שליחה **השתיק את ההתראה
        -- לשעה** — המנגנון שנועד למנוע רעש הפך למנגנון שמסתיר כשל.
        -- זה מה שהפך 401 חוזר לשתיקה מוחלטת במקום לניסיון כל עשר דקות.
        IF v_req IS NOT NULL THEN
          INSERT INTO settings (key, value, updated_at) VALUES ('alert_last_heartbeat', v_now, v_now)
            ON CONFLICT (key) DO UPDATE SET value = v_now, updated_at = v_now;
        END IF;
        RETURN QUERY SELECT 'heartbeat_stale'::text, (round(v_age_min) || ' דקות')::text;
      END IF;
    END IF;
  END IF;

  -- ============================================================
  -- 2. הודעות נזרקו בקליטה
  -- ============================================================
  -- ⚠️ **המקרה של 23.08 בדיוק.** אתר אחד הפסיק להיקלט בזמן שאחרים זרמו,
  -- ושום מנגנון לא התלונן. שורה ב-ingest_drops היא ראיה חד-משמעית.
  SELECT COUNT(*)::int INTO v_drops FROM ingest_drops
   WHERE at > to_char((now() - make_interval(mins => p_drop_window_minutes)) AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
     -- ============================================================
     -- ⚠️ רשימה ולא סיבה אחת — השומר צעק זאב כל שעה
     -- ============================================================
     -- כאן סוננה סיבה **אחת** בלבד. בפועל נמדד ב-24 שעות:
     --
     --     bridge_site_not_registered   29   ← התריע
     --     no_comm_rejected             11   ← התריע
     --     unknown_topic                 3   ← התריע
     --     site_not_registered           2   ← מסונן
     --
     -- כלומר ההתראה ירתה כל שעה על מכשירים שאינם שלנו ועל דחיות
     -- שהמערכת עשתה **נכון** — וכל זה קבר את האות היחיד שחשוב:
     -- הודעה שבאמת אבדה.
     --
     -- שתי משפחות שקטות, ולכל אחת נימוק אחר:
     --   • *_not_registered / unknown_topic — מכשיר שאינו שלנו משדר.
     --     זו משימה בשטח (לכבות אותו), לא תקלה בקליטה.
     --   • *_rejected — הקליטה **דחתה נכון**: צוואה מאוחרת שהייתה
     --     דורסת מצב טרי. התראה על הגנה שעבדה היא התראה על הצלחה.
     --
     -- ⚠️ רשימת **שקטים** ולא רשימת רועשים, ובכוונה: סיבה חדשה שתתווסף
     -- בעתיד תתריע כברירת מחדל. עדיף רעש שמתקנים מאשר אובדן שקט —
     -- זו אותה הכרעה שחוזרת בכל הקובץ הזה.
     AND reason NOT IN (
       'site_not_registered',
       'bridge_site_not_registered',
       'unknown_topic',
       'no_comm_rejected',
       'bridge_disconnect_rejected'
     );

  IF v_drops > 0 THEN
    SELECT value INTO v_last FROM settings WHERE key = 'alert_last_drops';
    IF v_last IS NULL OR EXTRACT(EPOCH FROM (now() - v_last::timestamptz)) / 60 > 60 THEN
      v_req := app.send_push(
        'fault', 'מערכת הניטור',
        v_drops || ' הודעות נזרקו בקליטה — ייתכן שמצב אתר אינו מעודכן');

      -- ⚠️ אותו נימוק כמו למעלה: אין שליחה, אין השתקה.
      IF v_req IS NOT NULL THEN
        INSERT INTO settings (key, value, updated_at) VALUES ('alert_last_drops', v_now, v_now)
          ON CONFLICT (key) DO UPDATE SET value = v_now, updated_at = v_now;
      END IF;
      RETURN QUERY SELECT 'drops'::text, (v_drops || ' הודעות')::text;
    END IF;
  END IF;

  -- ============================================================
  -- 3. המערכת כולה חשוכה
  -- ============================================================
  -- ⚠️ **שתי הנפילות הרב-יומיות לא נתפסו ע"י אף אחד משני הסעיפים
  -- שמעליי**, ולכן הסעיף הזה קיים. סעיף 1 בודק את הדופק של השרת —
  -- ושרת שאינו רץ אינו כותב דופק **וגם אינו מריץ שום בדיקה**; מי
  -- שמריץ כאן הוא pg_cron, בתוך Postgres, ולכן הוא שורד את נפילת
  -- ה-master. סעיף 2 בודק זריקות, ובנפילה אין הודעות שייזרקו.
  --
  -- נבחן על ההיסטוריה: תפס את שלוש הנפילות (6, 5 ו-8.8 שעות), עם
  -- אפס התראות שווא ב-80 בדיקות בזמנים תקינים.
  FOR v_blk IN SELECT * FROM app.detect_blackout() LOOP
    SELECT value INTO v_last FROM settings WHERE key = 'alert_last_blackout';
    -- ⚠️ דה-דופ של 6 שעות ולא שעה: נפילה נמשכת, וההתראה עליה חוזרת
    -- בכל הרצה. שעה הייתה מייצרת 60 התראות על נפילה בת יומיים וחצי.
    IF v_last IS NULL OR EXTRACT(EPOCH FROM (now() - v_last::timestamptz)) / 3600 > 6 THEN
      v_req := app.send_push('no_comm', 'מערכת הניטור', v_blk.detail);
      IF v_req IS NOT NULL THEN
        INSERT INTO settings (key, value, updated_at) VALUES ('alert_last_blackout', v_now, v_now)
          ON CONFLICT (key) DO UPDATE SET value = v_now, updated_at = v_now;
      END IF;
      RETURN QUERY SELECT v_blk.kind, v_blk.detail;
    END IF;
  END LOOP;

END;
$fn$;

DO $$
BEGIN
  PERFORM cron.unschedule('parkomat-ingestion-health');
EXCEPTION WHEN OTHERS THEN NULL;
END
$$;

-- כל 10 דקות. ⚠️ לא כל דקה: ההתראה נמדדת בשעות, ובדיקה תכופה רק מגדילה
-- את הסיכוי שריצה תיפול על עומס חולף ותצייץ סתם.
SELECT cron.schedule('parkomat-ingestion-health', '*/10 * * * *',
                     'SELECT app.check_ingestion_health(10, 15)');

-- ============================================================
-- ⚠️ סריקת השתיקה — משימה נפרדת, וכל דקה
-- ============================================================
-- היא **הייתה** סעיף רביעי בתוך `check_ingestion_health`, והוצאה משם.
-- הסיבה אינה סדר: שתי הבדיקות מודדות בשני שעונים שונים לגמרי.
-- `check_ingestion_health` שואלת "האם הקליטה זורמת" ונמדדת ב**שעות**;
-- כאן שואלים "האם הסוכן הזה חי" ונמדד ב**דקות**. משימה אחת נאלצת לרוץ
-- בקצב של הצורך המהיר יותר, כלומר להריץ פי עשרה גם את הבדיקה שאין לה
-- שום סיבה לרוץ כל דקה.
--
-- ⚠️ **הקצב הוא ההכרעה כאן, והוא נגזר משלושה מספרים:**
--   פעימה כל 60 שניות · סף 3 דקות · סריקה כל דקה  →  זיהוי 3–4 דקות.
--
-- 60 שניות אינו מספר שרירותי — זה **בדיוק** ה-`keepalive_interval` של
-- MQTT היום, ו"כלל 90 השניות" הוא 1.5 × אותו מספר. כלומר המערכת כבר
-- שולחת פעימה לכל אתר כל דקה, וההעברה ל-HTTPS **אינה מוסיפה סקר** —
-- היא מזיזה את השעון מ-HiveMQ ל-`pg_cron`. הסף 3 דקות הוא שלוש פעימות
-- שהוחמצו, ולא אחת: פעימה בודדת שנפלה על גמגום רשת אינה אתר מת.
--
-- ⚠️ **המחיר, במפורש:** 18 אתרים × 1,440 פעימות ביום = 25,920 בקשות,
-- כ-0.9GB לחודש — כ-18% מרוחב הפס החינמי. לשם השוואה, מה שנתבקש
-- (כל 2 שניות) הוא 777,600 בקשות ו-26.7GB, פי 5.3 מכל המכסה — ובלי
-- תמורה, כי זמן הזיהוי נקבע ע"י הסריקה ולא ע"י הפעימה.
--
-- ⚠️ **ואין כאן התראת push, בכוונה:** הסימון עצמו מפיק אירוע ב-`events`,
-- ומשם רצה שרשרת ההתראות הרגילה של תקלה. התראה שנייה מכאן הייתה שולחת
-- שתי הודעות על אותו אירוע.
DO $$
BEGIN
  PERFORM cron.unschedule('parkomat-agent-silence');
EXCEPTION WHEN OTHERS THEN NULL;
END
$$;

SELECT cron.schedule('parkomat-agent-silence', '* * * * *',
                     'SELECT app.mark_silent_agents(3)');
