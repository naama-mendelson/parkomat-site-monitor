// tests/error-segments.test.js — app.error_segments: אילו תקלות נספרות, ומתי תקלה היא "בתוך תחזוקה" (18/10/2026).
//
// ההגדרה האחת של "תקלה שנספרת" (functions.postgres.sql), שממנה יוצאים site_stats, executive_series ו-site_uptime_service.
// עד היום לא הייתה לה בדיקה מקומית משלה — הכיסוי היה tools/parity.js מול הייצור בלבד. הבדיקה נכתבה כשנוסף האינדקס
// החלקי idx_status_hist_maint (schema.postgres.sql): האינדקס אינו משנה תוצאה, אבל התנאי שלו חייב להישאר מילה במילה
// כמו בפונקציה, ובלי בדיקה שמחזיקה את הכלל, שינוי באחד מהם היה עובר בשקט.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";

let h;
const H = 3600e3;
const T0 = Date.parse("2026-09-10T00:00:00.000Z");            // תחילת החלון הנבדק
const at = (hours) => new Date(T0 + hours * H).toISOString();   // שעות מתחילת החלון (שלילי = לפניו)
const FROM = at(0), TO = at(48);

let seq = 0;
async function site(history) {
  const code = `E${++seq}`;
  const id = (await h.pg.query(`INSERT INTO sites (code, site_name, status, registered_at) VALUES ($1,$1,'ready',$2) RETURNING id`,
    [code, at(-240)])).rows[0].id;
  for (const [st, s, e, reclass] of history) {
    await h.pg.query(`INSERT INTO status_history (site_id, status, started_at, ended_at, reclassified_to) VALUES ($1,$2,$3,$4,$5)`,
      [id, st, s, e, reclass ?? null]);
  }
  return id;
}
const window = (id, s, e, extra = {}) => h.pg.query(
  `INSERT INTO maintenance_windows (site_id, set_by_name, started_at, duration_hours, expires_at, cancelled_at, excluded_at)
   VALUES ($1,'בדיקה',$2,1,$3,$4,$5)`, [id, s, e, extra.cancelled ?? null, extra.excluded ?? null]);
const segs = async (id, from = FROM, to = TO) => (await h.pg.query(
  `SELECT started_at, ended_at, in_maintenance FROM app.error_segments(ARRAY[$1]::int[], $2, $3) ORDER BY started_at`, [id, from, to])).rows;

before(async () => { if (!skip) h = await local.boot(); });
after(async () => { if (h) await h.close(); });

test("E1 · אילו תקלות חוזרות: בתוך החלון לפי started_at, לא מוחרגות, ו-ended_at נחשף (NULL = פתוחה)", { skip }, async () => {
  const id = await site([
    ["ready", at(-10), at(-3)],
    ["error", at(-3), at(-2)],        // נגמרה לפני החלון — לא (הקיפול עצמו כבר אינו רואה אותה)
    ["ready", at(-2), at(-1)],
    ["error", at(-1), at(1)],         // ⚠️ התחילה לפני החלון ונגמרה בתוכו — לא: הספירה לפי started_at. מוטציה
                                      // שהסירה את `started_at >= p_from` שרדה עד שהמקרה הזה נוסף; הקודם לבדו
                                      // נפל כבר בסינון של site_segments_collapsed.
    ["ready", at(1), at(5)],
    ["error", at(5), at(6)],          // בתוך — כן
    ["ready", at(6), at(20)],
    ["error", at(20), at(21)],        // תסומן כמוחרגת — לא
    ["ready", at(21), at(40)],
    ["error", at(40), null],          // פתוחה — כן, ended_at NULL
  ]);
  await h.pg.query(`UPDATE status_history SET excluded_at = $2 WHERE site_id = $1 AND started_at = $3`, [id, at(22), at(20)]);
  assert.deepEqual(await segs(id), [
    { started_at: at(5), ended_at: at(6), in_maintenance: false },
    { started_at: at(40), ended_at: null, in_maintenance: false },
  ]);
  // תקלה שמתחילה בדיוק ב-p_to — מחוץ לחלון (started_at < p_to)
  assert.equal((await segs(id, FROM, at(40))).length, 1);
});

test("E2 · בתוך תחזוקה — חלון ידני: כולל הגבולות, לא מבוטל, לא מוחרג", { skip }, async () => {
  const id = await site([
    ["ready", at(-10), at(2)],
    ["error", at(2), at(3)],          // בדיוק בתחילת חלון — כן (<=)
    ["ready", at(3), at(8)],
    ["error", at(8), at(9)],          // בדיוק בסוף חלון — כן (>=)
    ["ready", at(9), at(14)],
    ["error", at(14), at(15)],        // חלון שבוטל לפני התקלה — לא (COALESCE(cancelled_at, expires_at))
    ["ready", at(15), at(24)],
    ["error", at(24), at(25)],        // חלון מוחרג — לא
    ["ready", at(25), at(34)],
    ["error", at(34), at(35)],        // חלון שבוטל **אחרי** התקלה — כן
    ["ready", at(35), at(44)],
    ["error", at(44), at(45)],        // בלי חלון — לא
  ]);
  await window(id, at(2), at(8));
  await window(id, at(12), at(18), { cancelled: at(13) });
  await window(id, at(22), at(28), { excluded: at(23) });
  await window(id, at(32), at(38), { cancelled: at(36) });
  assert.deepEqual((await segs(id)).map((r) => [r.started_at, r.in_maintenance]), [
    [at(2), true], [at(8), true], [at(14), false], [at(24), false], [at(34), true], [at(44), false],
  ]);
});

test("E3 · בתוך תחזוקה — מקטע תחזוקה בהיסטוריה: סטטוס גולמי, מסווג-מחדש, פתוח, שהתחיל לפני החלון; ושל אתר אחר — לא", { skip }, async () => {
  // ⚠️ מקטעי התחזוקה הם בטבלה עצמה, לצד התקלות; ה-OR השני של הפונקציה. מקטע של אתר אחר אינו נספר.
  const other = await site([["maintenance", at(-100), null]]);
  const id = await site([
    ["maintenance", at(-30), at(4)],              // התחיל לפני החלון ונגמר בתוכו — התקלה ב-3 בתוכו
    ["error", at(3), at(3.5)],                    // ⚠️ חופף למקטע התחזוקה בזמן: כך נראה "תקלה בזמן תחזוקה" אחרי קיפול
    ["ready", at(4), at(10)],
    ["error", at(10), at(11)],                    // לא
    ["ready", at(11), at(20), "maintenance"],     // מסווג מחדש לתחזוקה — נספר כתחזוקה
    ["error", at(20), at(21)],                    // בדיוק בסוף המקטע המסווג — כן (>=)
    ["ready", at(21), at(30)],
    ["maintenance", at(30), null],                // פתוח — מכסה כל מה שאחריו
    ["error", at(31), at(32)],                    // כן
    ["ready", at(32), at(40)],                    // ⚠️ בלי זה שתי התקלות מתקפלות לאחת (סטטוס זהה ברצף = המשך)
    ["error", at(40), null],                      // כן, פתוחה
  ]);
  assert.deepEqual((await segs(id)).map((r) => [r.started_at, r.in_maintenance]), [
    [at(3), true], [at(10), false], [at(20), true], [at(31), true], [at(40), true],
  ]);
  assert.deepEqual((await segs(other)).length, 0, "לאתר האחר אין תקלות");
  // ⚠️ מקטע תחזוקה **מוחרג** אינו נספר ל-uptime, אבל כאן הוא עדיין "תחזוקה" — הפונקציה אינה מסננת excluded_at
  // על מקטעי התחזוקה (רק על התקלה עצמה). זה המצב הקיים, ותיעוד שלו, לא החלטה חדשה.
});

test("E4 · האינדקס החלקי קיים, ותנאי שלו הוא מילה במילה התנאי שבפונקציה", { skip }, async () => {
  const ix = (await h.pg.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_status_hist_maint'`)).rows[0];
  assert.ok(ix, "idx_status_hist_maint קיים");
  assert.match(ix.indexdef, /ON public\.status_history USING btree \(site_id, started_at\) WHERE \(COALESCE\(reclassified_to, status\) = 'maintenance'::text\)/);
  const fn = (await h.pg.query(`SELECT pg_get_functiondef('app.error_segments(integer[], text, text)'::regprocedure) AS d`)).rows[0].d;
  assert.match(fn, /COALESCE\(m\.reclassified_to, m\.status\) = 'maintenance'/, "אותו ביטוי בפונקציה — אחרת המתכנן לא ישתמש באינדקס");
});
