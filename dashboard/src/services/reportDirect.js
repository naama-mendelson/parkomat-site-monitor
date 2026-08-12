// services/reportDirect.js — דוח חודשי ישירות מ-Supabase.
//
// ============================================================
// למה זו פונקציית SQL ולא חישוב בדפדפן
// ============================================================
// כל שאר המסלולים שעברו לדשבורד עשו זאת כי הם **תצוגה** — סדר, תוויות,
// ספי הצגה. הדוח הוא ההפך: הוא **הגדרת מדד** על טווח שיכול להיות שנים,
// ושליפת כל השורות של שנתיים לדפדפן כדי לספור אותן שם היא בזבוז שגדל
// בדיוק כשהדוח נעשה שימושי.
//
// ⚠️ ובעיקר: הכללים כאן חייבים להיות זהים למסך. "תחזוקה גוברת" על תקלה,
// והחרגת superseded_by — שניהם כבר מוגדרים ב-SQL, ועותק שני שלהם ב-JS היה
// נותן לדוח מספר תקלות שונה ממה שמופיע במסך לאותה תקופה.
//
// ============================================================
// ⚠️ ולא monthly_summary
// ============================================================
// יש בבסיס הנתונים טבלת סיכום חודשית, והיא **שגויה**: נמדד שיולי הראה בה
// 633 פעולות מול 806 בפועל, ואוגוסט חסר לגמרי — העבודה היומית שבונה אותה
// אינה רצה. דוח שנשען עליה היה מדווח פחות ממה שקרה, בלי שום סימן.

import { supabase, isSupabaseConfigured } from "./supabase";

/**
 * @param code קוד אתר, או null לכל האתרים
 * @param from תאריך YYYY-MM-DD (כולל)
 * @param to   תאריך YYYY-MM-DD (כולל את היום כולו)
 * @returns אותו מבנה בדיוק ש-GET /api/report/monthly מחזיר
 */
export async function fetchMonthlyReportDirect(code, from, to) {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");

  // ⚠️ **חצות מקומית, לא חצות UTC.** נמדד שהטעות הזו הורידה 3 פעולות מדוח
  // של יום אחד: `T00:00:00.000Z` הוא חצות UTC, ובישראל בקיץ זה 03:00 מקומי —
  // כלומר כל מה שקרה בשלוש השעות הראשונות של היום נעלם. כל המערכת מיושרת
  // לחצות מקומית (api/periods.js).
  //
  // ⚠️ ו-to כולל את היום כולו: "עד 4.8" חייב לכלול את ה-4.8 עצמו.
  const bound = (ymd, endOfDay) => {
    const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
    return endOfDay
      ? new Date(y, m - 1, d, 23, 59, 59, 999).toISOString()
      : new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
  };
  const fromIso = bound(from, false);
  const toIso = bound(to, true);

  let siteIds = null;
  if (code) {
    const { data, error } = await supabase.from("sites").select("id").eq("code", code).single();
    if (error) throw new Error(error.message);
    siteIds = [data.id];
  }

  // שני החתכים מאותו טווח, במקביל: לפי חודש ולפי אתר. הם עונים על שתי
  // שאלות שונות — "איך זה התפתח" מול "מי בעייתי".
  const [byMonth, bySite, siteMonths] = await Promise.all([
    supabase.rpc("report_monthly", { p_site_ids: siteIds, p_from: fromIso, p_to: toIso }),
    supabase.rpc("report_by_site", { p_site_ids: siteIds, p_from: fromIso, p_to: toIso }),
    supabase.rpc("report_site_months", { p_site_ids: siteIds, p_from: fromIso, p_to: toIso }),
  ]);

  const failed = byMonth.error || bySite.error || siteMonths.error;
  if (failed) {
    throw new Error(
      failed.code === "42501" ? "אין הרשאת קריאה — נדרשת התחברות" : failed.message
    );
  }

  return {
    from: fromIso, to: toIso, site: code || null,
    months: byMonth.data || [],
    sites: bySite.data || [],
    siteMonths: siteMonths.data || [],
  };
}
