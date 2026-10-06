// components/Compliance/InspectionHistory.jsx — כל התסקירים של האתר, ו"היסטוריית שינויים".
//
// מקובץ לפי שנה ואז לפי מתקן, וכל בדיקה חוזרת יושבת **מתחת** לתקופתי שלה —
// גם כשהיא בשנה אחרת. בדיקה חוזרת שמוצגת לבד בשנה הבאה נקראת כמו תסקיר
// חדש, ומי שמחפש "למה האתר הזה בתוקף" מסתכל על הכרטיס הלא נכון.
//
// ⚠️ "היסטוריית שינויים" נטענת רק כשפותחים אותה: היא כוללת טקסט חופשי
// (סיבות, תיאורי ליקויים) ועד 200 שורות, ורוב מי שפותח את הלשונית לא צריך אותה.
import { useEffect, useMemo, useState } from "react";
import { fetchComplianceHistory } from "../../services/dataSource";
import { formatDateIL, formatStampIL } from "../../utils/compliance";
import {
  FIELD_LABEL, KIND_LABEL, SOURCE_TAG, byDateDesc, historyActionLabel, historyValue, machineTitle,
  openInCycleUpTo,
} from "./InspectionUtils";
import { InspectionMenu } from "./InspectionDialog";
import { DefectDoneRow } from "./DefectRows";

function groupHistory(reports) {
  const byId = new Map(reports.map((r) => [r.id, r]));
  const children = new Map();
  const tops = [];
  for (const r of reports) {
    const parent = r.kind === "followup" ? byId.get(r.followup_of) : null;
    if (parent && parent.kind === "periodic") {
      if (!children.has(parent.id)) children.set(parent.id, []);
      children.get(parent.id).push(r);
    } else {
      tops.push(r);   // תקופתי, או חוזר שהאב שלו אינו ברשימה (לא אמור לקרות — מוצג ולא נבלע)
    }
  }
  for (const list of children.values()) list.sort((a, b) => -byDateDesc(a, b));   // חוזרות: מהישנה לחדשה
  const years = new Map();
  for (const r of tops.sort(byDateDesc)) {
    const y = String(r.inspected_on || "").slice(0, 4) || "—";
    if (!years.has(y)) years.set(y, new Map());
    const machines = years.get(y);
    if (!machines.has(r.machine_key)) machines.set(r.machine_key, []);
    machines.get(r.machine_key).push(r);
  }
  return { years: [...years.entries()], children };
}

function ReportCard({ report, parent, followups, allReports, isManager, onViewFile, onEdit, onDelete, onCloseByReport, onOpenPhoto, nested }) {
  const r = report;
  const [open, setOpen] = useState(false);
  const defects = r.defects || [];
  const doneN = defects.filter((d) => d.status === "done").length;
  const validDate = r.valid_until ?? r.effective_valid_until ?? null;
  const toClose = r.kind === "followup" && r.declared_clean ? openInCycleUpTo(allReports, r.followup_of, r.inspected_on).length : 0;
  const purged = !!r.file?.purged;
  const byId = useMemo(() => new Map(allReports.map((x) => [x.id, x])), [allReports]);

  return (
    <li className={`it-report${nested ? " it-report--nested" : ""}`}>
      <div className="it-report-head">
        <div className="it-report-title">
          <strong>{KIND_LABEL[r.kind] ?? r.kind}</strong>
          <span>{formatDateIL(r.inspected_on)}</span>
          {r.declared_clean && <span className="it-tag it-tag--clean">נקי</span>}
        </div>
        {isManager && (
          <InspectionMenu label="פעולות על התסקיר" items={[
            { label: "עריכת פרטים", onSelect: () => onEdit(r, parent) },
            // ⚠️ השרת מסרב למחוק תקופתי שיש לו בדיקות חוזרות חיות — אומרים זאת לפני
            // שהמנהל מקליד סיבה, לא אחרי (followups הם אותה רשימה שהשרת בודק)
            { label: "מחיקה", danger: true, onSelect: () => onDelete(r, followups?.length || 0) },
            toClose > 0 && { label: `סגירת הליקויים בתסקיר הזה (${toClose})`, onSelect: () => onCloseByReport(r, toClose) },
          ]} />
        )}
      </div>

      <p className="it-report-line">
        {r.kind === "followup" && !r.valid_until ? (
          <>תוקף: {validDate ? `עד ${formatDateIL(validDate)}` : "—"} <span className="it-tag it-tag--src">{SOURCE_TAG.inherited}</span></>
        ) : (
          <>בתוקף עד {formatDateIL(validDate)} {r.validity_source && <span className="it-tag it-tag--src">{SOURCE_TAG[r.validity_source] ?? r.validity_source}</span>}</>
        )}
      </p>
      {(r.inspector_name || r.inspector_license || r.report_number) && (
        <p className="it-report-line it-muted">
          {r.inspector_name && <span>בודק: {r.inspector_name}{r.inspector_license ? ` (רישיון ${r.inspector_license})` : ""}</span>}
          {!r.inspector_name && r.inspector_license && <span>רישיון בודק {r.inspector_license}</span>}
          {r.report_number && <span>מס' תסקיר {r.report_number}</span>}
        </p>
      )}
      {r.note && <p className="it-report-line it-done-note">{r.note}</p>}

      <div className="it-report-foot">
        {defects.length > 0 ? (
          <button type="button" className="it-link" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            ליקויים: {doneN}/{defects.length} בוצעו {open ? "▴" : "▾"}
          </button>
        ) : (
          <span className="it-muted">{r.declared_clean ? "ללא ליקויים" : "אין ליקויים רשומים"}</span>
        )}
        <button type="button" className="it-btn it-btn--small" disabled={purged || !r.file?.id}
          title={purged ? "הקובץ נמחק סופית" : undefined} onClick={() => onViewFile(r)}>
          צפייה במסמך
        </button>
      </div>

      {open && defects.length > 0 && (
        <ul className="it-list it-report-defects">
          {defects.map((d) => (d.status === "done" ? (
            <DefectDoneRow key={d.id} defect={d} closingReport={byId.get(d.closed_by_report_id)}
              isManager={false} onOpenPhoto={onOpenPhoto} />
          ) : (
            <li key={d.id} className="it-done it-done--open">
              <p className="it-defect-body">{d.body}</p>
              <p className="it-done-meta">
                פתוח{d.due_on ? ` · לתיקון עד ${formatDateIL(d.due_on)}` : ""}{d.urgent ? " · דחוף" : ""}
              </p>
            </li>
          )))}
        </ul>
      )}

      {followups?.length > 0 && (
        <ul className="it-list it-followups">
          {followups.map((f) => (
            <ReportCard key={f.id} report={f} parent={r} allReports={allReports} nested
              isManager={isManager} onViewFile={onViewFile} onEdit={onEdit} onDelete={onDelete}
              onCloseByReport={onCloseByReport} onOpenPhoto={onOpenPhoto} />
          ))}
        </ul>
      )}
    </li>
  );
}

function ChangeLog({ siteCode, rev }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ status: "idle", rows: [], error: "" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setState((s) => ({ ...s, status: "loading", error: "" }));
    fetchComplianceHistory(siteCode, 100)
      .then((rows) => { if (alive) setState({ status: "done", rows: rows.filter((h) => h.area === "inspection"), error: "" }); })
      .catch((err) => { if (alive) setState({ status: "error", rows: [], error: err?.message || "ההיסטוריה לא נטענה" }); });
    return () => { alive = false; };
  }, [open, siteCode, attempt, rev]);

  return (
    <section className="insights-card it-card">
      <button type="button" className="it-collapse" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span>היסטוריית שינויים</span>
        <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        state.status === "error" ? (
          <p className="it-error" role="alert">
            {state.error}{" "}
            <button type="button" className="it-link" onClick={() => setAttempt((n) => n + 1)}>נסה שוב</button>
          </p>
        ) : state.status !== "done" ? (
          <p className="it-muted">טוען…</p>
        ) : state.rows.length === 0 ? (
          <p className="it-muted">לא נרשמו שינויים.</p>
        ) : (
          <ul className="it-list it-log">
            {state.rows.map((h) => <ChangeRow key={h.id} h={h} />)}
          </ul>
        )
      )}
    </section>
  );
}

function ChangeRow({ h }) {
  const after = h.after && typeof h.after === "object" ? h.after : null;
  const before = h.before && typeof h.before === "object" ? h.before : null;
  let detail = null;
  if (h.entity === "report" && h.action === "update" && after) {
    detail = Object.keys(after).map((f) => (
      <span key={f} className="it-log-field">
        {FIELD_LABEL[f] ?? f}: {historyValue(f, before?.[f])} ← {historyValue(f, after[f])}
      </span>
    ));
  } else if (h.entity === "defect") {
    const body = after?.body ?? before?.body;
    if (body) detail = <span className="it-log-field">"{body}"</span>;
  } else if (h.entity === "machine" && after?.machine_key) {
    detail = <span className="it-log-field">מתקן {after.machine_key}</span>;
  } else if (Array.isArray(after?.defect_ids ?? before?.defect_ids)) {
    const ids = after?.defect_ids ?? before?.defect_ids ?? [];
    detail = <span className="it-log-field">{ids.length} ליקויים</span>;
  } else if (h.entity === "report" && h.action === "delete" && before) {
    detail = <span className="it-log-field">{KIND_LABEL[before.kind] ?? ""} {historyValue("inspected_on", before.inspected_on)}</span>;
  }
  return (
    <li className="it-log-row">
      <span className="it-log-when">{formatStampIL(h.at)}</span>
      <span className="it-log-what"><strong>{historyActionLabel(h)}</strong> · {h.actor}</span>
      {detail && <span className="it-log-detail">{detail}</span>}
      {h.reason && <span className="it-log-reason">סיבה: {h.reason}</span>}
    </li>
  );
}

/**
 * @param {object} p
 * @param {ReturnType<import('./InspectionUtils').deriveInspection>} p.derived
 */
export default function InspectionHistory({
  derived, siteCode, isManager, rev, onViewFile, onEdit, onDelete, onCloseByReport, onOpenPhoto,
}) {
  const { reports, machines } = derived;
  const grouped = useMemo(() => groupHistory(reports), [reports]);
  const machineByKey = useMemo(() => new Map(machines.map((m) => [m.key, m])), [machines]);
  const showMachine = machines.length > 1;

  return (
    <>
      {reports.length > 0 && (
        <section className="insights-card it-card">
          <h3>היסטוריית תסקירים</h3>
          {grouped.years.map(([year, byMachine]) => (
            <div key={year} className="it-year">
              <h4 className="it-year-title">{year}</h4>
              {[...byMachine.entries()].map(([key, list]) => (
                <div key={key} className="it-year-machine">
                  {showMachine && (
                    <h5 className="it-machine-sub">
                      {machineTitle(machineByKey.get(key) ?? { key })}
                      {machineByKey.get(key)?.retired_at && <span className="it-tag it-tag--muted">הוצא משימוש</span>}
                    </h5>
                  )}
                  <ul className="it-list">
                    {list.map((r) => (
                      <ReportCard key={r.id} report={r} parent={null} followups={grouped.children.get(r.id)}
                        allReports={reports} isManager={isManager}
                        onViewFile={onViewFile} onEdit={onEdit} onDelete={onDelete}
                        onCloseByReport={onCloseByReport} onOpenPhoto={onOpenPhoto} />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ))}
        </section>
      )}
      <ChangeLog siteCode={siteCode} rev={rev} />
    </>
  );
}
