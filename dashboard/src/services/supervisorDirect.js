// services/supervisorDirect.js — מסך הבקרה ישירות מ-Supabase, בלי השרת.
//
// ============================================================
// למה דווקא המסלול הזה נבחר ראשון
// ============================================================
// נמדד על נתוני הייצור (חודש, 12 אתרים): **1,096ms** — הכבד ביותר מכל
// מסלולי הקריאה, פי שלושה מהבא אחריו. וזו רק ההתחלה: בשרת הוא טוען את כל
// הפעולות ואת כל מקטעי המצב של התקופה לזיכרון ומחשב ב-JS, ולכן העלות גדלה
// עם מספר האתרים. ב-CLAUDE.md מתועד ש-200 אתרים × 365 יום חוסמים את
// ה-event loop ל-26 שניות — **ו-Node חד-חוטי, כך שהקליטה מ-MQTT נעצרת יחד
// איתו.** כלומר זה לא ייעול תצוגה אלא הסרת סיכון מהקליטה.
//
// ============================================================
// ולמה זה זול: אין כאן שום הגדרה חדשה
// ============================================================
// getSupervisorStatsWithData בשרת בנוי מארבעה מקורות בדיוק — וכל אחד מהם
// כבר קיים כפונקציית SQL ומאומת ב-tools/parity.js:
//
//     getAllSites()          -> טבלת sites (PostgREST)
//     statsFromData(...)     -> site_stats
//     uptimeFromData(...)    -> site_uptime
//     getAllSitesGlobals()   -> site_globals
//
// כלומר אותן ארבע הקריאות ש-sitesDirect.js כבר עושה. **לא נכתבה כאן שום
// אריתמטיקה חדשה**, וזה התנאי: כל מדד שמחושב פעמיים נפרד בשקט, ובפרויקט
// הזה "זמינות" כבר נפרדה לשלוש הגדרות פעם אחת.
//
// ============================================================
// המבנה המוחזר חייב להיות זהה ל-GET /api/stats/supervisor
// ============================================================
// המסך אינו יודע דרך מה הנתונים הגיעו — זה התנאי לכך שהמתג ב-dataSource.js
// יהיה מתג ולא שכתוב. כל שדה שנוסף בצד אחד חייב להתווסף בשני.

import { supabase, isSupabaseConfigured } from "./supabase";
// ⚠️ המיפוי עצמו יושב ב-supervisorShape.js — קובץ **טהור, בלי שום import**.
// זה לא סגנון: כך tools/parity-supervisor.js יכול לייבא את הפונקציה שרצה
// באמת ולהשוות אותה לפלט השרת. עותק שני של המיפוי בבדיקה היה בודק את
// העותק, לא את הקוד.
import { toSupervisorShape } from "./supervisorShape";

/**
 * נתוני מסך הבקרה, ישירות מבסיס הנתונים.
 *
 * @param {string} fromIso תחילת החלון
 * @param {string} toIso   סופו (ברירת מחדל: עכשיו)
 * @returns {Promise<{sites: Array, summary: object}>} אותו מבנה שהשרת מחזיר
 * @throws {Error} כדי להתנהג כמו הזרוע דרך השרת
 */
export async function fetchSupervisorDirect(fromIso, toIso = new Date().toISOString()) {
  if (!isSupabaseConfigured) {
    throw new Error("Supabase אינו מוגדר בדשבורד");
  }

  const nowIso = new Date().toISOString();

  // p_site_ids = null פירושו "כל האתרים" — בדיוק הסיבה שהפונקציות מקבלות
  // null. אחרת היה צריך לשלוף קודם את המזהים ורק אז לקרוא, סיבוב רשת שלם
  // בטור לפני שאפשר להתחיל.
  //
  // שש קריאות **במקביל**. בשרת המקבילה הזו קיימת חלקית בלבד: recentErrors
  // ו-activeMaintenances רצות שם בטור, אחרי שכל השאר כבר הסתיים.
  const [sitesRes, statsRes, uptimeRes, globalsRes, errorsRes, maintRes] = await Promise.all([
    supabase.from("sites").select("*"),
    supabase.rpc("site_stats",   { p_site_ids: null, p_from: fromIso, p_to: toIso }),
    supabase.rpc("site_uptime",  { p_site_ids: null, p_from: fromIso, p_to: toIso }),
    supabase.rpc("site_globals", { p_site_ids: null }),
    supabase.rpc("recent_errors", { p_limit: 10 }),
    supabase
      .from("maintenance_windows")
      .select("started_at, expires_at, set_by_name, reason, sites(code, site_name)")
      .is("cancelled_at", null)
      // ⚠️ **גם started_at.** בלעדיו חלון שתוזמן למחר מוצג כפעיל היום —
      // ו-schedule_maintenance קיים, כלומר זה מצב שאפשר להגיע אליו.
      // site_globals ב-SQL כבר מחזיק את התנאי הזה; כאן הוא חסר.
      .lte("started_at", nowIso)
      .gt("expires_at", nowIso)
      .order("expires_at", { ascending: true }),
  ]);

  const failed = sitesRes.error || statsRes.error || uptimeRes.error || globalsRes.error
    || errorsRes.error || maintRes.error;
  if (failed) {
    // 42501 = permission denied. כמעט תמיד "אין session" ולא "המדיניות
    // שבורה", ולכן ההודעה אומרת את הדבר שסביר שקרה.
    throw new Error(
      failed.code === "42501"
        ? "אין הרשאת קריאה — נדרשת התחברות"
        : failed.message
    );
  }

  return toSupervisorShape({
    siteRows:    sitesRes.data,
    statsRows:   statsRes.data,
    uptimeRows:  uptimeRes.data,
    globalsRows: globalsRes.data,
    errorRows:   errorsRes.data,
    maintRows:   maintRes.data,
  });
}
