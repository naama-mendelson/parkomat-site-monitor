// utils/complianceFiles.js — קבצים לבודק ולתחזוקה המונעת: base64, דחיסה, מזהים.
//
// ⚠️ אותה מוסכמה כמו ב-services/fieldReportsDirect.js: ה-base64 נשמר **נטו**,
// בלי הקידומת `data:image/jpeg;base64,`. ה-mime יושב בעמודה שלידו, והקידומת
// נבנית רק בתצוגה. (fieldReportsDirect.js אינו משתנה — זה עותק מכוון ולא
// שיתוף: שם התקרה 2MB ותמונה אחת, כאן תמונה + תמונה ממוזערת בפענוח אחד.)
//
// קובץ בלי React ובלי Supabase — אפשר לייבא אותו מכל מקום.

const MAX_EDGE = 1280;
const QUALITY = 0.82;
const THUMB_EDGE = 320;
const THUMB_QUALITY = 0.7;

// ⚠️ התקרות של הטבלה הן 1MB לתמונה ו-40KB לממוזערת (CHECK במסד). דחיסה
// שיוצאת מעליהן נדחית בשרת אחרי שהטכנאי כבר המתין להעלאה; לכן מנסים שוב
// באיכות נמוכה יותר **לפני** שליחה. הערכים מעט מתחת לתקרה, בכוונה.
const PHOTO_SOFT_MAX = 950 * 1024;
const THUMB_SOFT_MAX = 38 * 1024;

export const PHOTO_ACCEPT = "image/jpeg,image/webp,image/heic,image/heif,.heic,.heif,.jpg,.jpeg,.webp";

/** מזהה לקוח ל-idempotency: אותו מזהה בכל ניסיון חוזר של אותה פעולה. */
export function newId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // ⚠️ randomUUID קיים רק בהקשר מאובטח (https/localhost). שרת פיתוח שנפתח
  // מכתובת IP ברשת הוא http — ושם בלי זה כל העלאה הייתה נופלת על TypeError.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** גודל הבתים של מחרוזת base64 נטו (בלי לפענח אותה). */
export function base64Bytes(b64) {
  if (!b64) return 0;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/** File/Blob → base64 נטו. FileReader ולא btoa על מחרוזת: PDF של 8MB הופך btoa ללולאה של שניות. */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("קריאת הקובץ נכשלה"));
    reader.onload = () => {
      const s = String(reader.result || "");
      const comma = s.indexOf(",");
      if (comma === -1) reject(new Error("קריאת הקובץ נכשלה"));
      else resolve(s.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** base64 נטו → Blob. */
export function base64ToBlob(b64, mime = "application/octet-stream") {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * base64 נטו → כתובת blob: לתצוגה/הורדה.
 * ⚠️ ולא כתובת data: — דפדפנים חוסמים ניווט ל-data: בחלון עליון, ו-PDF של
 * כמה MB כמחרוזת ב-DOM הוא זיכרון כפול. ⚠️ מי שקורא לזה אחראי ל-
 * URL.revokeObjectURL כשהתצוגה נסגרת.
 */
export function base64ToBlobUrl(b64, mime) {
  return URL.createObjectURL(base64ToBlob(b64, mime));
}

function canvasToB64(canvas, quality) {
  const url = canvas.toDataURL("image/jpeg", quality);
  const comma = url.indexOf(",");
  if (comma === -1 || !url.startsWith("data:image/jpeg")) throw new Error("דחיסת התמונה נכשלה");
  return url.slice(comma + 1);
}

function drawScaled(source, sw, sh, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("דחיסת התמונה נכשלה");
  // רקע לבן: WebP/HEIC עם שקיפות היה יוצא שחור ב-JPEG.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, w, h);
  return canvas;
}

function encodeUnder(canvas, quality, softMax) {
  let q = quality;
  let data = canvasToB64(canvas, q);
  while (base64Bytes(data) > softMax && q > 0.45) {
    q = Math.round((q - 0.12) * 100) / 100;
    data = canvasToB64(canvas, q);
  }
  return data;
}

/**
 * תמונה (jpeg/webp/heic) → `{ mime: "image/jpeg", data, thumb }`, שניהם base64 נטו.
 *
 * ⚠️ **פענוח אחד.** צילום של 12MP הוא ~48MB בזיכרון אחרי פענוח, וטלפון
 * ישן שמפענח אותו פעמיים (פעם לתמונה ופעם לממוזערת) נהרג באמצע — הלשונית
 * נטענת מחדש והטופס כולו נעלם. לכן הממוזערת (320px) מצוירת **מהקנבס של
 * 1280**, לא מהקובץ.
 *
 * ⚠️ resizeWidth/resizeHeight **אינם** מועברים ל-createImageBitmap, בניגוד
 * למה שנשקל: יחס הצלעות אינו ידוע לפני הפענוח, ולכן אי אפשר לבחור איזו צלע
 * לכווץ — ותמונה קטנה הייתה מוגדלת. העותק הגדול נסגר (close) מיד אחרי
 * הציור הראשון.
 */
export async function compressWithThumb(file) {
  let bitmap;
  try {
    // בלי options, כמו ב-compressImage: ברירת המחדל מכבדת את ה-EXIF בדפדפנים
    // מודרניים, וגרסאות ספארי ישנות זורקות על מילון options שאינן מכירות.
    bitmap = await createImageBitmap(file);
  } catch {
    // ⚠️ HEIC נקרא רק ב-Safari. בכרום/אנדרואיד הוא זורק כאן — והמשתמש צריך
    // לדעת שהבעיה בפורמט, לא ברשת.
    const heic = /hei[cf]$/i.test(file?.name || "") || /hei[cf]/i.test(file?.type || "");
    throw new Error(
      heic
        ? "הדפדפן הזה אינו קורא תמונות HEIC — צלמו מתוך הדף, או בחרו תמונת JPEG"
        : `"${file?.name || "הקובץ"}" אינו תמונה שאפשר לקרוא`,
    );
  }
  let main;
  try {
    main = drawScaled(bitmap, bitmap.width, bitmap.height, MAX_EDGE);
  } finally {
    bitmap.close?.();
  }
  const data = encodeUnder(main, QUALITY, PHOTO_SOFT_MAX);
  const thumbCanvas = drawScaled(main, main.width, main.height, THUMB_EDGE);
  const thumb = encodeUnder(thumbCanvas, THUMB_QUALITY, THUMB_SOFT_MAX);
  // שחרור הזיכרון של הקנבסים מיד (ספארי מחזיק אותם עד GC, ויש לו תקרה כוללת)
  main.width = main.height = 0;
  thumbCanvas.width = thumbCanvas.height = 0;
  return { mime: "image/jpeg", data, thumb };
}
