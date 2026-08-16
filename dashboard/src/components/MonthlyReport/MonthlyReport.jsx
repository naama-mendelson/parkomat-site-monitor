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

    // ⚠️ חתך רביעי בקובץ — סוגי התקלות. בטבלה הם שורות מקוננות, ובקובץ
    // שטוח הם חייבים להיות טבלה משלהם: דחיסתם לתא אחד ("סוג×3; סוג×2")
    // הופכת אותם לטקסט שאי אפשר לסנן או לסכם ב-Excel, כלומר לחסרי ערך
    // בדיוק בכלי שבשבילו מייצאים.
    const kindHead = ["אתר", "קוד", "סוג תקלה", "כמה"];
    const kindRows = sites.flatMap((s) =>
      (s.fault_types || []).map((k) => [s.site_name, s.code, k.text, k.count]));

    const smHead = ["אתר", "חודש", "פעולות", "תקלות"];
    const smRows = siteMonths.map((m) => [
      m.code, monthLabel(m.year_month), m.operations, m.errors,
    ]);

    // ============================================================
    // ⚠️ ציטוט CSV — והוא **תיקון באג קיים**, לא הידור
    // ============================================================
    // כאן היה `r.join(",")` בלי שום ציטוט, ושמות האתרים מכילים פסיקים
    // בפועל: `עמנואל הרומי 10 , ת"א`. כלומר כל שורה כזו נשברה לשתי
    // עמודות ב-Excel והזיזה את כל הטור שאחריה — **בלי שום הודעת שגיאה**.
    // זה בדיוק סוג הכשל שמתגלה רק כשמישהו מסכם עמודה ומקבל שטות.
    //
    // ⚠️ ותיאורי התקלה מחריפים אותו: הם טקסט חופשי מהבקר, ולכן יכולים
    // להכיל פסיק, מרכאות, ואפילו שורה חדשה.
    //
    // הכלל התקני: עוטפים במרכאות כשיש פסיק / מרכאה / שורה חדשה, ומרכאה
    // פנימית מוכפלת.
    const cell = (v) => {
      const t = String(v ?? "");
      return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };

    const csv = "﻿" + [head, ...rows, [], siteHead, ...siteRows, [], kindHead, ...kindRows, [], smHead, ...smRows]
      .map((r) => r.map(cell).join(",")).join("\r\n");
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
                  // ⚠️ **הפילוח לפי סוג תקלה מגיע מ-report_by_site**, מאותן
                  // שורות בדיוק שמהן נספר `errors` — ולכן הסכום שלו שווה לו
                  // תמיד. שתי שאילתות נפרדות היו מתפצלות בשקט בשינוי הבא,
                  // והמסך היה מציג פילוח שאינו מסתכם למספר שלידו.
                  const kinds = s.fault_types || [];
                  // ⚠️ נפתח גם כשיש חודש אחד בלבד: קודם התנאי היה מספר
                  // החודשים בלבד, ולכן אתר עם תקלות בחודש יחיד לא היה נפתח
                  // כלל — כלומר הפילוח שלו היה בלתי נגיש.
                  const canOpen = ms.length > 1 || kinds.length > 0;
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
                    className={`${canOpen ? "is-expandable" : ""} ${open ? "is-open" : ""}`}
                    onClick={canOpen ? () => setOpenSite(open ? null : s.site_id) : undefined}
                    title={canOpen ? "לחצי לפילוח לפי חודש וסוג תקלה" : undefined}
                  >
                    <th scope="row">
                      {canOpen && <span className="row-caret">{open ? "▾" : "▸"}</span>}
                      {s.site_name}
                      <span className="report-code">{s.code}</span>
                    </th>
                    <td><strong>{s.operations.toLocaleString()}</strong></td>
                    <td className={s.errors > 0 ? "is-error" : "muted"}>{s.errors}</td>
                  </tr>

                  {open && ms.length > 1 && ms.map((m) => (
                    <tr key={`${s.site_id}-${m.year_month}`} className="row-month">
                      <th scope="row">{monthLabel(m.year_month)}</th>
                      <td>{m.operations.toLocaleString()}</td>
                      <td className={m.errors > 0 ? "is-error" : "muted"}>{m.errors}</td>
                    </tr>
                  ))}

                  {/* ==========================================================
                      אילו תקלות היו, וכמה מכל אחת
                      ==========================================================
                      "13 תקלות" אינו אומר אם מדובר בתקלה אחת שחוזרת 13 פעם —
                      כלומר משהו אחד שבור — או ב-13 תקלות שונות. אלו שתי
                      מסקנות תחזוקה הפוכות מאותו מספר.

                      ⚠️ "ללא תיאור" מוצג ואינו מושמט: הבקר מדווח תיאור רק
                      בגרסאות סוכן חדשות, ומקטעים ישנים ריקים. השמטתם הייתה
                      גורמת לפילוח לא להסתכם למספר התקלות שלידו. */}
                  {open && kinds.length > 0 && (
                    <tr className="row-month row-kinds-head">
                      <th scope="row" colSpan={3}>סוגי התקלות</th>
                    </tr>
                  )}
                  {open && kinds.map((k) => (
                    <tr key={`${s.site_id}-k-${k.text}`} className="row-month row-kind">
                      <th scope="row" title={k.text}>{k.text}</th>
                      <td className="muted">—</td>
                      <td className="is-error">{k.count}</td>
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
