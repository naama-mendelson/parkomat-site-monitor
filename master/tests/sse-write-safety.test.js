// tests/sse-write-safety.test.js — כתיבת SSE לשקע מת.
//
// ============================================================
// ⚠️ לקוח אחד שסוגר לשונית ברגע הלא נכון מפיל את השרת לכולם
// ============================================================
// `res.write` על חיבור שכבר מת פולט אירוע `error` על ה-response.
// ל-ServerResponse אין מאזין `error` כברירת מחדל, ולכן זה unhandled error
// event — והתהליך יורד. הוא עולה מחדש (restart: unless-stopped), אבל מאבד
// את חיבור ה-MQTT ואת התורים שבזיכרון, וכל הדשבורדים מתנתקים.
//
// המרוץ צר אבל אמיתי: הלקוח מנתק, השקע מת, `req.close` עוד לא נורה —
// ובחלון הזה מגיעה הודעה מאתר ו-bus פולט siteUpdate לכל המנויים.
//
// ⚠️ הבדיקה נעשית על המקור ולא בהרצה: המסלול מוגדר inline בתוך app.get,
// ואי אפשר לקרוא לו בלי להרים שרת. אותה תבנית כמו client-ip.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "api", "routes.js"), "utf8");
// ההערות בעברית מזכירות את res.write בהסבר עצמו — מוסרות לפני החילוץ.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// גוף המסלול, מ-app.get("/api/stream" ועד המסלול הבא.
const START = CODE.indexOf('app.get("/api/stream"');
assert.ok(START !== -1, "מסלול /api/stream לא נמצא");
const END = CODE.indexOf("app.get(", START + 10);
const HANDLER = CODE.slice(START, END === -1 ? undefined : END);


// ⚠️ העוטף עצמו **חייב** להכיל res.write — הוא המקום היחיד שמותר לו,
// ולכן הוא נחתך לפני הבדיקה. אותו סידור כמו clientIp, שם הדרישה "אין
// req.ip בשום מקום" נכשלה דווקא על התיקון הנכון.
const WRAPPER = (HANDLER.match(/const safeWrite = \(chunk\) => \{[\s\S]*?^  \};/m) || [""])[0];
const REST = HANDLER.replace(WRAPPER, "");

test("⚠️ אין res.write חשוף במסלול ה-SSE", () => {
  assert.ok(WRAPPER, "העוטף safeWrite לא נמצא — אי אפשר להפריד אותו מהשאר");
  const bare = REST.match(/res\.write\(/g) || [];
  assert.deepEqual(bare, [],
    `נמצאו ${bare.length} קריאות res.write ישירות — כל אחת מהן יכולה להפיל את התהליך`);
});

test("⚠️ הכתיבה עטופה ב-try/catch ובודקת שהשקע חי", () => {
  assert.match(HANDLER, /safeWrite/, "אין עוטף כתיבה");
  assert.match(HANDLER, /catch\s*\(/, "העוטף אינו תופס חריגה");
  assert.match(HANDLER, /writableEnded|destroyed/,
    "אין בדיקה שהשקע עדיין חי לפני כתיבה");
});

test("⚠️ יש מאזין error — בלעדיו RST מפיל את התהליך בעצמו", () => {
  assert.match(HANDLER, /res\.on\(\s*["']error["']/,
    "אין res.on('error') — שקע שנסגר ב-RST מגיע בלי close");
});

test("⚠️ הניקוי אידמפוטנטי ומשוחרר בכל שלושת המסלולים", () => {
  // close, error, וכישלון כתיבה — כולם יורים על אותו חיבור.
  assert.match(HANDLER, /function cleanup\(\)/, "אין פונקציית ניקוי אחת");
  assert.match(HANDLER, /if \(closed\) return;/, "הניקוי אינו מוגן מקריאה כפולה");

  // ושלושתם מסירים את המאזין ואת ה-interval — אחרת כל ניתוק מדליף עוד אחד.
  assert.match(HANDLER, /removeListener\(\s*["']siteUpdate["']/);
  assert.match(HANDLER, /clearInterval\(pingInterval\)/);

  const cleanupCalls = (HANDLER.match(/cleanup\(\)/g) || []).length;
  assert.ok(cleanupCalls >= 4,
    `cleanup נקרא ${cleanupCalls} פעמים — צפוי לפחות 4 (הגדרה + close + error + כישלון כתיבה)`);
});
