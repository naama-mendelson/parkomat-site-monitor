// components/Compliance/InspectionDialog.jsx — מעטפת חלון, תפריט ⋯ וחלון "סיבה" של לשונית הבודק.
//
// ============================================================
// ⚠️ Escape סוגר את החלון הזה בלבד — לא את חלון האתר שמתחתיו
// ============================================================
// InsightsModal מאזין ל-Escape על document (שלב ה-bubble). לכן המאזין כאן
// יושב על window **בשלב ה-capture** ועוצר את ההתפשטות — אחרת Escape אחד
// היה סוגר גם את טופס התסקיר וגם את חלון האתר, ומנהל שהקליד עשרה ליקויים
// היה מאבד הכול בלחיצה אחת.
//
// ⚠️ ושני חריגים: (א) תצוגת קובץ (ComplianceFileViewer, z-index 600) פתוחה
// מעל — היא מטפלת ב-Escape בעצמה, והחלון שמתחתיה לא נסגר איתה; (ב) יותר
// מחלון אחד פתוח — רק העליון נסגר.
import { useEffect, useRef, useState } from "react";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * @param {object} p
 * @param {string} p.title
 * @param {() => void} p.onClose — נקרא ב-×, ב-Escape ובלחיצה על הרקע. ⚠️ שמירה
 *   מפני אובדן (window.confirm) היא באחריות מי שמעביר אותו — הוא יודע מה ייאבד.
 * @param {"narrow"|"wide"} [p.size]
 * @param {React.ReactNode} [p.footer]
 */
export function InspectionDialog({ title, onClose, size = "narrow", footer, children, className = "" }) {
  const overlayRef = useRef(null);
  const boxRef = useRef(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (document.querySelector(".cfv-overlay")) return;            // התצוגה שמעל מטפלת בעצמה
      const all = document.querySelectorAll(".it-dlg-overlay");
      if (all[all.length - 1] !== overlayRef.current) return;         // רק העליון
      e.stopPropagation();
      e.preventDefault();
      closeRef.current?.();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // מיקוד פנימה בפתיחה, וחזרה למי שפתח בסגירה — בלי זה מקלדת ו-VoiceOver
  // נשארים "מאחורי" החלון.
  useEffect(() => {
    const opener = document.activeElement;
    const first = boxRef.current?.querySelector("[data-autofocus]") || boxRef.current?.querySelector(FOCUSABLE);
    try { first?.focus({ preventScroll: true }); } catch { /* */ }
    return () => {
      if (opener && typeof opener.focus === "function" && document.contains(opener)) {
        try { opener.focus({ preventScroll: true }); } catch { /* */ }
      }
    };
  }, []);

  // ⚠️ המיקוד נשאר בתוך החלון גם כשהתוכן מתחלף. כפתור שהפך disabled בשמירה,
  // או שלב שהוחלף (בחירת קובץ → טופס, "בוצע" → "סגירה"), מפיל את המיקוד ל-body —
  // ומשם Tab יוצא מהחלון, וקורא מסך נשאר מאחוריו. אחרי כל שינוי בתוכן: אם
  // המיקוד יצא, מחזירים אותו — ל-[data-autofocus] אם יש, אחרת לחלון עצמו.
  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof MutationObserver === "undefined") return undefined;
    const refocus = () => {
      const a = document.activeElement;
      if (a && a !== document.body && box.contains(a)) return;
      if (a && a !== document.body && !box.contains(a)) return;     // המשתמש עבר למקום אחר בכוונה (תצוגת קובץ)
      const all = document.querySelectorAll(".it-dlg-overlay");
      if (all[all.length - 1] !== overlayRef.current) return;
      const target = box.querySelector("[data-autofocus]:not([disabled])") || box;
      try { target.focus({ preventScroll: true }); } catch { /* */ }
    };
    const mo = new MutationObserver(() => setTimeout(refocus, 0));
    mo.observe(box, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled"] });
    return () => mo.disconnect();
  }, []);

  // ⚠️ סגירה ברקע רק כשגם הלחיצה **התחילה** ברקע: בחירת טקסט בתוך תיבה
  // ששוחררה מעל הרקע מייצרת click על הרקע — וחלון "סיבה" היה נסגר עם הסיבה.
  const downOnOverlay = useRef(false);

  const trapTab = (e) => {
    if (e.key !== "Tab" || !boxRef.current) return;
    const list = [...boxRef.current.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return (
    <div
      ref={overlayRef}
      className="it-dlg-overlay"
      // ⚠️ עצירה: לחיצה בתוך החלון לא תגיע לרקע של InsightsModal (שסוגר אותו)
      onPointerDown={(e) => { downOnOverlay.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget && downOnOverlay.current) closeRef.current?.();
        downOnOverlay.current = false;
      }}
      onKeyDown={trapTab}
    >
      <div ref={boxRef} className={`it-dlg it-dlg--${size} ${className}`} role="dialog" aria-modal="true" aria-label={title} dir="rtl"
        tabIndex={-1}>
        <div className="it-dlg-head">
          <h3 className="it-dlg-title">{title}</h3>
          <button type="button" className="it-dlg-close" onClick={() => closeRef.current?.()} aria-label="סגירה">×</button>
        </div>
        <div className="it-dlg-body">{children}</div>
        {footer && <div className="it-dlg-foot">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * תפריט ⋯ של מנהל. `items`: [{label, onSelect, danger?, disabled?, title?}].
 * ⚠️ התפריט עצמו אינו הגנה — השרת דוחה כל פעולת מנהל ממי שאינו מנהל.
 * כאן רק לא מציגים כפתור שהיה נכשל.
 */
export function InspectionMenu({ items, label = "פעולות" }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const visible = (items || []).filter(Boolean);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      // תפריט פתוח — Escape סוגר אותו בלבד, לא את החלון/הלשונית שמתחתיו
      e.stopPropagation();
      setOpen(false);
      btnRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  if (!visible.length) return null;
  return (
    <span className="it-menu" ref={wrapRef}>
      {/* ⚠️ כפתורים רגילים עם aria-expanded, לא role=menu: menu מבטיח ניווט בחצים
          שאין כאן, וקורא מסך היה מחכה לו. */}
      <button ref={btnRef} type="button" className="it-menu-btn" aria-expanded={open}
        aria-label={label} title={label} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
        ⋯
      </button>
      {open && (
        <span className="it-menu-list">
          {visible.map((it) => (
            <button key={it.label} type="button"
              className={`it-menu-item${it.danger ? " it-menu-item--danger" : ""}`}
              disabled={it.disabled} title={it.title}
              // ⚠️ המיקוד חוזר ל-⋯ **לפני** שהחלון נפתח — כך הוא נרשם כמי שפתח,
              // והמיקוד חוזר אליו בסגירה (ולא ל-body)
              onClick={(e) => { e.stopPropagation(); btnRef.current?.focus({ preventScroll: true }); setOpen(false); it.onSelect?.(); }}>
              {it.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

/**
 * חלון "סיבה" לפעולות מנהל (מחיקה, פתיחה מחדש, הוצאה משימוש, סגירה בתסקיר נקי).
 * `onSubmit(reason)` — זורק = מוצגת השגיאה והחלון נשאר פתוח; מצליח = ההורה סוגר.
 * ⚠️ הסיבה נשמרת ב-compliance_history (סגור, לצוות בלבד) — לא ב-audit_log (D22).
 */
export function InspectionReasonDialog({
  title, message, confirmLabel = "אישור", danger = false, optional = false,
  placeholder = "", onSubmit, onClose,
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const trimmed = reason.trim();
  const valid = optional ? trimmed.length === 0 || trimmed.length >= 2 : trimmed.length >= 2;

  const submit = async (e) => {
    e?.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit(trimmed || null);
    } catch (err) {
      setError(err?.message || "הפעולה נכשלה");
      setBusy(false);
    }
  };

  return (
    <InspectionDialog title={title} onClose={() => { if (!busy) onClose(); }}
      footer={(
        <>
          <button type="button" className="it-btn" onClick={onClose} disabled={busy}>ביטול</button>
          <button type="submit" form="it-reason-form" className={`it-btn ${danger ? "it-btn--danger-solid" : "it-btn--primary"}`}
            disabled={!valid || busy}>
            {busy ? "שומר…" : confirmLabel}
          </button>
        </>
      )}>
      <form id="it-reason-form" className="it-form" onSubmit={submit}>
        {message && <p className="it-dlg-msg">{message}</p>}
        <label className="it-field">
          <span className="it-label">{optional ? "סיבה (לא חובה)" : "סיבה"}</span>
          <textarea data-autofocus className="it-input it-textarea" rows={3} maxLength={500} value={reason}
            placeholder={placeholder} onChange={(e) => setReason(e.target.value)} />
        </label>
        {!optional && trimmed.length > 0 && trimmed.length < 2 && <p className="it-hint">לפחות 2 תווים</p>}
        {error && <p className="it-error" role="alert">{error}</p>}
      </form>
    </InspectionDialog>
  );
}
