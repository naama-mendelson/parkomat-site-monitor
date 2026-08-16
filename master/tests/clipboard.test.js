// tests/clipboard.test.js — העתקת הסיסמה הזמנית.
//
// ============================================================
// למה זה נבדק בכלל, ולמה כהתנהגות
// ============================================================
// ⚠️ הקוד הקודם היה `navigator.clipboard?.writeText(...)` — והוא היה
// **כלום שקט** בכל כתובת שאינה `localhost` או HTTPS, כי `navigator.
// clipboard` פשוט אינו קיים שם. הלחיצה לא עשתה דבר ולא היה שום סימן.
//
// ⚠️ וזה נפל על הערך היחיד במערכת שמוצג **פעם אחת** ואינו נשמר בשום
// מקום: הסיסמה הזמנית של משתמש חדש. העתקה שנכשלת בשקט שם = משתמש שנוצר
// ואי אפשר להתחבר אליו.
//
// בדיקה שרק מחפשת את המחרוזת "clipboard" בקוד הייתה עוברת גם על הגרסה
// השבורה — היא הייתה שם. לכן כאן נבדקת **התשובה**: האם הפונקציה מודיעה
// נכונה אם ההעתקה קרתה.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const MODULE_URL = pathToFileURL(
  path.join(__dirname, "..", "..", "dashboard", "src", "utils", "clipboard.js")
).href;

/**
 * מחליף את הגלובלים שהמודול נשען עליהם ומחזיר פונקציית שחזור.
 *
 * ⚠️ ב-Node קיים `globalThis.navigator` מובנה והוא לקריאה בלבד, ולכן
 * ההחלפה היא דרך defineProperty ולא השמה. השמה פשוטה הייתה נכשלת בשקט
 * במצב לא-קפדני, והבדיקה הייתה רצה מול ה-navigator של Node.
 */
function stub({ clipboard, execCommand }) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  Object.defineProperty(globalThis, "navigator", {
    value: clipboard ? { clipboard } : {},
    configurable: true,
    writable: true,
  });

  const selected = [];
  globalThis.document = {
    createElement: () => ({
      style: {},
      setAttribute() {},
      select() { selected.push("select"); },
      setSelectionRange() {},
    }),
    body: { appendChild() {}, removeChild() {} },
    execCommand: execCommand ?? (() => false),
  };

  return () => {
    if (saved) Object.defineProperty(globalThis, "navigator", saved);
    else delete globalThis.navigator;
    delete globalThis.document;
  };
}

test("ה-API המודרני עובד → מדווח הצלחה", async () => {
  const restore = stub({ clipboard: { writeText: async () => {} } });
  try {
    const { copyText } = await import(MODULE_URL);
    assert.equal(await copyText("sod123"), true);
  } finally { restore(); }
});

test("⚠️ אין clipboard כלל → נופל ל-execCommand ומדווח הצלחה", async () => {
  // זה **בדיוק** המצב שנשבר: כתובת שאינה secure, כמו http://192.168.x.x.
  const restore = stub({ clipboard: null, execCommand: () => true });
  try {
    const { copyText } = await import(MODULE_URL);
    assert.equal(await copyText("sod123"), true, "חייבת להיות נפילה אחורית");
  } finally { restore(); }
});

test("⚠️ ה-API קיים אך נדחה → עדיין נופל אחורה", async () => {
  // הרשאה שנשללה, או מסמך שאינו ממוקד. בלי ה-catch זו הייתה
  // unhandled rejection, ובלי הנפילה האחורית — כישלון מיותר.
  const restore = stub({
    clipboard: { writeText: async () => { throw new Error("denied"); } },
    execCommand: () => true,
  });
  try {
    const { copyText } = await import(MODULE_URL);
    assert.equal(await copyText("sod123"), true);
  } finally { restore(); }
});

test("⚠️ שום דרך לא זמינה → מחזיר false, ולא זורק", async () => {
  // ההבדל בין הגרסה השבורה לתקינה הוא **כאן**: שתיהן לא מעתיקות,
  // אבל רק זו מודיעה על כך — ולכן המסך יכול לבקש סימון ידני.
  const restore = stub({ clipboard: null, execCommand: () => false });
  try {
    const { copyText } = await import(MODULE_URL);
    assert.equal(await copyText("sod123"), false);
  } finally { restore(); }
});

test("מחרוזת ריקה — אין מה להעתיק", async () => {
  const restore = stub({ clipboard: { writeText: async () => {} } });
  try {
    const { copyText } = await import(MODULE_URL);
    assert.equal(await copyText(""), false);
    assert.equal(await copyText(null), false);
  } finally { restore(); }
});

// ============================================================
// ⚠️ והמסך חייב להשתמש בתשובה — לא רק לקרוא לפונקציה
// ============================================================
// פונקציה שמחזירה false ומתעלמים ממנה שקולה בדיוק לבאג המקורי.
test("⚠️ הפאנל מציג מצב לפי תוצאת ההעתקה", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "..", "dashboard", "src", "components", "UsersPanel", "UsersPanel.jsx"),
    "utf8");

  // ⚠️ **ההערות מוסרות לפני ההשוואה, וזו לא קוסמטיקה.** הבדיקה נפלה על
  // ההערה שמתעדת את הבאג הישן — היא מצטטת `navigator.clipboard?.` כדי
  // להסביר מה נשבר. בדיקת-מקור אינה מבחינה בין קוד לבין תיאור של קוד,
  // ולכן תיעוד טוב היה מפיל אותה. מכאן: משווים מול הקוד בלבד.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")   // כולל הערות JSX — {/* ... */}
    .replace(/^\s*\/\/.*$/gm, "");

  assert.match(code, /copyText\(/, "חייב לעבור דרך העזר המשותף");
  assert.doesNotMatch(code, /navigator\.clipboard\?\./,
    "⚠️ הדפוס שגרם לבאג: קריאה עם ?. שאינה מדווחת כלום");
  assert.match(code, /setCopied\(\s*ok\s*\?/, "התוצאה חייבת להיכנס למצב התצוגה");
  assert.match(code, /selectPassword\(/, "בכישלון — סימון ידני, המסלול שעובד תמיד");
});
