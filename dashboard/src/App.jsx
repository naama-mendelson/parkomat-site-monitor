// App.jsx — קומפוננטה ראשית: מרכיבה את דשבורד הבקר
import { useState, useCallback, useEffect, useRef } from "react";
import { useSites } from "./hooks/useSites";
import { useSSE } from "./hooks/useSSE";
import { useSiteDetail } from "./hooks/useSiteDetail";
import { fuzzyMatch } from "./utils/helpers";
import Header from "./components/Header/Header";
import SiteGrid from "./components/SiteGrid/SiteGrid";
import DetailPanel from "./components/DetailPanel/DetailPanel";
import AddSiteModal from "./components/AddSiteModal/AddSiteModal";
import { alertError, alertNoComm, unlockAudio } from "./utils/audio/alerts";
import "./styles/global.css";
import "./styles/theme.css";

function App() {
  // ===== State מרכזי =====
  const [activeFilter, setActiveFilter] = useState(null);     // סינון לפי מצב
  const [searchQuery, setSearchQuery] = useState("");          // טקסט חיפוש
  const [selectedCode, setSelectedCode] = useState(null);      // אתר נבחר (לפאנל)
  const [darkMode, setDarkMode] = useState(true);              // dark/light (ברירת מחדל: כהה)
  const [addSiteOpen, setAddSiteOpen] = useState(false);       // מודל הוספת אתר
  const [dataVersion, setDataVersion] = useState(0);           // עולה בכל הודעה חדשה על האתר הפתוח

  // ===== Hooks =====
  const { sites, loading, error, reload } = useSites();
  const { detail, stats, maintenance, refresh: refreshDetail } = useSiteDetail(selectedCode);

  // רענון משולב: רשימת האתרים + פרטי האתר הפתוח (אחרי שינוי תחזוקה)
  const handleRefresh = useCallback(() => {
    reload();
    refreshDetail();
  }, [reload, refreshDetail]);

  // דחיית רענון (debounce): אתר עמוס מייצר ריבוי אירועי operation בשנייה, וכל
  // reload() מריץ חישוב-מחדש של כל האתרים בשרת. מקבצים פרץ אירועים לרענון אחד.
  const refreshTimer = useRef(null);
  const selectedTouched = useRef(false);

  // SSE — בכל עדכון מהשרת (state או operation):
  //   1. התראה קולית במעבר מצב (מיידית — לא נדחית).
  //   2. רענון (מדוחה) של רשימת האתרים.
  //   3. אם פאנל הפירוט פתוח על אתר שהתעדכן — רענון גם שלו.
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
        if (selectedTouched.current) {
          refreshDetail();
          // מאלץ שליפה מחדש של האנליטיקה והסטטיסטיקה — כך המספרים בפאנל
          // ובמסך "עוד מידע" נשארים מסונכרנים עם ה-DB בזמן אמת.
          setDataVersion((v) => v + 1);
          selectedTouched.current = false;
        }
      }, 400);
    }, [reload, selectedCode, refreshDetail])
  );

  // ניקוי הטיימר בהתנתקות
  useEffect(() => () => clearTimeout(refreshTimer.current), []);

  // ===== שחרור אודיו באינטראקציה הראשונה =====
  // דפדפנים חוסמים אודיו עד מחווה של המשתמש; ניצול אירוע ה-pointerdown הראשון.
  useEffect(() => {
    const handler = () => unlockAudio();
    window.addEventListener("pointerdown", handler, { once: true });
    window.addEventListener("keydown", handler, { once: true });
    return () => {
      window.removeEventListener("pointerdown", handler);
      window.removeEventListener("keydown", handler);
    };
  }, []);

  // ===== Dark/Light — סנכרון ל-data-theme על <html> =====
  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? "dark" : "light";
  }, [darkMode]);

  // ===== סינון אתרים =====
  const filteredSites = sites.filter((site) => {
    if (activeFilter && site.status !== activeFilter) return false;
    if (searchQuery && !fuzzyMatch(`${site.site_name} ${site.code}`, searchQuery)) return false;
    return true;
  });

  // ===== Handlers =====
  function handleSiteClick(code) {
    setSelectedCode(code);
  }

  function handleCloseDetail() {
    setSelectedCode(null);
  }

  // אחרי רישום מוצלח: רענון הרשימה כדי שהאתר החדש יופיע מיד, וסגירת המודל.
  function handleSiteAdded() {
    setAddSiteOpen(false);
    reload();
  }

  // ===== Render =====
  return (
    <div className="app">
      <Header
        sites={sites}
        activeFilter={activeFilter}
        onFilterChange={setActiveFilter}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        darkMode={darkMode}
        onToggleDarkMode={() => setDarkMode((d) => !d)}
        onAddSite={() => setAddSiteOpen(true)}
      />

      <main className="app-main">
        {loading && <div className="app-loading">טוען אתרים...</div>}
        {error && <div className="app-error">שגיאה: {error}</div>}
        {!loading && !error && (
          <SiteGrid sites={filteredSites} onSiteClick={handleSiteClick} />
        )}
      </main>

      {selectedCode && (
        <DetailPanel
          detail={detail}
          stats={stats}
          maintenance={maintenance}
          onClose={handleCloseDetail}
          onRefresh={handleRefresh}
          dataVersion={dataVersion}
        />
      )}

      {addSiteOpen && (
        <AddSiteModal
          onClose={() => setAddSiteOpen(false)}
          onSuccess={handleSiteAdded}
        />
      )}
    </div>
  );
}

export default App;
