// tools/gates.js — מריץ את כל שערי האימות ומדווח מה רץ ומה **לא** רץ.
//
// ============================================================
// למה מריץ אחד ולא שבע פקודות
// ============================================================
// ⚠️ שער שלא רץ נראה בדיוק כמו שער שעבר — כלומר כמו שום דבר. שלושת שערי
// ה-PostgREST דורשים PARITY_EMAIL/PARITY_PASSWORD, והם יוצאים בקוד שגיאה
// כשהם חסרים — אבל רק אם מישהו הריץ אותם וקרא את הפלט.
//
// בפועל CLAUDE.md מפנה ל-`npm run parity`, וסקריפט כזה **לא היה קיים**.
// כלומר שבעה שערים נכתבו, ולא הייתה שום פקודה שמריצה אותם כקבוצה.
//
// לכן המסך כאן מפריד שלוש תוצאות שאסור למזג:
//   ✅ עבר   · השוואה אמיתית שהצליחה
//   ❌ נפל   · השוואה אמיתית שנכשלה
//   ⏭️  לא רץ · חסרה הגדרה — **אין ידיעה**, לא הצלחה
//
// קוד היציאה: 1 אם משהו נפל, 2 אם הכול עבר אבל משהו לא רץ, 0 רק כשהכול רץ
// ועבר. 2 נבדל מ-0 בכוונה — CI שמסתפק ב-"לא נפל" היה מקבל כיסוי חלקי בשקט.

const { spawnSync } = require("node:child_process");
const path = require("node:path");

// SKIP_CODES — קודי היציאה שמשמעותם "לא הורץ מחוסר הגדרה" ולא "נכשל".
const GATES = [
  { name: "parity",            what: "JS מול SQL — כל המדדים" },
  { name: "parity-supervisor", what: "מסך הבקרה — JS מול RPC" },
  { name: "parity-activity",   what: "לוג הפעילות — שתי הזרועות" },
  { name: "parity-insights",   what: "תובנות — דרך PostgREST",  needsAuth: true },
  { name: "parity-executive",  what: "מנהל כללי — דרך PostgREST", needsAuth: true },
  { name: "parity-shape",      what: "זהות מבנה בכל המסלולים",   needsAuth: true },
  { name: "check-switch",      what: "שתי זרועות המתג שלמות",    noEnv: true },
  { name: "check-scope",       what: "מה בקר רואה ומה לא" },
  { name: "check-signup",      what: "מי נכנס למערכת ומה הוא מקבל" },
  { name: "check-single-instance", what: "שרת שני מסרב לעלות" },
  { name: "check-permissions",  what: "מי מורשה למה — מקצה לקצה" },
  { name: "check-docker",      what: "הקשר הבנייה של Docker שלם", noEnv: true },
];

const hasAuth = Boolean(process.env.PARITY_EMAIL && process.env.PARITY_PASSWORD);
const results = [];

for (const g of GATES) {
  if (g.needsAuth && !hasAuth) {
    results.push({ ...g, state: "skip", why: "אין PARITY_EMAIL / PARITY_PASSWORD" });
    console.log(`⏭️  ${g.name} — לא רץ (אין PARITY_EMAIL / PARITY_PASSWORD)`);
    continue;
  }

  const args = g.noEnv ? [] : ["--env-file=.env"];
  const r = spawnSync(process.execPath, [...args, path.join(__dirname, `${g.name}.js`)], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
  });

  // השורה האחרונה שאינה ריקה היא השורה המסכמת של כל שער.
  //
  // ⚠️ **חוץ מרעש של זמן הריצה.** `process.exit()` בזמן שחיבורי pg או
  // Supabase עדיין פתוחים מפיל את libuv עם
  // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" — והשורה הזו
  // נכתבת **אחרי** הודעת השגיאה האמיתית, ולכן היא שנתפסה כסיכום.
  //
  // התוצאה בפועל: השער דיווח על קריסה פנימית של Node במקום על
  // "התחברות נכשלה: invalid_credentials" — כלומר הוסתרה בדיוק הסיבה
  // שאפשר לתקן. הכשל עצמו אמיתי; מה שנשבר היה הדיווח עליו.
  // ⚠️ **stdout ו-stderr נבדקים בנפרד, ומיזוגם היה הבאג.** spawnSync מחזיר
  // שני מחרוזות שלמות, ולכן שרשור שלהן מציב את **כל** stderr אחרי **כל**
  // stdout — בלי קשר לסדר האמיתי. מספיקה הודעת retry אחת של db.js כדי
  // שהשורה האחרונה תהיה היא, וכל שער היה מדווח
  // "נכשל בניתוק חולף — ניסיון 1/5" במקום הסיכום שלו. גם שערים שעברו.
  //
  // כלומר בדיוק אותה תקלה שההערה למעלה מתארת, מכיוון אחר: לא רעש שנכתב
  // אחרי השגיאה, אלא ערוץ שלם שנדחף לסוף.
  //
  // לכן: הסיכום נלקח מ-stdout, ומ-stderr רק כשאין stdout כלל (קריסה).
  const RUNTIME_NOISE = /Assertion failed:|UV_HANDLE|node:internal|^\s+at /;
  const clean = (s) => (s || "").trim().split("\n")
    .filter(Boolean).filter((l) => !RUNTIME_NOISE.test(l));

  const outLines = clean(r.stdout);
  const errLines = clean(r.stderr);
  const summary = outLines[outLines.length - 1]
    || errLines[errLines.length - 1]
    || "(אין פלט)";

  // ⚠️ בכשל מציגים גם את stderr: כשהשער קרס לפני שהספיק להדפיס טבלה, כל
  // המידע נמצא שם — וזה בדיוק המצב שבו הכי צריך אותו.
  if (r.status !== 0 && errLines.length) {
    for (const l of errLines.slice(-6)) console.log(`     │ ${l}`);
  }

  if (r.status === 0) {
    results.push({ ...g, state: "pass", why: summary });
    console.log(`✅ ${g.name} — ${summary.replace(/^[✅]\s*/, "")}`);
  } else if (r.status === 2) {
    // ============================================================
    // ⚠️ קוד 2 — "לא ניתן להשוות", ולא כישלון
    // ============================================================
    // שערי ה-parity קוראים את אותו נתון פעמיים ומשווים. כשמסירה חוזרת
    // מ-HiveMQ כותבת שורות בין שתי הקריאות, ההפרש הוא **הנתון שזז** ולא
    // אי-התאמה בלוגיקה — נמדד: 11 הבדלים, כולם על אתר אחד שפעל באותו
    // רגע, וכולם באותו כיוון.
    //
    // ⚠️ ולכן זה נכנס לעמודת "לא רץ" ולא לעמודת "עברו": אין ידיעה, וזה
    // בדיוק ההפרדה שהקובץ הזה נבנה סביבה. שער שנופל באקראי מלמד להתעלם
    // ממנו; שער ש"עובר" כשלא בדק כלום גרוע עוד יותר.
    results.push({ ...g, state: "skip", why: summary });
    console.log(`⏭️  ${g.name} — לא ניתן להשוות (${summary})`);
  } else {
    results.push({ ...g, state: "fail", why: summary });
    console.log(`❌ ${g.name} — ${summary}`);
  }
}

const failed = results.filter((r) => r.state === "fail");
const skipped = results.filter((r) => r.state === "skip");

console.log("\n" + "=".repeat(60));
console.log(`עברו ${results.filter((r) => r.state === "pass").length} · נפלו ${failed.length} · לא רצו ${skipped.length}`);

if (failed.length) {
  console.log("\nנפלו:");
  for (const f of failed) console.log(`  ❌ ${f.name} — ${f.what}\n     ${f.why}`);
  process.exit(1);
}
if (skipped.length) {
  console.log(`\n⚠️  ${skipped.length} שערים לא רצו — אין עליהם ידיעה, לא אישור.`);
  console.log("   PARITY_EMAIL=<מייל> PARITY_PASSWORD=<סיסמה> npm run gates");
  process.exit(2);
}
console.log("\n✅ כל השערים רצו ועברו.");
process.exit(0);
