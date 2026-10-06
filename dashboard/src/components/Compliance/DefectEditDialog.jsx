// components/Compliance/DefectEditDialog.jsx — הוספה או עריכה של ליקוי (מנהל).
//
// ⚠️ clientId נוצר **פעם אחת לטופס**: הוספה שהתשובה שלה אבדה ונשלחה שוב
// מחזירה את אותו ליקוי (D23) — ולא ליקוי כפול שרק מנהל יכול להסיר, ורק עם סיבה.
//
// ⚠️ תאריך היעד נשלח **רק אם נערך**. בהוספה, null = השרת מחשב (דחוף = יום
// הבדיקה, אחרת +45); בעריכה, null = ללא שינוי. ערך שמוצג בשדה ונשלח "כי הוא
// שם" היה מקבע תאריך שהמנהל מעולם לא בחר.
import { useEffect, useRef, useState } from "react";
import { saveDefect } from "../../services/dataSource";
import { newId } from "../../utils/complianceFiles";
import { addDaysISO, formatDateIL } from "../../utils/compliance";
import { dropCleaned, pasteCleaned } from "../../utils/pdfItems";
import { InspectionDialog } from "./InspectionDialog";
import { KIND_LABEL } from "./InspectionUtils";

/**
 * @param {object} p
 * @param {object|null} p.defect — null = הוספה
 * @param {object} p.report — הדוח שאליו הליקוי שייך (להוספה: היעד; לעריכה: הדוח של הליקוי)
 * @param {() => void} p.onSaved
 * @param {() => void} p.onClose
 * @param {(reason: string|null) => void} [p.onDirtyChange]
 */
export default function DefectEditDialog({ defect, report, onSaved, onClose, onDirtyChange }) {
  const adding = !defect;
  const [clientId] = useState(newId);
  const [body, setBody] = useState(defect?.body ?? "");
  const [urgent, setUrgent] = useState(!!defect?.urgent);
  const [due, setDue] = useState(defect?.due_on ?? "");
  const [dueEdited, setDueEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirtyRef = useRef(onDirtyChange);
  useEffect(() => { dirtyRef.current = onDirtyChange; }, [onDirtyChange]);

  // ברירת המחדל של השרת להוספה — מוצגת כדי שהמנהל יראה מה ייקבע
  const defaultDue = report?.inspected_on ? (urgent ? report.inspected_on : addDaysISO(report.inspected_on, 45)) : "";
  const shownDue = adding && !dueEdited ? defaultDue : due;

  const changed = adding
    ? body.trim().length > 0
    : body.trim() !== (defect.body ?? "") || urgent !== !!defect.urgent || (dueEdited && due !== (defect.due_on ?? ""));
  const dirty = busy ? "הליקוי נשמר כרגע" : changed ? "הליקוי לא נשמר — סגירה תמחק את מה שהוזן" : null;
  useEffect(() => { dirtyRef.current?.(dirty); }, [dirty]);
  useEffect(() => () => dirtyRef.current?.(null), []);

  const requestClose = () => {
    if (busy) return;
    if (changed && !window.confirm("הליקוי לא נשמר — לסגור בלי לשמור?")) return;
    onClose();
  };

  const trimmed = body.trim();
  const valid = trimmed.length >= 2 && trimmed.length <= 2000 && (!dueEdited || /^\d{4}-\d{2}-\d{2}$/.test(due));

  // ⚠️ הוספה שהתשובה שלה אבדה עשויה להיות שמורה כבר. ניסיון חוזר עם אותו
  // clientId מחזיר את הליקוי הקיים **בלי** להחיל את הטקסט החדש (replay ב-SQL),
  // ולכן מנהל שתיקן "קומה 2" ל"קומה 3" לפני "נסה שוב" ראה "נוסף" ונשאר עם
  // "קומה 2" — ברשומה החוקית. שולחים שוב בדיוק את מה שנשלח, ואם בינתיים
  // נערך משהו — עריכה של הליקוי שחזר.
  const firstSent = useRef(null);
  const submit = async (e) => {
    e?.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    const now = { body: trimmed, urgent, dueOn: dueEdited ? due : null };
    try {
      if (adding) {
        firstSent.current ??= now;
        const sent = firstSent.current;
        const id = await saveDefect({ reportId: report.id, defectId: null, ...sent, clientId });
        if (sent.body !== now.body || sent.urgent !== now.urgent || sent.dueOn !== now.dueOn) {
          await saveDefect({ reportId: report.id, defectId: id, ...now });
        }
      } else {
        await saveDefect({ reportId: report.id, defectId: defect.id, ...now, clientId: null });
      }
      setBusy(false);
      onSaved();
    } catch (err) {
      setError(err?.message || "השמירה נכשלה");
      setBusy(false);
    }
  };

  return (
    <InspectionDialog
      title={adding ? "הוספת ליקוי" : "עריכת ליקוי"}
      onClose={requestClose}
      footer={(
        <>
          <button type="button" className="it-btn" onClick={requestClose} disabled={busy}>ביטול</button>
          <button type="submit" form="it-defect-form" className="it-btn it-btn--primary" disabled={!valid || busy}>
            {busy ? "שומר…" : error ? "נסה שוב" : "שמירה"}
          </button>
        </>
      )}
    >
      <form id="it-defect-form" className="it-form" onSubmit={submit}>
        {report && (
          <p className="it-muted">{KIND_LABEL[report.kind] ?? "תסקיר"} מ-{formatDateIL(report.inspected_on)}</p>
        )}
        <label className="it-field">
          <span className="it-label">תיאור הליקוי</span>
          <textarea data-autofocus className="it-input it-textarea" rows={3} maxLength={2000} value={body}
            onChange={(e) => setBody(e.target.value)} onPaste={(e) => pasteCleaned(e, setBody)}
            onDrop={(e) => dropCleaned(e, setBody)} />
        </label>
        <label className="it-check">
          <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />
          <span>דחוף</span>
        </label>
        <label className="it-field">
          <span className="it-label">לתיקון עד</span>
          <input className="it-input it-input--date" type="date" value={shownDue || ""}
            onChange={(e) => { setDue(e.target.value); setDueEdited(true); }} />
          {adding && !dueEdited && defaultDue && (
            <span className="it-hint">
              ברירת מחדל: {formatDateIL(defaultDue)} ({urgent ? "דחוף — יום הבדיקה" : "45 יום מתאריך הבדיקה"})
            </span>
          )}
        </label>
        {error && <p className="it-error" role="alert">{error}</p>}
      </form>
    </InspectionDialog>
  );
}
