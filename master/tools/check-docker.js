// tools/check-docker.js — שער: הקשר הבנייה של Docker שלם.
//
// ============================================================
// למה זה שער, וממה הוא מגן
// ============================================================
// ⚠️ בנייה שבורה מתגלה רק כשמישהו מריץ `docker compose up` — כלומר ביום
// הפריסה, ולרוב אצל מישהו אחר. וגרסה קודמת של ה-Dockerfile באמת הייתה
// שבורה: היא עשתה `COPY master/ ./` ל-/app, ואז
// `require("../../shared/executive.mjs")` הצביע ל-`/shared` — מחוץ להקשר.
//
// ⚠️ הכשל השני היה גרוע יותר כי הוא **אינו מפיל את הבנייה**: משתני VITE
// מוטמעים בזמן הבנייה, ובלעדיהם הקונטיינר עולה, המסך נטען, ומופיע
// "האימות אינו מוגדר בדשבורד". שרת תקין לגמרי, מסך שאי אפשר להיכנס בו.
//
// הבדיקה כאן קוראת את ה-Dockerfile ואת ה-compose ומוודאת ששניהם מכסים
// בדיוק את מה שהקוד באמת דורש — בלי להריץ Docker.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const bad = [];
const check = (name, ok, detail) => {
  if (!ok) bad.push({ name, detail });
  console.log(`  ${ok ? "✅" : "❌"} ${name}${!ok && detail ? " — " + detail : ""}`);
};

const dockerfile = read("Dockerfile");
const compose = read("docker-compose.yml");
const ignore = read(".dockerignore");
const envExample = read(".env.docker.example");

console.log("=== מבנה התיקיות ===");
// כל ייבוא מ-shared חייב להישאר תקף אחרי ההעתקה. הדרך היחידה היא לשמר
// את שמות התיקיות — לא לשטח.
check("shared/ מועתק בשלב הדשבורד", /COPY\s+shared\/\s+shared\//.test(dockerfile));
check("shared/ מועתק בשלב השרת",
  (dockerfile.match(/COPY[^\n]*\bshared\/\s+shared\//g) || []).length >= 2);
check("master/ מועתק לתת-תיקייה ולא לשורש", /COPY[^\n]*master\/\s+master\//.test(dockerfile));
check("shared/ אינו מוחרג ב-.dockerignore", !/(^|\n)\s*shared\/?\s*$/m.test(ignore));

console.log("\n=== משתני הבנייה של Vite ===");
// ⚠️ נגזר מהקוד עצמו ולא מרשימה קשיחה: משתנה שיתווסף למסך ולא ל-Dockerfile
// ייתפס כאן, במקום להתגלות כמסך שלא נטען.
const viteVars = new Set();
for (const f of ["dashboard/src/services/supabase.js", "dashboard/src/services/dataSource.js"]) {
  for (const m of read(f).matchAll(/\b(VITE_[A-Z0-9_]+)\b/g)) viteVars.add(m[1]);
}
for (const v of [...viteVars].sort()) {
  check(`${v}: ARG ב-Dockerfile`, new RegExp(`ARG\\s+${v}`).test(dockerfile));
  check(`${v}: מועבר ב-build.args`, new RegExp(`${v}\\s*:`).test(compose));
  check(`${v}: מתועד ב-.env.docker.example`, envExample.includes(v));
}

console.log("\n=== ריצה ===");
check("restart: unless-stopped", /restart:\s*unless-stopped/.test(compose));
// ⚠️ ריבוי מופעים משבית את הקליטה לגמרי — clientId קבוע מול HiveMQ, ושני
// מופעים מנתקים זה את זה בלולאה.
//
// ⚠️ ההערות מנוכות לפני הבדיקה. הגרסה הראשונה כאן נפלה על ה**הערה**
// שמסבירה למה אסור להוסיף replicas — שער שנופל על התיעוד של עצמו.
const composeCode = compose.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
check("אין replicas / scale", !/\breplicas\b|\bscale\b/.test(composeCode));
check("init: true (קוצר זומבים)", /init:\s*true/.test(compose));
check("stop_grace_period מוגדר", /stop_grace_period:/.test(compose));
check("HEALTHCHECK על /health ולא על /", /HEALTHCHECK[\s\S]{0,400}\/health/.test(dockerfile));
check("רץ כמשתמש node", /^USER node$/m.test(dockerfile));
check("TZ מוגדר", /ENV TZ=/.test(dockerfile));
check("tzdata מותקן (בלעדיו TZ אינו נקלט ב-alpine)", /apk add[^\n]*tzdata/.test(dockerfile));

console.log("\n=== אימות בזמן בנייה ===");
// ⚠️ זו הבדיקה שהייתה תופסת את באג ה-shared בבנייה במקום בעלייה בייצור.
// היא מאמתת גם את הנתיבים וגם ש-require(ESM) נתמך בגרסת ה-Node של התמונה.
check("בדיקת עשן על shared/ בזמן הבנייה",
  /RUN node -e[\s\S]{0,300}shared\/timeline\.mjs/.test(dockerfile));

console.log("\n=== הקשחה ===");
// כל אלה אפשריים **רק** כי הקונטיינר אינו כותב לדיסק. באפליקציה שכן כותבת
// read_only היה מפיל אותה בעלייה.
check("read_only: true", /read_only:\s*true/.test(composeCode));
check("/tmp כ-tmpfs עם noexec", /tmpfs:[\s\S]{0,120}\/tmp[^\n]*noexec/.test(composeCode));
check("no-new-privileges", /no-new-privileges:true/.test(composeCode));
check("cap_drop: ALL", /cap_drop:[\s\S]{0,40}-\s*ALL/.test(composeCode));
// ⚠️ בלי תקרה, זינוק זיכרון לוקח את המארח כולו — ולא רק את השירות.
check("תקרת זיכרון", /mem_limit:/.test(composeCode));

console.log("\n=== סודות ===");
check(".env מוחרג מהתמונה", /\*\*\/\.env/.test(ignore));
// ⚠️ המפתח הסודי עוקף RLS. אם הוא ייצרב לחבילת הדפדפן, כל מי שפותח את
// הדשבורד מקבל גישה מלאה.
check("SECRET_KEY אינו ARG של הדשבורד", !/ARG\s+VITE_[A-Z_]*SECRET/.test(dockerfile));
check("הסוכן (Windows) אינו נכנס לתמונה", /Parkomat\.Agent/.test(ignore));
check("קובצי SQLite אינם נכנסים", /\*\*\/\*\.db/.test(ignore));

// ============================================================
// ההקשר עצמו — לא רק מה שכתוב בקבצים
// ============================================================
// ⚠️ עד כאן נבדק מה ה-Dockerfile **אומר**. זה לא אותו דבר כמו מה שבאמת
// מגיע אליו: כלל אחד ב-.dockerignore יכול להשמיט את shared/ או את קובצי
// ה-SQL, וה-COPY יצליח על תיקייה ריקה בלי להתלונן.
//
// לכן כאן מיושמים חוקי ה-.dockerignore על כל קובץ ברפו, ונבדק מה שורד.
console.log("\n=== הקשר הבנייה בפועל ===");
{
  const rules = ignore.split("\n").map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => ({ neg: l.startsWith("!"), pat: l.replace(/^!/, "") }));

  // תרגום תבנית Docker ל-RegExp: ** = כל עומק, * = מקטע אחד.
  const toRe = (pat) => {
    const src = pat.replace(/\/$/, "")
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, " ").replace(/\*/g, "[^/]*").replace(/ /g, ".*");
    return new RegExp(`^${src}(/.*)?$`);
  };
  const compiled = rules.map((r) => ({ ...r, re: toRe(r.pat) }));
  const excluded = (rel) => {
    let out = false;
    for (const r of compiled) if (r.re.test(rel)) out = !r.neg;
    return out;
  };

  // ⚠️ הרשימה נגזרת מהתיקייה עצמה ולא מקובעת: קובץ חדש ב-shared/ ייבדק
  // אוטומטית, ולא יישכח.
  const must = [
    ...fs.readdirSync(path.join(ROOT, "shared")).map((f) => `shared/${f}`),
    "master/master.js", "master/package.json", "master/package-lock.json",
    "master/db/schema.postgres.sql", "master/db/functions.postgres.sql",
    "master/db/security.postgres.sql",
    "master/tools/monthly-summary.js", "master/tools/cleanup-old-data.js",
    "master/tools/backup-db.js",
    "dashboard/package.json", "dashboard/package-lock.json",
    "dashboard/vite.config.js", "dashboard/index.html",
  ];
  const missing = must.filter((f) => fs.existsSync(path.join(ROOT, f)) && excluded(f));
  check(`${must.length} קבצים נדרשים נכנסים להקשר`, missing.length === 0, missing.join(", "));

  // ⚠️ .env בהקשר = סוד בתמונה. זה הכשל שאי אפשר לתקן בדיעבד — התמונה
  // כבר נדחפה לרג'יסטרי.
  const walk = (dir, acc = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(ROOT, abs).split(path.sep).join("/");
      if (e.isDirectory()) walk(abs, acc); else acc.push(rel);
    }
    return acc;
  };
  const all = walk(ROOT);
  const leaked = all.filter((f) =>
    (/\.env$/.test(f) || /\.db($|-)/.test(f) || /^Parkomat\.Agent\//.test(f)) && !excluded(f));
  check("אין סודות / DB / סוכן בהקשר", leaked.length === 0, leaked.slice(0, 3).join(", "));

  const kept = all.filter((f) => !excluded(f));
  const mb = kept.reduce((a, f) => {
    try { return a + fs.statSync(path.join(ROOT, f)).size; } catch { return a; }
  }, 0) / 1024 / 1024;
  // הקשר שמתנפח פירושו שמישהו הפסיק להחריג משהו — בנייה איטית וגם דליפה.
  check(`הקשר קטן (${kept.length} קבצים, ${mb.toFixed(1)}MB)`, mb < 20);
}

console.log("\n=== גרסת Node ===");
const engines = JSON.parse(read("master/package.json")).engines?.node || "";
check("engines דורש 22.12+ (require של ESM)", /22\.12|>=2[3-9]|>=[3-9]\d/.test(engines), engines);
const fromTags = [...dockerfile.matchAll(/FROM node:(\d+)/g)].map((m) => Number(m[1]));
check("כל שלבי ה-FROM על 22+", fromTags.length > 0 && fromTags.every((v) => v >= 22),
  fromTags.join(", "));

console.log("\n" + "=".repeat(56));
if (!bad.length) {
  console.log("✅ הקשר הבנייה שלם");
  process.exit(0);
}
console.log(`❌ ${bad.length} פערים:`);
for (const b of bad) console.log(`   ${b.name}${b.detail ? " — " + b.detail : ""}`);
process.exit(1);
