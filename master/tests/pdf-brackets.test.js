// tests/pdf-brackets.test.js — סוגריים בטקסט שמסמנים ומעתיקים מתסקיר
// (dashboard/src/utils/pdfBrackets.js).
//
// ⚠️ המקור: בחלק מהתסקירים pdfjs מחזיר את כל הסוגריים הפוכים — כולל בליקוי עצמו —
// ובאחרים, מתוכנה אחרת, הם תקינים. כאן הבדיקה סינתטית; אותן בדיקות על הטקסט של
// שני תסקירים אמיתיים רצות ב-real-reports.local.test.js, שאינו בגיט (המאגר ציבורי).
import { test } from "node:test";
import assert from "node:assert/strict";
import { bracketSignal, bracketFixer, mirrorBrackets } from "../../dashboard/src/utils/pdfBrackets.js";

const strs = (items) => items.map((it) => it.str);
// מסמך מומצא בצורה של תסקיר שהסוגריים בו הפוכים: עמוד 1 עם ליקוי, עמוד 2 בלי סוגריים בכלל
const REVERSED = [
  { str: "שם מפעל חברה לדוגמה )1234(", dir: "rtl" },
  { str: "1. לתקן את המעקה )בקומה 2-( - לטיפול מיידי", dir: "rtl" },
  { str: "(Deck Locks)", dir: "ltr" },
];
const PAGE2 = [{ str: "חתימת הבודק המוסמך", dir: "rtl" }, { str: "11/11/2026", dir: "ltr" }];
const NORMAL = [{ str: "עומס מותר (משטח) 2.3 טון", dir: "rtl" }, { str: "(בדיקה ראשונה)", dir: "rtl" }];

test("מסמך הפוך: מזוהה, והליקוי מודבק עם הסוגריים במקומם", () => {
  const sig = bracketSignal(REVERSED);
  assert.ok(sig.reversed > 0 && sig.normal === 0, JSON.stringify(sig));
  const fixed = strs(bracketFixer()(1, REVERSED));
  assert.ok(fixed.includes("1. לתקן את המעקה (בקומה 2-) - לטיפול מיידי"), "הליקוי עם הסוגריים במקומם");
  assert.ok(fixed.includes("שם מפעל חברה לדוגמה (1234)"));
  assert.ok(fixed.includes("(Deck Locks)"), "קטע משמאל לימין אינו נוגע");
});

test("מסמך תקין: לא נוגעים בו — אותו מערך בדיוק", () => {
  const sig = bracketSignal(NORMAL);
  assert.ok(sig.normal > 0 && sig.reversed === 0, JSON.stringify(sig));
  assert.equal(bracketFixer()(1, NORMAL), NORMAL);
});

test("עמוד בלי סימנים מקבל את ההחלטה של העמוד שלפניו", () => {
  assert.deepEqual(bracketSignal(PAGE2), { reversed: 0, normal: 0 });
  const fix = bracketFixer();
  const lone = [{ str: "ראה סעיף 9 )", dir: "rtl" }];
  assert.deepEqual(strs(fix(2, lone)), ["ראה סעיף 9 )"], "לפני שנראה עמוד מכריע — כפי שהוא");
  fix(1, REVERSED);
  assert.deepEqual(strs(fix(2, lone)), ["ראה סעיף 9 ("], "אחרי עמוד 1 — מתוקן גם סוגר בודד");
});

test("עמוד שצויר שוב (מעבר הלוך-חזור בתצוגה) נספר פעם אחת", () => {
  const fix = bracketFixer();
  const normal = [{ str: "(א) (ב)", dir: "rtl" }];
  const reversedOnce = [{ str: ")א( )ב(", dir: "rtl" }, { str: ")ג(", dir: "rtl" }];
  fix(1, normal);
  fix(2, reversedOnce);
  // 1 תקין מול 2 הפוכים — הפוך. ציור חוזר של עמוד 1 לא יכול להפוך את ההחלטה.
  for (let i = 0; i < 5; i++) fix(1, normal);
  assert.deepEqual(strs(fix(1, normal)), ["(א) (ב)".replace(/[()]/g, (c) => (c === "(" ? ")" : "("))]);
});

test("רק קטעים מימין לשמאל; אנגלית ומספרים כפי שהם", () => {
  const fix = bracketFixer();
  const items = [{ str: ")מטר(", dir: "rtl" }, { str: "(Deck Locks)", dir: "ltr" }, { str: ")", dir: "ltr" }, { str: "", dir: "rtl" }];
  assert.deepEqual(strs(fix(1, items)), ["(מטר)", "(Deck Locks)", ")", ""]);
});

test("mirrorBrackets מחליף את כל הזוגות", () => {
  assert.equal(mirrorBrackets(")a( ]b[ }c{ >d<"), "(a) [b] {c} <d>");
});
