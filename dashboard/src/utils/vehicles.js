// utils/vehicles.js — מה מסך הרכבים מציג (20/10/2026). פונקציות טהורות; נבדקות ב-master/tests/vehicles-ui.test.js.
//
// ⚠️ הנתונים עצמם (מיקום, שעה בשעון ישראל → UTC, מה נמחק) — ב-SQL (vehicles.postgres.sql). כאן רק תרגום לתצוגה.

/** אחרי כמה זמן בלי דיווח רכב נחשב "לא מדווח" — רכב חונה לא מדווח (המנוע כבוי), אז לא דקות אלא יממה. */
export const STALE_MS = 24 * 60 * 60_000;
/** אחרי כמה זמן בלי סנכרון מוצלח המסך מזהיר שהמיקומים ישנים — הסנכרון רץ כל דקה. */
export const SYNC_LATE_MS = 5 * 60_000;

export const MOTION = {
  driving: { label: "בנסיעה", tone: "driving", rank: 0 },
  idle:    { label: "מנוע דולק", tone: "idle", rank: 1 },
  parking: { label: "חונה", tone: "parking", rank: 2 },
};
const UNKNOWN = { label: "לא ידוע", tone: "unknown", rank: 3 };

const ms = (iso) => { const t = Date.parse(iso ?? ""); return Number.isFinite(t) ? t : null; };

/** השם בלי מספר הרכב שאיתוראן מצרפים לכינוי ("ישראל ישראלי 1234567" → "ישראל ישראלי"). */
export function vehicleName(v) {
  const raw = String(v?.name ?? "").replace(/\s+/g, " ").trim();
  const plate = String(v?.plate ?? "").trim();
  let n = plate ? raw.split(plate).join(" ").replace(/\s+/g, " ").trim() : raw;
  n = n.replace(/\s*\(\s*\)\s*/g, " ").trim();
  return n || plate || "רכב";
}

/** האם הרכב לא דיווח יממה ויותר. */
export function isStale(v, nowIso) {
  const t = ms(v?.located_at), now = ms(nowIso);
  return t == null || now == null || now - t > STALE_MS;
}

/** המצב להצגה — רכב שלא דיווח יממה הוא "לא מדווח", מה שאיתוראן כתבו עליו לפני שבוע כבר לא נכון. */
export function motionOf(v, nowIso) {
  if (isStale(v, nowIso)) return { label: "לא מדווח", tone: "stale", rank: 4 };
  return MOTION[v?.motion] ?? UNKNOWN;
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

/** הסדר ברשימה: בנסיעה, מנוע דולק, חונה, לא ידוע, לא מדווח — ובתוך כל קבוצה לפי שם. */
export function sortVehicles(list, nowIso) {
  return [...(list || [])].sort((a, b) =>
    motionOf(a, nowIso).rank - motionOf(b, nowIso).rank || vehicleName(a).localeCompare(vehicleName(b), "he"));
}

/** כמה בכל מצב — לשורת הסיכום. */
export function motionCounts(list, nowIso) {
  const c = { driving: 0, idle: 0, parking: 0, stale: 0, unknown: 0 };
  for (const v of list || []) c[motionOf(v, nowIso).tone]++;
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
