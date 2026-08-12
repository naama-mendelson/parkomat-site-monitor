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
  const out = `${r.stdout || ""}${r.stderr || ""}`.trim().split("\n").filter(Boolean);
  const summary = out[out.length - 1] || "(אין פלט)";

  if (r.status === 0) {
    results.push({ ...g, state: "pass", why: summary });
    console.log(`✅ ${g.name} — ${summary.replace(/^[✅]\s*/, "")}`);
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
