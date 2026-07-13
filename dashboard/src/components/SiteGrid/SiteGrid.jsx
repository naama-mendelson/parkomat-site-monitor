// components/SiteGrid/SiteGrid.jsx — רשת כרטיסי אתרים עם צפיפות דינמית (PRD 12.1)
import { useState, useEffect } from "react";
import SiteCard from "../SiteCard/SiteCard";
import { DENSITY } from "../../utils/constants";
import "./SiteGrid.css";

// קביעת רמת הצפיפות לפי מספר האתרים המוצגים
function resolveDensity(count) {
  if (count > DENSITY.MINI_THRESHOLD) return "mini";       // מעל 50 — שם + צבע בלבד
  if (count > DENSITY.COMPACT_THRESHOLD) return "compact";  // מעל 20 — מצומצם
  return "normal";                                          // עד 20 — מלא
}

function SiteGrid({ sites, onSiteClick }) {
  // רק כרטיס אחד מורחב בכל רגע — אחרת הרשת מתפרקת ואי אפשר לסרוק אותה
  const [expanded, setExpanded] = useState(null);

  // לחיצה בכל מקום *מחוץ* לכרטיס המורחב מכווצת אותו. אין כפתור סגירה.
  // pointerdown (ולא click) כדי שהכיווץ יקרה לפני ה-click של הכרטיס הבא,
  // אחרת לחיצה על כרטיס אחר הייתה מכווצת אותו מיד אחרי שהוא נפתח.
  useEffect(() => {
    if (!expanded) return;

    const onPointerDown = (e) => {
      const el = e.target;
      if (el instanceof Element && el.closest(".site-card.is-expanded")) return;
      setExpanded(null);
    };

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [expanded]);

  if (sites.length === 0) {
    return <div className="grid-empty">לא נמצאו אתרים</div>;
  }

  const density = resolveDensity(sites.length);
  const toggle = (code) => setExpanded((cur) => (cur === code ? null : code));

  return (
    <div className={`site-grid grid-${density}`}>
      {sites.map((site) => (
        <SiteCard
          key={site.code}
          site={site}
          density={density}
          expanded={expanded === site.code}
          onToggle={toggle}
          onOpenDetail={onSiteClick}
        />
      ))}
    </div>
  );
}

export default SiteGrid;
