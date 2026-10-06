// utils/pdfItems.js — תיקון הטקסט ש-pdfjs מחלץ מתסקיר, לפני שמישהו קורא או מעתיק אותו.
//
// קובץ טהור (בלי pdfjs ובלי DOM) — נבדק ב-node: master/tests/pdf-items.test.js.
//
// ============================================================
// 1. קידוד עברי ישן: "מסומðים" במקום "מסומנים"
// ============================================================
// נמדד על תסקיר אמיתי (06/10/2026): כל "נ" בו נשלפה כ-"ð" — "לתיקוðים", "ðושא".
// הגופן שומר את האותיות לפי Windows-1255, שבו נ = 0xF0, ובלי מפת יוניקוד נכונה
// pdfjs מפרש את הקוד כ-Latin-1 — שבו 0xF0 הוא ð. בעלת המוצר העתיקה ליקוי והדביקה
// "מסומðים" לטופס.
//
// התיקון: בקטע שיש בו עברית, à–ú (0xE0–0xFA) חוזרים לאותיות א–ת שבאותם מקומות
// ב-1255 (à→א … ð→נ … ú→ת). ⚠️ רק בקטע שכבר יש בו עברית (או שמסומן rtl): מילה
// צרפתית באנגלית ("café") לא נוגעים בה.
//
// ⚠️ **מה שהוכח, ומה לא.** הוכח: אות שבורה **בודדת** בתוך מילה עברית (המסמך שנמדד —
// רק "נ" נשברה). לא הוכח, ולא מטופל: pdfjs מסדר את העברית בקטע לסדר קריאה ומתייחס
// לאותיות השבורות כלטיניות — ולכן **רצף** של שתי אותיות שבורות או יותר עלול לצאת בסדר
// הפוך, וקטע שכולו אותיות שבורות מסומן ltr ואינו מתוקן כלל (סקירת קוד, 06/10/2026).
// אין מסמך כזה למדוד עליו; תיקון של סדר על סמך תיאוריה היה עלול לשבור את מה שעובד.
//
// ============================================================
// 2. רווח שאינו במסמך: "לחזק7אומים"
// ============================================================
// באותו תסקיר "יש לחזק", "7" ו-"אומים…" הם שלושה קטעים נפרדים, ובין שניהם יש
// מרווח בעמוד — אבל אין תו רווח. הדפדפן מעתיק את שכבת הטקסט כרצף של הקטעים,
// ולכן הם נדבקו. כאן נוסף קטע " " במרווח עצמו, כשבין שני קטעים סמוכים על אותה
// שורה יש פער של לפחות 15% מגודל הגופן. ⚠️ קטע נפרד ולא רווח בסוף המחרוזת: שכבת
// הטקסט מותחת כל קטע לרוחב שלו בעמוד, ורווח נוסף היה מכווץ את האותיות השקופות
// והסימון היה נופל לצד המילים. ⚠️ ופער של אפס לא מקבל רווח: "יו"+"ם" הם מילה אחת
// שנחתכה לשני קטעים (נמדד באותו מסמך).
// ⚠️ ולא כשיש טקסט אחר בתוך המרווח: בטבלאות סדר הקטעים אינו תמיד סדר המיקום, והרווח
// נמתח על פני כל המרווח — קטע שיושב בתוכו היה מתכסה ואי אפשר היה לסמן אותו.
//
// ⚠️ הרווחים — לשכבת הטקסט בלבד, לא לקריאת התאריכים: שם תאריך מפוצל לספרות
// ("20" "2" "7") מורכב לפי מיקום, ורווח באמצע היה שובר אותו.

const HEB = /[א-ת]/;
const CP1255_LETTERS = /[à-ú]/g;

/** קטע אחד: אותיות 1255 שנקראו כ-Latin-1 → עברית. רק כשיש עברית בקטע או שהוא rtl. */
export function repairHebrewEncoding(str, dir) {
  if (typeof str !== "string" || !/[à-ú]/.test(str)) return str;
  if (!HEB.test(str) && dir !== "rtl") return str;
  return str.replace(CP1255_LETTERS, (c) => String.fromCharCode(0x05D0 + c.charCodeAt(0) - 0xE0));
}

/** תיקון הקידוד על כל הקטעים. מחזיר את אותו מערך כשאין מה לתקן. */
export function repairItems(items) {
  let changed = false;
  const out = items.map((it) => {
    const str = repairHebrewEncoding(it.str, it.dir);
    if (str === it.str) return it;
    changed = true;
    return { ...it, str };
  });
  return changed ? out : items;
}

const GAP_EM = 0.15;   // פער מינימלי לרווח, ביחס לגודל הגופן (רווח בין מילים ≈ 0.25–0.33)
// גובה הגופן — מהקנה האנכי: האופקי קטן יותר בטקסט דחוס, והיה מוסיף רווחים בין אותיות
const fontSize = (it) => Math.hypot(it.transform[2], it.transform[3]) || it.height || 0;

/**
 * קטע " " במרווח שבין שני קטעים סמוכים על אותה שורה, כשאין רווח בקצה של אף
 * אחד מהם ואין טקסט אחר בתוך המרווח. לשכבת הטקסט בלבד (ראו למעלה).
 */
export function addGapSpaces(items) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    out.push(a);
    const b = items[i + 1];
    if (!b || a.hasEOL || !a.str || !b.str || !a.transform || !b.transform) continue;
    if (/\s$/.test(a.str) || /^\s/.test(b.str)) continue;
    const fs = fontSize(a);
    if (!(fs > 0)) continue;
    const y = a.transform[5];
    if (Math.abs(y - b.transform[5]) > fs * 0.3) continue;   // לא אותה שורה
    const a0 = a.transform[4], a1 = a0 + (a.width || 0);
    const b0 = b.transform[4], b1 = b0 + (b.width || 0);
    // הפער בין שתי הקופסאות, בלי קשר לכיוון הקריאה (בעברית b משמאל ל-a)
    const left = b1 <= a0 ? b1 : a1;
    const gap = b1 <= a0 ? a0 - b1 : b0 - a1;
    if (!(gap >= fs * GAP_EM)) continue;
    const right = left + gap;
    const covers = items.some((c, k) => k !== i && k !== i + 1 && c.transform && c.str && c.str.trim()
      && Math.abs(c.transform[5] - y) <= fs * 0.3
      && Math.min(right, c.transform[4] + (c.width || 0)) - Math.max(left, c.transform[4]) > 0.5);
    if (covers) continue;
    const t = a.transform.slice();
    t[4] = left;
    // gapSpace — כדי ששכבת הטקסט תמתח את הקטע לרוחב המרווח (ראו pdfText.js)
    out.push({ ...a, str: " ", dir: "ltr", transform: t, width: gap, hasEOL: false, gapSpace: true });
  }
  return out;
}

// ============================================================
// 3. הדבקה (וגרירה) לשורת ליקוי
// ============================================================
// ליקוי שנשבר לשתי שורות במסמך מועתק עם ירידת שורה. שדה של שורה אחת (input)
// **מוחק** אותה בשקט — והמילה האחרונה של שורה 1 נדבקת לראשונה של שורה 2. כאן
// כל רצף רווחים/ירידות שורה הופך לרווח אחד, ותווי כיוון ורוחב-אפס שהדפדפן
// עשוי להוסיף בהעתקה מטקסט מעורב נמחקים. ⚠️ ולא נוגעים במילים עצמן.
// ⚠️ לפי קוד ולא כתווים בתוך ביטוי: תו כיוון בקוד המקור אינו נראה, ועורך עלול
// להציג את השורה אחרת ממה שהיא באמת.
const INVISIBLE = [[0x00AD, 0x00AD], [0x200B, 0x200F], [0x202A, 0x202E], [0x2066, 0x2069], [0xFEFF, 0xFEFF]];
const visible = (ch) => { const c = ch.codePointAt(0); return !INVISIBLE.some(([lo, hi]) => c >= lo && c <= hi); };

// ⚠️ תיקון הקידוד **לפי מילה**: רק מילה שיש בה עברית. על כל ההדבקה בבת אחת
// "תקן café" היה הופך ל-"תקן cafי" (סקירת קוד, 06/10/2026).
const repairWords = (s) => s.split(/(\s+)/).map((w) => (HEB.test(w) ? repairHebrewEncoding(w, "rtl") : w)).join("");

export function cleanPastedText(text) {
  if (typeof text !== "string") return "";
  const plain = [...text].filter(visible).join("");
  return repairWords(plain).split(/\s+/).filter(Boolean).join(" ");
}

/**
 * הכנסת טקסט מנוקה לערך של שדה, במקום [s0, s1).
 * ⚠️ רווח בקצה של מה שהועתק נשמר כשבצד השני יש מילה — אחרת שורה שנייה שמודבקת
 * אחרי הראשונה נדבקת אליה ("…את" + "הבורג" → "…אתהבורג"). בקצה השדה או ליד רווח — לא.
 */
export function insertCleaned(value, s0, s1, raw) {
  const text = cleanPastedText(raw);
  const plain = [...raw].filter(visible).join("");
  const before = value.slice(0, s0), after = value.slice(s1);
  const lead = text && /^\s/.test(plain) && before && !/\s$/.test(before) ? " " : "";
  const trail = text && /\s$/.test(plain) && after && !/^\s/.test(after) ? " " : "";
  const ins = lead + text + trail;
  return { value: before + ins + after, caret: s0 + ins.length };
}

function apply(el, setValue, raw, s0, s1) {
  const v = el.value ?? "";
  const max = el.maxLength > 0 ? el.maxLength : Infinity;
  const r = insertCleaned(v, s0, s1, raw);
  const next = r.value.slice(0, max);
  setValue(next);
  const caret = Math.min(r.caret, next.length);
  requestAnimationFrame(() => { try { el.setSelectionRange(caret, caret); } catch { /* השדה נעלם */ } });
}

/**
 * onPaste לשדה טקסט מבוקר (React): מדביק את הטקסט המנוקה במקום הסימון,
 * וקורא ל-setValue עם הערך החדש. ⚠️ preventDefault רק כשיש טקסט — הדבקה של
 * קובץ או של משהו אחר עוברת כרגיל.
 */
export function pasteCleaned(e, setValue) {
  const raw = e.clipboardData?.getData("text/plain");
  if (!raw) return;
  e.preventDefault();
  const el = e.currentTarget;
  const v = el.value ?? "";
  apply(el, setValue, raw, el.selectionStart ?? v.length, el.selectionEnd ?? v.length);
}

/**
 * onDrop לאותו שדה: טקסט שנגרר מהמסמך אל השדה עובר אותו ניקוי — בלעדיו הדפדפן
 * מוחק את ירידת השורה ומדביק מילים, בדיוק מה שההדבקה מתקנת. הטקסט נוסף בסוף
 * (בשחרור אין מיקום סמן אמין). ⚠️ קבצים — לא כאן: גרירת PDF מטופלת בעמוד.
 */
export function dropCleaned(e, setValue) {
  const dt = e.dataTransfer;
  if (!dt || (dt.files && dt.files.length > 0)) return;
  const raw = dt.getData("text/plain");
  if (!raw) return;
  e.preventDefault();
  const el = e.currentTarget;
  const v = el.value ?? "";
  el.focus?.();
  apply(el, setValue, v && !/\s$/.test(v) ? ` ${raw}` : raw, v.length, v.length);
}
