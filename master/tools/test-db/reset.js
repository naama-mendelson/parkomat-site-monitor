// tools/test-db/reset.js — מרוקן את מסד הבדיקות ומחזיר אותו למצב נקי.
//
//     npm run test:db:reset
//
// מוחק את *כל* נתוני הטלמטריה, ומאפס את מוני ה-SERIAL כדי שכל ריצת בדיקות
// תתחיל מ-id=1 — בדיקות שתלויות במזהים צריכות להיות דטרמיניסטיות.
//
// טבלת settings *שורדת*: היא מחזיקה את סימון הבדיקות (בלעדיו הסקריפט הבא
// יסרב לרוץ) ואת ה-hash של קוד המנהל.

const db = require("../../db/db");
const { assertTestDatabase, describeTarget } = require("../../db/test-guard");
const { MARKER_KEY } = require("../../db/test-guard");

async function main() {
  console.log("\n🧹 ריקון מסד הבדיקות");
  console.log(`   יעד: ${describeTarget()}\n`);

  // ⛔ החוסם. אם זה לא מסד בדיקות — נזרקת חריגה ושום דבר לא נמחק.
  await assertTestDatabase();
  console.log("   ✓ אומת: זהו מסד בדיקות\n");

  const before = await counts();

  // TRUNCATE ולא DELETE: מיידי, ומאפס את ה-SERIAL.
  // CASCADE נדרש בגלל מפתחות זרים ל-sites; הרשימה מפורשת בכל מקרה כדי
  // שיהיה גלוי מה נמחק — ושטבלת settings *אינה* ברשימה.
  await db.exec(`
    TRUNCATE TABLE operations, status_history, maintenance_windows, monthly_summary, sites
    RESTART IDENTITY CASCADE
  `);

  // מנקים גם כל הגדרה שאינה הסימון (למשל קוד מנהל שנקבע בבדיקה קודמת),
  // כדי שכל ריצה תתחיל מאותה נקודה בדיוק.
  await db.prepare("DELETE FROM settings WHERE key != ?").run(MARKER_KEY);

  const after = await counts();

  console.log("   טבלה                נמחקו");
  console.log("   ─────────────────────────");
  for (const [table, n] of Object.entries(before)) {
    console.log(`   ${table.padEnd(20)} ${String(n).padStart(5)}`);
  }

  const leftovers = Object.values(after).reduce((a, b) => a + b, 0);
  if (leftovers !== 0) {
    throw new Error(`הריקון לא הושלם — נשארו ${leftovers} שורות`);
  }

  console.log("\n✅ המסד ריק. הסימון נשמר.\n");
}

async function counts() {
  const tables = ["sites", "status_history", "operations", "maintenance_windows", "monthly_summary"];
  const out = {};
  for (const t of tables) {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get();
    out[t] = row.n;
  }
  return out;
}

main()
  .catch((err) => {
    console.error(`\n❌ ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => db.close());
