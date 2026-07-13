// utils/exporters.js — ייצוא נתונים לקובץ, בלי ספריות חיצוניות

// הורדת Blob כקובץ
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * ייצוא ל-CSV.
 *
 * קריטי: ה-BOM (﻿) בתחילת הקובץ. בלעדיו Excel מפרש את הקובץ כ-ANSI
 * ומציג את העברית כג'יבריש. זו התקלה הנפוצה ביותר בייצוא CSV בעברית.
 */
export function exportCSV(rows, filename) {
  if (!rows || rows.length === 0) return false;

  const headers = Object.keys(rows[0]);

  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

  const csv = [
    headers.map(escape).join(","),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(",")),
  ].join("\r\n");   // CRLF — מה ש-Excel מצפה לו

  download(
    new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" }),
    filename,
  );
  return true;
}

/** ייצוא ה-payload המלא ל-JSON */
export function exportJSON(data, filename) {
  download(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8;" }),
    filename,
  );
  return true;
}

/** שם קובץ שכולל את הטווח: parkomat_2026-06-01_2026-07-12.csv */
export function reportFilename(range, ext) {
  const day = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : "");
  return `parkomat_${day(range?.from)}_${day(range?.to)}.${ext}`;
}
