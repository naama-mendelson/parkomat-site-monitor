// utils/pdfText.js — הדבק בין pdfjs לבין הדשבורד (Vite בלבד).
//
// ============================================================
// ⚠️ pdfjs נטען בייבוא דינמי, ולעולם לא ב-import רגיל
// ============================================================
// הספרייה והעובד שלה הם כמה מאות KB. רוב מי שפותח את הדשבורד לא יעלה
// תסקיר לעולם, ו-import סטטי היה מכניס את כל זה ל-bundle הראשי של כולם.
// לכן הייבוא היחיד של 'pdfjs-dist' בקוד הוא ה-import() שבתוך loadPdfjs,
// ו-Vite מפצל אותו לקטע נפרד שנטען רק כשמישהו באמת פותח PDF.
//
// ⚠️ כתובת העובד מגיעה מ-`?url` — זה מה שגורם ל-Vite להעתיק את הקובץ ל-
// dist/assets עם hash. ⚠️ הייבוא הזה הוא מחרוזת בלבד (כתובת), ולכן הוא
// אינו מושך את העובד עצמו ל-bundle הראשי.
//
// ============================================================
// ⚠️ legacy/ ולא build/ — ולא להחליף בחזרה
// ============================================================
// build/ של pdfjs 6 קורא ל-Map.prototype.getOrInsertComputed, Math.sumPrecise,
// Promise.try ו-URL.parse **בלי polyfill** — דפדפנים מהחודשים האחרונים בלבד
// (נמדד: Node 24 / V8 13.6 חסר את שני הראשונים). בטלפון של טכנאי שלא עודכן
// זה TypeError — שנראה בדיוק כמו "קובץ פגום": התצוגה אומרת "לא ניתן להציג",
// ההעלאה עוברת לידני, ומכיוון שהקריאות יושבות במסלולים שתלויים בתוכן, חלק
// מהקבצים עובדים וחלק לא. legacy/ כולל core-js ומעט גדול יותר, ועדיין
// נטען רק בקטע העצל. scripts/check-bundle.mjs נכשל אם העובד שנבנה אינו legacy.
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import "./pdfTextLayer.css";
import { bracketFixer } from "./pdfBrackets";

// ============================================================
// שתי משפחות של כשל, ואסור לבלבל ביניהן
// ============================================================
// קובץ פגום/סרוק הוא בעיה של **המסמך** — עוברים להזנה ידנית.
// מודול שלא נטען (פריסה חדשה החליפה את שמות הקטעים בזמן שהלשונית הייתה
// פתוחה, או 404 על העובד) הוא בעיה של **הדף** — והתיקון הוא רענון.
// הצגת "לא הצלחנו לקרוא את הקובץ" במקרה השני הייתה שולחת את המנהל לסרוק
// מחדש מסמך תקין.
export class PdfModuleError extends Error {
  constructor(cause) {
    super("רכיב קריאת ה-PDF לא נטען — כנראה שגרסה חדשה של הדשבורד עלתה");
    this.name = "PdfModuleError";
    this.cause = cause;
  }
}

// הודעות הדפדפנים השונים לייבוא דינמי שנכשל, וההודעה של pdfjs כשהעובד
// לא נטען (הוא מנסה "fake worker" באותו thread ונכשל גם בו).
const MODULE_FAIL_RE =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Loading chunk \S+ failed|fake worker|Failed to fetch.*pdf\.worker/i;

export function isPdfModuleFailure(err) {
  if (!err) return false;
  if (err instanceof PdfModuleError) return true;
  return err.name === "ChunkLoadError" || MODULE_FAIL_RE.test(String(err.message || err));
}

let pdfjsPromise = null;

function loadPdfjs() {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs")
    .then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    })
    .catch((err) => {
      // ⚠️ לא נשמר הבטחה דחויה: אחרי רענון רשת חלקי ניסיון שני יכול להצליח,
      // ומטמון של כישלון היה הופך תקלה רגעית לקבועה עד רענון הדף.
      pdfjsPromise = null;
      throw new PdfModuleError(err);
    });
  return pdfjsPromise;
}

// ============================================================
// ⚠️ עותק של הבתים, תמיד
// ============================================================
// pdfjs **מעביר** (transfer) את ה-buffer לעובד, והמקור מתנתק — byteLength
// הופך ל-0. אותו קובץ נשלח אחר כך למסד (base64), ובלי עותק נשלח קובץ ריק.
// File.arrayBuffer() מחזיר buffer חדש בכל קריאה, אבל ArrayBuffer/Uint8Array
// שהגיעו מבחוץ הם של מי שקרא לנו — ולכן slice.
async function toBytes(src) {
  if (src instanceof ArrayBuffer) return new Uint8Array(src.slice(0));
  if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength));
  if (src && typeof src.arrayBuffer === "function") return new Uint8Array(await src.arrayBuffer());
  throw new TypeError("מקור PDF לא נתמך");
}

// קבצי העזר (wasm ל-JBIG2/JPEG2000, גופנים סטנדרטיים, CMaps, פרופיל ICC)
// מוגשים מ-/pdfjs/ בנתיב קבוע — ראה pdfjsAssets ב-vite.config.js. ⚠️ כתובת
// מלאה: העובד פותר כתובת יחסית מול **הכתובת שלו** (dist/assets/), לא מול הדף.
function assetUrls() {
  const base = new URL(`${import.meta.env.BASE_URL || "/"}pdfjs/`, window.location.href).href;
  return {
    wasmUrl: `${base}wasm/`,
    standardFontDataUrl: `${base}standard_fonts/`,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    iccUrl: `${base}iccs/`,
  };
}

async function openTask(src) {
  const pdfjs = await loadPdfjs();
  const data = await toBytes(src);
  // isEvalSupported:false — PDF הוא קלט מבחוץ; אין סיבה לתת לו לבנות קוד.
  //
  // ⚠️ disableFontFace:true — pdfjs מצייר את צורות האותיות בעצמו, ולא טוען את
  // הגופן המוטמע לדפדפן. בלי זה **כל** תסקיר עברי שנבדק יצא משובש: אותיות
  // אחת על השנייה וחלקן חסרות ("תסקיר בדי קת מתקן תי ה"). הגופנים כן מוטמעים
  // (David, Miriam, Arial — תת-קבוצות TrueType), אבל ההוראות שבהם פגומות
  // ("TT: undefined function: 32"), ו-Chrome דוחה גופן כזה כשהוא נטען כ-FontFace.
  // נמדד על שני תסקירים אמיתיים, משתי תוכנות: משובש בברירת המחדל, נקי עם הדגל.
  // המחיר: ציור קצת איטי יותר. שכבת הטקסט (renderText) אינה מושפעת — היא
  // משתמשת בגופני הדפדפן, לא בגופן המוטמע.
  return pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, verbosity: 0, ...assetUrls() });
}

function rethrow(err) {
  throw isPdfModuleFailure(err) && !(err instanceof PdfModuleError) ? new PdfModuleError(err) : err;
}

/**
 * File/Blob/ArrayBuffer → `[{ items }]`, הצורה ש-parseInspectionReport מקבל.
 * זורק PdfModuleError כשהמודול/העובד לא נטענו; כל שגיאה אחרת היא של הקובץ.
 */
export async function extractPages(src) {
  let task;
  try {
    task = await openTask(src);
    const doc = await task.promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      pages.push({ items: tc.items });
      page.cleanup();
    }
    return pages;
  } catch (err) {
    return rethrow(err);
  } finally {
    // ⚠️ ב-v6 אין PDFDocumentProxy.destroy() — משמידים את משימת הטעינה,
    // וזה מה שמשחרר את העובד. בלי זה כל העלאה משאירה עובד חי בזיכרון.
    if (task) await task.destroy().catch(() => {});
  }
}

// ============================================================
// שכבת טקסט — מה שמאפשר לסמן ולהעתיק מהמסמך
// ============================================================
// הקנבס הוא תמונה; אין בו טקסט לסמן. pdfjs יודע לבנות מעליו שכבה של טקסט
// שקוף, כל קטע במקום המדויק שלו בעמוד — והדפדפן מסמן ומעתיק אותה כרגיל.
// בעלת המוצר: "שיהיה אפשר להעתיק מהמסמך עצמו" — את הליקויים מקלידים בטופס
// מתוך המסמך שלידו.
//
// ⚠️ המיקום באחוזים מהעמוד, וגודל הגופן לפי --total-scale-factor (רוחב
// השכבה ÷ רוחב העמוד). הקנבס מוצג ב-width:100% ומשנה גודל עם החלון בלי ציור
// מחדש, ולכן המשתנה מחושב מהרוחב **הנמדד** בכל שינוי גודל ולא פעם אחת:
// אחרת אחרי סיבוב טלפון הסימון היה נופל ליד המילים ולא עליהן.
//
// ⚠️ pdfjs כותב לשכבה width/height עם round() של CSS — לא קיים בדפדפנים ישנים
// (ראו legacy למעלה), ונשען על --scale-round-x שמוגדר רק ב-CSS של הצופה
// שלהם. pdfTextLayer.css דורס את שניהם, והגובה נקבע מיחס העמוד (aspect-ratio)
// — לא מהמכל, שגובהו לפי עמוד 1 וטועה בעמוד במאוזן.
function attachTextLayer(pdfjs, page, container, fixItems) {
  const viewport = page.getViewport({ scale: 1 });
  container.replaceChildren();
  container.classList.add("pdf-text");
  container.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
  const fit = () => {
    const w = container.clientWidth;
    if (w > 0) container.style.setProperty("--total-scale-factor", String(w / viewport.width));
  };
  fit();
  const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
  ro?.observe(container);

  // ⚠️ "selecting": בזמן גרירה הרקע (endOfContent) עולה ומכסה את כל העמוד
  // מתחת לטקסט. בלעדיו, גרירה שעוברת ברווח בין שורות "קופצת" ומסמנת את כל
  // העמוד — כך גם בצופה של pdfjs עצמו.
  const end = document.createElement("div");
  end.className = "endOfContent";
  const down = () => container.classList.add("selecting");
  const up = () => container.classList.remove("selecting");
  container.addEventListener("pointerdown", down);
  window.addEventListener("pointerup", up);
  window.addEventListener("blur", up);

  let layer = null;
  let detached = false;
  const done = page.getTextContent().then((tc) => {
    if (detached) return undefined;
    // סוגריים הפוכים בחלק מהתסקירים — ראו pdfBrackets.js
    const textContentSource = { ...tc, items: fixItems(tc.items) };
    layer = new pdfjs.TextLayer({ textContentSource, container, viewport });
    return layer.render().then(() => { container.append(end); fit(); });
  });
  const detach = () => {
    detached = true;
    layer?.cancel();
    ro?.disconnect();
    container.removeEventListener("pointerdown", down);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("blur", up);
  };
  return { done, detach };
}

/**
 * פותח מסמך לתצוגה ומחזיר ידית:
 * `{ numPages, pageSize(no), renderPage(no, canvas, width), renderText(no, container), destroy() }`.
 * `width` — הרוחב ב-CSS px שהעמוד צריך למלא; צפיפות המסך מחושבת כאן.
 * `renderText` בונה את שכבת הטקסט ב-`container` (מעל הקנבס, באותו מכל
 * position:relative) ומחזיר פונקציית ניתוק — לקרוא לה לפני ציור עמוד אחר
 * באותו מכל, ובפירוק.
 * ⚠️ חובה לקרוא ל-destroy() — אחרת העובד נשאר חי.
 */
export async function openPdf(src) {
  let task;
  try {
    task = await openTask(src);
    const pdfjs = await loadPdfjs();
    const doc = await task.promise;
    const fixBrackets = bracketFixer();
    let destroyed = false;
    return {
      numPages: doc.numPages,
      async pageSize(pageNo) {
        const page = await doc.getPage(pageNo);
        const vp = page.getViewport({ scale: 1 });
        return { width: vp.width, height: vp.height };
      },
      async renderPage(pageNo, canvas, cssWidth) {
        if (destroyed) return;
        const page = await doc.getPage(pageNo);
        const base = page.getViewport({ scale: 1 });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const scale = (cssWidth / base.width) * dpr;
        const viewport = page.getViewport({ scale });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
        canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
        await page.render({ canvas, viewport }).promise;
        page.cleanup();
      },
      async renderText(pageNo, container) {
        if (destroyed || !container) return () => {};
        const page = await doc.getPage(pageNo);
        if (destroyed) return () => {};
        const { done, detach } = attachTextLayer(pdfjs, page, container, (items) => fixBrackets(pageNo, items));
        // ⚠️ כשל בשכבת הטקסט אינו כשל בתצוגה: העמוד כבר מצויר, רק אי אפשר
        // לסמן בו. לכן לא נזרק הלאה — שגיאה כאן הייתה מציגה "העמוד לא צויר".
        await done.catch(() => {});
        return detach;
      },
      async destroy() {
        destroyed = true;
        await task.destroy().catch(() => {});
        pdfjs.TextLayer.cleanup();
      },
    };
  } catch (err) {
    if (task) await task.destroy().catch(() => {});
    return rethrow(err);
  }
}

/**
 * מצייר עמוד אחד מקובץ מקומי (תצוגה מקדימה במסך האישור). `scale` — יחס
 * ל-CSS px, כמו ב-pdfjs. לכמה עמודים מאותו מסמך עדיף openPdf: כל קריאה
 * כאן פותחת את המסמך מחדש.
 */
export async function renderPage(src, pageNo, canvas, scale = 1) {
  const doc = await openPdf(src);
  try {
    const size = await doc.pageSize(pageNo);
    await doc.renderPage(pageNo, canvas, size.width * scale);
  } finally {
    await doc.destroy();
  }
}
