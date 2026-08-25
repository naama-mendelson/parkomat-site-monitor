// services/sitesDirect.js — רשימת האתרים ישירות מ-Supabase, בלי השרת.
//
// ============================================================
// זה המסלול שכל Phase D קיים בשבילו
// ============================================================
// עד כאן הדשבורד שאל את השרת, והשרת חישב. כאן הוא שואל את בסיס הנתונים
// ומבקש ממנו לחשב — אותן פונקציות SQL בדיוק שנבדקו ב-tools/parity.js מול
// ה-JS. כלומר אין כאן הגדרה שנייה של שום מדד, וזו הנקודה: שתי הגדרות של
// "זמינות" כבר נפרדו בשקט בפרויקט הזה פעם אחת.
//
// ארבע קריאות במקביל, לא בטור:
//   • sites          — קריאת טבלה תחת RLS
//   • site_stats     — RPC. פעולות, תקלות, אחוז כשל
//   • site_uptime    — RPC. זמינות
//   • site_globals   — RPC. תקלה אחרונה, פעולה אחרונה, מצב נוכחי, תחזוקה
//
// p_site_ids = null פירושו "כל האתרים". זו בדיוק הסיבה שהפונקציות מקבלות
// null: אחרת היה צריך לשלוף קודם את המזהים ורק אז לקרוא — סיבוב רשת שלם
// בטור, לפני שאפשר להתחיל.
//
// ============================================================
// המבנה המוחזר חייב להיות זהה ל-getAllSitesWithMetrics
// ============================================================
// המסך אינו יודע דרך מה הנתונים הגיעו, וזה התנאי לכך שהמתג ב-dataSource.js
// יהיה באמת מתג ולא שכתוב. כל שדה שנוסף בצד אחד חייב להתווסף בשני —
// ובמיוחד inMaintenance ו-statusSince, שבלעדיהם הכרטיס מאבד מידע *בשקט*
// ולא בשגיאה.

import { supabase, isSupabaseConfigured } from "./supabase";
import { siteTrend } from "../../../shared/executive.mjs";

/**
 * רשימת האתרים עם כל המדדים, ישירות מבסיס הנתונים.
 *
 * @param {string} fromIso תחילת החלון לחישוב המדדים
 * @param {string} toIso   סופו (ברירת מחדל: עכשיו)
 * @returns {Promise<Array>} אותו מבנה בדיוק שהשרת מחזיר ב-GET /api/sites
 * @throws {Error} כדי להתנהג כמו fetchSites — useSites תופס ומציג
 */
export async function fetchSitesDirect(fromIso, toIso = new Date().toISOString(), prevFromIso = null) {
  if (!isSupabaseConfigured) {
    throw new Error("Supabase אינו מוגדר בדשבורד");
  }

  // ⚠️ קריאה חמישית ולא סיבוב לכל אתר: site_stats מקבלת null ומחזירה שורה
  // לכל אתר, ולכן התקופה הקודמת עולה בדיוק כמו הנוכחית — אחת.
  const [sitesRes, statsRes, uptimeRes, globalsRes, prevRes] = await Promise.all([
    supabase.from("sites").select("*"),
    supabase.rpc("site_stats",   { p_site_ids: null, p_from: fromIso, p_to: toIso }),
    supabase.rpc("site_uptime",  { p_site_ids: null, p_from: fromIso, p_to: toIso }),
    supabase.rpc("site_globals", { p_site_ids: null }),
    prevFromIso
      ? supabase.rpc("site_stats", { p_site_ids: null, p_from: prevFromIso, p_to: fromIso })
      : Promise.resolve({ data: [], error: null }),
  ]);

  const failed = sitesRes.error || statsRes.error || uptimeRes.error || globalsRes.error;
  if (failed) {
    // 42501 = permission denied. כמעט תמיד "אין session" ולא "המדיניות
    // שבורה", ולכן ההודעה אומרת את הדבר שסביר שקרה.
    throw new Error(
      failed.code === "42501"
        ? "אין הרשאת קריאה — נדרשת התחברות"
        : failed.message
    );
  }

  const statsById   = new Map((statsRes.data   || []).map((r) => [r.site_id, r]));
  const uptimeById  = new Map((uptimeRes.data  || []).map((r) => [r.site_id, r]));
  const globalsById = new Map((globalsRes.data || []).map((r) => [r.site_id, r]));
  const prevById    = new Map((prevRes.data     || []).map((r) => [r.site_id, r]));

  return (sitesRes.data || []).map((site) => {
    const st = statsById.get(site.id);
    const up = uptimeById.get(site.id);
    const g  = globalsById.get(site.id) || {};

    // תקלה שקורה בתוך תחזוקה מתוכננת אינה "תקלה" — היא כבר מוחרגת מאחוז
    // הכשל, וכאן היא לא הופכת את הכרטיס למושבת. אותו כלל בדיוק כמו בשרת;
    // אם הוא ישתנה שם ולא כאן, שני המסלולים יראו סטטוס שונה לאותו אתר.
    const inMaintenance = Boolean(g.maintenance_id);
    const status = inMaintenance || site.status === "maintenance"
      ? "maintenance"
      : site.status;

    return {
      ...site,
      status,
      inMaintenance,
      failureRate: st?.failure_rate ?? 0,
      operations:  st?.operations   ?? 0,
      errors:      st?.errors       ?? 0,
      // measured_hours = 0 פירושו "אין נתון", ואז null כדי שהמסך יציג "—"
      // ולא "0%". "0%" נקרא כ"מושבת לגמרי" כשהמשמעות היא "איננו יודעים".
      uptime: up && up.measured_hours > 0 ? up.availability_percent : null,
      // אותו כלל בדיוק כמו בשרת — siteTrend במודול המשותף.
      trend: siteTrend(
        { operations: st?.operations ?? 0, failureRate: st?.failure_rate ?? 0 },
        prevById.get(site.id)
          ? { operations: prevById.get(site.id).operations,
              failureRate: prevById.get(site.id).failure_rate }
          : null
      ),
      lastFaultAt: g.last_fault_at ?? null,
      // ⚠️ ?? ולא ||: '' הוא ערך תקף ("הבקר נשאל והחזיר ריק"), ו-|| היה
      // הופך אותו ל-null — כלומר ל"לא נקרא". שני דברים שונים.
      currentFaultText: g.current_fault_text ?? null,
      // ⚠️ חייב להיות זהה לזרוע השרת — check-switch מוודא בדיוק את זה.
      currentAfterError: g.current_after_error === true,
      // ============================================================
      // ⚠️ בתחזוקה ידנית — הזמן הוא של החלון, לא של מקטע הבקר
      // ============================================================
      // הסטטוס נדרס ל-'maintenance' כשיש חלון ידני פעיל, אבל הזמן
      // נשאר של המקטע הפתוח מהבקר. התוצאה על הכרטיס: **"המצב השתנה
      // לבתחזוקה — לפני 3 שעות"** בזמן שהחלון נפתח לפני שתי דקות.
      //
      // ⚠️ נמדד באתר 1348: מקטע ready פתוח מ-05:00, חלון תחזוקה נפתח
      // ב-08:06, והכרטיס הציג 3 שעות. התווית והזמן הגיעו משני מקורות
      // שונים — וזה נראה כמו נתון אמיתי, לא כמו תקלה.
      statusSince: inMaintenance
        ? (g.maintenance_started_at ?? g.status_since ?? null)
        : (g.status_since ?? null),
      // השרת מחזיר אובייקט או null — ולא אובייקט עם שדות ריקים, שהיה נראה
      // למסך כמו "יש פעולה אחרונה" עם כל השדות undefined.
      lastOperation: g.last_op_occurred_at
        ? {
            start_end:   g.last_op_start_end,
            entry_exit:  g.last_op_entry_exit,
            card_number: g.last_op_card_number,
            occurred_at: g.last_op_occurred_at,
          }
        : null,
    };
  });
}
