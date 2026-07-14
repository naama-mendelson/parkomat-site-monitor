// tools/add-test-site.js — הוספת אתר בדיקה
// שימוש:
//   node master/tools/add-test-site.js                          → אתר 1 "אתר בדיקה ראשי", חדש (ברירת מחדל)
//   node master/tools/add-test-site.js 2 "חניון דיזנגוף" new     → אתר חדש (מונה מתחיל מ-0)
//   node master/tools/add-test-site.js 3 "חניון ותיק" existing  → אתר ותיק (מאמץ מונה מהבקר)
// argument שלישי: "new" (ברירת מחדל) או "existing".
const { findSiteByCode, insertSite } = require("../db/queries");

// code ושם אופציונליים מ-CLI — בלי arguments נשמרת תאימות אחורה (אתר 1)
const code = process.argv[2] || "1";
const name = process.argv[3] || "אתר בדיקה ראשי";

// סוג האתר: "existing" → ותיק (מאמץ מונה); כל דבר אחר / ריק → "new" (מונה מ-0).
const kind = (process.argv[4] || "new").toLowerCase();
const isNewSite = kind === "existing" ? 0 : 1;

const existing = await findSiteByCode(code);
if (existing) {
  console.log(`אתר ${code} כבר קיים:`, existing);
} else {
  await insertSite(code, name, {}, isNewSite);
  const label = isNewSite ? "חדש (מונה מתחיל מ-0)" : "ותיק (מאמץ מונה מהבקר)";
  console.log(`אתר ${code} נרשם בהצלחה (${name}) — ${label}`);
}
