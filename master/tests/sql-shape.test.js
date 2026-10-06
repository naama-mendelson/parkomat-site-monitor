// tests/sql-shape.test.js — ההרצה היבשה של tools/apply-sql.js רואה גם טבלאות,
// וההחלה נושאת lock_timeout. מקומי בלבד: אין כאן אף חיבור לייצור.
//
// ⚠️ למה זה קיים: עד P1 של הבודק/תחזוקה, apply-sql השווה פונקציות, מדיניות
// ותזמונים — ולא טבלאות. `CREATE TABLE IF NOT EXISTS` מדלג על טבלה קיימת כולה,
// ולכן CHECK שנערך, טריגר שנוסף או GRANT שדלף בייצור היו נראים "זהה לקוד".
// הבדיקות כאן מוכיחות שכל אחד מהם מופיע כפער.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const path = require("node:path");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";

const { CON_SQL, CON_TABLES } = require("../tools/lib/sql-shape");
const { diff, gaps, withLockTimeout } = require("../tools/apply-sql");

let h;
before(async () => { if (!skip) h = await local.boot(); });
after(async () => { if (h) await h.close(); });

const snap = (con) => ({ fns: [], pols: [], cron: [], con });
// תמונת מצב בתוך טרנזקציה שמתבטלת: השינוי "בייצור" אינו נשאר במסד
async function mutated(sql) {
  let rows;
  await h.pg.transaction(async (tx) => {
    await tx.exec(sql);
    rows = (await tx.query(CON_SQL)).rows;
    await tx.rollback();
  }).catch(() => {});
  return rows;
}

test("CON_SQL: RLS, אילוצים, טריגרים והרשאות של כל עשר הטבלאות", { skip }, async () => {
  const rows = (await h.pg.query(CON_SQL)).rows;
  const by = new Map(rows.map((r) => [r.k, r.def]));
  for (const t of CON_TABLES) {
    assert.equal(by.get(`rls:${t}`), "true", `RLS כבוי על ${t}`);
    for (const role of ["anon", "authenticated", "service_role"]) {
      assert.equal(by.get(`grant:${t}:${role}`), "", `הרשאה ל-${role} על ${t}`);
      assert.equal(by.get(`colgrant:${t}:${role}`), "", `הרשאת עמודה ל-${role} על ${t}`);
    }
  }
  assert.match(by.get("con:inspection_defects:inspection_defects_done_photo_fk") ?? "", /FOREIGN KEY \(id, closure_no, done_photo_id\)/);
  assert.ok(by.has("con:inspection_defects:inspection_defects_done_shape"));
  assert.ok(by.has("trg:inspection_defect_photos:inspection_defect_photos_guard"));
  assert.ok(by.has("trg:pm_files:pm_files_guard"));
  assert.ok(by.has("idx:pm_visits:uq_pm_visits_one_draft"));
  assert.ok(rows.some((r) => r.k.startsWith("seqgrant:inspection_reports_id_seq:")));
  assert.ok(!rows.some((r) => r.k.startsWith("pol:")), "D2: אין מדיניות על הטבלאות הסגורות");
});

test("diff: זהה → אפס פערים; אילוץ חסר, GRANT שדלף ומדיניות עודפת — כל אחד פער", { skip }, async () => {
  const head = (await h.pg.query(CON_SQL)).rows;
  assert.equal(gaps(diff(snap(head), snap(head))), 0);

  const dropped = await mutated(`ALTER TABLE inspection_defects DROP CONSTRAINT inspection_defects_done_shape`);
  assert.deepEqual(diff(snap(head), snap(dropped)).con,
    ["con:inspection_defects:inspection_defects_done_shape: חסר בייצור"]);

  const granted = await mutated(`GRANT SELECT ON inspection_files TO authenticated`);
  const g = diff(snap(head), snap(granted)).con;
  assert.ok(g.some((x) => x.startsWith("grant:inspection_files:authenticated: שונה")), JSON.stringify(g));

  const pol = await mutated(`CREATE POLICY leak ON pm_files FOR SELECT TO authenticated USING (true)`);
  assert.deepEqual(diff(snap(head), snap(pol)).con, ["pol:pm_files:leak: קיים רק בייצור"]);

  const trg = await mutated(`DROP TRIGGER pm_files_guard ON pm_files`);
  assert.deepEqual(diff(snap(head), snap(trg)).con, ["trg:pm_files:pm_files_guard: חסר בייצור"]);

  // CHECK שנערך בקובץ אבל לא הגיע (CREATE TABLE IF NOT EXISTS דילג) — שונה
  const edited = await mutated(`ALTER TABLE pm_visits DROP CONSTRAINT pm_visits_note;
    ALTER TABLE pm_visits ADD CONSTRAINT pm_visits_note CHECK (note IS NULL OR length(note) <= 5000)`);
  const e = diff(snap(head), snap(edited)).con;
  assert.equal(e.length, 1);
  assert.match(e[0], /^con:pm_visits:pm_visits_note: שונה/);
});

test("withLockTimeout: מוסיף -c lock_timeout=5000, ומצרף ל-options קיים", () => {
  assert.equal(withLockTimeout("postgres://u:p%40x@h:6543/postgres"),
    "postgres://u:p%40x@h:6543/postgres?options=-c%20lock_timeout%3D5000");
  const merged = new URL(withLockTimeout("postgres://u:p@h:5432/db?sslmode=require&options=-c%20search_path%3Dpublic"));
  assert.equal(merged.searchParams.get("options"), "-c search_path=public -c lock_timeout=5000");
  assert.equal(merged.searchParams.get("sslmode"), "require");
});

// ⚠️ PGlite משתף backend אחד בין כל החיבורים ומתעלם מפרמטרי ההפעלה, ולכן
// `SHOW lock_timeout` דרכו מחזיר 0 גם כשהפרמטר נשלח. מה שנבדק כאן הוא החצי
// שבשליטתנו: ש-node-postgres — בדיוק כפי ש-db.js בונה את חיבור ההחלה —
// שולח `options` בחבילת ההפעלה. שרת מזויף לוכד אותה.
test("node-postgres שולח את options בחבילת ההפעלה — כפי ש-db.js בונה את חיבור ההחלה", async () => {
  const startup = await new Promise((resolve, reject) => {
    // שומר: חבילה שלא הגיעה היא כישלון, לא המתנה עד timeout של הרץ
    const guard = setTimeout(() => { srv.close(); reject(new Error("חבילת ההפעלה לא הגיעה")); }, 5000);
    const srv = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 8) {
          const len = buf.readInt32BE(0);
          if (buf.length < len) return;
          const code = buf.readInt32BE(4);
          const pkt = buf.subarray(8, len);
          buf = buf.subarray(len);
          if (code === 80877103) { sock.write("N"); continue; }        // SSLRequest → אין SSL
          const parts = pkt.toString("utf8").split("\0");
          const params = {};
          for (let i = 0; i + 1 < parts.length && parts[i]; i += 2) params[parts[i]] = parts[i + 1];
          clearTimeout(guard);
          sock.destroy();
          srv.close();
          resolve(params);
          return;
        }
      });
    });
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", async () => {
      const { Client } = require(path.join(__dirname, "..", "node_modules", "pg"));
      // sslmode=disable כמו ב-local-pg: אחרת pg שולח SSLRequest ונוטש על "N"
      // לפני חבילת ההפעלה. בייצור היא נשלחת בתוך TLS — אותם פרמטרים.
      const url = withLockTimeout(`postgres://u:p@127.0.0.1:${srv.address().port}/postgres?sslmode=disable`);
      // אותה צורה כמו ב-db.js: connectionString + ssl
      const c = new Client({ connectionString: url.replace(":6543/", ":5432/"), ssl: { rejectUnauthorized: false } });
      c.on("error", () => {});
      c.connect().catch(() => {});
    });
  });
  assert.equal(startup.options, "-c lock_timeout=5000");
  assert.equal(startup.database, "postgres");
});
