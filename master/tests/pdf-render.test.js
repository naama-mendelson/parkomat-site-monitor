// tests/pdf-render.test.js — הגדרת הציור של ה-PDF בדשבורד (dashboard/src/utils/pdfText.js).
//
// ⚠️ למה בדיקה מבנית על שורה אחת: בלי disableFontFace **כל** תסקיר עברי שנבדק
// (שני תסקירים אמיתיים, משתי תוכנות שונות) צויר משובש — אותיות אחת על השנייה וחלקן חסרות. הגופנים
// המוטמעים (David, Miriam) נושאים הוראות פגומות, ו-Chrome דוחה אותם כ-FontFace.
// התקלה אינה נראית בשום בדיקה אחרת: הטקסט נשלף נכון, התאריכים נקראים, רק
// התמונה שעל המסך שגויה — ובדיוק זו שהאדם מאשר מולה את התאריך.
//
// הוכחה בפיקסלים (06/10/2026): ציור דרך openPdf זהה לציור עם הדגל (0.000%)
// ושונה ב-5% מהציור בלעדיו, בשני התסקירים; הסרת הדגל הפילה את ההשוואה.
// הבדיקה כאן שומרת שהדגל לא יוסר בטעות — היא לא מחליפה את ההוכחה.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../../dashboard/src/utils/pdfText.js", import.meta.url), "utf8");

test("pdfText: getDocument נקרא במקום אחד בלבד", () => {
  // מקום שני היה יכול לפתוח מסמך בלי הדגל — ולצייר שוב משובש
  assert.equal(src.match(/\.getDocument\(/g)?.length, 1);
});

test("⚠️ pdfText: disableFontFace:true בקריאה ל-getDocument", () => {
  const call = src.slice(src.indexOf(".getDocument("), src.indexOf(")", src.indexOf(".getDocument(")) + 1);
  assert.match(call, /disableFontFace:\s*true/, `בלי הדגל התסקירים העבריים מצוירים משובשים:\n${call}`);
});

test("pdfText: isEvalSupported:false נשאר (PDF הוא קלט מבחוץ)", () => {
  const call = src.slice(src.indexOf(".getDocument("), src.indexOf(")", src.indexOf(".getDocument(")) + 1);
  assert.match(call, /isEvalSupported:\s*false/);
});

// ============================================================
// שכבת הטקסט (סימון והעתקה)
// ============================================================
// ההוכחה האמיתית בדפדפן (06/10/2026, רתמת insp/probe-copy): השכבה מכסה את
// האותיות המצוירות, גרירה מסמנת, Ctrl+C → Ctrl+V לשורת ליקוי נותן אותו טקסט.
// כאן — שתי שורות שהסרה שלהן לא תישבר בשום בדיקה אחרת ותיראה רק בעין.
const css = readFileSync(new URL("../../dashboard/src/utils/pdfTextLayer.css", import.meta.url), "utf8");

test("⚠️ שכבת הטקסט עוברת בתיקון הסוגריים לפני TextLayer", () => {
  // בלי זה ליקוי מתסקיר שהסוגריים בו הפוכים מודבק לטופס כ")בקומה 2-(" — ראו pdf-brackets.test.js
  const body = src.slice(src.indexOf("getTextContent().then"), src.indexOf("new pdfjs.TextLayer"));
  assert.match(body, /items:\s*fixItems\(/, body);
});

test("⚠️ שכבת הטקסט: הגובה מיחס העמוד, ו-round() של pdfjs נדרס", () => {
  // pdfjs כותב width/height עם round() — דפדפן ישן מתעלם, ו-pdfjs נשען על
  // משתנה שמוגדר רק בצופה שלו. בלי הדריסה השכבה לא בגודל הקנבס והסימון זז.
  assert.match(css, /width:\s*100%\s*!important/);
  assert.match(css, /height:\s*auto\s*!important/);
  assert.match(src, /style\.aspectRatio\s*=/);
  // הטקסט שקוף — בלי זה הוא מצויר שחור מעל הציור
  assert.match(css, /\.pdf-text span,\s*\n\.pdf-text br\s*\{[^}]*color:\s*transparent/);
});
