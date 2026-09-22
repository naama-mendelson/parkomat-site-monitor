// tools/provision-intake-user.js — יוצר את המשתמש הקולט של קריאות השירות.
//
//   node --env-file=.env tools/provision-intake-user.js            ← מה יקרה
//   node --env-file=.env tools/provision-intake-user.js --apply    ← יוצר
//
// ============================================================
// ⚠️ מה הוא עושה, ולמה כל חלק
// ============================================================
//   1. יוצר משתמש ב-Supabase Auth עם סיסמה אקראית. ⚠️ דרך ה-Admin API,
//      כי `enforce_user_creation` דורש `parkomat_role` ב-app_metadata —
//      ורק מחזיק המפתח הסודי יכול לקבוע אותו.
//   2. **אינו** רושם אותו ב-`app_users`. זו רשימת בני האדם; זהות של
//      מכונה שמוזרקת לתוכה תופיע בכל מסך ניהול משתמשים ותיראה כמו אדם.
//   3. כותב את המזהה שלו ל-`settings.intake_user_id` — ומשם נגזרת
//      ההרשאה במדיניות ה-RLS. כלומר **ההרשאה מופעלת רק בשלב הזה**,
//      והטבלה עד אליו סגורה לחלוטין.
//   4. מדפיס את הסיסמה **פעם אחת**, יחד עם הסוד שבכתובת.
//
// ⚠️ **והסיסמה מוצגת פעם אחת בלבד** — Supabase שומר גיבוב. חלון שנסגר
// בלי להעתיק פירושו הנפקה מחדש, ואז גם הפונקציה צריכה עדכון.
const crypto = require("node:crypto");

const URL_BASE = process.env.SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const APPLY = process.argv.includes("--apply");
const EMAIL = "service-intake@parkomat.co.il";

async function admin(path, init = {}) {
  const res = await fetch(`${URL_BASE}/auth/v1/${path}`, {
    ...init,
    headers: {
      apikey: SECRET,
      Authorization: `Bearer ${SECRET}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

async function main() {
  if (!URL_BASE || !SECRET) throw new Error("חסרים SUPABASE_URL / SUPABASE_SECRET_KEY");

  const existing = await admin(`admin/users?filter=${encodeURIComponent(EMAIL)}`);
  const found = (existing.body?.users || []).find((u) => u.email === EMAIL);

  if (found) {
    console.log(`המשתמש כבר קיים: ${EMAIL}`);
    console.log(`  מזהה: ${found.id}`);
    console.log("  ⚠️ הסיסמה אינה ניתנת לשליפה. אם אבדה — יש להנפיק חדשה (rotate) ולעדכן את הפונקציה.");
    return;
  }

  // 32 בתים אקראיים בבסיס 64 — לא ניתן לניחוש, ומוקלד פעם אחת בלבד.
  const password = crypto.randomBytes(32).toString("base64url");
  const secretPath = crypto.randomBytes(24).toString("base64url");

  if (!APPLY) {
    console.log("ריצה יבשה. עם --apply ייווצר:");
    console.log(`  משתמש: ${EMAIL}`);
    console.log("  סיסמה אקראית, והמזהה שלו ייכתב ל-settings.intake_user_id");
    console.log("  סוד לכתובת ייוצר גם הוא");
    return;
  }

  const created = await admin("admin/users", {
    method: "POST",
    body: JSON.stringify({
      email: EMAIL,
      password,
      email_confirm: true,
      // ⚠️ `parkomat_role: 'intake'` נדרש כדי לעבור את טריגר היצירה, והוא
      // גם אומר במפורש שזו אינה זהות של אדם.
      app_metadata: { parkomat_role: "intake" },
    }),
  });
  if (!created.ok) throw new Error(`יצירת המשתמש נכשלה: ${created.status} ${JSON.stringify(created.body)}`);

  const uid = created.body.id;
  const pg = require("pg");
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  c.on("error", () => {});
  await c.connect();
  try {
    await c.query(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ('intake_user_id', $1, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`, [uid]);
    const back = (await c.query(`SELECT value FROM settings WHERE key = 'intake_user_id'`)).rows[0]?.value;
    if (back !== uid) throw new Error("המזהה לא נכתב כמצופה");
  } finally { await c.end(); }

  // ⚠️ **לקובץ ולא למסך.** סיסמה שנדפסת לטרמינל חיה משם והלאה בגלילה,
  // בצילום מסך ובכל העתקה של החלון. אותו דפוס בדיוק כמו
  // `agent-passwords-*.txt`, והקובץ מוחרג ב-.gitignore.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = require("node:path").join(__dirname, "..", `intake-credentials-${stamp}.txt`);
  const url = `${URL_BASE}/functions/v1/service-calls/${secretPath}`;
  require("node:fs").writeFileSync(file, [
    "סודות הקליטה של קריאות השירות — נוצרו " + new Date().toISOString(),
    "⚠️ הסיסמה מוצגת פעם אחת בלבד. Supabase שומר גיבוב, ואין דרך לשלוף אותה.",
    "",
    `INTAKE_EMAIL=${EMAIL}`,
    `INTAKE_PASSWORD=${password}`,
    `INTAKE_SECRET=${secretPath}`,
    "",
    "הכתובת לצוות האפליקציה (הסוד הוא חלק ממנה — לשלוח בערוץ מאובטח):",
    url,
    "",
    "פריסה, ממחשב הפיתוח בתיקיית הפרויקט:",
    `  supabase secrets set INTAKE_EMAIL="${EMAIL}" INTAKE_PASSWORD="${password}" INTAKE_SECRET="${secretPath}"`,
    "  supabase functions deploy service-calls --no-verify-jwt",
    "",
  ].join("\n"), "utf8");

  console.log("\n✅ נוצר.");
  console.log(`   משתמש: ${EMAIL}`);
  console.log(`   מזהה נכתב ל-settings.intake_user_id — מכאן ההרשאה פעילה`);
  console.log(`\n   הסיסמה, הסוד, הכתובת ושתי פקודות הפריסה נשמרו ב:`);
  console.log(`   ${file}`);
  console.log(`   ⚠️ הקובץ מוחרג מ-git. אחרי הפריסה — למחוק אותו או להעביר לכספת.`);
}

main().catch((e) => { console.error("⛔", e.message); process.exitCode = 1; });
