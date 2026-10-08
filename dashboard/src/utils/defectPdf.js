// utils/defectPdf.js — מסמך PDF של תיקוני הליקויים, לשליחה לבודק המוסמך.
//
// בעלת המוצר (08/10/2026): "כשמתקנים ליקוי ומעלים תמונה — שייווצר מסמך PDF עם הליקוי והתמונה שמראה את
// התיקון, שאפשר יהיה להוריד ולשלוח לבודק המוסמך". ואחר כך: "כשיש כמה ליקויים, כשמוסיפים עוד תיקון לעוד
// ליקוי — שיצטרף לאותו PDF". ובתשובות שלה: מסמך אחד לכל התיקונים של התסקיר הנוכחי (של המתקן), וגם
// תיקון בלי תמונה נכנס — עם "לא צורפה תמונה".
//
// ⚠️ נבנה בדפדפן, מהנתונים שכבר שמורים — לא נשמר במסד. "מצטרף" פירושו שהמסמך נבנה מחדש מכל התיקונים
// בכל הורדה, ולא קובץ שנערך: אין עותק ישן שיכול לסטות מהמסך, ולא מתווסף דבר לנפח המסד.
// ⚠️ העמוד מצויר על <canvas> ונארז כתמונה (ראה utils/pdfImages.js למה): כך העברית, התאריכים והשמות
// יוצאים בסדר הנכון בלי להטמיע גופן ובלי להפוך מחרוזות ביד.
//
// החלק העליון — פונקציות טהורות (נבדקות ב-node). buildFixesPdf — הציור עצמו, בדפדפן בלבד.
import { formatDateIL, todayIL } from "./compliance.js";
import { jpegPagesToPdf } from "./pdfImages.js";

// ============================================================
// טהור — אילו תיקונים, מה כתוב, ואיך זה מסודר
// ============================================================

/** תאריך ביום ישראלי (DD/MM/YYYY) מחותמת זמן מלאה. ⚠️ לא toISOString — בין 00:00 ל-03:00 זה עדיין אתמול. */
export function ilDay(stamp) {
  const t = Date.parse(stamp);
  return Number.isFinite(t) ? formatDateIL(todayIL(new Date(t))) : "";
}

/**
 * התיקונים שנכנסים למסמך: ליקויים שסומנו כבוצעו בשטח — לא כאלה שנסגרו בתסקיר חוזר נקי (את אלה הבודק
 * כבר ראה בעצמו). לפי סדר התיקון, הישן ראשון — כך "ליקוי 1" הוא הראשון שתוקן, והתיקון החדש מצטרף בסוף.
 */
export function fixesForPdf(defects) {
  return (defects || [])
    .filter((d) => d && d.status === "done" && !d.closed_by_report_id)
    .sort((a, b) => String(a.done_at ?? "").localeCompare(String(b.done_at ?? "")) || (a.id ?? 0) - (b.id ?? 0));
}

const reportText = (r) => (r?.inspected_on ? `${r.kindLabel ? `${r.kindLabel} ` : ""}מיום ${formatDateIL(r.inspected_on)}` : "");

/**
 * פרטי המסמך כולו — פעם אחת, בראש העמוד הראשון.
 * @param {{site, machineLabel?, reports?: Array<{inspected_on, kindLabel}>, count: number}} p
 */
export function summaryFacts({ site, machineLabel = null, reports = [], count = 0 }) {
  const siteName = site?.site_name ?? site?.name ?? "";
  const seen = new Set();
  const rep = reports.map(reportText).filter((t) => t && !seen.has(t) && seen.add(t));
  const rows = [
    ["אתר", [siteName, site?.code ? `קוד ${site.code}` : ""].filter(Boolean).join(" · ")],
    ["מתקן", machineLabel || ""],
    [rep.length > 1 ? "תסקירים" : "תסקיר", rep.join(" · ")],
    ["ליקויים שתוקנו", count === 1 ? "ליקוי אחד" : count > 1 ? `${count} ליקויים` : ""],
  ];
  return rows.filter(([, v]) => v).map(([label, value]) => ({ label, value }));
}

/**
 * פרטי תיקון אחד. שורה בלי ערך אינה מופיעה. `report` — רק כשבמסמך יש יותר מתסקיר אחד; אחרת הוא כבר
 * כתוב בראש העמוד, ולחזור עליו בכל ליקוי הוא רעש.
 */
export function fixFacts({ defect, report = null }) {
  const rows = [
    ["מתסקיר", reportText(report)],
    ["מועד תיקון נדרש", defect?.due_on ? `${formatDateIL(defect.due_on)}${defect.urgent ? " · דחוף" : ""}` : (defect?.urgent ? "דחוף" : "")],
    ["תוקן בתאריך", ilDay(defect?.done_at)],
    ["בוצע על ידי", defect?.done_by_name || ""],
    ["הערה", defect?.done_note || ""],
  ];
  return rows.filter(([, v]) => v).map(([label, value]) => ({ label, value }));
}

/** שם הקובץ: "תיקון-ליקויים-2438-2026-10-08.pdf" (יום התיקון האחרון). תווים שאסורים בשם קובץ — מוסרים. */
export function fixesPdfFileName({ site, defects }) {
  const last = (defects || []).map((d) => Date.parse(d?.done_at)).filter(Number.isFinite).sort((a, b) => a - b).pop();
  const day = last != null ? todayIL(new Date(last)) : todayIL();
  const code = String(site?.code ?? "").replace(/[\\/:*?"<>|\s]+/g, "");
  return `${(defects || []).length === 1 ? "תיקון-ליקוי" : "תיקון-ליקויים"}-${code ? `${code}-` : ""}${day}.pdf`;
}

/**
 * שבירת טקסט לשורות לפי רוחב. `measure(s)` — רוחב המחרוזת (ב-canvas: ctx.measureText(s).width).
 * שורות חדשות בטקסט נשמרות; מילה ארוכה מהשורה נחתכת באמצע — עדיף על טקסט שיוצא מהעמוד.
 */
export function wrapWords(text, maxWidth, measure) {
  const out = [];
  for (const para of String(text ?? "").split(/\r?\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) { out.push(""); continue; }
    let line = "";
    for (let w of words) {
      while (measure(w) > maxWidth && w.length > 1) {
        let cut = w.length - 1;
        while (cut > 1 && measure(w.slice(0, cut)) > maxWidth) cut--;
        if (line) { out.push(line); line = ""; }
        out.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      const next = line ? `${line} ${w}` : w;
      if (line && measure(next) > maxWidth) { out.push(line); line = w; } else line = next;
    }
    if (line) out.push(line);
  }
  return out;
}

/** עד `max` שורות; אם נחתך — "…" בסוף האחרונה, כדי שאיש לא יחשוב שזה כל הטקסט. */
export function clampLines(lines, max) {
  if (lines.length <= max) return lines;
  const keep = lines.slice(0, max);
  keep[max - 1] = `${keep[max - 1]}…`;
  return keep;
}

/**
 * מקום לכל תמונה בתוך שטח נתון: אחת — כל השטח; יותר — שתי עמודות. מימין לשמאל: הראשונה למעלה מימין.
 * @returns {Array<{x:number,y:number,w:number,h:number}>}
 */
export function layoutPhotos(n, area, gap = 24) {
  if (n <= 0) return [];
  const cols = n === 1 ? 1 : 2;
  const rows = Math.ceil(n / cols);
  const w = (area.w - gap * (cols - 1)) / cols;
  const h = (area.h - gap * (rows - 1)) / rows;
  return Array.from({ length: n }, (_, i) => {
    const r = Math.floor(i / cols), c = i % cols;
    return { x: area.x + area.w - w - c * (w + gap), y: area.y + r * (h + gap), w, h };
  });
}

/** התאמת תמונה לתא בלי לעוות: מוקטנת עד שנכנסת, וממורכזת. */
export function fitContain(iw, ih, cell) {
  const s = Math.min(cell.w / iw, cell.h / ih);
  const w = iw * s, h = ih * s;
  return { x: cell.x + (cell.w - w) / 2, y: cell.y + (cell.h - h) / 2, w, h };
}

/**
 * חלוקת התיקונים לעמודים. כל תיקון = טקסט (גובה ידוע) + תמונות. תיקון שלא נכנס במה שנשאר בעמוד —
 * עובר לעמוד הבא, שלם: ליקוי שהטקסט שלו בעמוד אחד והתמונה שלו בעמוד הבא נקרא כשני ליקויים.
 * התמונות מתכווצות עד `photoMin` כדי להיכנס; תחתיו — עמוד חדש.
 * @param {Array<{textH:number, photos:number}>} sections
 * @returns {Array<{page:number, y:number, photoH:number}>}
 */
export function planPages(sections, { firstTop, nextTop, bottom, gap = 40, photoMax = 560, photoMin = 300, noPhotoH = 56 } = {}) {
  const out = [];
  let page = 0, y = firstTop;
  for (const s of sections) {
    const min = s.photos ? photoMin : noPhotoH;
    const top = page === 0 ? firstTop : nextTop;
    if (bottom - y < s.textH + min && y > top) { page += 1; y = nextTop; }
    const room = bottom - y - s.textH;
    const photoH = s.photos ? Math.max(min, Math.min(photoMax, room)) : noPhotoH;
    out.push({ page, y, photoH });
    y += s.textH + photoH + gap;
  }
  return out;
}

// ============================================================
// בדפדפן — ציור העמודים
// ============================================================

// A4 ב-150 נקודות לאינץ' — חד מספיק להדפסה, וקובץ של מאות KB ולא של מגה
const W = 1240, H = 1754, M = 96, BOTTOM = H - 120;
const FONT = '"Segoe UI", "Assistant", Arial, sans-serif';
const C = { brand: "#0e4194", lime: "#94c11e", ink: "#14213d", sub: "#4a5670", muted: "#8a94a8", line: "#d8dee9", soft: "#f3f6fc" };
const LABEL_W = 270;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("התמונה לא נטענה"));
    img.src = url;
  });
}

function newPage() {
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.direction = "rtl";
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  return { canvas, ctx };
}

function font(ctx, size, weight = 400) { ctx.font = `${weight} ${size}px ${FONT}`; }
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); }

function header(ctx, logo, title, subtitle) {
  ctx.fillStyle = C.brand;
  ctx.fillRect(0, 0, W, 128);
  let x = W - M;
  if (logo) {
    const s = 72;
    ctx.fillStyle = "#ffffff";
    roundRect(ctx, x - s, 28, s, s, 14);
    ctx.fill();
    const f = fitContain(logo.naturalWidth || logo.width, logo.naturalHeight || logo.height, { x: x - s + 8, y: 36, w: s - 16, h: s - 16 });
    ctx.drawImage(logo, f.x, f.y, f.w, f.h);
    x -= s + 20;
  }
  ctx.fillStyle = "#ffffff"; font(ctx, 40, 800); ctx.fillText("Parkomat", x, 72);
  ctx.fillStyle = C.lime; font(ctx, 18, 700); ctx.fillText("SITEMONITOR", x, 98);
  ctx.fillStyle = C.ink; font(ctx, 50, 800); ctx.fillText(title, W - M, 220);
  ctx.fillStyle = C.sub; font(ctx, 26, 400); ctx.fillText(subtitle, W - M, 262);
  return 300;
}

function footer(ctx, made, pageNo, pages) {
  ctx.strokeStyle = C.line; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(M, H - 92); ctx.lineTo(W - M, H - 92); ctx.stroke();
  ctx.fillStyle = C.muted; font(ctx, 20, 400);
  ctx.textAlign = "right"; ctx.fillText(`הופק ב-${made} · Parkomat SiteMonitor`, W - M, H - 58);
  ctx.textAlign = "left"; ctx.fillText(`עמוד ${pageNo} מתוך ${pages}`, M, H - 58);
  ctx.textAlign = "right";
}

/** טבלת פרטים: תווית מימין, ערך משמאלה, קו דק בין שורות. `draw=false` — רק מודד. */
function factsTable(ctx, rows, y, draw = true) {
  for (const { label, value } of rows) {
    font(ctx, 26, 400);
    const lines = clampLines(wrapWords(value, W - 2 * M - LABEL_W, (s) => ctx.measureText(s).width), label === "הערה" ? 3 : 2);
    if (draw) {
      ctx.fillStyle = C.sub; font(ctx, 24, 700); ctx.fillText(label, W - M, y + 34);
      ctx.fillStyle = C.ink; font(ctx, 26, 400);
      lines.forEach((l, i) => ctx.fillText(l, W - M - LABEL_W, y + 34 + i * 36));
    }
    y += 18 + lines.length * 36;
    if (draw) {
      ctx.strokeStyle = C.line; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(M, y); ctx.lineTo(W - M, y); ctx.stroke();
    }
  }
  return y;
}

/** "תווית ערך" בשורה אחת: התווית מודגשת מימין, הערך משמאלה לה. */
function labelValue(ctx, label, value, x, y) {
  ctx.fillStyle = C.sub; font(ctx, 24, 700); ctx.fillText(label, x, y);
  const lw = ctx.measureText(label).width;
  ctx.fillStyle = C.ink; font(ctx, 26, 400); ctx.fillText(value, x - lw - 12, y);
}

/**
 * חלק של תיקון אחד: כותרת ממוספרת, הליקוי מודגש, והפרטים — מהודקים, כדי שכמה תיקונים ייכנסו בעמוד:
 * "מתסקיר" בשורה מלאה, מועד/תוקן/מבצע בשתי עמודות, ההערה בשורה מלאה מתחת. מחזיר את הגובה (ומצייר אם draw).
 */
function fixBlock(ctx, fix, index, total, y0, draw = true) {
  let y = y0;
  if (draw) { ctx.fillStyle = C.brand; font(ctx, 26, 800); ctx.fillText(total > 1 ? `ליקוי ${index + 1} מתוך ${total}` : "הליקוי", W - M, y + 28); }
  y += 46;
  font(ctx, 30, 600);
  const body = clampLines(wrapWords(fix.defect.body, W - 2 * M - 56, (s) => ctx.measureText(s).width), 6);
  const boxH = body.length * 42 + 32;
  if (draw) {
    ctx.fillStyle = C.soft; roundRect(ctx, M, y, W - 2 * M, boxH, 14); ctx.fill();
    ctx.fillStyle = C.ink; font(ctx, 30, 600);
    body.forEach((l, i) => ctx.fillText(l, W - M - 28, y + 48 + i * 42));
  }
  y += boxH + 12;
  const by = Object.fromEntries(fix.facts.map((r) => [r.label, r.value]));
  if (by["מתסקיר"]) { if (draw) labelValue(ctx, "מתסקיר", by["מתסקיר"], W - M, y + 30); y += 40; }
  const grid = ["מועד תיקון נדרש", "תוקן בתאריך", "בוצע על ידי"].filter((k) => by[k]);
  const colX = [W - M, W / 2 - 10];
  grid.forEach((k, i) => { if (draw) labelValue(ctx, k, by[k], colX[i % 2], y + 30 + Math.floor(i / 2) * 40); });
  y += Math.ceil(grid.length / 2) * 40;
  if (by["הערה"]) {
    font(ctx, 26, 400);
    const lw = (font(ctx, 24, 700), ctx.measureText("הערה").width + 12);
    font(ctx, 26, 400);
    const lines = clampLines(wrapWords(by["הערה"], W - 2 * M - lw, (s) => ctx.measureText(s).width), 3);
    if (draw) {
      ctx.fillStyle = C.sub; font(ctx, 24, 700); ctx.fillText("הערה", W - M, y + 30);
      ctx.fillStyle = C.ink; font(ctx, 26, 400);
      lines.forEach((l, i) => ctx.fillText(l, W - M - lw, y + 30 + i * 36));
    }
    y += lines.length * 36 + 6;
  }
  return y + 16 - y0;
}

function drawPhotos(ctx, imgs, area) {
  const cells = layoutPhotos(imgs.length, area);
  imgs.forEach((img, i) => {
    const f = fitContain(img.naturalWidth || img.width, img.naturalHeight || img.height, cells[i]);
    // ⚠️ צמוד לראש התא ולא ממורכז לגובה: שתי תמונות רחבות זו ליד זו ממלאות רק חלק מהגובה, ומרכוז השאיר
    // מעליהן רווח לבן גדול — נראה כמו עמוד שבור.
    f.y = cells[i].y;
    ctx.drawImage(img, f.x, f.y, f.w, f.h);
    ctx.strokeStyle = C.line; ctx.lineWidth = 2;
    ctx.strokeRect(f.x, f.y, f.w, f.h);
  });
}

const toJpeg = (canvas) => new Promise((resolve, reject) =>
  canvas.toBlob((b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a)), reject) : reject(new Error("הציור נכשל"))), "image/jpeg", 0.9));

/**
 * @param {object} p
 * @param {{site_name?:string,name?:string,code:string}} p.site
 * @param {string|null} [p.machineLabel]
 * @param {Array<{defect:object, report?:{inspected_on,kindLabel}|null, photoUrls:string[]}>} p.fixes — לפי הסדר (fixesForPdf)
 * @param {string} [p.logoUrl]
 * @param {Date} [p.now]
 * @returns {Promise<Blob>}
 */
export async function buildFixesPdf({ site, machineLabel = null, fixes, logoUrl = "/parkomat-logo.png", now = new Date() }) {
  if (!fixes?.length) throw new Error("אין תיקונים למסמך");
  if (document.fonts?.ready) await document.fonts.ready;
  const logo = await loadImage(logoUrl).catch(() => null);      // בלי לוגו — המסמך עדיין תקין
  const made = `${formatDateIL(todayIL(now))} ${new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now)}`;
  const siteName = site?.site_name ?? site?.name ?? "";
  const total = fixes.length;
  const title = total > 1 ? "דיווח תיקון ליקויים" : "דיווח תיקון ליקוי";
  const reports = fixes.map((f) => f.report).filter(Boolean);
  const multiReport = new Set(reports.map((r) => r.inspected_on)).size > 1;
  const items = fixes.map((f) => ({ ...f, facts: fixFacts({ defect: f.defect, report: multiReport ? f.report : null }) }));

  // ---- מדידה ותכנון — על עמוד-טיוטה, בלי לצייר ----
  const probe = newPage().ctx;
  const summary = summaryFacts({ site, machineLabel, reports, count: total });
  const firstTop = factsTable(probe, summary, 300, false) + 40;
  const nextTop = 300;
  // ⚠️ כשיש כמה תיקונים התמונות קטנות יותר (460 ולא 560) — כך שניים נכנסים בעמוד במקום עמוד לכל תיקון
  const plan = planPages(items.map((it) => ({ textH: fixBlock(probe, it, 0, total, 0, false), photos: it.photoUrls.length })),
    { firstTop, nextTop, bottom: BOTTOM, photoMax: total > 1 ? 460 : 560, photoMin: 280 });
  const pageCount = plan[plan.length - 1].page + 1;

  // ---- ציור, עמוד אחר עמוד — כל עמוד נארז ל-JPEG ומשוחרר מיד (טלפון עם עשרים תמונות) ----
  const jpegs = [];
  for (let p = 0; p < pageCount; p++) {
    const { canvas, ctx } = newPage();
    header(ctx, logo, p === 0 ? title : `${title} (המשך)`, `לבודק המוסמך${siteName ? ` · ${siteName}` : ""}`);
    if (p === 0) factsTable(ctx, summary, 300);
    for (let i = 0; i < items.length; i++) {
      if (plan[i].page !== p) continue;
      const it = items[i];
      const y = plan[i].y;
      const textH = fixBlock(ctx, it, i, total, y);
      if (it.photoUrls.length) {
        const imgs = await Promise.all(it.photoUrls.map(loadImage));
        drawPhotos(ctx, imgs, { x: M, y: y + textH, w: W - 2 * M, h: plan[i].photoH });
      } else {
        ctx.fillStyle = C.muted; font(ctx, 24, 400); ctx.fillText("לא צורפה תמונה", W - M, y + textH + 34);
      }
      // קו מפריד בין תיקונים באותו עמוד
      if (i < items.length - 1 && plan[i + 1].page === p) {
        const end = y + textH + plan[i].photoH + 20;
        ctx.strokeStyle = C.brand; ctx.globalAlpha = 0.25; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(M, end); ctx.lineTo(W - M, end); ctx.stroke(); ctx.globalAlpha = 1;
      }
    }
    footer(ctx, made, p + 1, pageCount);
    jpegs.push(await toJpeg(canvas));
  }

  const pdf = jpegPagesToPdf(jpegs.map((jpeg) => ({ jpeg, width: W, height: H })), {
    title: `${title}${siteName ? ` — ${siteName}` : ""}`,
  });
  return new Blob([pdf], { type: "application/pdf" });
}
