// tools/monthly-summary.js — יוצר סיכום חודשי לחודש שנגמר
// שימוש ידני: node master/tools/monthly-summary.js
// שימוש מ-master: require("./tools/monthly-summary").runMonthlySummary()

const { getAllSites, generateMonthlySummary, hasMonthlySummary } = require("../db/queries");

// חודש קודם בפורמט "YYYY-MM"
function getLastMonth() {
  const now = new Date();
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const year = last.getUTCFullYear();
  const month = String(last.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function runMonthlySummary() {
  const sites = getAllSites();
  if (sites.length === 0) return;

  const lastMonth = getLastMonth();

  for (const site of sites) {
    if (!hasMonthlySummary(site.id, lastMonth)) {
      generateMonthlySummary(site.id, lastMonth);
      console.log(`[summary] ✅ סיכום נוצר: אתר ${site.code}, חודש ${lastMonth}`);
    }
  }
}

if (require.main === module) {
  runMonthlySummary();
}

module.exports = { runMonthlySummary };