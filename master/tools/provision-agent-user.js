// tools/provision-agent-user.js — מנפיק זהות לסוכן של אתר.
//
//   node --env-file=.env tools/provision-agent-user.js <קוד-אתר>
//   node --env-file=.env tools/provision-agent-user.js <קוד-אתר> --rotate
//   node --env-file=.env tools/provision-agent-user.js --all          ← כל הצי
//
// ⚠️ `--all` כותב את הסיסמאות לקובץ טקסט גלוי (`agent-passwords-*.txt`,
// מוחרג מגיט). זו פשרה מודעת: החלופה היא 18 חלונות טרמינל ו-18 העתקות
// ידניות, וכל אחת מהן הזדמנות לדלג על אתר — אתר שנראה מותקן ופשוט אינו
// מדווח. הקובץ נועד לעבור למקום מאובטח ולהימחק, והכלי אומר זאת.
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
const fs = require("node:fs");
const path = require("node:path");
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

/**
 * מנפיק זהות לאתר **אחד**. מחזיר { email, password } או זורק.
 *
 * ⚠️ הוצא מ-main כדי ש-`--all` יוכל לקרוא לו בלולאה. הלוגיקה זהה
 * לחלוטין — שני מסלולים לאותו קוד הם שני מסלולים שיכולים להיפרד,
 * ואז אתר שהונפק באצווה מתנהג אחרת מאתר שהונפק לבד.
 */
async function provisionOne(site, { rotate }) {
  const email = emailFor(site.code);
  const password = newPassword();
  const admin = { apikey: SECRET, Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };

  const existing = await db.prepare(
    "SELECT id, supabase_uid, is_active, site_id FROM app_users WHERE LOWER(email) = LOWER(?)"
  ).get(email);

  // ⚠️ הנפקה חוזרת בלי --rotate נחסמת בכוונה. הסיסמה אינה ניתנת לשחזור,
  // ולכן "להריץ שוב כדי לראות אותה" הוא בדיוק המצב שבו מישהו מנתק אתר
  // עובד בלי לשים לב. --rotate אומר "אני יודע שהאתר יפסיק לדווח עד
  // שאעדכן אותו".
  // ⚠️ שגיאה מסומנת ולא process.exit: ב-`--all` אתר שכבר הונפק הוא
  // **דילוג**, לא כישלון — אחרת הרצה שנייה על צי חלקי הייתה נעצרת
  // באתר הראשון ולא מנפיקה לאף אחד מהשאר.
  if (existing && !rotate) {
    const err = new Error(`כבר קיים סוכן ל-${site.code} (${email})`);
    err.alreadyExists = true;
    throw err;
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
        app_metadata: { parkomat_role: "agent", site_code: String(site.code) },
      }),
    });
    if (!r.ok) throw new Error(`יצירת משתמש נכשלה: ${r.status} ${(await r.text()).slice(0, 200)}`);
    uid = (await r.json()).id;
    console.log(`נוצר חשבון הזדהות: ${email}`);
  } else {
    const r = await fetch(`${SB}/auth/v1/admin/users/${uid}`, {
      method: "PUT", headers: admin, body: JSON.stringify({ password }),
    });
    if (!r.ok) throw new Error(`החלפת סיסמה נכשלה: ${r.status} ${(await r.text()).slice(0, 200)}`);
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

  if (!row || row.role !== "agent" || row.site_id !== site.id)
    throw new Error(`שורת app_users לא נכתבה כצפוי: ${JSON.stringify(row)}`);

  return { email, password, siteId: site.id, role: row.role };
}

// ============================================================
// ⚠️ אצווה — פקודה אחת לכל הצי
// ============================================================
// בלי זה, הפעלת 18 אתרים היא 18 חלונות טרמינל ו-18 העתקות ידניות, וכל
// אחת מהן הזדמנות לדלג על אתר בלי לשים לב — אתר שנראה מותקן ופשוט אינו
// מדווח, בלי שום שגיאה בשום מקום.
async function provisionAll(rotate) {
  const sites = await db.prepare("SELECT id, code, site_name FROM sites ORDER BY code").all();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const file = path.join(__dirname, "..", `agent-passwords-${stamp}.txt`);

  // ⚠️ **כותבים שורה-שורה, ולא אוסף בזיכרון ומדפיס בסוף.** אתר שנופל
  // באמצע היה גורר איתו את הסיסמאות של כל מי שכבר הונפק לפניו — והן
  // אינן ניתנות לשחזור. אותו נימוק בדיוק כמו `PendingQueue` בסוכן:
  // מבנה שנועד למנוע אובדן והופך למקור אובדן.
  fs.writeFileSync(file,
    `# סיסמאות סוכנים — נוצר ${new Date().toISOString()}\n` +
    `# ⚠️ טקסט גלוי. להעביר למקום מאובטח ולמחוק את הקובץ.\n` +
    `# כל שורה: קוד-אתר <TAB> שם-משתמש <TAB> סיסמה\n\n`);

  let ok = 0, skipped = 0, failed = 0;
  for (const site of sites) {
    try {
      const r = await provisionOne(site, { rotate });
      fs.appendFileSync(file, `${site.code}\t${r.email}\t${r.password}\n`);
      console.log(`  ✅ ${site.code} — ${site.site_name}`);
      ok++;
    } catch (e) {
      if (e.alreadyExists) { console.log(`  ⏭️  ${site.code} — כבר קיים, דולג`); skipped++; }
      // ⚠️ כישלון באתר אחד אינו עוצר את השאר. הצי אינו הומוגני, ואתר
      // אחד תקול לא צריך למנוע מ-17 האחרים לקבל זהות.
      else { console.log(`  ❌ ${site.code} — ${e.message}`); failed++; }
    }
  }

  console.log("");
  console.log("═".repeat(62));
  console.log(`  הונפקו: ${ok} · דולגו: ${skipped} · נכשלו: ${failed}`);
  console.log(`  הסיסמאות נכתבו ל: ${file}`);
  console.log("═".repeat(62));
  console.log("");
  console.log("⚠️  הקובץ הוא טקסט גלוי, והסיסמאות אינן ניתנות לשחזור.");
  console.log("    להעביר למקום מאובטח, ולמחוק אותו מכאן.");
  console.log("    (הוא מוחרג מגיט, אבל החרגה אינה הצפנה.)");
  return failed === 0 ? 0 : 1;
}

async function main() {
  const arg = process.argv[2];
  const rotate = process.argv.includes("--rotate");
  const all = process.argv.includes("--all");

  if (!all && (!arg || arg.startsWith("--"))) {
    console.error("שימוש:");
    console.error("  node --env-file=.env tools/provision-agent-user.js <קוד-אתר> [--rotate]");
    console.error("  node --env-file=.env tools/provision-agent-user.js --all [--rotate]");
    process.exit(1);
  }
  if (!SB || !SECRET) {
    console.error("❌ חסרים SUPABASE_URL / SUPABASE_SECRET_KEY");
    process.exit(1);
  }

  await db.init();

  if (all) process.exit(await provisionAll(rotate));

  const site = await db.prepare("SELECT id, code, site_name FROM sites WHERE code = ?").get(arg);
  if (!site) {
    console.error(`❌ אין אתר עם הקוד ${arg}`);
    process.exit(1);
  }

  let r;
  try {
    r = await provisionOne(site, { rotate });
  } catch (e) {
    console.error(`❌ ${e.message}`);
    if (e.alreadyExists) {
      console.error("   הסיסמה אינה ניתנת לשחזור. להנפקת סיסמה חדשה: --rotate");
      console.error("   ⚠️ החלפה מנתקת את האתר עד שה-config שלו יעודכן.");
    }
    process.exit(1);
  }

  console.log("");
  console.log("═".repeat(62));
  console.log(`  אתר      : ${site.code} — ${site.site_name}`);
  console.log(`  משתמש    : ${r.email}`);
  console.log(`  סיסמה    : ${r.password}`);
  console.log(`  מתוחם ל  : site_id ${r.siteId} · דרגה ${r.role}`);
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
