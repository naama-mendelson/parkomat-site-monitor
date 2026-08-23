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

// ============================================================
// ⚠️ כל פונקציה מיוצאת — ולא רק `fetch*`
// ============================================================
// הגרסה הראשונה חיפשה `export function fetch\w+`, כלומר **כל הכתיבות היו
// מחוץ לשער**: `startMaintenance`, `cancelMaintenance`, `registerSite`,
// `updateSite`, `deleteSite`. חמישה מסלולים נוספו למתג והשער דיווח ✅ בלי
// לגעת באף אחד מהם.
//
// וזה בדיוק הכשל שהקובץ הזה נבנה למנוע, מכיוון הפוך: לא "זרוע חסרה
// שנתפסה", אלא **מסלול שלם שלא נסרק** — כי מי שהוסיף אותו לא שינה גם את
// הביטוי הרגולרי. הכתיבות הן גם המסלולים שבהם זרוע חסרה מזיקה יותר: קריאה
// שנשברת מציגה מסך ריק, כתיבה שנשברת משאירה מצב שונה במסד.
//
// ⚠️ העזרים בקובץ (`periodBounds`, `dayStartIso`, `prevRange`) **אינם
// מיוצאים**, ולכן הם נופלים מחוץ לרשימה מעצם ההגדרה ולא בזכות סינון.

// ============================================================
// ⚠️ הרחבה: הרכיבים אינם רשאים לעקוף את המתג
// ============================================================
// השער סרק **רק את dataSource.js**, ולכן היה ירוק בזמן שארבע פעולות —
// הזמנת משתמש, מחיקה, אימות קוד המנהל והחלפתו — נכתבו בקבצי *Direct.js
// ויובאו ישירות לרכיבים. VITE_SUPABASE_DIRECT=false החזיר את הקריאות
// והמדדים אבל השאיר את ניהול המשתמשים שבור, ואיש לא ידע.
//
// ⚠️ זה הכשל הגרוע: לא שער אדום שהתעלמו ממנו, אלא **שער ירוק שלא בדק
// כלום** — כי הקוד החדש נכתב מחוץ לתחום שהוא סורק.
//
// הכלל: רכיב מייבא מ-dataSource. ייבוא ישיר מקובץ *Direct הוא עקיפה,
// חוץ ממה שאין לו משמעות בזרוע השרת ולא צריכה להיות לו.
const ALLOWED_DIRECT = new Set([
  // עוזרי דפדפן בלבד — נעילת המושב. אין מקבילה בשרת.
  "isUnlocked", "markUnlocked", "lockAgain",
  // ⚠️ אותו סוג בדיוק: קריאה וכתיבה ל-sessionStorage של הלשונית. זה אינו
  // מסלול נתונים ואין לו צד שרת — "האם המשתמשת נעלה את המסך כאן" היא
  // שאלה על הדפדפן הזה בלבד.
  "isDirectLocked", "setDirectLocked",
  // ⚠️ `reauthenticate` **כן** פונה ל-Supabase, ולכן היא נראית כמו חריגה —
  // אבל היא נקראת רק מהזרוע הישירה. בזרוע השרת הפתיחה היא `unlockByCode`
  // מול `verifyAdminCode`, שעובר במתג כרגיל. שתי דרכי פתיחה לשני מנגנוני
  // הרשאה שונים — ולא מסלול אחד שעוקף.
  "reauthenticate",
  // התראות push: אין זרוע שרת **בכוונה** — השולח אינו יכול להיות המחשב
  // שנופל, וזה בדיוק הרגע שבו ההתראה נחוצה. חריגה מוצהרת ב-EXIT-PLAN.md.
  // ⚠️ isInstalledApp היא בדיקת **סביבה בדפדפן** (display-mode: standalone),
  // לא גישה לנתונים. אין לה מקבילה בשרת ולא צריכה להיות — היא עונה על
  // "האם אני רץ כאפליקציה מותקנת", שאלה שלשרת אין בה שום חלק.
  "isInstalledApp",
  "pushSupported", "pushPermission", "enablePush", "disablePush",
  "getPushSites", "setPushSites", "ensurePushSubscription", "pushCoverage",
  // ⚠️ useSSE מממש את המתג **בעצמו** ובצדק: מנוי חי אינו בקשה, ואי אפשר
  // לעטוף אותו ב-dataSource שכולו פונקציות שמחזירות ערך. שתי הזרועות שם
  // מלאות — Realtime מול EventSource — ונבדקות בסעיף הראשי.
  "subscribeRealtime",
]);

const walkDir = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = dir + "/" + e.name;
  return e.isDirectory() ? walkDir(full) : (/\.jsx?$/.test(e.name) ? [full] : []);
});

const SRC_DIR = path.resolve(__dirname, "../../dashboard/src");
const bypass = [];
for (const file of walkDir(SRC_DIR)) {
  if (/[\\/]services[\\/]/.test(file)) continue;   // השכבה עצמה רשאית
  const text = fs.readFileSync(file, "utf8");
  for (const m of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*["'][^"']*services\/(\w+Direct)["']/g)) {
    const names = m[1].split(",").map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    const bad = names.filter((n) => !ALLOWED_DIRECT.has(n));
    if (bad.length) bypass.push(file.replace(SRC_DIR + "/", "") + " → " + bad.join(", "));
  }
}

if (bypass.length) {
  console.log("❌ רכיבים שעוקפים את המתג:");
  for (const b of bypass) console.log("   " + b);
  console.log("\nכל אחד מהם ייכשל כש-VITE_SUPABASE_DIRECT=false.\n");
  process.exit(1);
}
console.log("✅ אף רכיב אינו עוקף את המתג\n");

const fns = [...src.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]);
console.log(`נמצאו ${fns.length} מסלולים במתג\n`);

for (const fn of fns) {
  const start = src.indexOf(`function ${fn}`);
  const body = src.slice(start, src.indexOf("\n}", start));

  // ⚠️ הזרוע דרך השרת מזוהה לפי `if (!useDirect)`. מסלול בלעדיה אינו מתג
  // אלא קריאה ישירה שמתחזה לאחד — והמתג היה נשבר בלי שאיש יבחין.
  say(body.includes("useDirect"), `${fn}: יש בדיקת useDirect`);

  // כל מזהה שנקרא כפונקציה בתוך הגוף חייב להיות מיובא או מוגדר בקובץ.
  //
  // ⚠️ הזיהוי הוא לפי **מוסכמת השמות של שתי הזרועות** — `…ViaServer` ו-
  // `…Direct` — ולא לפי `fetch`. זה מה שגורם לשער לתפוס גם כתיבות, ולכל
  // מסלול חדש להיכנס אליו בלי לשנות אותו שוב.
  for (const m of body.matchAll(/\b(\w+(?:ViaServer|Direct))\s*\(/g)) {
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
