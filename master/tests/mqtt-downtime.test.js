// tests/mqtt-downtime.test.js — הניתוק חייב "להזדקן".
//
// ============================================================
// ⚠️ הבדיקה הזו מגנה על בדיקת הבריאות עצמה
// ============================================================
// mqtt.js פולט `close` **בכל ניסיון חיבור מחדש**, וה-reconnectPeriod הוא
// שנייה. חותם שמתאפס בכל אירוע פירושו ש-downForSeconds() לעולם לא עובר
// ~1 שנייה — גם בניתוק בן שעות.
//
// ⚠️ ואז /health מחזיר 200 לנצח, כי `mqttDown < MQTT_UNHEALTHY_AFTER_SECONDS`
// תמיד מתקיים. ה-HEALTHCHECK ב-Dockerfile בודק בדיוק statusCode===200,
// כלומר הקונטיינר מדווח "בריא" לאורך ניתוק אינסופי — בדיוק כשל
// ה"מגיש דפים ואינו קולט" שהבדיקה נכתבה כדי לתפוס, ושארך 14.7 שעות.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "mqtt", "subscriber.js"), "utf8");
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("⚠️ close אינו מאפס חותם ניתוק קיים", () => {
  const i = CODE.indexOf('client.on("close"');
  assert.ok(i >= 0, "מטפל close נעלם");
  const body = CODE.slice(i, CODE.indexOf("});", i));
  assert.match(body, /disconnectedSince === null/,
    "close מאפס את החותם בכל ניסיון חיבור מחדש — downForSeconds לא יגדל לעולם");
  assert.doesNotMatch(body, /^\s*disconnectedSince = Date\.now\(\);\s*$/m,
    "יש השמה ללא תנאי");
});

test("החיבור המוצלח כן מנקה את החותם", () => {
  // בלי זה, ניתוק אחד היה מסמן את השרת חולה לנצח.
  const i = CODE.indexOf('client.on("connect"');
  assert.ok(i >= 0, "מטפל connect נעלם");
  const body = CODE.slice(i, i + 900);
  assert.match(body, /disconnectedSince = null/, "connect אינו מנקה את החותם");
});

test("⚠️ הסימולציה: עשרה close ברצף — הניתוק עדיין מזדקן", () => {
  // מדמים את הלוגיקה עצמה, לא את הספרייה.
  let disconnectedSince = null;
  const onClose = () => { if (disconnectedSince === null) disconnectedSince = 1000; };
  for (let i = 0; i < 10; i++) onClose();
  const now = 1000 + 4 * 3600 * 1000;              // ארבע שעות אחר כך
  assert.equal(Math.round((now - disconnectedSince) / 1000), 14400,
    "אחרי עשרה close הניתוק חייב להימדד כארבע שעות, לא כאפס");
});
