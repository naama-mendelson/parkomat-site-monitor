// tests/technicians-ui.test.js — החלון "צא ל:" בכרטיס הטכנאי (21/10/2026): חיפוש האתר "פחות או יותר" (utils/siteSearch.js)
// והרשימה בלי חיפוש (dispatchSites). ההחלטות על השליחה עצמה — במסד (technicians.test.js); כאן רק מה שהמסך מציע.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ackLine, dispatchSites, dispatchLine, techByPlate, techOnSiteBySite, techOnSiteText } from "../../dashboard/src/utils/technicians.js";
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

// 22/10/2026 — הבעלת: "כשטכנאי מאשר את המשימה אני רוצה לראות על הכרטיס שהוא אישר. אם לא — שיראו שעדיין לא אישר".
test("אישר / עוד לא אישר בכרטיס: תמיד כשהמשימה פתוחה; אדום אחרי 3 צפצופים; פירוט הצפצוף מתחת; מסד ישן — כלום", () => {
  const now = "2026-10-21T08:00:00Z";
  const d = { created_at: "2026-10-21T07:40:00Z", push_count: 1, push_last_at: "2026-10-21T07:42:00Z", push_max: 3, push_error: null, acked_at: null };
  assert.deepEqual(ackLine(d, now), { tone: "wait", label: "עוד לא אישר", time: null, detail: "צפצף בטלפון 10:42 (1 מתוך 3)" });
  assert.deepEqual(ackLine({ ...d, acked_at: "2026-10-21T07:43:00Z" }, now), { tone: "ok", label: "✓ אישר", time: "10:43", detail: null });
  assert.deepEqual(ackLine({ ...d, arrived_at: "2026-10-21T07:50:00Z" }, now), { tone: "wait", label: "עוד לא אישר", time: null, detail: null },
    "הגיע בלי לאשר — עדיין 'עוד לא אישר' (עד 22/10 השורה נעלמה), בלי פירוט צפצוף");
  assert.equal(ackLine({ ...d, arrived_at: "2026-10-21T07:50:00Z", acked_at: "2026-10-21T07:43:00Z" }, now).tone, "ok", "אישר קודם — 'אישר'");
  assert.deepEqual(ackLine({ ...d, push_count: 0, push_error: "שירות הצפצוף לא ענה — הצפצוף לא נשלח" }, now),
    { tone: "wait", label: "עוד לא אישר", time: null, detail: "⚠ שירות הצפצוף לא ענה — הצפצוף לא נשלח" });
  assert.deepEqual(ackLine({ ...d, push_count: 3 }, now), { tone: "bad", label: "✕ לא אישר", time: null, detail: "צפצף בטלפון 3 פעמים, בלי תשובה" });
  assert.equal(ackLine({ ...d, push_count: 3, acked_at: "2026-10-21T07:50:00Z" }, now).tone, "ok", "אישר — גם אחרי 3");
  assert.equal(ackLine({ ...d, push_count: 0, push_error: "הטלפון של הטכנאי לא הפעיל צפצוף" }, now).detail, "⚠ הטלפון של הטכנאי לא הפעיל צפצוף",
    "טלפון שלא מחובר לצפצוף — 'עוד לא אישר', והסיבה מתחת");
  assert.deepEqual(ackLine({ ...d, push_count: 0, push_last_at: null }, now), { tone: "wait", label: "עוד לא אישר", time: null, detail: "שולח צפצוף לטלפון…" });
  assert.equal(ackLine({ ...d, push_count: 2, push_max: undefined }, now).detail, "צפצף בטלפון 10:42 (2 מתוך 3)", "בלי push_max — 3");
  assert.equal(ackLine({ created_at: d.created_at }, now), null, "מסד ישן — לא ממציאים 'לא אישר'");
  assert.equal(ackLine({ created_at: d.created_at, acked_at: null }, now).label, "עוד לא אישר", "יש שדה אישור — יודעים");
  assert.equal(ackLine(null, now), null);
});

test("טכנאי באתר בלוח: לפי אתר, השם מהלוח או מהכינוי, מי שהגיע ראשון ראשון; והטקסט של האיקון", () => {
  const rows = [
    { site_id: 9, code: "1227", plate: "1110002", nickname: "דני כהן 1110002", tech: null, since: "2026-10-21T08:20:00Z", no_signal: false },
    { site_id: 9, code: "1227", plate: "1110001", nickname: "אבי 1110001", tech: "אבי לוי", since: "2026-10-21T07:42:00Z", no_signal: false },
    { site_id: 4, code: "1047", plate: "1110003", nickname: "1110003", tech: "  ", since: null, no_signal: true },
    { site_id: null, code: "GONE", plate: "1110004", nickname: "x", tech: "y", since: null },
  ];
  const m = techOnSiteBySite(rows);
  assert.deepEqual([...m.keys()].sort(), [4, 9], "אתר שנמחק (site_id ריק) — לא");
  assert.deepEqual(m.get(9).map((x) => x.name), ["אבי לוי", "דני כהן"], "הראשון שהגיע — ראשון; בלי שיוך — הכינוי בלי המספר");
  assert.deepEqual(m.get(4), [{ name: "1110003", since: null, noSignal: true }], "שם ריק בלוח וכינוי שהוא רק מספר — המספר");
  const NOW = "2026-10-21T09:00:00Z";
  assert.equal(techOnSiteText(m.get(9), NOW), "2 טכנאים באתר: אבי לוי, דני כהן · מ-10:42");
  assert.equal(techOnSiteText([{ name: "אבי לוי", since: "2026-10-21T07:42:00Z" }], NOW), "טכנאי באתר: אבי לוי · מ-10:42");
  assert.equal(techOnSiteText(m.get(4), NOW), "טכנאי באתר: 1110003", "בלי שעה — בלי 'מ-'");
  assert.equal(techOnSiteText([], NOW), "");
  assert.equal(techOnSiteText(null, NOW), "");
  assert.equal(techOnSiteBySite(null).size, 0);
});
