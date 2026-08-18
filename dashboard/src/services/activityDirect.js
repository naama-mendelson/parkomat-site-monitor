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
// ⚠️ Supabase חוסם כל בקשה ב-1,000 שורות ומתעלם מ-limit. חובה לדפדף.
import { pageAll } from "./pageAll";

// אותה תקרה כמו LOG_FETCH_CAP בשרת. משוכפלת במכוון ולא מיובאת: היא מאפיין
// של מגבלת התעבורה בכל צד, ולצד הדפדפן יש מגבלה אחרת מזו של השרת.
const FETCH_CAP = 20000;

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

  const scoped = (q) => (siteId ? q.eq("site_id", siteId) : q);

  const [opsPage, statesPage, maintPage, supPage] = await Promise.all([
    pageAll((a, b) => scoped(
      supabase
        .from("operations")
        // id נשלף כי superseded_by מצביע עליו — ראה getActivityLog ב-queries.js.
        .select("id, site_id, start_end, entry_exit, card_number, is_anomaly, superseded_by, state, occurred_at, excluded_at, excluded_by, sites(site_name)")
        .gte("occurred_at", from).lt("occurred_at", to)
        .order("occurred_at", { ascending: false })
        .range(a, b)
    ), FETCH_CAP),

    pageAll((a, b) => scoped(
      supabase
        .from("status_history")
        .select("id, site_id, status, started_at, ended_at, fault_text, excluded_at, excluded_by, sites(site_name)")
        .gte("started_at", from).lt("started_at", to)
        .order("started_at", { ascending: false })
        .range(a, b)
    ), FETCH_CAP),

    pageAll((a, b) => scoped(
      supabase
        .from("maintenance_windows")
        .select("id, site_id, set_by_name, set_by_role, reason, started_at, duration_hours, expires_at, cancelled_at, excluded_at, excluded_by, sites(site_name)")
        .gte("started_at", from).lt("started_at", to)
        .order("started_at", { ascending: false })
        .range(a, b)
    ), FETCH_CAP),

    // ⚠️ תקלות שהושמטו מהמדדים בזמן תחזוקה. הן **חייבות** להיטען גם כאן:
    // שתי הזרועות מריצות את אותה buildActivityLog, ולכן זרוע שאינה טוענת
    // אותן הייתה מציגה לוג קצר יותר — בלי שום שגיאה, ורק כשהמתג מוחלף.
    pageAll((a, b) => scoped(
      supabase
        .from("suppressed_faults")
        .select("site_id, occurred_at, fault_text, reason, sites(site_name)")
        .gte("occurred_at", from).lt("occurred_at", to)
        .order("occurred_at", { ascending: false })
        .range(a, b)
    ), FETCH_CAP),
  ]);

  // ⚠️ PostgREST מחזיר את הטבלה המקושרת כאובייקט מקונן (sites.site_name),
  // בעוד שהשרת שולף אותו כעמודה שטוחה (site_name) ב-JOIN. buildTimeline קורא
  // את השטוח, ולכן ההשטחה חייבת לקרות **כאן** — בלעדיה שם האתר נעלם מהלוג
  // המצרף בשקט, בלי שום שגיאה.
  const flat = (rows) => rows.map((r) => ({ ...r, site_name: r.sites?.site_name ?? null }));

  return buildActivityLog({
    ops: flat(opsPage.rows),
    states: flat(statesPage.rows),
    maint: flat(maintPage.rows),
    suppressed: flat(supPage.rows),
    limit, offset, filter, card,
    capped: opsPage.capped || statesPage.capped || maintPage.capped || supPage.capped,
  });
}
