// utils/techReport.js — דוח הטכנאים (22/10/2026): תקופה, טבלה, שיאים. פונקציות טהורות; נבדקות ב-master/tests/tech-report-ui.test.js.
//
// הבעלת: "היסטוריה של אתרים שבהם כל אחד ביקר, כמה שעות בממוצע נמצא טכנאי באתר, כמה כל אחד מהם, מי נוסע הכי מהר — תפרט
// הרבה מידע וכמה שיותר סטטיסטיקות". ⚠️ החישובים במסד (tech_stats / tech_history / site_visit_stats); כאן רק תרגום, מיון
// ובחירת השיאים מתוך מה שהמסד החזיר.

import { siteShortName } from "../../../shared/site-address.mjs";
import { hmText, kmText } from "./techStats.js";
import { vehicleName } from "./vehicles.js";

/** התקופות. days = כמה ימים כולל היום. */
export const PERIODS = [
  { key: "today", label: "היום", days: 1 },
  { key: "7", label: "7 ימים", days: 7 },
  { key: "30", label: "30 ימים", days: 30 },
  { key: "90", label: "90 ימים", days: 90 },
  { key: "365", label: "שנה", days: 365 },
];

/** היום בישראל, 'YYYY-MM-DD' (לא UTC: אחרי חצות בישראל ולפני 02:00/03:00 UTC זה כבר מחר). */
export function israelDay(nowIso) {
  const t = Date.parse(nowIso ?? "");
  const d = Number.isFinite(t) ? new Date(t) : new Date();
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (k) => p.find((x) => x.type === k)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** יום פלוס n ימים, על תאריך בלבד (בלי שעון: שעון קיץ לא משנה יום). */
export function addDays(day, n) {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(t)) return day;
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

/** { from, to } לתקופה, ימים בישראל, היום כלול. מפתח לא מוכר — 7 ימים. */
export function periodRange(key, nowIso) {
  const p = PERIODS.find((x) => x.key === key) ?? PERIODS[1];
  const to = israelDay(nowIso);
  return { from: addDays(to, -(p.days - 1)), to };
}

/** "DD/MM" מ-'YYYY-MM-DD'. */
export function dayShort(day) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(day ?? ""));
  return m ? `${m[2]}/${m[1]}` : "";
}

const WEEKDAY = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
/** "ד׳ 21/10" מ-'YYYY-MM-DD'. */
export function dayLabel(day) {
  const t = Date.parse(`${day}T12:00:00Z`);
  if (!Number.isFinite(t)) return "";
  return `${WEEKDAY[new Date(t).getUTCDay()]} ${dayShort(day)}`;
}

const IL_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function ilParts(iso) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return null;
  const p = Object.fromEntries(IL_PARTS.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
/** השעה בישראל, "07:42". בלי נתון — "—". */
export function ilTime(iso) { return ilParts(iso)?.time ?? "—"; }
/** היום בישראל של רגע, "ד׳ 21/10". */
export function ilDayLabel(iso) { const p = ilParts(iso); return p ? dayLabel(p.day) : ""; }

/** "הנתונים מ-21/10" כשהמעקב התחיל אחרי תחילת התקופה; אחרת "". */
export function dataNote(stats) {
  const first = stats?.first_day;
  if (!first || !stats?.from || first <= stats.from) return "";
  return `הנתונים מ-${dayShort(first)}, מאז שהמעקב התחיל`;
}

/** דקות מחצות → "07:42". בלי נתון — "—". */
export function minuteText(min) {
  const n = Number(min);
  if (min == null || !Number.isFinite(n) || n < 0) return "—";
  const m = Math.round(n);
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** אורך (דקות) → "8:15 שע׳" / "45 דק׳". */
export function minutesLong(min) {
  const n = Number(min);
  if (min == null || !Number.isFinite(n) || n < 0) return "—";
  return hmText(n * 60);
}

/** השם להצגה: מלוח הרכז, אחרת הכינוי באיתוראן בלי מספר הרכב. */
export function techLabel(t) {
  return vehicleName({ tech: t?.tech, name: t?.nickname, plate: t?.plate });
}

/** שם האתר בלי העיר, או הקוד. */
export function siteLabel(s) {
  return siteShortName(s?.name) || s?.name || s?.code || "";
}

/** ק"מ ליום עבודה (ימים שנסע), או null. */
export function kmPerDay(t) {
  const d = Number(t?.work_days);
  return d > 0 ? Math.round((Number(t?.km) || 0) / d) : null;
}

const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * עמודות הטבלה "לפי טכנאי". value = למיון (null תמיד בסוף); text = לתצוגה. ⚠️ שמות קצרים: הטבלה רחבה ממילא.
 */
export const COLUMNS = [
  { key: "name", label: "טכנאי", value: (t) => techLabel(t), text: (t) => techLabel(t) },
  { key: "work_days", label: "ימי עבודה", value: (t) => num(t.work_days), text: (t) => String(t.work_days ?? 0) },
  { key: "km", label: "ק״מ", value: (t) => num(t.km), text: (t) => kmText(t.km) },
  { key: "km_day", label: "ק״מ ליום", value: (t) => kmPerDay(t), text: (t) => (kmPerDay(t) == null ? "—" : String(kmPerDay(t))) },
  { key: "drive_s", label: "נסיעה", value: (t) => num(t.drive_s), text: (t) => hmText(t.drive_s) },
  { key: "visits", label: "ביקורים", value: (t) => num(t.visits), text: (t) => String(t.visits ?? 0) },
  { key: "sites", label: "אתרים", value: (t) => num(t.sites), text: (t) => String(t.sites ?? 0) },
  { key: "visit_avg_s", label: "ממוצע באתר", value: (t) => num(t.visit_avg_s), text: (t) => (t.visit_avg_s == null ? "—" : hmText(t.visit_avg_s)) },
  { key: "visit_total_s", label: "סה״כ באתרים", value: (t) => num(t.visit_total_s), text: (t) => hmText(t.visit_total_s ?? 0) },
  { key: "first_min", label: "יציאה", value: (t) => num(t.first_min), text: (t) => minuteText(t.first_min) },
  { key: "last_min", label: "סיום", value: (t) => num(t.last_min), text: (t) => minuteText(t.last_min) },
  { key: "workday_min", label: "יום עבודה", value: (t) => num(t.workday_min), text: (t) => minutesLong(t.workday_min) },
  { key: "avg_speed", label: "מהירות ממוצעת", value: (t) => num(t.avg_speed), text: (t) => (t.avg_speed == null ? "—" : `${t.avg_speed} קמ״ש`) },
  { key: "max_speed", label: "מהירות שיא", value: (t) => num(t.max_speed), text: (t) => (t.max_speed == null ? "—" : `${t.max_speed} קמ״ש`) },
];

/** מיון לפי עמודה. dir = "desc" / "asc"; null תמיד בסוף; שוויון — לפי שם. */
export function sortTechs(list, key, dir = "desc") {
  const col = COLUMNS.find((c) => c.key === key) ?? COLUMNS[2];
  const sign = dir === "asc" ? 1 : -1;
  return [...(list || [])].sort((a, b) => {
    const va = col.value(a), vb = col.value(b);
    if (va == null && vb == null) return techLabel(a).localeCompare(techLabel(b), "he");
    if (va == null) return 1;
    if (vb == null) return -1;
    const c = typeof va === "string" ? va.localeCompare(vb, "he") : va - vb;
    return c * sign || techLabel(a).localeCompare(techLabel(b), "he");
  });
}

/**
 * השיאים ("מי הכי"): לכל שאלה — מי מוביל, וכמה. רק מי שיש לו נתון (ואפס אינו שיא). שוויון — לפי שם.
 * [{ key, label, name, text }]
 */
const RECORDS = [
  { key: "km", label: "הכי הרבה ק״מ", pick: "max", value: (t) => num(t.km), text: (v) => `${kmText(v)} ק״מ` },
  { key: "visits", label: "הכי הרבה ביקורים", pick: "max", value: (t) => num(t.visits), text: (v) => `${v} ביקורים` },
  { key: "sites", label: "הכי הרבה אתרים שונים", pick: "max", value: (t) => num(t.sites), text: (v) => `${v} אתרים` },
  { key: "visit_total_s", label: "הכי הרבה זמן באתרים", pick: "max", value: (t) => num(t.visit_total_s), text: (v) => hmText(v) },
  { key: "visit_avg_s", label: "הכי הרבה זמן ממוצע באתר", pick: "max", value: (t) => num(t.visit_avg_s), text: (v) => hmText(v) },
  { key: "max_speed", label: "המהירות הגבוהה ביותר", pick: "max", value: (t) => num(t.max_speed), text: (v) => `${v} קמ״ש` },
  { key: "avg_speed", label: "המהירות הממוצעת הגבוהה ביותר", pick: "max", value: (t) => num(t.avg_speed), text: (v) => `${v} קמ״ש` },
  { key: "first_min", label: "יוצא הכי מוקדם (בממוצע)", pick: "min", value: (t) => num(t.first_min), text: (v) => minuteText(v) },
  { key: "workday_min", label: "יום העבודה הארוך ביותר (בממוצע)", pick: "max", value: (t) => num(t.workday_min), text: (v) => minutesLong(v) },
];

export function records(list) {
  const out = [];
  for (const r of RECORDS) {
    const cand = (list || []).filter((t) => {
      const v = r.value(t);
      return v != null && (r.pick === "min" || v > 0);
    });
    if (!cand.length) continue;
    const best = [...cand].sort((a, b) => {
      const d = r.pick === "min" ? r.value(a) - r.value(b) : r.value(b) - r.value(a);
      return d || techLabel(a).localeCompare(techLabel(b), "he");
    })[0];
    out.push({ key: r.key, label: r.label, name: techLabel(best), plate: best.plate, text: r.text(r.value(best)) });
  }
  return out;
}

/** שורת הצוות: [{label, text}] — רק מה שיש בו נתון. */
export function teamFacts(team) {
  if (!team) return [];
  return [
    { label: "ק״מ", text: kmText(team.km ?? 0) },
    { label: "בנסיעה", text: hmText(team.drive_s ?? 0) },
    { label: "ביקורים באתרים", text: String(team.visits ?? 0) },
    { label: "אתרים שונים", text: String(team.sites ?? 0) },
    { label: "זמן ממוצע באתר", text: team.visit_avg_s == null ? "—" : hmText(team.visit_avg_s) },
    { label: "סה״כ באתרים", text: hmText(team.visit_total_s ?? 0) },
    { label: "ימי עבודה", text: String(team.work_days ?? 0) },
  ];
}

/** "דני (3), רון (1)" — הטכנאים באתר, עם כמה פעמים כל אחד. */
export function siteTechsText(site) {
  return (site?.techs ?? []).map((t) => `${techLabel(t)} (${t.n})`).join(", ");
}
