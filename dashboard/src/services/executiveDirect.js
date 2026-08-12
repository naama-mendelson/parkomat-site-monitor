// services/executiveDirect.js — מסך ההנהלה ישירות מ-Supabase, בלי השרת.
//
// ============================================================
// מרכיב שני מקורות שכבר קיימים — ולא בונה שום דבר חדש
// ============================================================
// computeExecutive זקוקה לשלושה קלטים בדיוק, ולכולם כבר יש מסלול ישיר:
//
//   allRows  — שורות מסך הבקרה   -> fetchSupervisorDirect (site_stats/uptime/globals)
//   data     — הנתונים הגולמיים   -> loadRangeShape כאן (ops + segments + windows)
//   allSites — רשימת האתרים       -> טבלת sites
//
// **לא נכתבה כאן שום אריתמטיקה.** כל החישוב — הדליים, מפת החום, הפילוחים,
// ה-KPI-ים — הוא shared/executive.mjs, אותו קובץ שהשרת מריץ.
//
// ============================================================
// ⚠️ מבנה `data` הוא חוזה, לא נוחות
// ============================================================
// statsFromData ו-uptimeFromData מצפות ל-Map לפי site_id, ו-uptimeFromData
// **קוראת את data.windows ישירות ואינה מתגוננת** — קורא ששוכח לטעון חלונות
// יקבל קריסה ולא זמינות מנופחת. זה מכוון (ראה master/CLAUDE.md), ולכן
// windows חייב להיות שם גם כשהוא ריק.

import { supabase, isSupabaseConfigured } from "./supabase";
import { computeExecutive } from "../../../shared/executive.mjs";
import { fetchSupervisorDirect } from "./supervisorDirect";
import { pageAll } from "./pageAll";

const FETCH_CAP = 20000;

/** בונה את מבנה `data` שה-*FromData מצפות לו: שלוש מפות לפי site_id. */
async function loadRangeShape(from, to) {
  const [ops, segments, windows] = await Promise.all([
    pageAll((a, b) => supabase
      .from("operations")
      .select("site_id, occurred_at, entry_exit, start_end, is_anomaly, superseded_by")
      .gte("occurred_at", from).lt("occurred_at", to)
      .order("occurred_at", { ascending: true })
      .range(a, b), FETCH_CAP),

    // ⚠️ חפיפה ולא הכלה: מקטע שהתחיל לפני החלון ונמשך לתוכו הוא זמן אמיתי
    // בתוך התקופה. בלעדיו אתר שהיה מושבת כל השבוע מקבל 100% זמינות.
    pageAll((a, b) => supabase
      .from("status_history")
      .select("site_id, status, started_at, ended_at, id")
      .lt("started_at", to)
      .or(`ended_at.is.null,ended_at.gt.${from}`)
      .order("started_at", { ascending: true })
      .range(a, b), FETCH_CAP),

    pageAll((a, b) => supabase
      .from("maintenance_windows")
      .select("site_id, started_at, expires_at, cancelled_at")
      .lt("started_at", to)
      .order("started_at", { ascending: true })
      .range(a, b), FETCH_CAP),
  ]);

  const group = (rows) => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.site_id)) m.set(r.site_id, []);
      m.get(r.site_id).push(r);
    }
    return m;
  };

  return {
    ops: group(ops.rows),
    segments: group(segments.rows),
    windows: group(windows.rows),
    capped: ops.capped || segments.capped || windows.capped,
  };
}

/**
 * @param filters { siteCodes, statuses, minFailureRate, groupBy, granularity }
 * @returns אותו מבנה בדיוק ש-GET /api/stats/executive מחזיר (ללא ההשוואה)
 */
export async function fetchExecutiveDirect({ from, to, ...filters }) {
  if (!isSupabaseConfigured) {
    throw new Error("Supabase אינו מוגדר בדשבורד");
  }

  const [supervisor, data, sitesRes] = await Promise.all([
    fetchSupervisorDirect(from, to),
    loadRangeShape(from, to),
    supabase.from("sites").select("id, code, site_name"),
  ]);

  if (sitesRes.error) throw new Error(sitesRes.error.message);

  // ⚠️ הסדר חייב להיות זהה לשרת (getAllSites → ORDER BY code): computeExecutive
  // ממפה קוד→מזהה דרך allSites, וסדר שונה משנה איזה אתר נופל לאיזו שורה
  // במפת החום.
  const allSites = (sitesRes.data || [])
    .slice()
    .sort((a, b) => String(a.code).localeCompare(String(b.code)));

  return computeExecutive({
    allRows: supervisor.sites,
    data,
    allSites,
    from, to,
    ...filters,
  });
}
