// services/activityDirect.js — לוג הפעילות ישירות מ-Supabase, בלי השרת.
//
// ============================================================
// כאן ההעברה היא לדשבורד, לא ל-SQL — וזו החלטה
// ============================================================
// כל שאר המסלולים עברו לפונקציות SQL, כי הם **הגדרות מדד**: זמינות ואחוז
// כשל חייבים להיות זהים בדיוק בכל מסך ובעוזר ה-AI, ולכן הם שייכים למקום
// אחד שכולם קוראים ממנו.
//
// הלוג אינו כזה. מה שהוא מחליט הוא **תצוגה**: איזו שורה מופיעה מעל איזו
// כששתיהן באותה שנייה, מה נחשב רעש ומוסתר, ואיך נקראת פעולה שנקטעה. זה
// השתנה ארבע פעמים בשבוע האחרון לבדו — ואילו זה היה יושב ב-SQL, כל אחד
// מהשינויים האלה היה הגירת בסיס נתונים.
//
// לכן הפונקציה עצמה נשארה JS ועברה ל-shared/timeline.mjs. **אותו קובץ בדיוק**
// רץ בשרת ובדפדפן, ו-42 הבדיקות שמכסות אותו רצות עליו כמות שהוא. אין כאן
// פורט, ולכן אין סיכון parity — זה לא תרגום אלא אותו קוד במקום אחר.
//
// ============================================================
// המחיר: שורות גולמיות חוצות את הרשת
// ============================================================
// הדפדפן צריך את אותן שורות שהשרת טוען היום. נמדד על נתוני הייצור:
//
//     שבוע  — 3,184 שורות · 436KB גולמי (~87KB דחוס)
//     חודש  — 4,599 שורות · 621KB גולמי (~124KB דחוס)
//
// זה מקובל, אבל הוא **גדל עם התקופה ועם מספר האתרים**. התקרה כאן היא ההגנה:
// אם התקופה חורגת ממנה, הלוג מסמן `capped` במקום להציג "סה\"כ" שקטן מהאמת.

import { supabase, isSupabaseConfigured } from "./supabase";
import { buildActivityLog } from "../../../shared/timeline.mjs";
import { fetchRowsChunked } from "./rowsChunked";

// ⚠️ **אין תקרה.** עד 24/09/2026 השורות נשלפו בדפדוף (PostgREST חותך כל
// תשובה ב-1,000) עם תקרת ביטחון, ו"כל האתרים" בתצוגת שנה עבר אותה. עכשיו
// הן מגיעות מפונקציית SQL לפי חודש — ראה rowsChunked.js.

/**
 * @param code    קוד אתר, או null ללוג המצרף
 * @param opts    { from, to, limit, offset, filter, card }
 * @returns אותו מבנה בדיוק ש-GET /api/activity מחזיר
 */
export async function fetchActivityDirect(code, { from, to, limit = 300, offset = 0, filter = "all", card = null }) {
  if (!isSupabaseConfigured) {
    throw new Error("Supabase אינו מוגדר בדשבורד");
  }

  // אתר בודד: צריך את המזהה לפני השליפות. במצרף אין צעד כזה.
  let siteId = null;
  if (code) {
    const { data, error } = await supabase.from("sites").select("id").eq("code", code).single();
    if (error) throw new Error(error.message);
    siteId = data.id;
  }


  // ⚠️ השורות מ-public.activity_rows, לפי חודש, בסדר יורד — ראה
  // rowsChunked.js. site_name מגיע כעמודה, ולא כ-sites(site_name) מקונן.
  const rows = await fetchRowsChunked("activity_rows", siteId, from, to, { desc: true });

  return buildActivityLog({
    ops: rows.ops,
    states: rows.states,
    maint: rows.maint,
    suppressed: rows.suppressed,
    limit, offset, filter, card,
    capped: false,
  });
}
