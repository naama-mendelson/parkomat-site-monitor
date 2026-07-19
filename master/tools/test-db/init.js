// tools/test-db/init.js — מקים את סכמת SiteMonitor במסד הבדיקות ומסמן אותו.
//
// ============================================================
// מריצים כך:
//     npm run test:db:init
// (הפקודה טוענת .env.test, לא .env — ראה package.json)
// ============================================================
//
// זה הסקריפט היחיד שרשאי *ליצור* את סימון הבדיקות, ולכן הוא לא יכול להסתמך
// עליו כדי להגן על עצמו — הרי בפעם הראשונה הוא עוד לא קיים. הביצה והתרנגולת.
//
// הפתרון: הוא נשען על ראיה אחרת, שקשה לזייף — **האם המסד ריק**.
//   • מסד חדש (אין טבלאות / אין אתרים)  → בטוח לסמן.
//   • מסד שכבר מסומן "test"              → בטוח, ריצה חוזרת (idempotent).
//   • מסד עם אתרים ובלי סימון            → ⛔ עצור. זה פרודקשן.
//
// כלומר: כדי לסמן פרודקשן בטעות, הוא היה צריך להיות ריק מאתרים — ואז אין מה
// להרוס בו. הכשל סגור.

const db = require("../../db/db");
const {
  readMarker,
  stampMarker,
  describeTarget,
  assertEnvFileWins,
  MARKER_VALUE,
} = require("../../db/test-guard");

async function countSites() {
  try {
    const row = await db.prepare("SELECT COUNT(*) AS n FROM sites").get();
    return row?.n ?? 0;
  } catch (err) {
    if (err.code === "42P01") return 0;   // אין טבלה בכלל — מסד חדש
    throw err;
  }
}

async function main() {
  console.log("\n🧪 אתחול מסד בדיקות");
  console.log(`   יעד: ${describeTarget()}\n`);

  // ===== שלב 1: האם מותר לגעת במסד הזה? =====
  assertEnvFileWins();   // הסביבה לא דורסת את .env.test
  const marker = await readMarker();
  const sites = await countSites();

  if (marker && marker !== MARKER_VALUE) {
    throw new Error(
      `המסד מסומן כ-"${marker}" ולא כ-"${MARKER_VALUE}". מסרב לגעת בו.`
    );
  }

  if (!marker && sites > 0) {
    throw new Error(
      `\n⛔ המסד הזה מכיל ${sites} אתרים ואינו מסומן כמסד בדיקות.\n` +
        `   כמעט בוודאות זה הפרודקשן. מסרב.\n\n` +
        `   אם בכל זאת התכוונת לכאן — זו לא טעות שאני מוכן לעשות בשבילך.\n`
    );
  }

  if (marker === MARKER_VALUE) {
    console.log(`   ℹ️  המסד כבר מסומן כמסד בדיקות (${sites} אתרים). מרענן סכמה.\n`);
  } else {
    console.log("   ✓ המסד ריק — בטוח לאתחל.\n");
  }

  // ===== שלב 2: הסכמה =====
  // db.init() מריץ את schema.postgres.sql (CREATE TABLE IF NOT EXISTS) ואת
  // השלמת העמודות. אותו קוד בדיוק שרץ בפרודקשן — כדי שמסד הבדיקות יהיה
  // באמת זהה, ולא "בערך".
  await db.init();
  console.log("   ✓ סכמה הוקמה");

  // ===== שלב 3: הסימון =====
  await stampMarker();
  console.log(`   ✓ המסד סומן: settings['environment'] = '${MARKER_VALUE}'`);

  // ===== שלב 4: אימות שהכול באמת שם =====
  const tables = await db
    .prepare(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`
    )
    .all();

  console.log(`\n   טבלאות (${tables.length}): ${tables.map((t) => t.table_name).join(", ")}`);
  console.log("\n✅ מסד הבדיקות מוכן.\n");
  console.log("   הבאים בתור:");
  console.log("     npm run test:db:seed    — למלא נתוני דמה");
  console.log("     npm run test:db:reset   — לרוקן ולהתחיל מחדש\n");
}

main()
  .catch((err) => {
    console.error(`\n❌ ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => db.close());
