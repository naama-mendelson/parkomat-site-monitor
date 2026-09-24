// services/rowsChunked.js — השורות הגולמיות של תקופה, בקריאות לפי חודש.
//
// ============================================================
// ⚠️ למה זה קיים — ולמה זה לא מדד
// ============================================================
// חלון התובנות ויומן הפעילות מחשבים ב-JS (computeInsights / buildActivityLog
// נשארים שם — CLAUDE.md), ולכן הם צריכים את השורות עצמן. עד 24/09/2026 הן
// נשלפו דרך PostgREST בדפדוף של 1,000 שורות, עם תקרה — ו"כל האתרים" בתצוגת
// שנה עבר אותה: "התקופה גדולה מכדי לטעון במלואה".
//
// public.insights_rows / public.activity_rows מחזירות **אותן** שורות, באותם
// תנאים, כמערכים (בלי שמות שדות בכל שורה). כאן הן מורכבות בחזרה לאותם
// אובייקטים בדיוק — ולכן המספרים על המסך זהים מעצם ההגדרה.
//
// ⚠️ **חלוקה לשבועות, ולא קריאה אחת**: ל-authenticated יש statement_timeout
// של 8s, ו-activity_rows לשנה המלאה כבר נמדדה 2.5–4.8s — קריאה אחת הייתה
// נופלת לפני סוף השנה, והמסך כולו איתה.
//
// ⚠️ **ולא לחודשים — זה נמדד ונפסל.** הנתונים אינם מפוזרים שווה: יותר אתרים
// מדווחים כל חודש, וחלק של ספטמבר לבדו (≈14 אלף פעולות) לקח 4.6s. שבוע הוא
// ≈3.5 אלף שורות לסוג — הרחק מהמגבלה, גם כשהצי יגדל.
//
// ⚠️ **ועד 6 בקשות במקביל.** שנה היא ~53 שבועות; שליחת כולן בבת אחת על מסד
// חינמי שכבר עמוס ברענוני הכרטיסים הייתה מאטה את כל שאר המסכים.
import { supabase } from "./supabase";

const PART_MS = 7 * 86400000;
const PARALLEL = 6;

/** גבולות כל 7 ימים בתוך [from, to) — החלוקה בלבד, בלי משמעות. */
function cutsOf(from, to) {
  const cuts = [];
  for (let t = Date.parse(from) + PART_MS; t < Date.parse(to); t += PART_MS) {
    cuts.push(new Date(t).toISOString());
  }
  return cuts;
}

/** מריץ את המשימות עם תקרת מקביליות, ושומר על הסדר. */
async function pooled(tasks, limit) {
  const out = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return out;
}

const expand = ({ cols, rows }) =>
  rows.map((r) => {
    const o = {};
    for (let i = 0; i < cols.length; i++) o[cols[i]] = r[i];
    return o;
  });

/**
 * @param fn        "insights_rows" | "activity_rows"
 * @param siteId    מזהה אתר, או null לכל האתרים
 * @param desc      true כשהפונקציה ממיינת בסדר יורד (הלוג) — החלקים משורשרים הפוך
 * @returns {Promise<Record<string, object[]>>} מפתח לכל סוג שורות
 */
export async function fetchRowsChunked(fn, siteId, from, to, { desc = false } = {}) {
  const cuts = cutsOf(from, to);
  // ⚠️ החלק הראשון מתחיל ב-'' — הקטן מכל מחרוזת — כדי לכלול מקטע מצב שהתחיל
  // לפני התקופה ונמשך לתוכה. תנאי התקופה עצמה נשאר בצד ה-SQL.
  const starts = ["", ...cuts];
  const ends = [...cuts, null];

  const parts = await pooled(starts.map((pf, i) => () =>
    supabase.rpc(fn, {
      p_site_id: siteId, p_from: from, p_to: to, p_part_from: pf, p_part_to: ends[i],
    })), PARALLEL);

  const failed = parts.find((p) => p.error);
  if (failed) {
    throw new Error(failed.error.code === "42501"
      ? "אין הרשאת קריאה — נדרשת התחברות"
      : failed.error.message || "השליפה נכשלה");
  }

  const ordered = desc ? [...parts].reverse() : parts;
  const out = {};
  for (const key of Object.keys(ordered[0].data || {})) {
    out[key] = ordered.flatMap((p) => expand(p.data[key]));
  }
  return out;
}
