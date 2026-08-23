// views/OperatorView/OperatorView.jsx — דשבורד הבקר: ניטור שוטף של כלל האתרים.
// הועבר מ-App.jsx ללא שינוי התנהגות; הסינון והחיפוש מגיעים מה-Header.
import SiteGrid from "../../components/SiteGrid/SiteGrid";
import { matchesSiteFilters } from "../../components/SiteFilterTile/SiteFilterTile";
import { fuzzyMatch } from "../../utils/helpers";
import { compareSitesByPriority } from "../../utils/sortSites";
import "./OperatorView.css";

function OperatorView({ sites, loading, error, onRetry, activeFilters = [], typeFilter = "", tierFilter = "", searchQuery, onSiteClick }) {
  // ============================================================
  // ⚠️ שגיאה **אינה** מוחקת מסך שיש בו נתונים
  // ============================================================
  // כאן היה `if (error)` יחיד, והוא היה היחיד מבין שלוש התצוגות שמתנהג כך:
  // SupervisorView ו-ExecutiveView שניהם בודקים `error && !data`. התוצאה
  // בפועל — תקלת רשת חולפת אחת החליפה 13 כרטיסי אתר תקינים, שכבר היו
  // בזיכרון, בשורה אדומה אחת. הנתונים לא אבדו; רק הסירוב להציג אותם.
  //
  // ⚠️ אבל **לא פשוט להסתיר את השגיאה.** בדיוק מזה מזהיר ההערה ב-App.jsx:
  // "מסך שנראה תקין ומשקר" הוא הכשל הגרוע ביותר במסך ניטור. לכן הנתונים
  // נשארים, והשגיאה עוברת לפס עליון שאומר במפורש שהמוצג אינו טרי.
  if (loading && sites.length === 0) return <div className="app-loading">טוען אתרים...</div>;
  // ⚠️ **כפתור, ולא רק הודעה.** מסך ריק שאומר "שגיאה" ואינו מציע דבר
  // גורר רענון ידני של הדף — ורענון מאבד את הסינון, את הגלילה ואת
  // התצוגה שנבחרה. ניסיון חוזר במקום עולה לחיצה אחת ואינו מאבד כלום.
  if (error && sites.length === 0) {
    return (
      <div className="app-error">
        <div>{error}</div>
        <button className="app-error-retry" onClick={onRetry}>נסה שוב</button>
      </div>
    );
  }

  const filtered = sites.filter((site) => {
    // רשימה ריקה = בלי סינון. אחרת: האתר צריך להיות באחד מהמצבים שנבחרו.
    if (activeFilters.length > 0 && !activeFilters.includes(site.status)) return false;
    // ⚠️ הכלל עצמו חי ב-SiteFilterTile ומיוצא — כך הסרגל והתצוגה מסכימים על
    // מה קורה עם אתר בלי סוג, במקום להגדיר את זה פעמיים.
    if (!matchesSiteFilters(site, typeFilter, tierFilter)) return false;
    if (searchQuery && !fuzzyMatch(`${site.site_name} ${site.code}`, searchQuery)) return false;
    return true;
  });

  const ordered = [...filtered].sort(compareSitesByPriority);

  return (
    <div className="operator-view">
      {/* ⚠️ הפס נשאר עד שהשליפה הבאה מצליחה — הוא אינו מודעה חולפת אלא
          מצב. רענון רץ כל 60 שניות, ולכן הוא נעלם מעצמו כשהרשת חוזרת. */}
      {error && (
        <div className="op-stale" role="status">
          ⚠️ העדכון האחרון נכשל — ייתכן שהמוצג אינו מעודכן
          <span className="op-stale-detail">{error}</span>
        </div>
      )}
      <SiteGrid sites={ordered} onSiteClick={onSiteClick} />
    </div>
  );
}

export default OperatorView;
