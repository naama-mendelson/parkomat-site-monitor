// services/sitesDirect.js — רשימת האתרים ישירות מ-Supabase, בלי השרת.
//
// ============================================================
// זה המסלול שכל Phase D קיים בשבילו
// ============================================================
// עד כאן הדשבורד שאל את השרת, והשרת חישב. כאן הוא שואל את בסיס הנתונים
// ומבקש ממנו לחשב — אותן פונקציות SQL בדיוק שנבדקו ב-tools/parity.js מול
// ה-JS (939 השוואות, 0 הבדלים). כלומר אין כאן הגדרה שנייה של שום מדד.
//
// שלוש קריאות במקביל, לא בטור:
//   • sites          — קריאת טבלה תחת RLS
//   • site_stats     — RPC. פעולות, תקלות, אחוז כשל
//   • site_uptime    — RPC. זמינות
//
// p_site_ids = null פירושו "כל האתרים". זו בדיוק הסיבה שהפונקציות מקבלות
// null: אחרת היה צריך לשלוף קודם את המזהים ורק אז לקרוא — סיבוב רשת שלם
// בטור, לפני שאפשר להתחיל.
//
// ============================================================
// מה שהמסלול הזה עדיין **אינו** מספק, ובמפורש
// ============================================================
// getAllSitesGlobals בשרת (107 שורות) מספק statusSince, lastFaultAt,
// lastOperation ו-inMaintenance. הוא **לא הועבר ל-SQL**, ולכן השדות האלה
// אינם זמינים כאן. הכרטיס משתמש בהם: בלי statusSince אין "בפעולה 3 שעות",
// ובלי inMaintenance התחזוקה לא גוברת על מה שה-PLC דיווח.
//
// לכן זה מסלול **מקביל ולא מחליף**: הוא מוכיח את הארכיטקטורה מקצה לקצה
// על מסך אחד, ומודד את המחיר האמיתי. המסך הראשי ממשיך דרך השרת עד
// שהפונקציה ההיא תעבור גם היא. אל תחליפו את fetchSites בזה לפני כן —
// המסך יאבד שדות בשקט.

import { supabase, isSupabaseConfigured } from "./supabase";

/**
 * @returns {Promise<{sites: Array, error: string|null, source: string}>}
 * source נחשף כדי שהמסך יוכל להראות מאיפה הנתונים הגיעו. במעבר הדרגתי זה
 * ההבדל בין "עובד" לבין "עובד, ואני יודע דרך מה".
 */
export async function fetchSitesDirect(fromIso, toIso = new Date().toISOString()) {
  if (!isSupabaseConfigured) {
    return { sites: [], error: "Supabase אינו מוגדר בדשבורד", source: "none" };
  }

  const [sitesRes, statsRes, uptimeRes] = await Promise.all([
    supabase.from("sites").select("id, code, site_name, status, last_seen, tier, cycle_total"),
    supabase.rpc("site_stats", { p_site_ids: null, p_from: fromIso, p_to: toIso }),
    supabase.rpc("site_uptime", { p_site_ids: null, p_from: fromIso, p_to: toIso }),
  ]);

  const failed = sitesRes.error || statsRes.error || uptimeRes.error;
  if (failed) {
    // 42501 = permission denied. כמעט תמיד "אין session" ולא "המדיניות
    // שבורה", ולכן ההודעה אומרת את הדבר שסביר שקרה.
    const msg = failed.code === "42501"
      ? "אין הרשאת קריאה — נדרשת התחברות"
      : failed.message;
    return { sites: [], error: msg, source: "supabase" };
  }

  const statsById = new Map((statsRes.data || []).map((r) => [r.site_id, r]));
  const uptimeById = new Map((uptimeRes.data || []).map((r) => [r.site_id, r]));

  const sites = (sitesRes.data || []).map((s) => {
    const st = statsById.get(s.id);
    const up = uptimeById.get(s.id);
    return {
      ...s,
      operations: st?.operations ?? 0,
      errors: st?.errors ?? 0,
      failureRate: st?.failure_rate ?? 0,
      // measured_hours = 0 פירושו "אין נתון", ואז null כדי שהמסך יציג "—"
      // ולא "0%". אותו כלל בדיוק כמו בשרת.
      uptime: up && up.measured_hours > 0 ? up.availability_percent : null,
    };
  });

  return { sites, error: null, source: "supabase" };
}
