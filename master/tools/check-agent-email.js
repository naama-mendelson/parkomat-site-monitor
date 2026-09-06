// tools/check-agent-email.js — מוסכמת האימייל של הסוכן, בארבעה מקומות
// שאינם יודעים זה על קיומו של זה.
//
// ============================================================
// ⚠️ למה השער הזה קיים, ומה קורה בלעדיו
// ============================================================
// הכתובת `site-{code}@parkomat.co.il` כתובה **שלוש פעמים** בשלוש שפות:
//
//   • Parkomat.Agent — C#,  SupabaseConfig.EmailFor    (מי **נכנס**)
//   • master/tools   — Node, provision-agent-user.js   (מי **נוצר**, מהטרמינל)
//   • supabase/…     — TS,   provision-agent           (מי **נוצר**, מהדשבורד)
//
// אין ביניהם קובץ משותף — הסוכן הוא בינארי שרץ במחשב אחר, ה-Edge Function
// רץ בתוך Supabase, והכלי רץ מהטרמינל. הדרך היחידה לקשור אותם היא לקרוא
// את שלושת הקבצים ולהשוות.
//
// ⚠️ **וזה נכשל בשקט מוחלט.** עותק שסטה פירושו שהסוכן נכנס בשם משתמש
// שמעולם לא נוצר: הוא מקבל 400 בכל סבב, במחשב שאיש אינו יושב מולו, ובלי
// שורה בשום מסך. האתר נראה מותקן לחלוטין ופשוט לעולם אינו מדווח — בדיוק
// הכשל שבגללו הועברה יצירת הזהות מהפקודה לדשבורד.
//
// ============================================================
// ⚠️ ההשוואה היא על **התוצאה**, לא על הטקסט
// ============================================================
// שער שמשווה מחרוזות מקור היה נופל על הבדל תחבירי חסר משמעות
// (`${code}` מול `{siteId.Trim()}`) ועובר על הבדל אמיתי שנכתב באותו סגנון.
// לכן כל עותק מפורק לתחילית ולסיומת, מורכב מחדש עם קוד אתר אמיתי,
// והמחרוזות המוגמרות מושוות.
//
// ⚠️ **והדומיין נבדק מול מי שבאמת אוכף אותו** — `app.allowed_email_domains()`
// ב-SQL. שלושת העותקים יכולים להסכים זה עם זה ולהיות שגויים שלושתם:
// הטריגר `enforce_user_creation` דוחה כל כתובת מחוץ לרשימה, כלומר
// ההקצאה נכשלת עוד לפני שיש סוכן שינסה להיכנס.
//
// שער סטטי — אינו נוגע ברשת ואינו עולה תעבורה.
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const SITE = "2438"; // קוד אתר אמיתי — כדי שההרכבה תהיה מוחשית ולא סמלית

// כל מקור: הקובץ, והתבנית שמוציאה ממנו תחילית+סיומת סביב ההשמה.
const SOURCES = [
  {
    what: "הסוכן (C#) — מי נכנס",
    rel: "Parkomat.Agent/src/Parkomat.Agent.Core/Configuration/SupabaseConfig.cs",
    // $"site-{siteId.Trim()}@parkomat.co.il"
    re: /\$"([^"{]*)\{[^}]*\}([^"]*)"/,
  },
  {
    what: "הכלי (Node) — הקצאה מהטרמינל",
    rel: "master/tools/provision-agent-user.js",
    // `site-${code}@parkomat.co.il`
    re: /`([^`$]*)\$\{[^}]*\}([^`]*)`/,
  },
  {
    what: "Edge Function (TS) — הקצאה מהדשבורד",
    rel: "supabase/functions/provision-agent/index.ts",
    re: /`([^`$]*)\$\{[^}]*\}([^`]*)`/,
  },
];

// ⚠️ מחפשים סביב שורת ההגדרה ולא בכל הקובץ: תבנית כללית הייתה תופסת את
// המחרוזת המשולבת הראשונה שבמקרה נמצאת שם, ומשווה משהו אחר לגמרי.
//
// ⚠️ **העוגן הוא ההגדרה, לא כל אזכור** — ו-`const|string` לפני השם הוא מה
// שעושה את ההבדל. גרסה קודמת עגנה על השם בלבד; מוטציה ששינתה את שם
// ההגדרה תפסה **אתר קריאה** של אותה פונקציה ופרסרה תבנית שכנה לגמרי
// (`Bearer ${token}`). היא נכשלה — במקרה, כי המחרוזת יצאה שונה. ווריאנט
// אחר, שבו התבנית השכנה נראית תקינה, היה מדווח ירוק על קוד שבור.
const ANCHOR = /\b(?:const|string)\s+(?:EmailFor|emailFor)\b/;

// ⚠️ **חלון של שלוש שורות ולא שורה אחת.** ב-C# ההגדרה נשברת אחרי `=>`:
//     public static string EmailFor(string siteId) =>
//         string.IsNullOrWhiteSpace(siteId) ? "" : $"site-{...}@...";
// גרסה ראשונה של השער קראה שורה-שורה, לא מצאה את העותק הזה, ודיווחה
// "השתנתה הצורה" — כלומר השער היה אדום על עצמו. זו גם הסיבה ש"לא נמצא"
// חייב להיות כישלון: אילו היה דילוג, הצד היחיד שלא נבדק היה עובר בשקט.
const WINDOW = 3;

console.log("=".repeat(64));
console.log("מוסכמת האימייל של הסוכן — שלושה עותקים ומי שאוכף אותם");
console.log("=".repeat(64));

const found = [];
const problems = [];

for (const src of SOURCES) {
  const file = path.join(ROOT, src.rel);
  if (!fs.existsSync(file)) {
    problems.push(`קובץ חסר: ${src.rel}`);
    continue;
  }

  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  let hit = null;

  lines.forEach((line, i) => {
    if (hit) return;
    const t = line.trim();
    // הערה אינה קוד. C# ו-JS/TS — '//', ובלוקי תיעוד '///' ו-'*'.
    if (t.startsWith("//") || t.startsWith("*")) return;
    if (!ANCHOR.test(line)) return;

    const m = lines.slice(i, i + WINDOW).join("\n").match(src.re);
    if (m) hit = { line: i + 1, email: m[1] + SITE + m[2] };
  });

  if (!hit) {
    // ⚠️ "לא נמצא" הוא כישלון ולא דילוג. שער שמדלג על עותק שהוא לא הצליח
    // לפרסר מדווח ירוק על שני עותקים ומשאיר את השלישי בלי כיסוי — כלומר
    // בדיוק המצב שהוא נכתב כדי למנוע.
    problems.push(`לא נמצאה הגדרת אימייל ב-${src.rel} — השתנתה הצורה?`);
    continue;
  }

  found.push({ ...src, ...hit });
  console.log(`  ${src.what}`);
  console.log(`     ${src.rel}:${hit.line}`);
  console.log(`     → ${hit.email}`);
}

console.log("-".repeat(64));

// ===== 1. שלושת העותקים מייצרים את אותה מחרוזת =====
if (found.length === SOURCES.length) {
  const distinct = [...new Set(found.map((f) => f.email))];
  if (distinct.length === 1) {
    console.log(`✅ שלושת העותקים מייצרים ${distinct[0]}`);
  } else {
    problems.push(
      `העותקים נחלקו ל-${distinct.length} מחרוזות שונות: ${distinct.join(" · ")}`
    );
  }
}

// ===== 2. הדומיין הוא זה שהטריגר ב-SQL באמת מתיר =====
const secSql = fs.readFileSync(
  path.join(ROOT, "master", "db", "security.postgres.sql"),
  "utf8"
);
const domainsMatch = secSql.match(
  /allowed_email_domains[\s\S]{0,400}?SELECT\s+ARRAY\[([^\]]*)\]/
);
if (!domainsMatch) {
  problems.push("לא נמצאה app.allowed_email_domains() ב-security.postgres.sql");
} else {
  const domains = [...domainsMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const used = found[0]?.email.split("@")[1];
  if (used && domains.includes(used)) {
    console.log(`✅ הדומיין ${used} מותר ב-app.allowed_email_domains()`);
  } else {
    problems.push(
      `הדומיין ${used} אינו ברשימה שהטריגר אוכף (${domains.join(", ")}) — ` +
        "ההקצאה תיכשל לפני שיהיה סוכן שינסה להיכנס"
    );
  }
}

// ===== 3. בדיקה שהעוגן באמת מצא משהו =====
// ⚠️ אותו שיקול כמו מונה הצורות התקינות ב-check-effective-status: שער
// שסופר רק חריגות מדפיס "נקי" גם כשלא קרא דבר.
if (found.length < SOURCES.length && problems.length === 0) {
  problems.push(`נמצאו ${found.length} עותקים מתוך ${SOURCES.length}`);
}

console.log("=".repeat(64));

if (problems.length === 0) {
  console.log(`✅ ${found.length} עותקים בשלוש שפות — מחרוזת אחת, דומיין נאכף`);
  process.exit(0);
}

for (const p of problems) console.log(`  ❌ ${p}`);
console.log("=".repeat(64));
console.log(`❌ ${problems.length} בעיות במוסכמת האימייל`);
console.log("   כל שינוי בכתובת חייב להיעשות בשלושת הקבצים באותו קומיט.");
process.exit(1);
