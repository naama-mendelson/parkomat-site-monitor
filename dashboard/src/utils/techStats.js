// utils/techStats.js — מה כרטיס הטכנאי מציג (21/10/2026). פונקציות טהורות; נבדקות ב-master/tests/tech-stats-ui.test.js.
//
// ⚠️ ההחלטות במסד (vehicles.postgres.sql / vehicle-stats.postgres.sql): המצב, "באתר" (רדיוס לפי דיוק מיקום האתר), הביקור,
// הסיכום היומי, ציר היום ומי הכי קרוב לתקלה. כאן רק תרגום לתצוגה, וחלוקה לקבוצות לפי מה שהמסד אמר.

import { siteShortName } from "../../../shared/site-address.mjs";
import { clockText, distanceText, durationLabel, nearList, placeText, stateOf, stateText, vehicleName } from "./vehicles.js";

const ms = (iso) => { const t = Date.parse(iso ?? ""); return Number.isFinite(t) ? t : null; };

/**
 * הקבוצות בכרטיסים, בסדר שלהן. "באתר" ראשונה: זה מה ששואלים עליו.
 * ⚠️ "מנוע דולק" קבוצה משלו (21/10/2026, בעלת המוצר: "מנוע דולק זה לא נקרא בתנועה") — עד אז נספר ב"בתנועה".
 */
export const GROUPS = [
  { key: "site", label: "באתר", plural: "באתרים" },
  { key: "move", label: "בתנועה", plural: "בתנועה" },
  { key: "idle", label: "מנוע דולק", plural: "עם מנוע דולק" },
  { key: "park", label: "חונה", plural: "חונים" },
  { key: "silent", label: "לא מתעדכן", plural: "לא מתעדכנים" },
  { key: "unknown", label: "לא ידוע", plural: "לא ידוע" },
  { key: "stale", label: "לא מדווח", plural: "לא מדווחים" },
];
const RANK = Object.fromEntries(GROUPS.map((g, i) => [g.key, i]));

/** לאיזו קבוצה הכרטיס שייך — לפי המצב שהמסד קבע, ו-at_site (עומד ליד אתר שלנו). */
export function cardGroup(v, nowIso) {
  const tone = stateOf(v, nowIso).tone;
  if (v?.at_site && (tone === "parking" || tone === "idle" || tone === "silent")) return "site";
  if (tone === "driving") return "move";
  if (tone === "idle") return "idle";
  if (tone === "parking") return "park";
  if (tone === "silent") return "silent";
  if (tone === "stale") return "stale";
  return "unknown";
}

export function groupCounts(list, nowIso) {
  const c = Object.fromEntries(GROUPS.map((g) => [g.key, 0]));
  for (const v of list || []) c[cardGroup(v, nowIso)]++;
  return c;
}

/** הסדר: באתר, בתנועה, מנוע דולק, חונים, לא מתעדכנים, לא ידוע, לא מדווחים — ובתוך כל קבוצה לפי שם. */
export function sortCards(list, nowIso) {
  return [...(list || [])].sort((a, b) =>
    RANK[cardGroup(a, nowIso)] - RANK[cardGroup(b, nowIso)] || vehicleName(a).localeCompare(vehicleName(b), "he"));
}

/** ראשי תיבות לעיגול: האות הראשונה של שתי המילים הראשונות ("דני לוי" → "דל"). */
export function initials(name) {
  const words = String(name ?? "").replace(/[^\p{L}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  return (words.slice(0, 2).map((w) => w[0]).join("") || "?").toUpperCase();
}

/** משך בשניות: "0 דק׳", "45 דק׳", "3:05 שע׳". */
export function hmText(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return "—";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} דק׳`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")} שע׳`;
}

/** שעות:דקות במשבצת צרה — "0:45", "1:15", "112:45"; היחידה כתובה בכותרת המשבצת ("שעות בנסיעה"). */
export function hhmm(seconds) {
  const s = Number(seconds);
  if (seconds == null || !Number.isFinite(s) || s < 0) return "—";
  const m = Math.floor(s / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

/** ק"מ: עד 10 — ספרה אחת אחרי הנקודה; מעל — שלם; בלי נתון — "—". */
export function kmText(km) {
  const n = Number(km);
  if (km == null || !Number.isFinite(n)) return "—";
  return n < 10 ? String(Math.round(n * 10) / 10) : String(Math.round(n));
}

const siteLabel = (s) => (s ? siteShortName(s.name) || s.name || s.code : "");

/**
 * איפה הטכנאי עכשיו — כותרת ושורות, במילים של המפה. site = האתר שהוא עומד לידו ({code, name, ...}) או null.
 * { group, title, sub: [..], site, since, approx, noSignal }
 */
export function whereInfo(v, nowIso) {
  const group = cardGroup(v, nowIso);
  const s = stateOf(v, nowIso);
  const visit = v?.stats?.visit ?? null;
  const near = nearList(v)[0] ?? null;
  const place = placeText(v, nowIso);
  if (group === "site") {
    const site = v.at_site;
    const since = visit && visit.code === site.code ? visit.since : null;
    const sub = [];
    if (since) sub.push(`מ-${clockText(since, nowIso)} · ${durationLabel(since, nowIso)}`);
    if (s.tone === "silent") sub.push(`אין קליטה ${v.located_at ? `מאז ${clockText(v.located_at, nowIso)}` : ""}`.trim());
    else if (s.tone === "idle") sub.push("מנוע דולק");
    return { group, title: `באתר ${siteLabel(site)}`, code: site.code, sub, site, since, approx: site.approx === true, noSignal: s.tone === "silent" };
  }
  if (group === "move" || group === "idle") {
    const speed = s.tone === "driving" && Number.isFinite(v?.speed) && v.speed > 0 ? ` · ${v.speed} קמ"ש` : "";
    const sub = [place, near ? `ליד ${near.label} · ${near.dist}` : ""].filter(Boolean);
    return { group, title: `${s.label}${speed}`, sub, site: null };
  }
  if (group === "park") {
    const sub = [place, near ? `${near.dist} מ${near.label}` : ""].filter(Boolean);
    return { group, title: stateText(v, nowIso), sub, site: null };
  }
  // לא מתעדכן / לא מדווח: המקום האחרון, וליד איזה אתר הוא היה
  return { group, title: stateText(v, nowIso), sub: [place, near ? `ליד ${near.label} · ${near.dist}` : ""].filter(Boolean), site: null };
}

/** "3 חונים", "1 חונה" — יחיד כשיש אחד. */
export function groupLabel(key, n) {
  const g = GROUPS.find((x) => x.key === key);
  return g ? (Number(n) === 1 ? g.label : g.plural) : "";
}

/** הצוות היום: ק"מ, זמן נסיעה, ביקורים, אתרים שונים, היציאה הראשונה, וכמה רכבים זזו. */
export function teamToday(list) {
  let km = 0, kmAny = false, driveS = 0, visits = 0, moved = 0, firstMove = null;
  const sites = new Set();
  for (const v of list || []) {
    const t = v?.stats?.today;
    if (t) {
      if (Number.isFinite(Number(t.km)) && t.km != null) { km += Number(t.km); kmAny = true; }
      driveS += Number(t.drive_s) || 0;
      if (t.first_move) { moved++; if (!firstMove || ms(t.first_move) < ms(firstMove)) firstMove = t.first_move; }
    }
    for (const x of v?.stats?.visits ?? []) { visits++; sites.add(x.code); }
  }
  return { km: kmAny ? Math.round(km) : null, driveS, visits, sites: sites.size, moved, firstMove };
}

export const KINDS = {
  drive: { label: "בנסיעה" },
  site: { label: "באתר" },
  park: { label: "חונה" },
  silent: { label: "אין קליטה" },
  none: { label: "אין נתונים" },
};

const IL_HM = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** "HH:MM" בישראל של דקה m מתחילת היום (תחילת היום ב-UTC מהמסד — כך יום מעבר שעון נכון). */
export function minuteClock(dayStartIso, m) {
  const t = ms(dayStartIso);
  return t == null ? "" : IL_HM.format(new Date(t + m * 60_000));
}

/**
 * ציר היום: { from, to, blocks: [{kind, left, width, title, code}], now, ticks: [{at, label}] } — אחוזים מתוך החלון.
 * החלון 06:00–22:00, ומתרחב לשעה שלמה כשיש פעילות לפני או אחרי. בלי סיכום היום — null.
 */
export function timeline(stats, { from = 360, to = 1320 } = {}) {
  const segs = stats?.today?.segments;
  if (!Array.isArray(segs) || !segs.length) return null;
  const day = Number(stats.day_minutes) || 1440;
  // ⚠️ רק פעילות קובעת את החלון: חניה מחצות (הרכב בבית) או "אין נתונים" היו מותחים את הציר ל-00:00–24:00
  const real = segs.filter((x) => x[0] === "drive" || x[0] === "site" || x[0] === "silent");
  const lo = Math.min(from, ...real.map((x) => Math.floor(x[1] / 60) * 60));   // Math.min() בלי ערכים — Infinity, ואז from
  const hi = Math.max(to, ...real.map((x) => Math.ceil(x[2] / 60) * 60));
  const a = Math.max(0, lo), b = Math.min(day, Math.max(hi, a + 60));
  const pct = (m) => ((Math.min(b, Math.max(a, m)) - a) / (b - a)) * 100;
  const blocks = segs
    .filter((x) => x[2] > a && x[1] < b)
    .map(([kind, s, e, code]) => {
      const left = pct(s), width = Math.max(pct(Math.max(e, s + 1)) - left, 0.35);
      const label = KINDS[kind]?.label ?? kind;
      const where = kind === "site" && code ? ` ${code}` : "";
      return { kind, left, width, code: code ?? null, title: `${label}${where} · ${minuteClock(stats.day_start, s)}–${minuteClock(stats.day_start, e)}` };
    });
  const ticks = [];
  for (let m = Math.ceil(a / 180) * 180; m <= b; m += 180) ticks.push({ at: pct(m), label: minuteClock(stats.day_start, m) });
  const now = Number.isFinite(stats.now_min) && stats.now_min >= a && stats.now_min <= b ? pct(stats.now_min) : null;
  return { from: a, to: b, blocks, now, ticks };
}

const WEEKDAY = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
/** עמודות השבוע: [{day, label, km, visits, tracked, today, h}] — h באחוזים מהיום הגבוה. */
export function weekBars(stats) {
  const week = Array.isArray(stats?.week) ? stats.week : [];
  const max = Math.max(1, ...week.map((d) => Number(d.km) || 0));
  return week.map((d, i) => {
    const km = d.km == null ? null : Number(d.km);
    const wd = new Date(`${d.day}T12:00:00Z`).getUTCDay();
    return {
      day: d.day, label: WEEKDAY[wd] ?? "", km, visits: Number(d.visits) || 0, sites: Number(d.sites) || 0,
      tracked: d.tracked === true, today: i === week.length - 1, h: km == null ? 0 : Math.max(4, (km / max) * 100),
    };
  });
}

/** סיכום השבוע: { km, visits, days } — רק ימים שנאספו. */
export function weekTotals(stats) {
  const week = Array.isArray(stats?.week) ? stats.week : [];
  const tracked = week.filter((d) => d.tracked);
  const km = tracked.reduce((s, d) => s + (Number(d.km) || 0), 0);
  return { km: tracked.length ? Math.round(km) : null, visits: tracked.reduce((s, d) => s + (Number(d.visits) || 0), 0), days: tracked.length };
}

/** הביקורים של היום, לתצוגה: [{code, label, from, to, open, dur}] */
export function visitRows(stats, nowIso) {
  return (Array.isArray(stats?.visits) ? stats.visits : []).map((x) => ({
    code: x.code,
    label: siteShortName(x.name) || x.name || x.code,
    from: clockText(x.from, nowIso),
    to: x.open ? "" : clockText(x.to, nowIso),
    open: x.open === true,
    dur: durationLabel(x.from, x.open ? nowIso : x.to),
    approx: x.approx === true,
  }));
}

/**
 * "צריכים טכנאי": לכל אתר בתקלה או עם קריאה פתוחה — מי כבר שם, ומי הכי קרוב.
 * [{code, label, fault, calls, located, onSite: [{plate, name}], nearest: [{plate, name, dist, state}]}]
 */
export function alertRows(alerts, vehicles, nowIso) {
  const byPlate = new Map((vehicles || []).map((v) => [v.plate, v]));
  const nameOf = (p) => (byPlate.has(p) ? vehicleName(byPlate.get(p)) : p);
  return (Array.isArray(alerts) ? alerts : []).map((a) => ({
    code: a.code,
    label: siteShortName(a.name) || a.name || a.code,
    name: a.name,
    fault: a.fault === true,
    calls: Number(a.calls) || 0,
    located: a.located === true,
    approx: a.approx === true,
    onSite: (a.on_site || []).map((p) => ({ plate: p, name: nameOf(p) })),
    nearest: (a.nearest || [])
      .filter((n) => !(a.on_site || []).includes(n.plate))
      .map((n) => ({
        plate: n.plate,
        name: nameOf(n.plate),
        dist: distanceText(n.m, a.approx === true),
        state: byPlate.has(n.plate) ? stateOf(byPlate.get(n.plate), nowIso).label : "",
      })),
  }));
}

/** חיפוש בכרטיסים: שם, מספר רכב, כתובת, האתר שהוא בו או לידו, והאתרים שביקר בהם היום. */
export function matchesCard(v, query) {
  const q = String(query ?? "").replace(/\s+/g, " ").trim();
  if (!q) return true;
  const bits = [vehicleName(v), v?.plate, v?.address, v?.at_site?.name, v?.at_site?.code,
    ...nearList(v).map((s) => s.label), ...(v?.stats?.visits ?? []).flatMap((x) => [x.name, x.code])];
  return bits.some((x) => String(x ?? "").includes(q));
}
