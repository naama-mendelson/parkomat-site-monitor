// tests/uptime-buckets.test.js — app.site_uptime_buckets זהה ל-site_uptime דלי-דלי (18/10/2026).
//
// executive_series קראה ל-site_uptime פעם לכל דלי — 367 סריקות ל"שנה, יומי", וה-timeout של PostgREST. הפונקציה
// החדשה מחשבת את כל הדליים בסריקה אחת, וכלל הברזל הוא שהמספרים זהים. כאן זה נבדק על מקרי הקצה שהייצור לא
// מבטיח: מקטע שחוצה גבול דלי, מקטע פתוח, מקטע שנגמר בדיוק על גבול, מקטע מוחרג, תקלה שסווגה מחדש, חלונות תחזוקה
// חופפים שחוצים גבול, דלי של יותר מיום, דלי הסך, דלי עתידי (לא חוקי), דלי שנקצץ ל-now, דלי הפוך, וסינון אתרים.
// ההשוואה היא שורה-לשורה, ערך-לערך — אותו עיגול, אותו 0 (ולא NULL) לאתר בלי נתונים.
//
// ⚠️ מה שכבר נתפס כאן: LEFT JOIN לחלונות + LEAST/GREATEST (שמתעלמים מ-NULL) נתן 24 שעות תחזוקה לאתר בלי שום
// חלון. מוטציות (18/10/2026, עותק מבודד): 8/14 נתפסו; שש השורדות שקולות — הצמדה דרך הגבולות היא סינון מקדים
// והתנאי המקורי אחריו מכסה (ראו CLAUDE.md, הסעיף על "שנה, יומי").
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";

let h;
after(async () => { if (h) await h.close(); });

const H = 3600e3, D = 24 * H;
const iso = (t) => new Date(t).toISOString();

let seq = 0;
async function site() {
  const code = `UB${++seq}`;
  return (await h.pg.query(
    `INSERT INTO sites (code, site_name, status, registered_at) VALUES ($1,$1,'ready','2026-01-01T00:00:00.000Z') RETURNING id`,
    [code])).rows[0].id;
}
const hist = (id, st, s, e, { excluded = null, reclass = null } = {}) => h.pg.query(
  `INSERT INTO status_history (site_id, status, started_at, ended_at, excluded_at, reclassified_to) VALUES ($1,$2,$3,$4,$5,$6)`,
  [id, st, iso(s), e == null ? null : iso(e), excluded, reclass]);
const win = (id, s, e, cancelled = null) => h.pg.query(
  `INSERT INTO maintenance_windows (site_id, set_by_name, started_at, duration_hours, expires_at, cancelled_at) VALUES ($1,'t',$2,$3,$4,$5)`,
  [id, iso(s), (e - s) / H, iso(e), cancelled == null ? null : iso(cancelled)]);

const perBucket = async (ids, buckets) => {
  const rows = [];
  for (const [i, b] of buckets.entries()) {
    const r = await h.pg.query(
      `SELECT $1::int AS bucket, site_id, maintenance_hours, availability_percent, measured_hours
         FROM public.site_uptime($2::int[], $3, $4) ORDER BY site_id`, [i, ids, b.from, b.to]);
    rows.push(...r.rows);
  }
  return rows;
};
const batched = async (ids, buckets) => (await h.pg.query(
  `SELECT bucket, site_id, maintenance_hours, availability_percent, measured_hours
     FROM app.site_uptime_buckets($1::int[], $2::jsonb) ORDER BY bucket, site_id`, [ids, JSON.stringify(buckets)])).rows;
const viaExecutive = async (ids, buckets) => (await h.pg.query(
  `SELECT bucket, site_id, maintenance_hours, availability_percent, measured_hours
     FROM public.executive_series($1::int[], $2, $3, $4::jsonb) ORDER BY bucket, site_id`,
  [ids, buckets[0].from, buckets.at(-1).to, JSON.stringify(buckets)])).rows;

// ארבעה ימים שנגמרו לפני יומיים, כדי ש-now() לא ייגע בהם
const base = Math.floor(Date.now() / D) * D - 6 * D;
const day = (i) => ({ from: iso(base + i * D), to: iso(base + (i + 1) * D) });

let A, B, C, Dsite, buckets;
// hook אחד: אתחול ואז זריעה. שני hooks נפרדים — הזריעה רצה לפני ש-h הוקצה.
before(async () => {
  if (skip) return;
  h = await local.boot();
  A = await site(); B = await site(); C = await site(); Dsite = await site();
  // A: מוכן שחוצה את גבול יום 1, תקלה, תחזוקה שחוצה את גבול יום 2, ואז מוכן פתוח עד עכשיו
  await hist(A, "ready", base - D, base + D + 6 * H);
  await hist(A, "error", base + D + 6 * H, base + D + 9 * H);
  await hist(A, "maintenance", base + D + 9 * H, base + 2 * D + H);
  await hist(A, "ready", base + 2 * D + H, null);
  // חלון תחזוקה שחוצה את גבול יום 1 ומכסה חלק מה"מוכן"
  await win(A, base + 2 * H, base + D + 2 * H);
  // B: תקלה שסווגה מחדש כתחזוקה, שורה מוחרגת (אסור שתיספר), נתק, ואז בפעולה פתוח
  await hist(B, "error", base + 12 * H, base + D + 12 * H, { reclass: "maintenance" });
  await hist(B, "ready", base, base + 3 * D, { excluded: iso(base + 3 * D) });
  await hist(B, "no_comm", base + D + 12 * H, base + 2 * D);
  await hist(B, "operating", base + 2 * D, null);
  // שני חלונות חופפים ביום 1 (מיזוג), ואחד מבוטל (לא נספר)
  await win(B, base + D, base + D + 5 * H);
  await win(B, base + D + 3 * H, base + D + 8 * H);
  await win(B, base + 2 * D, base + 2 * D + 10 * H, base + 2 * D + H);
  // C: תקלה שנגמרת **בדיוק** על גבול יום 1, ואז מוכן בדיוק מהגבול — נגיעה בגבול אינה חפיפה
  await hist(C, "error", base, base + D);
  await hist(C, "ready", base + D, base + 3 * D);
  // D: בלי היסטוריה בכלל — חייב לחזור עם אפסים, לא להיעלם
  buckets = [
    day(0), day(1), day(2), day(3),
    { from: day(1).from, to: day(3).to },                     // דלי של יומיים, חופף לדליים היומיים
    { from: day(0).from, to: day(4).to },                     // דלי הסך
    { from: iso(Date.now() + D), to: iso(Date.now() + 2 * D) }, // עתידי — לא חוקי אחרי הקיצוץ ל-now
    { from: day(3).from, to: iso(Date.now() + D) },           // נקצץ ל-now
    { from: day(2).to, to: day(2).from },                     // הפוך — אפסים
  ];
});

test("כל האתרים — שורה-לשורה זהה ל-site_uptime לכל דלי, כולל אפסים לאתר בלי נתונים", { skip }, async () => {
  const want = await perBucket(null, buckets);
  const got = await batched(null, buckets);
  assert.equal(got.length, buckets.length * (await h.pg.query(`SELECT count(*)::int n FROM sites`)).rows[0].n);
  assert.deepEqual(got, want);
  // ולא ריק: המקרים שנבנו באמת מייצרים מספרים שונים מאפס
  const nz = got.filter((r) => r.site_id === A && r.maintenance_hours > 0 && r.availability_percent > 0 && r.availability_percent < 100);
  assert.ok(nz.length >= 1, "ל-A יש דלי עם תחזוקה, תקלה ומוכן יחד");
  const dRows = got.filter((r) => r.site_id === Dsite);
  assert.equal(dRows.length, buckets.length);
  assert.ok(dRows.every((r) => r.maintenance_hours === 0 && r.availability_percent === 0 && r.measured_hours === 0));
});

test("סינון אתרים — אותן שורות, רק של האתרים שנבחרו", { skip }, async () => {
  const ids = [A, C];
  const want = await perBucket(ids, buckets);
  const got = await batched(ids, buckets);
  assert.equal(got.length, buckets.length * 2);
  assert.deepEqual(got, want);
});

test("executive_series מחזירה את אותן שלוש עמודות — זה הצרכן", { skip }, async () => {
  const bs = buckets.slice(0, 6);
  const want = (await perBucket(null, bs)).map((r) => ({ ...r }));
  const got = await viaExecutive(null, bs);
  assert.deepEqual(got, want);
});

test("⚠️ נגיעה בגבול אינה חפיפה: התקלה של C שנגמרת בדיוק בתחילת יום 1 אינה נספרת ביום 1", { skip }, async () => {
  const got = await batched([C], [day(1)]);
  assert.equal(got.length, 1);
  assert.equal(got[0].availability_percent, 100);
  assert.equal(got[0].measured_hours, 24);
});

test("בלי דליים חוקיים — שורות אפס לכל אתר, ולא שגיאה", { skip }, async () => {
  const bs = [{ from: iso(Date.now() + D), to: iso(Date.now() + 2 * D) }];
  const got = await batched([A], bs);
  assert.deepEqual(got, [{ bucket: 0, site_id: A, maintenance_hours: 0, availability_percent: 0, measured_hours: 0 }]);
  assert.deepEqual(await batched([A], []), []);
});
