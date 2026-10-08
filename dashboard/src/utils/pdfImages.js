// utils/pdfImages.js — PDF מעמודים שכל אחד מהם הוא תמונת JPEG אחת בגודל העמוד.
//
// ============================================================
// למה כותבים PDF ביד, ולמה העמוד הוא תמונה
// ============================================================
// מסמך תיקון הליקוי (08/10/2026) הוא עברית, מימין לשמאל, עם תאריכים ומספרים באמצע המשפט. ספריות
// PDF ב-JS (jsPDF, pdf-lib) אינן מסדרות טקסט דו-כיווני: עברית יוצאת הפוכה, או צריך להפוך אותה ביד
// ולהטמיע גופן עברי — שביר בדיוק במשפט כמו "בוצע ב-08/10/2026 ע״י משה". הדפדפן כבר יודע לצייר את
// זה נכון על <canvas> (direction = "rtl"), ולכן העמוד מצויר שם ונארז כאן כ-JPEG.
// המחיר, בגלוי: הטקסט במסמך אינו ניתן לסימון ולחיפוש. למסמך שנשלח לבודק כראיה לתיקון — מספיק.
// ⚠️ בלי תלות: PDF של תמונות JPEG הוא כמה עשרות שורות (DCTDecode — ה-JPEG נכנס כמו שהוא), וספרייה
// הייתה מוסיפה מאות KB לדשבורד בשביל זה.
//
// קובץ טהור: בלי DOM — נבדק ב-node (tests/defect-pdf.test.js) ונפתח שם ב-pdfjs.

const enc = new TextEncoder();

// A4 בנקודות PDF (1/72 אינץ')
export const A4_PT = { width: 595.28, height: 841.89 };

/** מחרוזת PDF בטוחה לכל שפה: UTF-16BE עם BOM, בהקסה — כך "תיקון ליקוי" נשמר בכותרת המסמך. */
export function pdfTextString(s) {
  let hex = "FEFF";
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) {
      const v = cp - 0x10000;
      hex += (0xd800 + (v >> 10)).toString(16).padStart(4, "0") + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, "0");
    } else {
      hex += cp.toString(16).padStart(4, "0");
    }
  }
  return `<${hex.toUpperCase()}>`;
}

/**
 * @param {Array<{jpeg: Uint8Array, width: number, height: number}>} pages — פיקסלים של כל תמונה
 * @param {{title?: string, page?: {width:number,height:number}}} [opts]
 * @returns {Uint8Array} קובץ PDF
 */
export function jpegPagesToPdf(pages, { title = "", page = A4_PT } = {}) {
  if (!pages?.length) throw new Error("אין עמודים");
  const chunks = [];
  const offsets = [];
  let size = 0;
  const push = (data) => {
    const b = typeof data === "string" ? enc.encode(data) : data;
    chunks.push(b);
    size += b.length;
  };
  const obj = (n, body) => { offsets[n] = size; push(`${n} 0 obj\n`); body(); push("\nendobj\n"); };

  // ⚠️ השורה השנייה — תווים מעל 127 — אומרת לכל קורא שהקובץ בינארי; בלעדיה יש כלים שמשבשים אותו.
  // (TextEncoder מקודד אותם כ-UTF-8, כלומר בייטים מעל 127 — וזה כל מה שנדרש.)
  push("%PDF-1.4\n%âãÏÓ\n");

  const W = page.width.toFixed(2), H = page.height.toFixed(2);
  const kids = pages.map((_, i) => `${4 + i * 3} 0 R`).join(" ");
  obj(1, () => push("<< /Type /Catalog /Pages 2 0 R >>"));
  obj(2, () => push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`));
  obj(3, () => push(`<< /Producer ${pdfTextString("Parkomat SiteMonitor")}${title ? ` /Title ${pdfTextString(title)}` : ""} >>`));

  pages.forEach((p, i) => {
    const pageN = 4 + i * 3, imgN = pageN + 1, contentN = pageN + 2;
    obj(pageN, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] ` +
      `/Resources << /XObject << /Im0 ${imgN} 0 R >> >> /Contents ${contentN} 0 R >>`));
    obj(imgN, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB ` +
        `/BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
      push(p.jpeg);
      push("\nendstream");
    });
    const draw = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    obj(contentN, () => push(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`));
  });

  const count = 4 + pages.length * 3;
  const xrefAt = size;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) xref += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
