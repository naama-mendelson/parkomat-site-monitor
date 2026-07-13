// views/OperatorView/OperatorView.jsx — דשבורד הבקר: ניטור שוטף של כלל האתרים.
// הועבר מ-App.jsx ללא שינוי התנהגות; הסינון והחיפוש מגיעים מה-Header.
import SiteGrid from "../../components/SiteGrid/SiteGrid";
import { fuzzyMatch } from "../../utils/helpers";
import "./OperatorView.css";

function OperatorView({ sites, loading, error, activeFilters = [], searchQuery, onSiteClick }) {
  if (loading) return <div className="app-loading">טוען אתרים...</div>;
  if (error) return <div className="app-error">שגיאה: {error}</div>;

  const filtered = sites.filter((site) => {
    // רשימה ריקה = בלי סינון. אחרת: האתר צריך להיות באחד מהמצבים שנבחרו.
    if (activeFilters.length > 0 && !activeFilters.includes(site.status)) return false;
    if (searchQuery && !fuzzyMatch(`${site.site_name} ${site.code}`, searchQuery)) return false;
    return true;
  });

  return (
    <div className="operator-view">
      <SiteGrid sites={filtered} onSiteClick={onSiteClick} />
    </div>
  );
}

export default OperatorView;
