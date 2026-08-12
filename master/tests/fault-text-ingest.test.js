// tests/fault-text-ingest.test.js — התפר שבו טקסט מהבקר נכנס למסד.
//
// ============================================================
// למה דווקא כאן
// ============================================================
// שרשרת תיאור התקלה עוברת ארבע תחנות: הבקר → הסוכן → **הקליטה** → הלוג
// והכרטיס. שלוש מהן נבדקות (FaultTextDecoder ב-C#, timeline, sitePatch),
// והאמצעית — זו שמחליטה מה בכלל נכנס למסד — לא הייתה.
//
// ⚠️ וזו התחנה היחידה שמקבלת קלט **מבחוץ**: מחרוזת שנכתבה בבקר בשטח,
// שאיש מאיתנו לא ראה, ושמגיעה דרך MQTT. כל שאר התחנות מעבדות נתון שכבר
// נוקה כאן.

const test = require("node:test");
const assert = require("node:assert/strict");

const { extractFaultText } = require("../ingestion/fault-text");

test("תקלה עם טקסט — נשמר", () => {
  assert.equal(
    extractFaultText("error", { faultText: "E-204 CARD READER TIMEOUT" }),
    "E-204 CARD READER TIMEOUT"
  );
});

test("עברית עוברת שלמה", () => {
  // ⚠️ הבקר מדבר Windows-1255 והסוכן ממיר ליוניקוד. אם משהו בדרך היה
  // חותך בתים במקום תווים, עברית הייתה נשברת בעוד אנגלית עוברת — כלומר
  // בדיקה באנגלית בלבד הייתה מדווחת ירוק.
  assert.equal(
    extractFaultText("error", { faultText: "תקלה בקורא הכרטיסים" }),
    "תקלה בקורא הכרטיסים"
  );
});

test("⚠️ טקסט על מצב שאינו תקלה — נזרק", () => {
  // שורת 'מוכן' עם תיאור תקלה היא מידע שסותר את עצמו.
  for (const status of ["ready", "operating", "maintenance", "no_comm"]) {
    assert.equal(extractFaultText(status, { faultText: "SENSOR FAIL" }), null, status);
  }
});

test("⚠️ null ו-'' אינם אותו דבר", () => {
  // null = לא נקרא (סוכן ישן / בקר בלי התכונה). '' = נקרא והיה ריק.
  // מיזוגם היה מוחק את ההבחנה בין "אין לנו מידע" ל"הבקר לא אמר כלום".
  assert.equal(extractFaultText("error", {}), null, "שדה חסר → null");
  assert.equal(extractFaultText("error", { faultText: "" }), "", "ריק נשאר ריק");
});

test("סוג לא-מחרוזת נדחה ואינו מפיל", () => {
  // מפרסם שגוי (או זדוני) על נושא ה-MQTT. חייב להיבלע בשקט — קליטת
  // המצב עצמו חשובה יותר מהתיאור.
  for (const bad of [null, 42, true, { a: 1 }, ["x"]]) {
    assert.equal(extractFaultText("error", { faultText: bad }), null);
  }
  assert.equal(extractFaultText("error", null), null, "הודעה ריקה לגמרי");
});

test("תקרת 200 תווים נאכפת", () => {
  const out = extractFaultText("error", { faultText: "A".repeat(500) });
  assert.equal(out.length, 200);
});

test("רווחים בקצה מנוקים", () => {
  assert.equal(extractFaultText("error", { faultText: "  JAM IN LANE 2 \r\n" }), "JAM IN LANE 2");
});
