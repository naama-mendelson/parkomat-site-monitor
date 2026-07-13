// tools/cleanup-old-data.js — מוחק נתונים ישנים (מעל שנה) אחרי שהסיכום קיים
// שימוש ידני: node master/tools/cleanup-old-data.js
// שימוש מ-master: require("./tools/cleanup-old-data").runCleanup()

const { getAllSites, generateMonthlySummary,
        getRawMonthsBefore, hasMonthlySummary, deleteRawInRange } = require("../db/queries");

const RETENTION_MONTHS = 12;

function getCutoffMonth() {
  const now = new Date();
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - RETENTION_MONTHS, 1));
  const year = cutoff.getUTCFullYear();
  const month = String(cutoff.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function runCleanup() {
  const sites = getAllSites();
  if (sites.length === 0) return;

  const cutoffMonth = getCutoffMonth();

  const oldMonths = getRawMonthsBefore(cutoffMonth);

  if (oldMonths.length === 0) {
    console.log(`[cleanup] אין נתונים ישנים מלפני ${cutoffMonth} — הכל נקי.`);
    return;
  }

  console.log(`[cleanup] נמצאו ${oldMonths.length} חודשים ישנים: ${oldMonths.join(", ")}`);

  for (const ym of oldMonths) {
    const [y, m] = ym.split("-").map(Number);
    const monthStart = ym + "-01T00:00:00.000Z";
    const monthEnd = new Date(Date.UTC(y, m, 1)).toISOString();

    // ודא סיכום לפני מחיקה (הגנה — לא מוחקים בלי סיכום)
    for (const site of sites) {
      if (!hasMonthlySummary(site.id, ym)) {
        generateMonthlySummary(site.id, ym);
        console.log(`[cleanup] ✅ סיכום נוצר לפני מחיקה: אתר ${site.code}, חודש ${ym}`);
      }
    }

    // מחיקת raw
    const deleted = deleteRawInRange(monthStart, monthEnd);

    console.log(`[cleanup] 🗑️ ${ym}: נמחקו ${deleted.operations} operations, ${deleted.statusHistory} status_history, ${deleted.maintenance} maintenance_windows`);
  }

  console.log("[cleanup] ✅ ניקוי הושלם.");
}

if (require.main === module) {
  runCleanup();
}

module.exports = { runCleanup };