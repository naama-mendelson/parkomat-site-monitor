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
const fs = require("node:fs");
const path = require("node:path");

// SKIP_CODES — קודי היציאה שמשמעותם "לא הורץ מחוסר הגדרה" ולא "נכשל".
const GATES = [
  { name: "parity",            what: "JS מול SQL — כל המדדים" },
  { name: "parity-supervisor", what: "מסך הבקרה — JS מול RPC" },
  { name: "parity-activity",   what: "לוג הפעילות — שתי הזרועות" },
  // ⚠️ שלושת אלה **היו** מסומנים needsAuth ודילגו מראש בלי PARITY_EMAIL.
  // הם בונים לעצמם משתמש חד-פעמי עכשיו (tools/lib/gate-user.js), ולכן
  // הדגל הוסר: החשבון האנושי שהם השתמשו בו נמחק, ושלושה מתוך שלושה-עשר
  // שערים הפסיקו לרוץ בלי שאיש הבחין — הם דיווחו "לא רץ", וזה נקרא כרעש.
  { name: "parity-insights",   what: "תובנות — דרך PostgREST" },
  { name: "parity-executive",  what: "מנהל כללי — דרך PostgREST" },
  { name: "parity-shape",      what: "זהות מבנה בכל המסלולים" },
  { name: "check-switch",      what: "שתי זרועות המתג שלמות",    noEnv: true },
  { name: "check-scope-master", what: "master מגיש רק את הבוט ואת בדיקת החיים" },
  { name: "check-scope",       what: "מה בקר רואה ומה לא" },
  { name: "check-signup",      what: "מי נכנס למערכת ומה הוא מקבל" },
  { name: "check-single-instance", what: "שרת שני מסרב לעלות" },
  { name: "check-permissions",  what: "מי מורשה למה — מקצה לקצה" },
  { name: "check-writes",       what: "כתיבה ישירה ל-Supabase, בלי השרת" },
  { name: "check-reports",      what: "דיווחי שטח — תקרות, זהות, ומי רואה את מה" },
  // ⚠️ .mjs ולא .js: הוא מייבא את shared/timeline.mjs — אותו מודול עצמו
  // שהוא בא לבדוק. עותק שני של הלוגיקה כאן היה בודק את העותק, לא את הקוד.
  { name: "check-reclass",      what: "סיווג מחדש — מוחל לפני החישוב", file: "check-reclass.mjs" },
  // ⚠️ noEnv: סריקת טקסט בלבד. הוא נכתב אחרי שנמצאו 11 שאילתות שקראו
  // status גולמי — ו-parity היה ירוק, כי הבאג היה בשתי הזרועות.
  { name: "check-effective-status", what: "כל קורא רואה את הסטטוס האפקטיבי", noEnv: true },
  { name: "check-heartbeat",     what: "המסך יודע לומר שהוא מציג נתונים ישנים" },
  // ⚠️ נכתב אחרי אובדן אמיתי: תקלה שודרה, HiveMQ אישר, והשרת לא רשם —
  // וה"למה" נמחק יחד עם הלוג של הקונטיינר.
  { name: "check-drops",        what: "הודעה שנזרקה משאירה עקבות" },
  { name: "check-mfa",          what: "אימות דו-שלבי — אוכף ב-SQL, לא במסך" },
  { name: "check-security",     what: "חשיפה לרשת — 11 בדיקות על הייצור החי" },
  { name: "check-message-loss", what: "למה הודעות מתפספסות — חמישה גלאים" },
  // ⚠️ בעיקר בודק **שתיקה**: התראה שמצייצת סתם מלמדת להשתיק, ואז גם
  // האמיתית מושתקת. שני ספי-שתיקה נשללו במדידה לפני שנבחר האות הזה.
  { name: "check-watchdog",     what: "שומר הקליטה מתריע כשצריך ושותק כשלא" },
  { name: "check-service-commands", what: "הכפתור \"הפעל מחדש\" — הרשאה, ריסון, וביצוע" },
  { name: "parity-exec-series", what: "executive_series מול החישוב מהשורות הגולמיות" },
  { name: "check-row-cap",     what: "אף קריאה ישירה אינה מתקרבת לתקרת 1,000 השורות" },
  { name: "check-agent-identity", what: "סוכן מתוחם לאתר שלו — ואינו נחסם ב-MFA" },
  { name: "check-ingest-recorder", what: "מקליט הקליטה תקין — צד הייחוס של השוואת הקליטה" },
  { name: "parity-ingest-cycle", what: "מונה המחזורים — JS מול SQL, שבעת המצבים" },
  { name: "parity-ingest-op",    what: "מסלול התפעולים — המסלול הקיים מול app.ingest_operation" },
  { name: "parity-ingest-state", what: "מסלול המצב — המסלול הקיים מול app.ingest_state" },
  { name: "check-agent-write",   what: "סוכן כותב דרך PostgREST — ורק לאתר שלו" },
  { name: "check-agent-live",    what: "קוד ה-C# האמיתי כותב ל-Supabase האמיתי" },
  // ⚠️ **אחרון בכוונה.** הוא בודק מה נשאר אחרי כל השאר, ולכן חייב לרוץ
  // אחריהם. נמדד: 62 חלונות תחזוקה ו-297 שורות ביקורת הצטברו על אתר
  // אמיתי והופיעו בלוג הפעילות שלו כפעולות שאיש לא עשה.
  { name: "check-no-residue",   what: "השערים אינם מותירים עקבות בייצור" },
  { name: "check-docker",      what: "הקשר הבנייה של Docker שלם", noEnv: true },
];

// ⚠️ **הדילוג-מראש הוסר, ולא רק הדגל.** הבדיקה כאן הכריעה לפני שהשער
// בכלל התחיל, ולכן היא הייתה חזקה מהשער עצמו: גם אחרי שהם למדו לבנות
// לעצמם משתמש, gates.js המשיך לדווח "לא רץ". שער שיודע להזדהות מכריע
// בעצמו, ומחזיר קוד 2 אם לא הצליח.
const results = [];

for (const g of GATES) {
  const args = g.noEnv ? [] : ["--env-file=.env"];
  // g.file — לשער שאינו .js. ראה check-reclass: הוא מייבא מודול ESM.
  const r = spawnSync(process.execPath, [...args, path.join(__dirname, g.file || `${g.name}.js`)], {
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

  // ============================================================
  // ⚠️ בכשל — הפלט **המלא** נשמר לקובץ
  // ============================================================
  // שש שורות אינן מספיקות, ונמדד: parity-executive נפל פעמיים בהרצה
  // מלאה ועבר חמש פעמים לבד. כל מה שהסיכום הראה היה שורת כותרת אחת —
  // בלי מספרים, בלי שם שדה, בלי כלום. בלי הפלט המלא אי אפשר להבדיל
  // בין הבדל אמיתי, נתונים שזזו, וקריסה.
  //
  // ⚠️ **ורק בכשל.** שמירת הפלט של 25 שערים בכל הרצה הייתה יוצרת רעש
  // שאיש לא מנקה, והקבצים היו מתיישנים בלי שאיש ישים לב איזה שייך
  // לאיזו הרצה.
  if (r.status !== 0 && r.status !== 2) {
    try {
      const dir = path.join(__dirname, ".gate-logs");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${g.name}.log`);
      fs.writeFileSync(file,
        `# ${g.name} — ${new Date().toISOString()} — exit=${r.status}

` +
        `===== stdout =====
${r.stdout || "(ריק)"}

` +
        `===== stderr =====
${r.stderr || "(ריק)"}
`);
      console.log(`     📄 הפלט המלא: tools/.gate-logs/${g.name}.log`);
    } catch { /* שמירת הלוג לא תפיל את ההרצה */ }
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
