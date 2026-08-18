// components/SiteGrid/SiteGrid.jsx — רשת כרטיסי אתרים עם צפיפות דינמית (PRD 12.1)
import { useState, useEffect, useRef } from "react";
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

  // מספר העמודות בפועל. נדרש כדי לדעת מי יושב בעמודה האחרונה — ראה
  // placementFor למטה. auto-fill קובע אותו לפי הרוחב, ולכן הוא משתנה
  // עם גודל החלון ואי אפשר לגזור אותו מרמת הצפיפות בלבד.
  const gridRef = useRef(null);
  const [cols, setCols] = useState(0);

  useEffect(() => {
    const el = gridRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const measure = () => {
      const n = getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length;
      setCols((prev) => (prev === n ? prev : n));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // לחיצה *נועלת* את הכרטיס פתוח: הוא לא ייסגר כשהעכבר יוצא, רק בלחיצה
  // מחוץ לו. ריחוף לעומת זאת הוא ארעי. בלי ההבחנה הזו, כרטיס שנפתח בלחיצה
  // היה נסגר ברגע שהעכבר זז כדי ללחוץ על "פתח פירוט מלא".
  const [pinned, setPinned] = useState(false);

  const openTimer = useRef(null);
  const pointer = useRef({ x: 0, y: 0 });

  // ⚠️ כאן ישבה בדיקת (hover: hover) — היא הפרידה בין מכשיר עם מצביע
  // אמיתי לבין מסך מגע, שבו "hover" נדבק אחרי נגיעה. מרגע שהפתיחה היא
  // בלחיצה בלבד, שני סוגי המכשירים מתנהגים אותו דבר ואין מה להפריד.

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

  // ============================================================
  // ⚠️ פתיחה בלחיצה בלבד — הריחוף **הוסר**
  // ============================================================
  // כאן ישבה פתיחה אחרי 120ms של ריחוף. היא הוסרה לבקשת המשתמשת, והנימוק
  // מעשי: הכרטיס המורחב תופס 2×2 תאים ולכן **מזיז את הפריסה**, כך שסתם
  // מעבר עם העכבר על פני הרשת היה מקפיץ כרטיסים ומזיז את מה שמנסים ללחוץ
  // עליו. מי שרוצה לפתוח, לוחץ.
  //
  // ⚠️ הפונקציה נשארת כמעט-ריקה ולא נמחקת, כי SiteCard עדיין מעביר
  // onHover: היא מבטלת טיימר שעלול להיות תלוי מלחיצה קודמת. מחיקת ה-prop
  // הייתה שינוי בשני קבצים בלי תועלת נוספת.
  const handleCardEnter = () => {
    clearTimeout(openTimer.current);
  };

  // סוגרים רק כשיוצאים מהרשת כולה — לא בכל יציאה מכרטיס בודד. אחרת הזזת
  // הפריסה (שנגרמת מההרחבה עצמה) הייתה סוגרת את הכרטיס שזה עתה נפתח.
  // ⚠️ יציאה מהרשת **אינה** סוגרת יותר. כשהפתיחה הייתה בריחוף, סגירה
  // ביציאה הייתה הכרחית — אחרת כרטיס שנפתח בטעות היה נשאר פתוח. עכשיו כל
  // פתיחה היא לחיצה מכוונת, וסגירתה בהזזת עכבר החוצה הייתה מבטלת כוונה.
  const handleGridLeave = () => {
    clearTimeout(openTimer.current);
  };

  // ==========================================================
  // כרטיס בעמודה האחרונה — מזיזים את השכן, לא אותו
  // ==========================================================
  // הכרטיס המורחב תופס 2 עמודות. כשהוא כבר בעמודה האחרונה אין לו לאן
  // להתרחב, ו-CSS Grid דוחף אותו לשורה הבאה — נמדד: קפיצה של 183px.
  //
  // זה גרוע במיוחד כי הכרטיס בורח **מתחת לסמן** בדיוק ברגע שנגעת בו. עד
  // כה זה טופל רק כסימפטום (האימות ב-handleCardEnter, שמנע לולאת
  // פתיחה/סגירה); כאן מטפלים בסיבה.
  //
  // הפתרון: מיקום מפורש בשתי העמודות האחרונות של **אותה שורה**. Grid
  // מציב פריטים בעלי מיקום מוגדר לפני האוטומטיים, ולכן הכרטיס נשאר במקומו
  // והשכן שמשמאלו הוא שזז. בדיוק מה שנדרש — מזיזים אחר כדי לפנות מקום.
  //
  // ⚠️ שורה *וגם* עמודה. עם עמודה בלבד, Grid מחפש את השורה הראשונה שבה שתי
  // העמודות פנויות — וזו כבר השורה הבאה, כלומר הבאג חוזר בדלת האחורית.
  //
  // ⚠️⚠️ ו-`span 2` חייב להיכתב כאן במפורש, בשתי הצורות המקוצרות. הגרסה
  // הראשונה קבעה gridColumnStart בלבד — וזה **דרס** את `grid-column: span 2`
  // שב-CSS והשאיר את הכרטיס ברוחב תא אחד, בזמן שהשכנים נמתחו לגובה כפול עם
  // שטח ריק. הבדיקה הראשונה פספסה את זה כי היא מדדה רק את מיקום ה-y ולא את
  // הגודל: הכרטיס אכן נשאר בשורה, אבל נפתח שבור.
  const placementFor = (index) => {
    if (cols < 2) return undefined;                  // עמודה אחת — אין מה להזיז
    if (index % cols !== cols - 1) return undefined; // לא בעמודה האחרונה
    return {
      gridColumn: `${cols - 1} / span 2`,
      gridRow: `${Math.floor(index / cols) + 1} / span 2`,
    };
  };

  return (
    <div
      ref={gridRef}
      className={`site-grid grid-${density}`}
      onPointerMove={trackPointer}
      onMouseLeave={handleGridLeave}
    >
      {sites.map((site, index) => (
        <SiteCard
          key={site.code}
          site={site}
          density={density}
          expanded={expanded === site.code}
          // רק למורחב: לכרטיס רגיל מיקום מפורש היה מקבע את כל הרשת ומבטל
          // את ה-auto-placement שמסדר אותה מחדש בכל שינוי רוחב.
          style={expanded === site.code ? placementFor(index) : undefined}
          onToggle={toggle}
          onHover={handleCardEnter}
          onOpenDetail={onSiteClick}
        />
      ))}
    </div>
  );
}

export default SiteGrid;
