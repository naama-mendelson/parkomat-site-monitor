// scripts/check-name-fit.mjs — סדר הוויתורים בשם האתר.
//
// ============================================================
// ⚠️ למה בדיקה התנהגותית ולא מבנית
// ============================================================
// `check-cards` יכול לוודא שהקוד **מזכיר** פסיק ומקטין פונט. הוא לא יכול
// לוודא שהסדר ביניהם נכון — וזו כל הבקשה: "רק אם אין ברירה תקטין, ועדיף
// שאם אין מקום תסתיר את מה שאחרי הפסיק".
//
// לכן ההחלטה הוצאה ל-`pickName`, פונקציה טהורה שמקבלת פונקציית מדידה
// מוזרקת. אותו דפוס כמו WatchdogPolicy ו-RestartPolicy בסוכן: הלוגיקה
// שאפשר לטעות בה מופרדת מה-DOM שאי אפשר לבדוק.
//
//   node scripts/check-name-fit.mjs
import { pickName } from "../src/hooks/useFitName.js";

let failures = 0;
const results = [];

function check(label, ok, detail = "") {
  results.push({ label, ok, detail });
  if (!ok) failures++;
}

// מדידה מדומה: כל תו ברוחב 10 פיקסלים. פשוטה, ולכן קל לחשב מה אמור לקרות.
const W = 10;
const measure = (t) => t.length * W;

const FULL = 'עמנואל הרומי 10 , ת"א';        // 21 תווים ⇒ 210px
const SHORT = "עמנואל הרומי 10";              // 15 תווים ⇒ 150px

// ---------- 1. יש מקום — לא נוגעים בכלום ----------
{
  const r = pickName(FULL, 250, measure);
  check("יש מקום → השם המלא, בגודל מלא",
    r.text === FULL && r.scale === 1, JSON.stringify(r));
}

// ⚠️ בדיוק על הגבול — חייב להיחשב "נכנס". `<` במקום `<=` היה מקצר שם
// שנכנס בול, כלומר מוותר על מידע בלי סיבה.
{
  const r = pickName(FULL, 210, measure);
  check("נכנס בדיוק → עדיין השם המלא", r.text === FULL && r.scale === 1);
}

// ---------- 2. אין מקום → מורידים את מה שאחרי הפסיק ----------
{
  const r = pickName(FULL, 160, measure);
  check("אין מקום לשם המלא → יורד מה שאחרי הפסיק, בלי להקטין",
    r.text === SHORT && r.scale === 1, JSON.stringify(r));
}

// ⚠️ **הטענה המרכזית של כל הקובץ.** גרסה שמקטינה מיד עוברת את כל
// הבדיקות האחרות ונופלת רק כאן: יש רוחב שבו הקיצור מספיק, והפונט
// חייב להישאר מלא.
{
  const r = pickName(FULL, 150, measure);
  check("⚠️ הקיצור מספיק בדיוק → הפונט נשאר מלא, לא מוקטן",
    r.text === SHORT && r.scale === 1, `scale=${r.scale}`);
}

// ---------- 3. גם הקיצור לא נכנס → רק אז מקטינים ----------
{
  const r = pickName(FULL, 120, measure);
  check("גם המקוצר לא נכנס → מקטינים, על המקוצר",
    r.text === SHORT && r.scale < 1, JSON.stringify(r));
  check("וההקטנה מספיקה כדי שייכנס",
    r.text.length * W * r.scale <= 120);
}

// ---------- שם בלי פסיק — אין מה לקצר ----------
{
  const noComma = "יוחנן הורקנוס 3 תל אביב";   // 23 תווים
  const r = pickName(noComma, 100, measure);
  check("שם בלי פסיק ואין מקום → מקטינים את השם המלא",
    r.text === noComma && r.scale < 1, JSON.stringify(r));
}

// ---------- הרצפה ----------
{
  const r = pickName(FULL, 10, measure, 0.62);
  check("רוחב אבסורדי → ההקטנה נעצרת ברצפה ולא מתאפסת", r.scale === 0.62);
}

// ⚠️ הקיצור לא יוצר מחרוזת ריקה: שם שמתחיל בפסיק היה מקוצר ל-"" והכרטיס
// היה מציג כותרת ריקה — גרוע מכל חיתוך.
{
  const r = pickName(", ת\"א", 20, measure);
  check("שם שמתחיל בפסיק → לא מקוצר לכלום", r.text.length > 0, JSON.stringify(r));
}

// ---------- מקרי קצה ----------
check("שם ריק אינו מפיל", pickName("", 100, measure).text === "");
check("רוחב 0 (אלמנט מוסתר) אינו מפיל ואינו מקטין",
  pickName(FULL, 0, measure).scale === 1);

console.log("=".repeat(60));
for (const r of results) {
  console.log(`  ${r.ok ? "✅" : "❌"} ${r.label}${r.detail ? "   " + r.detail : ""}`);
}
console.log("=".repeat(60));
if (failures) {
  console.log(`❌ ${failures} בדיקות נכשלו`);
  process.exit(1);
}
console.log("✅ סדר הוויתורים: שם מלא → בלי העיר → ורק אז הקטנה");
