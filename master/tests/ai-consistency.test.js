// tests/ai-consistency.test.js — שני כשלים בבוט שלא מייצרים שגיאה.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");


// ============================================================
// ⚠️ קוד אתר הוא מילה, לא תת-מחרוזת
// ============================================================
// כל קודי האתרים הם ארבע ספרות. `q.includes(code)` קשר "כרטיס 1284"
// לאתר 1284 — והבוט ענה **נתונים נכונים על האתר הלא נכון**. זו התשובה
// הגרועה ביותר האפשרית: לא שגיאה, ולא "לא הבנתי".
const CHAT = read("ai", "chat.js");
const siteFromText = new Function(
  `${(CHAT.match(/^const norm = [\s\S]*?;$/m) || [""])[0]}
   ${(CHAT.match(/^function siteFromText\(t, sites\)[\s\S]*?^\}/m) || [""])[0]}
   return siteFromText;`,
)();

const SITES = [
  { id: 1, code: "1284", site_name: "ויצמן 93-97 , ת\"א" },
  { id: 2, code: "1343", site_name: "סוקולוב 10 , בת-ים" },
  { id: 3, code: "3456", site_name: "חולדה 4 , ת\"א" },
];

test("⚠️ מספר כרטיס אינו קוד אתר", () => {
  assert.equal(siteFromText("כרטיס 1284 מפיל את האתר", SITES), null);
  assert.equal(siteFromText("card 1343 keeps failing", SITES), null);
  assert.equal(siteFromText("כרטיס מספר 3456 תקוע", SITES), null);
});

test("⚠️ קוד בתוך מספר ארוך יותר אינו התאמה", () => {
  assert.equal(siteFromText("תתקשר ל-0501284999", SITES), null);
  assert.equal(siteFromText("הודעה 11284", SITES), null);
});

test("קוד אמיתי עדיין נתפס — התיקון לא סגר את התכונה", () => {
  assert.equal(siteFromText("מה קורה באתר 1284?", SITES).id, 1);
  assert.equal(siteFromText("1343", SITES).id, 2);
  assert.equal(siteFromText("תראה לי את חולדה 4 , ת\"א", SITES).id, 3);
  // כרטיס **וגם** אתר באותו משפט: הכרטיס מוסתר, האתר נשאר.
  assert.equal(siteFromText("כרטיס 1284 באתר 3456", SITES).id, 3);
});

test("שני אתרים במשפט = לא חד-משמעי", () => {
  assert.equal(siteFromText("השווה את 1284 מול 1343", SITES), null);
});


// ============================================================
// ⚠️ ההיסטוריה חייבת להכיל בדיוק את הכלים שנענו
// ============================================================
// הודעת assistant עם tool_calls חייבת להיות מלווה בהודעת tool לכל
// tool_call_id. כלי שדולג בגלל JSON פגום נשאר ב-raw ולא קיבל תשובה,
// ולכן ההודעה **הבאה** בשיחה נכשלה — צעד אחד אחרי הסיבה.
const GROQ = read("ai", "providers", "groq.js");

test("⚠️ raw.tool_calls מסונן יחד עם המפוענחים", () => {
  const src = GROQ.replace(/^\s*\/\/.*$/gm, "");

  assert.ok(
    !/tool_calls:\s*rawToolCalls\b/.test(src),
    "raw מקבל את **כל** הקריאות, כולל זו שדולגה",
  );
  assert.match(src, /rawKept|kept\.has/,
    "אין סינון של raw לפי מה ששרד את הפענוח");

  // הסדר חייב להישמר: raw נבנה **אחרי** הפענוח, אחרת אין לפי מה לסנן.
  const iParse = src.indexOf("parseToolCalls(rawToolCalls)");
  const iRaw = src.indexOf("raw.tool_calls =");
  assert.ok(iParse !== -1 && iRaw !== -1 && iParse < iRaw,
    "raw.tool_calls נבנה לפני הפענוח");
});
