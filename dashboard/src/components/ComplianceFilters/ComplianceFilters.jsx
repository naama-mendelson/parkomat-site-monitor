// components/ComplianceFilters/ComplianceFilters.jsx — "בודק מוסמך" בסינון שבכותרת: אריח שנפתח לרשימה.
//
// בעלת המוצר (08/10/2026): "כשלוחצים על בודק מוסמך יפתח תפריט מתחת, ואז יצטרכו לבחור מה רואים, ואז
// זה יסגר בסיום הבחירה". ואחר כך: "תעשה את זה יותר יפה" — על האריח. ולפני כן: הנורה בכרטיס "מופיעה
// רק כשמסמנים", כל המצבים מופיעים תמיד (גם 0), ו"אין נתונים" / "לא נטען" — "תעיף את זה, זה לא קיים".
//
// ⚠️ תפריט משלנו ולא <select>: הרשימה של <select> מצוירת על ידי מערכת ההפעלה — לבנה, בלי צבע ובלי
// הנורה — ואי אפשר לעצב אותה. כאן כל שורה נושאת את הנורה של המצב (LampSwatch, אותה מנורה כמו בכרטיס),
// והאריח הסגור נראה כמו אריחי המצב שלידו: מספר גדול, שם, וצבע המצב כשנבחר.
// מה שה-<select> נתן חינם ונשמר כאן במפורש: נסגר בבחירה, בלחיצה בחוץ וב-Esc; חיצים, Enter ו-Home/End;
// הפוקוס חוזר לאריח; role=listbox / option / aria-selected.
// ⚠️ בחירה אחת בכל פעם, כמו הבוררים שלידו. המודל (only) תומך בכמה — הממשק לא מציע.
//
// אין כאן החלטה על מצב: השורות, המפתחות, הספירה והסינון ב-utils/compliance.js.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AreaIcon } from "../Compliance/icons";
import { LampSwatch } from "../Compliance/ComplianceLights";
import {
  AREA_NAME, COMPLIANCE_AREAS, COMPLIANCE_FILTER_ROWS, DEFAULT_COMPLIANCE_VIEW, complianceFilterCounts,
} from "../../utils/compliance";
import "./ComplianceFilters.css";

const OFF = "__off__";
const ALL = "__all__";

function AreaPicker({ area, sites, counts, value, onPick }) {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(0);
  const [alignEnd, setAlignEnd] = useState(false);
  const [maxH, setMaxH] = useState(null);
  const wrap = useRef(null);
  const btn = useRef(null);
  const menu = useRef(null);

  const on = value?.show === true;
  const row = COMPLIANCE_FILTER_ROWS[area].find((r) => r.key === value?.only?.[0]);
  const current = !on ? OFF : row ? row.key : ALL;

  const items = [
    { value: OFF, label: `בלי ${AREA_NAME[area]}`, hint: "בלי נורות בכרטיסים" },
    { value: ALL, label: "כל האתרים", n: sites.length },
    ...COMPLIANCE_FILTER_ROWS[area].map((r) => ({ value: r.key, label: r.label, n: counts[r.key], swatch: r.swatch, title: r.title })),
  ];

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
        className={`filter-btn cf-area-btn${on ? " active" : ""}${row ? ` cf-area-btn--${row.key}` : ""}`}
        data-choice={current}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${AREA_NAME[area]}: ${items.find((it) => it.value === current).label}`}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(e) => { if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); openMenu(); } }}
      >
        {row ? (
          // נבחר מצב — כמו אריח מצב: המספר הגדול הוא כמה אתרים מוצגים עכשיו
          <span className="filter-count cf-head"><LampSwatch state={row.swatch} area={area} /> {counts[row.key]}</span>
        ) : (
          <span className="filter-count cf-head" aria-hidden="true"><AreaIcon area={area} size={22} /></span>
        )}
        <span className="filter-label cf-name">
          {row ? row.label : AREA_NAME[area]}
          <span className={`cf-chevron${open ? " is-open" : ""}`} aria-hidden="true">▾</span>
        </span>
        {/* מתחת לשם — מה המצב: מי שבחר מצב רואה מאיזה תחום הוא, ומי שבחר "כל האתרים" רואה שזה פעיל */}
        {row && <span className="cf-sub">{AREA_NAME[area]}</span>}
        {on && !row && <span className="cf-sub">כל האתרים</span>}
      </button>

      {open && (
        <div
          ref={menu}
          className={`cf-menu${alignEnd ? " cf-menu--end" : ""}`}
          style={maxH ? { maxHeight: `${maxH}px` } : undefined}
          role="listbox"
          aria-label={`${AREA_NAME[area]} — מה להציג`}
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
              className={`cf-item${it.value === current ? " is-selected" : ""}${it.n === 0 ? " is-empty" : ""}${it.value === OFF ? " cf-item--off" : ""}${it.value === ALL ? " cf-item--all" : ""}`}
              onClick={() => pick(it.value)}
              onMouseEnter={() => setFocus(i)}
            >
              <span className="cf-item-mark" aria-hidden="true">
                {it.swatch ? <LampSwatch state={it.swatch} area={area} /> : it.value === ALL ? <AreaIcon area={area} size={14} /> : "○"}
              </span>
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

function ComplianceFilters({ sites, value = DEFAULT_COMPLIANCE_VIEW, onChange, areas = COMPLIANCE_AREAS }) {
  const counts = complianceFilterCounts(sites, areas);
  return areas.map((area) => (
    <AreaPicker
      key={area}
      area={area}
      sites={sites}
      counts={counts[area]}
      value={value[area]}
      onPick={(v) => onChange({ ...value, [area]: v === OFF ? { show: false, only: [] } : { show: true, only: v === ALL ? [] : [v] } })}
    />
  ));
}

export default ComplianceFilters;
