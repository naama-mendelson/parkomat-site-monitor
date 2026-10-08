// components/Compliance/DefectRows.jsx — שורת ליקוי פתוח, שורת ליקוי שבוצע, ותמונות ממוזערות.
//
// ⚠️ התמונות הממוזערות נטענות **בעצלות**: רק כשהשורה מתקרבת למסך. אתר
// עם עשרות ליקויים שבוצעו היה מושך כל פתיחת לשונית עשרות תמונות (עד 40KB
// כל אחת) — ממכסת תעבורה שכבר חרגה (CLAUDE.md, "The gates run against
// production"). ושורה שבוצעה בתסקיר חוזר נקי (בלי תמונה) לא שואלת בכלל.
import { useEffect, useRef, useState } from "react";
import { fetchComplianceFile, fetchComplianceThumbs } from "../../services/dataSource";
import { formatDateIL, formatDayMonth } from "../../utils/compliance";
import { fixesForPdf } from "../../utils/defectPdf";
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
 * ⚠️ מצב המועד מגיע מה-SQL (`due_state`: overdue / soon) — אותם כללים כמו overdue_n ו-due_soon_n,
 * ולכן הצבע כאן והנורה מסכימים, בלי עותק של הסף (30 יום) בדפדפן. SQL ישן שאינו שולח אותו —
 * "עבר המועד" לפי due_on < היום, כמו קודם, ובלי "בתוך החודש".
 */
export function DefectRow({ defect, today, isManager, showSource, onMarkDone, onEdit, onDelete }) {
  const d = defect;
  const due = d.due_state !== undefined ? d.due_state : (d.due_on && d.due_on < today ? "overdue" : null);
  const overdue = due === "overdue";
  const soon = due === "soon";
  const late = overdue ? daysBetween(d.due_on, today) : 0;
  const left = soon ? daysBetween(today, d.due_on) : 0;
  const photosAny = (d.current_photos || 0) + (d.past_photos || 0);
  return (
    <li className={`it-defect${overdue ? " it-defect--overdue" : soon ? " it-defect--soon" : ""}`}>
      <div className="it-defect-main">
        <p className="it-defect-body">{d.body}</p>
        <p className="it-defect-meta">
          {d.urgent && <span className="it-tag it-tag--urgent">דחוף</span>}
          {d.due_on && (
            <span className={overdue ? "it-due it-due--late" : soon ? "it-due it-due--soon" : "it-due"}>
              לתיקון עד {formatDateIL(d.due_on)}
              {overdue ? ` · עבר המועד לפני ${late === 1 ? "יום" : `${late} ימים`}` : ""}
              {soon ? ` · ${left === 0 ? "היום" : left === 1 ? "מחר" : `בעוד ${left} ימים`}` : ""}
            </span>
          )}
          {d.current_photos > 0 && (
            <span className="it-muted">צולמו {d.current_photos === 1 ? "תמונה" : `${d.current_photos} תמונות`} — טרם סומן</span>
          )}
          {showSource && <span className="it-muted">{KIND_LABEL[d.reportKind] ?? ""} {formatDateIL(d.reportDate)}</span>}
        </p>
      </div>
      <div className="it-defect-actions">
        {/* מסגרת ולא מילוי: כפתור כחול מלא בכל שורה הפך את הרשימה לטור של כפתורים */}
        <button type="button" className="it-btn it-btn--small it-btn--done" onClick={() => onMarkDone(d)}>סימון כבוצע</button>
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

/**
 * "הורדת PDF לבודק" — מסמך אחד עם כל התיקונים של התסקיר הנוכחי של המתקן (בעלת המוצר, 08/10/2026: "כשמוסיפים
 * עוד תיקון לעוד ליקוי — שיצטרף לאותו PDF"). המסמך נבנה מחדש בכל הורדה, ולכן תיקון חדש פשוט מופיע בו.
 * ⚠️ נבנה בדפדפן מהנתונים השמורים, ולא נשמר במסד: התמונות המלאות נשלפות רק כשלוחצים — לא בפתיחת העמוד
 * (תעבורה) — אחת אחרי השנייה, והבנאי עצמו נטען רק אז (import דינמי).
 * @param {{defects: object[], site: object, machineLabel?: string|null, byId: Map}} p — defects: הבוצעו של המחזור
 */
export function FixesPdfButton({ defects, site, machineLabel = null, byId }) {
  const [state, setState] = useState("idle");          // idle | busy | error
  const fixes = fixesForPdf(defects);
  if (!site || fixes.length === 0) return null;
  const run = async () => {
    setState("busy");
    const urls = [];
    try {
      const items = [];
      for (const d of fixes) {
        const photoUrls = [];
        if (d.current_photos > 0) {
          for (const t of await fetchComplianceThumbs("defect", d.id)) {
            const url = (await fetchComplianceFile("defect_photo", t.id)).blobUrl;
            urls.push(url);
            photoUrls.push(url);
          }
        }
        const r = byId?.get(d.reportId);
        items.push({ defect: d, photoUrls, report: r ? { inspected_on: r.inspected_on, kindLabel: KIND_LABEL[r.kind] } : null });
      }
      const { buildFixesPdf, fixesPdfFileName } = await import("../../utils/defectPdf");
      const blob = await buildFixesPdf({ site, machineLabel, fixes: items });
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = fixesPdfFileName({ site, defects: fixes });
      document.body.appendChild(a);
      a.click();
      a.remove();
      // ⚠️ לא מיד: בחלק מהדפדפנים ההורדה מתחילה אחרי שהלחיצה חזרה, וכתובת שבוטלה = קובץ ריק
      setTimeout(() => URL.revokeObjectURL(href), 60_000);
      setState("idle");
    } catch {
      setState("error");
    } finally {
      urls.forEach((u) => URL.revokeObjectURL(u));   // כבר צוירו לתוך המסמך
    }
  };
  return (
    <span className="it-pdf">
      <button type="button" className="it-btn it-btn--small it-pdf-btn" onClick={run}
        disabled={state === "busy"} aria-busy={state === "busy"}
        title={fixes.length === 1 ? "מסמך עם הליקוי שתוקן והתמונות" : `מסמך אחד עם ${fixes.length} הליקויים שתוקנו והתמונות`}>
        {state === "busy" ? "מכין את המסמך…" : `הורדת PDF לבודק (${fixes.length})`}
      </button>
      {state === "error" && <span className="it-error" role="alert">המסמך לא הופק — אפשר לנסות שוב</span>}
    </span>
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
