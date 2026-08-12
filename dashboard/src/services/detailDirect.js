// services/detailDirect.js — פאנל פרטי האתר ואנליטיקה, ישירות מ-Supabase.
//
// ============================================================
// שני המסלולים האחרונים שנשארו מהשרת
// ============================================================
// אחרי שהרשימה, מסך הבקרה, הלוג, התובנות ומסך ההנהלה עברו, אלה היו שלוש
// הקריאות היחידות שעדיין פנו לשרת — ולכן הן מה שמנע מהתמונה להיות שלמה:
// "הדשבורד מדבר רק עם Supabase" לא היה נכון כל עוד הן קיימות.
//
// ============================================================
// מה עבר לאן, ולמה
// ============================================================
// **פרטי האתר** — הרכבה של דברים שכולם כבר קיימים ב-SQL ומאומתים:
//   site_stats · site_uptime · site_globals · site_status_history
// בתוספת שתי שליפות טבלה פשוטות (פעולות אחרונות, היסטוריית תחזוקה).
//
// ⚠️ site_status_history היא פונקציה חדשה ולא שליפה ישירה, כי היא נושאת שני
// כללים שאי אפשר לבטא בבורר של PostgREST: הסתרת 'בפעולה' **רק** כשיש פעולה
// שמסבירה אותו (מקטע יתום חייב להישאר — זה מה שחשף אתר תקוע 11 שעות),
// ו"תחזוקה גוברת" משני מקורות.
//
// **אנליטיקה** — כאן החישוב נשאר JS ורץ בדפדפן: computeAnalytics ב-
// shared/executive.mjs, אותה פונקציה בדיוק שהשרת מריץ. הסיבה זהה לזו של
// הלוג — buildPeriodSeries בונה דליים לפי אזור זמן מקומי ומייצר תוויות
// בעברית, ופורט שלה ל-SQL היה שכפול שברירי של שתיהן.

import { supabase, isSupabaseConfigured } from "./supabase";
import { computeAnalytics } from "../../../shared/executive.mjs";
import { pageAll } from "./pageAll";

const FETCH_CAP = 20000;

function fail(error) {
  throw new Error(
    error.code === "42501" ? "אין הרשאת קריאה — נדרשת התחברות" : error.message
  );
}

/**
 * פרטי אתר מלאים. אותו מבנה בדיוק ש-GET /api/sites/:code מחזיר.
 */
export async function fetchSiteDetailDirect(code, weekFromIso, toIso = new Date().toISOString()) {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");

  const siteRes = await supabase.from("sites").select("*").eq("code", code).single();
  if (siteRes.error) fail(siteRes.error);
  const site = siteRes.data;

  const [statsRes, uptimeRes, globalsRes, historyRes, opsRes, maintRes] = await Promise.all([
    supabase.rpc("site_stats", { p_site_ids: [site.id], p_from: weekFromIso, p_to: toIso }),
    supabase.rpc("site_uptime", { p_site_ids: [site.id], p_from: weekFromIso, p_to: toIso }),
    supabase.rpc("site_globals", { p_site_ids: [site.id] }),
    supabase.rpc("site_status_history", { p_site_id: site.id, p_limit: 10 }),
    supabase.from("operations").select("*")
      .eq("site_id", site.id).order("occurred_at", { ascending: false }).limit(10),
    supabase.from("maintenance_windows")
      .select("set_by_name, reason, started_at, duration_hours, expires_at, cancelled_at")
      .eq("site_id", site.id).order("started_at", { ascending: false }).limit(10),
  ]);

  for (const r of [statsRes, uptimeRes, globalsRes, historyRes, opsRes, maintRes]) {
    if (r.error) fail(r.error);
  }

  const st = statsRes.data?.[0] ?? {};
  const up = uptimeRes.data?.[0] ?? {};
  const g = globalsRes.data?.[0] ?? {};

  // ⚠️ תחזוקה ידנית פעילה גוברת על המצב שה-PLC דיווח — אותו כלל בדיוק כמו
  // applyMaintenanceStatus בשרת. בלעדיו אתר בתחזוקה נראה זמין.
  const inMaintenance = Boolean(g.maintenance_id);
  const status = inMaintenance || site.status === "maintenance" ? "maintenance" : site.status;

  return {
    site: {
      ...site,
      status,
      inMaintenance,
      // השרת מחזיר את חלון התחזוקה הפעיל כאובייקט מקונן; site_globals מחזירה
      // אותו שטוח. בלי ההרכבה כאן הפאנל מאבד את "מי הפעיל ועד מתי" בשקט.
      activeMaintenance: inMaintenance ? {
        setBy: g.maintenance_set_by_name,
        role: g.maintenance_set_by_role,
        reason: g.maintenance_reason,
        startedAt: g.maintenance_started_at,
        durationHours: g.maintenance_duration_hours,
        expiresAt: g.maintenance_expires_at,
      } : null,
      statusSince: g.status_since ?? null,
      failureRate: st.failure_rate ?? 0,
      operations: st.operations ?? 0,
      errors: st.errors ?? 0,
      // measured_hours = 0 פירושו "אין נתון" ולא "0%" — ראה sitesDirect.js.
      uptime: up.measured_hours > 0 ? up.availability_percent : null,
      lastFaultAt: g.last_fault_at ?? null,
      lastOperation: g.last_op_occurred_at ? {
        start_end: g.last_op_start_end,
        entry_exit: g.last_op_entry_exit,
        card_number: g.last_op_card_number,
        occurred_at: g.last_op_occurred_at,
      } : null,
    },
    operations: opsRes.data ?? [],
    statusHistory: historyRes.data ?? [],
    maintenanceHistory: maintRes.data ?? [],
  };
}

/**
 * אנליטיקת אתר. **הטווח הנשלף הוא טווח-העל** — מתחילת התקופה הקודמת ועד סוף
 * הנוכחית — כי computeAnalytics מחשבת את שתיהן מאותם נתונים. שליפה של
 * התקופה הנוכחית בלבד הייתה מחזירה השוואה ריקה.
 */
export async function fetchSiteAnalyticsDirect(code, { range, prev, granularity }) {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");

  // ⚠️ plc_cycle_last ו-cycle_total נשלפים כאן ולא רק ה-id: המסך מציג אותם
  // תחת `cycles`, והשרת מחזיר אותם מאותה שורת אתר. בלעדיהם המונים בפאנל
  // מוצגים ריקים — בלי שגיאה, בלי סימן.
  const siteRes = await supabase
    .from("sites").select("id, plc_cycle_last, cycle_total").eq("code", code).single();
  if (siteRes.error) fail(siteRes.error);
  const siteId = siteRes.data.id;

  const from = prev.from, to = range.to;

  const [ops, segments, windows] = await Promise.all([
    pageAll((a, b) => supabase
      .from("operations")
      .select("site_id, occurred_at, entry_exit, start_end, is_anomaly, superseded_by")
      .eq("site_id", siteId).gte("occurred_at", from).lt("occurred_at", to)
      .order("occurred_at", { ascending: true }).range(a, b), FETCH_CAP),

    // חפיפה ולא הכלה — מקטע שהתחיל לפני הטווח ונמשך לתוכו חייב להיספר.
    pageAll((a, b) => supabase
      .from("status_history")
      .select("site_id, status, started_at, ended_at, id")
      .eq("site_id", siteId).lt("started_at", to)
      .or(`ended_at.is.null,ended_at.gt.${from}`)
      // ⚠️ id כשובר שוויון — sortByStartedAt בשרת עושה בדיוק את זה, וקיפול
      // הריצוד תלוי בסדר. בלי זה שני מקטעים באותה שנייה עלולים להתהפך
      // והקיפול יחזיר תוצאה אחרת.
      .order("started_at", { ascending: true }).order("id", { ascending: true })
      .range(a, b), FETCH_CAP),

    pageAll((a, b) => supabase
      .from("maintenance_windows")
      .select("site_id, started_at, expires_at, cancelled_at, duration_hours")
      .eq("site_id", siteId).lt("started_at", to)
      .order("started_at", { ascending: true }).range(a, b), FETCH_CAP),
  ]);

  // מבנה loadRangeData: שלוש מפות לפי site_id. computeAnalytics קוראת אותן
  // ישירות, ולכן הצורה חייבת להיות זהה — לא רשימות.
  const data = {
    ops: new Map([[siteId, ops.rows]]),
    segments: new Map([[siteId, segments.rows]]),
    windows: new Map([[siteId, windows.rows]]),
  };

  // site מוחזר כדי ש-dataSource יוכל לבנות את `cycles` — ראה שם.
  return { ...computeAnalytics(data, siteId, { range, prev, granularity }), site: siteRes.data };
}
