// utils/serviceCalls.js — קריאות השירות של ויזנט: פונקציות טהורות (נבדקות ב-master/tests/service-calls-ui.test.js).

// ============================================================
// ⚠️ כבוי עד שהרשימות של ויזנט נטענות
// ============================================================
// בלי רשימת הסטטוסים אין דרך לדעת איזו קריאה סגורה — הסימון היה סופר גם סגורות — והבוררים היו מציגים
// מספרים במקום שמות. ההפעלה: VITE_SERVICE_CALLS=true ב-Cloudflare Pages, אחרי שהרשימות נטענו ונבדקו.
// ⚠️ ברירת המחדל כבויה, כמו PM_ENABLED: בנייה שאיש לא הגדיר נותנת את מה שהוחלט.
export const SERVICE_CALLS_ENABLED = String(import.meta.env?.VITE_SERVICE_CALLS ?? "false") === "true";

/** שורות service_call_counts → { [siteId]: { open } } */
export function countsBySite(rows) {
  const out = {};
  for (const r of rows ?? []) {
    if (r?.site_id == null) continue;
    out[r.site_id] = { open: (out[r.site_id]?.open ?? 0) + (Number(r.open) || 0) };
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
