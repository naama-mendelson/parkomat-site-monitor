// tools/check-switch.js — האם **שתי** זרועות המתג באמת קיימות.
//
//   node tools/check-switch.js
//
// ============================================================
// למה זה קיים: build ירוק אינו אומר שהקוד רץ
// ============================================================
// נתפס בפועל, ובדיוק בדרך הגרועה ביותר. שלושה מסלולים חוברו למתג, אבל
// הייבוא של **זרוע השרת** שלהם לא נוסף — `fetchSiteDetailViaServer` נקרא
// מבלי שיובא מעולם.
//
// `vite build` עבר. הוא אינו TypeScript ואינו בודק מזהים חופשיים; השגיאה
// הייתה מופיעה רק כ-ReferenceError בזמן ריצה — **ורק במצב VITE_SUPABASE_DIRECT=false**,
// כלומר בדיוק ביום שבו נרצה לחזור מ-Supabase, וכשכבר לא נזכור למה.
//
// זה בדיוק מה ש-CLAUDE.md מזהיר עליו: "מסלול שאינו רץ נרקב". הבדיקה הזו היא
// מה שמונע ממנו לרקוב בשקט.
//
// ⚠️ היא בודקת **קיום ושלמות**, לא נכונות. ששתי הזרועות מחזירות אותו מבנה
// נבדק בשערי ה-parity; שהן בכלל קיימות — כאן.

const fs = require("node:fs");
const path = require("node:path");

const DS = path.resolve(__dirname, "../../dashboard/src/services/dataSource.js");
const src = fs.readFileSync(DS, "utf8");

let fail = 0;
const say = (good, msg) => { if (!good) fail++; console.log(`  ${good ? "✔" : "✘"} ${msg}`); };

// כל המזהים שיובאו (משני הסוגים: `x as y` ו-`x`)
const imported = new Set();
for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
  for (const part of m[1].split(",")) {
    const bits = part.trim().split(/\s+as\s+/);
    imported.add((bits[1] || bits[0]).trim());
  }
}

// כל פונקציית מתג ומה שהיא קוראת
const fns = [...src.matchAll(/export (?:async )?function (fetch\w+)/g)].map((m) => m[1]);
console.log(`נמצאו ${fns.length} מסלולים במתג\n`);

for (const fn of fns) {
  const start = src.indexOf(`function ${fn}`);
  const body = src.slice(start, src.indexOf("\n}", start));

  // ⚠️ הזרוע דרך השרת מזוהה לפי `if (!useDirect)`. מסלול בלעדיה אינו מתג
  // אלא קריאה ישירה שמתחזה לאחד — והמתג היה נשבר בלי שאיש יבחין.
  say(body.includes("useDirect"), `${fn}: יש בדיקת useDirect`);

  // כל מזהה שנקרא כפונקציה בתוך הגוף חייב להיות מיובא או מוגדר בקובץ
  for (const m of body.matchAll(/\b(fetch\w+|compute\w+)\s*\(/g)) {
    const name = m[1];
    if (name === fn) continue;
    const known = imported.has(name)
      || new RegExp(`(function|const)\\s+${name}\\b`).test(src);
    say(known, `${fn}: ${name} ${known ? "מוגדר" : "**אינו מיובא ואינו מוגדר**"}`);
  }
}

console.log(`\n${"=".repeat(60)}`);
if (fail) {
  console.log(`❌ ${fail} בעיות — אחת מזרועות המתג לא תרוץ`);
  process.exit(1);
}
console.log("✅ שתי הזרועות שלמות בכל המסלולים");
process.exit(0);
