// components/SiteGrid/SiteGrid.jsx — רשת כרטיסי אתרים עם צפיפות דינמית (PRD 12.1)
import { useState, useEffect, useRef } from "react";
import SiteCard from "../SiteCard/SiteCard";
import { DENSITY } from "../../utils/constants";
import "./SiteGrid.css";

// השהיית "כוונת ריחוף": הכרטיס נפתח רק אם העכבר *נח* עליו, ולא בכל מעבר.
// בלי זה, סריקה של העכבר על פני הרשת הייתה פותחת וסוגרת כרטיס אחרי כרטיס.
// 120ms מרגיש כמעט מיידי ועדיין מסנן מעבר-חטוף — מתחת לזה חוזר ההבהוב.
const HOVER_OPEN_MS = 120;

// קביעת רמת הצפיפות לפי מספר האתרים המוצגים
function resolveDensity(count) {
  if (count > DENSITY.MINI_THRESHOLD) return "mini";       // מעל 50 — שם + צבע בלבד
  if (count > DENSITY.COMPACT_THRESHOLD) return "compact";  // מעל 20 — מצומצם
  return "normal";                                          // עד 20 — מלא
}

function SiteGrid({ sites, onSiteClick }) {
  // רק כרטיס אחד מורחב בכל רגע — אחרת הרשת מתפרקת ואי אפשר לסרוק אותה
  const [expanded, setExpanded] = useState(null);
  // לחיצה *נועלת* את הכרטיס פתוח: הוא לא ייסגר כשהעכבר יוצא, רק בלחיצה
  // מחוץ לו. ריחוף לעומת זאת הוא ארעי. בלי ההבחנה הזו, כרטיס שנפתח בלחיצה
  // היה נסגר ברגע שהעכבר זז כדי ללחוץ על "פתח פירוט מלא".
  const [pinned, setPinned] = useState(false);

  const openTimer = useRef(null);
  const pointer = useRef({ x: 0, y: 0 });

  // ריחוף רק במכשירים עם מצביע אמיתי. במסך מגע "hover" נדבק אחרי נגיעה
  // ומשאיר כרטיס פתוח בלי שהמשתמש ביקש — שם נשארים בלחיצה בלבד.
  const hoverCapable = useRef(
    typeof window !== "undefined" && window.matchMedia?.("(hover: hover)").matches !== false
  );

  useEffect(() => () => clearTimeout(openTimer.current), []);

  // לחיצה בכל מקום *מחוץ* לכרטיס המורחב מכווצת אותו. אין כפתור סגירה.
  // pointerdown (ולא click) כדי שהכיווץ יקרה לפני ה-click של הכרטיס הבא,
  // אחרת לחיצה על כרטיס אחר הייתה מכווצת אותו מיד אחרי שהוא נפתח.
  useEffect(() => {
    if (!expanded) return;

    const onPointerDown = (e) => {
      const el = e.target;
      if (el instanceof Element && el.closest(".site-card.is-expanded")) return;
      setPinned(false);
      setExpanded(null);
    };

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [expanded]);

  if (sites.length === 0) {
    return <div className="grid-empty">לא נמצאו אתרים</div>;
  }

  const density = resolveDensity(sites.length);

  // לחיצה — פתיחה *נעולה* (או סגירה אם כבר נעול על אותו כרטיס)
  const toggle = (code) => {
    clearTimeout(openTimer.current);
    if (expanded === code && pinned) {
      setPinned(false);
      setExpanded(null);
    } else {
      setPinned(true);
      setExpanded(code);
    }
  };

  const trackPointer = (e) => {
    pointer.current = { x: e.clientX, y: e.clientY };
  };

  // ריחוף על כרטיס — פותח אחרי השהיה קצרה.
  //
  // האימות בסוף ההשהיה אינו קישוט: הכרטיס המורחב תופס 2×2 תאים ולכן *מזיז את
  // הפריסה*. כרטיס בעמודה האחרונה שגדל נדחף לשורה הבאה, בורח מתחת לסמן, וכרטיס
  // אחר תופס את מקומו — מה שהיה מפעיל mouseenter נוסף ויוצר לולאת פתיחה/סגירה
  // אינסופית בלי שהעכבר זז בכלל. לכן בודקים מי *באמת* נמצא תחת הסמן ברגע
  // הפתיחה, ולא מסתמכים על האירוע שהתרחש לפני 260ms.
  const handleCardEnter = (code) => {
    if (!hoverCapable.current || pinned) return;
    clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => {
      const { x, y } = pointer.current;
      const under = document.elementFromPoint(x, y)?.closest?.(".site-card");
      if (under?.dataset.code === String(code)) setExpanded(code);
    }, HOVER_OPEN_MS);
  };

  // סוגרים רק כשיוצאים מהרשת כולה — לא בכל יציאה מכרטיס בודד. אחרת הזזת
  // הפריסה (שנגרמת מההרחבה עצמה) הייתה סוגרת את הכרטיס שזה עתה נפתח.
  const handleGridLeave = () => {
    clearTimeout(openTimer.current);
    if (!pinned) setExpanded(null);
  };

  return (
    <div
      className={`site-grid grid-${density}`}
      onPointerMove={trackPointer}
      onMouseLeave={handleGridLeave}
    >
      {sites.map((site) => (
        <SiteCard
          key={site.code}
          site={site}
          density={density}
          expanded={expanded === site.code}
          onToggle={toggle}
          onHover={handleCardEnter}
          onOpenDetail={onSiteClick}
        />
      ))}
    </div>
  );
}

export default SiteGrid;
