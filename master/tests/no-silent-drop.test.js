// tests/no-silent-drop.test.js — הודעה שהגיעה לשרת אינה נעלמת בשקט.
//
// ============================================================
// ⚠️ למה זה חשוב יותר ממה שזה נשמע
// ============================================================
// כל אירוע שנחקר עד היום היה בעל אותה צורה: המסך הציג נתון ישן בביטחון
// מלא, ואיש לא ידע. באג ה-"//" נמצא **רק** משום שהותיר שורה
// ב-ingest_drops. שבע נקודות זריקה נוספות לא הותירו כלום — רק console,
// שנעלם עם הקונטיינר.
//
// ⚠️ ההבחנה: `console.log` אינו עקבה. הוא נמחק בהפעלה מחדש, אינו ניתן
// לשאילתה, ואי אפשר לשחזר ממנו הודעה. שורה ב-ingest_drops שומרת את
// **התוכן המלא** — וזה מה שאיפשר לשחזר 19 הודעות אבודות.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(__dirname, "..", "ingestion");
const FILES = ["dispatcher.js", "state-handler.js"];

const TRACE = /noteDrop|insertSuppressedFault|recordIngestDrop/;
const DISCARD = /console\.(log|warn|error)/;

// ============================================================
// ⚠️ "ללא שינוי" אינו זריקה — ההודעה כן טופלה
// ============================================================
// כשהמצב שהגיע זהה למצב הרשום, אין מה לרשום: המסד כבר מחזיק את האמת.
// הענף מעדכן last_seen — או במכוון לא, ב-no_comm ("ניתוק אינו תצפית") —
// ויוצא. הוא אינו מוחק מידע.
//
// ⚠️ הפטור מנוסח על **הקוד** ולא על מספרי שורות: פטור לפי שורה מתיישן
// בעריכה הראשונה, ואז מכסה בשקט זריקה אמיתית שתזוז למקומו.
const NO_CHANGE = /ללא שינוי|newStatus === site\.status/;

function silentDrops(src) {
  const lines = src.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*return;\s*$/.test(lines[i])) continue;
    const window = lines.slice(Math.max(0, i - 12), i + 1).join("\n");
    // יציאה אחרי הצלחה אינה זריקה — היא מזוהה בכך שאין בה console.
    if (DISCARD.test(window) && !TRACE.test(window) && !NO_CHANGE.test(window)) {
      out.push(i + 1);
    }
  }
  return out;
}

for (const f of FILES) {
  test(`⚠️ ${f} — אין יציאה שמוחקת הודעה בלי עקבה`, () => {
    const bad = silentDrops(fs.readFileSync(path.join(DIR, f), "utf8"));
    assert.deepEqual(bad, [],
      `שורות שיוצאות אחרי console בלי noteDrop: ${bad.join(", ")}. ` +
      "console אינו עקבה — הוא נמחק בהפעלה מחדש ואי אפשר לשחזר ממנו.");
  });
}

test("⚠️ כל סיבת זריקה שמורה, כדי שאפשר יהיה לשאול עליה", () => {
  // הסיבות הן ה-API של הטבלה: מי שחוקר תקלה מסנן לפיהן. סיבה שנעלמת
  // הופכת חקירה עתידית לסריקת טקסט חופשי.
  const all = FILES.map((f) => fs.readFileSync(path.join(DIR, f), "utf8")).join("\n");
  const expected = [
    "site_not_registered", "invalid_state", "unknown_topic",
    "bridge_site_not_registered", "malformed_json", "payload_not_object",
    "state_bad_timestamp", "operation_invalid", "no_comm_rejected",
    "state_late_vs_open_segment", "gave_up_after_retries",
  ];
  const missing = expected.filter((r) => !all.includes(r));
  assert.deepEqual(missing, [], `סיבות זריקה שנעלמו: ${missing.join(", ")}`);
});

test("⚠️ הדיווח עצמו אינו יכול להפיל את הקליטה", () => {
  // noteDrop עטוף ב-try: כשל ברישום הזריקה היה הופך זריקה נקייה לניסיון
  // חוזר, ומשם לסופת retry. נמדד פעם אחת — 8 בדיקות דיספצ'ר קפצו ל-3.8
  // שניות עד שהעטיפה נוספה.
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(DIR, f), "utf8");
    const i = src.indexOf("function noteDrop");
    assert.ok(i >= 0, `${f}: noteDrop נעלם`);
    const body = src.slice(i, src.indexOf("\n}", i));
    assert.match(body, /try/, `${f}: noteDrop אינו עטוף ב-try`);
    assert.match(body, /catch/, `${f}: noteDrop בלי catch`);
  }
});
