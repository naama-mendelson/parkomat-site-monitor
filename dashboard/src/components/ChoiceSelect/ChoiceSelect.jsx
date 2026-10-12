// components/ChoiceSelect/ChoiceSelect.jsx — רשימה נפתחת מעוצבת, במקום <select>.
//
// נבנתה לסוג המעלית (בעלת המוצר, 12/10/2026: "תעצב את הSELECT יותר יפה וחדשני", ובחרה "רשימה נפתחת
// מעוצבת"). כמו "בודק מוסמך" שבכותרת (ComplianceFilters): הרשימה של <select> מצוירת על ידי מערכת
// ההפעלה ואי אפשר לעצב אותה, ולכן כפתור ורשימה משלנו — ומה ש-<select> נתן חינם נבנה כאן במפורש:
// נסגר בבחירה, בלחיצה בחוץ, ב-Esc וב-Tab; חיצים, Home/End, Enter/רווח; הפוקוס חוזר לכפתור;
// role=listbox / option / aria-selected.
//
// ⚠️ **הרשימה נפתחת ב-portal, במיקום fixed** — לא absolute בתוך הטופס. החלון של "הוספת אתר" גולל
// (overflow-y: auto), ורשימה שבתוכו הייתה נחתכת בגבולותיו או מגדילה את הגלילה במקום לצוף מעליו.
// המיקום נמדד מהכפתור, ומתעדכן בגלילה ובשינוי גודל. אין מקום מתחת — נפתחת למעלה.
// ⚠️ ולחיצה בתוך ה-portal אינה "בחוץ" מבחינת המודאל: אירועי React עוברים דרך עץ הקומפוננטות ולא דרך
// ה-DOM, ולכן ה-stopPropagation של המודאל (AddSiteModal, AdminPanel) עוצר אותם כרגיל.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./ChoiceSelect.css";

const GAP = 6;          // בין הכפתור לרשימה
const EDGE = 8;         // מרחק מינימלי משולי המסך
const MAX_H = 320;

/**
 * @param {object} p
 * @param {string} p.value — "" = לא נבחר
 * @param {{value: string, label: string}[]} p.options
 * @param {(v: string) => void} p.onChange
 * @param {string} p.label — שם השדה, לקורא מסך ("סוג מעלית")
 * @param {string} [p.placeholder] — מה שכתוב כשאין ערך. ⚠️ אינו אפשרות ברשימה; מי שצריך "בלי" מעביר אותה
 *   כאפשרות עם value "".
 * @param {string} [p.name] — data-name על הכפתור (בדיקות, ותווית של השדה)
 * @param {boolean} [p.invalid] — מסגרת אדומה ו-aria-invalid
 */
export default function ChoiceSelect({ value, options, onChange, label, placeholder = "— לבחור —", name, invalid = false }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState(null);
  const btn = useRef(null);
  const menu = useRef(null);
  const listId = useId();
  const current = options.find((o) => o.value === value) ?? null;
  const shown = current && current.value !== "" ? current.label : null;
  // מה שקורא מסך אומר כשאין ערך: שם האפשרות הריקה אם יש כזו ("לא הוגדר"), ולא ה-placeholder ("— לבחור —")
  const emptyName = options.find((o) => o.value === "")?.label ?? "לא נבחר";

  // ⚠️ RTL: הרשימה מתחילה בקצה הימני של הכפתור ונמשכת שמאלה (כמו הטקסט שבו), ולא חורגת מהמסך
  const place = useCallback(() => {
    const b = btn.current?.getBoundingClientRect();
    if (!b) return;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const width = Math.min(Math.max(b.width, 200), vw - 2 * EDGE);
    const rtl = getComputedStyle(btn.current).direction === "rtl";
    const left = Math.min(Math.max(EDGE, rtl ? b.right - width : b.left), vw - EDGE - width);
    const below = vh - b.bottom - GAP - EDGE;
    const above = b.top - GAP - EDGE;
    const need = Math.min(MAX_H, menu.current ? menu.current.scrollHeight + 2 : MAX_H);
    const up = below < need && above > below;
    setPos({ left, width, up, maxH: Math.max(120, Math.min(MAX_H, up ? above : below)),
      top: up ? null : b.bottom + GAP, bottom: up ? vh - b.top + GAP : null });
  }, []);

  const close = (refocus = true) => {
    setOpen(false);
    setPos(null);
    if (refocus) btn.current?.focus({ preventScroll: true });
  };
  const pick = (v) => { if (v !== value) onChange(v); close(); };
  const openMenu = () => {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };

  // מיקום ראשון לפני הציור, ושוב אחרי שהרשימה קיימת (הגובה שלה קובע אם למעלה או למטה)
  useLayoutEffect(() => { if (open) place(); }, [open, place]);
  useLayoutEffect(() => { if (open && pos && menu.current) place(); }, [open, pos === null]); // eslint-disable-line react-hooks/exhaustive-deps

  // גלילה (גם של המודאל שבתוכו) או שינוי גודל — הרשימה נשארת צמודה לכפתור
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const onMove = (e) => {
      if (menu.current && e?.target instanceof Node && menu.current.contains(e.target)) return;   // גלילה בתוך הרשימה
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(place);
    };
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("scroll", onMove, true); window.removeEventListener("resize", onMove); };
  }, [open, place]);

  // לחיצה מחוץ לכפתור ולרשימה — נסגרת, בלי להחזיר פוקוס (הלחיצה הלכה למקום אחר)
  useEffect(() => {
    if (!open) return;
    const away = (e) => {
      if (btn.current?.contains(e.target) || menu.current?.contains(e.target)) return;
      close(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // הפוקוס עוקב אחרי השורה הפעילה — כך גם קורא מסך שומע אותה. ⚠️ preventScroll: focus() רגיל גולל את
  // הדף (או את המודאל) אל השורה, והגלילה מזיזה את הכפתור מתחת לרשימה.
  useEffect(() => {
    if (!open || !pos) return;
    const el = menu.current?.querySelectorAll('[role="option"]')[active];
    if (!el) return;
    el.focus({ preventScroll: true });
    const m = menu.current;
    if (el.offsetTop < m.scrollTop) m.scrollTop = el.offsetTop;
    else if (el.offsetTop + el.offsetHeight > m.scrollTop + m.clientHeight) m.scrollTop = el.offsetTop + el.offsetHeight - m.clientHeight;
  }, [open, pos, active]);

  const onMenuKey = (e) => {
    const last = options.length - 1;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(last, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(last); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(options[active].value); }
    // ⚠️ Tab: הרשימה יושבת בסוף ה-body, ו-Tab משם היה מוציא את הפוקוס מהטופס — חוזרים לכפתור
    else if (e.key === "Tab") { e.preventDefault(); close(); }
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`cs-btn${open ? " is-open" : ""}${invalid ? " is-invalid" : ""}${shown ? "" : " is-empty"}`}
        data-name={name}
        data-value={value || ""}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-invalid={invalid || undefined}
        aria-label={`${label}: ${shown ?? emptyName}`}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(e) => { if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); openMenu(); } }}
      >
        <span className="cs-value">{shown ?? placeholder}</span>
        {/* אותו חץ כמו ה-<select> המעוצבים בטופס (AddSiteModal.css) — SVG ולא "▾", שיצא זעיר */}
        <svg className="cs-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && createPortal(
        <div
          ref={menu}
          id={listId}
          className={`cs-menu${pos?.up ? " is-up" : ""}`}
          role="listbox"
          aria-label={label}
          dir="rtl"
          style={pos ? { left: pos.left, width: pos.width, top: pos.top ?? undefined, bottom: pos.bottom ?? undefined, maxHeight: pos.maxH }
            : { visibility: "hidden", left: 0, top: 0 }}
          onKeyDown={onMenuKey}
        >
          {options.map((o, i) => (
            <div
              key={o.value || "__none__"}
              role="option"
              tabIndex={-1}
              aria-selected={o.value === value}
              data-value={o.value}
              className={`cs-item${o.value === value ? " is-selected" : ""}${o.value === "" ? " is-none" : ""}`}
              onClick={() => pick(o.value)}
              onMouseEnter={() => setActive(i)}
            >
              <span className="cs-item-label">{o.label}</span>
              <span className="cs-item-check" aria-hidden="true">{o.value === value ? "✓" : ""}</span>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
