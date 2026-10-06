// App.jsx — מעטפת: מחזיקה את ה-state המשותף (אתרים, SSE, תפקיד, אתר נבחר)
// ומנתבת לתצוגה לפי התפקיד. הפאנל והמודלים משותפים לכל התצוגות.
import { useState, useCallback, useEffect, useRef } from "react";
import { useSites } from "./hooks/useSites";
import { useSSE } from "./hooks/useSSE";
import { useSiteDetail } from "./hooks/useSiteDetail";
import { useTheme } from "./hooks/useTheme";
import Header from "./components/Header/Header";
// ⚠️ **הכרטיס פותח את הפירוט המלא ישירות.** קודם הוא פתח פאנל צד, וממנו
// היה צריך לגלול וללחוץ "הצג עוד מידע" כדי להגיע לגרפים — שני מסכים
// לאותו אתר, ורוב התוכן משוכפל ביניהם.
import InsightsModal from "./components/InsightsModal/InsightsModal";
import AdminPanel from "./components/AdminPanel/AdminPanel";
import TrafficLight from "./components/TrafficLight/TrafficLight";
import { useDirect, fetchSiteCompliance } from "./services/dataSource";
import { COMPLIANCE_TABS, toCompliance } from "./utils/compliance";
// מסגרת דקה בלבד — הלשונית שבתוכה נטענת בעצלות, כמו בחלון האתר
import InspectionPage from "./components/Compliance/InspectionPage";
import "./components/TrafficLight/TrafficLight.css";
import OperatorView from "./views/OperatorView/OperatorView";
import SupervisorView from "./views/SupervisorView/SupervisorView";
import ExecutiveView from "./views/ExecutiveView/ExecutiveView";
import Announcement from "./components/Announcement/Announcement";
import { needsRefetch } from "./utils/sitePatch";
import { useFaultAlerts } from "./hooks/useFaultAlerts";
// ⚠️ פס ולא חלון חוסם — ראה ההסבר בקובץ עצמו. מסך קיר שמתאתחל בלילה חייב
// להציג אתרים גם אם איש לא נגע בו.
import AlertUnlockBar from "./components/AlertBell/AlertUnlockBar";
import StaleBanner from "./components/StaleBanner/StaleBanner";
import { testAlert } from "./utils/audio/alerts";
import "./styles/global.css";
import "./styles/theme.css";

function App() {
  // ===== State מרכזי =====
  const [role, setRole] = useState("operator");                // בקר / מנהל בקרה / מנהל כללי
  const [activeFilters, setActiveFilters] = useState([]);       // סינון לפי מצב (בקר) — בחירה מרובה
  // ⚠️ מצב וסוג הם שני מסננים **שמצטלבים**, ולכן שני מצבים נפרדים: "מושבת"
  // + "דולי" = כל מתקני הדולי שמושבתים כרגע. מצב אחד משותף היה מאלץ לבחור
  // ביניהם במקום לשלב.
  const [typeFilter, setTypeFilter] = useState("");             // סינון לפי סוג מתקן ("" = הכל)
  const [systemFilter, setSystemFilter] = useState("");         // סינון לפי מערכת הפעלה ("" = הכל)
  const [tierFilter, setTierFilter] = useState("");             // סינון לפי רמת שירות ("" = הכל)
  const [searchQuery, setSearchQuery] = useState("");           // חיפוש (בקר)
  const [selectedCode, setSelectedCode] = useState(null);       // אתר נבחר (לפאנל)
  // הלשונית שהחלון **נפתח** עליה (מנורה בכרטיס → "בודק מוסמך"/"תחזוקה מונעת").
  // ⚠️ רק הפתיחה: המעבר בין לשוניות בתוך החלון אינו משנה אותה — אחרת מעבר
  // לסקירה כשפרטי האתר לא נטענו היה סוגר את החלון מתחת לידיים.
  const [detailSection, setDetailSection] = useState(null);
  // עמוד הבודק נפתח מתוך חלון האתר (ולא מהכרטיס) → "חזרה" מחזירה לחלון, לאותה
  // לשונית שממנה יצאו. null = נפתח מהכרטיס/מהכתובת, והחזרה היא לדשבורד.
  const [inspectionReturn, setInspectionReturn] = useState(null);
  // מונה לכל אתר: עולה באירוע compliance → הלשונית הפתוחה של אותו אתר נטענת מחדש.
  const [complianceRev, setComplianceRev] = useState({});
  const [adminOpen, setAdminOpen] = useState(false);            // פאנל ניהול האתרים
  const [trafficOpen, setTrafficOpen] = useState(false);        // לוח הרמזור

  // ערכת נושא: בהירה כברירת מחדל, והבחירה נזכרת בין ביקורים (ראה useTheme)
  const { darkMode, toggle: toggleTheme } = useTheme();

  // שתי גרסאות נפרדות, ובכוונה:
  //   dataVersion   — אגרגציות של *כל* המערכת (מנהל בקרה / מנהל כללי)
  //   detailVersion — האתר הפתוח בפאנל בלבד
  // קודם הייתה גרסה אחת, ולכן הודעה מאתר א' גררה שליפה מחדש של האנליטיקה
  // וה"עוד מידע" של אתר ב' שפתוח בפאנל — נתונים שלא השתנו כלל.
  const [dataVersion, setDataVersion] = useState(0);
  const [detailVersion, setDetailVersion] = useState(0);

  // ⚠️ התקופה עברה לכאן מ-DetailPanel, שירד. היא נשמרת ברמת האפליקציה
  // ולא במודאל, כדי שסגירה ופתיחה של אתר אחר לא יאפסו את מה שנבחר —
  // מי שמסתכל על חודש רוצה חודש גם באתר הבא.
  const [period, setPeriod] = useState("week");

  // ===== Hooks =====
  // ⚠️ במסך ההנהלה — הרשימה הכבדה מחכה עד שהמסך קיבל את הנתונים שלו
  // (ראה hold ב-useSites). רשת ביטחון של 8 שניות: אם המסך נכשל בשקט,
  // התראות התקלה אינן נשארות בלי רשימה.
  const [execReady, setExecReady] = useState(false);
  const markExecReady = useCallback(() => setExecReady(true), []);
  // יציאה ממסך ההנהלה מאפסת: חזרה אליו מקבלת שוב עדיפות.
  useEffect(() => { if (role !== "executive") setExecReady(false); }, [role]);
  useEffect(() => {
    if (role !== "executive" || execReady) return undefined;
    const t = setTimeout(() => setExecReady(true), 8000);
    return () => clearTimeout(t);
  }, [role, execReady]);
  const { sites, loading, error, reload, patch, patchSite } = useSites({ hold: role === "executive" && !execReady });
  const { detail, maintenance, error: detailError, refresh: refreshDetail } = useSiteDetail(selectedCode);
  // ⚠️ כרטיס שנלחץ ולא נפתח חייב לומר למה. רק כשאין פרטים בכלל: כשל
  // ברענון של פאנל פתוח משאיר את הנתונים האחרונים, כמו קודם.
  // ⚠️ אבל חלון שנפתח ללשונית בודק/תחזוקה **אינו תלוי** בפרטי האתר — הוא
  // נפתח מהרשימה (ראה listSite למטה) ומציג את הכשל בתוך הסקירה.
  useEffect(() => {
    if (!selectedCode || !detailError || detail?.site) return;
    if (COMPLIANCE_TABS.includes(detailSection)) return;
    alert("טעינת פרטי האתר נכשלה: " + detailError);
    setSelectedCode(null);
  }, [selectedCode, detailError, detail, detailSection]);

  // ==========================================================
  // רמזורי בודק/תחזוקה — שליפה ממוקדת של אתר אחד (D20)
  // ==========================================================
  // אירוע compliance (סגירת ליקוי, הגשת ביקור, העלאת תסקיר) אינו מצדיק את
  // שליפת הרשימה המלאה. שולפים את שורת site_compliance של האתר הזה בלבד,
  // מחליפים אותה בכרטיס, ומעלים את המונה שלו — כך לשונית פתוחה נטענת מחדש.
  //
  // ⚠️ כתיבה מהלשונית עצמה מגיעה פעמיים: onChanged מיד, ואירוע realtime
  // שנייה אחר כך. הלשונית כבר טענה את עצמה אחרי הכתיבה, ולכן אירוע שמגיע
  // סמוך לכתיבה מקומית מרענן רק את המנורה — לא את הלשונית שוב.
  const sitesRef = useRef(sites);
  useEffect(() => { sitesRef.current = sites; }, [sites]);
  const localWriteAt = useRef({});
  const complianceTimers = useRef({});
  const refreshCompliance = useCallback(async (code, { bump = true } = {}) => {
    const s = sitesRef.current.find((x) => x.code === code);
    if (!s || s.compliance === undefined) return;     // מצב שרת, או אתר שאינו ברשימה
    try {
      const rows = await fetchSiteCompliance([s.id]);
      const row = rows.find((r) => r.site_code === code) ?? rows[0];
      patchSite(code, { compliance: toCompliance(row) });
    } catch (err) {
      const cur = sitesRef.current.find((x) => x.code === code)?.compliance;
      patchSite(code, {
        compliance: !cur || cur.unknown
          ? { unknown: true, error: err?.message || "שגיאה" }
          : { ...cur, stale: true, error: err?.message || "שגיאה" },
      });
    }
    if (bump) setComplianceRev((m) => ({ ...m, [code]: (m[code] ?? 0) + 1 }));
  }, [patchSite]);
  const scheduleComplianceRefresh = useCallback((code) => {
    if (!code) return;
    clearTimeout(complianceTimers.current[code]);
    // ⚠️ השהיה קצרה: העלאה מרוכזת של תסקירים היסטוריים יורה אירוע לכל קובץ
    complianceTimers.current[code] = setTimeout(() => {
      const recentLocal = Date.now() - (localWriteAt.current[code] ?? 0) < 5000;
      refreshCompliance(code, { bump: !recentLocal });
    }, 600);
  }, [refreshCompliance]);
  useEffect(() => () => {
    for (const t of Object.values(complianceTimers.current)) clearTimeout(t);
  }, []);
  const handleComplianceChanged = useCallback(() => {
    if (!selectedCode) return;
    localWriteAt.current[selectedCode] = Date.now();
    refreshCompliance(selectedCode, { bump: false });
  }, [selectedCode, refreshCompliance]);

  const handleRefresh = useCallback(() => {
    reload();
    refreshDetail();
  }, [reload, refreshDetail]);

  // ==========================================================
  // טיפול בהודעת SSE — שלוש רמות, מהזולה ליקרה
  // ==========================================================
  // 1. *תמיד*: מעדכנים את הכרטיס מהודעה עצמה. אפס בקשות, עדכון מיידי.
  // 2. רק אם ההודעה שינתה מדד מצטבר (פעולה, תקלה, תחזוקה, נתק): שולפים
  //    מחדש את הרשימה והאגרגציות. מעבר ready↔operating — שהוא רוב מוחלט
  //    של התנועה באתר עמוס — כבר לא גורר שום בקשה.
  // 3. רק אם ההודעה נוגעת לאתר *הפתוח בפאנל*: מרעננים גם אותו.
  //
  // קודם כל הודעה גררה שליפה של הכול (רשימה + פאנל + אגרגציות של כל
  // המסכים), גם כשלא היה מה לעדכן.
  const SSE_DEBOUNCE_MS = 500;

  const refreshTimer = useRef(null);
  const selectedTouched = useRef(false);
  const aggregatesStale = useRef(false);

  // ==========================================================
  // סנכרון מחדש — מקור האמת כשההודעות אינן מספיקות
  // ==========================================================
  // שליפה מלאה ולא replay של אירועים: היא מתקנת גם חוסרים שלא ידענו
  // עליהם, ואינה תלויה בסמן שהלקוח צריך לתחזק. גם האגרגציות מרועננות —
  // הן נגזרות מחלון של 7 ימים בשרת ויכלו להשתנות בזמן שלא הקשבנו.
  const resync = useCallback(() => {
    reload();
    setDataVersion((v) => v + 1);
    if (selectedCode) {
      refreshDetail();
      setDetailVersion((v) => v + 1);
    }
  }, [reload, refreshDetail, selectedCode]);

  // ==========================================================
  // ⚠️ רשת הביטחון: שליפה תקופתית. **אל תסירו אותה.**
  // ==========================================================
  // התאוששות דרך onopen מכסה נתק שהדפדפן זיהה. אבל נמדד בפועל שהמקרה
  // המסוכן אינו זה: כשהרשת נופלת, ה-EventSource לעיתים **נשאר פתוח
  // ופשוט שותק** — לא נורה onerror, לא נורה onopen, ושום מסלול התאוששות
  // מבוסס-אירועים לא מתעורר. הדפדפן חושב שהוא מחובר.
  //
  // זה מה שהמשתמש ראה: כרטיס שהציג "בפעולה" בזמן שלוג הפעילות, שנשלף
  // טרי, כבר הראה "מוכן". במסך ניטור זה הכשל הגרוע ביותר — לא שגיאה
  // ולא סמל אפור, אלא מסך שנראה תקין ומשקר.
  //
  // דקה אחת חוסמת את גיל הנתונים בלי קשר למה שקרה ל-SSE. המחיר זניח:
  // שאילתה אחת מחושבת ב-Postgres, ממוטמעת בשרת.
  useEffect(() => {
    const id = setInterval(resync, 60_000);
    return () => clearInterval(id);
  }, [resync]);

  useSSE(
    useCallback((data) => {
      // ההתראות הקוליות *אינן* כאן בכוונה — הן נגזרות משינוי הסטטוס בפועל
      // (ראה האפקט "צלילי התראה" למטה). הודעת SSE שאובדת בזמן נתק הייתה
      // משתיקה את הצליל לגמרי; השוואת מצב לא תלויה בהודעה בודדת.

      // 0. בודק/תחזוקה — שורה אחת של האתר הזה, ולא שום דבר אחר (D20)
      if (data?.type === "compliance") {
        scheduleComplianceRefresh(data.code);
        return;
      }

      // 1. עדכון מיידי מהודעה — בלי בקשת רשת
      patch(data);

      if (selectedCode && data.code === selectedCode) {
        selectedTouched.current = true;
      }
      if (needsRefetch(data)) {
        aggregatesStale.current = true;
      }

      // כלום לא התיישן ואין פאנל פתוח → אין מה לשלוף
      if (!aggregatesStale.current && !selectedTouched.current) return;

      clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        if (aggregatesStale.current) {
          reload();
          setDataVersion((v) => v + 1);
          aggregatesStale.current = false;
        }
        if (selectedTouched.current) {
          refreshDetail();
          setDetailVersion((v) => v + 1);
          selectedTouched.current = false;
        }
      }, SSE_DEBOUNCE_MS);
    }, [patch, reload, selectedCode, refreshDetail, scheduleComplianceRefresh]),

    // ==========================================================
    // התאוששות מנתק — שליפה מלאה, לא השלמת הודעות
    // ==========================================================
    // ל-SSE אין מסירה חוזרת, ולכן הודעה שנשלחה בזמן נתק אבודה. הטלאי
    // המקומי מסתמך על ההודעה, וכשהיא חסרה הכרטיס נשאר על המצב הישן —
    // **בלי שום סימן שמשהו לא בסדר**. נצפה בפועל: כרטיס שהראה "בפעולה"
    // בזמן שלוג הפעילות כבר הראה "מוכן".
    //
    // שליפה מלאה ולא replay של אירועים: היא מקור האמת, היא מתקנת גם
    // חוסרים שלא ידענו עליהם, והיא לא תלויה בסמן שהלקוח צריך לתחזק.
    // (נתיב ה-replay /api/stream/since קיים ושימושי ללוג הפעילות, אבל
    // לרשימת האתרים שליפה טרייה חזקה ממנו.)
    //
    // גם האגרגציות מרועננות: הן נגזרות מחלון של 7 ימים בשרת, וייתכן
    // שהשתנו בזמן שלא הקשבנו.
    resync
  );

  useEffect(() => () => clearTimeout(refreshTimer.current), []);

  // ==========================================================
  // צליל התראה — נגזר משינוי הסטטוס, לא מהודעת SSE
  // ==========================================================
  // קודם הצליל התנגן ישירות מתוך handler ה-SSE. זה נשמע נכון אבל נשבר בשקט:
  // אם חיבור ה-SSE נופל לרגע (אתחול שרת, נפילת רשת, טאב שנרדם), ההודעה
  // שנשלחה באותו רגע **אובדת** — ל-SSE אין מסירה חוזרת. הכרטיס בכל זאת היה
  // מתעדכן ל"מושבת" מאוחר יותר דרך שליפה מלאה, אבל הצליל כבר לא היה מתנגן.
  //
  // ההשוואה, הקיבוץ לצליל אחד, וניהול ה-AudioContext עברו ל-useFaultAlerts
  // ול-useAlertAudio. כאן נשארה רק ההרכבה.
  useFaultAlerts(sites);

  // בדיקה מהירה מהקונסול: parkomatTestAlert()
  useEffect(() => {
    window.parkomatTestAlert = testAlert;
    return () => { delete window.parkomatTestAlert; };
  }, []);

  // הפעלת ערכת הנושא על ה-DOM עברה ל-useTheme, יחד עם שמירת ההעדפה.

  // ===== Handlers =====
  // section — מהמנורה בכרטיס ("inspection"/"pm"); בלעדיו החלון נפתח על הסקירה.
  // ⚠️ "inspection" אינו לשונית בחלון אלא **עמוד מלא** (InspectionPage) — ראה
  // הרינדור למטה. המנורה, ההתראות, טבלת המפקח והכתובת עוברים כולם דרך כאן.
  const handleSiteClick = useCallback((code, section = null) => {
    setDetailSection(typeof section === "string" ? section : null);
    setInspectionReturn(null);
    setSelectedCode(code);
  }, []);
  const closeDetail = useCallback(() => {
    setSelectedCode(null);
    setDetailSection(null);
    setInspectionReturn(null);
  }, []);
  // "בודק מוסמך" בתוך חלון האתר פותח את העמוד — והחזרה ממנו חוזרת לחלון, לא
  // לדשבורד: מי שנכנס דרך האתר מצפה לחזור לאתר.
  // ⚠️ חוזרים ללשונית שממנה יצאו ולא תמיד לסקירה: מי שהגיע מ"תחזוקה מונעת"
  // כשפרטי האתר לא נטענו היה נוחת בסקירה — שדורשת אותם — והחלון היה נסגר.
  const openInspectionFromSite = useCallback((fromSection) => {
    setInspectionReturn(fromSection || "overview");
    setDetailSection("inspection");
  }, []);
  const backFromInspection = useCallback(() => {
    if (!inspectionReturn) { closeDetail(); return; }
    setDetailSection(inspectionReturn === "overview" ? null : inspectionReturn);
    setInspectionReturn(null);
  }, [inspectionReturn, closeDetail]);

  // ==========================================================
  // ⚠️ פתיחת האפליקציה = דשבורד הבקר. תמיד.
  // ==========================================================
  // בעלת המוצר (06/10/2026): "שהברירת מחדל כשפותחים את האפליקציה מגיעים ישר
  // ל-DASHBOARD הבקר". לפני כן האתר והלשונית נשמרו בכתובת (?site=&tab=)
  // ונפתחו מחדש בכל רענון — כדי שטלפון שהרג את ה-PWA באמצע ביקור תחזוקה
  // יחזיר את הטכנאי לטופס. זה הוסר בכוונה, והמחיר ידוע: הוא חוזר לדשבורד
  // ופותח שוב את האתר. הטיוטה עצמה לא אובדת — סימונים, הערות ותמונות שמורים
  // במכשיר (utils/pmOutbox.js) ומופיעים כשהלשונית נפתחת שוב.
  //
  // כתובת ישנה עם ?site=&tab= (מגרסה קודמת, סימנייה) — לא פותחת כלום, ונוקה
  // כדי שהכתובת לא תטען שמשהו פתוח כשהמסך מראה את הדשבורד.
  useEffect(() => {
    try {
      const u = new URL(window.location.href);
      if (!u.searchParams.has("site") && !u.searchParams.has("tab")) return;
      u.searchParams.delete("site");
      u.searchParams.delete("tab");
      window.history.replaceState(window.history.state, "", u);
    } catch { /* כתובת שאינה ניתנת לעדכון — לא חוסם כלום */ }
  }, []);

  // אחרי כל שינוי בניהול (הוספה/עריכה/מחיקה) — רענון הרשימה וגם האגרגציות
  const handleAdminChanged = useCallback(() => {
    reload();
    setDataVersion((v) => v + 1);
  }, [reload]);

  // ===== ניתוב לפי תפקיד =====
  function renderView() {
    if (role === "supervisor") {
      // sites (רשימה חיה, מתעדכנת מ-SSE) — כדי שעמודת "מצב" בטבלה תהיה עקבית
      // עם תצוגת הבקר גם למצב החולף "בפעולה", בלי שליפה-מחדש של הסטטיסטיקה.
      return <SupervisorView onSiteClick={handleSiteClick} dataVersion={dataVersion} sites={sites} />;
    }
    if (role === "executive") {
      return <ExecutiveView dataVersion={dataVersion} onFirstData={markExecReady} />;
    }
    return (
      <OperatorView
        sites={sites}
        loading={loading}
        error={error}
        onRetry={reload}
        activeFilters={activeFilters}
        typeFilter={typeFilter}
        systemFilter={systemFilter}
        tierFilter={tierFilter}
        searchQuery={searchQuery}
        onSiteClick={handleSiteClick}
      />
    );
  }

  return (
    <div className="app">
      <AlertUnlockBar />
      <Header
        sites={sites}
        role={role}
        onRoleChange={setRole}
        activeFilters={activeFilters}
        onFilterChange={setActiveFilters}
        typeFilter={typeFilter}
        onTypeFilterChange={setTypeFilter}
        systemFilter={systemFilter}
        onSystemFilterChange={setSystemFilter}
        tierFilter={tierFilter}
        onTierFilterChange={setTierFilter}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        darkMode={darkMode}
        onToggleDarkMode={toggleTheme}
        onAdmin={() => setAdminOpen(true)}
      />

      {/* ⚠️ **בתוך main ומעל התוכן, ולא מעל ה-Header.** הבאנר צריך לשבת
          במקום שהעין מגיעה אליו כשהיא באה לקרוא מספרים — מעל הכותרת הוא
          נקרא כשורת מערכת ומדלגים עליו. */}
      <main className="app-main">
        <StaleBanner />
        {renderView()}
      </main>

      {/* ⚠️ **מחוץ ל-main ואחרון**, כדי שיישב מעל הכול — כולל חלוניות
          שנשארו פתוחות מהפעם הקודמת. הרכיב מחזיר null כשאין מה להכריז,
          ולכן הוא עולה תמיד ואינו עולה כלום כשאין הכרזה. */}
      <Announcement />

      {/* הפאנל משותף — נפתח גם מהבקר וגם מטבלת מנהל הבקרה */}
      {/* ⚠️ **גם detail?.site ולא רק selectedCode.** השליפה אסינכרונית,
          ובין הלחיצה לתשובה site הוא undefined — והמודאל קורא site.site_name
          מיד. הפאנל הישן היה מוגן ב-if (!detail) return null, וההגנה הזו
          נפלה בהעברה. התסמין: מסך ריק ושגיאה בקונסול. */}
      {/* ⚠️ לשונית בודק/תחזוקה נפתחת **מהרשימה** (listSite) בלי לחכות לפרטי
          האתר: טכנאי שלוחץ על מנורה לא צריך את גרפי התובנות. ה-key מאפס את
          החלון כשעוברים לאתר אחר — אחרת לשונית פתוחה הייתה שומרת את השומר
          ואת הטיוטה של האתר הקודם. */}
      {(() => {
        if (!selectedCode) return null;
        const listSite = sites.find((x) => x.code === selectedCode);
        // ⚠️ בודק מוסמך — עמוד מלא ולא לשונית (בקשת בעלת המוצר, 05/10/2026).
        // מהרשימה בלבד, כמו הלשונית: לא מחכה לפרטי האתר. במצב שרת אין לתכונה
        // זרוע, ואז נשאר החלון (שבו הלשונית פשוט אינה קיימת).
        if (detailSection === "inspection" && useDirect) {
          if (!listSite) return null;
          return (
            <InspectionPage
              key={selectedCode}
              site={listSite}
              backLabel={inspectionReturn ? "חזרה לאתר" : "חזרה לדשבורד"}
              onBack={backFromInspection}
              complianceRev={complianceRev[selectedCode] ?? 0}
              onChanged={handleComplianceChanged}
            />
          );
        }
        // ⚠️ רק פרטים של **האתר הזה**: בין הלחיצה לאיפוס ב-useSiteDetail
        // עדיין יושבים שם הפרטים של האתר הקודם, לרינדור אחד.
        const detailSite = detail?.site?.code === selectedCode ? detail.site : null;
        const site = detailSite ?? (COMPLIANCE_TABS.includes(detailSection) ? listSite : null);
        if (!site) return null;
        return (
          <InsightsModal
            key={selectedCode}
            site={site}
            maintenance={maintenance}
            period={period}
            onPeriodChange={setPeriod}
            // הגרסה של האתר הפתוח בלבד — לא של כל המערכת
            version={detailVersion}
            onRefresh={handleRefresh}
            onClose={closeDetail}
            initialSection={detailSection ?? "overview"}
            compliance={listSite?.compliance}
            complianceRev={complianceRev[selectedCode] ?? 0}
            onComplianceChanged={handleComplianceChanged}
            onOpenInspection={openInspectionFromSite}
            detailMissing={!detailSite}
          />
        );
      })()}

      {/* ניהול אתרים — רק מנהל בקרה/כללי, ומאחורי קוד שהשרת אוכף */}
      {adminOpen && (
        <AdminPanel
          sites={sites}
          onClose={() => setAdminOpen(false)}
          onChanged={handleAdminChanged}
        />
      )}

      {/* ==========================================================
          רמזור — לוח חופשי שהמנהל עורך
          ==========================================================
          ⚠️ **כפתור צף בצד הנגדי לעוזר ה-AI.** שניהם כלים שזמינים מכל
          תצוגה ואינם שייכים לאף אחת מהן; הצבתם באותה פינה הייתה מכריחה
          את אחד מהם להיות מוסתר מאחורי תפריט.

          ⚠️ ומוצג תמיד, גם לבקר — שער התפקיד יושב **בתוך** הפאנל ואומר
          במפורש מה התפקיד שלך. כפתור שנעלם משאיר את מי שחושבת שהיא
          מנהלת בלי שום דרך לדעת שהתפקיד שלה במסד שונה. */}
      {/* ⚠️ מוסתר במצב שרת: ללוח אין זרוע שרת, ראה dataSource. */}
      {useDirect && <button
        type="button"
        className="tl-fab"
        onClick={() => setTrafficOpen(true)}
        title="רמזור — לוח לקוחות"
      >
        <span className="tl-lamps" aria-hidden="true">
          <span className="tl-lamp tl-lamp--r" />
          <span className="tl-lamp tl-lamp--y" />
          <span className="tl-lamp tl-lamp--g" />
        </span>
        רמזור
      </button>}

      {trafficOpen && <TrafficLight onClose={() => setTrafficOpen(false)} />}

      {/* ⚠️ עוזר ה-AI הוסר (17/09/2026) לבקשת בעלת המוצר: הוא רץ על master,
          ו-master יוצא משימוש — המערכת נשענת על Supabase והדשבורד בלבד. */}
    </div>
  );
}

export default App;
