// views/OperatorView/OperatorView.jsx — דשבורד הבקר: ניטור שוטף של כלל האתרים.
// הועבר מ-App.jsx ללא שינוי התנהגות; הסינון והחיפוש מגיעים מה-Header.
import SiteGrid from "../../components/SiteGrid/SiteGrid";
import { matchesSiteFilters } from "../../components/SiteFilterTile/SiteFilterTile";
import { fuzzyMatch } from "../../utils/helpers";
import { compareSitesByPriority } from "../../utils/sortSites";
import "./OperatorView.css";

function OperatorView({ sites, loading, error, activeFilters = [], typeFilter = "", tierFilter = "", searchQuery, onSiteClick }) {
  if (loading) return <div className="app-loading">טוען אתרים...</div>;
  if (error) return <div className="app-error">שגיאה: {error}</div>;

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
      <SiteGrid sites={ordered} onSiteClick={onSiteClick} />
    </div>
  );
}

export default OperatorView;
