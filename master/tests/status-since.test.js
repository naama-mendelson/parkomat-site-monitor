// tests/status-since.test.js — מתי "המצב השתנה", כשהתחזוקה ידנית.
//
// ============================================================
// ⚠️ הבאג: התווית ממקור אחד, הזמן ממקור אחר
// ============================================================
// כשיש חלון תחזוקה ידני פעיל, הסטטוס נדרס ל-'maintenance'. אבל
// `statusSince` המשיך להגיע מהמקטע הפתוח **של הבקר**, שהוא בדרך כלל
// ready או operating ופתוח כבר שעות.
//
// ⚠️ נמדד באתר 1348: מקטע ready פתוח מ-05:00, חלון תחזוקה נפתח ב-08:06,
// והכרטיס הציג **"המצב השתנה לבתחזוקה — לפני 3 שעות"** על חלון בן שתי
// דקות.
//
// ⚠️ וזה סוג התקלה הגרוע: המספר נראה כמו נתון אמיתי. אין שגיאה, אין
// ערך חסר — רק זמן שגוי, שמי שקורא אותו מסיק ממנו מסקנה תפעולית.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SERVER = fs.readFileSync(path.join(ROOT, "db", "queries.js"), "utf8");
const DIRECT = fs.readFileSync(
  path.join(ROOT, "..", "dashboard", "src", "services", "sitesDirect.js"), "utf8");

// הלוגיקה עצמה, כפי ששתי הזרועות מיישמות אותה.
const resolve = (inMaintenance, windowStart, segmentStart) =>
  inMaintenance ? (windowStart ?? segmentStart ?? null) : (segmentStart ?? null);

test("בתחזוקה ידנית — הזמן הוא של החלון", () => {
  const seg = "2026-08-25T05:00:05.000Z";
  const win = "2026-08-25T08:06:17.759Z";
  assert.equal(resolve(true, win, seg), win, "הוצג זמן המקטע במקום זמן החלון");
});

test("לא בתחזוקה — הזמן נשאר של מקטע הבקר", () => {
  const seg = "2026-08-25T07:34:32.000Z";
  assert.equal(resolve(false, null, seg), seg);
});

test("⚠️ חלון בלי חותמת — נופלים למקטע ולא ל-null", () => {
  // null היה מוחק את השורה מהכרטיס לגמרי. זמן פחות מדויק עדיף על היעדר זמן.
  const seg = "2026-08-25T05:00:05.000Z";
  assert.equal(resolve(true, null, seg), seg);
});

test("⚠️ שתי הזרועות מיישמות את הכלל — לא רק אחת", () => {
  // הזרוע השנייה היא דלת היציאה. תיקון בצד אחד בלבד מייצר שני מסכים
  // שמראים זמן שונה לאותו אתר, לפי ערך של משתנה סביבה.
  assert.match(SERVER, /statusSince: inMaintenance/,
    "זרוע השרת עדיין לוקחת את הזמן מהמקטע");
  assert.match(SERVER, /activeMaintenance\?\.started_at/,
    "זרוע השרת אינה קוראת את תחילת החלון");

  assert.match(DIRECT, /statusSince: inMaintenance/,
    "הזרוע הישירה עדיין לוקחת את הזמן מהמקטע");
  assert.match(DIRECT, /maintenance_started_at/,
    "הזרוע הישירה אינה קוראת את תחילת החלון");
});
