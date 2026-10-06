// components/Compliance/InspectionReportEdit.jsx — עריכת פרטי תסקיר (מנהל).
//
// ============================================================
// ⚠️ נשלחים **רק** השדות ששונו
// ============================================================
// בשרת, שדה שנשלח נחשב לשינוי: תאריך תוקף שנשלח נרשם 'manual' גם אם הוא
// זהה לזה שהיה (inspection_report_update). טופס ששולח את כל השדות היה מוחק
// בשקט את התגית "מהמסמך" מכל תסקיר שמישהו פתח לעריכה רק כדי לתקן הערה.
//
// ⚠️ "נקי" (declared_clean) הוא עובדה על המסמך (D7), והוא סוגר מחזור — לכן
// סימון מחייב סיבה, וביטול סימון של בדיקה חוזרת **פותח מחדש** את הליקויים
// שנסגרו בה (D24). שני אלה נאמרים כאן במפורש לפני השמירה.
import { useEffect, useRef, useState } from "react";
import { updateInspectionReport } from "../../services/dataSource";
import { addMonthsISO, formatDateIL, todayIL } from "../../utils/compliance";
import { InspectionDialog } from "./InspectionDialog";
import { KIND_LABEL, daysBetween } from "./InspectionUtils";

const TEXT_FIELDS = ["report_number", "inspector_name", "inspector_license", "machine_no", "note"];
const norm = (v) => (v == null ? "" : String(v).trim());

/**
 * @param {object} p
 * @param {object} p.report
 * @param {object|null} p.parent — התקופתי של בדיקה חוזרת (לתוקף "כמו התקופתי")
 * @param {() => void} p.onSaved
 * @param {() => void} p.onClose
 * @param {(reason: string|null) => void} [p.onDirtyChange]
 */
export default function InspectionReportEdit({ report, parent, onSaved, onClose, onDirtyChange }) {
  const r = report;
  const periodic = r.kind === "periodic";
  const [form, setForm] = useState(() => ({
    inspected_on: r.inspected_on ?? "",
    valid_until: r.valid_until ?? "",
    machine_key: r.machine_key ?? "",
    declared_clean: !!r.declared_clean,
    ...Object.fromEntries(TEXT_FIELDS.map((f) => [f, r[f] ?? ""])),
  }));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirtyRef = useRef(onDirtyChange);
  useEffect(() => { dirtyRef.current = onDirtyChange; }, [onDirtyChange]);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const liveDefects = (r.defects || []).length;
  const today = todayIL();

  // ההפרש בין הטופס לדוח — זה ורק זה נשלח
  const changes = {};
  for (const f of TEXT_FIELDS) if (norm(form[f]) !== norm(r[f])) changes[f] = norm(form[f]) || null;
  if (form.inspected_on !== (r.inspected_on ?? "")) changes.inspected_on = form.inspected_on || null;
  if (form.valid_until !== (r.valid_until ?? "")) changes.valid_until = form.valid_until || null;
  if (periodic && norm(form.machine_key) !== norm(r.machine_key)) changes.machine_key = norm(form.machine_key);
  if (form.declared_clean !== !!r.declared_clean) changes.declared_clean = form.declared_clean;
  const fields = Object.keys(changes);

  const declaring = changes.declared_clean === true;
  const undeclaring = changes.declared_clean === false;

  const problems = [];
  if (!form.inspected_on) problems.push("תאריך בדיקה");
  else if (form.inspected_on > today) problems.push("תאריך הבדיקה בעתיד");
  if (periodic && !form.valid_until) problems.push("תאריך תוקף (חובה בתסקיר תקופתי)");
  if (form.valid_until && form.inspected_on) {
    const n = daysBetween(form.inspected_on, form.valid_until);
    if (n <= 0 || n > 800) problems.push("התוקף חייב להיות אחרי תאריך הבדיקה ועד כשנתיים ממנו");
  }
  if (periodic && !norm(form.machine_key)) problems.push("מתקן");
  if (declaring && reason.trim().length < 2) problems.push("סיבה לסימון התסקיר כנקי");

  const dirty = busy ? "פרטי התסקיר נשמרים כרגע" : fields.length ? "פרטי התסקיר נערכו ולא נשמרו" : null;
  useEffect(() => { dirtyRef.current?.(dirty); }, [dirty]);
  useEffect(() => () => dirtyRef.current?.(null), []);

  const requestClose = () => {
    if (busy) return;
    if (fields.length && !window.confirm("השינויים לא נשמרו — לסגור בלי לשמור?")) return;
    onClose();
  };

  const submit = async (e) => {
    e?.preventDefault();
    if (busy || !fields.length || problems.length) return;
    setBusy(true);
    setError("");
    try {
      await updateInspectionReport(r.id, changes, reason.trim() || null);
      setBusy(false);
      onSaved();
    } catch (err) {
      setError(err?.message || "השמירה נכשלה");
      setBusy(false);
    }
  };

  return (
    <InspectionDialog
      title={`עריכת ${KIND_LABEL[r.kind] ?? "תסקיר"} מ-${formatDateIL(r.inspected_on)}`}
      onClose={requestClose}
      footer={(
        <>
          <button type="button" className="it-btn" onClick={requestClose} disabled={busy}>ביטול</button>
          <button type="submit" form="it-report-form" className="it-btn it-btn--primary"
            disabled={busy || !fields.length || problems.length > 0}>
            {busy ? "שומר…" : "שמירה"}
          </button>
        </>
      )}
    >
      <form id="it-report-form" className="it-form" onSubmit={submit}>
        <div className="it-grid2">
          <label className="it-field">
            <span className="it-label">תאריך בדיקה</span>
            <input data-autofocus className="it-input it-input--date" type="date" max={today} value={form.inspected_on}
              onChange={(e) => set("inspected_on", e.target.value)} />
          </label>
          <div className="it-field">
            <label className="it-label" htmlFor="it-edit-valid">בתוקף עד</label>
            <input id="it-edit-valid" className="it-input it-input--date" type="date" value={form.valid_until}
              onChange={(e) => set("valid_until", e.target.value)} />
            <span className="it-inline-btns">
              <button type="button" className="it-btn it-btn--small" disabled={!form.inspected_on}
                onClick={() => set("valid_until", addMonthsISO(form.inspected_on, 12))}>+12 חודשים</button>
              <button type="button" className="it-btn it-btn--small" disabled={!form.inspected_on}
                onClick={() => set("valid_until", addMonthsISO(form.inspected_on, 6))}>+6 חודשים</button>
              {!periodic && form.valid_until && (
                <button type="button" className="it-btn it-btn--small" onClick={() => set("valid_until", "")}>כמו התקופתי</button>
              )}
            </span>
            {!periodic && !form.valid_until && (
              <span className="it-hint">ריק = כמו התסקיר התקופתי{parent?.valid_until ? ` (${formatDateIL(parent.valid_until)})` : ""}</span>
            )}
            {changes.valid_until && <span className="it-hint">תאריך שנערך יסומן "הוזן ידנית"</span>}
          </div>
        </div>

        <div className="it-grid2">
          <label className="it-field">
            <span className="it-label">מס' תסקיר</span>
            <input className="it-input" value={form.report_number} maxLength={60} onChange={(e) => set("report_number", e.target.value)} />
          </label>
          <label className="it-field">
            <span className="it-label">מס' מתקן במסמך</span>
            <input className="it-input" value={form.machine_no} maxLength={60} onChange={(e) => set("machine_no", e.target.value)} />
          </label>
          <label className="it-field">
            <span className="it-label">שם הבודק</span>
            <input className="it-input" value={form.inspector_name} maxLength={100} onChange={(e) => set("inspector_name", e.target.value)} />
          </label>
          <label className="it-field">
            <span className="it-label">רישיון בודק</span>
            <input className="it-input" value={form.inspector_license} maxLength={60} onChange={(e) => set("inspector_license", e.target.value)} />
          </label>
          {periodic && (
            <label className="it-field">
              <span className="it-label">מתקן (מפתח)</span>
              <input className="it-input" value={form.machine_key} maxLength={40} onChange={(e) => set("machine_key", e.target.value)} />
              {changes.machine_key && <span className="it-hint">הבדיקות החוזרות של התסקיר יעברו איתו למתקן {changes.machine_key}</span>}
            </label>
          )}
        </div>

        <label className="it-field">
          <span className="it-label">הערה</span>
          <textarea className="it-input it-textarea" rows={2} maxLength={2000} value={form.note} onChange={(e) => set("note", e.target.value)} />
        </label>

        {(liveDefects === 0 || r.declared_clean) && (
          <label className="it-check">
            <input type="checkbox" checked={form.declared_clean} onChange={(e) => set("declared_clean", e.target.checked)}
              disabled={liveDefects > 0 && !r.declared_clean} />
            <span>התסקיר נקי — הבודק לא מצא ליקויים</span>
          </label>
        )}
        {liveDefects > 0 && !r.declared_clean && (
          <p className="it-hint">יש בתסקיר {liveDefects} ליקויים — אי אפשר לסמן אותו כנקי.</p>
        )}
        {undeclaring && r.kind === "followup" && (
          <p className="it-banner it-banner--warn">ביטול הסימון יפתח מחדש את הליקויים שנסגרו על סמך התסקיר הזה.</p>
        )}

        <label className="it-field">
          <span className="it-label">{declaring ? "סיבה (חובה בסימון כנקי)" : "סיבה (לא חובה)"}</span>
          <textarea className="it-input it-textarea" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>

        {fields.length > 0 && problems.length > 0 && <p className="it-hint">כדי לשמור: {problems.join(" · ")}</p>}
        {error && <p className="it-error" role="alert">{error}</p>}
      </form>
    </InspectionDialog>
  );
}
