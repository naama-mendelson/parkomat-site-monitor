// components/Compliance/DefectRows.jsx — שורת ליקוי פתוח, שורת ליקוי שבוצע, ותמונות ממוזערות.
//
// ⚠️ התמונות הממוזערות נטענות **בעצלות**: רק כשהשורה מתקרבת למסך. אתר
// עם עשרות ליקויים שבוצעו היה מושך כל פתיחת לשונית עשרות תמונות (עד 40KB
// כל אחת) — ממכסת תעבורה שכבר חרגה (CLAUDE.md, "The gates run against
// production"). ושורה שבוצעה בתסקיר חוזר נקי (בלי תמונה) לא שואלת בכלל.
import { useEffect, useRef, useState } from "react";
import { fetchComplianceThumbs } from "../../services/dataSource";
import { formatDateIL, formatDayMonth } from "../../utils/compliance";
import { daysBetween, ilDateOf, KIND_LABEL } from "./InspectionUtils";
import { InspectionMenu } from "./InspectionDialog";

/** תמונות ממוזערות של ליקוי. `kind`: 'defect' (הסגירה הנוכחית) / 'defect_history'. */
export function DefectThumbs({ kind, ownerId, expected = 1, onOpen, eager = false }) {
  const ref = useRef(null);
  const [state, setState] = useState({ status: "idle", items: [], error: "" });
  const [attempt, setAttempt] = useState(0);
  const [visible, setVisible] = useState(eager);

  useEffect(() => {
    if (visible) return undefined;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") { setVisible(true); return undefined; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); setVisible(true); }
    }, { rootMargin: "200px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return undefined;
    let alive = true;
    setState((s) => ({ ...s, status: "loading", error: "" }));
    fetchComplianceThumbs(kind, ownerId)
      .then((items) => { if (alive) setState({ status: "done", items, error: "" }); })
      .catch((err) => { if (alive) setState({ status: "error", items: [], error: err?.message || "התמונות לא נטענו" }); });
    return () => { alive = false; };
  }, [visible, kind, ownerId, attempt]);

  const placeholders = Math.max(1, Math.min(expected, kind === "defect" ? 3 : 9));
  return (
    <div ref={ref} className="it-thumbs" aria-busy={state.status === "loading"}>
      {state.status === "error" ? (
        <span className="it-error">
          {state.error}{" "}
          <button type="button" className="it-link" onClick={() => setAttempt((n) => n + 1)}>נסה שוב</button>
        </span>
      ) : state.status !== "done" ? (
        Array.from({ length: placeholders }, (_, i) => <span key={i} className="it-thumb it-thumb--ph" aria-hidden="true" />)
      ) : state.items.length === 0 ? (
        <span className="it-muted">אין תמונות</span>
      ) : (
        state.items.map((p, i) => (
          <button key={p.id} type="button" className="it-thumb" onClick={() => onOpen?.(p)}
            aria-label={`הצגת תמונה ${i + 1}`} title="הצגת התמונה">
            {p.thumb
              ? <img src={`data:image/jpeg;base64,${p.thumb}`} alt="" loading="lazy" />
              : <span className="it-thumb-txt">תמונה</span>}
          </button>
        ))
      )}
    </div>
  );
}

/**
 * ליקוי פתוח. `showSource` — כשיש במחזור יותר מדוח אחד, לציין מאיזה.
 * ⚠️ "באיחור" מחושב מ-due_on מול היום בישראל — אותו כלל כמו overdue_n ב-SQL
 * (due_on < today), ולכן הספירה בכרטיס והאדום כאן מסכימים.
 */
export function DefectRow({ defect, today, isManager, showSource, onMarkDone, onEdit, onDelete }) {
  const d = defect;
  const overdue = !!d.due_on && d.due_on < today;
  const late = overdue ? daysBetween(d.due_on, today) : 0;
  const photosAny = (d.current_photos || 0) + (d.past_photos || 0);
  return (
    <li className={`it-defect${overdue ? " it-defect--overdue" : ""}`}>
      <div className="it-defect-main">
        <p className="it-defect-body">{d.body}</p>
        <p className="it-defect-meta">
          {d.urgent && <span className="it-tag it-tag--urgent">דחוף</span>}
          {d.due_on && (
            <span className={overdue ? "it-due it-due--late" : "it-due"}>
              לתיקון עד {formatDateIL(d.due_on)}{overdue ? ` · באיחור ${late === 1 ? "יום" : `${late} ימים`}` : ""}
            </span>
          )}
          {d.current_photos > 0 && (
            <span className="it-muted">צולמו {d.current_photos === 1 ? "תמונה" : `${d.current_photos} תמונות`} — טרם סומן</span>
          )}
          {showSource && <span className="it-muted">{KIND_LABEL[d.reportKind] ?? ""} {formatDateIL(d.reportDate)}</span>}
        </p>
      </div>
      <div className="it-defect-actions">
        <button type="button" className="it-btn it-btn--primary" onClick={() => onMarkDone(d)}>סימון כבוצע</button>
        {isManager && (
          <InspectionMenu label="פעולות על הליקוי" items={[
            { label: "עריכה", onSelect: () => onEdit(d) },
            {
              label: "מחיקה", danger: true, onSelect: () => onDelete(d), disabled: photosAny > 0,
              // אותו כלל כמו השרת (inspection_defect_delete) — ליקוי עם תמונות הוא ראיה
              title: photosAny > 0 ? "לליקוי יש תמונות — אי אפשר למחוק אותו" : undefined,
            },
          ]} />
        )}
      </div>
    </li>
  );
}

/** ליקוי שבוצע: מתי ומי, או "נסגר בתסקיר חוזר נקי". */
export function DefectDoneRow({ defect, closingReport, isManager, onReopen, onOpenPhoto }) {
  const d = defect;
  const [showPast, setShowPast] = useState(false);
  const doneDay = ilDateOf(d.done_at);
  return (
    <li className="it-done">
      <p className="it-defect-body">
        <span className="it-done-check" aria-hidden="true">✓</span> {d.body}
      </p>
      <p className="it-done-meta">
        {d.closed_by_report_id
          ? `נסגר בתסקיר חוזר נקי מ-${closingReport ? formatDayMonth(closingReport.inspected_on) : "?"}${d.done_by_name ? ` · סומן ע״י ${d.done_by_name}` : ""}`
          : `בוצע ב-${doneDay ? formatDateIL(doneDay) : "?"} ע״י ${d.done_by_name || "?"}`}
      </p>
      {d.done_note && <p className="it-done-note">{d.done_note}</p>}
      {d.current_photos > 0 && (
        <DefectThumbs kind="defect" ownerId={d.id} expected={d.current_photos} onOpen={onOpenPhoto} />
      )}
      {(d.past_photos > 0 || isManager) && (
        <div className="it-done-actions">
          {d.past_photos > 0 && (
            <button type="button" className="it-link" onClick={() => setShowPast((v) => !v)} aria-expanded={showPast}>
              תמונות מסגירות קודמות ({d.past_photos})
            </button>
          )}
          {isManager && onReopen && (
            <button type="button" className="it-btn it-btn--small" onClick={() => onReopen(d)}>פתיחה מחדש</button>
          )}
        </div>
      )}
      {showPast && <DefectThumbs kind="defect_history" ownerId={d.id} expected={d.past_photos} onOpen={onOpenPhoto} eager />}
    </li>
  );
}
