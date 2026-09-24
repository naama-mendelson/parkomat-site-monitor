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
import { fetchRowsChunked } from "./rowsChunked";

// ⚠️ **אין תקרה.** עד 24/09/2026 השורות נשלפו בדפדוף (PostgREST חותך כל
// תשובה ב-1,000) עם תקרת ביטחון, ו"כל האתרים" בתצוגת שנה עבר אותה. עכשיו
// הן מגיעות מפונקציית SQL לפי חודש — ראה rowsChunked.js.

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

  // ⚠️ השורות מ-public.insights_rows, לפי חודש — ראה rowsChunked.js. אותן
  // עמודות ואותם תנאים כמו השליפה המדופדפת שהייתה כאן, ובלי תקרה.
  const rows = await fetchRowsChunked("insights_rows", siteId, from, to);
  const opsPage = { rows: rows.ops }, segPage = { rows: rows.segs }, winPage = { rows: rows.wins };
  const coverWindows = rows.cover;

  const counted = collapseSegmentsBySite(segPage.rows).filter((s) => !s.excluded_at);
  const kept = segPage.rows;

  // ==========================================================
  // קטיעה חייבת להיאמר, לא להיבלע
  // ==========================================================
  // ⚠️ capped נשאר בתשובה (המסך קורא אותו), אבל אינו יכול להיות true עוד:
  // אין תקרה. הכלל שהיה כאן נשאר נכון — תובנות על חלק מהתקופה שנראות
  // שלמות גרועות משגיאה — ולכן נפילה של חודש אחד מפילה את כל השליפה.
  return {
    ...computeInsights({
      ops: opsPage.rows,
      // ⚠️ **הסטטוס האפקטיבי.** `collapseSegmentsBySite` מחזיר את המקטע
      // המקורי בכוונה, ולכן `s.status` כאן הוא הגולמי: תקלה שמנהל סיווג
      // מחדש כתחזוקה נספרה בלשונית האמינות כתקלה, ושעותיה כ"בתקלה". הזרוע
      // דרך השרת עשתה `COALESCE(reclassified_to, status)` ב-SQL.
      errorRows: counted.filter((s) => (s.reclassified_to || s.status) === "error"),
      maintRows: counted.filter((s) => (s.reclassified_to || s.status) === "maintenance"),
      windows: winPage.rows,
      coverWindows,
      from, to,
      // ראה computeInsights: הזמן נסכם על המקטעים הגולמיים, לא המקופלים.
      allRows: kept,
    }),
    // אין יותר תקרה — כל השורות מגיעות. השדה נשאר כי המסך קורא אותו.
    capped: false,
  };
}
