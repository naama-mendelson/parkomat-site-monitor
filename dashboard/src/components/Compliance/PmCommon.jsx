// components/Compliance/PmCommon.jsx — חלקים קטנים שחוזרים בלשונית התחזוקה המונעת.
import { useEffect, useId, useRef, useState } from "react";
import { GLYPH } from "../../utils/compliance";
import { WrenchIcon } from "./icons";
import { REASON_MAX } from "./PmUtils";

/**
 * מנורת התחזוקה המונעת בראש הלשונית — אותו אייקון ואותו גליף כמו בכרטיס,
 * כדי שמי שלחץ על המנורה בכרטיס יזהה אותה כאן. ⚠️ הצבע אינו הסימן היחיד:
 * הגליף (✓ ! ✕ ○ ?) נושא את המצב גם בשחור-לבן.
 */
export function PmLamp({ state = "unknown" }) {
  return (
    <span className={`pm-lamp pm-lamp--${state}`} aria-hidden="true">
      <WrenchIcon size={15} />
      <span className="pm-lamp-glyph">{GLYPH[state] ?? "?"}</span>
    </span>
  );
}

export function CameraIcon({ size = 18 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8h3l1.6-2.2A1.5 1.5 0 0 1 9.8 5h4.4a1.5 1.5 0 0 1 1.2.8L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
      <circle cx="12" cy="13" r="3.6" />
    </svg>
  );
}

/**
 * אישור פעולה הרסנית עם שדה סיבה — בתוך הדף, ולא window.prompt.
 * ⚠️ prompt בטלפון הוא תיבה זעירה בלי מקלדת עברית מובטחת, ובמצב PWA חלק
 * מהדפדפנים חוסמים אותו בשקט — כלומר "מחיקה" שלא עושה כלום.
 *
 * @param {object} p
 * @param {string} p.text — מה עומד לקרות
 * @param {string} p.confirmLabel
 * @param {boolean} p.required — סיבה חובה (2–500 תווים, כמו app.compliance_reason)
 * @param {(reason:string|null) => Promise} p.onConfirm — זורקת = מוצג כשגיאה
 * @param {() => void} p.onCancel
 *
 * ⚠️ הטופס מחליף את הכפתור שפתח אותו — כלומר הפוקוס נופל ל-body, וקורא מסך
 * קופץ לראש החלון בלי להקריא את האזהרה. לכן הוא לוקח את הפוקוס בעצמו (הקבוצה
 * מסומנת בטקסט האזהרה, וזה מה שמוקרא). החזרת הפוקוס לפותח ב"חזרה" — אצל ההורה.
 */
export function ReasonForm({ text, confirmLabel, required = false, onConfirm, onCancel, placeholder }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const boxRef = useRef(null);
  const textId = useId();
  useEffect(() => { boxRef.current?.focus({ preventScroll: true }); }, []);
  const trimmed = reason.trim();
  // ⚠️ תו אחד נדחה בשרת גם כשהסיבה רשות ("חובה לציין סיבה" — 2 תווים לפחות).
  const tooShort = trimmed.length === 1 || (required && trimmed.length < 2);

  const go = async () => {
    setBusy(true);
    setError("");
    try {
      await onConfirm(trimmed || null);
    } catch (err) {
      setError(err?.message || "הפעולה נכשלה");
      setBusy(false);
    }
  };

  return (
    <div className="pm-confirm" role="group" aria-labelledby={textId} tabIndex={-1} ref={boxRef}>
      <p className="pm-confirm-text" id={textId}>{text}</p>
      <label className="pm-field">
        <span>סיבה {required ? "" : <em>(רשות)</em>}</span>
        <input className="pm-input" type="text" value={reason} maxLength={REASON_MAX}
          placeholder={placeholder} onChange={(e) => setReason(e.target.value)} disabled={busy} />
      </label>
      {tooShort && trimmed.length > 0 && <span className="pm-field-err">סיבה — שני תווים לפחות</span>}
      {error && <div className="pm-banner pm-banner--error" role="alert">{error}</div>}
      <div className="pm-row">
        <button type="button" className="pm-btn pm-btn--danger" onClick={go}
          disabled={busy || tooShort || (required && !trimmed)}>
          {busy ? "רגע…" : confirmLabel}
        </button>
        <button type="button" className="pm-btn" onClick={onCancel} disabled={busy}>חזרה</button>
      </div>
    </div>
  );
}
