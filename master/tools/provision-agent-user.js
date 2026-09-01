// tools/provision-agent-user.js — מנפיק זהות לסוכן של אתר אחד.
//
//   node --env-file=.env tools/provision-agent-user.js <קוד-אתר>
//   node --env-file=.env tools/provision-agent-user.js <קוד-אתר> --rotate
//
// ============================================================
// ⚠️ מה זה מחליף, ולמה
// ============================================================
// היום כל 16 האתרים מתחברים ל-HiveMQ עם **אותו שם משתמש (`agent`) ואותה
// סיסמה**, בטקסט גלוי ב-config.json וב-bridge.conf, וניתנת לחילוץ מכל
// installer משוגר ב-`strings`. דליפה מאתר אחד פותחת את כל 16.
//
// כאן: משתמש משלו לכל אתר, מתוחם ב-`site_id` לאתר אחד בלבד.
//
// ⚠️ **ולמה לא פשוט המפתח הסודי.** הוא עוקף RLS לחלוטין — מי שמגיע פיזית
// לאתר אחד היה מוחק את ההיסטוריה של כולם. זה כלל 7 ב-CLAUDE.md בשורש,
// והוא הסיבה שהכלי הזה קיים בכלל.
const crypto = require("node:crypto");
const db = require("../db/db");

const SB = process.env.SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;

// ⚠️ 32 בתים אקראיים ולא סיסמה קריאה. אדם לעולם לא יקליד אותה — היא
// נכנסת ל-config.json של הסוכן — ולכן אין שום סיבה להחליש אותה למען
// הזיכרון. base64url כדי שלא יהיו תווים שישברו JSON או קובץ conf.
const newPassword = () => crypto.randomBytes(32).toString("base64url");

// ⚠️ הדומיין חייב להיות parkomat.co.il: הטריגר `enforce_user_creation`
// חוסם כל כתובת אחרת, כולל של מכונה.
const emailFor = (code) => `site-${code}@parkomat.co.il`;

async function main() {
  const code = process.argv[2];
  const rotate = process.argv.includes("--rotate");

  if (!code || code.startsWith("--")) {
    console.error("שימוש: node --env-file=.env tools/provision-agent-user.js <קוד-אתר> [--rotate]");
    process.exit(1);
  }
  if (!SB || !SECRET) {
    console.error("❌ חסרים SUPABASE_URL / SUPABASE_SECRET_KEY");
    process.exit(1);
  }

  await db.init();

  const site = await db.prepare("SELECT id, code, site_name FROM sites WHERE code = ?").get(code);
  if (!site) {
    console.error(`❌ אין אתר עם הקוד ${code}`);
    process.exit(1);
  }

  const email = emailFor(code);
  const password = newPassword();
  const admin = { apikey: SECRET, Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };

  const existing = await db.prepare(
    "SELECT id, supabase_uid, is_active, site_id FROM app_users WHERE LOWER(email) = LOWER(?)"
  ).get(email);

  // ⚠️ הנפקה חוזרת בלי --rotate נחסמת בכוונה. הסיסמה אינה ניתנת לשחזור,
  // ולכן "להריץ שוב כדי לראות אותה" הוא בדיוק המצב שבו מישהו מנתק אתר
  // עובד בלי לשים לב. --rotate אומר "אני יודע שהאתר יפסיק לדווח עד
  // שאעדכן אותו".
  if (existing && !rotate) {
    console.error(`❌ כבר קיים סוכן ל-${code} (${email}).`);
    console.error("   הסיסמה אינה ניתנת לשחזור. להנפקת סיסמה חדשה: --rotate");
    console.error("   ⚠️ החלפה מנתקת את האתר עד שה-config שלו יעודכן.");
    process.exit(1);
  }

  let uid = existing?.supabase_uid;

  if (!existing) {
    const r = await fetch(`${SB}/auth/v1/admin/users`, {
      method: "POST", headers: admin,
      body: JSON.stringify({
        email, password, email_confirm: true,
        // ⚠️ חובה: הטריגר `enforce_invite_only` דורש parkomat_role בזמן
        // commit. בלעדיו היצירה נופלת, ו-app.current_role() היה קורא
        // 'anonymous'.
        app_metadata: { parkomat_role: "agent", site_code: String(code) },
      }),
    });
    if (!r.ok) {
      console.error(`❌ יצירת משתמש נכשלה: ${r.status} ${(await r.text()).slice(0, 300)}`);
      process.exit(1);
    }
    uid = (await r.json()).id;
    console.log(`נוצר חשבון הזדהות: ${email}`);
  } else {
    const r = await fetch(`${SB}/auth/v1/admin/users/${uid}`, {
      method: "PUT", headers: admin, body: JSON.stringify({ password }),
    });
    if (!r.ok) {
      console.error(`❌ החלפת סיסמה נכשלה: ${r.status} ${(await r.text()).slice(0, 300)}`);
      process.exit(1);
    }
    console.log(`הוחלפה סיסמה: ${email}`);
  }

  // ⚠️ הדרגה והשיוך נכתבים ביד, ולא נסמכים על הטריגר. `provision_app_user`
  // רץ ב-AFTER INSERT — לפני שגו-טרו כותב את app_metadata — ולכן השורה
  // נולדת כ-`operator` בלי site_id. `app.current_app_role()` קורא מהטבלה
  // ולא מהתביעה, כך שבלי השורות האלה הסוכן הוא סוכן בנייר בלבד.
  await db.prepare(
    "UPDATE app_users SET role = 'agent', site_id = ?, is_active = TRUE WHERE LOWER(email) = LOWER(?)"
  ).run(site.id, email);

  const row = await db.prepare(
    "SELECT id, email, role, site_id, is_active FROM app_users WHERE LOWER(email) = LOWER(?)"
  ).get(email);

  if (!row || row.role !== "agent" || row.site_id !== site.id) {
    console.error("❌ שורת app_users לא נכתבה כצפוי:", JSON.stringify(row));
    process.exit(1);
  }

  console.log("");
  console.log("═".repeat(62));
  console.log(`  אתר      : ${site.code} — ${site.site_name}`);
  console.log(`  משתמש    : ${email}`);
  console.log(`  סיסמה    : ${password}`);
  console.log(`  מתוחם ל  : site_id ${site.id} · דרגה ${row.role}`);
  console.log("═".repeat(62));
  console.log("");
  // ⚠️ ההדפסה היא הפעם היחידה. הסיסמה אינה נשמרת בשום מקום אצלנו —
  // Supabase מחזיק גיבוב בלבד — ולכן שורה שנסגרה בלי להעתיק אותה
  // משמעה הנפקה מחדש.
  console.log("⚠️  הסיסמה מוצגת **פעם אחת בלבד**. העתיקי אותה עכשיו.");
  console.log("    היא נכנסת ל-config.json של הסוכן באתר.");
  process.exit(0);
}

main().catch((e) => { console.error("שגיאה:", e.message); process.exit(1); });
