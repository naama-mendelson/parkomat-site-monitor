// components/ComplianceFilters/FilterPicker.jsx — אריח בסינון שבכותרת שנפתח לרשימה. משותף ל"בודק מוסמך" / "תחזוקה
// מונעת" (ComplianceFilters) ול"משימות" (TasksFilter) — 18/10/2026, כשנוסף השני: עותק שני של המקלדת, הסגירה בחוץ
// והמיקום בטלפון היה נפרד מהראשון בשקט בתיקון הבא.
//
// ⚠️ תפריט משלנו ולא <select>: הרשימה של <select> מצוירת על ידי מערכת ההפעלה — לבנה, בלי צבע ובלי סימן — ואי אפשר
// לעצב אותה. מה שה-<select> נתן חינם ונשמר כאן במפורש: נסגר בבחירה, בלחיצה בחוץ וב-Esc; חיצים, Enter ו-Home/End;
// הפוקוס חוזר לאריח; role=listbox / option / aria-selected. בחירה אחת בכל פעם.
//
// items: [{ value, label, hint?, n?, title?, mark, cls? }] — mark הוא מה שמצויר בתחילת השורה; cls — מחלקה נוספת לשורה.
// head(open) — תוכן האריח הסגור. אין כאן החלטה על מה מוצג: היא אצל מי שמשתמש ברכיב.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./ComplianceFilters.css";

export default function FilterPicker({ items, current, onPick, btnClass = "", ariaLabel, menuLabel, head }) {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(0);
  const [alignEnd, setAlignEnd] = useState(false);
  const [maxH, setMaxH] = useState(null);
  const wrap = useRef(null);
  const btn = useRef(null);
  const menu = useRef(null);

  const close = (refocus = true) => { setOpen(false); if (refocus) btn.current?.focus(); };
  const pick = (v) => { onPick(v); close(); };
  const openMenu = () => { setFocus(Math.max(0, items.findIndex((it) => it.value === current))); setAlignEnd(false); setMaxH(null); setOpen(true); };

  // נסגר בלחיצה מחוץ לאריח ולרשימה
  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (!wrap.current?.contains(e.target)) close(false); };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);

  // ⚠️ הרשימה נצמדת לצד הימני של האריח ונמשכת שמאלה. בטלפון האריח יכול לשבת בקצה השמאלי, ואז היא
  // הייתה יוצאת מהמסך — אז נמדד אחרי הפתיחה, ואם אין מקום היא נצמדת לצד השמאלי ונמשכת ימינה.
  // ⚠️ והגובה מוגבל למה שנשאר עד תחתית המסך: הכותרת דביקה, והרשימה בתוכה אינה זזה בגלילה — בטלפון
  // נמוך השורות התחתונות היו נחתכות בלי דרך להגיע אליהן. מעבר לגובה — גלילה בתוך הרשימה.
  useLayoutEffect(() => {
    if (!open || !menu.current) return;
    const r = menu.current.getBoundingClientRect();
    if (r.left < 8) setAlignEnd(true);
    setMaxH(Math.max(160, window.innerHeight - r.top - 8));
  }, [open]);

  // הפוקוס עוקב אחרי השורה המסומנת — כך גם קורא מסך שומע מה נבחר.
  // ⚠️ preventScroll: focus() רגיל גולל את הדף אל השורה, ובטלפון גלילה סוגרת את "סינון ותצוגה" כולו
  // (Header.jsx) — הרשימה נעלמה מתחת לאצבע. נמדד ב-probe-cf (P4).
  useEffect(() => {
    if (!open) return;
    const el = menu.current?.querySelectorAll('[role="option"]')[focus];
    el?.focus({ preventScroll: true });
    // בתוך הרשימה עצמה (כשהיא גוללת) — כן להביא את השורה לתצוגה, בלי להזיז את הדף
    if (el && menu.current.scrollHeight > menu.current.clientHeight) {
      const m = menu.current;
      if (el.offsetTop < m.scrollTop) m.scrollTop = el.offsetTop;
      else if (el.offsetTop + el.offsetHeight > m.scrollTop + m.clientHeight) m.scrollTop = el.offsetTop + el.offsetHeight - m.clientHeight;
    }
  }, [open, focus]);

  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setFocus((i) => Math.min(items.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setFocus((i) => Math.max(0, i - 1)); }
    else if (e.key === "Home") { e.preventDefault(); setFocus(0); }
    else if (e.key === "End") { e.preventDefault(); setFocus(items.length - 1); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(items[focus].value); }
    else if (e.key === "Tab") close(false);
  };

  return (
    <div className="cf-picker" ref={wrap}>
      <button
        ref={btn}
        type="button"
        className={`filter-btn ${btnClass}`.trim()}
        data-choice={current}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(e) => { if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); openMenu(); } }}
      >
        {head(open)}
      </button>

      {open && (
        <div
          ref={menu}
          className={`cf-menu${alignEnd ? " cf-menu--end" : ""}`}
          style={maxH ? { maxHeight: `${maxH}px` } : undefined}
          role="listbox"
          aria-label={menuLabel}
          onKeyDown={onKey}
        >
          {items.map((it, i) => (
            <div
              key={it.value}
              role="option"
              tabIndex={-1}
              aria-selected={it.value === current}
              data-value={it.value}
              title={it.title}
              className={`cf-item${it.value === current ? " is-selected" : ""}${it.n === 0 ? " is-empty" : ""}${it.cls ? ` ${it.cls}` : ""}`}
              onClick={() => pick(it.value)}
              onMouseEnter={() => setFocus(i)}
            >
              <span className="cf-item-mark" aria-hidden="true">{it.mark}</span>
              <span className="cf-item-label">
                {it.label}
                {it.hint && <span className="cf-item-hint">{it.hint}</span>}
              </span>
              {it.n != null && <span className="cf-item-count">{it.n}</span>}
              <span className="cf-item-check" aria-hidden="true">{it.value === current ? "✓" : ""}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
