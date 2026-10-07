// hooks/useSites.js — שליפת וניהול רשימת כל האתרים
import { useState, useEffect, useCallback, useRef } from "react";
// ה-hook לא יודע מאיפה הנתונים מגיעים — dataSource מכריע, והמבנה זהה
// בשני המסלולים. ראה services/dataSource.js לתוכנית ב'.
import { fetchSitesList } from "../services/dataSource";
import { applySiteUpdate } from "../utils/sitePatch";
import { mergeCompliance, complianceFailed, complianceFetched } from "../utils/complianceMerge.js";
import { keepLastService } from "../utils/serviceMerge.js";
import { keepLastStats, statsMissing } from "../utils/siteSync.js";

// ⚠️ כל כמה זמן הרשימה שולפת גם את רמזורי הבודק/התחזוקה. הם משתנים לכל היותר
// פעם ביום (מעבר ספים בחצות), או באירוע — ואירוע מטופל בשליפה ממוקדת של אתר
// אחד ב-App. שליפה של כל האתרים בכל דקה בכל מסך פתוח הייתה עלות תעבורה בלי
// שום מידע חדש.
const COMPLIANCE_EVERY_MS = 5 * 60 * 1000;

// ============================================================
// ⚠️ הודעה לבן אדם, לא ל-console
// ============================================================
// `TypeError: Failed to fetch` על מסך עברי בחדר בקרה אינו אומר דבר למי
// שקורא אותו, ובעיקר אינו אומר **מה לעשות**. הוא גם נראה כמו תקלה
// במערכת בזמן שברוב המקרים זו קפיצת רשת של שתי שניות.
//
// ⚠️ ההודעה המקורית לא נמחקת אלא נבלעת בכוונה רק כשזיהינו אותה: שגיאה
// שאיננו מכירים חייבת להגיע למסך כמות שהיא, אחרת נסתיר בדיוק את התקלה
// שאיש עוד לא ראה.
function humanError(err) {
  const msg = String(err?.message ?? err ?? "");
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "אין חיבור לאינטרנט. המסך יתעדכן כשהחיבור יחזור.";
  }
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return "לא הצלחנו להגיע לשרת הנתונים. ייתכן נתק רשת רגעי — מנסים שוב אוטומטית.";
  }
  return msg;
}

export function useSites({ hold = false } = {}) {
  const [sites, setSites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // ============================================================
  // ניסיון שני לפני שמכריזים על שגיאה
  // ============================================================
  // ⚠️ `TypeError: Failed to fetch` הוא כשל **ברמת הדפדפן** — הבקשה לא
  // יצאה או לא חזרה. הוא חולף כמעט תמיד: קפיצת Wi-Fi, חידוש אסימון, שנייה
  // שבה ה-DNS לא ענה. עד עכשיו כשל בודד כזה הודלף ישירות למסך, והשליפה
  // הבאה הייתה רק בעוד 60 שניות — כלומר דקה שלמה של הודעת שגיאה על סמך
  // תקלה שנמשכה חצי שנייה.
  //
  // ⚠️ שני ניסיונות ולא יותר, וזה מכוון: המטרה היא לבלוע רעש, לא להסתיר
  // נתק אמיתי. אם גם השני נכשל — זו כבר לא קפיצה, והמסך צריך לדעת.
  // ============================================================
  // ⚠️ שלושה ניסיונות עם השהיה גדלה — 1.5ש' לא הספיקו
  // ============================================================
  // שני ניסיונות בהפרש 1.5 שניות מכסים נתק של שנייה וחצי. נתק של חמש —
  // מעבר בין נקודות Wi-Fi, VPN שמתחבר מחדש, מחשב שהתעורר — עובר את שניהם,
  // והמסך נשאר ריק עם `TypeError: Failed to fetch` **עד השליפה הבאה, בעוד
  // 60 שניות**. זה מה שנראה על המסך בפועל.
  //
  // 1.5 ואז 4 שניות מכסים כשש שניות בסך הכול, ועדיין אינם מסתירים נתק
  // אמיתי: מי שבאמת מנותק יראה את ההודעה, רק שש שניות מאוחר יותר.
  const RETRY_DELAYS = [1500, 4000];

  // ============================================================
  // ⚠️ שתי שליפות במקביל — והישנה עלולה לנצח
  // ============================================================
  // loadSites נקראת מארבעה מקומות: הטעינה הראשונית, הרענון התקופתי
  // (60ש'), `online`, ו-`visibilitychange`. עם עד שני ניסיונות חוזרים
  // ובהשהיה של 5.5 שניות, קל מאוד ששתיים ירוצו יחד — למשל מחשב שהתעורר
  // משינה מפעיל את שניהם ברצף.
  //
  // ⚠️ ואז מי שמסיים אחרון קובע, ולא מי שהתחיל אחרון: שליפה איטית שהחלה
  // לפני השינוי דורסת את התוצאה החדשה. המסך חוזר למצב ישן **אחרי**
  // שהראה את החדש, בלי שגיאה ובלי סימן, עד הרענון הבא.
  //
  // ⚠️ וגם `setError(null)` נדרס כך: שליפה ישנה שנכשלה מציבה הודעת
  // שגיאה על מסך שכבר קיבל נתונים תקינים.
  const seq = useRef(0);
  const lastComplianceAt = useRef(0);
  const patchedAt = useRef({});          // site id → מתי הוחלף ה-compliance שלו ב-patchSite

  // ============================================================
  // ⚠️ טעינה אחת בכל רגע (07/10/2026)
  // ============================================================
  // seq דואג שהתוצאה הישנה לא תדרוס את החדשה — אבל שתי הטעינות עדיין רצות במסד.
  // כשהשרת איטי, טעינה אורכת יותר מהמרווח בין הטריגרים והן נערמות זו על זו.
  // עכשיו: אם טעינה כבר רצה, נרשמת **אחת** נוספת ורצה כשהראשונה מסתיימת.
  const inFlight = useRef(false);
  const again = useRef(false);
  const loadRef = useRef(null);

  // ============================================================
  // ⚠️ הסטטיסטיקות — רק בכניסה לדף (07/10/2026)
  // ============================================================
  // טעינה רגילה היא **חיה**: מצב, תקלה, תחזוקה. הסטטיסטיקות (פעולות, זמינות,
  // מגמה) — רק כשמבקשים במפורש (reloadStats: פתיחה, מעבר דף, חזרה ללשונית), או
  // כשיש ברשימה אתר שעוד לא חושבה לו (אתר חדש). ראו utils/siteSync.js.
  const wantStats = useRef(true);          // הטעינה הראשונה — תמיד עם הסטטיסטיקות
  const statsIds = useRef(new Set());     // אתרים שכבר הגיעו בטעינה עם סטטיסטיקות

  const loadSites = useCallback(async ({ stats = false } = {}) => {
    if (stats) wantStats.current = true;
    if (inFlight.current) { again.current = true; return; }
    inFlight.current = true;
    try {
      await loadOnce();
    } finally {
      inFlight.current = false;
      if (again.current) { again.current = false; loadRef.current?.(); }
    }
  }, []);
  loadRef.current = loadSites;

  async function loadOnce() {
    const mine = ++seq.current;
    const stale = () => mine !== seq.current;
    const withStats = wantStats.current;
    wantStats.current = false;

    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        const withCompliance = Date.now() - lastComplianceAt.current >= COMPLIANCE_EVERY_MS;
        const startedAt = Date.now();
        const data = await fetchSitesList({ withCompliance, withStats });
        if (stale()) return;          // שליפה חדשה יותר כבר בדרך
        // כשל ברמזורי הבודק אינו מקדם את השעון — השליפה הבאה תנסה שוב, ולא בעוד
        // חמש דקות. (פס "אינו מתעדכן" בראש המסך הוסר לבקשת בעלת המוצר, 04/10;
        // המנורות עצמן מציגות "?" מקווקו כשהסטטוס לא נטען — הן לא נעלמות.)
        if (complianceFetched(data) && !complianceFailed(data)) lastComplianceAt.current = Date.now();
        // ⚠️ "הגיעו סטטיסטיקות" — לפי השורות ולא לפי הבקשה: בזרוע השרת כל טעינה מלאה
        if (!data.some((s) => s && s.statsSkipped)) {
          statsIds.current = new Set(data.map((s) => s.id));
        } else if (statsMissing(data, statsIds.current)) {
          // אתר חדש — בלי זה הוא היה מציג "0 פעולות" עד הכניסה הבאה לדף
          wantStats.current = true;
          again.current = true;
        }
        setSites((prev) => {
          // טעינה חיה — שדות הסטטיסטיקה מהרשימה שעל המסך (siteSync), ואז:
          // כשל בשעות השירות — הערך האחרון הידוע, לא "בסיסי" ו-24/7 לדקה (serviceMerge)
          const { list, missing } = mergeCompliance(prev, keepLastService(prev, keepLastStats(prev, data)), startedAt, patchedAt.current);
          // אתר חדש (או שנוסף מאז הסבב האחרון) — הסבב הבא שולף רמזורים, לא בעוד 5 דקות
          if (missing) lastComplianceAt.current = 0;
          return list;
        });
        setError(null);
        setLoading(false);
        return;
      } catch (err) {
        if (stale()) return;
        // ⚠️ ניסיון חוזר רק על נתק רשת רגעי. שגיאה מהשרת (עומס, timeout, 5xx) — ניסיון
        // חוזר מיידי רק מוסיף עומס על שרת שכבר מתקשה (07/10/2026); הבדיקה הבאה תנסה.
        const transient = /failed to fetch|networkerror|load failed/i.test(String(err?.message ?? err ?? ""));
        if (attempt === RETRY_DELAYS.length || !transient) {
          // סטטיסטיקות שמעולם לא הגיעו — הטעינה הבאה תנסה שוב איתן. אם כבר יש
          // כאלה על המסך, הן נשארות עד הכניסה הבאה (לא מכבידים על מסד שנכשל).
          if (withStats && statsIds.current.size === 0) wantStats.current = true;
          setError(humanError(err));
          setLoading(false);
          return;
        }
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
      }
    }
  }

  // עדכון מקומי מהודעת SSE — בלי בקשת רשת.
  // applySiteUpdate מחזיר את *אותו* מערך אם אין מה לעדכן, ולכן React
  // לא מרנדר מחדש לחינם.
  /**
   * החלפת שדות של אתר אחד בלי שליפה (למשל `compliance` אחרי אירוע — D20).
   * @param {string} code
   * @param {object} fields
   */
  const patchSite = useCallback((code, fields) => {
    setSites((current) => {
      const i = current.findIndex((s) => s.code === code);
      if (i === -1) return current;
      // חותמת — כדי ששליפה מלאה שיצאה לפני העדכון הזה לא תדרוס אותו (mergeCompliance)
      if ("compliance" in fields) patchedAt.current[current[i].id] = Date.now();
      const next = current.slice();
      next[i] = { ...current[i], ...fields };
      return next;
    });
  }, []);

  const patch = useCallback((msg) => {
    setSites((current) => applySiteUpdate(current, msg));
  }, []);

  // טעינה ראשונית
  // ============================================================
  // ⚠️ `hold` — מסך אחר קודם, והטעינה הזו מחכה לו
  // ============================================================
  // נמדד (24/09/2026): במסך ההנהלה הטעינה הזו רצה **במקביל** ל-11 השאילתות
  // של המסך עצמו — site_stats ×2, site_uptime, site_globals, והכבדה מכולן
  // site_uptime_service (≈1.1s) — על מסד חינמי שכבר עמוס ברענוני הכרטיסים.
  // כ-17 שאילתות כבדות ברגע הפתיחה, בשביל מסך שאינו מוצג.
  //
  // ⚠️ **נדחית ולא מבוטלת.** useFaultAlerts נשען על הרשימה הזו בכל תצוגה,
  // ומסך ההנהלה אינו פוטר מהתראות תקלה. בזמן ההמתנה patch ממשיך לעבוד;
  // reload שנקרא נרשם ורץ ברגע השחרור.
  const pendingLoad = useRef(true);
  useEffect(() => {
    if (hold || !pendingLoad.current) return;
    pendingLoad.current = false;
    loadSites();
  }, [hold, loadSites]);

  // טעינה חיה — מצב, תקלה, תחזוקה. הסטטיסטיקות נשמרות מהטעינה הקודמת.
  const reload = useCallback(() => {
    if (hold) { pendingLoad.current = true; return; }
    loadSites();
  }, [hold, loadSites]);

  // כניסה לדף — גם הסטטיסטיקות (~12 שניות במסד; לא לקרוא מטיימר)
  const reloadStats = useCallback(() => {
    wantStats.current = true;
    if (hold) { pendingLoad.current = true; return; }
    loadSites();
  }, [hold, loadSites]);

  // ============================================================
  // ⚠️ חזרה מנתק — שולפים מיד, ולא ממתינים לשליפה הבאה
  // ============================================================
  // בלי זה המסך נשאר עם הודעת השגיאה **עד 60 שניות** אחרי שהרשת כבר
  // חזרה. מי שרואה את זה מרענן את הדף, וזו בדיוק הפעולה שאנחנו רוצים
  // שלא תידרש.
  //
  // ⚠️ שני אירועים ולא אחד: `online` תופס חזרת רשת, אבל מחשב שהתעורר
  // משינה לא בהכרח מפעיל אותו — שם `visibilitychange` הוא זה שיורה.
  // ⚠️ **רק כשיש שגיאה בפועל.** גרסה ראשונה של זה שלפה בכל מעבר לשונית,
  // כלומר הוסיפה בקשות בדיוק כשהכול תקין. כשאין שגיאה, השליפה התקופתית
  // (60ש') כבר עושה את העבודה, ואין מה למהר.
  const hasError = error !== null;
  useEffect(() => {
    if (!hasError) return undefined;

    const retry = () => {
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      loadSites();
    };
    const onVisible = () => { if (document.visibilityState === "visible") retry(); };

    // ⚠️ שני אירועים ולא אחד: `online` תופס חזרת רשת, אבל מחשב שהתעורר
    // משינה לא בהכרח מפעיל אותו — שם `visibilitychange` הוא זה שיורה.
    window.addEventListener("online", retry);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [hasError, loadSites]);

  return { sites, loading, error, reload, reloadStats, patch, patchSite };
}