// services/dataSource.js — המתג. מאיפה הדשבורד קורא נתונים.
//
// ============================================================
// זו תוכנית ב'
// ============================================================
// היום הדשבורד קורא ישירות מ-Supabase. ביום שנרצה להתנתק — משנים משתנה
// סביבה אחד מ-true ל-false, ובונים מחדש. הכול חוזר לעבור דרך השרת, שהוא
// המסלול שאינו תלוי ב-Supabase כלל.
//
//     dashboard/.env
//     VITE_SUPABASE_DIRECT=true      ← קריאה ישירה (ברירת המחדל היום)
//     VITE_SUPABASE_DIRECT=false     ← הכול דרך השרת
//
// ============================================================
// למה זה מתג ולא מחיקה — וההשלכה שצריך להסכים עליה
// ============================================================
// התוכנית המקורית קראה למחוק את 17 נתיבי הקריאה בשרת אחרי המעבר. **זה
// סותר את תוכנית ב' ישירות**: הנתיבים האלה *הם* דרך החזרה. אי אפשר גם
// למחוק אותם וגם להחזיק מסלול נסיגה, וזו לא סתירה שאפשר לפתור בקוד.
//
// ההכרעה כאן: הנתיבים נשארים. השרת מצטמצם בכך שהוא **אינו בשימוש**, לא
// בכך שנמחק ממנו קוד. המחיר הוא קוד שיושב ואינו רץ; התמורה היא שהיציאה
// נשארת פתוחה בלי פרויקט הגירה. אם בעתיד תתקבל החלטה לוותר על תוכנית ב',
// המחיקה היא צעד נפרד ומודע — ולא תופעת לוואי.
//
// ⚠️ מסלול שאינו רץ נרקב. **שני המצבים נבדקים בדפדפן** לפני כל שחרור,
// בדיוק כמו שהאימות העצמאי נבדק אף שהוא רדום.
//
// ============================================================
// אין נפילה-אוטומטית-לשרת, בכוונה
// ============================================================
// מפתה להוסיף "אם הישיר נכשל, נסה את השרת". זה בדיוק מה שהופך תקלה
// לשקטה: RLS שנשברה, session שפג, פונקציה שלא הוחלה — כולם היו נראים
// כמו מערכת עובדת, והיינו מגלים רק כשגם השרת ייפול. המתג מפורש.

import {
  fetchSites as fetchSitesViaServer,
  fetchSupervisorStats as fetchSupervisorViaServer,
  fetchActivityLog as fetchActivityViaServer,
  fetchSiteInsights as fetchSiteInsightsViaServer,
  fetchGlobalInsights as fetchGlobalInsightsViaServer,
  fetchExecutiveStats as fetchExecutiveViaServer,
  fetchSiteDetail as fetchSiteDetailViaServer,
  fetchSiteAnalytics as fetchSiteAnalyticsViaServer,
  fetchMaintenance as fetchMaintenanceViaServer,
  startMaintenance as startMaintenanceViaServer,
  cancelMaintenance as cancelMaintenanceViaServer,
  fetchMonthlyReport as fetchMonthlyReportViaServer,
  registerSite as registerSiteViaServer,
  updateSite as updateSiteViaServer,
  deleteSite as deleteSiteViaServer,
} from "./api";
import { fetchActivityDirect } from "./activityDirect";
import { fetchInsightsDirect } from "./insightsDirect";
import { fetchSiteDetailDirect, fetchSiteAnalyticsDirect } from "./detailDirect";
import { fetchMonthlyReportDirect } from "./reportDirect";
import { fetchExecutiveDirect } from "./executiveDirect";
import { fetchSitesDirect } from "./sitesDirect";
import { fetchSupervisorDirect } from "./supervisorDirect";
import { startMaintenanceDirect, cancelMaintenanceDirect } from "./maintenanceDirect";
import { registerSiteDirect, updateSiteDirect, deleteSiteDirect } from "./sitesWriteDirect";
import { supabase, isSupabaseConfigured } from "./supabase";

// ============================================================
// ההשוואה היא למחרוזת "false", ולא בדיקת אמת
// ============================================================
// ב-Vite כל משתני הסביבה הם מחרוזות. Boolean("false") הוא true — כלומר
// הכתיבה הטבעית הייתה מתעלמת מהכיבוי לגמרי, והמתג היה נראה כאילו נתקע.
// ברירת המחדל כשהמשתנה חסר היא ישיר, אבל רק אם Supabase בכלל מוגדר:
// דשבורד בלי מפתחות שינסה לקרוא ישירות ייכשל בכל בקשה.
// נופלים ל-process.env מאותה סיבה כמו ב-supabase.js: כדי שהמתג יהיה ניתן
// לייבוא מ-Node, ושהבדיקות יריצו את הקוד עצמו ולא עותק שלו.
const requested = (import.meta.env ?? process.env).VITE_SUPABASE_DIRECT !== "false";

export const useDirect = requested && isSupabaseConfigured;

/** "supabase" או "server" — לתצוגה, ללוג ולבדיקות. */
export const dataSourceName = useDirect ? "supabase" : "server";

if (requested && !isSupabaseConfigured) {
  console.warn(
    "dataSource: התבקשה קריאה ישירה אך Supabase אינו מוגדר — נופלים לשרת. " +
    "בדקו VITE_SUPABASE_URL ו-VITE_SUPABASE_PUBLISHABLE_KEY."
  );
}

/**
 * רשימת האתרים. שתי הזרועות מחזירות **אותו מבנה בדיוק**, ולכן אף
 * קומפוננטה אינה יודעת מי ענה — וזה מה שהופך את המתג למתג.
 *
 * ⚠️ החלון: השרת מחשב שבוע אחרון (resolvePeriod("week") — 7 ימים מיושרים
 * לחצות). המסלול הישיר חייב לבקש את אותו חלון, אחרת אותו אתר יראה אחוז
 * כשל שונה בשני המצבים והמתג יהפוך לשינוי-משמעות.
 */
export function fetchSitesList() {
  if (!useDirect) return fetchSitesViaServer();
  // הפרמטר השלישי — תחילת השבוע הקודם, לחישוב "משתפר/מחמיר" על כל כרטיס.
  return fetchSitesDirect(weekFromIso(), new Date().toISOString(), prevWeekFromIso());
}

/**
 * מסך הבקרה. שתי הזרועות מחזירות **אותו מבנה בדיוק**.
 *
 * זה המסלול הכבד ביותר שנמדד — 1,096ms לחודש על 12 אתרים, פי שלושה מהבא
 * אחריו — והוא זה שגדל עם מספר האתרים: בשרת הוא טוען את כל הפעולות ואת כל
 * מקטעי המצב לזיכרון ומחשב ב-JS. ב-200 אתרים זה חוסם את ה-event loop, ומכיוון
 * ש-Node חד-חוטי **הקליטה מ-MQTT נעצרת יחד איתו.** לכן הוא הועבר ראשון.
 */
export async function fetchSupervisor(period) {
  if (!useDirect) return fetchSupervisorViaServer(period);

  const from = periodFromIso(period);
  const to = new Date().toISOString();
  const body = await fetchSupervisorDirect(from, to);

  // המסך קורא גם את period/label/range — ובלעדיהם כותרת התקופה נעלמת בשקט
  // במצב הישיר. זה בדיוק סוג ההבדל שהופך "מתג" ל"שני מסכים שונים".
  return { period: period || "week", ...PERIOD_META[period] || PERIOD_META.week, range: { from, to }, ...body };
}

/**
 * לוג הפעילות. שתי הזרועות מחזירות **אותו מבנה בדיוק** — וכאן זה מובטח
 * חזק מבכל מסלול אחר: שתיהן מריצות את **אותה פונקציה**, buildActivityLog
 * מ-shared/timeline.mjs. ההבדל היחיד הוא מי שלף את השורות הגולמיות.
 */
export function fetchActivity(code, opts = {}) {
  const { period = "week", ...rest } = opts;
  if (!useDirect) return fetchActivityViaServer(code, { period, ...rest });

  return fetchActivityDirect(code, {
    from: periodFromIso(period),
    to: new Date().toISOString(),
    ...rest,
  });
}

/**
 * התובנות המעמיקות ("עוד מידע"). שתי הזרועות מחזירות אותו מבנה.
 *
 * ⚠️ תשובת השרת כוללת גם את **העמוד הראשון של הלוג** תחת `log`, כדי שהמודאל
 * ייפתח עם תוכן ולא עם ספינר. הזרוע הישירה חייבת לעשות אותו דבר — אחרת הלוג
 * במודאל היה ריק עד הבקשה הבאה, וזה נראה כמו "לא קרה כלום בתקופה".
 */
export async function fetchInsights(code, period) {
  if (!useDirect) {
    return code ? fetchSiteInsightsViaServer(code, period) : fetchGlobalInsightsViaServer(period);
  }

  const from = periodFromIso(period);
  const to = new Date().toISOString();

  // שתיהן בלתי-תלויות — במקביל, ולא בטור כמו בשרת.
  const [insights, log] = await Promise.all([
    fetchInsightsDirect(code, { from, to }),
    fetchActivityDirect(code, { from, to, limit: 300, offset: 0, filter: "all" }),
  ]);

  return {
    period: period || "week",
    ...(PERIOD_META[period] || PERIOD_META.week),
    range: { from, to },
    ...insights,
    log,
  };
}

/**
 * מסך ההנהלה. שתי הזרועות מחזירות אותו מבנה.
 *
 * ⚠️ ההשוואה לתקופה הקודמת מוחלת על **אותם פילטרים בדיוק**. השוואה בין
 * "12 האתרים המסוננים השבוע" ל"כל האתרים בשבוע שעבר" אינה מגמה אלא רעש
 * שנראה כמו מגמה.
 */
export async function fetchExecutive(params = {}) {
  if (!useDirect) return fetchExecutiveViaServer(params);

  // ============================================================
  // ⚠️ טווח תאריכים חופשי — וכאן היה באג
  // ============================================================
  // הגרסה הראשונה קראה רק את params.period ונפלה ל-"week" בברירת מחדל.
  // אבל בורר הטווח מחזיר **או** period **או** from/to: "היום", "הרבעון
  // הנוכחי" ו"שנה שעברה" מחזירים טווח מפורש ומנקים את period.
  //
  // התוצאה: בחירת "היום" הציגה **7 ימים**. הבורר הראה "היום", הכותרת אמרה
  // "7 הימים האחרונים", והמספרים היו של השבוע. שום שגיאה — רק נתונים של
  // תקופה אחרת מזו שהמשתמשת ביקשה.
  //
  // ⚠️ **הזרוע דרך השרת מעולם לא סבלה מזה** (resolveRange שם מטפל בשניהם),
  // ולכן זה נראה כמו "עובד" בכל בדיקה שרצה דרכה. הפער נחשף רק במצב הישיר.
  const explicit = Boolean(params.from && params.to);

  const period = params.period || (explicit ? null : "week");
  // בטווח חופשי הגרעיניות נגזרת מאורכו: מעל 90 יום ביומי היא 300 עמודות
  // בלתי קריאות, ולכן עוברים לחודשי. אותו כלל כמו resolveRange בשרת.
  const from = explicit ? dayStartIso(params.from) : periodFromIso(period);
  const to = explicit
    // ⚠️ סוף היום ולא תחילתו: "עד 4.8" חייב לכלול את ה-4.8 כולו. חתוך
    // ל"עכשיו" כדי לא לספור אל תוך העתיד — בדיוק כמו resolveRange.
    ? new Date(Math.min(Date.parse(dayEndIso(params.to)), Date.now())).toISOString()
    : new Date().toISOString();

  const spanDays = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86400000));
  const granularity = explicit
    ? (spanDays > 90 ? "month" : "day")
    : (period === "year" ? "month" : "day");

  const filters = {
    siteCodes: params.sites, statuses: params.statuses,
    minFailureRate: Number(params.minFailureRate) || 0,
    groupBy: ["site", "status", "time"].includes(params.groupBy) ? params.groupBy : "site",
    granularity,
  };

  // התקופה הקודמת **באותו אורך**, צמודה לטווח הנוכחי. השוואה מול חלון
  // באורך אחר אינה מגמה אלא רעש שנראה כמו מגמה.
  const prev = explicit
    ? {
        from: new Date(Date.parse(from) - (Date.parse(to) - Date.parse(from))).toISOString(),
        to: from,
      }
    : prevRange(period, from);

  const [current, old] = await Promise.all([
    fetchExecutiveDirect({ from, to, ...filters }),
    fetchExecutiveDirect({ ...prev, ...filters }),
  ]);

  // ⚠️ תקופה קודמת ריקה לגמרי אינה "ירידה של 100%" אלא **אין נתון**. אתר
  // חדש היה מוצג כקורס, וזה בדיוק סוג המספר שגורם לפתוח חקירה על כלום.
  const hasComparison =
    old.kpis.totalOperations > 0 || old.kpis.totalErrors > 0 || old.kpis.avgAvailability > 0;

  const pct = (cur, prv) => {
    if (!Number.isFinite(prv) || prv === 0) return cur === 0 ? 0 : null;
    return Math.round(((cur - prv) / prv) * 1000) / 10;
  };
  const trendOf = (cur, prv) => ({
    current: cur, previous: prv,
    changePercent: hasComparison ? pct(cur, prv) : null,
  });

  return {
    period,
    ...(PERIOD_META[period] || PERIOD_META.week),
    daysCount: null,
    hasComparison,
    granularity,
    groupBy: filters.groupBy,
    range: { from, to },
    filters: { sites: params.sites, statuses: params.statuses, minFailureRate: filters.minFailureRate },
    ...current,
    trend: {
      operations: trendOf(current.kpis.totalOperations, old.kpis.totalOperations),
      errors: trendOf(current.kpis.totalErrors, old.kpis.totalErrors),
      availability: trendOf(current.kpis.avgAvailability, old.kpis.avgAvailability),
      failureRate: trendOf(current.kpis.avgFailureRate, old.kpis.avgFailureRate),
    },
  };
}

/** התקופה הקלנדרית שלפני החלון הנוכחי — באותו אורך בדיוק. */
function prevRange(period, fromIso) {
  const from = new Date(fromIso);
  if (period === "year") {
    return {
      from: new Date(from.getFullYear() - 1, 0, 1).toISOString(),
      to: fromIso,
    };
  }
  const days = period === "month" ? 30 : 7;
  const prevFrom = new Date(from);
  prevFrom.setDate(prevFrom.getDate() - days);
  return { from: prevFrom.toISOString(), to: fromIso };
}

/** פרטי אתר מלאים (הפאנל הצדדי). */
export function fetchDetail(code) {
  if (!useDirect) return fetchSiteDetailViaServer(code);
  return fetchSiteDetailDirect(code, weekFromIso());
}

/**
 * אנליטיקת אתר לפי תקופה.
 *
 * ⚠️ הזרוע הישירה צריכה גם את **התקופה הקודמת**, כי המסך מציג השוואה. השרת
 * מחשב אותה מ-resolvePeriod; כאן היא נבנית מ-periodBounds, ושתיהן חייבות
 * להסכים — אחרת החץ "לעומת התקופה הקודמת" יצביע על טווח אחר בכל מצב מתג.
 */
export async function fetchAnalytics(code, period) {
  if (!useDirect) return fetchSiteAnalyticsViaServer(code, period);

  const b = periodBounds(period);
  const { stats, uptime, prevStats, prevUptime, chart, site } =
    await fetchSiteAnalyticsDirect(code, b);

  // ============================================================
  // ⚠️ trend ו-cycles נבנים **כאן**, כי הם לא היו ב-computeAnalytics
  // ============================================================
  // נתפס בדפדפן ולא בשום שער: `DetailPanel` קרס עם
  // `Cannot read properties of undefined (reading 'operations')` — הזרוע
  // הישירה החזירה stats/uptime/chart אבל **לא trend**, והשרת כן.
  //
  // וזה בדיוק מה שכל השערים לא יכלו לתפוס: הם משווים **ערכים** בין שתי
  // הזרועות, ו-trend פשוט לא היה באף אחד מהם כדי להשוות. שדה שחסר בשתי
  // הבדיקות נראה כמו שדה שאין. **רק המסך יודע מה הוא באמת צורך.**
  const hasComparison =
    prevStats.operations > 0 || prevStats.errors > 0 || prevUptime.totalHours > 0;

  // ⚠️ אותה נוסחה בדיוק כמו percentChange בשרת, כולל מקרה הקצה: תקופה קודמת
  // ריקה אינה "ירידה של 100%" אלא **אין נתון** (null). אתר חדש היה מוצג
  // כקורס, וזה בדיוק סוג המספר שגורם לפתוח חקירה על כלום.
  const pct = (cur, prev) => {
    if (!Number.isFinite(prev) || prev === 0) return cur === 0 ? 0 : null;
    return Math.round(((cur - prev) / prev) * 1000) / 10;
  };
  const trendOf = (current, previous) => ({
    current, previous,
    changePercent: hasComparison ? pct(current, previous) : null,
  });

  return {
    period: period || "week",
    ...(PERIOD_META[period] || PERIOD_META.week),
    hasComparison,
    range: b.range,
    stats,
    uptime,
    cycles: {
      // null — טבלת operations אינה שומרת את מונה הבקר לכל הודעה.
      deltaInPeriod: null,
      totalFromPLC: site?.plc_cycle_last ?? null,
      countedTotal: site?.cycle_total ?? null,
    },
    trend: {
      operations: trendOf(stats.operations, prevStats.operations),
      errors: trendOf(stats.errors, prevStats.errors),
      failureRate: trendOf(stats.failureRate, prevStats.failureRate),
      availability: trendOf(uptime.availabilityPercent, prevUptime.availabilityPercent),
    },
    chart,
  };
}

// ============================================================
// כתיבה — ולא רק קריאה
// ============================================================
// ⚠️ **זה המתג הראשון שעובר על פעולת כתיבה.** עד כה שני הזרועות היו
// "קרא מ-Supabase" מול "קרא מהשרת"; כאן הן "כתוב ל-Supabase" מול "כתוב
// דרך השרת", והשמירה על זהות ההתנהגות חשובה יותר — כתיבה שנופלת בין
// הזרועות משאירה מצב שונה במסד, ולא רק תצוגה שונה.
//
// ⚠️ שני ההבדלים הידועים, ושניהם לטובה בזרוע הישירה:
//   • `name` אינו נשלח — הוא נגזר מהזהות המאומתת במסד.
//   • שורת ביקורת ב-audit_log נכתבת בפועל. בזרוע השרת היא console.log.
//
// ⚠️ ובזרוע השרת `name` **כן** חובה (400 בלעדיו), ולכן הוא נשאר בחתימה.
// חתימה שונה בין הזרועות הייתה הופכת את המתג לשני מסלולי קוד במסך.

/** פתיחת חלון תחזוקה. `name` נדרש רק בזרוע השרת — ראה למעלה. */
export async function startMaintenance(code, name, durationHours, reason = "") {
  if (!useDirect) return startMaintenanceViaServer(code, name, durationHours, reason);
  return startMaintenanceDirect(code, durationHours, reason);
}

/** ביטול חלון התחזוקה הפעיל. */
export async function cancelMaintenance(code) {
  if (!useDirect) return cancelMaintenanceViaServer(code);
  return cancelMaintenanceDirect(code);
}

// ============================================================
// כתיבת אתרים — וכאן שתי הזרועות **אינן** שקולות
// ============================================================
// ⚠️ בכל שאר המתג ההבטחה היא "אותה התנהגות, מסלול אחר". כאן זה לא נכון,
// ושתי אי-השקילויות חייבות להיות מוצהרות:
//
//   1. **ההרשאה שונה.** הזרוע הישירה דורשת תפקיד `manager` מאומת; זרוע
//      השרת דורשת את הקוד המשותף `admin123`. הן לא מגנות על אותו דבר.
//
//   2. **`POST /api/sites` בשרת שבור** (שש עמודות, שמונה מקומות — ראה
//      `sitesWriteDirect.js`). כלומר רישום אתר **עובד רק במצב הישיר**.
//
// ⚠️ ולכן `VITE_SUPABASE_DIRECT=false` אינו נסיגה שלמה כאן — הוא מחזיר גם
// את הבאג. זה נרשם במפורש כדי שלא ייראה כמו "המתג עובד בשני הכיוונים".

/** רישום אתר חדש. `{ ok, site }` בשתי הזרועות. */
export async function registerSite(payload) {
  if (!useDirect) return registerSiteViaServer(payload);
  return registerSiteDirect(payload);
}

/** עדכון אתר. שדה חסר = "אל תיגע"; `plc_type: ""` = "מחק". */
export async function updateSite(code, payload) {
  if (!useDirect) return updateSiteViaServer(code, payload);
  return updateSiteDirect(code, payload);
}

/** מחיקת אתר. `{ ok, deleted: { code, name, operations, statusHistory } }`. */
export async function deleteSite(code) {
  if (!useDirect) return deleteSiteViaServer(code);
  return deleteSiteDirect(code);
}

/** מצב התחזוקה של אתר (יש/אין חלון פעיל). */
export async function fetchMaintenanceState(code) {
  if (!useDirect) return fetchMaintenanceViaServer(code);

  const { data: site, error: e1 } = await supabase
    .from("sites").select("id").eq("code", code).single();
  if (e1) throw new Error(e1.message);

  // "פעיל" = לא בוטל ועדיין לא פג. אותו תנאי בדיוק כמו getActiveMaintenance.
  const { data, error } = await supabase
    .from("maintenance_windows").select("*")
    .eq("site_id", site.id).is("cancelled_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("expires_at", { ascending: false }).limit(1);
  if (error) throw new Error(error.message);

  const active = data?.[0] ?? null;
  return { code, inMaintenance: Boolean(active), maintenance: active };
}

/**
 * דוח חודשי לטווח חופשי. שתי הזרועות מחזירות אותו מבנה.
 *
 * ⚠️ שתיהן קוראות לאותה פונקציית SQL (report_monthly) — הדוח הוא הגדרת מדד
 * ולא תצוגה, ולכן הוא נשאר במקום אחד. עותק שני שלו ב-JS היה נותן מספר
 * תקלות שונה ממה שמופיע על המסך לאותה תקופה.
 */
export function fetchMonthlyReport(code, from, to) {
  if (!useDirect) return fetchMonthlyReportViaServer(code, from, to);
  return fetchMonthlyReportDirect(code, from, to);
}

// זהה ל-resolvePeriod בשרת. "חודש" הוא 30 יום מתגלגלים — ולכן גם התווית.
const PERIOD_META = {
  week:  { label: "7 הימים האחרונים",  comparisonLabel: "לעומת השבוע הקודם" },
  month: { label: "30 הימים האחרונים", comparisonLabel: "לעומת 30 הימים הקודמים" },
  year:  { label: String(new Date().getFullYear()),
           comparisonLabel: `לעומת ${new Date().getFullYear() - 1}` },
};

// ============================================================
// גבולות התקופה — הכפילות המודעת היחידה בקובץ הזה
// ============================================================
// זהה ל-resolvePeriod ב-master/api/periods.js. אי אפשר לייבא מהשרת לדפדפן,
// ולכן ההגדרה חוזרת כאן. אם היא תשתנה שם היא חייבת להשתנות גם כאן — ולכן
// המתג נבדק **בשני המצבים** ומשווים מספרים, ולא רק "המסך עלה".
//
// ⚠️ המיושר-לחצות אינו קוסמטי: חלון שמתחיל בשעה שרירותית יוצר ימים חלקיים
// בשני הקצוות, והדלי של *היום* נופל מחוץ לסדרה.
//
// ⚠️ ו"חודש" הוא 30 יום מתגלגלים ולא "מה-1 בחודש": ב-3 בחודש המסך הראה
// שלושה ימים תחת הכותרת "חודש", וכל המדדים קרסו לכמעט-אפס בתחילת כל חודש.
// ============================================================
// ⚠️ גבולות היום הם **חצות מקומית**, לא חצות UTC
// ============================================================
// נתפס בפועל: בחירת "היום" החזירה 63 פעולות במצב ישיר מול 66 דרך השרת.
// הסיבה — כתבתי `${date}T00:00:00.000Z`, כלומר חצות **UTC**, בזמן ש-
// resolveRange בשרת בונה `new Date(y, m-1, d, 0,0,0,0)` — חצות **מקומית**.
//
// בישראל בקיץ הפער הוא שלוש שעות, ולכן כל פעולה שקרתה בין 00:00 ל-03:00
// לפי שעון ישראל נעלמה מהדוח. שלוש פעולות, כולן בכניסות — בדיוק סוג ההפרש
// שנראה כמו "טעות עיגול" ואינו כזה.
//
// כל המערכת מיושרת לחצות מקומית (ראה api/periods.js), וזה הכלל.
function dayStartIso(ymd) {
  const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}

function dayEndIso(ymd) {
  const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
}

function periodFromIso(period) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);

  if (period === "year") return new Date(d.getFullYear(), 0, 1).toISOString();
  d.setDate(d.getDate() - (period === "month" ? 29 : 6));
  return d.toISOString();
}

/**
 * הטווח הנוכחי **והקודם** + הגרעיניות — זהה ל-resolvePeriod בשרת.
 *
 * ⚠️ התקופה הקודמת אינה קישוט: היא המכנה של כל "לעומת התקופה הקודמת" במסך.
 * שנה היא היחידה שאינה מתגלגלת — היא קלנדרית (1 בינואר), וכך גם הקודמת.
 */
function periodBounds(period) {
  const now = new Date();
  const iso = (d) => d.toISOString();

  if (period === "year") {
    const from = new Date(now.getFullYear(), 0, 1);
    return {
      range: { from: iso(from), to: iso(now) },
      prev: { from: iso(new Date(now.getFullYear() - 1, 0, 1)), to: iso(from) },
      granularity: "month",
    };
  }

  const days = period === "month" ? 30 : 7;
  const at = (back) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - back);
    return d;
  };
  const from = at(days - 1);
  return {
    range: { from: iso(from), to: iso(now) },
    prev: { from: iso(at(days * 2 - 1)), to: iso(from) },
    granularity: "day",
  };
}

/** תחילת חלון השבוע — נשאר בשמו כי fetchSitesList תמיד שבועי. */
function weekFromIso() {
  return periodFromIso("week");
}

// ⚠️ שבוע **לפני** תחילת השבוע הנוכחי, ולא "14 יום אחורה": הטווח הקודם חייב
// להיגמר בדיוק היכן שהנוכחי מתחיל, אחרת שני החלונות חופפים ואותה תקלה
// נספרת בשניהם — מה שמקהה כל שינוי.
function prevWeekFromIso() {
  const from = new Date(weekFromIso());
  const span = Date.now() - from.getTime();
  return new Date(from.getTime() - span).toISOString();
}
