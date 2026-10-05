// components/SiteGrid/SiteGrid.jsx — רשת כרטיסי אתרים עם צפיפות דינמית (PRD 12.1)
import { useState, useEffect, useRef } from "react";
import SiteCard from "../SiteCard/SiteCard";
import { densityFor } from "../../utils/constants";
import "./SiteGrid.css";

function SiteGrid({ sites, onSiteClick }) {
  // רק כרטיס אחד מורחב בכל רגע — אחרת הרשת מתפרקת ואי אפשר לסרוק אותה
  const [expanded, setExpanded] = useState(null);

  // מספר העמודות בפועל. נדרש כדי לדעת באיזו שורה יושב כל כרטיס — ראה
  // placementFor למטה. auto-fill קובע אותו לפי הרוחב, ולכן הוא משתנה
  // עם גודל החלון ואי אפשר לגזור אותו מרמת הצפיפות בלבד.
  const gridRef = useRef(null);
  const [cols, setCols] = useState(0);

  // ============================================================
  // ⚠️ המקום שיש — לא מספר האתרים
  // ============================================================
  // הצפיפות נקבעה קודם מ-`sites.length` בלבד, ולכן ב-21 אתרים על מסך
  // רחב הכרטיסים התכווצו בזמן שרוב המסך היה ריק. נמדד ונראה על המסך.
  //
  // כאן נמדדים הרוחב של הרשת והגובה שנשאר לה עד תחתית החלון; הבחירה
  // עצמה חיה ב-`densityFor` — פונקציה טהורה, בלי DOM.
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = gridRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const measure = () => {
      const n = getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length;
      setCols((prev) => (prev === n ? prev : n));

      // ⚠️ הגובה נמדד מראש הרשת ולא מ-innerHeight: מעליה יושבות הכותרת
      // והמסננים, ובלי החיסור הזה הרשת "נכנסת" בחישוב וגולשת במסך.
      const top = el.getBoundingClientRect().top;
      const w = el.clientWidth;
      const h = Math.max(0, window.innerHeight - top - 16);
      setBox((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);

    // ⚠️ ResizeObserver על הרשת לבדו אינו מספיק: שינוי **גובה** החלון
    // אינו משנה את רוחב הרשת, ולכן אינו מפעיל אותו — והצפיפות הייתה
    // נשארת של הגובה הקודם.
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
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

  // הכרטיס נפתח שורה אחת מתחת (ראה placementFor) — ואולי מתחת לקצה המסך.
  // גוללים **רק כמה שצריך** (nearest) כדי שכולו ייראה; אם הוא כבר גלוי, שום
  // דבר לא זז.
  //
  // ⚠️ **אחרי אנימציית הפתיחה, לא בתחילתה — נמדד.** cardExpand מתחיל ב-scale(0.94),
  // ו-scrollIntoView מודד את הכרטיס *המוקטן*: הגלילה עצרה 8px לפני הקצה התחתון
  // במחשב ו-13px בטלפון (3% מגובה הכרטיס, בדיוק). 320ms > 280ms של האנימציה.
  // ⚠️ ולפני ה-return המוקדם שמתחת — hook אחריו נקרא רק כשיש אתרים, ו-React
  // קורס ברגע שהרשימה מתרוקנת או מתמלאת.
  useEffect(() => {
    if (!expanded || !gridRef.current) return undefined;
    let reduce = false;
    try { reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { /* */ }
    const t = setTimeout(() => {
      const el = gridRef.current?.querySelector(`.site-card.is-expanded[data-code="${CSS.escape(expanded)}"]`);
      el?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
    }, reduce ? 0 : 320);
    return () => clearTimeout(t);
  }, [expanded]);

  if (sites.length === 0) {
    return <div className="grid-empty">לא נמצאו אתרים</div>;
  }

  const density = densityFor(sites.length, box.w, box.h);

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
  // הכרטיס המורחב — שורה שלמה, ממש מתחת לשורה שבה לחצו
  // ==========================================================
  // ⚠️ **לרוחב ולא לגובה — בקשת בעלת המוצר (05/10/2026):** "עדיף שהכרטיס
  // יפתח לרוחב ולא יצטרכו לגלול אותו". הוא תפס 2×2 תאים, ובצפיפות compact/mini
  // זה כרטיס של 320–450px שבו הכותרת והמדדים נערמו לגובה — עד שהיה צריך לגלול
  // כדי לראות את כולו. בשורה שלמה ארבעת המדדים עומדים זה לצד זה.
  //
  // ⚠️ **מיקום מפורש בשורה *שמתחת*, ולא auto-placement.** כרטיס ברוחב שורה
  // שמוצב אוטומטית קופץ לשורה הבאה ומשאיר חורים בשורה שבה היה (התאים שאחריו
  // ריקים עד סוף השורה). בשורה שמתחת — Grid מציב קודם את המפורש, והשכנים
  // שאחריו ממלאים את מקומו בשורה המקורית: אין חורים, והכרטיס נפתח כמגירה
  // ישירות מתחת למקום שבו לחצו.
  //
  // (הגרסה הקודמת — 2 עמודות, ומיקום מפורש רק בעמודה האחרונה כדי שלא יקפוץ
  // 183px — מתועדת בהיסטוריה של הקובץ.)
  const placementFor = (index) => {
    if (cols < 2) return undefined;                  // עמודה אחת — כבר כל הרוחב
    return {
      gridColumn: "1 / -1",
      gridRow: `${Math.floor(index / cols) + 2}`,
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
