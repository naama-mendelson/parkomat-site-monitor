// components/FilterGroup/FilterGroup.jsx — מלבן בכותרת שנפתח לחלונית עם כמה מסננים (19/10/2026).
//
// בעלת המוצר: "אני רוצה מלבנים שמכל אחד מהם נובע כמה דברים — אחד מצבים (הכל, מוכן, בפעולה, בתקלה, בתחזוקה, אין
// תקשורת), שני מידע (סוג, מערכת, מעליות, סוג שירות), שלישי תוספים (בודק מוסמך, תחזוקה מונעת, קריאות, משימות, תקלות
// חוזרות); ושני ריבועים — מכפילים ורובוטיים — שעליהם מתבצעים בעצם הריבועים".
//
// • המלבן הסגור: השם, ▾, ומתחתיו מה פעיל עכשיו (summary). מסומן (active) כשמשהו בו שונה מברירת המחדל.
// • החלונית נשארת פתוחה בזמן בחירה (אפשר לסמן כמה מצבים); נסגרת בלחיצה על המלבן, בלחיצה בחוץ וב-Esc.
//   רשימה פנימית שנפתחת בתוכה (FilterPicker של "בודק מוסמך" / "משימות") היא חלק ממנה — לחיצה בה אינה "בחוץ",
//   ו-Esc שלה סוגר רק אותה (preventDefault).
// • ⚠️ התוכן מרונדר תמיד, ומוסתר (hidden) כשהחלונית סגורה — לא מוסר. המסננים שבתוכה הם אותם רכיבים שהיו בשורה
//   (StatusFilters, SiteFilterTile, ComplianceFilters, TasksFilter), והמצב שלהם (למשל ספירות) לא נבנה מחדש בכל פתיחה.
// • בטלפון ובמסך צר (הכותרת מקופלת ל"סינון ותצוגה") החלונית נפרשת במקום, מתחת למלבן — לא מרחפת (FilterGroup.css).
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import "./FilterGroup.css";

export default function FilterGroup({ title, summary, active = false, className = "", children }) {
  const [open, setOpen] = useState(false);
  const [alignEnd, setAlignEnd] = useState(false);
  const wrap = useRef(null);
  const btn = useRef(null);
  const panel = useRef(null);
  const id = useId();

  const close = (refocus = true) => { setOpen(false); if (refocus) btn.current?.focus(); };

  // נסגרת בלחיצה מחוץ למלבן ולחלונית (רשימה פנימית של אריח — בתוכה; רשימת ChoiceSelect בפורטל — לא "בחוץ")
  useEffect(() => {
    if (!open) return;
    const away = (e) => {
      if (wrap.current?.contains(e.target)) return;
      if (e.target?.closest?.(".cs-menu, .cs-backdrop")) return;
      close(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);

  // החלונית נצמדת לצד הימני של המלבן ונמשכת שמאלה; אם אין מקום — לצד השמאלי.
  // ⚠️ בלי גובה מרבי ובלי גלילה: הרשימות של האריחים שבתוכה (FilterPicker) צפות מעליה — בחלונית גוללת הן נחתכו בתוכה.
  useLayoutEffect(() => {
    if (!open || !panel.current) return;
    if (getComputedStyle(panel.current).position !== "absolute") return;   // במסך צר — במקום
    const r = panel.current.getBoundingClientRect();
    if (r.left < 8) setAlignEnd(true);
  }, [open]);

  const toggle = () => { if (open) close(); else { setAlignEnd(false); setOpen(true); } };
  const onKey = (e) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); close(); } };

  return (
    <div className={`fg ${className}`.trim()} ref={wrap}>
      <button
        ref={btn}
        type="button"
        className={`filter-btn fg-btn${active ? " active" : ""}${open ? " is-open" : ""}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={toggle}
      >
        <span className="fg-title">{title}<span className="fg-chevron" aria-hidden="true">▾</span></span>
        <span className="fg-summary">{summary}</span>
      </button>
      <div
        id={id}
        ref={panel}
        className={`fg-panel${alignEnd ? " fg-panel--end" : ""}`}
        role="group"
        aria-label={title}
        hidden={!open}
        onKeyDown={onKey}
      >
        {children}
      </div>
    </div>
  );
}
