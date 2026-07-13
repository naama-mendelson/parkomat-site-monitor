// App.jsx — מעטפת: מחזיקה את ה-state המשותף (אתרים, SSE, תפקיד, אתר נבחר)
// ומנתבת לתצוגה לפי התפקיד. הפאנל והמודלים משותפים לכל התצוגות.
import { useState, useCallback, useEffect, useRef } from "react";
import { useSites } from "./hooks/useSites";
import { useSSE } from "./hooks/useSSE";
import { useSiteDetail } from "./hooks/useSiteDetail";
import Header from "./components/Header/Header";
import DetailPanel from "./components/DetailPanel/DetailPanel";
import AdminPanel from "./components/AdminPanel/AdminPanel";
import OperatorView from "./views/OperatorView/OperatorView";
import SupervisorView from "./views/SupervisorView/SupervisorView";
import ExecutiveView from "./views/ExecutiveView/ExecutiveView";
import { alertError, alertNoComm, unlockAudio } from "./utils/audio/alerts";
import "./styles/global.css";
import "./styles/theme.css";

function App() {
  // ===== State מרכזי =====
  const [role, setRole] = useState("operator");                // בקר / מנהל בקרה / מנהל כללי
  const [activeFilters, setActiveFilters] = useState([]);       // סינון לפי מצב (בקר) — בחירה מרובה
  const [searchQuery, setSearchQuery] = useState("");           // חיפוש (בקר)
  const [selectedCode, setSelectedCode] = useState(null);       // אתר נבחר (לפאנל)
  const [darkMode, setDarkMode] = useState(true);
  const [adminOpen, setAdminOpen] = useState(false);            // פאנל ניהול האתרים
  const [dataVersion, setDataVersion] = useState(0);            // עולה בכל הודעה חדשה

  // ===== Hooks =====
  const { sites, loading, error, reload } = useSites();
  const { detail, stats, maintenance, refresh: refreshDetail } = useSiteDetail(selectedCode);

  const handleRefresh = useCallback(() => {
    reload();
    refreshDetail();
  }, [reload, refreshDetail]);

  // דחיית רענון (debounce): אתר עמוס מייצר ריבוי אירועי operation בשנייה.
  const refreshTimer = useRef(null);
  const selectedTouched = useRef(false);

  useSSE(
    useCallback((data) => {
      if (data.type === "state") {
        if (data.newStatus === "error") alertError();
        else if (data.newStatus === "no_comm") alertNoComm();
      }

      if (selectedCode && data.code === selectedCode) {
        selectedTouched.current = true;
      }

      clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        reload();
        // dataVersion עולה תמיד — גם מסכי הניהול (שמציגים אגרגציה של כל
        // האתרים) צריכים להתרענן, לא רק הפאנל של האתר הפתוח.
        setDataVersion((v) => v + 1);
        if (selectedTouched.current) {
          refreshDetail();
          selectedTouched.current = false;
        }
      }, 400);
    }, [reload, selectedCode, refreshDetail])
  );

  useEffect(() => () => clearTimeout(refreshTimer.current), []);

  // ===== שחרור אודיו באינטראקציה הראשונה =====
  useEffect(() => {
    const handler = () => unlockAudio();
    window.addEventListener("pointerdown", handler, { once: true });
    window.addEventListener("keydown", handler, { once: true });
    return () => {
      window.removeEventListener("pointerdown", handler);
      window.removeEventListener("keydown", handler);
    };
  }, []);

  // ===== Dark/Light =====
  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? "dark" : "light";
  }, [darkMode]);

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
        onToggleDarkMode={() => setDarkMode((d) => !d)}
        onAdmin={() => setAdminOpen(true)}
      />

      <main className="app-main">{renderView()}</main>

      {/* הפאנל משותף — נפתח גם מהבקר וגם מטבלת מנהל הבקרה */}
      {selectedCode && (
        <DetailPanel
          detail={detail}
          stats={stats}
          maintenance={maintenance}
          onClose={() => setSelectedCode(null)}
          onRefresh={handleRefresh}
          dataVersion={dataVersion}
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
    </div>
  );
}

export default App;
