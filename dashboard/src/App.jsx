// App.jsx — מעטפת: מחזיקה את ה-state המשותף (אתרים, SSE, תפקיד, אתר נבחר)
// ומנתבת לתצוגה לפי התפקיד. הפאנל והמודלים משותפים לכל התצוגות.
import { useState, useCallback, useEffect, useRef } from "react";
import { useSites } from "./hooks/useSites";
import { useSSE } from "./hooks/useSSE";
import { useSiteDetail } from "./hooks/useSiteDetail";
import { useTheme } from "./hooks/useTheme";
import Header from "./components/Header/Header";
import DetailPanel from "./components/DetailPanel/DetailPanel";
import AdminPanel from "./components/AdminPanel/AdminPanel";
import ChatAssistant from "./components/ChatAssistant/ChatAssistant";
import OperatorView from "./views/OperatorView/OperatorView";
import SupervisorView from "./views/SupervisorView/SupervisorView";
import ExecutiveView from "./views/ExecutiveView/ExecutiveView";
import { needsRefetch } from "./utils/sitePatch";
import { alertError, alertNoComm, unlockAudio } from "./utils/audio/alerts";
import "./styles/global.css";
import "./styles/theme.css";

function App() {
  // ===== State מרכזי =====
  const [role, setRole] = useState("operator");                // בקר / מנהל בקרה / מנהל כללי
  const [activeFilters, setActiveFilters] = useState([]);       // סינון לפי מצב (בקר) — בחירה מרובה
  const [searchQuery, setSearchQuery] = useState("");           // חיפוש (בקר)
  const [selectedCode, setSelectedCode] = useState(null);       // אתר נבחר (לפאנל)
  const [adminOpen, setAdminOpen] = useState(false);            // פאנל ניהול האתרים

  // ערכת נושא: בהירה כברירת מחדל, והבחירה נזכרת בין ביקורים (ראה useTheme)
  const { darkMode, toggle: toggleTheme } = useTheme();

  // שתי גרסאות נפרדות, ובכוונה:
  //   dataVersion   — אגרגציות של *כל* המערכת (מנהל בקרה / מנהל כללי)
  //   detailVersion — האתר הפתוח בפאנל בלבד
  // קודם הייתה גרסה אחת, ולכן הודעה מאתר א' גררה שליפה מחדש של האנליטיקה
  // וה"עוד מידע" של אתר ב' שפתוח בפאנל — נתונים שלא השתנו כלל.
  const [dataVersion, setDataVersion] = useState(0);
  const [detailVersion, setDetailVersion] = useState(0);

  // ===== Hooks =====
  const { sites, loading, error, reload, patch } = useSites();
  const { detail, maintenance, refresh: refreshDetail } = useSiteDetail(selectedCode);

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

  useSSE(
    useCallback((data) => {
      // ההתראות הקוליות *אינן* כאן בכוונה — הן נגזרות משינוי הסטטוס בפועל
      // (ראה האפקט "צלילי התראה" למטה). הודעת SSE שאובדת בזמן נתק הייתה
      // משתיקה את הצליל לגמרי; השוואת מצב לא תלויה בהודעה בודדת.

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
    }, [patch, reload, selectedCode, refreshDetail])
  );

  useEffect(() => () => clearTimeout(refreshTimer.current), []);

  // ==========================================================
  // צלילי התראה — נגזרים משינוי הסטטוס, לא מהודעת SSE
  // ==========================================================
  // קודם הצליל התנגן ישירות מתוך handler ה-SSE. זה נשמע נכון אבל נשבר בשקט:
  // אם חיבור ה-SSE נופל לרגע (אתחול שרת, נפילת רשת, טאב שנרדם), ההודעה
  // שנשלחה באותו רגע **אובדת** — ל-SSE אין מסירה חוזרת. הכרטיס בכל זאת היה
  // מתעדכן ל"מושבת" מאוחר יותר דרך שליפה מלאה, אבל הצליל כבר לא היה מתנגן.
  //
  // כאן משווים את הסטטוס הקודם לנוכחי בכל עדכון של הרשימה — לא משנה אם הוא
  // הגיע מ-SSE או משליפה. כל מעבר ל"מושבת" משמיע צליל, בדיוק פעם אחת.
  //
  // בונוס: הסטטוס כאן הוא ה*אפקטיבי* (השרת כבר החיל "תחזוקה גוברת"), ולכן
  // אתר בתחזוקה לעולם לא יגיע ל"מושבת" — ולא יצפצף. בלי תנאי מיוחד.
  const prevStatuses = useRef(null);
  useEffect(() => {
    if (!sites || sites.length === 0) return;

    const current = new Map(sites.map((s) => [s.code, s.status]));
    const previous = prevStatuses.current;
    prevStatuses.current = current;

    // טעינה ראשונה: רק זוכרים. בלי זה כל רענון דף היה מצפצף על כל אתר שכבר מושבת.
    if (!previous) return;

    for (const [code, status] of current) {
      const before = previous.get(code);
      if (!before || before === status) continue;   // אתר חדש / בלי שינוי

      if (status === "error") {
        console.info(`[alert] אתר ${code}: ${before} → מושבת — צליל התראה`);
        alertError();
      } else if (status === "no_comm") {
        alertNoComm();
      }
    }
  }, [sites]);

  // ===== שחרור/החייאת אודיו =====
  // *לא* { once }: הדפדפן משעה מחדש את ה-AudioContext כשהטאב יורד לרקע, ואז
  // צליל תקלה לא היה נשמע כשחוזרים. לכן מחיים אותו בכל אינטראקציה *וגם* כשהטאב
  // חוזר להיות גלוי. unlockAudio זול ואידמפוטנטי — קריאה חוזרת לא מזיקה.
  useEffect(() => {
    const handler = () => unlockAudio();
    handler();   // ניסיון מיידי (אם כבר הייתה אינטראקציה קודמת בטעינה)
    window.addEventListener("pointerdown", handler);
    window.addEventListener("keydown", handler);
    document.addEventListener("visibilitychange", handler);
    return () => {
      window.removeEventListener("pointerdown", handler);
      window.removeEventListener("keydown", handler);
      document.removeEventListener("visibilitychange", handler);
    };
  }, []);

  // בדיקה מהירה של צליל התקלה — להריץ בקונסול של הדפדפן: parkomatTestAlert()
  // (מחייה את האודיו ומנגן את אותו צליל שמושמע כשאתר עובר למושבת).
  useEffect(() => {
    window.parkomatTestAlert = () => { unlockAudio(); alertError(); };
    return () => { delete window.parkomatTestAlert; };
  }, []);

  // הפעלת ערכת הנושא על ה-DOM עברה ל-useTheme, יחד עם שמירת ההעדפה.

  // ===== Handlers =====
  const handleSiteClick = useCallback((code) => setSelectedCode(code), []);

  // אחרי כל שינוי בניהול (הוספה/עריכה/מחיקה) — רענון הרשימה וגם האגרגציות
  const handleAdminChanged = useCallback(() => {
    reload();
    setDataVersion((v) => v + 1);
  }, [reload]);

  // ===== ניתוב לפי תפקיד =====
  function renderView() {
    if (role === "supervisor") {
      return <SupervisorView onSiteClick={handleSiteClick} dataVersion={dataVersion} />;
    }
    if (role === "executive") {
      return <ExecutiveView dataVersion={dataVersion} />;
    }
    return (
      <OperatorView
        sites={sites}
        loading={loading}
        error={error}
        activeFilters={activeFilters}
        searchQuery={searchQuery}
        onSiteClick={handleSiteClick}
      />
    );
  }

  return (
    <div className="app">
      <Header
        sites={sites}
        role={role}
        onRoleChange={setRole}
        activeFilters={activeFilters}
        onFilterChange={setActiveFilters}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        darkMode={darkMode}
        onToggleDarkMode={toggleTheme}
        onAdmin={() => setAdminOpen(true)}
      />

      <main className="app-main">{renderView()}</main>

      {/* הפאנל משותף — נפתח גם מהבקר וגם מטבלת מנהל הבקרה */}
      {selectedCode && (
        <DetailPanel
          detail={detail}
          maintenance={maintenance}
          onClose={() => setSelectedCode(null)}
          onRefresh={handleRefresh}
          // הגרסה של האתר הפתוח בלבד — לא של כל המערכת
          dataVersion={detailVersion}
        />
      )}

      {/* ניהול אתרים — רק מנהל בקרה/כללי, ומאחורי קוד שהשרת אוכף */}
      {adminOpen && (
        <AdminPanel
          sites={sites}
          onClose={() => setAdminOpen(false)}
          onChanged={handleAdminChanged}
        />
      )}

      {/* עוזר ה-AI — קריאה בלבד, זמין מכל תצוגה */}
      <ChatAssistant />
    </div>
  );
}

export default App;
