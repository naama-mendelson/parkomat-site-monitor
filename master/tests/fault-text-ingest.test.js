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

// ============================================================
// ⚠️ תווים שאינם יכולים להגיע מבקר ישראלי
// ============================================================
// נמדד בייצור: אתר 1376 הציג תקלה שכל תיאורה היה `珼` (U+73FC). המקור
// ב-FaultTextDecoder בסוכן — רגיסטר מעל 0xFF מוחזר כנקודת קוד יוניקוד
// ישירה. זה כלל **נכון** לבקרים ששולחים עברית כ-1488..1514, אבל רגיסטר
// זבל בערך 0x73FC הופך כך לתו סיני.
//
// ⚠️ ואותו אתר מפיק עברית תקינה ברוב הזמן — כלומר לא אי-התאמת קידוד,
// אלא קריאה מזדמנת מחוצץ שלא נוקה.
test("⚠️ תו זבל יחיד נחתך ל-null ולא מוצג", () => {
  // מפעיל שרואה `珼` בשדה תקלה אינו לומד כלום, ואינו יכול לדעת אם זו
  // תקלה אמיתית עם שם מוזר או קריאה פגומה. שדה ריק אומר את האמת.
  assert.equal(extractFaultText("error", { faultText: "珼" }), null);
});

test("⚠️ זבל בתוך טקסט תקין — הטקסט שורד", () => {
  // חיתוך הכל היה מוחק תיאור אמיתי בגלל בית אחד פגום.
  assert.equal(extractFaultText("error", { faultText: "珼מנהל חניון" }), "מנהל חניון");
});

test("עברית, אנגלית וספרות עוברות ללא שינוי", () => {
  for (const t of [
    "מנהל חניון - דלתות חניון פתוחות:",
    "מיטה 20 - חיישן נגדי נדלק כשמגש שני לא נטען:",
    "Shuttle 1 - overload:",
    "- דלתות חניון פתוחות:",
  ]) {
    assert.equal(extractFaultText("error", { faultText: t }), t);
  }
});

test("⚠️ null ולא מחרוזת ריקה", () => {
  // המסד מבדיל בין 'לא נקרא' (NULL) ל'נקרא והיה ריק' (''). מחרוזת ריקה
  // הייתה טוענת שהבקר נשאל והחזיר כלום — טענה שאינה נכונה כאן.
  assert.equal(extractFaultText("error", { faultText: "珼" }), null);
  // ⚠️ אבל רווחים בלבד נשארים '' ולא null — הבקר **כן** נקרא.
  assert.equal(extractFaultText("error", { faultText: "   " }), "");
});
