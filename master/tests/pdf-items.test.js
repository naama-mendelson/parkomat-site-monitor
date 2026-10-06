// tests/pdf-items.test.js — תיקון הטקסט שנשלף מתסקיר (dashboard/src/utils/pdfItems.js).
//
// ⚠️ סינתטי: הטקסט והמיקומים מומצאים, בצורה של מה שנמדד על תסקיר אמיתי (06/10/2026) —
// "נ" שנשלפה כ-"ð", ומספר שנדבק למילים כי בין הקטעים יש מרווח בעמוד ואין תו רווח.
// שום דבר מתסקיר אמיתי אינו בגיט (המאגר ציבורי).
import { test } from "node:test";
import assert from "node:assert/strict";
import { repairHebrewEncoding, repairItems, addGapSpaces, cleanPastedText, insertCleaned } from "../../dashboard/src/utils/pdfItems.js";

// קטע כמו ש-pdfjs מחזיר: x = קצה שמאלי, רוחב ביחידות העמוד, גופן 9.3
const it = (str, x, w, { y = 210, dir, eol = false, fs = 9.3 } = {}) =>
  ({ str, dir: dir ?? (/[א-ת]/.test(str) ? "rtl" : "ltr"), transform: [fs, 0, 0, fs, x, y], width: w, height: fs, fontName: "f1", hasEOL: eol });
const joined = (items) => items.map((i) => i.str).join("");

test("קידוד 1255: ð בתוך עברית → נ, וכל 27 האותיות באותו מנגנון", () => {
  assert.equal(repairHebrewEncoding("מסומðים"), "מסומנים");
  assert.equal(repairHebrewEncoding("ðושא"), "נושא");
  assert.equal(repairHebrewEncoding("àáâãäåæçèéêëìíîïðñòóôõö÷øùú", "rtl"), "אבגדהוזחטיךכלםמןנסעףפץצקרשת");
});

test("קידוד 1255: לא נוגעים בטקסט לועזי, וקטע בלי מה לתקן חוזר כמו שהוא", () => {
  assert.equal(repairHebrewEncoding("café", "ltr"), "café", "מילה לועזית — לא עברית");
  assert.equal(repairHebrewEncoding("ð", "ltr"), "ð", "בלי עברית ובלי rtl — אין הקשר");
  assert.equal(repairHebrewEncoding("ð", "rtl"), "נ", "קטע rtl של אות אחת");
  const items = [it("יש להחליף", 400, 40), it("3", 390, 4)];
  assert.equal(repairItems(items), items, "אותו מערך כשאין מה לתקן");
  const fixed = repairItems([it("ðורות", 300, 30)]);
  assert.equal(fixed[0].str, "נורות");
});

test("רווח במרווח: '1', 'יש להחליף', '3', 'נורות בכניסה' — מועתקים עם רווחים", () => {
  const items = [it("1", 491.9, 4.1), it("יש להחליף", 451.5, 30), it("3", 444, 4.1), it("נורות בכניסה", 390, 51.5)];
  const out = addGapSpaces(items);
  assert.equal(joined(out), "1 יש להחליף 3 נורות בכניסה");
  // הקטע נמצא במרווח עצמו — לא מזיז אף קטע קיים
  const sp = out[3];   // בין "יש להחליף" ל-"3"
  assert.equal(sp.str, " ");
  assert.equal(sp.transform[4], 448.1);
  assert.ok(Math.abs(sp.width - 3.4) < 1e-9, String(sp.width));
  assert.equal(sp.fontName, "f1", "שכבת הטקסט מחפשת את הגופן לפי השם");
  assert.deepEqual(out.filter((x) => x.str !== " "), items, "הקטעים המקוריים — כמו שהיו");
});

test("אין רווח: מילה שנחתכה ('יו'+'ם', פער אפס), שורה אחרת, סוף שורה, ורווח שכבר קיים", () => {
  assert.equal(joined(addGapSpaces([it("יו", 218.5, 5.7), it("ם", 212.8, 5.7)])), "יום");
  assert.equal(joined(addGapSpaces([it("שורה", 400, 20, { y: 210 }), it("אחרת", 300, 20, { y: 196 })])), "שורהאחרת");
  assert.equal(joined(addGapSpaces([it("סוף", 400, 20, { eol: true }), it("התחלה", 300, 20)])), "סוףהתחלה");
  assert.equal(joined(addGapSpaces([it("כבר ", 400, 20), it("רווח", 300, 20)])), "כבר רווח");
  // פער של פחות מ-15% מהגופן (1.39 ב-9.3) — ריווח אותיות, לא רווח
  assert.equal(joined(addGapSpaces([it("אב", 410, 10), it("גד", 399, 10)])), "אבגד");
  assert.equal(joined(addGapSpaces([it("אב", 410, 10), it("גד", 398.5, 10)])), "אב גד");
});

test("עמודות באותה שורה מקבלות רווח (הפער גדול), וגם ltr אחרי ltr", () => {
  assert.equal(joined(addGapSpaces([it("מסגרת", 310, 30), it("תוך", 236, 20)])), "מסגרת תוך");
  assert.equal(joined(addGapSpaces([it("EN", 100, 10), it("81", 115, 8)])), "EN 81");
});

test("הדבקה: ירידת שורה → רווח (ולא מילים דבוקות), רווחים כפולים מתקפלים, תווים נסתרים נמחקים", () => {
  const LRM = String.fromCharCode(0x200e), RLE = String.fromCharCode(0x202b), PDF_ = String.fromCharCode(0x202c);
  assert.equal(cleanPastedText("יש להחליף את\nהנורה בכניסה"), "יש להחליף את הנורה בכניסה");
  assert.equal(cleanPastedText("  1   יש  להחליף \r\n 3 נורות  "), "1 יש להחליף 3 נורות");
  assert.equal(cleanPastedText(`${RLE}יש${LRM} להחליף${PDF_}`), "יש להחליף");
  assert.equal(cleanPastedText("מסומðים"), "מסומנים", "גם קידוד 1255 שהגיע מהעתקה ממקום אחר");
  assert.equal(cleanPastedText("EN 81-20 café"), "EN 81-20 café", "טקסט לועזי — כמו שהוא");
});

// ---------------------------------------------------------------
// אחרי סקירת קוד (06/10/2026)
// ---------------------------------------------------------------
test("אין רווח כשיש טקסט אחר בתוך המרווח (טבלה: סדר הקטעים אינו סדר המיקום)", () => {
  // a ו-b עוקבים בסדר, אבל c — מוקדם בסדר — יושב באמצע המרווח ביניהם
  const c = it("עמודה", 340, 30);
  const out = addGapSpaces([c, it("ראשון", 400, 30), it("שני", 300, 20)]);
  const coversC = (g) => Math.min(g.transform[4] + g.width, 370) - Math.max(g.transform[4], 340) > 0.5;
  assert.equal(out.filter((x) => x.gapSpace && coversC(x)).length, 0, "רווח מתוח היה מכסה את c ואי אפשר היה לסמן אותו");
  // (בין c ל"ראשון" — שעוקבים ויש ביניהם מרווח אמיתי — רווח כן נכנס)
  assert.equal(out.filter((x) => x.gapSpace).length, 1);
  // ובלי c — יש רווח
  assert.equal(addGapSpaces([it("ראשון", 400, 30), it("שני", 300, 20)]).filter((x) => x.gapSpace).length, 1);
});

test("גודל הגופן מהקנה האנכי: טקסט דחוס אינו מקבל רווחים בין אותיות", () => {
  // קנה אופקי 5, אנכי 10: פער 1.2 הוא 0.12em (בלי רווח) — לפי האופקי היה 0.24em (רווח)
  const nar = (str, x, w) => ({ str, dir: "rtl", transform: [5, 0, 0, 10, x, 210], width: w, height: 10, fontName: "f1", hasEOL: false });
  assert.equal(joined(addGapSpaces([nar("אב", 400, 10), nar("גד", 388.8, 10)])), "אבגד");
});

test("הדבקה: תיקון הקידוד לפי מילה — מילה לועזית ליד עברית לא נוגעים בה", () => {
  assert.equal(cleanPastedText("תקן café ÷ 5 מסומðים"), "תקן café ÷ 5 מסומנים");
});

test("הדבקה באמצע טקסט: רווח הגבול נשמר מול מילה, ולא כפול ולא בקצה השדה", () => {
  assert.deepEqual(insertCleaned("את", 2, 2, "\nהבורג"), { value: "את הבורג", caret: 8 });
  assert.deepEqual(insertCleaned("את ", 3, 3, " הבורג"), { value: "את הבורג", caret: 8 }, "כבר יש רווח — לא שניים");
  assert.deepEqual(insertCleaned("", 0, 0, "  הבורג  "), { value: "הבורג", caret: 5 }, "שדה ריק — בלי רווחים בקצוות");
  assert.deepEqual(insertCleaned("יש להחליף", 2, 2, " את "), { value: "יש את להחליף", caret: 5 });
  assert.deepEqual(insertCleaned("אב", 1, 1, "ג"), { value: "אגב", caret: 2 }, "בלי רווח במקור — לא ממציאים");
});
