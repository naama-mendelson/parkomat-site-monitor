// check-fixflow-mapping.js — לאן כל אתר מגיע ב-FixFlow, לפי סוג המכונה שלו.
//
//   node --env-file=.env tools/check-fixflow-mapping.js
//
// שער, לא דוח: הוא נופל כשאתר מגיע לספרייה ריקה. אתר שמציג רשימת תקלות ריקה
// אינו מראה שגיאה למוקדן — הוא נראה בדיוק כמו אתר שאין לו תקלות ידועות, וזה
// כשל שאי אפשר להבחין בו מהמסך.
//
// ⚠️ הכלי אינו כותב דבר, לא כאן ולא ב-FixFlow.
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveLink, PROFILE_BY_TYPE } from "../../shared/fixflow-profiles.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const FIXFLOW_DB =
  process.env.FIXFLOW_DB_PATH ||
  "C:\\Users\\נעמהמנדלסון\\Documents\\FixFlow\\server\\data\\parkomat.sqlite";

// המפה שהדשבורד נושא איתו — אותו קובץ בדיוק, כדי שהשער ימדוד את מה שנשלח.
const MAP = JSON.parse(
  readFileSync(join(HERE, "..", "..", "dashboard", "src", "components", "FixFlowLink", "fixflow-sites.json"), "utf8")
);

async function main() {
  const ff = new DatabaseSync(FIXFLOW_DB, { readOnly: true });
  const counts = new Map();
  for (const r of ff
    .prepare(
      `SELECT sy.name AS system, p.name AS profile,
              (SELECT COUNT(*) FROM faults f WHERE f.profile_id = p.id AND f.deleted_at IS NULL) AS faults,
              (SELECT COUNT(*) FROM procedures pr WHERE pr.profile_id = p.id AND pr.deleted_at IS NULL) AS procs
         FROM profiles p JOIN systems sy ON sy.id = p.system_id`
    )
    .all())
    counts.set(`${r.system}|${r.profile}`, r.faults + r.procs);
  ff.close();

  // ============================================================
  // ⚠️ כל פרופיל שמישהו כתב במפה חייב להתקיים ב-FixFlow
  // ============================================================
  // נמדד ב-16/09/2026: `matzbet-x` הצביע על `שאטל מצבט x קומתי (מצבטון על
  // המעלית)` — **שם התיקייה בכונן G, לא שם הפרופיל**. הוא אינו קיים, ולכן
  // ספירת המסמכים יצאה 0, ולכן המסך אמר "ספרייה ריקה". כלומר באג במיפוי
  // הוצג בדיוק כמו המתנה לייצוא מסמכים, והירקון 224 ישב כך חודשיים.
  //
  // ⚠️ **והבדיקה עוברת על המפה עצמה ולא על האתרים.** פרופיל שגוי שאין לו
  // אתר היום אינו נראה בשום מקום — עד שמישהו ירשום אתר מהסוג הזה, ואז הוא
  // ייראה כמו ספרייה ריקה גם הוא.
  const named = [];
  for (const [type, entry] of Object.entries(PROFILE_BY_TYPE)) {
    if (entry.bySystem) for (const e of Object.values(entry.bySystem)) named.push([type, e]);
    else named.push([type, entry]);
  }
  const phantom = named.filter(([, e]) => !counts.has(`${e.system}|${e.profile}`));
  if (phantom.length) {
    console.log(`
❌ פרופיל שאינו קיים ב-FixFlow (${phantom.length}) — באג ב-PROFILE_BY_TYPE:
`);
    for (const [type, e] of phantom)
      console.log(`   ${String(type).padEnd(12)} → ${e.system} / ${e.profile}`);
    console.log(`   ⚠️ מוצג למשתמשת כ"ספרייה ריקה" — באג שנראה כמו המתנה.`);
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  // ⚠️ `fixflow_profile` נקרא כאן כי **הוא מה שהמסך משתמש בו**. שער שקורא
  // פחות שדות מהמסך מודד מצב אחר — וזה כבר קרה: כשהשער הכיר רק מיפוי לפי
  // סוג, הוא דיווח "14 מחוברים" בזמן שהמסך חיבר 25.
  //
  // ⚠️ ועמודה חסרה אינה נבלעת. `fixflow_profile` נוספת בעליית `master`, ולכן
  // לפני פריסה היא אינה קיימת — ושער שממשיך בלעדיה בשקט היה מדווח "הכול
  // מחובר" על מערכת שהתכונה בה כלל לא נפרסה. ההודעה אומרת בדיוק מה חסר.
  let sites;
  try {
    ({ rows: sites } = await pool.query(
      `SELECT code, site_name, plc_type, fixflow_profile FROM sites ORDER BY code`));
  } catch (e) {
    if (e.code !== "42703") throw e;
    await pool.end();
    console.log(`
❌ העמודה sites.fixflow_profile אינה קיימת במסד.`);
    console.log(`   בחירת ספריית התקלות נוספה בקוד אך **טרם נפרסה**.`);
    console.log(`   להרצה על DELL008:  deploy.ps1   (מוסיף את העמודה ומחליף את הפונקציות)`);
    console.log(`   ⚠️ ולפרוס את הדשבורד רק אחרי — מסך שקורא לפונקציה שאינה קיימת נכשל בשמירה.`);
    process.exit(1);
  }
  await pool.end();

  const buckets = { ok: [], empty: [], needsSystem: [], unmapped: [], noType: [] };
  for (const s of sites) {
    // ⚠️ אותו מימוש שהדשבורד מריץ, ועם אותה מפה. גרסה קודמת של השער הכירה רק
    // את המיפוי לפי סוג ודיווחה "14 מחוברים" בזמן שהמסך חיבר 25.
    const r = resolveLink(s, MAP);
    const row = { ...s, ...r };
    if (r.status === "no-type") buckets.noType.push(row);
    else if (r.status === "needs-system") buckets.needsSystem.push(row);
    else if (r.status === "unmapped") buckets.unmapped.push(row);
    else {
      row.docs = counts.get(`${r.system}|${r.profile}`) ?? 0;
      (row.docs > 0 ? buckets.ok : buckets.empty).push(row);
    }
  }

  const line = (s, extra = "") =>
    `   ${String(s.code).padEnd(6)} ${String(s.site_name).slice(0, 24).padEnd(25)} ${String(s.plc_type ?? "—").padEnd(11)} ${extra}`;

  console.log(`\n=== לאן כל אתר מגיע ב-FixFlow ===   (${sites.length} אתרים)\n`);
  console.log(`✅ מחובר לספרייה עם תוכן (${buckets.ok.length}):`);
  for (const s of buckets.ok) console.log(line(s, `${s.profile} — ${s.docs} מסמכים`));

  if (buckets.empty.length) {
    console.log(`\n❌ מחובר לספרייה **ריקה** (${buckets.empty.length}) — המוקדן יראה רשימה ריקה:`);
    for (const s of buckets.empty) console.log(line(s, `${s.profile} — 0 מסמכים`));
  }
  if (buckets.needsSystem.length) {
    console.log(`\n⚠️  חסר לדעת לולק או ביטנקם (${buckets.needsSystem.length}):`);
    for (const s of buckets.needsSystem) console.log(line(s, s.reason));
  }
  if (buckets.unmapped.length) {
    console.log(`\n⚠️  סוג שטרם הוכרע (${buckets.unmapped.length}):`);
    for (const s of buckets.unmapped) console.log(line(s, s.reason));
  }
  if (buckets.noType.length) {
    console.log(`\n⚠️  אין סוג מכונה (${buckets.noType.length}) — אי אפשר לחבר לשום ספרייה:`);
    for (const s of buckets.noType) console.log(line(s));
  }

  // ⚠️ פרופיל רפאים נספר ככשל, לא כאזהרה: הוא **תמיד** באג, בעוד שספרייה
  // ריקה עשויה להיות המתנה לגיטימית לייצוא מהכונן.
  const broken = buckets.empty.length + phantom.length;
  console.log(
    `\nמחוברים: ${buckets.ok.length} · ריקים: ${buckets.empty.length} · ממתינים להכרעה: ${buckets.needsSystem.length + buckets.unmapped.length + buckets.noType.length}`
  );
  process.exit(broken === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
