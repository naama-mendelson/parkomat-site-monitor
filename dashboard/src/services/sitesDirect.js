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
import { displayStatusFor, systemsAgeMinutes } from "../../../shared/site-systems.mjs";
import { toCompliance } from "../utils/compliance";
import { effectiveTier } from "../utils/tier";

/**
 * רשימת האתרים עם כל המדדים, ישירות מבסיס הנתונים.
 *
 * @param {string} fromIso תחילת החלון לחישוב המדדים
 * @param {string} toIso   סופו (ברירת מחדל: עכשיו)
 * @returns {Promise<Array>} אותו מבנה בדיוק שהשרת מחזיר ב-GET /api/sites
 * @throws {Error} כדי להתנהג כמו fetchSites — useSites תופס ומציג
 */
/**
 * מצבי האתרים בלבד — שאילתה אחת על `sites`, בלי שום חישוב (אלפיות שנייה).
 * לבדיקת הדקה הזולה (utils/siteSync): האם המסך עדיין תואם את המסד. רק אם לא —
 * טעינה מלאה. (07/10/2026: הטעינה המלאה בכל דקה בכל מסך היא שהפילה את השרת.)
 * @returns {Promise<Array<{id:number, code:string, status:string}>>}
 */
export async function fetchSiteStatusesDirect() {
  if (!isSupabaseConfigured) {
    throw new Error("Supabase אינו מוגדר בדשבורד");
  }
  const { data, error } = await supabase.from("sites").select("id, code, status");
  if (error) {
    throw new Error(error.code === "42501" ? "אין הרשאת קריאה — נדרשת התחברות" : error.message);
  }
  return data || [];
}

export async function fetchSitesDirect(fromIso, toIso = new Date().toISOString(), prevFromIso = null, { withCompliance = true, withStats = true } = {}) {
  if (!isSupabaseConfigured) {
    throw new Error("Supabase אינו מוגדר בדשבורד");
  }

  // ⚠️ `withStats: false` — טעינה חיה: בלי ארבע קריאות הסטטיסטיקה (~12 שניות במסד
  // לטעינה, 07/10/2026). כל אתר יוצא עם `statsSkipped: true`, ו-useSites ממלא את
  // השדות מהטעינה הקודמת (keepLastStats ב-utils/siteSync.js).
  const skipped = { data: null, error: null };
  const stat = (fn, args) => (withStats ? supabase.rpc(fn, args) : Promise.resolve(skipped));

  // ⚠️ קריאה חמישית ולא סיבוב לכל אתר: site_stats מקבלת null ומחזירה שורה
  // לכל אתר, ולכן התקופה הקודמת עולה בדיוק כמו הנוכחית — אחת.
  const statsAt = Date.now();
  const [sitesRes, statsRes, uptimeRes, globalsRes, svcRes, prevRes, compRes] = await Promise.all([
    supabase.from("sites").select("*"),
    stat("site_stats",   { p_site_ids: null, p_from: fromIso, p_to: toIso }),
    stat("site_uptime",  { p_site_ids: null, p_from: fromIso, p_to: toIso }),
    supabase.rpc("site_globals", { p_site_ids: null }),
    // ⚠️ זמינות בתוך שעות השירות — מחזירה שורה **רק** לאתר שחובר
    // ברמזור (עמודת "קוד אתר"). אתר שלא חובר ממשיך על 24/7 כפי שהיה,
    // כלומר השינוי חל רק על מה שמישהו הגדיר במפורש.
    stat("site_uptime_service", { p_site_ids: null, p_from: fromIso, p_to: toIso }),
    prevFromIso
      ? stat("site_stats", { p_site_ids: null, p_from: prevFromIso, p_to: fromIso })
      : Promise.resolve({ data: [], error: null }),
    // ⚠️ רמזורי בודק מוסמך ותחזוקה מונעת — **אינה קטלנית**, כמו site_uptime_service.
    // כשל כאן לא יפיל את רשימת האתרים; כל אתר יקבל `{unknown:true}` (מנורה "?"),
    // ו-useSites ישמור את המצב האחרון הידוע עם סימון stale (D19).
    // ⚠️ ולא בכל שליפה: הרשימה נשלפת כל דקה בכל מסך פתוח, והרמזור משתנה
    // לכל היותר פעם ביום (או באירוע — ואז App שולף שורה אחת). useSites מבקש
    // אותה פעם בכמה דקות; כשלא התבקשה — `compliance: null` = "השאר את הקודם".
    withCompliance ? supabase.rpc("site_compliance", { p_site_ids: null }) : Promise.resolve(null),
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

  // ⚠️ **כשל בקריאה הזו אינו מפיל את הרשימה.** היא תוספת על מה שכבר
  // עובד; אתר בלי ערך פשוט ממשיך להציג 24/7. `svcRes.error` לא נכלל
  // ב-`failed` למעלה מאותה סיבה בדיוק.
  const svcById = new Map(((svcRes && svcRes.data) || []).map((r) => [r.site_id, r]));
  const prevById    = new Map((prevRes.data     || []).map((r) => [r.site_id, r]));
  // ⚠️ `compError` נשמר על כל אתר ולא נבלע: מנורה עם "?" וסיבה בחלונית
  // הריחוף אומרת "לא יודעים", ומנורה שנעלמת בשקט נראית כמו "אין מה לדווח".
  const compError = compRes?.error
    ? (compRes.error.code === "42501" ? "אין הרשאת קריאה" : compRes.error.message || "שגיאה")
    : null;
  const compById = new Map(((compRes && !compRes.error && compRes.data) || []).map((r) => [r.site_id, r]));

  return (sitesRes.data || []).map((site) => {
    const st = statsById.get(site.id);
    const up = uptimeById.get(site.id);
    const g  = globalsById.get(site.id) || {};
    const svc = svcById.get(site.id) || null;

    // תקלה שקורה בתוך תחזוקה מתוכננת אינה "תקלה" — היא כבר מוחרגת מאחוז
    // הכשל, וכאן היא לא הופכת את הכרטיס למושבת. אותו כלל בדיוק כמו בשרת;
    // אם הוא ישתנה שם ולא כאן, שני המסלולים יראו סטטוס שונה לאותו אתר.
    const inMaintenance = Boolean(g.maintenance_id);
    const status = inMaintenance || site.status === "maintenance"
      ? "maintenance"
      : site.status;


    return {
      ...site,
      // טעינה חיה: שדות הסטטיסטיקה שלמטה הם ברירת מחדל ולא ערך (keepLastStats).
      // statsAt — מתי חושבו, ו-null כשלא חושבו בשליפה הזו.
      statsSkipped: !withStats,
      statsAt: withStats ? statsAt : null,
      // ⚠️ רמת השירות מגיעה מהרמזור, ואתר בלי שורה בו הוא "לא חובר" —
      // ראה `effectiveTier`.
      tier: effectiveTier(svc, Boolean(svcRes?.error), site.tier),
      // ⚠️ **הדרגה שבמסד, בנפרד.** טופס העריכה נזרע מ-`tier` ושלח אותו תמיד,
      // ולכן שינוי שם של אתר מחובר **כתב את דרגת ההסכם לתוך `sites.tier`** —
      // והדרגה הידנית אבדה לצמיתות, גם אחרי ניתוק מהרמזור.
      manualTier: site.tier,
      status,
      inMaintenance,
      // ============================================================
      // ⚠️ אחוז הכשל בתוך שעות המסלול בלבד
      // ============================================================
      // תקלה שקרתה בשבת באתר עם מסלול בסיסי אינה כשל בשירות — אין
      // שירות בשבת. נמדד: 26 מתוך 28 האתרים זזו, לשני הכיוונים.
      // אפשטיין ירד מ-4.88% ל-0% (כל התקלות היו מחוץ לשעות), ומגדל 1
      // **עלה** מ-33.3% ל-37.8% (התקלות התרכזו דווקא בתוכן).
      //
      // ⚠️ **וגם המכנה מצטמצם, לא רק המונה.** ספירת תקלות בתוך השעות
      // מול פעולות של כל השבוע הייתה מייצרת אחוז נמוך באופן מלאכותי —
      // מספר שנראה טוב מפני שחושב לא נכון.
      //
      // ⚠️ **null ולא 0 כשאין פעולות בשעות השירות.** "0% כשל" קורא
      // כ"מושלם", והוא בדיוק המקרה שבו לא נמדד דבר.
      failureRate: svc
        ? (svc.failure_rate ?? null)
        : (st?.failure_rate ?? 0),

      // הנתונים הגולמיים, כדי שהמסך יוכל לומר על מה האחוז מחושב.
      serviceOperations: svc ? svc.operations : null,
      serviceErrors: svc ? svc.errors : null,
      operations:  st?.operations   ?? 0,
      errors:      st?.errors       ?? 0,
      // ⚠️ **?? null ולא ?? 0**, בשונה משלוש השורות שמעליי. אתר בלי תקלות
      // סגורות בטווח לא "טופל תוך אפס דקות" — אין לו נתון. אותה הבחנה
      // בדיוק כמו measuredHours = 0 בזמינות, שתי שורות מתחת.
      avgRepairMinutes:    st?.avg_repair_minutes    ?? null,
      medianRepairMinutes: st?.median_repair_minutes ?? null,
      longRepairCount:     st?.long_repair_count     ?? null,
      longRepairPercent:   st?.long_repair_percent   ?? null,
      quickRepairCount:    st?.quick_repair_count    ?? null,
      mediumRepairCount:   st?.medium_repair_count   ?? null,
      repairSeries:        st?.repair_minutes         ?? null,
      // measured_hours = 0 פירושו "אין נתון", ואז null כדי שהמסך יציג "—"
      // ולא "0%". "0%" נקרא כ"מושבת לגמרי" כשהמשמעות היא "איננו יודעים".
      // ============================================================
      // ⚠️ זמינות בתוך שעות השירות, כשהאתר חובר לרמזור
      // ============================================================
      // תקלה שקרתה בשבת באתר עם הסכם בסיסי אינה זמן שבו השירות נכשל —
      // אין שירות בשבת. עד כה היא נספרה ככשל מלא, וזה עיוות את המספר
      // לרעה דווקא באתרים שקנו פחות שירות.
      //
      // ⚠️ **החלפה ולא הוספה, במכוון.** שני מספרי זמינות לאותו אתר על
      // אותו מסך הם בדיוק הדרך שבה אנשים מפסיקים להאמין לשניהם.
      // ‏`serviceAgreement` הוא מה שאומר לכרטיס איזה מהם הוא מציג.
      //
      // ⚠️ ואתר בלי הסכם ממשיך על 24/7 בדיוק כפי שהיה — השינוי חל רק
      // על מה שמישהו חיבר במפורש.
      uptime: svc && svc.measured_hours > 0
        ? svc.availability_percent
        : (up && up.measured_hours > 0 ? up.availability_percent : null),

      compliance: !compRes ? null
        : compError ? { unknown: true, error: compError }
        : toCompliance(compById.get(site.id)),

      serviceAgreement: svc ? svc.agreement : null,
      // ⚠️ **המסלול אינו מחשב דבר** — הוא מה שנחתם. הוא נוסע לכרטיס
      // כדי שהפער בינו לבין השירות יהיה גלוי: 8 אתרים נמדדים היום לפי
      // הסכם שונה מזה שבחוזה, וזה היה בלתי-נראה לחלוטין.
      servicePlan: svc ? svc.plan : null,
      serviceHours: svc ? svc.service_hours : null,
      // ⚠️ הקריאה לשעות השירות נכשלה — כל השדות שלמעלה הם ברירת מחדל ולא ערך.
      // useSites מחליף אותם בערך האחרון הידוע (utils/serviceMerge.js).
      serviceStale: Boolean(svcRes?.error),
      // אותו כלל בדיוק כמו בשרת — siteTrend במודול המשותף.
      trend: siteTrend(
        { operations: st?.operations ?? 0, failureRate: st?.failure_rate ?? 0 },
        prevById.get(site.id)
          ? { operations: prevById.get(site.id).operations,
              failureRate: prevById.get(site.id).failure_rate }
          : null
      ),
      // ============================================================
      // ⚠️ אתר עם שתי מערכות בבקר אחד (פלורנטין)
      // ============================================================
      // ‏`status` נשאר **מצב אחד** — הטוב מבין השתיים, מאוחד כבר בסוכן —
      // ולכן הזמינות ואחוז הכשל מחושבים בדיוק כמו בכל אתר אחר.
      //
      // ⚠️ **וזה בדיוק מה שהופך את הפירוט להכרחי.** לפי הכלל שנקבע,
      // מערכת שנופלת לתקלה בזמן שהשנייה עובדת אינה משנה את מצב האתר:
      // הכרטיס יישאר ירוק. בלי השבבים האלה אין שום דבר על המסך שמעיד
      // שמערכת שלמה מושבתת.
      //
      // null = לאתר יש מערכת אחת. מערך = יש שתיים, והנה הן.
      // ⚠️ **הפירוט מוצג תמיד, גם כשהוא ישן** — ולצידו גילו. הגרסה הקודמת
      // הסתירה אותו, וזו הייתה החמרה: בפלורנטין `2 תחזוקה` מלפני עשר שעות
      // היה **נכון**, והלובי השמאלי באמת לא באוטומט. הסתרה מחקה בדיוק את
      // המידע שבגללו מסתכלים על הכרטיס.
      systems: Array.isArray(g.systems) && g.systems.length > 0 ? g.systems : null,
      // גיל הפירוט בדקות. null = אין חותמת. המסך מציג אותו כשהוא משמעותי.
      systemsAgeMin: systemsAgeMinutes(g.systems_seen_at),

      // ============================================================
      // ⚠️ באתר דו-מערכתי — **הצגה לפי הגרוע, מדידה לפי הטוב**
      // ============================================================
      // שתי שאלות שונות שהיו עד כה נתון אחד:
      //   "האם צריך לטפל בזה עכשיו?"  → המערכת הגרועה. מערכת שמתה היא
      //      סיבה לנסוע לאתר, גם אם השנייה מחזיקה את החניון פתוח.
      //   "האם עמדנו בהתחייבות?"       → המערכת הטובה. האתר שירת רכבים.
      //
      // ⚠️ **וזו הסיבה ש-`status` לא נוגע.** הוא מה שנכתב ל-
      // ‏`status_history`, וממנו מחושבות הזמינות ואחוז הכשל — שינוי שלו
      // היה מעביר גם אותם לגרוע, כלומר בדיוק ההפך ממה שנקבע.
      // ‏`displayStatus` הוא שכבת תצוגה בלבד: הצ'יפ והמיון.
      displayStatus: displayStatusFor(status, g.systems),

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
