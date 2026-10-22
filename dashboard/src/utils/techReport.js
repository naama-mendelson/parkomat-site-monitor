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

/** "דני (3), רון (1)" — הטכנאים באתר, עם כמה פעמים כל אחד. */
export function siteTechsText(site) {
  return (site?.techs ?? []).map((t) => `${techLabel(t)} (${t.n})`).join(", ");
}

// ── התצוגה הוויזואלית (22/10/2026) ──────────────────────────────────────────────────────────────────────────────────
// הבעלת, על הטבלה: "לא רוצה כזו תצוגה, אני רוצה תצוגה ויזואלית, מעניינת, צבעונית וברורה". הטבלה נשארת מאחורי כפתור.
// צבע לפי משפחת המדד, תמיד אותו צבע לאותה משפחה: road = מרחק ונסיעה, site = אתרים, speed = מהירות, time = שעות היום.
// הגוונים עצמם ב-TechReport.css (--ts-road / --ts-site / --ts-speed / --ts-time), לכל ערכת נושא.

/** המדדים של "השוואה בין הטכנאים" — אחד בכל פעם, עמודה לכל טכנאי. */
export const METRICS = [
  { key: "km", label: "ק״מ", family: "road", value: (t) => num(t.km), text: (v) => `${kmText(v)} ק״מ` },
  { key: "visits", label: "ביקורים", family: "site", value: (t) => num(t.visits), text: (v) => (v === 1 ? "ביקור אחד" : `${v} ביקורים`) },
  { key: "visit_total_s", label: "זמן באתרים", family: "site", value: (t) => num(t.visit_total_s), text: (v) => hmText(v) },
  { key: "drive_s", label: "זמן נסיעה", family: "road", value: (t) => num(t.drive_s), text: (v) => hmText(v) },
  { key: "sites", label: "אתרים שונים", family: "site", value: (t) => num(t.sites), text: (v) => (v === 1 ? "אתר אחד" : `${v} אתרים`) },
  { key: "km_day", label: "ק״מ ליום", family: "road", value: (t) => kmPerDay(t), text: (v) => `${v} ק״מ ליום` },
  { key: "visit_avg_s", label: "זמן ממוצע באתר", family: "site", value: (t) => num(t.visit_avg_s), text: (v) => hmText(v) },
  { key: "avg_speed", label: "מהירות ממוצעת", family: "speed", value: (t) => num(t.avg_speed), text: (v) => `${v} קמ״ש` },
  { key: "max_speed", label: "מהירות שיא", family: "speed", value: (t) => num(t.max_speed), text: (v) => `${v} קמ״ש` },
];

/**
 * עמודות ההשוואה למדד אחד: מהגבוה לנמוך; אפס ובלי נתון — לא עמודה, נספרים ב-missing. pct = רוחב העמודה (המוביל 100).
 * { metric, rows: [{ plate, name, value, text, pct, rank }], missing }
 */
export function barRows(list, key) {
  const m = METRICS.find((x) => x.key === key) ?? METRICS[0];
  const all = (list || []).map((t) => ({ t, v: m.value(t) }));
  const has = all.filter((r) => r.v != null && r.v > 0)
    .sort((a, b) => b.v - a.v || techLabel(a.t).localeCompare(techLabel(b.t), "he"));
  const max = has[0]?.v ?? 0;
  return {
    metric: m,
    rows: has.map((r, i) => ({ plate: r.t.plate, name: techLabel(r.t), value: r.v, text: m.text(r.v), pct: (r.v / max) * 100, rank: i + 1 })),
    missing: all.length - has.length,
  };
}

/** משפחת הצבע של שיא (לפי המדד שלו). */
export function recordFamily(key) {
  if (key === "first_min" || key === "workday_min") return "time";
  return METRICS.find((m) => m.key === key)?.family ?? "road";
}

const hourText = (h) => `${String(h % 24).padStart(2, "0")}:00`;

/**
 * ציר השעות של "יום העבודה": משעה עגולה לפני היציאה המוקדמת ועד שעה עגולה אחרי הסיום המאוחר, לפחות 07:00–17:00.
 * סימון כל שעה עד 12 שעות, אחרת כל שעתיים. בלי אף טכנאי עם יציאה וסיום — null.
 */
export function clockAxis(list) {
  const pts = (list || []).filter((t) => num(t.first_min) != null && num(t.last_min) != null);
  if (!pts.length) return null;
  const from = Math.max(0, Math.min(7, Math.floor(Math.min(...pts.map((t) => num(t.first_min))) / 60)));
  const to = Math.min(24, Math.max(17, Math.ceil(Math.max(...pts.map((t) => num(t.last_min))) / 60)));
  const step = to - from <= 12 ? 1 : 2;
  const ticks = [];
  for (let h = from; h <= to; h += step) ticks.push({ pct: ((h - from) / (to - from)) * 100, label: hourText(h) });
  return { from: from * 60, to: to * 60, ticks };
}

/**
 * שורה לכל טכנאי שיש לו יציאה וסיום: מאיפה עד איפה על הציר (אחוזים), מהמוקדם ביותר.
 * [{ plate, name, start, width, first, last, len }]
 */
export function spanRows(list, axis) {
  if (!axis) return [];
  const span = axis.to - axis.from;
  const at = (m) => Math.min(100, Math.max(0, ((m - axis.from) / span) * 100));
  return (list || [])
    .filter((t) => num(t.first_min) != null && num(t.last_min) != null)
    .sort((a, b) => num(a.first_min) - num(b.first_min) || techLabel(a).localeCompare(techLabel(b), "he"))
    .map((t) => {
      const s = at(num(t.first_min)), e = at(Math.max(num(t.first_min), num(t.last_min)));
      return { plate: t.plate, name: techLabel(t), start: s, width: Math.max(e - s, 0.5), first: minuteText(t.first_min),
               last: minuteText(t.last_min), len: minutesLong(t.workday_min) };
    });
}

/** חלקי היום, לפי הסדר שבו הם מצוירים. */
export const MIX_PARTS = [
  { key: "drive", label: "נסיעה" },
  { key: "site", label: "באתרים" },
  { key: "other", label: "חונה ואחר" },
];

/**
 * איך עובר יום עבודה ממוצע: נסיעה, באתרים, והשאר (חונה, עצירות) — מתוך אורך היום הממוצע. רק מי שנסע בתקופה.
 * ⚠️ אם נסיעה + אתרים ארוכים מהיום הממוצע (למשל זמן באתר אחרי התזוזה האחרונה) — הסכום הוא היום, ו"אחר" אפס.
 * { total, parts: [{ key, label, s, pct }] } או null.
 */
export function dayMix(t) {
  const d = Number(t?.work_days);
  if (!(d > 0)) return null;
  const drive = Math.max(0, Number(t.drive_s) || 0) / d;
  const site = Math.max(0, Number(t.site_s) || 0) / d;
  const day = (Number(t.workday_min) || 0) * 60;
  const total = Math.max(day, drive + site);
  if (!(total > 0)) return null;
  const s = { drive, site, other: total - drive - site };
  return { total, parts: MIX_PARTS.map((p) => ({ ...p, s: s[p.key], pct: (s[p.key] / total) * 100 })) };
}

/** שורות "איך עובר היום": מי שהכי הרבה באתרים — למעלה. */
export function mixRows(list) {
  return (list || [])
    .map((t) => ({ plate: t.plate, name: techLabel(t), mix: dayMix(t) }))
    .filter((r) => r.mix)
    .sort((a, b) => b.mix.parts[1].pct - a.mix.parts[1].pct || a.name.localeCompare(b.name, "he"));
}

/** מדדי האתרים, ועמודות לפיהם (כמו barRows). */
export const SITE_METRICS = [
  { key: "visits", label: "ביקורים", value: (s) => num(s.visits), text: (v) => (v === 1 ? "ביקור אחד" : `${v} ביקורים`) },
  { key: "total_s", label: "זמן כולל", value: (s) => num(s.total_s), text: (v) => hmText(v) },
  { key: "avg_s", label: "זמן ממוצע", value: (s) => num(s.avg_s), text: (v) => hmText(v) },
];
export function siteBarRows(sites, key) {
  const m = SITE_METRICS.find((x) => x.key === key) ?? SITE_METRICS[0];
  const has = (sites || []).map((s) => ({ s, v: m.value(s) })).filter((r) => r.v != null && r.v > 0)
    .sort((a, b) => b.v - a.v || siteLabel(a.s).localeCompare(siteLabel(b.s), "he"));
  const max = has[0]?.v ?? 0;
  return { metric: m, rows: has.map((r, i) => ({ site: r.s, value: r.v, text: m.text(r.v), pct: (r.v / max) * 100, rank: i + 1 })) };
}
