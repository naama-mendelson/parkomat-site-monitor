// components/SiteGrid/SiteGrid.jsx — רשת כרטיסי אתרים עם צפיפות דינמית (PRD 12.1)
import SiteCard from "../SiteCard/SiteCard";
import { DENSITY } from "../../utils/constants";
import "./SiteGrid.css";

// קביעת רמת הצפיפות לפי מספר האתרים המוצגים
function resolveDensity(count) {
  if (count > DENSITY.MINI_THRESHOLD) return "mini";       // מעל 50 — שם + צבע בלבד
  if (count > DENSITY.COMPACT_THRESHOLD) return "compact";  // מעל 20 — מצומצם
  return "normal";                                          // עד 20 — מלא
}

// מיון: אתרי VIP ראשונים (PRD 12.1). אם אין שדה is_vip — הסדר נשמר.
function orderSites(sites) {
  return [...sites].sort((a, b) => (b.is_vip ? 1 : 0) - (a.is_vip ? 1 : 0));
}

function SiteGrid({ sites, onSiteClick }) {
  if (sites.length === 0) {
    return <div className="grid-empty">לא נמצאו אתרים</div>;
  }

  const density = resolveDensity(sites.length);
  const ordered = orderSites(sites);

  return (
    <div className={`site-grid grid-${density}`}>
      {ordered.map((site) => (
        <SiteCard
          key={site.code}
          site={site}
          density={density}
          onClick={onSiteClick}
        />
      ))}
    </div>
  );
}

export default SiteGrid;
