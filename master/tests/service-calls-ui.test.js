// tests/service-calls-ui.test.js — קריאות ויזנט בדשבורד: הפונקציות הטהורות, והכלל "כבוי עד שהרשימות נטענות".
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const U = pathToFileURL(path.join(__dirname, "../../dashboard/src/utils/serviceCalls.js")).href;
const P = pathToFileURL(path.join(__dirname, "../../dashboard/src/utils/sitePatch.js")).href;

// ⚠️ 14/10/2026: הרשימות נטענו, עשרה סטטוסים סומנו כסגורים וויזנט הדליקו את השליחה — ההצגה דולקת
// כברירת מחדל. העדכון **חזרה** נשאר כבוי: ה-API שלהם חסום מחוץ לישראל ואין לנו כתובת יוצאת קבועה.
test("⚠️ ברירות המחדל: ההצגה דולקת, והעדכון לוויזנט כבוי", async () => {
  const { SERVICE_CALLS_ENABLED, SERVICE_CALLS_WRITE } = await import(U);
  assert.equal(SERVICE_CALLS_ENABLED, true);
  assert.equal(SERVICE_CALLS_WRITE, false, "בורר שנראה עובד ונתקע 15 שניות גרוע מערך לקריאה בלבד");
});

test("countsBySite — לפי site_id, מחבר שורות, מתעלם משורה בלי אתר", async () => {
  const { countsBySite } = await import(U);
  assert.deepEqual(countsBySite([{ site_id: 7, open: 2 }, { site_id: 9, open: "1" }, { site_id: null, open: 5 }, { site_id: 7, open: 1 }]),
    { 7: { open: 3 }, 9: { open: 1 } });
  assert.deepEqual(countsBySite(null), {});
});

test("callerName / openedLabel — שם מלא או '—'; זמן בשעון ישראל; טקסט שאינו תאריך — כמו שהוא; בלי — שעת ההגעה", async () => {
  const { callerName, openedLabel } = await import(U);
  assert.equal(callerName({ first_name: " דנה ", last_name: "כהן" }), "דנה כהן");
  assert.equal(callerName({ first_name: "", last_name: null }), "—");
  assert.equal(openedLabel({ opened_at: "2026-10-13T06:42:00.000Z" }), "13/10 09:42");     // UTC+3
  assert.equal(openedLabel({ opened_at: "13/10/2026 09:42" }), "13/10/2026 09:42");
  assert.equal(openedLabel({ received_at: "2026-01-15T10:05:00.000Z" }), "15/01 12:05");   // חורף, UTC+2
  assert.equal(openedLabel({}), "");
});

test("⚠️ optionsFor — הערך הנוכחי תמיד בבורר, גם כשאינו ברשימה (אחרת הבורר מציג את הראשון כאילו הוא הנוכחי)", async () => {
  const { optionsFor } = await import(U);
  const list = [{ id: 148, name: "פתוחה" }, { id: "151", name: "בטיפול" }];
  assert.deepEqual(optionsFor(list, "151", "בטיפול"), [{ id: "148", name: "פתוחה" }, { id: "151", name: "בטיפול" }]);
  assert.deepEqual(optionsFor(list, "777", null)[0], { id: "777", name: "לא מוכר (777)" });
  assert.deepEqual(optionsFor(list, "777", "שם מהמסד")[0], { id: "777", name: "שם מהמסד" });
  assert.equal(optionsFor(list, null).length, 2);
  assert.deepEqual(optionsFor([], "5", null), [{ id: "5", name: "לא מוכר (5)" }]);
});

test("אירוע service_calls אינו טוען מחדש את רשימת האתרים (App מרענן את הסימון והחלון בלבד)", async () => {
  const { needsRefetch } = await import(P);
  assert.equal(needsRefetch({ type: "service_calls", code: "1307", action: "received" }), false);
});
