// tools/test-db/seed.js — ממלא את מסד הבדיקות בטלמטריה סינתטית אך ריאליסטית.
//
//     npm run test:db:seed                          # 5 אתרים, 60 יום
//     npm run test:db:seed -- --sites=200 --days=365  # לבדיקות עומס
//
// ============================================================
// דטרמיניסטי בכוונה
// ============================================================
// אין כאן Math.random. הנתונים נגזרים מ-PRNG עם seed קבוע, ולכן **אותה פקודה
// מייצרת בדיוק אותו מסד, תמיד**. בלי זה, בדיקה שנופלת היא בדיקה שאי אפשר
// לשחזר — והיא חסרת ערך. גם ה"עכשיו" מעוגן: כל הזמנים נמדדים אחורה מחצות
// של היום, ולא מרגע ההרצה, כדי ששתי הרצות באותו יום ייתנו אותו דבר.
//
// הנתונים מכסים בכוונה את המקרים שהקוד באמת נשבר בהם:
//   • מקטע מצב שמתחיל *לפני* תחילת החודש ונמשך לתוכו (הבאג בסיכום החודשי)
//   • חלון תחזוקה — שאמור להיות מחוץ למכנה של הזמינות
//   • אתר אחד שנמצא כרגע ב-no_comm, ואתר אחד בתקלה
//   • מקטע פתוח אחד לכל אתר (ended_at = NULL) — המצב הנוכחי

const db = require("../../db/db");
const { assertTestDatabase, describeTarget } = require("../../db/test-guard");

// ===== PRNG עם seed קבוע (mulberry32) =====
function rng(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);

const SITES = Number(args.sites ?? 5);
const DAYS = Number(args.days ?? 60);
const OPS_PER_DAY = Number(args["ops-per-day"] ?? 30);

const DAY_MS = 86_400_000;
// עוגן: חצות של היום. לא Date.now() — ראה ההערה למעלה.
const midnight = new Date();
midnight.setUTCHours(0, 0, 0, 0);
const T0 = midnight.getTime();

const iso = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString();

// Postgres מגביל ל-65,535 פרמטרים לפקודה. מכניסים במנות.
async function bulkInsert(table, columns, rows, chunkSize = 400) {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => `(${columns.map(() => "?").join(",")})`).join(",");
    const sql = `INSERT INTO ${table} (${columns.join(",")}) VALUES ${placeholders}
                 ON CONFLICT DO NOTHING`;
    await db.prepare(sql).run(...chunk.flat());
  }
}

async function main() {
  console.log("\n🌱 מילוי מסד הבדיקות");
  console.log(`   יעד: ${describeTarget()}`);
  console.log(`   ${SITES} אתרים · ${DAYS} ימים · ~${OPS_PER_DAY} פעולות ליום\n`);

  await assertTestDatabase();
  console.log("   ✓ אומת: זהו מסד בדיקות\n");

  const existing = await db.prepare("SELECT COUNT(*) AS n FROM sites").get();
  if (existing.n > 0) {
    throw new Error(`המסד אינו ריק (${existing.n} אתרים). הרץ קודם: npm run test:db:reset`);
  }

  const rand = rng(20260714);

  // ===== אתרים =====
  const siteRows = [];
  for (let i = 1; i <= SITES; i++) {
    const code = String(1000 + i);
    // האתר האחרון מנותק, זה שלפניו בתקלה — כדי שיהיה מה לבדוק בדשבורד.
    const status = i === SITES ? "no_comm" : i === SITES - 1 ? "error" : i % 3 === 0 ? "operating" : "ready";
    siteRows.push([
      code,
      `אתר בדיקה ${i}`,
      status,
      iso(T0 - rand() * DAY_MS),
      Math.floor(rand() * 5000),           // cycle_total
      i % 4 === 0 ? 0 : 1,                 // is_new_site — חלקם ותיקים
      iso(T0 - DAYS * DAY_MS),             // registered_at
    ]);
  }
  await bulkInsert(
    "sites",
    ["code", "site_name", "status", "last_seen", "cycle_total", "is_new_site", "registered_at"],
    siteRows
  );
  const sites = await db.prepare("SELECT id, code, status FROM sites ORDER BY id").all();
  console.log(`   ✓ ${sites.length} אתרים`);

  // ===== היסטוריית מצבים =====
  const statusRows = [];
  for (const site of sites) {
    // מקטע שמתחיל *לפני* חלון הנתונים ונמשך לתוכו. זה בדיוק המקרה שהפיל את
    // הסיכום החודשי (WHERE started_at >= monthStart פשוט השמיט אותו).
    let cursor = T0 - (DAYS + 3) * DAY_MS;

    for (let d = 0; d < DAYS; d++) {
      const dayStart = T0 - (DAYS - d) * DAY_MS;
      // 2-4 מקטעים ביום
      const segments = 2 + Math.floor(rand() * 3);
      for (let s = 0; s < segments; s++) {
        const r = rand();
        const status =
          r < 0.55 ? "ready" : r < 0.85 ? "operating" : r < 0.94 ? "error" : "no_comm";
        const next = dayStart + ((s + 1) / segments) * DAY_MS;
        if (next <= cursor) continue;
        statusRows.push([site.id, status, iso(cursor), iso(next)]);
        cursor = next;
      }
    }
    // המקטע הפתוח — המצב הנוכחי. חייב להתאים ל-sites.status.
    statusRows.push([site.id, site.status, iso(cursor), null]);
  }
  await bulkInsert("status_history", ["site_id", "status", "started_at", "ended_at"], statusRows);
  console.log(`   ✓ ${statusRows.length.toLocaleString()} מקטעי מצב`);

  // ===== פעולות =====
  const opRows = [];
  for (const site of sites) {
    for (let d = 0; d < DAYS; d++) {
      const dayStart = T0 - (DAYS - d) * DAY_MS;
      // עומס יומי משתנה: פחות בסופ"ש — כדי שמפת החום לא תהיה אחידה ומשעממת
      const weekday = new Date(dayStart).getUTCDay();
      const load = weekday === 5 || weekday === 6 ? 0.4 : 1;
      const count = Math.round(OPS_PER_DAY * load * (0.7 + rand() * 0.6));

      for (let i = 0; i < count; i++) {
        // שעות פעילות: 6:00–22:00
        const hour = 6 + Math.floor(rand() * 16);
        const at = dayStart + hour * 3_600_000 + i * 1000;
        const entryExit = rand() < 0.5 ? "entry" : "exit";
        const anomaly = rand() < 0.03 ? 1 : 0;   // ~3% אנומליות
        const card = String(100000 + Math.floor(rand() * 900000));
        // כל פעולה = start + end (הקוד סופר רק end)
        opRows.push([site.id, "start", entryExit, card, "operating", anomaly, iso(at), iso(at)]);
        opRows.push([site.id, "end", entryExit, card, "operating", anomaly, iso(at + 4000), iso(at + 4000)]);
      }
    }
  }
  await bulkInsert(
    "operations",
    ["site_id", "start_end", "entry_exit", "card_number", "state", "is_anomaly", "occurred_at", "received_at"],
    opRows
  );
  console.log(`   ✓ ${opRows.length.toLocaleString()} פעולות`);

  // ===== חלונות תחזוקה =====
  // אחד פעיל (כדי לבדוק שהוא באמת מוחרג מהזמינות), ואחד שפג.
  const maint = [];
  if (sites.length >= 2) {
    const active = sites[0];
    const startedAt = T0 - 2 * 3_600_000;
    maint.push([active.id, "בדיקה אוטומטית", "טכנאי", "תחזוקה מתוכננת", iso(startedAt), 6, iso(startedAt + 6 * 3_600_000), null]);

    const past = sites[1];
    const oldStart = T0 - 10 * DAY_MS;
    maint.push([past.id, "בדיקה אוטומטית", "טכנאי", "החלפת חלק", iso(oldStart), 4, iso(oldStart + 4 * 3_600_000), null]);
  }
  await bulkInsert(
    "maintenance_windows",
    ["site_id", "set_by_name", "set_by_role", "reason", "started_at", "duration_hours", "expires_at", "cancelled_at"],
    maint
  );
  console.log(`   ✓ ${maint.length} חלונות תחזוקה`);

  // ===== סיכום =====
  const totals = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM sites)               AS sites,
              (SELECT COUNT(*) FROM status_history)      AS segments,
              (SELECT COUNT(*) FROM operations)          AS operations,
              (SELECT COUNT(*) FROM maintenance_windows) AS windows`
    )
    .get();

  console.log(`\n   טווח: ${iso(T0 - DAYS * DAY_MS).slice(0, 10)} → ${iso(T0).slice(0, 10)}`);
  console.log(`   סה"כ: ${totals.sites} אתרים · ${totals.segments.toLocaleString()} מקטעים · ` +
              `${totals.operations.toLocaleString()} פעולות · ${totals.windows} תחזוקות`);
  console.log("\n✅ מסד הבדיקות מלא ומוכן.\n");
}

main()
  .catch((err) => {
    console.error(`\n❌ ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => db.close());
