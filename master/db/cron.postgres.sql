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
