// components/ExportMenu/ExportMenu.jsx — ייצוא CSV/JSON והדפסה
import { useState } from "react";
import { exportCSV, exportJSON, reportFilename } from "../../utils/exporters";
import "./ExportMenu.css";

/**
 * data       — ה-payload המלא מהשרת (כבר מסונן!)
 * onPrint    — מעבר לתצוגת דוח והדפסה
 */
function ExportMenu({ data, onPrint }) {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState(null);

  const rows = data?.rawRows || [];

  function flash(text) {
    setMsg(text);
    setTimeout(() => setMsg(null), 2200);
  }

  function doCSV() {
    setOpen(false);
    if (rows.length === 0) return flash("אין נתונים לייצוא");
    exportCSV(rows, reportFilename(data.range, "csv"));
    flash(`יוצאו ${rows.length} אתרים ל-CSV`);
  }

  function doJSON() {
    setOpen(false);
    exportJSON(data, reportFilename(data.range, "json"));
    flash("הנתונים המלאים יוצאו ל-JSON");
  }

  return (
    <div className="em">
      <button className="em-trigger" onClick={() => setOpen((o) => !o)}>
        ⤓ ייצוא
        <span className={`em-caret ${open ? "is-open" : ""}`}>▾</span>
      </button>

      {open && (
        <div className="em-panel">
          <button onClick={doCSV}>
            <strong>CSV</strong>
            <span>טבלת האתרים — נפתח ב-Excel</span>
          </button>
          <button onClick={doJSON}>
            <strong>JSON</strong>
            <span>כל הנתונים הגולמיים</span>
          </button>
          <button onClick={() => { setOpen(false); onPrint(); }}>
            <strong>הדפס דוח</strong>
            <span>תצוגה מותאמת להדפסה / PDF</span>
          </button>

          <p className="em-note">הייצוא מכבד את הפילטרים הפעילים</p>
        </div>
      )}

      {msg && <span className="em-toast">{msg}</span>}
    </div>
  );
}

export default ExportMenu;
