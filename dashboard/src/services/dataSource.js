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
  fetchUsers as fetchUsersViaServer,
  setUserActive as setUserActiveViaServer,
  setUserRole as setUserRoleViaServer,
} from "./api";
import { fetchActivityDirect } from "./activityDirect";
import { fetchInsightsDirect } from "./insightsDirect";
import { fetchSiteDetailDirect, fetchSiteAnalyticsDirect } from "./detailDirect";
import { fetchMonthlyReportDirect } from "./reportDirect";
import { fetchExecutiveDirect } from "./executiveDirect";
import { fetchSitesDirect } from "./sitesDirect";
import { fetchSupervisorDirect } from "./supervisorDirect";
import { startMaintenanceDirect, cancelMaintenanceDirect } from "./maintenanceDirect";
import { markAsTestDirect, unmarkTestDirect, reclassifyStatusDirect } from "./reportsDirect";
import { fetchServerHealthDirect } from "./healthDirect";
import {
  inviteUser as inviteUserViaServer,
  deleteUser as deleteUserViaServer,
  verifyAdminCode as verifyAdminCodeViaServer,
  changeAdminCode as changeAdminCodeViaServer,
  fetchServerHealth as apiFetchServerHealth,
} from "./api";
import { inviteUserDirect, deleteUserDirect } from "./usersInviteDirect";
import { verifyAdminCodeDirect, setAdminCodeDirect } from "./adminCodeDirect";
import { registerSiteDirect, updateSiteDirect, deleteSiteDirect } from "./sitesWriteDirect";
import { fetchUsersDirect, setUserActiveDirect, setUserRoleDirect } from "./usersDirect";
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
    // ============================================================
    // ⚠️ "עכשיו" מעוגל כלפי מטה ל-30 שניות — וזה תיקון ביצועים אמיתי
    // ============================================================
    // הגרסה הקודמת קראה `new Date()`, כלומר **כל קריאה קיבלה חותמת
    // שונה במילישניות**:
    //
    //     קריאה 1:  to = 2026-08-31T06:23:00.123Z
    //     קריאה 2:  to = 2026-08-31T06:23:00.789Z
    //
    // התוצאה: שתי קריאות שהן לכל דבר **אותה שאלה** נראו שונות. איחוד
    // הבקשות ב-executiveDirect לא תפס אותן, חסם הקצב ב-useExecutiveStats
    // לא תפס אותן, וכל טעינה של המסך שלפה הכול פעמיים — נמדד בדפדפן
    // ארבע פעמים ברצף:
    //
    //     site_stats  1.26s ו-1.12s · executive_series  2.51s ו-2.32s
    //
    // ⚠️ המחיר, במפורש: החלון מסתיים בעד 30 שניות לפני "עכשיו". זו
    // אגרגציה על 30 יום — 30 שניות הן 0.001% ממנה, ובלתי נראות. שתי
    // שליפות כבדות בכל טעינה — נראות מאוד.
    //
    // ⚠️ **כלפי מטה ולא כלפי מעלה**: עיגול קדימה היה סופר אל תוך העתיד,
    // וזה בדיוק מה שהשורה שמעליה נזהרת ממנו.
    : new Date(Math.floor(Date.now() / 30_000) * 30_000).toISOString();

  const spanDays = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86400000));

  // ============================================================
  // ⚠️ הרזולוציה שהמשתמשת בחרה — לא רק זו שנגזרת מאורך הטווח
  // ============================================================
  // params.granularity הגיע לכאן מ-FilterBar בכל בקשה, והשורות האלה
  // דרסו אותו. כלומר **בורר הרזולוציה לא עשה כלום במצב הישיר** — שהוא
  // המצב שרץ היום. בחרת "חודשית", קיבלת יומי, וכותרת המשנה אמרה "יומית"
  // ליד בורר שמראה "חודשית".
  //
  // ⚠️ ובנוסף הגזירה עצמה נבדלה מהשרת: כאן 90 יום ⇐ חודשי, שם 31 ⇐ יומי
  // ו-180 ⇐ שבועי, ו-"week" לא היה קיים כאן בכלל. אותו טווח בן 120 יום
  // הצטייר בעמודות חודשיות בזרוע אחת ובשבועיות בשנייה. שתי הזרועות חייבות
  // להחזיר את אותה צורה — זו כל התכלית של המתג.
  const chosen = ["day", "week", "month"].includes(params.granularity)
    ? params.granularity
    : null;

  const granularity = chosen
    ?? (explicit
      ? (spanDays <= 31 ? "day" : spanDays <= 180 ? "week" : "month")
      : (period === "year" ? "month" : "day"));

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

// ============================================================
// ⚠️ `name` עובר עכשיו **בשתי הזרועות**
// ============================================================
// קודם הוא נשלח רק לשרת, והזרוע הישירה זרקה אותו — כי `set_by_name`
// נגזר מהאסימון ולא מגוף הבקשה. הכלל ההוא נכון ולא השתנה.
//
// ⚠️ אבל הוא עונה על "איזה **חשבון**", לא על "**מי**". החשבון
// sherut@parkomat.co.il הוא תיבה משותפת, ולכל שמונת המשתמשים אין
// full_name — כך שכל חלון תחזוקה נרשם על כתובת מייל שאינה מזהה אדם.
//
// עכשיו נשמרים **שניהם**: `set_by_name` המאומת, ו-`performed_by`
// המוקלד. מי שקורא את היומן רואה את שניהם ויודע מה מאומת ומה נאמר.
export async function startMaintenance(code, name, durationHours, reason = "") {
  if (!useDirect) return startMaintenanceViaServer(code, name, durationHours, reason);
  return startMaintenanceDirect(code, durationHours, reason, name);
}

/** ביטול חלון התחזוקה הפעיל. */
// ⚠️ **גם הביטול נושא שם.** זו הפעולה שמחזירה אתר לספירה: מרגע
// הביטול תקלות נספרות שוב והזמינות מושפעת. מי שסוגר חלון מוקדם עושה
// החלטה תפעולית, ולא פחות מזו שפתחה אותו.
export async function cancelMaintenance(code, name) {
  if (!useDirect) return cancelMaintenanceViaServer(code, name);
  return cancelMaintenanceDirect(code, name);
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

// ============================================================
// ניהול משתמשים — שלוש פעולות מתוך חמש
// ============================================================
// ⚠️ **`inviteUser` עברה ל-Edge Function** (services/usersInviteDirect.js):
// היא דורשת את ה-Secret, ומרגע שהדשבורד עבר ל-Cloudflare ה-master אינו
// נגיש ממנו — מאחורי NAT ובלי כתובת ציבורית. הסוד נשאר בצד השרת, אבל
// בצד השרת של Supabase ולא שלנו.
//
// ⚠️ **`deleteUser` אינה כאן, ולא תהיה עדיין.** היא עוברת ב-Admin
// API של GoTrue, כלומר דורשות את מפתח ה-Secret — שאסור לו להגיע לדפדפן
// (כלל 7 בשורש CLAUDE.md: הוא עוקף RLS לגמרי). `UsersPanel` מייבא אותן
// מ-`services/api` ישירות, וזה נכון: אין להן זרוע שנייה.
//
// ⚠️ ולכן מסך המשתמשים הוא **חצי-חצי** גם במצב ישיר, וזה נאמר במפורש כדי
// שלא ייראה כמו מסלול שנשכח.

/** רשימת המשתמשים. `{ users: [...] }` בשתי הזרועות. */
export async function fetchUsers() {
  if (!useDirect) return fetchUsersViaServer();
  return fetchUsersDirect();
}

/** השבתה או החזרה לפעילות. שני מגני הנעילה נאכפים בשתי הזרועות. */
export async function setUserActive(id, isActive) {
  if (!useDirect) return setUserActiveViaServer(id, isActive);
  return setUserActiveDirect(id, isActive);
}

/** שינוי תפקיד. העלאה תמיד מותרת; הורדה כפופה לאותם מגנים. */
export async function setUserRole(id, role) {
  if (!useDirect) return setUserRoleViaServer(id, role);
  return setUserRoleDirect(id, role);
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
    // ⚠️ גם lte על started_at: חלון מתוזמן למחר אינו פעיל היום. בלי זה
    // האתר היה מסומן כבתחזוקה מרגע התזמון — יום לפני שמישהו נגע בו.
    .lte("started_at", new Date().toISOString())
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

// ============================================================
// סימון דיווח כניסוי — **אין זרוע שרת, וזו הצהרה**
// ============================================================
// ⚠️ בכל שאר המתג קיימות שתי זרועות. כאן קיימת אחת: אין מסלול שרת שמסמן
// דיווח כניסוי, ולא נבנה כזה. הסיבה היא שהכלל — "מנהל בלבד" — נשען על
// `app.require_manager()` שקורא תפקיד מאומת מ-`app_users`. הזרוע דרך
// השרת מגינה בקוד המשותף `admin123`, שערכו בקוד הפתוח, ולכן היא הייתה
// **מחלישה** את ההגנה על הפעולה שמשנה את המספרים שמסתכלים עליהם.
//
// ⚠️ ולכן הזרוע השנייה זורקת הודעה מפורשת ולא נופלת חזרה בשקט. נפילה
// שקטה לשרת הייתה הופכת מצב `VITE_SUPABASE_DIRECT=false` ל"הכפתור לא
// עובד ואיש לא יודע למה".
export async function markAsTest(kind, id, note = "") {
  if (!useDirect) {
    throw new Error("סימון ניסוי זמין רק בקריאה ישירה ל-Supabase (VITE_SUPABASE_DIRECT=true)");
  }
  return markAsTestDirect(kind, id, note);
}

/** ביטול סימון הניסוי — הדיווח חוזר להיספר. */
export async function unmarkTest(kind, id) {
  if (!useDirect) {
    throw new Error("ביטול סימון ניסוי זמין רק בקריאה ישירה ל-Supabase");
  }
  return unmarkTestDirect(kind, id);
}

// ⚠️ **זרוע אחת, מאותו נימוק בדיוק כמו סימון הניסוי** — הכלל "מנהל בלבד"
// חי ב-app.is_manager() שקורא תפקיד מאומת. מסלול שרת היה מגן עליו ב-
// admin123 שערכו בקוד הפתוח, כלומר מחליש דווקא את הפעולה שמזיזה את
// אחוז הכשל. וגם כאן — זריקה מפורשת ולא נפילה שקטה.
export async function reclassifyStatus(id, to = "maintenance") {
  if (!useDirect) {
    throw new Error("סיווג מחדש זמין רק בקריאה ישירה ל-Supabase (VITE_SUPABASE_DIRECT=true)");
  }
  return reclassifyStatusDirect(id, to);
}


// ============================================================
// ניהול משתמשים וקוד המנהל — **חזרו למתג**
// ============================================================
// ⚠️ ארבע הפעולות האלה נכתבו בתחילה ישירות מול Supabase, מחוץ לקובץ הזה.
// התוצאה: `VITE_SUPABASE_DIRECT=false` החזיר את הקריאות והמדדים אבל
// **השאיר את ניהול המשתמשים שבור** — דלת חירום שנסדקה בלי שאיש ידע.
//
// ⚠️ ו-check-switch היה **ירוק** כל אותו זמן, כי הוא סרק רק את הקובץ הזה.
// שער שסורק קובץ אחד מאשר כל דבר שנכתב בקובץ שני. זה תוקן גם הוא.
//
// המסלולים בשרת קיימים ועובדים (נמדד: POST /api/users/invite מחזיר 200),
// ולכן זו חיווט ולא בנייה.

/** הזמנת משתמש. `{ ok, user, tempPassword }` בשתי הזרועות. */
export async function inviteUser(email, role = "operator") {
  if (!useDirect) return inviteUserViaServer(email, role);
  return inviteUserDirect(email, role);
}

/** מחיקת משתמש. ⚠️ שני המנעולים נאכפים בשתי הזרועות — במסד ובשרת. */
export async function deleteUser(id) {
  if (!useDirect) return deleteUserViaServer(id);
  return deleteUserDirect(id);
}

/** אימות קוד המנהל. מחזיר true/false; אינו זורק על קוד שגוי. */
export async function verifyAdminCode(code) {
  if (!useDirect) {
    // ⚠️ זרוע השרת **זורקת** על קוד שגוי (401), והישירה מחזירה false.
    // הנרמול כאן הוא מה שהופך את זה למתג ולא לשני מסלולי קוד במסך.
    try { await verifyAdminCodeViaServer(code); return true; }
    catch { return false; }
  }
  return verifyAdminCodeDirect(code);
}

/** החלפת קוד המנהל. מנהל בלבד, ונדרש הקוד הנוכחי. */
export async function changeAdminCode(current, next) {
  if (!useDirect) return changeAdminCodeViaServer(current, next);
  return setAdminCodeDirect(current, next);
}

/**
 * חלון תחזוקה **מתוזמן** — עם שעת התחלה וסיום מפורשות.
 *
 * ⚠️ **אין זרוע שרת, וזו הצהרה.** המסלול בשרת מקבל משך בלבד ומתחיל תמיד
 * מעכשיו; תזמון לעתיד לא היה קיים שם מעולם. הוספתו הייתה בניית תכונה
 * במסלול שהוא דלת חירום ולא יעד — ולכן הזרוע השנייה זורקת הודעה מפורשת
 * במקום ליפול בשקט.
 */
export async function scheduleMaintenance(code, startAt, endAt, reason = "") {
  if (!useDirect) {
    throw new Error("תזמון תחזוקה זמין רק בקריאה ישירה ל-Supabase");
  }
  const { data, error } = await supabase.rpc("schedule_maintenance", {
    p_site_code: String(code),
    p_start_at: startAt,
    p_end_at: endAt,
    p_reason: reason || null,
  });
  if (error) throw new Error(error.message || "תזמון התחזוקה נכשל");
  const row = Array.isArray(data) ? data[0] : data;
  return { id: row?.id ?? null, startedAt: row?.started_at, expiresAt: row?.expires_at };
}

// ============================================================
// בריאות השרת — שתי זרועות, ובכוונה שונות זו מזו
// ============================================================
// ⚠️ שאר המסלולים כאן מחזירים את אותו נתון משני מקורות. כאן שתי הזרועות
// שואלות שאלות שונות, וזה נכון:
//
//   ישיר  — קוראים את אות החיים ש**השרת כתב על עצמו** ל-Supabase. הדשבורד
//           עצמו אינו נוגע בשרת, ולכן זו הדרך היחידה לדעת עליו משהו.
//   שרת   — עצם ההגעה ל-/health היא התשובה. אין צורך בחותם.
//
// ⚠️ והמקרה שבגללו זה נבנה קיים **רק בזרוע הישירה**: שם הדשבורד עובד מצוין
// מול Supabase בזמן שהקליטה מתה, ומציג נתוני אתמול כאילו הם של עכשיו.
export async function fetchServerHealth(staleAfterSeconds = 300) {
  if (!useDirect) return apiFetchServerHealth();
  return fetchServerHealthDirect(staleAfterSeconds);
}

// ============================================================
// דיווחים והודעות מערכת — **אין להם זרוע שרת, וזה מוצהר**
// ============================================================
// ⚠️ הם עוברים דרך כאן ולא מיובאים ישירות ברכיבים, למרות שאין מה לבחור
// ביניהם. הסיבה היא ה-seam עצמו: `check-switch` אוכף שכל גישה לנתונים
// עוברת במקום אחד, וחריגה אחת שנראית מוצדקת היא בדיוק איך שהכלל נשחק.
//
// ⚠️ ומה שכן שונה כאן, ונאמר במפורש: **התכונות האלה קיימות רק במצב
// הישיר.** הן נולדו אחרי שהמתג הוכרע ומעולם לא היה להן נתיב שרת; בנייתו
// "לשלמות" הייתה יוצרת קוד רדום שאיש לא מריץ — וקובץ ההנחיות אומר בדיוק
// מה קורה לנתיב כזה.
//
// לכן `VITE_SUPABASE_DIRECT=false` **מסתיר את הכפתור** (ראה Header) במקום
// להציע מסך שייכשל. מסך שמציע פעולה שאינה אפשרית הוא הדרך האמינה לגרום
// למישהו להסיק שהמערכת שבורה.
export {
  submitFieldReport, fetchFieldReports, fetchReportImage, resolveFieldReport, deleteFieldReport,
  fetchReplies, replyToReport, MAX_FILES, MAX_BODY, MIN_NAME,
} from "./fieldReportsDirect";

export {
  pendingAnnouncement, markAnnouncementSeen, publishAnnouncement,
  fetchAnnouncements, MAX_TITLE, MAX_ANN_BODY,
} from "./announcementsDirect";

export { subscribeNewReports } from "./reportsLiveDirect";
export { subscribeReload, broadcastReload } from "./reloadDirect";

export {
  requestServiceRestart, recentServiceCommands, subscribeServiceCommands,
} from "./serviceCommandsDirect";
