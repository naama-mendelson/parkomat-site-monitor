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
  v_key       text;
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
        PERFORM net.http_post(
          url     := 'https://xvfsikwaaaohnmldjbtv.supabase.co/functions/v1/notify-fault',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || current_setting('app.push_anon_key', true)),
          body    := jsonb_build_object(
            'site_id', 0, 'site_code', '—', 'site_name', 'מערכת הניטור',
            'kind', 'no_comm',
            'fault_text', 'השרת אינו מדווח על עצמו ' || round(v_age_min) || ' דקות — ייתכן שהקליטה מושבתת')
        );
        INSERT INTO settings (key, value, updated_at) VALUES ('alert_last_heartbeat', v_now, v_now)
          ON CONFLICT (key) DO UPDATE SET value = v_now, updated_at = v_now;
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
      PERFORM net.http_post(
        url     := 'https://xvfsikwaaaohnmldjbtv.supabase.co/functions/v1/notify-fault',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || current_setting('app.push_anon_key', true)),
        body    := jsonb_build_object(
          'site_id', 0, 'site_code', '—', 'site_name', 'מערכת הניטור',
          'kind', 'fault',
          'fault_text', v_drops || ' הודעות נזרקו בקליטה — ייתכן שמצב אתר אינו מעודכן')
      );
      INSERT INTO settings (key, value, updated_at) VALUES ('alert_last_drops', v_now, v_now)
        ON CONFLICT (key) DO UPDATE SET value = v_now, updated_at = v_now;
      RETURN QUERY SELECT 'drops'::text, (v_drops || ' הודעות')::text;
    END IF;
  END IF;
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
