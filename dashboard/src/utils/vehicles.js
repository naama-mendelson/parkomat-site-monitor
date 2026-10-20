// utils/vehicles.js — מה מסך הרכבים מציג (20/10/2026). פונקציות טהורות; נבדקות ב-master/tests/vehicles-ui.test.js.
//
// ⚠️ הנתונים עצמם (מיקום, שעה בשעון ישראל → UTC, מה נמחק) **והמצב שמוצג** — ב-SQL (vehicles.postgres.sql:
// app.vehicle_state, "חונה מאז", התראת מתח). כאן רק תרגום לתצוגה. ה-motion של איתוראן לבדו אינו מצב: יחידה שהפסיקה לשדר
// באמצע נסיעה נשארת אצלם "בנסיעה" שעות (נמדד 20/10/2026; בעלת המוצר, על אחד מהם: "לא בנסיעה").

/** רק למסד ישן, לפני שהוחל ה-SQL של 20/10 (אין state בתשובה): אחרי יממה בלי דיווח — "לא מדווח". */
export const STALE_MS = 24 * 60 * 60_000;
/** אחרי כמה זמן בלי סנכרון מוצלח המסך מזהיר שהמיקומים ישנים — הסנכרון רץ כל דקה. */
export const SYNC_LATE_MS = 5 * 60_000;

/** המצבים שהמסד מחזיר (state), בסדר שלהם ברשימה. tone = הצבע (סמן, נקודה, מילה). */
export const STATES = {
  driving:   { label: "בנסיעה", tone: "driving", rank: 0 },
  idle:      { label: "מנוע דולק", tone: "idle", rank: 1 },
  parking:   { label: "חונה", tone: "parking", rank: 2 },
  silent:    { label: "לא מתעדכן", tone: "silent", rank: 3 },
  unknown:   { label: "לא ידוע", tone: "unknown", rank: 4 },
  no_report: { label: "לא מדווח", tone: "stale", rank: 5 },
};

const ms = (iso) => { const t = Date.parse(iso ?? ""); return Number.isFinite(t) ? t : null; };

/** השם בלי מספר הרכב שאיתוראן מצרפים לכינוי ("ישראל ישראלי 1234567" → "ישראל ישראלי"). */
export function vehicleName(v) {
  const raw = String(v?.name ?? "").replace(/\s+/g, " ").trim();
  const plate = String(v?.plate ?? "").trim();
  let n = plate ? raw.split(plate).join(" ").replace(/\s+/g, " ").trim() : raw;
  n = n.replace(/\s*\(\s*\)\s*/g, " ").trim();
  return n || plate || "רכב";
}

/** המצב להצגה — מה שהמסד החליט. בלי state (מסד ישן): ההתנהגות הקודמת — איתוראן, ואחרי יממה "לא מדווח". */
export function stateOf(v, nowIso) {
  if (v && Object.prototype.hasOwnProperty.call(v, "state")) return STATES[v.state] ?? STATES.unknown;
  const t = ms(v?.located_at), now = ms(nowIso);
  if (t == null || now == null || now - t > STALE_MS) return STATES.no_report;
  return ({ driving: STATES.driving, idle: STATES.idle, parking: STATES.parking })[v?.motion] ?? STATES.unknown;
}

/** "עכשיו" / "לפני 5 דק'" / "לפני 3 שע'" / "לפני 4 ימים". */
export function ageText(iso, nowIso) {
  const t = ms(iso), now = ms(nowIso);
  if (t == null || now == null) return "לא ידוע";
  const m = Math.max(0, Math.floor((now - t) / 60_000));
  if (m < 1) return "עכשיו";
  if (m < 60) return `לפני ${m} דק'`;
  const h = Math.floor(m / 60);
  if (h < 24) return `לפני ${h} שע'`;
  const d = Math.floor(h / 24);
  return d === 1 ? "לפני יום" : `לפני ${d} ימים`;
}

const IL = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const ilParts = (t) => Object.fromEntries(IL.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
const dayKey = (p) => `${p.year}-${p.month}-${p.day}`;

/** שעה בשעון ישראל: "17:45" היום, "אתמול 17:45", "13/10 17:45" לפני כן, ועם שנה כשהיא אחרת. */
export function clockText(iso, nowIso) {
  const t = ms(iso);
  if (t == null) return "";
  const a = ilParts(t), hm = `${a.hour}:${a.minute}`;
  const now = ms(nowIso);
  if (now == null) return `${a.day}/${a.month} ${hm}`;
  const n = ilParts(now);
  if (dayKey(a) >= dayKey(n)) return hm;
  // אתמול לפי לוח השנה בישראל, לא "לפני 24 שעות" (יום מעבר שעון הוא 23 או 25 שעות)
  const y = new Date(Date.UTC(Number(n.year), Number(n.month) - 1, Number(n.day) - 1));
  if (dayKey(a) === y.toISOString().slice(0, 10)) return `אתמול ${hm}`;
  return a.year === n.year ? `${a.day}/${a.month} ${hm}` : `${a.day}/${a.month}/${a.year} ${hm}`;
}

/** שורת המצב עם הזמן שלה: "חונה מאז 17:45", "לא מתעדכן מאז 13:02", "לא מדווח מאז 13/10 08:00"; אחרת — רק המצב. */
export function stateText(v, nowIso) {
  const s = stateOf(v, nowIso);
  const since = v?.state_since ?? (s.tone === "silent" || s.tone === "stale" ? v?.located_at : null);
  const when = since ? clockText(since, nowIso) : "";
  return when && s.tone !== "driving" && s.tone !== "idle" ? `${s.label} מאז ${when}` : s.label;
}

/**
 * הגיל בעמודת הזמן — רק כשהוא אומר משהו: בנסיעה / מנוע דולק / לא ידוע ("לפני 2 דק'"). לחונה, לא מתעדכן ולא מדווח הזמן
 * כבר בשורת המצב, ו"לפני 4 דק'" ליד "חונה" נקרא כ"חנה לפני 4 דקות" — כשבפועל זו הפעימה האחרונה של יחידה חונה.
 */
export function rowAge(v, nowIso) {
  const tone = stateOf(v, nowIso).tone;
  return tone === "driving" || tone === "idle" || tone === "unknown" ? ageText(v?.located_at, nowIso) : "";
}

/** המקום: האזורים באיתוראן, ואם אין — הכתובת. כשהרכב לא מתעדכן — "מקום אחרון: …", כי זה לא בהכרח איפה שהוא עכשיו. */
export function placeText(v, nowIso) {
  const places = placeNames(v);
  const where = places.length ? places.join(", ") : String(v?.address ?? "").trim();
  if (!where) return "";
  const tone = stateOf(v, nowIso).tone;
  return tone === "silent" || tone === "stale" ? `מקום אחרון: ${where}` : where;
}

/** התראת המתח, או null: { name: "ניתוק מתח", at, text: "ניתוק מתח מאז 08:54" }. */
export function powerAlert(v, nowIso) {
  const p = v?.power_alert;
  if (!p || !ms(p.at)) return null;
  const name = String(p.name ?? "").trim() || "תקלת מתח";
  return { name, at: p.at, text: `${name} מאז ${clockText(p.at, nowIso)}` };
}

/** הסדר ברשימה: בנסיעה, מנוע דולק, חונה, לא מתעדכן, לא ידוע, לא מדווח — ובתוך כל קבוצה לפי שם. */
export function sortVehicles(list, nowIso) {
  return [...(list || [])].sort((a, b) =>
    stateOf(a, nowIso).rank - stateOf(b, nowIso).rank || vehicleName(a).localeCompare(vehicleName(b), "he"));
}

/** כמה בכל מצב — לשורת הסיכום. */
export function stateCounts(list, nowIso) {
  const c = { driving: 0, idle: 0, parking: 0, silent: 0, unknown: 0, stale: 0 };
  for (const v of list || []) c[stateOf(v, nowIso).tone]++;
  return c;
}

/** מצב הסנכרון: never (עוד לא רץ) / error (הכשל אחרי ההצלחה האחרונה) / late (אין הצלחה 5 דקות) / ok. */
export function syncState(sync, nowIso) {
  const ok = ms(sync?.last_ok_at), err = ms(sync?.last_error_at), now = ms(nowIso);
  if (ok == null && err == null) return "never";
  if (err != null && (ok == null || err > ok)) return "error";
  if (now != null && ok != null && now - ok > SYNC_LATE_MS) return "late";
  return "ok";
}

/** שמות המקומות (אזורים באיתוראן) שהרכב בתוכם. */
export function placeNames(v) {
  return (Array.isArray(v?.places) ? v.places : []).map((p) => String(p?.place_name ?? "").trim()).filter(Boolean);
}

/** האם יש לרכב מיקום שאפשר לשים על מפה. */
export function hasPosition(v) {
  return Number.isFinite(v?.lat) && Number.isFinite(v?.lon) && !(v.lat === 0 && v.lon === 0);
}

/** חיפוש ברשימה: שם, מספר רכב, כתובת או מקום — בלי רגישות לרווחים. */
export function matchesVehicle(v, query) {
  const q = String(query ?? "").replace(/\s+/g, " ").trim();
  if (!q) return true;
  return [vehicleName(v), v?.plate, v?.address, ...placeNames(v)].some((x) => String(x ?? "").includes(q));
}
