// components/ReportView/ReportView.jsx — תצוגת דוח רשמית, מותאמת להדפסה/PDF
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { STATUS_COLORS } from "../../utils/constants";
import LineChart from "../LineChart/LineChart";
import "./ReportView.css";

const OPS = STATUS_COLORS.operating.dot;
const ERR = STATUS_COLORS.error.dot;

function ReportView({ data, onClose }) {
  // חוסמים גלילה של הרקע כל עוד הדוח פתוח
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (!data) return null;

  const now = new Date().toLocaleString("he-IL", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  const k = data.kpis;

  // ==========================================================
  // הסטטוס לא נכנס לדוח — וזה לא קיצור, זו נכונות.
  // ==========================================================
  // הדוח מתאר *תקופה* (למשל יולי 2026): פעולות, תקלות, זמינות — כולם נמדדו
  // בתוכה. הסטטוס, לעומת זאת, הוא צילום רגע: מה מצב האתר בשנייה שבה הדוח
  // הופק. אתר שהיה מושבת חצי מהחודש והתאושש לפני דקה היה מופיע בדוח כ"מוכן",
  // ומי שיקרא את הדוח בעוד חודש יבין ממנו דבר שגוי לחלוטין.
  //
  // בייצוא ה-CSV הוא כן נשאר (שם זה dump גולמי), ולכן הוא מסונן כאן ולא בשרת.
  //
  // שני השמות מסוננים בכוונה: השרת שינה את המפתח מ-"מצב" ל-"מצב נוכחי", אבל
  // הדוח לא אמור להיות תלוי בגרסת השרת שרצה מולו. שרת ישן לא יחזיר עמודה
  // שגויה לדוח.
  const STATUS_KEYS = new Set(["מצב", "מצב נוכחי"]);

  const PERIOD_COLUMNS = (row) =>
    Object.entries(row).filter(([key]) => !STATUS_KEYS.has(key));

  const rows = data.rawRows || [];
  const headers = rows.length ? PERIOD_COLUMNS(rows[0]).map(([key]) => key) : [];

  // ==========================================================
  // הדוח מרונדר ישירות אל <body> דרך פורטל — וזה מה שהופך אותו לניתן להדפסה
  // ==========================================================
  // הוא נמצא בעץ ה-React בתוך ExecutiveView, כלומר בתוך <main class="app-main">.
  // ה-CSS של ההדפסה מסתיר את `.app-main` (כדי לא להדפיס את הדשבורד) — ואב עם
  // display:none מסתיר את *כל* הצאצאים שלו. כלומר הדוח הסתיר את עצמו,
  // וההדפסה יצאה דף ריק.
  //
  // הפורטל מוציא אותו מה-DOM של הדשבורד והופך אותו לילד ישיר של <body>,
  // כך שהסתרת הדשבורד לא נוגעת בו. במיקום בעץ ה-React (props, state) לא השתנה כלום.
  return createPortal(
    <div className="rv">
      {/* סרגל הפעולות — לא מודפס */}
      <div className="rv-bar no-print">
        <button className="rv-print" onClick={() => window.print()}>🖨 הדפס</button>
        <button className="rv-close" onClick={onClose}>חזרה לתצוגה רגילה</button>
      </div>

      <article className="rv-page">
        {/* כותרת הדוח */}
        <header className="rv-header">
          <div className="rv-brandbox">
            {/* הלוגו מודפס גם הוא — הדוח יוצא ממותג */}
            <img src="/parkomat-logo.png" alt="Parkomat" className="rv-logo" />
            <div>
              <span className="rv-brand">Parkomat · SiteMonitor</span>
              <h1>דוח מנהל</h1>
            </div>
          </div>
          <div className="rv-meta">
            <p><strong>תקופת הדוח:</strong> {data.label}</p>
            <p><strong>אתרים בדוח:</strong> {data.filteredSitesCount} מתוך {data.totalSitesInSystem}</p>
            <p><strong>הופק בתאריך:</strong> {now}</p>
          </div>
        </header>

        {/* מדדים ראשיים */}
        <section className="rv-section">
          <h2>מדדים ראשיים</h2>
          <table className="rv-kpis">
            <tbody>
              <tr>
                <th>סה"כ פעולות חניה</th><td>{k.totalOperations.toLocaleString()}</td>
                <th>זמינות ממוצעת</th><td>{k.avgAvailability}%</td>
              </tr>
              <tr>
                <th>סה"כ תקלות</th><td>{k.totalErrors.toLocaleString()}</td>
                <th>אחוז כשל ממוצע</th><td>{k.avgFailureRate}%</td>
              </tr>
              <tr>
                <th>אתרים פעילים</th><td>{k.activeSites} / {k.totalSites}</td>
                <th>שעות תחזוקה</th><td>{k.totalMaintenanceHours}</td>
              </tr>
              <tr>
                <th>שעות השבתה</th><td>{k.totalDowntimeHours}</td>
                <th>—</th><td>—</td>
              </tr>
            </tbody>
          </table>
        </section>

        {/* גרף מגמה */}
        <section className="rv-section rv-break">
          <h2>מגמת פעילות ותקלות</h2>
          <LineChart
            points={data.chart}
            series={[
              { key: "operations", name: "פעולות", color: OPS },
              { key: "errors", name: "תקלות", color: ERR },
            ]}
            type="line"
            showGrid
          />
        </section>

        {/* טבלת האתרים */}
        <section className="rv-section rv-break">
          <h2>פירוט לפי אתר</h2>
          {rows.length === 0 ? (
            <p className="rv-empty">אין נתונים בטווח הנבחר</p>
          ) : (
            <table className="rv-table">
              <thead>
                <tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    {PERIOD_COLUMNS(r).map(([key, v]) => (
                      <td key={key}>{String(v ?? "—")}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <footer className="rv-footer">
          Parkomat SiteMonitor — דוח מנהל · {data.label}
        </footer>
      </article>
    </div>,
    document.body,
  );
}

export default ReportView;
