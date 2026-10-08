// tests/defect-pdf.test.js — מסמך תיקוני הליקויים לבודק המוסמך (08/10/2026): מסמך אחד לכל התיקונים של התסקיר.
//
// שני חלקים: כותב ה-PDF (utils/pdfImages.js) — הקובץ שנוצר נפתח כאן ב-pdfjs, אותו קורא שהדשבורד משתמש
// בו, ונבדק גם מבנית (טבלת ההפניות מצביעה על האובייקטים); ומה שכתוב במסמך ואיך הוא מסודר
// (utils/defectPdf.js — החלק הטהור). הציור עצמו על canvas נבדק בדפדפן (probe-defect-pdf).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { jpegPagesToPdf, pdfTextString, A4_PT } from "../../dashboard/src/utils/pdfImages.js";
import {
  fixesForPdf, summaryFacts, fixFacts, fixesPdfFileName, planPages, wrapWords, clampLines, layoutPhotos, fitContain, ilDay,
} from "../../dashboard/src/utils/defectPdf.js";

const JPEG = new Uint8Array(readFileSync(new URL("./fixtures/defect-pdf/tile-16x12.jpg", import.meta.url)));
const PDFJS = new URL("../../dashboard/node_modules/pdfjs-dist/legacy/build/pdf.mjs", import.meta.url);
const noPdfjs = !existsSync(fileURLToPath(PDFJS)) && "pdfjs-dist אינו מותקן ב-dashboard/node_modules";

// ---------------------------------------------------------------
// כותב ה-PDF
// ---------------------------------------------------------------
test("PDF: טבלת ההפניות מצביעה בדיוק על תחילת כל אובייקט, והקובץ נגמר ב-%%EOF", () => {
  const pdf = jpegPagesToPdf([{ jpeg: JPEG, width: 16, height: 12 }, { jpeg: JPEG, width: 16, height: 12 }], { title: "בדיקה" });
  const text = Buffer.from(pdf).toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4\n"));
  assert.ok(text.trimEnd().endsWith("%%EOF"));
  const startxref = Number(text.match(/startxref\n(\d+)\n%%EOF/)[1]);
  assert.equal(text.slice(startxref, startxref + 4), "xref");
  const [, first, count] = text.slice(startxref).match(/^xref\n(\d+) (\d+)\n/);
  assert.equal(Number(first), 0);
  const rows = text.slice(startxref).split("\n").slice(2, 2 + Number(count));
  rows.slice(1).forEach((row, i) => {
    const off = Number(row.slice(0, 10));
    assert.equal(text.slice(off, off + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`, `אובייקט ${i + 1} — הפניה ${off}`);
  });
  // ה-JPEG נכנס כמו שהוא, פעם לכל עמוד
  assert.equal(text.split("/Filter /DCTDecode").length - 1, 2);
  assert.ok(text.includes(`/Length ${JPEG.length}`));
});

test("PDF: נפתח ב-pdfjs — מספר עמודים, גודל A4, תמונה בכל עמוד, וכותרת בעברית", { skip: noPdfjs }, async () => {
  const { getDocument, OPS } = await import(PDFJS.href);
  const title = "דיווח תיקון ליקוי — מגדל 1";
  const pdf = jpegPagesToPdf([{ jpeg: JPEG, width: 16, height: 12 }, { jpeg: JPEG, width: 16, height: 12 }], { title });
  // ⚠️ pdfjs 6: אין doc.destroy — סוגרים את משימת הטעינה
  const task = getDocument({ data: pdf, isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  try {
    assert.equal(doc.numPages, 2);
    for (let n = 1; n <= 2; n++) {
      const page = await doc.getPage(n);
      assert.deepEqual(page.view.map((v) => Math.round(v * 100) / 100), [0, 0, A4_PT.width, A4_PT.height]);
      const ops = await page.getOperatorList();
      assert.ok(ops.fnArray.includes(OPS.paintImageXObject), `עמוד ${n}: אין ציור תמונה`);
    }
    const { info } = await doc.getMetadata();
    assert.equal(info.Title, title, "הכותרת בעברית נשמרה");
    assert.equal(info.Producer, "Parkomat SiteMonitor");
  } finally {
    await task.destroy();
  }
});

test("PDF: בלי עמודים — שגיאה, לא קובץ ריק", () => {
  assert.throws(() => jpegPagesToPdf([]));
});

test("מחרוזת PDF: UTF-16BE עם BOM, כולל תו מחוץ למישור הבסיסי", () => {
  assert.equal(pdfTextString("אב"), "<FEFF05D005D1>");
  assert.equal(pdfTextString("A"), "<FEFF0041>");
  assert.equal(pdfTextString("😀"), "<FEFFD83DDE00>");
});

// ---------------------------------------------------------------
// מה כתוב במסמך
// ---------------------------------------------------------------
const SITE = { code: "2438", site_name: "חניון מגדל 1" };
const DEFECT = { id: 103, status: "done", body: "להחליף נורת אזהרה", due_on: "2026-04-30", urgent: false,
  done_at: "2026-05-02T08:10:00.000Z", done_by_name: "יוסי כהן", done_note: "הוחלפה נורה, נבדק תקין" };

test("אילו תיקונים: רק מה שסומן כבוצע בשטח — לא פתוח ולא נסגר בתסקיר חוזר נקי — לפי סדר התיקון", () => {
  const ds = [
    { id: 3, status: "done", done_at: "2026-05-03T08:00:00Z" },
    { id: 1, status: "done", done_at: "2026-05-01T08:00:00Z" },
    { id: 9, status: "done", done_at: "2026-05-02T08:00:00Z", closed_by_report_id: 21 },
    { id: 5, status: "open" },
    { id: 2, status: "done", done_at: "2026-05-01T08:00:00Z" },
  ];
  assert.deepEqual(fixesForPdf(ds).map((d) => d.id), [1, 2, 3], "הישן ראשון; תיקו — לפי מזהה; התיקון החדש מצטרף בסוף");
  assert.deepEqual(fixesForPdf(null), []);
});

test("פרטי המסמך: אתר, מתקן, התסקיר (או תסקירים, בלי כפילות), ומספר הליקויים", () => {
  const per = { inspected_on: "2026-03-16", kindLabel: "תסקיר תקופתי" };
  const fol = { inspected_on: "2026-05-10", kindLabel: "בדיקה חוזרת" };
  const one = summaryFacts({ site: SITE, reports: [per, per], count: 1 });
  assert.deepEqual(one.map((r) => [r.label, r.value]), [["אתר", "חניון מגדל 1 · קוד 2438"], ["תסקיר", "תסקיר תקופתי מיום 16/03/2026"], ["ליקויים שתוקנו", "ליקוי אחד"]]);
  const two = summaryFacts({ site: SITE, machineLabel: "30245", reports: [per, fol, per], count: 3 });
  assert.deepEqual(two.map((r) => r.label), ["אתר", "מתקן", "תסקירים", "ליקויים שתוקנו"]);
  assert.equal(two[2].value, "תסקיר תקופתי מיום 16/03/2026 · בדיקה חוזרת מיום 10/05/2026");
  assert.equal(two[3].value, "3 ליקויים");
  assert.equal(summaryFacts({ site: { code: "1", name: "אתר" } })[0].value, "אתר · קוד 1", "שם האתר גם מ-name");
});

test("פרטי תיקון: לפי הסדר, שורה ריקה אינה מופיעה, 'מתסקיר' רק כשנמסר", () => {
  assert.deepEqual(fixFacts({ defect: DEFECT }).map((r) => [r.label, r.value]),
    [["מועד תיקון נדרש", "30/04/2026"], ["תוקן בתאריך", "02/05/2026"], ["בוצע על ידי", "יוסי כהן"], ["הערה", "הוחלפה נורה, נבדק תקין"]]);
  const f = fixFacts({ defect: { ...DEFECT, urgent: true, done_note: "" }, report: { inspected_on: "2026-05-10", kindLabel: "בדיקה חוזרת" } });
  assert.deepEqual(f.map((r) => r.label), ["מתסקיר", "מועד תיקון נדרש", "תוקן בתאריך", "בוצע על ידי"]);
  assert.equal(f[0].value, "בדיקה חוזרת מיום 10/05/2026");
  assert.equal(f[1].value, "30/04/2026 · דחוף");
});

test("תאריך התיקון ביום ישראלי — 01:30 בלילה בישראל הוא עדיין 22:30 של אתמול ב-UTC", () => {
  assert.equal(ilDay("2026-10-07T22:30:00.000Z"), "08/10/2026");
  assert.equal(ilDay("bad"), "");
});

test("שם הקובץ: יחיד/רבים, קוד האתר ויום התיקון האחרון, בלי תווים אסורים", () => {
  assert.equal(fixesPdfFileName({ site: SITE, defects: [DEFECT] }), "תיקון-ליקוי-2438-2026-05-02.pdf");
  assert.equal(fixesPdfFileName({ site: SITE, defects: [DEFECT, { done_at: "2026-10-07T22:30:00Z" }, { done_at: "2026-06-01T08:00:00Z" }] }),
    "תיקון-ליקויים-2438-2026-10-08.pdf", "האחרון — וביום ישראלי");
  assert.equal(fixesPdfFileName({ site: { code: "a/b c" }, defects: [DEFECT] }), "תיקון-ליקוי-abc-2026-05-02.pdf");
});

test("חלוקה לעמודים: תיקון שלם בכל עמוד, תמונות מתכווצות עד המינימום, ותחתיו — עמוד חדש", () => {
  const opt = { firstTop: 500, nextTop: 300, bottom: 1600, gap: 40, photoMax: 560, photoMin: 300, noPhotoH: 56 };
  // אחד — נכנס בעמוד הראשון, תמונה בגודל המלא
  assert.deepEqual(planPages([{ textH: 300, photos: 1 }], opt), [{ page: 0, y: 500, photoH: 560 }]);
  // שניים: השני מתחיל אחרי הראשון; נשאר לו 1600-1400-300<300 → עמוד חדש
  const two = planPages([{ textH: 300, photos: 1 }, { textH: 300, photos: 2 }], opt);
  assert.deepEqual(two[1], { page: 1, y: 300, photoH: 560 });
  // תמונה מתכווצת כדי להיכנס (במקום עמוד חדש) כשנשאר מעל המינימום
  const shrink = planPages([{ textH: 200, photos: 1 }, { textH: 200, photos: 1 }], { ...opt, firstTop: 300 });
  assert.equal(shrink[1].page, 0);
  assert.ok(shrink[1].photoH >= 300 && shrink[1].photoH < 560, JSON.stringify(shrink));
  assert.ok(shrink[1].y + 200 + shrink[1].photoH <= 1600, "בתוך העמוד");
  // בלי תמונה — רק שורת "לא צורפה תמונה"
  assert.deepEqual(planPages([{ textH: 300, photos: 0 }], opt), [{ page: 0, y: 500, photoH: 56 }]);
  // תיקון ראשון בעמוד לעולם אינו נדחה לעמוד ריק נוסף, גם אם גדול
  const big = planPages([{ textH: 1500, photos: 1 }], opt)[0];
  assert.equal(big.page, 0);
  assert.equal(big.photoH, 300, "והתמונה שלו לא מתכווצת מתחת למינימום — גם אם אין לה מקום");
  // כל תיקון מתחיל אחרי הקודם באותו עמוד, בלי חפיפה
  const many = planPages(Array.from({ length: 6 }, () => ({ textH: 250, photos: 1 })), opt);
  for (let i = 1; i < many.length; i++) {
    if (many[i].page === many[i - 1].page) assert.ok(many[i].y >= many[i - 1].y + 250 + many[i - 1].photoH, `חפיפה ${i}`);
    assert.ok(many[i].page >= many[i - 1].page);
  }
});

// ---------------------------------------------------------------
// סידור העמוד
// ---------------------------------------------------------------
const measure = (s) => s.length * 10;

test("שבירת שורות: כל שורה בתוך הרוחב, שורות חדשות נשמרות, מילה ארוכה נחתכת", () => {
  const lines = wrapWords("אחת שתיים שלוש ארבע חמש שש", 100, measure);
  assert.ok(lines.every((l) => measure(l) <= 100), JSON.stringify(lines));
  assert.equal(lines.join(" "), "אחת שתיים שלוש ארבע חמש שש");
  assert.deepEqual(wrapWords("א\nב", 100, measure), ["א", "ב"]);
  const long = wrapWords("x".repeat(25), 100, measure);
  assert.ok(long.every((l) => measure(l) <= 100) && long.join("") === "x".repeat(25), JSON.stringify(long));
});

test("קיצור: '…' בסוף השורה האחרונה כשנחתך, ובלי שינוי כשלא", () => {
  assert.deepEqual(clampLines(["a", "b", "c"], 2), ["a", "b…"]);
  assert.deepEqual(clampLines(["a"], 2), ["a"]);
});

test("תמונות: אחת — כל השטח; כמה — שתי עמודות, הראשונה מימין, בלי חפיפה ובתוך השטח", () => {
  const area = { x: 100, y: 200, w: 1000, h: 800 };
  assert.deepEqual(layoutPhotos(1, area), [{ x: 100, y: 200, w: 1000, h: 800 }]);
  for (const n of [2, 3]) {
    const cells = layoutPhotos(n, area, 20);
    assert.equal(cells.length, n);
    assert.ok(cells[0].x > (cells[1].x), "הראשונה מימין");
    for (const c of cells) assert.ok(c.x >= area.x - 1e-6 && c.y >= area.y && c.x + c.w <= area.x + area.w + 1e-6 && c.y + c.h <= area.y + area.h + 1e-6);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = cells[i], b = cells[j];
      assert.ok(a.x + a.w <= b.x + 1e-6 || b.x + b.w <= a.x + 1e-6 || a.y + a.h <= b.y + 1e-6 || b.y + b.h <= a.y + 1e-6, `חפיפה ${i}/${j}`);
    }
  }
  assert.deepEqual(layoutPhotos(0, area), []);
});

test("התאמה לתא: היחס נשמר, התמונה בתוך התא וממורכזת", () => {
  const cell = { x: 0, y: 0, w: 400, h: 300 };
  const f = fitContain(1600, 900, cell);              // רחבה — נוגעת בצדדים
  assert.equal(f.w, 400);
  assert.ok(Math.abs(f.w / f.h - 1600 / 900) < 1e-9);
  assert.ok(Math.abs(f.y - (300 - f.h) / 2) < 1e-9 && f.x === 0);
  const g = fitContain(300, 1200, cell);              // גבוהה — נוגעת למעלה ולמטה
  assert.equal(g.h, 300);
  assert.ok(Math.abs(g.x - (400 - g.w) / 2) < 1e-9);
});
