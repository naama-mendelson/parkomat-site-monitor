// components/MonthlyReport/MonthlyReport.jsx — דוח חודשי לטווח תאריכים חופשי.
//
// ============================================================
// למה זה מסך נפרד ולא עוד לשונית
// ============================================================
// כל שאר המסכים עונים על "מה קורה עכשיו" ונשענים על בורר תקופה קבוע
// (שבוע/חודש/שנה). הדוח עונה על שאלה אחרת לגמרי — "מה היה בין שני תאריכים
// שאני בוחרת" — ולכן הוא לא נכנס תחת אותו בורר.
import { Fragment, useState } from "react";
import { fetchMonthlyReport } from "../../services/dataSource";
import "./MonthlyReport.css";

const MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
                "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];

/** "2026-07" → "יולי 2026" */
function monthLabel(ym) {
  const [y, m] = String(ym).split("-").map(Number);
  return `${MONTHS[m - 1] ?? ym} ${y}`;
}

const iso = (d) => d.toISOString().slice(0, 10);

function MonthlyReport({ site = null, onClose }) {
  // ברירת מחדל: מתחילת השנה עד היום. טווח שימושי מיד, בלי למלא כלום.
  const [from, setFrom] = useState(() => iso(new Date(new Date().getFullYear(), 0, 1)));
  const [to, setTo] = useState(() => iso(new Date()));

  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // איזה אתר פרוש לפילוח חודשי. אחד בכל רגע — פתיחת כולם מאבדת את ההשוואה
  // בין האתרים, שהיא כל מה שהטבלה הזו נותנת.
  const [openSite, setOpenSite] = useState(null);

  const run = async (e) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setReport(await fetchMonthlyReport(site?.code ?? null, from, to));
    } catch (err) {
      setError(err.message || "הפקת הדוח נכשלה");
      setReport(null);
    } finally {
      setBusy(false);
    }
  };

  const months = report?.months ?? [];
  const sites = report?.sites ?? [];
  const siteMonths = report?.siteMonths ?? [];
  const totals = months.reduce(
    (a, m) => ({ operations: a.operations + m.operations, errors: a.errors + m.errors }),
    { operations: 0, errors: 0 }
  );

  // ============================================================
  // ייצוא ל-CSV — כי דוח שאי אפשר להוציא ממנו נתונים אינו דוח
  // ============================================================
  // ⚠️ BOM בתחילת הקובץ. בלעדיו Excel פותח UTF-8 בעברית כג'יבריש — וזה
  // הכשל היחיד שהופך את הייצוא כולו לחסר תועלת, בלי שום הודעת שגיאה.
  const exportCsv = () => {
    // ⚠️ הייצוא מחזיק את **אותן עמודות** שעל המסך. קובץ שמכיל עמודות שאינן
    // בטבלה הופך את הבדיקה "האם המספר נכון" לבלתי אפשרית — אין מול מה להשוות.
    const head = ["חודש", "פעולות", "תקלות"];
    const rows = months.map((m) => [monthLabel(m.year_month), m.operations, m.errors]);
    rows.push(["סה\"כ", totals.operations, totals.errors]);

    // ⚠️ שלושת החתכים באותו קובץ, מופרדים בשורה ריקה. מי שמפיק דוח רוצה את
    // כולם, וקובץ שני היה נשכח בתיקיית ההורדות.
    const siteHead = ["אתר", "קוד", "פעולות", "תקלות"];
    const siteRows = sites.map((s) => [s.site_name, s.code, s.operations, s.errors]);

    const smHead = ["אתר", "חודש", "פעולות", "תקלות"];
    const smRows = siteMonths.map((m) => [
      m.code, monthLabel(m.year_month), m.operations, m.errors,
    ]);

    const csv = "﻿" + [head, ...rows, [], siteHead, ...siteRows, [], smHead, ...smRows]
      .map((r) => r.join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `parkomat-${site?.code ?? "all"}-${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="report-overlay" onClick={onClose}>
      <div className="report-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="report-header">
          <div>
            <h2>דוח תקופתי</h2>
            <span className="report-sub">
              {site ? `${site.site_name} · קוד ${site.code}` : "כל האתרים"}
            </span>
          </div>
          <button className="report-close" onClick={onClose} aria-label="סגירה">✕</button>
        </header>

        <form className="report-controls" onSubmit={run}>
          <label>
            <span>מתאריך</span>
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            <span>עד תאריך</span>
            <input type="date" value={to} min={from} max={iso(new Date())}
                   onChange={(e) => setTo(e.target.value)} />
          </label>
          <button type="submit" className="report-run" disabled={busy || !from || !to}>
            {busy ? "מפיק…" : "הפק דוח"}
          </button>
          {months.length > 0 && (
            <button type="button" className="report-export" onClick={exportCsv}>
              ייצוא ל-Excel
            </button>
          )}
        </form>

        {error && <p className="report-error">{error}</p>}

        {report && (
          months.length === 0 ? (
            <p className="report-empty">לא נרשמה פעילות בטווח שנבחר</p>
          ) : (
            // ==========================================================
            // שתי עמודות בלבד: פעולות ותקלות
            // ==========================================================
            // היו כאן גם כניסות, יציאות, תחזוקה ומספר אתרים. הם ירדו — לא
            // כי הם שגויים אלא כי דוח שמציג שבע עמודות מכריח לחפש בתוכו את
            // השתיים שביקשו. כל אלה זמינים במסכים הייעודיים להם.
            <table className="report-table">
              <thead>
                <tr>
                  <th>חודש</th>
                  <th>פעולות</th>
                  <th>תקלות</th>
                </tr>
              </thead>
              <tbody>
                {months.map((m) => (
                  <tr key={m.year_month}>
                    <th scope="row">{monthLabel(m.year_month)}</th>
                    <td><strong>{m.operations.toLocaleString()}</strong></td>
                    {/* אפס נשאר דהוי ולא נצבע — טבלה שכולה אדום מאבדת את
                        מה שהיא באה להבליט. */}
                    <td className={m.errors > 0 ? "is-error" : "muted"}>{m.errors}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">סה"כ</th>
                  <td><strong>{totals.operations.toLocaleString()}</strong></td>
                  <td className={totals.errors > 0 ? "is-error" : "muted"}>{totals.errors}</td>
                </tr>
              </tfoot>
            </table>
          )
        )}

        {/* ==========================================================
            לפי אתר — פעולות ותקלות
            ==========================================================
            החתך החודשי עונה "איך זה התפתח". זה עונה "מי בעייתי", וזו שאלה
            אחרת לגמרי — אתר אחד עם 14 תקלות נבלע לגמרי בסכום החודשי. */}
        {sites.length > 0 && (
          <>
            <h3 className="report-section">לפי אתר</h3>
            <table className="report-table">
              <thead>
                <tr>
                  <th>אתר</th>
                  <th>פעולות</th>
                  <th>תקלות</th>
                </tr>
              </thead>
              <tbody>
                {sites.map((s) => {
                  const ms = siteMonths.filter((m) => m.site_id === s.site_id);
                  const open = openSite === s.site_id;
                  return (
                  <Fragment key={s.site_id}>
                  {/* ==========================================================
                      לחיצה פורשת את החודשים של אותו אתר
                      ==========================================================
                      השורה מסכמת את **כל** הטווח, אבל טווח של "5.7 עד היום"
                      חוצה שני חודשים — ואז "89 פעולות" אינו אומר כמה היו בכל
                      אחד מהם. הנתון קיים; הוא פשוט לא היה מפולח.

                      ⚠️ סכום שורות החודש שווה בדיוק לשורת האתר — נבדק על כל
                      12 האתרים. אם השניים ייפרדו, אחד מהם משקר. */}
                  <tr
                    className={`${ms.length > 1 ? "is-expandable" : ""} ${open ? "is-open" : ""}`}
                    onClick={ms.length > 1 ? () => setOpenSite(open ? null : s.site_id) : undefined}
                    title={ms.length > 1 ? "לחצי לפילוח לפי חודש" : undefined}
                  >
                    <th scope="row">
                      {ms.length > 1 && <span className="row-caret">{open ? "▾" : "▸"}</span>}
                      {s.site_name}
                      <span className="report-code">{s.code}</span>
                    </th>
                    <td><strong>{s.operations.toLocaleString()}</strong></td>
                    <td className={s.errors > 0 ? "is-error" : "muted"}>{s.errors}</td>
                  </tr>

                  {open && ms.map((m) => (
                    <tr key={`${s.site_id}-${m.year_month}`} className="row-month">
                      <th scope="row">{monthLabel(m.year_month)}</th>
                      <td>{m.operations.toLocaleString()}</td>
                      <td className={m.errors > 0 ? "is-error" : "muted"}>{m.errors}</td>
                    </tr>
                  ))}
                  </Fragment>
                  );
                })}
              </tbody>
            </table>
          </>
        )}

        {!report && !error && (
          <p className="report-empty">בחרי טווח תאריכים ולחצי "הפק דוח"</p>
        )}
      </div>
    </div>
  );
}

export default MonthlyReport;
