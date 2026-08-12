// tools/check-scope.js — שער: מה בקר רואה, ומה לא.
//
// ============================================================
// למה זה שער ולא בדיקת יחידה
// ============================================================
// ⚠️ RLS אינו ניתן לבדיקה בזיכרון. המדיניות רצה **במסד**, תחת רול אחר,
// ועם זהות שמגיעה מ-JWT או מ-GUC. בדיקה שמריצה JS מול מפות לא נוגעת בה
// בכלל — היא תעבור בשלמות גם אם כל המדיניות נמחקו.
//
// ⚠️ וזה בדיוק סוג הכשל הגרוע: מדיניות שנשברה אינה זורקת שגיאה. היא
// מחזירה **יותר שורות**. מסך שנראה תקין לחלוטין, ומשתמש שרואה מה שאסור.
//
// ============================================================
// הכלל שנבדק כאן
// ============================================================
// **בקר רואה את כל האתרים ואת כל היומן — למעט פעולות ניהול המשתמשים.**
// מי נכנס למערכת ומי הוצא ממנה הוא עניין של הנהלה; תחזוקה ורישום אתר
// נוגעים לעבודה היומיומית וגלויים לכולם.
//
// ⚠️⚠️ והנקודה השברירית: ההרשאה נשענת על **התחילית `user.`** בשם הפעולה.
// פעולה שתיקרא `users.invite` תהיה גלויה לבקרים בלי שאיש ישים לב. שתי
// הבדיקות האחרונות כאן הן מה שעומד בין הכלל לבין הפרה שקטה שלו.
const db = require("../db/db");

// ============================================================
// ניסיון חוזר על ניתוק חולף — אחרת השער מרצד
// ============================================================
// ⚠️ נמדד: השער עבר חמש ריצות רצופות ונפל תחת npm run gates, על
// ECONNRESET מ-Supavisor. db.js מנסה קריאות מחדש, אבל **לא בתוך
// טרנזקציה** — שם runOn משרשר על client קבוע, וניתוק שלו מפיל את הכול.
//
// ⚠️ ושער שנופל אקראית הוא שער שלומדים להתעלם ממנו. זה כבר קרה בפרויקט
// הזה פעמיים (parity על מקטע פתוח, parity-activity על קליטה חיה), ובשני
// המקרים התיקון היה אותו תיקון: לוודא שהכשל מגיע מהקוד ולא מהרשת.
//
// ⚠️ הניסיון החוזר **רק על ניתוק**. שגיאת מדיניות או ספירה שגויה חייבות
// להפיל מיד — ניסיון חוזר עליהן היה מסתיר בדיוק את מה שהשער בא לתפוס.
const TRANSIENT = /ECONNRESET|Connection terminated|socket hang up/i;

async function retryTransient(fn, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= tries || !TRANSIENT.test(err.message || "")) throw err;
      console.log(`   (ניתוק חולף — ניסיון ${i}/${tries - 1})`);
      await new Promise((r) => setTimeout(r, 250 * i));
    }
  }
}

// מדמים בקשה מזוהה: app.current_actor() נופל ל-GUC app.user_id כשאין JWT.
async function asUser(uid, fn) {
  return retryTransient(() => db.transaction(async () => {
    // ⚠️ SET LOCAL — נמשך עד סוף הטרנזקציה בלבד, ולכן אינו דולף לחיבור
    // הבא בבריכה. בלי LOCAL הרול היה נשאר authenticated לכל שאילתה אחרת.
    await db.prepare("SET LOCAL ROLE authenticated").run();
    await db.prepare(`SET LOCAL app.user_id = '${uid}'`).run();
    return fn();
  }));
}

const UID_MGR = "00000000-0000-0000-0000-0000000000a1";
const UID_OPR = "00000000-0000-0000-0000-0000000000b2";
const SEED = "rlscheck";

(async () => {
  // ⚠️ חימום: קריאה מנוסה מחדש בניתוק חולף, כתיבה **לא** — ולכן כתיבה
  // כשאילתה הראשונה על חיבור טרי נופלת על ECONNRESET מ-Supavisor.
  await db.prepare("SELECT 1").get();

  const cleanup = async () => {
    await db.prepare(`DELETE FROM audit_log WHERE actor_name LIKE '${SEED}%'`).run();
    await db.prepare(`DELETE FROM app_users WHERE email LIKE '${SEED}%'`).run();
  };
  await cleanup();

  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO app_users (email, full_name, role, supabase_uid, created_at)
     VALUES ('${SEED}-mgr@parkomat.co.il', '${SEED} מנהל', 'manager', ?, ?)`
  ).run(UID_MGR, now);
  await db.prepare(
    `INSERT INTO app_users (email, full_name, role, supabase_uid, created_at)
     VALUES ('${SEED}-opr@parkomat.co.il', '${SEED} בקר', 'operator', ?, ?)`
  ).run(UID_OPR, now);

  // שלוש שורות ביקורת: שתיים שאמורות להיראות לכולם, ואחת שלא.
  const rows = [
    ["maintenance.start", "manager"],   // מנהל, אבל פעולה תפעולית — גלוי
    ["site.register", "manager"],       // אותו דבר
    ["user.invite", "manager"],         // ניהול משתמשים — מוסתר מבקר
  ];
  for (const [action, role] of rows) {
    await db.prepare(
      `INSERT INTO audit_log (at, actor_name, actor_role, trust, action)
       VALUES (?, ?, ?, 'token', ?)`
    ).run(now, `${SEED} ${action}`, role, action);
  }

  const total = (await db.prepare("SELECT COUNT(*)::int n FROM sites").get()).n;

  const sitesSeen = (u) => asUser(u, async () =>
    (await db.prepare("SELECT COUNT(*)::int n FROM sites").get()).n);
  const auditSeen = (u, like) => asUser(u, async () =>
    (await db.prepare(
      `SELECT COUNT(*)::int n FROM audit_log
        WHERE actor_name LIKE '${SEED}%'` + (like ? ` AND action = '${like}'` : "")).get()).n);

  const checks = [
    ["מנהל רואה את כל האתרים", await sitesSeen(UID_MGR), total],
    ["⚠️ בקר רואה את כל האתרים", await sitesSeen(UID_OPR), total],
    ["מנהל רואה את שלוש שורות היומן", await auditSeen(UID_MGR), 3],
    ["בקר רואה שתיים מתוך שלוש", await auditSeen(UID_OPR), 2],
    ["⚠️ בקר אינו רואה user.invite", await auditSeen(UID_OPR, "user.invite"), 0],
    ["⚠️ בקר כן רואה maintenance.start", await auditSeen(UID_OPR, "maintenance.start"), 1],
    ["...וגם site.register", await auditSeen(UID_OPR, "site.register"), 1],
  ];

  console.log("בדיקה                                   בפועל  צפוי");
  let bad = 0;
  for (const [name, got, want] of checks) {
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${name.padEnd(38)}${String(got).padStart(5)} ${String(want).padStart(5)}  ${ok ? "✅" : "❌"}`);
  }

  await cleanup();
  console.log(bad === 0 ? "\n✅ הכלל נאכף" : `\n❌ ${bad} כשלים`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
