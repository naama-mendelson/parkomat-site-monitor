// tests/health-exposure.test.js — מה /health מספר, ולמי.
//
// ============================================================
// ⚠️ הנתיב הזה שינה מעמד בלי ששורת קוד בו השתנתה
// ============================================================
// עד Cloudflare Tunnel הוא היה מוגן ברשת: פורט מקומי בלבד. מרגע
// שהדשבורד מוגש דרך Cloudflare, גם /health מוגש — לכל האינטרנט.
//
// אין בו נתונים עסקיים, ולכן זו אינה דליפה חמורה. אבל "מתי הקליטה למטה"
// הוא בדיוק המידע שמועיל למי שמנסה לזייף הודעות MQTT, והצירוף בין
// הממצא ההוא לזה אינו מקרי.
//
// ⚠️ **והנתיב לא הוסר, בכוונה.** `fetchServerHealth` בזרוע השרת של המתג
// קוראת לו, וזו דלת היציאה — הסרתו הייתה שוברת אותה בשקט. הלקוח ממילא
// משתמש רק בקוד ה-HTTP, ולכן צמצום הגוף אינו עולה לו דבר.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "api", "routes.js"), "utf8");
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const START = CODE.indexOf('app.get("/health"');
// ⚠️ נחתך עד ההצהרה הבאה ולא עד ה-"});" הראשון: הראשון נמצא **בתוך**
// החסימה לקורא לא מקומי, והפריסה הייתה מסתיימת לפניה.
const NEXT = CODE.slice(START + 1).search(/^(app.|const |function )/m);
const ROUTE = NEXT < 0 ? CODE.slice(START) : CODE.slice(START, START + 1 + NEXT);

test("⚠️ הנתיב עדיין קיים — דלת היציאה תלויה בו", () => {
  assert.ok(START >= 0, "/health הוסר — זרוע השרת של המתג תישבר בשקט");
});

test("⚠️ קורא לא מקומי מקבל סטטוס בלבד", () => {
  assert.match(ROUTE, /loopback/, "אין הבחנה בין קורא מקומי לציבורי");
  const guard = ROUTE.indexOf("if (!loopback)");
  const full = ROUTE.indexOf("uptimeSeconds");
  assert.ok(guard >= 0, "אין חסימה לקורא לא מקומי");
  assert.ok(guard < full, "הפירוט נשלח לפני הבדיקה — כלומר לכולם");
});

test("⚠️ הפירוט אינו דולף דרך כותרת שהלקוח שולט בה", () => {
  // CF-Connecting-IP מגיעה מ-Cloudflare; נוכחותה מוכיחה שהבקשה **אינה**
  // מקומית. בלי הבדיקה הזו, פנייה ישירה עם remoteAddress לולאתי הייתה
  // מקבלת פירוט מלא.
  assert.match(ROUTE, /!req\.headers\["cf-connecting-ip"\]/,
    "loopback אינו שולל בקשה שהגיעה דרך Cloudflare");
});

test("קוד ה-HTTP נשמר בשני המסלולים", () => {
  // הלקוח קורא את res.ok ולא את הגוף — שינוי הקוד היה שובר את הבאנר.
  const codes = (ROUTE.match(/healthy \? 200 : 503/g) || []).length;
  assert.equal(codes, 2, `ציפיתי ל-200/503 בשני המסלולים, נמצאו ${codes}`);
});
