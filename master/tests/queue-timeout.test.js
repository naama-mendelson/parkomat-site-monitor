// tests/queue-timeout.test.js — משימה תקועה לא חוסמת אתר לנצח.
//
// ============================================================
// ⚠️ מה נמדד בשטח, ולמה זה נבנה
// ============================================================
// תור הקליטה הוא שרשרת Promise **לכל קוד אתר**. משימה שאינה נפתרת עוצרת
// את האתר הזה לנצח: כל הודעה עתידית ממתינה לה, ואתרים אחרים ממשיכים
// כרגיל — כלומר אתר אחד משתתק לגמרי בזמן שהמסך נראה בריא.
//
// **נמדד ב-22–23.08:** אתר 1284 הפסיק להיקלט לחלוטין במשך שעות, בעוד
// 1343, 1416 ו-3456 זרמו באותן דקות. `last_seen` שלו קפא, ואף מנגנון לא
// התלונן.
//
// ⚠️ שני דברים נבדקים כאן, והשני נסתר: מלבד השחרור עצמו, דחייה בתור
// יוצרת Promise-העתק ב-`finally` שאיש אינו מחזיק — כלומר
// `unhandled rejection`, שב-Node מפיל את התהליך. עד שהייתה תקרה זה היה
// רדום; מרגע שיש תקרה זה צפוי.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const MASTER = path.join(__dirname, "..", "master.js");

test("⚠️ קיימת תקרת זמן למשימה בתור", () => {
  const src = fs.readFileSync(MASTER, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  assert.match(src, /TASK_TIMEOUT_MS\s*=\s*[\d_]+/, "אין תקרת זמן — משימה תקועה חוסמת אתר לנצח");
  assert.match(src, /Promise\.race/, "התקרה אינה מיושמת עם race");

  // ⚠️ התקרה חייבת להיות **נדיבה**: handleMessage מנסה 5 פעמים עם backoff
  // מעריכי (~7.75ש' בסך הכול) ובכל ניסיון כותב מול ה-pooler של Supabase,
  // שנמדד כמתנתק מיוזמתו. תקרה צמודה הופכת עומס חולף לאובדן הודעות —
  // כלומר ההגנה נעשית התקלה.
  const ms = Number((src.match(/TASK_TIMEOUT_MS\s*=\s*([\d_]+)/) || [])[1]?.replace(/_/g, ""));
  assert.ok(ms >= 30_000, `התקרה ${ms}ms צמודה מדי — 5 ניסיונות עם backoff לוקחים שניות`);
});

test("⚠️ הטיימר מקבל unref — אחרת התהליך לא נסגר ב-SIGTERM", () => {
  const src = fs.readFileSync(MASTER, "utf8");
  const guard = src.slice(src.indexOf("function withTimeout"), src.indexOf("function enqueue"));
  assert.match(guard, /unref/, "טיימר תלוי מחזיק את התהליך חי, ו-SIGTERM נגמר ב-SIGKILL");
  assert.match(guard, /clearTimeout/, "הטיימר אינו מנוקה — נזילה בכל הודעה");
});

test("⚠️ דחייה בשרשרת אינה מפילה את ההודעות הבאות מאותו אתר", () => {
  const src = fs.readFileSync(MASTER, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const fn = src.slice(src.indexOf("function enqueue"));

  // ⚠️ בלי catch על `previous`, משימה שנדחתה הופכת את השרשרת ל-rejected
  // וכל `then` שנתלה עליה אחריה יורש את הדחייה — כשל אחד היה מפיל את כל
  // התור של האתר.
  assert.match(fn, /previous\s*\.catch\(|previous\.catch\(/,
    "אין catch על החוליה הקודמת — דחייה אחת מפילה את כל התור של האתר");

  // ⚠️ וה-catch על ה-finally: הוא יוצר Promise חדש שיורש את הדחייה ואיש
  // אינו מחזיק אותו → unhandled rejection.
  assert.match(fn, /\.finally\([\s\S]*?\}\)\s*\.catch\(/,
    "ה-finally של הניקוי אינו מטופל — unhandled rejection מפיל את התהליך");
});

test("⚠️ הדחייה מוחזרת לקורא ולא נבלעת", () => {
  // המנוי הוא זה שרושם ל-ingest_drops ומאשר. `enqueue` שהיה בולע את
  // הדחייה היה מחזיר "הצלחה" על הודעה שלא עובדה — כלומר בדיוק הבאג
  // שתוקן ב-state-handler, במקום אחר.
  const src = fs.readFileSync(MASTER, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const fn = src.slice(src.indexOf("function enqueue"), src.indexOf("async function drainQueues"));
  assert.match(fn, /return next;/, "enqueue אינו מחזיר את ה-Promise — הכשל לא יגיע למנוי");
});

// ============================================================
// ⚠️ ומעל הכול — בדיקה **התנהגותית**, לא מבנית
// ============================================================
// ארבע הבדיקות שלמעלה קוראות טקסט. הן יכולות לעבור בזמן שההתנהגות
// שבורה — למשל `Promise.race` שנכתב נכון אבל על ה-Promise הלא נכון.
//
// ⚠️ **הפונקציה מחולצת מהמקור ומורצת כמות שהיא**, ולא משוכפלת לכאן. העלאת
// master.js אמיתי הייתה תופסת את נעילת המופע היחיד ומתחברת ל-HiveMQ —
// כלומר בדיקה שמתנגשת בייצור. ועותק שני של הלוגיקה היה בודק את העותק.
//
// התקרה מוחלפת ל-400ms: אותה התנהגות בדיוק, בלי להמתין דקה וחצי.
function loadEnqueue() {
  const src = fs.readFileSync(MASTER, "utf8");
  const body = src.slice(src.indexOf("const TASK_TIMEOUT_MS"), src.indexOf("async function drainQueues"))
    .replace(/TASK_TIMEOUT_MS = [\d_]+/, "TASK_TIMEOUT_MS = 400");
  // eslint-disable-next-line no-new-func
  return new Function(`const queues = new Map();\n${body}\nreturn { enqueue, queues };`)();
}

test("⚠️ משימה תקועה משוחררת, וההודעה הבאה מאותו אתר עוברת", async () => {
  const { enqueue, queues } = loadEnqueue();

  let stuckStarted = false;
  const stuck = enqueue("sites/1284/state", () => {
    stuckStarted = true;
    return new Promise(() => {});   // לעולם לא נפתרת
  });
  let stuckRejected = false;
  stuck.catch(() => { stuckRejected = true; });

  let secondRan = false;
  const second = enqueue("sites/1284/state", async () => { secondRan = true; });

  let otherRan = false;
  await enqueue("sites/3456/state", async () => { otherRan = true; }).catch(() => {});

  // ⚠️ אתר אחר אינו נחסם — זו התכונה שהתור נבנה בשבילה, ואסור לתקרה
  // לשבור אותה.
  assert.equal(otherRan, true, "אתר אחר נחסם בגלל התקועה");
  assert.equal(stuckStarted, true, "המשימה התקועה לא התחילה בכלל");

  // לפני התקרה: ההודעה השנייה **חייבת** להמתין. סדר FIFO לכל אתר הוא
  // כלל נכונות (ראה ההערה על התור ב-master.js), לא אופטימיזציה.
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(secondRan, false, "ה-FIFO נשבר — הודעה עקפה משימה שרצה");

  await new Promise((r) => setTimeout(r, 700));
  assert.equal(stuckRejected, true, "התקועה לא נדחתה — האתר חסום לנצח");
  assert.equal(secondRan, true, "התור לא שוחרר — ההודעה הבאה עדיין תקועה");

  await second.catch(() => {});
  assert.equal(queues.size, 0, "התור לא התנקה — המפה גדלה לנצח");
});
