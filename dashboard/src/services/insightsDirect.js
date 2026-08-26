// services/insightsDirect.js — התובנות המעמיקות ישירות מ-Supabase, בלי השרת.
//
// ============================================================
// אותה תבנית כמו activityDirect.js, ומאותה סיבה
// ============================================================
// computeInsights אינה הגדרת מדד אלא הצגה — ספי תצוגה, דירוג כרטיסים, דליים
// לפי שעה ויום. לכן היא נשארה JS ועברה ל-shared/insights.mjs, ו**אותה
// פונקציה בדיוק** רצה כאן ובשרת. אין פורט, ולכן אין סיכון שהחישוב יסטה.
//
// מה שכן יכול להישבר הוא מבנה השורות: PostgREST מחזיר עמודות בשמות הטבלה,
// והשרת שולף אותן דרך שאילתה משלו. tools/parity-insights.js בודק בדיוק את זה.
//
// ============================================================
// ⚠️ חלון המצבים שונה מחלון הפעולות — וזה לא רשלנות
// ============================================================
// הפעולות נשלפות בתוך הטווח (occurred_at >= from AND < to), אבל המצבים
// נשלפים לפי **חפיפה**: started_at < to AND (ended_at IS NULL OR ended_at > from).
//
// בלי זה, מקטע תקלה שהתחיל לפני תחילת החלון ועדיין נמשך בתוכו היה נעלם
// לגמרי — כלומר אתר שהיה מושבת כל השבוע היה מוצג בלי אף תקלה.
//
// ⚠️ ונשלפים **כל** המצבים ולא רק error/maintenance: קיפול הריצוד זקוק
// למקטעי ה-no_comm כדי לזהות `X → no_comm → X` כאירוע אחד. שליפה מסוננת
// הייתה מפרקת תקלה אחת לשלוש.

import { supabase, isSupabaseConfigured } from "./supabase";
import { computeInsights, collapseSegmentsBySite } from "../../../shared/insights.mjs";
// ⚠️ Supabase חוסם כל בקשה ב-1,000 שורות ומתעלם מ-limit. חובה לדפדף — ראה
// pageAll.js. הגרסה הראשונה כאן ביקשה limit(20000) וקיבלה 1,000 **בשקט**.
import { pageAll } from "./pageAll";

const FETCH_CAP = 20000;

/**
 * @param code קוד אתר, או null למצרף על כל האתרים
 * @returns אותו מבנה בדיוק ש-GET /api/insights מחזיר (ללא log)
 */
export async function fetchInsightsDirect(code, { from, to }) {
  if (!isSupabaseConfigured) {
    throw new Error("Supabase אינו מוגדר בדשבורד");
  }

  let siteId = null;
  if (code) {
    const { data, error } = await supabase.from("sites").select("id").eq("code", code).single();
    if (error) throw new Error(error.message);
    siteId = data.id;
  }
  const scoped = (q) => (siteId ? q.eq("site_id", siteId) : q);

  const [opsPage, segPage, winPage] = await Promise.all([
    pageAll((a, b) => scoped(
      supabase
        .from("operations")
        .select("site_id, start_end, entry_exit, card_number, is_anomaly, superseded_by, occurred_at, excluded_at")
        .gte("occurred_at", from).lt("occurred_at", to)
        .order("occurred_at", { ascending: true })
        .range(a, b)
    ), FETCH_CAP),

    pageAll((a, b) => scoped(
      supabase
        .from("status_history")
        // ⚠️ **COALESCE ועמודות הסימון — שניהם חסרו.** זרוע השרת
        // (queries.js:1146) עושה COALESCE(reclassified_to, status);
        // כאן נשלף status גולמי, ולכן תקלה שסווגה מחדש כתחזוקה עדיין
        // נספרת כתקלה בדפדפן ולא נספרת בשרת. אותה מחלקה בדיוק שתוקנה
        // ב-executiveDirect — התובנות פשוט לא תוקנו יחד איתה.
        .select("site_id, status, started_at, ended_at, excluded_at, reclassified_to")
        // חפיפה, לא הכלה — ראה ההסבר למעלה.
        .lt("started_at", to)
        .or(`ended_at.is.null,ended_at.gt.${from}`)
        .order("started_at", { ascending: true })
        .range(a, b)
    ), FETCH_CAP),

    pageAll((a, b) => scoped(
      supabase
        .from("maintenance_windows")
        // ⚠️ site_id ו-excluded_at דרושים ל-computeInsights: הכיסוי נבנה לכל אתר
        // בנפרד, וחלון שסומן כניסוי אינו מכסה דבר.
        .select("site_id, set_by_name, reason, started_at, duration_hours, cancelled_at, excluded_at")
        .gte("started_at", from).lt("started_at", to)
        .order("started_at", { ascending: true })
        .range(a, b)
    ), FETCH_CAP),
  ]);

  // מקפלים ריצוד לפני הספירה, ולכל אתר בנפרד: רשימה מעורבת הייתה מקפלת
  // מקטעים של אתרים שונים זה לתוך זה.
  // ⚠️ מקטע שסומן כניסוי מוסר **לפני** הקיפול, לא אחריו: הוא לא קרה, ולכן
  // הוא גם אינו מפריד בין שני מקטעים שכן קרו. בלי זה הוא נספר כאירוע השבתה
  // נוסף — בזמן שהזמינות כבר התעלמה ממנו לגמרי.
  const kept = segPage.rows.filter((s) => !s.excluded_at);
  const counted = collapseSegmentsBySite(kept);

  // ==========================================================
  // קטיעה חייבת להיאמר, לא להיבלע
  // ==========================================================
  // ⚠️ pageAll מחזיר capped כשהוא הגיע לתקרה ועדיין נשארו שורות — והערך
  // הזה **נזרק כאן**. תובנות שחושבו על חלק מהתקופה נראות בדיוק כמו תובנות
  // מלאות: "היום העמוס ביותר" עדיין מספר, "ממוצע יומי" עדיין מספר, ואין
  // שום סימן שהחישוב נעצר באמצע.
  //
  // זה גרוע יותר משגיאה. שגיאה עוצרת ומודיעה; מספר חלקי שנראה שלם מתגלה
  // רק כשמישהו משווה אותו למקור אחר, ואז שני המספרים מאבדים אמון.
  return {
    ...computeInsights({
      ops: opsPage.rows,
      errorRows: counted.filter((s) => s.status === "error"),
      maintRows: counted.filter((s) => s.status === "maintenance"),
      windows: winPage.rows,
      from, to,
      // ראה computeInsights: הזמן נסכם על המקטעים הגולמיים, לא המקופלים.
      allRows: kept,
    }),
    capped: opsPage.capped || segPage.capped || winPage.capped,
  };
}
