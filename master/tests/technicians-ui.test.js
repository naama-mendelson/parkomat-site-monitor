// tests/technicians-ui.test.js — החלון "צא ל:" בכרטיס הטכנאי (21/10/2026): חיפוש האתר "פחות או יותר" (utils/siteSearch.js)
// והרשימה בלי חיפוש (dispatchSites). ההחלטות על השליחה עצמה — במסד (technicians.test.js); כאן רק מה שהמסך מציע.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchSites, dispatchLine, techByPlate } from "../../dashboard/src/utils/technicians.js";
import { editDistance, looseText, matchScore, searchSites, siteKey, skel } from "../../dashboard/src/utils/siteSearch.js";

// שמות בצורה של הייצור (קיצורים, גרשיים כפולים, טווחים) — רחובות ציבוריים, לא נתונים מסמך
const SITES = [
  { id: 1, code: "1227", site_name: "הרצל 50, ת\"א", status: "ready" },
  { id: 2, code: "1373", site_name: "מזאה 63-65, ת''א", status: "error" },
  { id: 3, code: "1400", site_name: "שנקין 74, תל אביב", status: "ready" },
  { id: 4, code: "2431", site_name: "רחובות הנהר 18, ר''ג", status: "ready" },
  { id: 5, code: "1206", site_name: "מתיתיהו הכהן הגדול 9, ת\"א", status: "ready" },
  { id: 6, code: "1102", site_name: "הרצל 5, ראשל\"צ", status: "ready" },
  { id: 7, code: "1355", site_name: "ז'בוטינסקי 33, רמת גן", status: "ready" },
  { id: 8, code: "MX-007", site_name: "יפת 117, יפו", status: "no_comm", monitored: false },
  { id: 9, code: "3468", site_name: "פלורנטין, ת\"א", status: "ready" },
];
const keys = SITES.map(siteKey);
const codes = (q) => searchSites(SITES, keys, q).map((r) => r.site.code);

test("נרמול: גרשיים, אותיות סופיות, מקפים; שלד בלי י/ו וא/ה בסוף", () => {
  assert.equal(looseText("ת\"א"), "תא");
  assert.equal(looseText("ר''ג"), "רג");
  assert.equal(looseText("מזאה 63-65"), "מזאה 63 65");
  assert.equal(looseText("רמת גן"), "רמת גנ");
  assert.equal(skel("שינקין"), skel("שנקין"));
  assert.equal(skel("וילנא"), skel("וילנה"));
  assert.equal(skel("וי"), "וי", "מילה שכולה י/ו נשארת כמו שהיא");
  assert.equal(editDistance("הרצלל", "הרצל"), 1);
  assert.equal(editDistance("שנקני", looseText("שנקין")), 1, "החלפת שתי אותיות סמוכות = טעות אחת");
  assert.equal(editDistance("אבג", "אבגדהו"), 3);
});

test("קוד: מדויק קודם, אחריו קוד שמתחיל; ספרות לא 'מוכלות' באמצע מספר", () => {
  assert.equal(codes("1227")[0], "1227");
  assert.deepEqual(codes("14"), ["1400"], "קוד שמתחיל ב-14 — ולא 'מכיל 14'");
  assert.deepEqual(codes("12"), ["1227", "1206"], "שני הקודים שמתחילים ב-12 — לפי השם (הרצל לפני מתיתיהו)");
  assert.ok(!codes("12").includes("2431"), "2431 לא מתחיל ב-12");
  assert.equal(codes("mx-007")[0], "MX-007", "קוד עם אותיות לטיניות ומקף, בלי רגישות לגודל");
  assert.deepEqual(codes("mx"), ["MX-007"], "חלק מקוד עם אותיות");
  assert.deepEqual(codes("1373 מזאה"), ["1373"], "קוד ושם יחד — הקוד הוא מילה כמו כל מילה");
});

test("שם: תחילת שם, כל המילים בכל סדר, ומספר הבית שמתחיל בספרות", () => {
  assert.deepEqual(codes("הרצל"), ["1102", "1227"], "שווים בציון — לפי השם (הרצל 5 לפני הרצל 50), לא לפי הסדר ברשימה");
  assert.deepEqual(codes("הרצל 50"), ["1227"]);
  assert.deepEqual(codes("50 הרצל"), ["1227"], "סדר המילים לא משנה");
  assert.deepEqual(codes("הרצל 5").sort(), ["1102", "1227"], "5 = מספר בית שמתחיל ב-5 (5, 50)");
  assert.deepEqual(codes("מזאה 63"), ["1373"]);
  assert.deepEqual(codes("מזאה 5"), [], "5 אינו בתוך 65 — מספר בית מתחיל בספרות");
  assert.deepEqual(codes("שנקין 4"), [], "4 אינו בתוך 74");
  assert.deepEqual(codes("הנהר"), ["2431"], "באמצע השם");
  assert.deepEqual(codes("בוטינסקי"), ["1355"], "חלק ממילה, בלי הגרש");
  assert.deepEqual(codes("ז׳בוטינסקי"), ["1355"], "גרש עברי = בלי גרש");
});

test("ערים: קיצור = העיר, בשני הכיוונים", () => {
  assert.deepEqual(codes("הרצל תא"), ["1227"], "תא בלי גרשיים");
  assert.deepEqual(codes("הרצל ת\"א"), ["1227"]);
  assert.deepEqual(codes("הרצל תל אביב"), ["1227"], "שם העיר המלא מוצא את הקיצור");
  assert.deepEqual(codes("שנקין תא"), ["1400"], "הקיצור מוצא את השם המלא");
  assert.deepEqual(codes("הרצל ראשון"), ["1102"], "רשל\"צ = ראשון לציון");
  assert.deepEqual(codes("רחובות רג"), ["2431"]);
  assert.deepEqual(codes("זבוטינסקי רמת גן"), ["1355"]);
});

test("כתיב מלא / חסר וטעות הקלדה אחת — אבל לא הכול מתאים להכול", () => {
  assert.deepEqual(codes("שינקין"), ["1400"], "כתיב מלא מוצא כתיב חסר");
  assert.deepEqual(codes("מתתיהו"), ["1206"], "כתיב חסר מוצא כתיב מלא");
  assert.deepEqual(codes("שנקנ"), ["1400"], "אות אחת חסרה/מוחלפת");
  assert.ok(codes("הרצלל").includes("1227"), "אות כפולה");
  assert.deepEqual(codes("פלורנטינ"), ["3468"]);
  assert.deepEqual(codes("קנדי"), [], "מילה שאין — אין תוצאות");
  assert.deepEqual(codes("הרצל קנדי"), [], "כל מילה חייבת להימצא");
  assert.deepEqual(codes("שנקין 99"), [], "מספר בית שאין");
});

test("הדירוג: קוד מדויק > קוד שמתחיל > תחילת השם > מילים כמו שהן > שלד > טעות", () => {
  const k = siteKey({ code: "1400", site_name: "שנקין 74, תל אביב" });
  const s = (q) => matchScore(k, q);
  assert.ok(s("1400") > s("140"));
  assert.ok(s("140") > s("שנקין 7"));
  assert.ok(s("שנקין 7") > s("74 שנקין"), "תחילת השם קודמת לסדר אחר");
  assert.ok(s("74 שנקין") > s("74 שינקין"), "כמו שהוא קודם לשלד");
  assert.ok(s("74 שינקין") > s("74 שנקפין"), "שלד קודם לטעות");
  assert.ok(s("74 שנקפין") > 0, "טעות אחת עדיין מתאימה");
  assert.equal(s(""), 0);
  assert.equal(s("  ,. "), 0, "רק סימנים — כמו ריק");
});

test("dispatchSites: בלי חיפוש — תקלה, ואז קריאות פתוחות; עם חיפוש — החיפוש הסלחני", () => {
  const calls = { 4: { open: 2 }, 3: { open: 1 }, 8: { open: 1 } };
  assert.deepEqual(dispatchSites(SITES, "", calls).map((s) => s.code),
    // תקלה; ואז 2 קריאות; ואז קריאה אחת — לפי השם (יפת לפני שנקין)
    ["1373", "2431", "MX-007", "1400"]);
  assert.deepEqual(dispatchSites(SITES, "   ", null).map((s) => s.code), ["1373"], "בלי קריאות — רק תקלות");
  assert.deepEqual(dispatchSites(SITES, " ,. ", null).map((s) => s.code), ["1373"], "רק סימנים — כמו בלי חיפוש");
  const shell = [...SITES, { id: 20, code: "9001", site_name: "קפלן 8, ת\"א", status: "error", monitored: false }];
  assert.deepEqual(dispatchSites(shell, "", null).map((s) => s.code), ["1373"], "אתר בלי בקר: \"error\" במסד אינו תקלה");
  assert.deepEqual(dispatchSites(SITES, "שינקין", null, keys).map((s) => s.code), ["1400"]);
  assert.deepEqual(dispatchSites(SITES, "שינקין", null).map((s) => s.code), ["1400"], "בלי מפתחות — נבנים כאן");
  const many = Array.from({ length: 50 }, (_, i) => ({ id: 100 + i, code: String(5000 + i), site_name: `הרצל ${i + 1}, ת"א` }));
  assert.equal(dispatchSites(many, "הרצל").length, 30, "עד 30");
});

test("הכרטיס: הטכנאי לפי מספר הרכב, ושורת המשימה הפתוחה", () => {
  const map = techByPlate([{ id: 1, plate: "7000001", name: "א" }, { id: 2, plate: null, name: "ב" }]);
  assert.equal(map.get("7000001").id, 1);
  assert.equal(map.size, 1, "טכנאי בלי רכב אינו בכרטיס של אף רכב");
  const now = "2026-10-21T08:00:00Z";
  const d = { site_code: "1227", site_name: "הרצל 50, ת\"א", created_at: "2026-10-21T07:42:00Z", created_by: "מנהלת", details: "מעלית 2 תקועה" };
  assert.equal(dispatchLine(d, now), "נשלח 10:42 ע״י מנהלת");
  assert.equal(dispatchLine({ ...d, arrived_at: "2026-10-21T07:58:00Z" }, now), "נשלח 10:42 ע״י מנהלת · הגיע 10:58");
  assert.equal(dispatchLine(null, now), "");
});
