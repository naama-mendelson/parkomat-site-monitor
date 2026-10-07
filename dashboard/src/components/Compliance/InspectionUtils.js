// components/Compliance/InspectionUtils.js — עזרים טהורים ללשונית "בודק מוסמך".
//
// ⚠️ אין כאן החלטה על צבע ואין כאן סף. צבע הנורה, מצב המועד של כל ליקוי ומצב המחזור מגיעים
// מ-`inspection_site` (שמחשב אותם ב-SQL, app.compliance_machine_rows). מה שכאן
// רק **מארגן** את התשובה לתצוגה: איזה דוח שייך לאיזה מחזור, איזה ליקוי פתוח,
// ואיך לכתוב תאריך. חישוב מקביל של "פג/בתוקף" בצד הלקוח היה נותן יום בשנה
// שבו הלשונית והכרטיס חלוקים — ושני מקורות אמת.
//
// קובץ בלי React — כדי שכלל only-export-components לא יחול על הרכיבים.
import { daysText, formatDateIL, todayIL } from "../../utils/compliance";

export const KIND_LABEL = { periodic: "תסקיר תקופתי", followup: "בדיקה חוזרת" };

// D25: המקור נגזר בשרת. התגית אומרת למנהל מאיפה התאריך הגיע — "הוזן ידנית"
// על תאריך שנראה כמו מהמסמך הוא בדיוק מה שצריך לעצור עליו.
export const SOURCE_TAG = {
  document: "מהמסמך",
  next_inspection: "מ'בדיקה הבאה'",
  manual: "הוזן ידנית",
  inherited: "כמו התקופתי",
};

// ============================================================
// תאריכים — מחרוזות בלבד
// ============================================================
// ⚠️ לא new Date("2026-11-11"): זה חצות UTC, ובישראל הערב שלפני. כל
// החשבון כאן על מספרי ימים של Date.UTC, כמו addDaysISO ב-utils/compliance.
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDate = (s) => typeof s === "string" && ISO_RE.test(s.slice(0, 10)) && s.length >= 10;

export function dayNum(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

/** כמה ימים מ-from עד to (שלילי = to עבר). */
export const daysBetween = (fromIso, toIso) => Math.round(dayNum(toIso) - dayNum(fromIso));

/** חותמת ISO-UTC → תאריך ישראלי "YYYY-MM-DD" (done_at, retired_at). */
export function ilDateOf(stamp) {
  const t = Date.parse(stamp);
  return Number.isFinite(t) ? todayIL(new Date(t)) : null;
}

/** "בתוקף עד … · עוד N ימים" / "לא בתוקף — פג לפני N ימים" / "אין תסקיר במערכת". */
export function validityText(validUntil, today) {
  if (!validUntil) return "אין תסקיר במערכת";
  const d = formatDateIL(validUntil);
  const n = daysBetween(today, validUntil);
  if (n < 0) return `לא בתוקף — פג ${n === -1 ? "אתמול" : `לפני ${-n} ימים`} (${d})`;
  // "היום"/"מחר" לבד אחרי "בתוקף עד" נקראים כמו התאריך עצמו — מפורש יותר:
  if (n === 0) return `בתוקף עד ${d} · היום האחרון`;
  if (n === 1) return `בתוקף עד ${d} · עד מחר`;
  return `בתוקף עד ${d} · ${daysText(n)}`;
}

export const fmtMB = (bytes) => `${(Math.max(0, Number(bytes) || 0) / (1024 * 1024)).toFixed(1)}`;

// גרירה של קבצים (ולא של טקסט או קישור מתוך הדף) — רק עליה מגיבים.
export const hasDraggedFiles = (e) => Array.from(e?.dataTransfer?.types || []).includes("Files");

// ============================================================
// ארגון התשובה של inspection_site
// ============================================================
export const byDateDesc = (a, b) =>
  String(b.inspected_on).localeCompare(String(a.inspected_on)) || (b.id ?? 0) - (a.id ?? 0);
const byDue = (a, b) =>
  String(a.due_on || "9999").localeCompare(String(b.due_on || "9999")) || (a.seq ?? 0) - (b.seq ?? 0);
const byDoneDesc = (a, b) => String(b.done_at || "").localeCompare(String(a.done_at || ""));

/** שם מתקן לתצוגה. */
export function machineTitle(m) {
  if (!m) return "";
  return m.label ? `${m.label} (${m.key})` : `מתקן ${m.key}`;
}

/**
 * מחזור לכל מתקן פעיל: התקופתי האחרון (periodic_id מהשרת) והבדיקות החוזרות שלו.
 *
 * ⚠️ periodic_id מגיע מהשרת ולא נבחר כאן "לפי התאריך הגבוה": זו אותה הגדרה
 * שצובעת את הנורה (התקופתי האחרון, לא max(valid_until)). בחירה מקומית
 * הייתה יכולה להציג ליקויים של מחזור אחד ליד נורה של מחזור אחר.
 */
export function deriveInspection(data) {
  const reports = Array.isArray(data?.reports) ? data.reports : [];
  const machines = Array.isArray(data?.machines) ? data.machines : [];
  const byId = new Map(reports.map((r) => [r.id, r]));
  const active = machines.filter((m) => !m.retired_at);

  const cycles = active.map((m) => {
    const pid = m.periodic_id ?? null;
    const reps = pid == null ? [] : reports.filter((r) => r.id === pid || r.followup_of === pid).sort(byDateDesc);
    const defects = reps.flatMap((r) =>
      (r.defects || []).map((d) => ({ ...d, reportId: r.id, reportKind: r.kind, reportDate: r.inspected_on })));
    return {
      key: m.key,
      machine: m,
      periodicId: pid,
      periodic: pid == null ? null : byId.get(pid) ?? null,
      reports: reps,
      open: defects.filter((d) => d.status === "open").sort(byDue),
      done: defects.filter((d) => d.status === "done").sort(byDoneDesc),
      // "הוספת ליקוי" — לדוח **האחרון** במחזור, ורק אם הוא לא סומן נקי (השרת
      // דוחה הוספה לדוח נקי). ⚠️ לא "האחרון שאינו נקי": אחרי בדיקה חוזרת נקייה
      // זה היה מציע להוסיף ליקוי לתקופתי הישן — ופותח מחדש מחזור שהבודק סגר.
      // ליקוי חדש אחרי תסקיר נקי מגיע עם תסקיר חדש.
      addTarget: reps[0] && !reps[0].declared_clean ? reps[0] : null,
      latest: reps[0] ?? null,
    };
  });

  return { reports, machines, active, byId, cycles, multi: machines.length > 1 };
}

/**
 * הליקויים הפתוחים שבדיקה חוזרת נקייה הייתה סוגרת — אותו כלל כמו
 * app.inspection_close_cycle: התקופתי, והחוזרות שלו עד תאריך הבדיקה הזו.
 */
export function openInCycleUpTo(reports, parentId, inspectedOn) {
  if (parentId == null) return [];
  return reports
    .filter((r) => r.id === parentId || (r.followup_of === parentId && (!inspectedOn || r.inspected_on <= inspectedOn)))
    .flatMap((r) => (r.defects || []).filter((d) => d.status === "open"));
}

// ============================================================
// היסטוריית השינויים — תוויות
// ============================================================
const ACTION_LABEL = {
  "report:update": "עריכת פרטי תסקיר",
  "report:delete": "מחיקת תסקיר",
  "report:close_cycle": "סגירת ליקויים בתסקיר חוזר נקי",
  "report:reopen_cycle": "ליקויים נפתחו מחדש (התסקיר הנקי בוטל)",
  "machine:retire": "הוצאת מתקן משימוש",
  "defect:create": "הוספת ליקוי",
  "defect:update": "עריכת ליקוי",
  "defect:delete": "מחיקת ליקוי",
  "defect:reopen": "פתיחה מחדש של ליקוי",
  "site:reattach": "שיוך מחדש לאתר",
  "file:purge": "מחיקה סופית של קובץ",
};
export const historyActionLabel = (h) => ACTION_LABEL[`${h.entity}:${h.action}`] ?? `${h.entity} · ${h.action}`;

export const FIELD_LABEL = {
  inspected_on: "תאריך בדיקה",
  valid_until: "תוקף",
  validity_source: "מקור התוקף",
  declared_clean: "נקי",
  report_number: "מס' תסקיר",
  inspector_name: "שם הבודק",
  inspector_license: "רישיון בודק",
  machine_no: "מס' מתקן במסמך",
  machine_key: "מתקן",
  note: "הערה",
  body: "תיאור",
  urgent: "דחוף",
  due_on: "לתיקון עד",
  closure_no: "סגירה",
  kind: "סוג",
  done_by_name: "בוצע ע״י",
  done_note: "הערת ביצוע",
  done_at: "בוצע ב",
};

export function historyValue(field, v) {
  if (v == null || v === "") return "—";
  if (typeof v === "boolean") return v ? "כן" : "לא";
  if (field === "validity_source") return SOURCE_TAG[v] ?? String(v);
  if (field === "kind") return KIND_LABEL[v] ?? String(v);
  if (field === "done_at") return formatDateIL(ilDateOf(v) || "");
  if (typeof v === "string" && isIsoDate(v) && v.length === 10) return formatDateIL(v);
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
