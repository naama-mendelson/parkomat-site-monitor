// tests/site-patch.test.js — עדכון הכרטיס מאירוע חי (SSE / Realtime).
//
// ============================================================
// למה זה נבדק, ולמה זה לא היה נבדק עד עכשיו
// ============================================================
// sitePatch הוא הקוד שמעדכן כרטיס **בלי רענון**. הוא רץ עשרות פעמים בשעה
// על מסך שפתוח כל היום, ולא היה עליו אף בדיקה.
//
// ⚠️ והכשל שלו שקט לחלוטין: הוא לא זורק ולא מרנדר שגיאה — הוא פשוט **לא
// מעדכן שדה**, והמסך מציג נתון ישן עד הריענון הבא. זה נתפס רק אם מישהו
// יושב ומסתכל ברגע הנכון.
//
// ============================================================
// הבאג שנתפס כאן
// ============================================================
// תיאור התקלה **לא הוחל בכלל**. תקלה שהגיעה חיה הפכה את הכרטיס ל"מושבת"
// בלי תיאור — כלומר דווקא ברגע שהמידע הכי דחוף, הוא לא היה שם.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

// ============================================================
// טעינת מודול ESM של הדשבורד לתוך בדיקת CommonJS
// ============================================================
// sitePatch.js הוא ESM ואינו תלוי ב-React או ב-DOM — הוא פונקציה טהורה.
// require() של ESM נתמך מ-Node 22.12, בדיוק כמו shared/*.mjs.
const patchPath = path.join(__dirname, "..", "..", "dashboard", "src", "utils", "sitePatch.js");
const hasModule = fs.existsSync(patchPath);

const { applySiteUpdate } = hasModule ? require(patchPath) : {};

const site = (over = {}) => ({
  id: 1, code: "1234", status: "ready",
  last_seen: "2026-08-10T09:00:00.000Z",
  statusSince: "2026-08-10T08:00:00.000Z",
  inMaintenance: false, currentFaultText: null,
  ...over,
});

const ev = (over = {}) => ({
  type: "state", code: "1234", oldStatus: "ready", newStatus: "error",
  occurredAt: "2026-08-10T10:00:00.000Z", ...over,
});

/** מחיל אירוע על אתר יחיד ומחזיר את השורה המעודכנת. */
const apply = (s, e) => applySiteUpdate([s], e)?.[0] ?? s;

test("תקלה עם תיאור — התיאור מוחל מיד, בלי רענון", { skip: !hasModule }, () => {
  const out = apply(site(), ev({ faultText: "E-204 CARD READER TIMEOUT" }));
  assert.equal(out.status, "error");
  assert.equal(out.currentFaultText, "E-204 CARD READER TIMEOUT");
});

test("⚠️ מעבר לתחזוקה **משמר** את התיאור הקיים", { skip: !hasModule }, () => {
  // זה הכלל שהמשתמשת ביקשה במפורש: תקלה ואז תחזוקה מיד אחריה — התיאור
  // חייב להישאר, כדי שיהיה אפשר לדעת במה מטפלים.
  //
  // הודעת המעבר לתחזוקה **אינה נושאת** תיאור, ולכן מחיקה כאן הייתה
  // מוחקת בדיוק את מה שהמשתמשת ביקשה שיישאר.
  const inError = site({ status: "error", currentFaultText: "JAM IN LANE 2" });
  const out = apply(inError, ev({ oldStatus: "error", newStatus: "maintenance" }));

  assert.equal(out.status, "maintenance");
  assert.equal(out.currentFaultText, "JAM IN LANE 2");
});

test("חזרה ל'מוכן' מנקה את התיאור", { skip: !hasModule }, () => {
  // התקלה נגמרה. השארת התיאור הייתה מתארת עבר על כרטיס שמתאר הווה.
  const inError = site({ status: "error", currentFaultText: "SENSOR FAIL" });
  const out = apply(inError, ev({ oldStatus: "error", newStatus: "ready" }));

  assert.equal(out.status, "ready");
  assert.equal(out.currentFaultText, null);
});

test("תקלה חדשה בלי תיאור מנקה תיאור ישן", { skip: !hasModule }, () => {
  // ⚠️ אחרת תקלה חדשה הייתה יורשת את התיאור של הקודמת — שקר שנראה אמין
  // לגמרי, כי הוא טקסט אמיתי מהבקר.
  const old = site({ status: "ready", currentFaultText: "OLD FAULT" });
  const out = apply(old, ev({ newStatus: "error" }));

  assert.equal(out.currentFaultText, null);
});

test("מחרוזת ריקה אינה נחשבת תיאור", { skip: !hasModule }, () => {
  // הבקר נשאל והחזיר ריק. אין מה להציג, ואין להשאיר ישן.
  const old = site({ status: "ready", currentFaultText: "OLD" });
  const out = apply(old, ev({ newStatus: "error", faultText: "" }));

  assert.equal(out.currentFaultText, null);
});

test("no_comm אינו מרענן last_seen — ניתוק אינו צפייה", { skip: !hasModule }, () => {
  // ⚠️ כלל קיים שנשמר: הודעת no_comm מגיעה מהברוקר בשם אתר שהתנתק. אם
  // היא תרענן last_seen, אתר מת ייראה "נצפה זה עתה".
  const before = site();
  const out = apply(before, ev({ newStatus: "no_comm" }));

  assert.equal(out.status, "no_comm");
  assert.equal(out.last_seen, before.last_seen);
});

test("אתר בחלון תחזוקה ידני — תקלה אינה הופכת אותו למושבת", { skip: !hasModule }, () => {
  // כלל קיים: התחזוקה גוברת, בדיוק כמו בשרת.
  const m = site({ inMaintenance: true, status: "maintenance" });
  const out = apply(m, ev({ newStatus: "error" }));

  assert.equal(out.status, "maintenance");
});
