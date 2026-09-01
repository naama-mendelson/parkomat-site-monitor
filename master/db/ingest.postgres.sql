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
