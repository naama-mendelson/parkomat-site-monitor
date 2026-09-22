// tools/apply-sql.js — מחיל את ה-SQL של הפרויקט על Supabase, ממחשב הפיתוח.
//
//   node --env-file=.env tools/apply-sql.js           ← בדיקה: מה שונה, בלי לכתוב
//   node --env-file=.env tools/apply-sql.js --apply   ← החלה
//
// ============================================================
// ⚠️ למה הכלי הזה קיים
// ============================================================
// עד 17/09/2026 ה-SQL הוחל **בעליית `master`** (`db.init()`), ולכן "לפרוס
// SQL" פירושו היה `deploy.ps1` ב-DELL008. באותו יום `master` יצא משימוש
// לבקשת בעלת המוצר — המערכת היא Supabase והדשבורד בלבד — ואיתו נעלם
// המסלול היחיד שהחיל סכימה, פונקציות, מדיניות ותזמונים.
//
// ⚠️ **וזה לא נשאר תיאורטי אפילו ליום אחד.** באותו אחר צהריים משימה
// מתוזמנת ב-DELL008 הרימה את הקונטיינר הישן, `db.init()` של הקוד הישן רץ,
// ושבע פונקציות חזרו לגרסה קודמת — כולל זו שכותבת את האירועים שמזינים את
// המסך החי. אף אחד לא ידע, כי שום דבר לא נשבר בקול: הנתונים נכתבו,
// והמסך פשוט הפסיק להתעדכן לבד.
//
// ⚠️ **ולכן ההרצה היבשה היא העיקר כאן, לא ההחלה.** היא עונה על השאלה
// "האם הייצור זהה לקוד" — וזו השאלה שלא הייתה לה תשובה באותם חמישה ימים.
//
// ============================================================
// ⚠️ מה הכלי מסרב לעשות
// ============================================================
// הוא בודק ש-`master` **אינו** רץ לפני שהוא כותב: אות החיים שלו
// (`settings.server_heartbeat`) חייב להיות ישן משתי דקות. שני תהליכים
// שמריצים DDL במקביל זה בדיוק התרחיש שיצר deadlock מול הקליטה ואיבד
// הודעת תקלה מאתר 1284 — ומעבר לכך, `master` שרץ פירושו שהוא ידרוס שוב
// בעלייה הבאה, כלומר החלה עכשיו היא עבודה שתימחק.
//
// ⚠️ **ההשוואה נעשית מול Postgres אמיתי מקומי (PGlite) ולא מול טקסט.**
// אותו `db.init()` רץ על מסד ריק, ומה שנוצר שם מושווה לייצור: גוף כל
// פונקציה, SECURITY DEFINER, ההרשאות, המדיניות והתזמונים. השוואת קבצים
// לא הייתה תופסת פונקציה שנדרסה בייצור — הקובץ בגיט נשאר נכון.
const path = require("node:path");
const pg = require("pg");

const MASTER = path.join(__dirname, "..");
const APPLY = process.argv.includes("--apply");
const PROD_URL = process.env.DATABASE_URL;

const { FN_SQL, POL_SQL, CRON_SQL } = require("./lib/sql-shape");

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

async function prodSnapshot() {
  const c = new pg.Client({ connectionString: PROD_URL, ssl: { rejectUnauthorized: false } });
  c.on("error", () => {});
  await c.connect();
  try {
    const beat = (await c.query(
      `SELECT round(extract(epoch FROM now() - value::timestamptz))::int s
         FROM settings WHERE key = 'server_heartbeat'`)).rows[0]?.s ?? null;
    return {
      beatAgeSeconds: beat,
      fns: (await c.query(FN_SQL)).rows,
      pols: (await c.query(POL_SQL)).rows,
      cron: (await c.query(CRON_SQL)).rows,
    };
  } finally { await c.end(); }
}

async function headSnapshot() {
  // ⚠️ תהליך נפרד, ולא require כאן — ראה ההסבר ב-lib/head-sql-snapshot.js.
  // מטמון המודולים של Node היה מקבע את db.js למסד המקומי, וההחלה על
  // הייצור הייתה הולכת לשם. נמדד, ודווח כהצלחה שלא קרתה.
  const out = path.join(require("node:os").tmpdir(), `head-sql-${process.pid}.json`);
  require("node:child_process").execFileSync(
    process.execPath, [path.join(__dirname, "lib", "head-sql-snapshot.js"), out],
    { stdio: ["ignore", "inherit", "inherit"] });
  const snap = JSON.parse(require("node:fs").readFileSync(out, "utf8"));
  require("node:fs").unlinkSync(out);
  return snap;
}

function diff(head, prod) {
  const P = new Map(prod.fns.map((r) => [r.sig, r]));
  const missing = [], differ = [];
  for (const l of head.fns) {
    const p = P.get(l.sig);
    if (!p) { missing.push(l.sig); continue; }
    const d = [];
    if (norm(p.src) !== norm(l.src)) d.push("גוף");
    if (p.secdef !== l.secdef) d.push("SECURITY DEFINER");
    if (p.vol !== l.vol) d.push("volatility");
    if (norm(p.cfg) !== norm(l.cfg)) d.push("search_path");
    if (norm(p.ret) !== norm(l.ret)) d.push("טיפוס החזרה");
    if (p.anon_x !== l.anon_x || p.auth_x !== l.auth_x) d.push("הרשאות");
    if (d.length) differ.push(`${l.sig}: ${d.join(", ")}`);
  }
  const PP = new Map(prod.pols.map((r) => [r.k, r]));
  const pols = [];
  for (const l of head.pols) {
    const p = PP.get(l.k);
    if (!p) { pols.push(`${l.k}: חסרה בייצור`); continue; }
    for (const f of ["cmd", "roles", "qual", "wc"]) if (norm(p[f]) !== norm(l[f])) pols.push(`${l.k}: ${f}`);
  }
  const PC = new Map(prod.cron.map((r) => [r.k, r]));
  const cron = [];
  for (const l of head.cron) {
    const p = PC.get(l.k);
    if (!p) cron.push(`${l.k}: חסר בייצור`);
    else if (p.schedule !== l.schedule || norm(p.command) !== norm(l.command)) cron.push(`${l.k}: שונה`);
  }
  return { missing, differ, pols, cron };
}

async function main() {
  if (!PROD_URL) throw new Error("חסר DATABASE_URL (צריך --env-file=.env)");
  const prod = await prodSnapshot();
  const head = await headSnapshot();
  const d = diff(head, prod);
  const total = d.missing.length + d.differ.length + d.pols.length + d.cron.length;

  console.log(`\n=== הייצור מול הקוד ===`);
  console.log(`  פונקציות חסרות בייצור: ${d.missing.length}`);
  for (const m of d.missing) console.log(`     ${m}`);
  console.log(`  פונקציות שונות מהקוד:  ${d.differ.length}`);
  for (const m of d.differ) console.log(`     ${m}`);
  console.log(`  מדיניות:               ${d.pols.length}`);
  for (const m of d.pols) console.log(`     ${m}`);
  console.log(`  תזמונים:               ${d.cron.length}`);
  for (const m of d.cron) console.log(`     ${m}`);

  if (!APPLY) {
    console.log(total === 0
      ? "\n✅ הייצור זהה לקוד. אין מה להחיל."
      : `\n${total} פערים. להחלה:  node --env-file=.env tools/apply-sql.js --apply`);
    process.exitCode = total === 0 ? 0 : 1;
    return;
  }

  // ⚠️ הסירוב הזה הוא הלב של הכלי. ראה ההסבר בראש הקובץ.
  if (prod.beatAgeSeconds !== null && prod.beatAgeSeconds < 120) {
    console.log(`\n⛔ master דיווח על עצמו לפני ${prod.beatAgeSeconds} שניות — הוא חי.`);
    console.log("   כל עוד הוא רץ, הוא ידרוס את מה שיוחל כאן בעלייה הבאה שלו.");
    console.log("   ב-DELL008:  Get-ScheduledTask -TaskName \"Parkomat-*\" | Disable-ScheduledTask   ואז   docker stop parkomat");
    process.exitCode = 1;
    return;
  }

  process.env.DATABASE_URL = PROD_URL;
  const db = require(path.join(MASTER, "db", "db.js"));
  const t0 = Date.now();
  await db.init();
  await db.close?.();
  console.log(`\n✅ הוחל ב-${Math.round((Date.now() - t0) / 1000)} שניות.`);

  // ⚠️ אימות בקריאה חוזרת, ולא אמון בהחלה: "הוחל" הוא מה שהמסד מחזיר עכשיו.
  const after = diff(head, await prodSnapshot());
  const left = after.missing.length + after.differ.length + after.pols.length + after.cron.length;
  console.log(left === 0 ? "✅ הייצור זהה לקוד." : `❌ נותרו ${left} פערים — ראה למעלה.`);
  process.exitCode = left === 0 ? 0 : 1;
}

main().catch((e) => { console.error("⛔", e.stack || e.message); process.exitCode = 1; });
