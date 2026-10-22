// components/SiteInactive/InactiveDialog.jsx — "לא פעיל" (22/10/2026): לסמן אתר כלא פעיל, לעדכן את הסיבה, או להחזיר לפעיל.
//
// בקשה מהשטח שהבעלת העבירה: אתרים שלא פעילים ומופיעים כ"תקלה" או "תחזוקה" — לסוף הרשימה, תחת הכותרת "לא פעיל".
// בחירות הבעלת: רק המיקום בלוח; עורך או מנהל, מהכרטיס. המסד בודק את ההרשאה (public.site_inactive_set).
// ⚠️ .tk-overlay — אותו חלון כמו המשימות: SiteGrid לא מקפל את הכרטיס בלחיצה בתוכו, ו-Esc סוגר רק את העליון.
import { useEffect, useRef, useState } from "react";
import { setSiteInactive } from "../../services/dataSource";
import { inactiveLine, isInactive } from "../../utils/siteInactive";
import "../Tasks/Tasks.css";
import "./SiteInactive.css";

const MAX = 200;

export default function InactiveDialog({ site, onClose, onChanged }) {
  const inactive = isInactive(site);
  const [reason, setReason] = useState(site.inactive_reason ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const overlayRef = useRef(null);
  const pressed = useRef(false);
  const inputRef = useRef(null);
  const name = site.site_name || site.code;

  useEffect(() => {
    if (window.matchMedia?.("(pointer: fine)").matches) inputRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      const all = document.querySelectorAll(".tk-overlay");
      if (all[all.length - 1] !== overlayRef.current) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const save = async (makeInactive) => {
    setBusy(true);
    setError(null);
    try {
      await setSiteInactive(site.code, makeInactive, makeInactive ? reason : null);
      onChanged?.();
      onClose();
    } catch (e) {
      setError(e?.message || "הפעולה נכשלה");
      setBusy(false);
    }
  };
  const reasonChanged = (reason.trim() || null) !== (site.inactive_reason ?? null);

  return (
    <div className="tk-overlay" ref={overlayRef}
      onPointerDown={(e) => { pressed.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && pressed.current) onClose(); }}>
      <div className="tk-dialog ia-dialog" role="dialog" aria-modal="true" aria-label={`לא פעיל — ${name}`} dir="rtl">
        <header className="tk-head">
          <div className="tk-head-text">
            <h2 className="tk-title">{inactive ? "האתר מסומן לא פעיל" : "סימון כלא פעיל"}</h2>
            <span className="tk-site">{name} · {site.code}</span>
          </div>
          <button type="button" className="tk-close" onClick={onClose} aria-label="סגירה">✕</button>
        </header>
        {inactive
          ? <p className="ia-now">{inactiveLine(site)}</p>
          : <p className="ia-hint">האתר יעבור לסוף הרשימה, תחת הכותרת "לא פעיל". שום דבר אחר לא משתנה — המצב, הצלצול
              והסטטיסטיקה ממשיכים כרגיל.</p>}
        <label className="ia-field">
          <span>סיבה (רשות)</span>
          <input ref={inputRef} className="ia-input" type="text" value={reason} maxLength={MAX} disabled={busy}
            placeholder="למשל: בשיפוץ, מושבת עד הודעה חדשה"
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !busy && (!inactive || reasonChanged)) { e.preventDefault(); save(true); } }} />
        </label>
        {error && <p className="ia-err" role="alert">{error}</p>}
        <div className="ia-btns">
          {inactive ? (
            <>
              <button type="button" className="ia-main" onClick={() => save(false)} disabled={busy}>
                {busy ? "שומר…" : "החזרה לפעיל"}
              </button>
              <button type="button" onClick={() => save(true)} disabled={busy || !reasonChanged}>שמירת הסיבה</button>
            </>
          ) : (
            <button type="button" className="ia-main" onClick={() => save(true)} disabled={busy}>
              {busy ? "שומר…" : "סימון כלא פעיל"}
            </button>
          )}
          <button type="button" onClick={onClose} disabled={busy}>ביטול</button>
        </div>
      </div>
    </div>
  );
}
