// components/Panel/Panel.jsx — חלונית ברשת ה-bento.
// גודל משתנה (span). לחיצה *על החלונית* פורשת אותה על כל המסך,
// ולחיצה מחוצה לה (או Escape) מכווצת אותה חזרה — בלי כפתור סגירה.
import { useEffect } from "react";
import "./Panel.css";

const ExpandIcon = () => (
  <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"
    fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="12,3 17,3 17,8" />
    <polyline points="8,17 3,17 3,12" />
    <line x1="17" y1="3" x2="11" y2="9" />
    <line x1="3" y1="17" x2="9" y2="11" />
  </svg>
);

// לחיצה על פקד אמיתי בתוך החלונית (כפתור, קלט, קישור) היא *הפעולה שלו*
// ולא בקשה להרחיב. בלי הבדיקה הזו, מתג "רגיל/מוערם" היה גם פורש את החלונית.
const isControl = (el) =>
  el instanceof Element && el.closest("button, a, input, select, textarea, label");

/**
 * id / title / subtitle
 * span    — כמה עמודות מתוך 12 (קובע את גודל החלונית)
 * tall    — חלונית גבוהה (2 שורות)
 * accent  — צבע הפס העליון
 * actions — פקדים בכותרת (למשל מתג רגיל/מוערם)
 * expanded / onExpand / onClose
 */
function Panel({
  id, title, subtitle, span = 4, tall = false, accent, index = 0,
  actions, expanded, onExpand, onClose, children,
}) {
  // סגירה ב-Escape כשהחלונית פרושה
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);

    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [expanded, onClose]);

  const head = (
    <header className="pn-head">
      <div className="pn-title">
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>

      <div className="pn-actions">
        {actions}
        {expanded ? (
          <span className="pn-hint">לחצו מחוץ לחלונית כדי לסגור</span>
        ) : (
          // סמן ההרחבה נשאר: הוא מרמז שאפשר ללחוץ, והוא גם הכפתור הנגיש
          // למקלדת — הרשת עצמה לוכדת רק את לחיצת העכבר.
          <button className="pn-btn" onClick={() => onExpand(id)}
            aria-label={`הרחב: ${title}`} title="הרחב למסך מלא">
            <ExpandIcon />
          </button>
        )}
      </div>
    </header>
  );

  // ===== פרושה על כל המסך =====
  if (expanded) {
    return (
      <div className="pn-overlay" onClick={onClose}>
        <section
          className="pn pn--full"
          style={{ "--pn-accent": accent }}
          onClick={(e) => e.stopPropagation()}
        >
          {head}
          <div className="pn-body">{children}</div>
        </section>
      </div>
    );
  }

  // ===== ברשת: כל החלונית היא אזור לחיצה =====
  return (
    <section
      className={`pn pn--grid is-clickable ${tall ? "is-tall" : ""}`}
      style={{ "--pn-accent": accent, "--pn-span": span, animationDelay: `${index * 65}ms` }}
      onClick={(e) => { if (!isControl(e.target)) onExpand(id); }}
    >
      {head}
      <div className="pn-body">{children}</div>
    </section>
  );
}

export default Panel;
