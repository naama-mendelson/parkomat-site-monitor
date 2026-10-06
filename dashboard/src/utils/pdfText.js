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
import { addGapSpaces, repairItems } from "./pdfItems";

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
      // קידוד עברי ישן ("מסומðים") — גם לקריאה, לא רק להעתקה (ראו pdfItems.js)
      pages.push({ items: repairItems(tc.items) });
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
// ⚠️ הרווחים שנוספו במרווחים (pdfItems.addGapSpaces) צריכים **לכסות** את המרווח.
// pdfjs מותח קטע לרוחבו רק כשיש בו יותר מתו אחד (shouldScaleText), ולכן " " נשאר
// ברוחב של רווח — 3px — ומרווח של 16px בין "1" ל"יש לחזק" נשאר ריק. גרירה שמתחילה
// שם, ממש לפני האות הראשונה (איפה שאדם מתחיל לסמן בעברית), לא סימנה כלום. נמדד על
// תסקיר אמיתי, 06/10/2026. הקטעים של pdfjs באים בסדר הפריטים שיש בהם טקסט.
function gapSpans(container, items) {
  // :not(.markedContent) — עוטפים של pdfjs (אם includeMarkedContent יופעל) אינם קטעי טקסט
  const spans = container.querySelectorAll("span:not(.markedContent)");
  const texty = items.filter((it) => it.str !== "" && it.str !== undefined);
  if (spans.length !== texty.length) return [];    // מבנה לא צפוי — לא נוגעים
  const out = [];
  texty.forEach((it, i) => { if (it.gapSpace) out.push([spans[i], it.width]); });
  return out;
}
// היחס נשמר גם כשהשכבה משנה גודל (הכול מוכפל באותו מקדם) — אבל המדידה צריכה
// שכבה גלויה, ולכן היא רצה בכל fit() ולא רק פעם אחת.
// ⚠️ כתיבה-קריאה-כתיבה באצווה ולא לסירוגין: מדידה אחרי כל כתיבה מאלצת חישוב פריסה
// לכל מרווח, בכל שינוי גודל.
function stretchGaps(gaps, k) {
  for (const [span] of gaps) span.style.setProperty("--scale-x", "1");
  const natural = gaps.map(([span]) => span.getBoundingClientRect().width);
  gaps.forEach(([span, width], i) => {
    if (natural[i] > 0) span.style.setProperty("--scale-x", String((width * k) / natural[i]));
  });
}

// ⚠️ סימון שמתחיל או נגמר באמצע מילה מורחב למילה שלמה. "י" היא אות של 3px:
// גרירה שמתחילה על החצי השמאלי שלה מתחילה **אחריה**, ובעלת המוצר הדביקה
// "ש לחזק…" במקום "יש לחזק…" (06/10/2026). ליקויים מעתיקים במילים שלמות.
//
// ⚠️ ו"באמצע מילה" אינו מספיק: גרירה שמתחילה על החצי השמאלי של האות **האחרונה**
// במילה מציבה את הסמן בקצה המילה — ובלי ההרחבה המילה כולה נעלמת ("לחזק 7…").
// מהסמן לבדו אי אפשר להבחין בין "התחלתי על המילה" ל"התחלתי ברווח שאחריה"; הנקודה
// שבה העכבר נלחץ (או שוחרר) כן: אות שנמצאת מתחתיה, ממש מחוץ לסימון, נכנסת אליו.
// גרש וגרשיים בתוך מילה — ת"א, ע"י, מס׳ — הם חלק ממנה
const WORD_CHAR = /[\p{L}\p{N}"'׳״]/u;
function charUnder(node, i, pt) {
  if (!pt || !node || node.nodeType !== 3 || i < 0 || i >= node.data.length) return false;
  const rg = document.createRange();
  rg.setStart(node, i);
  rg.setEnd(node, i + 1);
  const b = rg.getBoundingClientRect();
  return pt.x >= b.left - 0.5 && pt.x <= b.right + 0.5 && pt.y >= b.top - 2 && pt.y <= b.bottom + 2;
}
// ⚠️ ולא מתקנים את מה ש-Chrome עשה — בונים מחדש. נמדד על התסקיר הזה, פיקסל אחר
// פיקסל לאורך "יש": במקומות מסוימים הסמן נוחת על הקטע עצמו (לא על אות), ובאחרים
// הגרירה מסתיימת **בלי סימון בכלל**. לכן בשחרור העכבר הסימון נבנה מחדש משתי
// הנקודות — איפה שנלחץ ואיפה ששוחרר — ולא ממה שהדפדפן השאיר.
function caretAt(container, pt) {
  let node = null, offset = 0;
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(pt.x, pt.y);
    if (p) { node = p.offsetNode; offset = p.offset; }
  } else if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(pt.x, pt.y);
    if (r) { node = r.startContainer; offset = r.startOffset; }
  }
  if (!node || node.nodeType !== 3 || !container.contains(node)) return null;
  return { node, offset };
}
function fixMouseSelection(container, downPt, upPt) {
  const sel = window.getSelection?.();
  if (!sel || !downPt || !upPt) return;
  if (Math.hypot(upPt.x - downPt.x, upPt.y - downPt.y) < 3) return;   // קליק, לא גרירה
  let a = caretAt(container, downPt), b = caretAt(container, upPt);
  if (!a || !b) return;      // אחת הנקודות מחוץ לטקסט (למשל גרירה אל מחוץ לעמוד) — כמו שהדפדפן השאיר
  // סדר המסמך: מי ההתחלה ומי הסוף
  const probe = document.createRange();
  probe.setStart(a.node, a.offset);
  const backward = probe.comparePoint(b.node, b.offset) < 0;
  if (backward) [a, b, downPt, upPt] = [b, a, upPt, downPt];
  let sNode = a.node, so = a.offset, eNode = b.node, eo = b.offset;
  // האות שמתחת לנקודה נכנסת, גם כשהסמן נפל בקצה שלה
  if (so > 0 && WORD_CHAR.test(sNode.data[so - 1]) && charUnder(sNode, so - 1, downPt)) so--;
  if (eo < eNode.data.length && WORD_CHAR.test(eNode.data[eo]) && charUnder(eNode, eo, upPt)) eo++;
  // ומשם — עד קצה המילה
  if (so > 0 && so < sNode.data.length && WORD_CHAR.test(sNode.data[so - 1]) && WORD_CHAR.test(sNode.data[so])) {
    while (so > 0 && WORD_CHAR.test(sNode.data[so - 1])) so--;
  }
  if (eo > 0 && eo < eNode.data.length && WORD_CHAR.test(eNode.data[eo - 1]) && WORD_CHAR.test(eNode.data[eo])) {
    while (eo < eNode.data.length && WORD_CHAR.test(eNode.data[eo])) eo++;
  }
  // ⚠️ מילה שנחתכה לשני קטעים צמודים ("יו"+"ם", נמדד) — ממשיכים לקטע השכן. קטע שכן
  // **צמוד** = אין ביניהם קטע רווח (pdfItems מוסיף רווח רק כשיש מרווח) ואין <br>.
  const textOf = (el) => (el && el.tagName === "SPAN" && el.firstChild?.nodeType === 3 ? el.firstChild : null);
  if (so === 0 && WORD_CHAR.test(sNode.data[0] ?? "")) {
    const prev = textOf(sNode.parentNode?.previousElementSibling);
    if (prev && WORD_CHAR.test(prev.data[prev.data.length - 1] ?? "")) {
      let p = prev.data.length;
      while (p > 0 && WORD_CHAR.test(prev.data[p - 1])) p--;
      sNode = prev; so = p;
    }
  }
  if (eo === eNode.data.length && WORD_CHAR.test(eNode.data[eo - 1] ?? "")) {
    const next = textOf(eNode.parentNode?.nextElementSibling);
    if (next && WORD_CHAR.test(next.data[0] ?? "")) {
      let n = 0;
      while (n < next.data.length && WORD_CHAR.test(next.data[n])) n++;
      eNode = next; eo = n;
    }
  }
  if (sNode === eNode && so >= eo) return;
  // ⚠️ setBaseAndExtent ולא addRange: שומר את כיוון הגרירה (Shift+חץ אחר כך)
  if (backward) sel.setBaseAndExtent(eNode, eo, sNode, so);
  else sel.setBaseAndExtent(sNode, so, eNode, eo);
}

function attachTextLayer(pdfjs, page, container, fixItems) {
  const viewport = page.getViewport({ scale: 1 });
  container.replaceChildren();
  container.classList.add("pdf-text");
  container.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
  let gaps = [];
  const fit = () => {
    const w = container.clientWidth;
    if (w > 0) {
      container.style.setProperty("--total-scale-factor", String(w / viewport.width));
      stretchGaps(gaps, w / viewport.width);
    }
  };
  fit();
  const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
  ro?.observe(container);

  // ⚠️ "selecting": בזמן גרירה הרקע (endOfContent) עולה ומכסה את כל העמוד
  // מתחת לטקסט. בלעדיו, גרירה שעוברת ברווח בין שורות "קופצת" ומסמנת את כל
  // העמוד — כך גם בצופה של pdfjs עצמו.
  const end = document.createElement("div");
  end.className = "endOfContent";
  let downPt = null;
  const down = (e) => {
    container.classList.add("selecting");
    // ⚠️ עכבר בלבד. במגע הסימון נעשה בלחיצה ארוכה ובידיות של הדפדפן — שתי נקודות
    // של אצבע אינן הקצוות של מה שהאדם סימן, ובנייה מחדש מהן הייתה שוברת אותו.
    downPt = e.pointerType === "mouse" && e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  };
  const up = (e) => {
    container.classList.remove("selecting");
    if (!downPt) return;
    const from = downPt;
    const to = e && Number.isFinite(e.clientX) ? { x: e.clientX, y: e.clientY } : null;   // blur — אין נקודה
    downPt = null;
    // אחרי שהדפדפן סיים לעדכן את הסימון של הגרירה.
    // (החלה שנייה אחרי פריים נוסתה ונמחקה: בקצב של אדם — Ctrl+C 150ms ויותר אחרי
    // השחרור — סריקה של כל פיקסל לאורך "יש" עברה גם בלעדיה. דריסה נראתה רק בגרירות
    // בהפרש של 40ms זו מזו, שאדם אינו עושה.)
    setTimeout(() => fixMouseSelection(container, from, to), 0);
  };
  // ⚠️ גרירה שהדפדפן ביטל (למשל גרירה של טקסט שכבר מסומן) שולחת pointercancel ולא
  // pointerup — בלי זה נקודת הלחיצה נשארת, והשחרור הבא היה בונה סימון ממנה.
  const cancel = () => { container.classList.remove("selecting"); downPt = null; };
  container.addEventListener("pointerdown", down);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("blur", up);

  let layer = null;
  let detached = false;
  const done = page.getTextContent().then((tc) => {
    if (detached) return undefined;
    // סוגריים הפוכים בחלק מהתסקירים — ראו pdfBrackets.js
    const textContentSource = { ...tc, items: fixItems(tc.items) };
    layer = new pdfjs.TextLayer({ textContentSource, container, viewport });
    return layer.render().then(() => {
      container.append(end);
      gaps = gapSpans(container, textContentSource.items);
      fit();
    });
  });
  const detach = () => {
    detached = true;
    layer?.cancel();
    ro?.disconnect();
    container.removeEventListener("pointerdown", down);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
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
        // הסדר: קידוד → סוגריים → רווחים. הסוגריים נספרים על הטקסט המתוקן, והרווחים
        // נוספים אחרון — קטע " " אינו נושא סימן לאף אחד מהם (ראו pdfItems.js)
        const { done, detach } = attachTextLayer(pdfjs, page, container,
          (items) => addGapSpaces(fixBrackets(pageNo, repairItems(items))));
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
