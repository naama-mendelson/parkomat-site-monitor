// components/SiteGrid/SiteGrid.jsx — רשת כרטיסי אתרים עם צפיפות דינמית (PRD 12.1)
import { useState, useEffect, useLayoutEffect, useRef } from "react";
import SiteCard from "../SiteCard/SiteCard";
import { densityFor, DENSITY } from "../../utils/constants";
import "./SiteGrid.css";

// ⚠️ רוחב מזערי לכרטיס הפתוח, ולא מספר עמודות קבוע: עמודה היא 260px ומעלה
// ב-normal אבל 140px ב-mini, ו"שתי עמודות" ב-mini היו כרטיס של 290px שבו הכול
// נערם לגובה — בדיוק מה שהיה צריך לגלול. 440 = שתי עמודות ב-normal, שלוש ב-compact.
const EXPANDED_MIN_W = 440;
// הערכה לרינדור הראשון בלבד; useLayoutEffect מודד ומתקן לפני הציור.
const EXPANDED_EST_H = 360;

/**
 * גובה התוכן של כרטיס — בלי המתיחה של שורת הרשת.
 *
 * ⚠️ **נסכם מהילדים, ולא נמדד מהכרטיס.** כרטיס נמתח לגובה השורה שלו
 * (align-self: stretch), כך שגובהו הוא *תוצאה* של הרשת — ובכרטיס הפתוח,
 * של מספר השורות שבחרנו. מדידתו הייתה נועלת אותו על הבחירה הקודמת.
 * ⚠️ offsetHeight ולא getBoundingClientRect: אנימציית הפתיחה מתחילה
 * ב-scale(0.94), ו-rect היה מודד כרטיס מוקטן.
 * ⚠️ ובלי שוליים: ל-.exp-open יש margin-top: auto, ו-getComputedStyle מחזיר
 * את הערך *בפועל* — כלומר את השטח שנמתח. אותה נעילה, מהדלת האחורית.
 */
function contentHeight(el) {
  const cs = getComputedStyle(el);
  const kids = [...el.children].filter((k) => {
    if (!k.getClientRects().length) return false;            // display: none
    const p = getComputedStyle(k).position;
    return p !== "absolute" && p !== "fixed";                 // לא תופס מקום
  });
  const frame = parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop)
              + parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth);
  // mini הוא flex בשורה — הגבוה מבין הילדים, לא סכומם
  if (cs.flexDirection.startsWith("row")) return frame + Math.max(0, ...kids.map((k) => k.offsetHeight));
  return frame + (parseFloat(cs.rowGap) || 0) * Math.max(0, kids.length - 1)
               + kids.reduce((s, k) => s + k.offsetHeight, 0);
}

/**
 * כמה שורות של הרשת הכרטיס הפתוח יתפוס, החל מ-startRow (1-based).
 *
 * ⚠️ **לפי הגובה הטבעי של כל שורה, ולא לפי "שורה רגילה" — נמדד.** הגרסה
 * הראשונה חילקה בגובה הכרטיס הסגור הנמוך ביותר. אבל אתר דו-מערכתי (פלורנטין)
 * גבוה ממנו בכמחצית, וכשהוא בשורה של הכרטיס הפתוח השורות יצאו גבוהות מהחישוב:
 * 107px ריקים בתוך הכרטיס ושכנים שנמתחו ב-115px.
 *
 * לכן: גובה כל שורה = התוכן של הכרטיס הסגור הגבוה בה, ובוחרים את מספר השורות
 * שסכומן הכי קרוב לתוכן של הכרטיס הפתוח. חסר — השורות גדלות והשכנים נמתחים;
 * עודף — שטח פנוי בכרטיס הפתוח.
 *
 * ⚠️ **חסר שוקל פי 1.5.** שכן שנמתח הוא כרטיס עם בטן ריקה, ובשורה יש כמה כאלה;
 * השטח הפנוי בכרטיס הפתוח מתחלק בין חלקיו (justify-content ב-CSS) ואינו נראה
 * כחור. נמדד בשורה עם שני אתרים דו-מערכתיים: 100px מתיחה מול 87px פנוי.
 */
function chooseRows(card, grid, startRow) {
  const h = contentHeight(card);
  const gs = getComputedStyle(grid);
  const gap = parseFloat(gs.rowGap) || 0;
  const tracks = gs.gridTemplateRows.split(" ").map(parseFloat).filter(Number.isFinite);
  const gTop = grid.getBoundingClientRect().top + parseFloat(gs.borderTopWidth) + parseFloat(gs.paddingTop);
  const starts = [];
  let y = 0;
  for (const t of tracks) { starts.push(y); y += t + gap; }

  const nat = tracks.map(() => 0);
  for (const c of grid.querySelectorAll(".site-card:not(.is-expanded)")) {
    // ריחוף מזיז כרטיס ב-2px (translateY) — הסבולת היא חצי רווח
    const top = c.getBoundingClientRect().top - gTop;
    let i = 0;
    while (i + 1 < starts.length && starts[i + 1] <= top + gap / 2 + 3) i++;
    nat[i] = Math.max(nat[i], contentHeight(c));
  }

  let best = 1;
  let bestCost = Infinity;
  let area = -gap;
  for (let k = 1; k <= 24; k++) {
    const row = nat[startRow - 2 + k];
    // שורה בלי אף כרטיס סגור (סוף הרשימה) נמדדת לפי הכרטיס הפתוח עצמו — אין
    // שכן שיימתח ואין שטח שיישאר ריק.
    if (!row) { if (area < h) best = k; break; }
    area += row + gap;
    const cost = area >= h ? area - h : (h - area) * 1.5;
    if (cost < bestCost - 0.5) { best = k; bestCost = cost; }
    if (area >= h) break;                                       // עוד שורה = רק עוד ריק
  }
  return best;
}

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
      // חלון המשימות של האתר נפתח מהכרטיס — לחיצה בתוכו אינה "מחוץ לכרטיס": כשהוא
      // נסגר חוזרים לכרטיס הפתוח, לא לרשת שבה הכרטיס התכווץ מתחת לחלון.
      if (el instanceof Element && el.closest(".tk-overlay")) return;
      setPinned(false);
      setExpanded(null);
    };

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [expanded]);

  // כמה שורות הכרטיס הפתוח תופס — נמדד אחרי שהוא מוצב ברוחבו, ומתוקן לפני
  // הציור. ⚠️ `sites` בתלויות: התוכן משתנה עם הנתונים החיים (פעולה שנפתחה מוסיפה
  // שורה לכרטיס). setState רק כשהמספר באמת השתנה — אחרת אין רינדור נוסף.
  //
  // ⚠️ **ושוב אחרי כל תיקון, עד שלוש פעמים.** מי יושב בשורות שליד הכרטיס תלוי
  // במספר השורות שהוא תופס (הכרטיסים זורמים סביבו), ולכן הבחירה נבדקת שוב
  // אחרי שהוצבה. התקרה נגד מצב שבו שתי בחירות מחליפות זו את זו בלי סוף.
  const [expRows, setExpRows] = useState(null);
  const adjust = useRef({ key: "", n: 0 });
  useLayoutEffect(() => {
    if (!expanded || !gridRef.current || cols < 2) return;
    const card = gridRef.current.querySelector(`.site-card.is-expanded[data-code="${CSS.escape(expanded)}"]`);
    const index = sites.findIndex((s) => s.code === expanded);
    if (!card || index < 0 || !String(card.style.gridRow).includes("span")) return;
    const key = `${expanded}|${cols}|${box.w}|${sites.length}`;
    if (adjust.current.key !== key) adjust.current = { key, n: 0 };
    if (adjust.current.n >= 3) return;
    const rows = chooseRows(card, gridRef.current, Math.floor(index / cols) + 1);
    setExpRows((prev) => {
      if (prev && prev.code === expanded && prev.rows === rows) return prev;
      adjust.current.n += 1;
      return { code: expanded, rows };
    });
  }, [expanded, cols, box, sites, expRows]);

  // הכרטיס נפתח במקומו (או שורה מתחת, כשהוא ברוחב השורה — ראה placementFor),
  // ואולי מתחת לקצה המסך.
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
  // הכרטיס המורחב — ריבוע במקום שבו לחצו
  // ==========================================================
  // ⚠️ **שלוש גרסאות, ושתיים נדחו על ידי בעלת המוצר — כל אחת מסיבה אחרת:**
  //   1. 2×2 תאים — ב-compact/mini כרטיס של 320–450px, הכותרת והמדדים נערמו
  //      לגובה, ו-2 שורות של 85px לא הכילו אותו: השורות נמתחו ו"צריך לגלול".
  //   2. שורה שלמה, מתחת לשורה שבה לחצו (fd7d373) — "לא אוהבת שהוא נפתח לכל
  //      רוחב המסך, עדיף יותר מרובע" (05/10/2026): פס של 1,800×278.
  //   3. כאן: **רוחב** לפי EXPANDED_MIN_W (2–4 עמודות, ~450–650px), ו**גובה**
  //      לפי התוכן — כמה שורות שצריך (expandedRows). זה מה שחסר בגרסה 1: מספר
  //      השורות היה קבוע, ולכן הכרטיס לא נכנס בהן.
  //
  // ⚠️ **במקום, ולא בשורה שמתחת.** הכרטיס הפתוח מכסה את התא שבו לחצו, כך שהוא
  // נשאר מתחת לסמן. בעמודות האחרונות הוא זז פנימה (start) כדי להיכנס, וזה
  // מזיז את *השכנים* שקדמו לו בשורה — הם עוברים לתאים הפנויים שאחריו. Grid
  // מציב קודם את המפורש, ושאר הכרטיסים (כולם 1×1) ממלאים כל תא פנוי: אין חורים.
  //
  // ⚠️ **שורה *וגם* עמודה, מפורשות.** עם עמודה בלבד Grid מחפש את השורה הראשונה
  // שבה כל העמודות פנויות — כלומר הכרטיס קופץ למטה (נמדד בעבר: 183px).
  //
  // ⚠️ כשהרוחב הנדרש הוא כל השורה (טלפון, טאבלט) — שורה שלמה *מתחת*, כמו
  // בגרסה 2: במקום, היה דוחף את כל הכרטיסים שקדמו לו בשורה אל מתחתיו.
  const spanCols = () => {
    const gap = DENSITY.GAP[density] ?? 14;
    const colW = (box.w - (cols - 1) * gap) / cols;
    let n = 2;
    while (n < cols && n * colW + (n - 1) * gap < EXPANDED_MIN_W) n++;
    return n;
  };

  const placementFor = (index, code) => {
    if (cols < 2) return undefined;                  // עמודה אחת — כבר כל הרוחב
    const row = Math.floor(index / cols) + 1;
    const n = spanCols();
    if (n >= cols) return { gridColumn: "1 / -1", gridRow: `${row + 1}` };
    const start = Math.min(index % cols, cols - n) + 1;
    const rows = expRows?.code === code
      ? expRows.rows
      : Math.max(1, Math.round(EXPANDED_EST_H / (DENSITY.CARD_H[density] ?? 168)));
    return { gridColumn: `${start} / span ${n}`, gridRow: `${row} / span ${rows}` };
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
          style={expanded === site.code ? placementFor(index, site.code) : undefined}
          onToggle={toggle}
          onHover={handleCardEnter}
          onOpenDetail={onSiteClick}
        />
      ))}
    </div>
  );
}

export default SiteGrid;
