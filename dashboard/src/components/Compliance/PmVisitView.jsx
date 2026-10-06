// components/Compliance/PmVisitView.jsx — צפייה בביקור שהוגש (קריאה בלבד).
//
// נפתח בתוך שורת ההיסטוריה. ביקור מהטופס: פריטים, הערות, תמונות ממוזערות
// וחתימה. דוח היסטורי (PDF סרוק): הפרטים מהשורה וכפתור "צפייה במסמך".
//
// ⚠️ שום קובץ מלא לא נטען מראש. ממוזערות (≤40KB כל אחת) כן; תמונה מלאה,
// חתימה ו-PDF — רק בלחיצה, דרך ComplianceFileViewer, שמשחרר את ה-blob
// כשהוא נסגר. רשימת היסטוריה שהייתה מושכת עשרה דוחות של 8MB כל אחד רק
// כדי להציג אותם הייתה גומרת את מכסת התעבורה בבוקר אחד.
import { useEffect, useRef, useState } from "react";
import {
  fetchPmVisit, fetchComplianceThumbs, fetchComplianceFile, deletePmVisit,
} from "../../services/dataSource";
import { formatDateIL, formatStampIL } from "../../utils/compliance";
import ComplianceFileViewer from "./ComplianceFileViewer";
import { ReasonForm } from "./PmCommon";
import { KIND_LABEL, bytesText } from "./PmUtils";

export default function PmVisitView({ visit, isManager, onDeleted }) {
  const historical = visit.source === "historical";
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [thumbs, setThumbs] = useState(() => new Map());
  const [viewer, setViewer] = useState(null);      // {key, kind, id, title}
  const [deleteOpen, setDeleteOpen] = useState(false);
  // "חזרה" מהאישור מחזירה את הפוקוס לכפתור שפתח אותו (ראה ReasonForm)
  const deleteBtnRef = useRef(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !deleteOpen) deleteBtnRef.current?.focus();
    wasOpen.current = deleteOpen;
  }, [deleteOpen]);

  useEffect(() => {
    if (historical) return undefined;               // אין פריטים — כל מה שצריך כבר בשורה
    let alive = true;
    setError("");
    fetchPmVisit(visit.id)
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        const hasPhotos = (d?.items || []).some((i) => (i.photos || []).length > 0);
        if (!hasPhotos) return;
        fetchComplianceThumbs("pm_visit", visit.id)
          .then((rows) => { if (alive) setThumbs(new Map(rows.map((r) => [r.id, r.thumb]))); })
          .catch(() => { /* בלי ממוזערות — הריבועים נשארים ריקים ועדיין לחיצים */ });
      })
      .catch((err) => { if (alive) setError(err?.message || "הביקור לא נטען"); });
    return () => { alive = false; };
  }, [visit.id, historical, attempt]);

  const open = (kind, id, title) => setViewer({ key: `${kind}:${id}`, kind, id, title });

  const performer = visit.performer_name || detail?.performer_name;
  const note = visit.note ?? detail?.note;

  return (
    <div className="pm-view">
      <dl className="pm-facts">
        <div><dt>תאריך ביצוע</dt><dd>{formatDateIL(visit.performed_on)}</dd></div>
        {performer && <div><dt>מבצע</dt><dd>{performer}</dd></div>}
        {visit.vendor && <div><dt>ספק</dt><dd>{visit.vendor}</dd></div>}
        {visit.submitted_by && (
          <div>
            <dt>{historical ? "הועלה ע״י" : "הוגש ע״י"}</dt>
            <dd>{visit.submitted_by}{visit.submitted_at ? ` · ${formatStampIL(visit.submitted_at)}` : ""}</dd>
          </div>
        )}
        {note && <div className="pm-facts-wide"><dt>הערה</dt><dd className="pm-pre">{note}</dd></div>}
      </dl>

      <div className="pm-row">
        {visit.file && (
          <button type="button" className="pm-btn"
            onClick={() => open("pm_pdf", visit.file.id, visit.file.file_name || "דוח תחזוקה")}>
            צפייה במסמך{visit.file.byte_size ? ` (${bytesText(visit.file.byte_size)})` : ""}
          </button>
        )}
        {visit.has_signature && (
          <button type="button" className="pm-btn" onClick={() => open("pm_signature", visit.id, "חתימת המבצע")}>
            הצגת חתימה
          </button>
        )}
      </div>

      {!historical && (
        error ? (
          <div className="pm-banner pm-banner--error" role="alert">
            {error}
            <button type="button" className="pm-btn pm-btn--inline" onClick={() => setAttempt((n) => n + 1)}>נסה שוב</button>
          </div>
        ) : !detail ? (
          <p className="pm-muted">טוען את פרטי הביקור…</p>
        ) : (
          <ol className="pm-view-items">
            {(detail.items || []).map((it) => {
              const n = (it.photos || []).length;
              // פריט צילום בלי אף תמונה אינו "בוצע", גם כשהוא רשות (מינימום 0)
              const done = it.kind === "photo" ? n > 0 && n >= (it.min_photos || 0) : !!it.checked;
              return (
                <li key={it.id} className={`pm-view-item${done ? "" : " pm-view-item--no"}`}>
                  <span className="pm-view-mark" aria-label={done ? "בוצע" : "לא סומן"}>{done ? "✓" : "—"}</span>
                  <div className="pm-view-body">
                    <span className="pm-view-label">{it.label}</span>
                    <span className="pm-view-sub">
                      {KIND_LABEL[it.kind] || it.kind}{it.required ? " · חובה" : " · רשות"}
                    </span>
                    {it.note && <span className="pm-view-note pm-pre">{it.note}</span>}
                    {(it.photos || []).length > 0 && (
                      <div className="pm-thumbs">
                        {it.photos.map((fid, ix) => (
                          <button key={fid} type="button" className="pm-thumb-btn"
                            aria-label={`תמונה ${ix + 1} של ${it.label}`}
                            onClick={() => open("pm_photo", fid, `${it.label} — תמונה ${ix + 1}`)}>
                            {thumbs.get(fid)
                              ? <img src={`data:image/jpeg;base64,${thumbs.get(fid)}`} alt="" />
                              : <span className="pm-thumb-empty" aria-hidden="true" />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )
      )}

      {isManager && (
        <div className="pm-view-admin">
          {deleteOpen ? (
            <ReasonForm
              text="הביקור יוסר מההיסטוריה ומחישוב מועד התחזוקה הבא. הרשומה נשמרת במסד עם הסיבה."
              confirmLabel="מחיקת הביקור"
              required
              onConfirm={async (reason) => {
                // ⚠️ pm_visit_delete אינו אידמפוטנטי: ניסיון חוזר אחרי תשובה שאבדה
                // מקבל PT404 "הביקור לא נמצא". ביקור שמופיע ברשימה של המנהל ו"לא
                // נמצא" — כבר נמחק, כלומר הניסיון הקודם הצליח. זו הצלחה, לא שגיאה.
                let already = false;
                try {
                  await deletePmVisit(visit.id, reason);
                } catch (err) {
                  if (err?.code !== "PT404") throw err;
                  already = true;
                }
                onDeleted?.({ already });
              }}
              onCancel={() => setDeleteOpen(false)}
            />
          ) : (
            <button type="button" className="pm-btn pm-btn--danger" ref={deleteBtnRef}
              onClick={() => setDeleteOpen(true)}>מחיקה</button>
          )}
        </div>
      )}

      {viewer && (
        <ComplianceFileViewer
          key={viewer.key}
          title={viewer.title}
          fetchFile={() => fetchComplianceFile(viewer.kind, viewer.id)}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
}
