// tests/client-ip.test.js — כתובת הלקוח מאחורי Cloudflare Tunnel.
//
// ============================================================
// ⚠️ הבדיקה הזו נולדה משבירה שקטה שנתפסה לפני שהגיעה לייצור
// ============================================================
// כשנכנסה המנהרה, השרשרת הפכה ל: דפדפן ← Cloudflare ← cloudflared ←
// Caddy ← master. `trust proxy` היה `"loopback"` בלבד, ולכן `req.ip` הפך
// לכתובת הקונטיינר של ה-proxy — **אותה כתובת לכל אדם בחברה**.
//
// שני דברים היו נשברים, ואף אחד מהם אינו מייצר שגיאה:
//   1. **יומן הביקורת.** כל שורה הייתה רושמת 172.x.x.x. ה-IP הוא אחד
//      משני הדברים שעליהם נשענת ההסבה (השני הוא השם) — כלומר חצי
//      ממנגנון האחריות נמחק בשקט.
//   2. **מגבילי הקצב.** שניהם מגבילים לפי IP. אדם אחד שמגיע לתקרה היה
//      חוסם את כל החברה, וזה היה נראה כמו "המערכת תקועה".
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "api", "routes.js"), "utf8");
// ההערות מוסרות לפני החילוץ — הן בעברית ומזכירות את req.ip בהסבר עצמו.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ⚠️ העוזר עצמו **חייב** להכיל req.ip — הוא המקור החלופי. לכן הוא נחתך
// מהקוד לפני הבדיקה. הגרסה הראשונה דרשה "אין req.ip בשום מקום" ונכשלה
// דווקא על התיקון הנכון.
const HELPER = (CODE.match(/function clientIp\(req\)[\s\S]*?^\}/m) || [""])[0];
const REST = CODE.replace(HELPER, "");

test("⚠️ trust proxy מכסה את רשת ה-Docker", () => {
  // בלי uniquelocal (172.16/12), Express אינו סומך על ה-proxy ו-req.ip
  // נשאר כתובת הקונטיינר.
  assert.match(CODE, /trust proxy",\s*\[[^\]]*"uniquelocal"/,
    "trust proxy אינו כולל uniquelocal — req.ip יהיה כתובת ה-proxy לכולם");
  assert.match(CODE, /trust proxy",\s*\[[^\]]*"loopback"/,
    "loopback הוסר — ה-proxy של Vite בפיתוח יישבר");
});

test("⚠️ trust proxy אינו 'סמוך על כולם'", () => {
  // `true` היה מאפשר לכל לקוח לזייף X-Forwarded-For ולעקוף את מגביל הקצב.
  assert.doesNotMatch(CODE, /trust proxy",\s*true/,
    "trust proxy = true — כל לקוח יכול לזייף כתובת ולעקוף את מגביל הקצב");
});

test("⚠️ אין req.ip גולמי מחוץ לעוזר", () => {
  assert.ok(HELPER, "clientIp נעלם");
  assert.doesNotMatch(REST, /\breq\.ip\b/,
    "נשאר req.ip גולמי מחוץ ל-clientIp — הוא יחזיר את כתובת ה-proxy ולא את הלקוח");
});

test("⚠️ העוזר אינו קורא לעצמו", () => {
  // ⚠️ קרה בפועל: החלפה גורפת של req.ip פגעה גם בתוך העוזר והפכה אותו
  // לרקורסיה אינסופית. כל בקשה בלי כותרת Cloudflare הייתה מפילה את
  // השרת, כולל ה-healthcheck של הקונטיינר.
  const calls = (HELPER.match(/clientIp\s*\(/g) || []).length;
  assert.equal(calls, 1, `clientIp מופיע בגוף שלו ${calls} פעמים — רקורסיה`);
  assert.match(HELPER, /return req\.ip/, "אין מקור חלופי ל-req.ip בעוזר");
});

test("clientIp מעדיף את הכותרת ש-Cloudflare מציב", () => {
  // Cloudflare מוחקת ערך שהלקוח שלח ומציבה את שלה, ולכן היא מהימנה מהחוץ.
  assert.match(HELPER, /cf-connecting-ip/, "CF-Connecting-IP אינו נקרא");
  assert.ok(HELPER.indexOf("cf-connecting-ip") < HELPER.indexOf("req.ip"),
    "req.ip נבדק לפני CF-Connecting-IP — הסדר ההפוך מבטל את התיקון");
});

test("⚠️ שני מגבילי הקצב משתמשים ב-clientIp", () => {
  // ⚠️ הגרסה הראשונה של התיקון תפסה רק אחד מהם. השני נמצא רק משום
  // שהפאטץ' דרש בדיוק מופע אחד ונכשל על שניים.
  const limiters = (CODE.match(/const ip = clientIp\(req\);/g) || []).length;
  assert.equal(limiters, 2, `ציפיתי לשני מגבילי קצב עם clientIp, נמצאו ${limiters}`);
});
