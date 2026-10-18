// tools/check-uptime-buckets.js — app.site_uptime_buckets זהה ל-site_uptime דלי-דלי, על נתוני הייצור.
//
//   node --env-file=.env tools/check-uptime-buckets.js
//
// ============================================================
// למה זה קיים
// ============================================================
// executive_series קראה ל-site_uptime פעם לכל דלי — 367 סריקות של status_history ל"שנה, יומי" — ונפלה על
// ה-statement timeout של PostgREST (57014). app.site_uptime_buckets מחשבת את כל הדליים בסריקה אחת (18/10/2026).
// כלל הברזל של הפרויקט: מדד שעבר צורה חייב להחזיר **אותם מספרים** על נתונים אמיתיים. tests/uptime-buckets.test.js
// מכסה מקרי קצה שנבנו ביד; כאן זה הייצור — כל הצירופים שהבורר במסך "מנהל כללי" מאפשר, בכל האתרים.
//
// ⚠️ שני הצדדים רצים **באותה טרנזקציה** (READ ONLY), כדי ש-now() — שקוצץ דלי פתוח — יהיה זהה בשניהם.
// ⚠️ ההשוואה היא EXCEPT בשני הכיוונים, בתוך המסד: ארבעה מספרים חוזרים, לא 78,538 שורות. ⚠️ הצד הישן הוא
// 367 קריאות site_uptime — כ-12 שניות של זמן מסד לשנה יומית. לא להריץ בלולאה.
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { Client } = require("pg");

(async () => {
  if (!process.env.DATABASE_URL) { console.log("⚠️  אין DATABASE_URL — השער לא רץ."); process.exit(2); }
  const { getBucketRanges } = await import(pathToFileURL(path.join(__dirname, "..", "..", "shared", "executive.mjs")).href);
  const now = new Date().toISOString();
  const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
  // כמו הדשבורד: הדליים של הרזולוציה, ואחריהם דלי הסך של כל הטווח
  const withTotal = (from, g) => [...getBucketRanges({ from, to: now, granularity: g }).map((b) => ({ from: b.from, to: b.to })), { from, to: now }];
  const sets = [
    ["שנה, יומי",   withTotal(ago(365), "day")],
    ["שנה, שבועי",  withTotal(ago(365), "week")],
    ["שנה, חודשי",  withTotal(ago(365), "month")],
    ["חודש, יומי",  withTotal(ago(30), "day")],
    ["שבוע, יומי",  withTotal(ago(7), "day")],
  ];

  console.log("=== check-uptime-buckets ===\n");
  const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  let fails = 0;
  try {
    await db.query("BEGIN READ ONLY");
    const ids = (await db.query("SELECT id FROM sites ORDER BY id LIMIT 5")).rows.map((r) => r.id);
    sets.push(["חודש, יומי — 5 אתרים", sets[3][1], ids]);
    for (const [name, buckets, siteIds = null] of sets) {
      const t0 = Date.now();
      const r = await db.query(`
        WITH bk AS (SELECT (ord - 1)::int AS bucket, e ->> 'from' AS f, e ->> 'to' AS t
                      FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS x(e, ord)),
        o AS (SELECT bk.bucket, u.site_id, u.maintenance_hours AS m, u.availability_percent AS a, u.measured_hours AS h
                FROM bk CROSS JOIN LATERAL public.site_uptime($1::int[], bk.f, bk.t) u),
        n AS (SELECT bucket, site_id, maintenance_hours AS m, availability_percent AS a, measured_hours AS h
                FROM app.site_uptime_buckets($1::int[], $2::jsonb))
        SELECT (SELECT count(*) FROM o)::int AS n_old,
               (SELECT count(*) FROM n)::int AS n_new,
               (SELECT count(*) FROM (SELECT * FROM o EXCEPT SELECT * FROM n) d)::int AS only_old,
               (SELECT count(*) FROM (SELECT * FROM n EXCEPT SELECT * FROM o) d)::int AS only_new,
               (SELECT count(*) FROM n WHERE m <> 0 OR a <> 0 OR h <> 0)::int AS nonzero`,
        [siteIds, JSON.stringify(buckets)]);
      const x = r.rows[0];
      // ⚠️ nonzero > 0 הוא חלק מהתנאי: שני צדדים ריקים זהים — ואינם מוכיחים דבר
      const ok = x.only_old === 0 && x.only_new === 0 && x.n_old === x.n_new && x.n_new > 0 && x.nonzero > 0;
      if (!ok) fails++;
      console.log(`  ${ok ? "✅" : "❌"} ${name.padEnd(24)} ${String(buckets.length).padStart(3)} דליים · ${String(x.n_new).padStart(6)} שורות · ${x.nonzero} שונות מאפס · הבדלים ${x.only_old}/${x.only_new} · ${Date.now() - t0} ms`);
      if (!ok && (x.only_old || x.only_new)) {
        const d = await db.query(`
          WITH bk AS (SELECT (ord - 1)::int AS bucket, e ->> 'from' AS f, e ->> 'to' AS t
                        FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS x(e, ord)),
          o AS (SELECT bk.bucket, u.site_id, u.maintenance_hours AS m, u.availability_percent AS a, u.measured_hours AS h
                  FROM bk CROSS JOIN LATERAL public.site_uptime($1::int[], bk.f, bk.t) u),
          n AS (SELECT bucket, site_id, maintenance_hours AS m, availability_percent AS a, measured_hours AS h
                  FROM app.site_uptime_buckets($1::int[], $2::jsonb))
          SELECT 'site_uptime' AS side, * FROM (SELECT * FROM o EXCEPT SELECT * FROM n) a
          UNION ALL
          SELECT 'buckets', * FROM (SELECT * FROM n EXCEPT SELECT * FROM o) b
          ORDER BY 2, 3, 1 LIMIT 12`, [siteIds, JSON.stringify(buckets)]);
        console.table(d.rows);
      }
    }
  } finally {
    await db.query("ROLLBACK").catch(() => {});
    await db.end();
  }
  console.log(`\n${"=".repeat(50)}`);
  console.log(fails ? `❌ ${fails} ממצאים` : "✅ app.site_uptime_buckets זהה ל-site_uptime בכל הצירופים");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
