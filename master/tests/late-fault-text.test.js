// tests/late-fault-text.test.js — תיאור תקלה שהגיע באיחור.
//
// ============================================================
// ⚠️ "למה אין טקסט בתקלות" — והתשובה אינה מה שהיה נראה
// ============================================================
// החשד היה שהניקוי בצד השרת הורס טקסט. נמדד, ואינו נכון: טבלת
// ingest_drops מכילה **אפס** שורות `fault_text_unreadable`, והמטענים
// הגולמיים מראים את התמונה האמיתית —
//
//     {"timestamp":1787557040,"state":"error"}                      ← בלי השדה
//     {"timestamp":1787557567,"state":"error","faultText":"מיטה 1…"} ← עם
//     {"timestamp":1787559034,"state":"error"}                      ← בלי
//
// הבקר מחזיק את ה-MODE בכתובת 290 ואת הטקסט בכתובת 2, ואינו כותב אותם
// באותו רגע. הסוכן ממתין לטקסט **שנייה אחת** ואז משדר בלעדיו — כי דיווח
// על תקלה חשוב יותר מהתיאור שלה, ובקר שטרם כתב אינו סיבה לעכב התראה.
//
// ⚠️ אבל עד כה זה היה סוף הסיפור: הטקסט שהבקר כתב רגע אחר כך לא נשלח
// לעולם (המצב לא השתנה), ואם כן נשלח — נבלע כאן כ"אין שינוי".
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const HANDLER = strip(read("ingestion", "state-handler.js"));
const QUERIES = strip(read("db", "queries.js"));


test("⚠️ ענף 'אין שינוי' ממלא תיאור חסר במקום לצאת מיד", () => {
  const i = HANDLER.indexOf("newStatus === site.status");
  assert.ok(i !== -1, "ענף 'אין שינוי' לא נמצא");
  const branch = HANDLER.slice(i, i + 1400);

  assert.match(branch, /fillFaultTextIfMissing/,
    "ההודעה השנייה עדיין נבלעת — התיאור שהגיע באיחור אין לו לאן להיכנס");

  // ⚠️ ומשדרים: הכרטיס מציג את התיאור, ובלעדי השידור הוא נשאר ריק עד
  // הרענון המלא הבא — כלומר בדיוק ברגע שהמידע הכי דחוף.
  assert.match(branch, /bus\.publish/, "המילוי אינו משודר לדשבורד");
});


test("⚠️ הכתיבה נוגעת **רק** במקטע פתוח שאין לו תיאור", () => {
  const fn = (QUERIES.match(/async function fillFaultTextIfMissing[\s\S]*?^}/m) || [""])[0];
  assert.ok(fn, "fillFaultTextIfMissing לא נמצאה");

  assert.match(fn, /ended_at IS NULL/, "עלול לדרוס מקטע שכבר נסגר");
  assert.match(fn, /fault_text IS NULL/,
    "עלול לדרוס תיאור קיים — תיאור נכון שנדרס גרוע מתיאור חסר");
  assert.match(fn, /=\s*'error'/, "עלול להדביק תיאור תקלה למקטע שאינו תקלה");
});


test("⚠️ '' אינו ממלא — הוא תשובה, לא היעדר תשובה", () => {
  const fn = (QUERIES.match(/async function fillFaultTextIfMissing[\s\S]*?^}/m) || [""])[0];
  // NULL = "לא נקרא"; '' = "נקרא והיה ריק". מילוי ב-'' היה מוחק את ההבחנה
  // ונועל את המקטע מפני התיאור האמיתי שעוד עשוי להגיע.
  assert.match(fn, /faultText === ""/,
    "מחרוזת ריקה נכתבת, ובכך נועלת את המקטע מפני התיאור האמיתי");
});


// ============================================================
// הצד השני — הסוכן חייב לשדר שוב כשהטקסט מופיע
// ============================================================
// בלי זה השרת מוכן לקלוט הודעה שלעולם לא נשלחת.
test("⚠️ הסוכן ממשיך לחפש את התיאור ומשדר אותו כשהוא מגיע", () => {
  const W = strip(read("..", "Parkomat.Agent", "src", "Parkomat.Agent.Service", "Worker.cs"));

  assert.match(W, /awaitingLateFaultText/, "אין מעקב אחרי תקלה ששודרה בלי תיאור");
  assert.match(W, /LateFaultTextMaxPolls/,
    "אין תקרה — דגימת 80 רגיסטרים לנצח היא עומס מיותר על הבקר");

  // ⚠️ **רק כשהמצב עדיין תקלה.** אם הבקר התאושש, הטקסט שייקרא עכשיו הוא
  // של תקלה שנגמרה — ושליחתו הייתה מדביקה תיאור שגוי למקטע הבא.
  assert.match(W, /FromMode\(reading\.Mode\)\s*!=\s*SiteState\.Error/,
    "אין בדיקה שהמצב עדיין תקלה לפני השידור המשלים");
});
