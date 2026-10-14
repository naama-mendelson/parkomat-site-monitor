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

/** "דנה כהן", או "—" כשאין שם */
export function callerName(c) {
  const n = [c?.first_name, c?.last_name].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ");
  return n || "—";
}

/**
 * מתי נפתחה — "13/10 09:42" בשעון ישראל. ויזנט שולחים opened_at כטקסט; כשאינו תאריך — מוצג כמו שהוא,
 * וכשאין — שעת ההגעה אלינו.
 */
export function openedLabel(c) {
  const raw = c?.opened_at || c?.received_at;
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return String(raw);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.day}/${parts.month} ${parts.hour}:${parts.minute}`;
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
