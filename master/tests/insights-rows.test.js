// tests/insights-rows.test.js — insights_rows / activity_rows מחזירות בדיוק
// את השורות שהדפדפן שלף ישירות, והחלוקה לחודשים אינה מכפילה ואינה משמיטה.
//
// ⚠️ **אלה אינן פונקציות מדד** — computeInsights ו-buildActivityLog נשארים
// ב-JS (CLAUDE.md). לכן הבדיקה היחידה שנדרשת היא זהות השורות: אם השורות
// זהות, המספרים על המסך זהים מעצם ההגדרה.
//
// רץ מול PGlite עם db.init האמיתי — לא מול הייצור.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";
let h, A, B;

const FROM = "2026-01-01T00:00:00.000Z";
const TO = "2026-04-01T00:00:00.000Z";
const PARTS = [["", "2026-02-01T00:00:00.000Z"], ["2026-02-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"], ["2026-03-01T00:00:00.000Z", TO]];

async function site(code) {
  const { rows } = await h.pg.query(
    `INSERT INTO sites (code, site_name, status, registered_at) VALUES ($1,$1,'ready','2025-01-01T00:00:00.000Z') RETURNING id`, [code]);
  return rows[0].id;
}
const op = (id, at) => h.pg.query(
  `INSERT INTO operations (site_id, start_end, entry_exit, state, occurred_at, received_at) VALUES ($1,'end','entry','ready',$2,$2)`, [id, at]);
const seg = (id, st, s, e) => h.pg.query(
  `INSERT INTO status_history (site_id, status, started_at, ended_at) VALUES ($1,$2,$3,$4)`, [id, st, s, e]);

// מרכיב את התשובה בחזרה לאובייקטים — בדיוק כמו הדפדפן.
const expand = ({ cols, rows }) => rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
const call = async (fn, site, from, to, pf, pt) =>
  (await h.pg.query(`SELECT public.${fn}($1,$2,$3,$4,$5) j`, [site, from, to, pf, pt])).rows[0].j;

before(async () => {
  if (skip) return;
  h = await local.boot();
  A = await site("9101"); B = await site("9102");
  await op(A, "2026-01-05T10:00:00.000Z"); await op(A, "2026-02-10T10:00:00.000Z");
  await op(B, "2026-03-20T10:00:00.000Z"); await op(A, "2026-04-02T10:00:00.000Z"); // מחוץ לתקופה
  await seg(A, "error", "2025-12-30T00:00:00.000Z", "2026-01-02T00:00:00.000Z");     // התחיל לפני התקופה
  await seg(A, "ready", "2026-01-31T20:00:00.000Z", "2026-02-02T00:00:00.000Z");     // חוצה גבול חודש
  await seg(B, "maintenance", "2026-03-10T00:00:00.000Z", null);                     // פתוח
});
after(async () => { if (h) await h.close?.(); });

test("insights_rows — אותן שורות כמו השליפה הישירה", { skip }, async () => {
  const j = await call("insights_rows", null, FROM, TO, "", null);
  const ops = (await h.pg.query(`SELECT site_id, start_end, entry_exit, card_number, is_anomaly, superseded_by, occurred_at, excluded_at
    FROM operations WHERE occurred_at >= $1 AND occurred_at < $2 ORDER BY occurred_at, id`, [FROM, TO])).rows;
  const segs = (await h.pg.query(`SELECT site_id, status, started_at, ended_at, excluded_at, reclassified_to FROM status_history
    WHERE started_at < $2 AND (ended_at IS NULL OR ended_at > $1) ORDER BY started_at, id`, [FROM, TO])).rows;
  assert.deepEqual(expand(j.ops), ops);
  assert.deepEqual(expand(j.segs), segs);
  assert.equal(ops.length, 3);
  assert.equal(segs.length, 3, "כולל המקטע שהתחיל לפני התקופה");
});

test("⚠️ חלוקה לחודשים — שרשור החלקים זהה לקריאה אחת, בלי כפילות ובלי השמטה", { skip }, async () => {
  const whole = await call("insights_rows", null, FROM, TO, "", null);
  const parts = await Promise.all(PARTS.map(([pf, pt]) => call("insights_rows", null, FROM, TO, pf, pt)));
  for (const k of ["ops", "segs", "wins", "cover"]) {
    const joined = parts.flatMap((p) => expand(p[k]));
    assert.deepEqual(joined, expand(whole[k]), k);
  }
  // המקטע שהתחיל לפני התקופה — רק בחלק הראשון
  assert.equal(expand(parts[0].segs).filter((s) => s.started_at < FROM).length, 1);
  assert.equal(parts.slice(1).flatMap((p) => expand(p.segs)).filter((s) => s.started_at < FROM).length, 0);
});

test("activity_rows — סדר יורד, עם שם האתר, וחלוקה ששרשורה (הפוך) זהה", { skip }, async () => {
  const whole = await call("activity_rows", null, FROM, TO, "", null);
  const ops = expand(whole.ops);
  assert.deepEqual(ops.map((o) => o.occurred_at), [...ops.map((o) => o.occurred_at)].sort().reverse());
  assert.ok(ops.every((o) => o.site_name === "9101" || o.site_name === "9102"));
  const parts = await Promise.all(PARTS.map(([pf, pt]) => call("activity_rows", null, FROM, TO, pf, pt)));
  for (const k of ["ops", "states", "maint", "suppressed"]) {
    const joined = [...parts].reverse().flatMap((p) => expand(p[k]));
    assert.deepEqual(joined, expand(whole[k]), k);
  }
});

test("סינון לפי אתר", { skip }, async () => {
  const j = await call("insights_rows", B, FROM, TO, "", null);
  assert.ok(expand(j.ops).every((o) => o.site_id === B));
  assert.equal(expand(j.ops).length, 1);
});
