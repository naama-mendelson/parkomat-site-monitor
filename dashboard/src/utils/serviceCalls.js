// utils/serviceCalls.js — קריאות השירות של ויזנט: פונקציות טהורות (נבדקות ב-master/tests/service-calls-ui.test.js).

// ============================================================
// ⚠️ דולק מ-14/10/2026 — הרשימות נטענו והקריאות מגיעות
// ============================================================
// היה כבוי עד שרשימות ויזנט נטענו: בלי רשימת הסטטוסים אין דרך לדעת איזו קריאה סגורה, והסימון היה
// סופר גם סגורות. ב-13/10 נטענו 20 סטטוסים ו-11 סוגים, ב-14/10 סומנו עשרה כסגורים (בחירת בעלת
// המוצר) וויזנט הדליקו את השליחה אלינו — ולכן ברירת המחדל הפוכה. `VITE_SERVICE_CALLS=false` מכבה.
export const SERVICE_CALLS_ENABLED = String(import.meta.env?.VITE_SERVICE_CALLS ?? "true") !== "false";

// ============================================================
// ⚠️ שינוי סטטוס/סוג — כבוי, ולא בגללנו
// ============================================================
// העדכון חזרה עובר ל-WIZEAPI, וויזנט חוסמים גישה מחוץ לישראל (תשובתם, 14/10/2026): הטוקן הוא
// שכבת אבטחה נוספת ואינו מחליף את הגבלת הגישה. ל-Edge Functions של Supabase אין
// כתובת יוצאת קבועה, ולכן עד שיוקם ממסר עם IP קבוע — הקריאות **מוצגות בלבד**.
// ⚠️ בלי הדגל הזה הבורר נראה עובד, ולחיצה עליו מסתיימת ב"ויזנט לא ענו בזמן" אחרי 15 שניות.
// ההחזרה: VITE_SERVICE_CALLS_WRITE=true, אחרי שהממסר קיים והכתובת אושרה אצלם.
export const SERVICE_CALLS_WRITE = String(import.meta.env?.VITE_SERVICE_CALLS_WRITE ?? "false") === "true";

/**
 * שורות service_call_counts → { [siteId]: { open, recent } }
 * open — פתוחות עכשיו (בכל גיל); recent — כל מה שהגיע ב-24 השעות, כולל סגורות.
 * ⚠️ מסד ישן אינו מחזיר recent — אז הוא 0, והכרטיס מתנהג כמו קודם (רק פתוחות).
 */
export function countsBySite(rows) {
  const out = {};
  for (const r of rows ?? []) {
    if (r?.site_id == null) continue;
    const cur = out[r.site_id] ?? { open: 0, recent: 0 };
    out[r.site_id] = { open: cur.open + (Number(r.open) || 0), recent: cur.recent + (Number(r.recent) || 0) };
  }
  return out;
}

// ============================================================
// ⚠️ מה שוויזנט שולחים אינו טקסט נקי
// ============================================================
// נמדד על הקריאות האמיתיות: `notes` מגיע כ-HTML — `<br />`, `<br>`, `&nbsp;`, `\r\n`, ולפעמים
// `~~~` כמפריד — והוא **פותח כמעט תמיד במספר הטלפון**, שכבר מוצג שורה מעליו. `customer_complaint`
// לפעמים אינו תוכן בכלל: קוד האתר ("3461"), "ללא נושא", או מחרוזת ריקה.
// בלי הניקוי הזה המסך הראה "0547721538<br /> &nbsp;" מתחת לטלפון עצמו.

/** טקסט מוויזנט → טקסט רגיל: בלי תגיות, בלי ישויות, שורות מופרדות ב-" · " */
export function cleanText(s) {
  return String(s ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/~~~+/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .split("\n").map((x) => x.trim()).filter(Boolean)
    .join(" · ");
}

const onlyDigits = (s) => String(s ?? "").replace(/\D/g, "");

/**
 * מה באמת כתוב בקריאה — שורה אחת או שתיים, בלי כפילות הטלפון ובלי "ללא נושא".
 * ⚠️ מחזיר מערך ולא מחרוזת: התלונה והפירוט הם שתי רמות, והמסך מדגיש את הראשונה.
 */
export function callText(c) {
  const ph = onlyDigits(c?.phone);
  const useful = (t) => {
    const x = cleanText(t);
    if (!x) return "";
    // ⚠️ "רק מספר" נבדק על הטקסט כולו ולא על הספרות שבו: הערה שמתחילה בטלפון וממשיכה במילים
    // היא תוכן, ובדיקה על הספרות בלבד הייתה מוחקת אותה (נמצא בבדיקות, 14/10/2026).
    if (!/[A-Za-zא-ת]/.test(x)) return "";                      // אין בכלל מילים — קוד או טלפון
    if (/^ללא נושא$/i.test(x)) return "";
    return x;
  };
  let head = useful(c?.complaint);
  let rest = useful(c?.notes);
  if (ph && rest) {
    // ההערות פותחות (או נגמרות) במספר הטלפון שכבר מוצג
    const re = new RegExp(`(^|·\\s*)${ph.replace(/(\d)/g, "$1[\\s-]?")}(\\s*·|$)`, "g");
    rest = cleanText(rest.replace(re, " · ").replace(/^\s*·\s*|\s*·\s*$/g, ""));
  }
  if (rest && head && (rest.includes(head) || head.includes(rest))) rest = rest.length > head.length ? rest : "";
  if (!head && rest) { head = rest; rest = ""; }
  return [head, rest].filter(Boolean);
}

/**
 * "חניה" מוצגת רק כשהיא מוסיפה מידע: קוד מלא כולל מתקן/כרטיס ("1226-1-02").
 * ⚠️ מאז 08/10 ויזנט שולחים את קוד הפרויקט לבדו ("3452") — והוא כבר כתוב כקוד האתר.
 */
export function parkingDetail(c) {
  const pk = String(c?.parking_code ?? "").trim();
  return pk && /[-/]/.test(pk) ? pk : "";
}

/** "קריאה אחת · פתוחה" / "3 קריאות · 2 פתוחות" / "3 קריאות · הכול סגור" */
export function callsSummary(calls) {
  const n = calls?.length ?? 0;
  if (!n) return "";
  const open = calls.filter((c) => c.open !== false).length;
  const head = n === 1 ? "קריאה אחת" : `${n} קריאות`;
  if (open === 0) return `${head} · הכול סגור`;
  if (open === n) return n === 1 ? `${head} · פתוחה` : `${head} · כולן פתוחות`;
  return `${head} · ${open === 1 ? "אחת פתוחה" : `${open} פתוחות`}`;
}

/** "דנה כהן", או "—" כשאין שם */
export function callerName(c) {
  const n = [c?.first_name, c?.last_name].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ");
  return n || "—";
}

/** זמן אמיתי (שלנו, UTC) → "13/10 09:42" בשעון ישראל */
export function israelLabel(raw) {
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return String(raw);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.day}/${parts.month} ${parts.hour}:${parts.minute}`;
}

// ============================================================
// ⚠️ ויזנט שולחים **שעון ישראל** עם סיומת Z — ולכן אין להמיר אותו
// ============================================================
// נמדד ב-14/10/2026 על הקריאות האמיתיות: `updated_at` של הודעה הוא שנייה־שתיים **לפני** שעת ההגעה
// שלנו, אבל מסומן שלוש שעות קדימה. למשל 12:40:46Z על הודעה שהתקבלה ב-09:40:47 UTC. כלומר ה-Z אינו
// UTC אלא שעון מקומי.
//
// התוצאה לפני התיקון: הוספנו עוד שלוש שעות, וקריאה שנפתחה ב-12:40 הוצגה כ-15:40 — **שעה שעוד לא
// הגיעה**. בעלת המוצר: "הזמן שמוצג לא הגיוני, עדיין לא הגיע השעה הזו".
//
// ⚠️ ולכן יש כאן שתי פונקציות ולא אחת: `received_at` ו-`changed_at` הם **שלנו**, זמן UTC אמיתי,
// וחייבים המרה. כל מה שהגיע מוויזנט — מוצג כמו שנכתב.

/** זמן מוויזנט → השעון שכתוב בו, בלי שום המרה */
export function wizenetLabel(raw) {
  const m = String(raw ?? "").match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  return m ? `${m[3]}/${m[2]} ${m[4]}:${m[5]}` : String(raw ?? "");
}

/** מתי נפתחה: השעה שוויזנט כתבו; וכשאין — שעת ההגעה אלינו, בשעון ישראל */
export function openedLabel(c) {
  if (c?.opened_at) return wizenetLabel(c.opened_at);
  return israelLabel(c?.received_at);
}

/**
 * אפשרויות לבורר: הרשימה מוויזנט, ו⚠️ הערך הנוכחי גם כשאינו ברשימה — בורר שאין בו את הערך הנוכחי מציג
 * את הראשון ברשימה, וזה נראה כמו "הסטטוס הוא X" כשהוא לא.
 */
export function optionsFor(list, currentId, currentName) {
  const opts = (list ?? []).map((o) => ({ id: String(o.id), name: o.name }));
  if (currentId != null && currentId !== "" && !opts.some((o) => o.id === String(currentId))) {
    opts.unshift({ id: String(currentId), name: currentName || `לא מוכר (${currentId})` });
  }
  return opts;
}
