// tools/check-signup.js — שער: מי נכנס למערכת, ומה הוא מקבל.
//
// ============================================================
// למה זה שער ולא בדיקת יחידה
// ============================================================
// הכללים כאן הם **טריגרים על auth.users**. הם רצים בתוך הטרנזקציה של
// GoTrue, על סכמה שאינה שלנו, ועם SECURITY DEFINER. שום בדיקה בזיכרון לא
// נוגעת בהם — היא תעבור בשלמות גם אם הטריגרים נמחקו.
//
// ⚠️ וההיסטוריה כאן מלמדת בדיוק את זה: הגרסה הראשונה של חסימת הדומיין
// **חסמה את כולם**, כולל מיילים מאושרים, בגלל permission denied. הבדיקה
// השלילית ("gmail נחסם") עברה — מהסיבה הלא נכונה. רק בדיקה שכוללת מקרה
// שאמור **לעבור** תפסה את זה.
//
// לכן שלושת המקרים כאן, ובמיוחד הראשון.
//
// ============================================================
// מה נבדק
// ============================================================
//   1. מוזמן (parkomat_role נכתב **אחרי** ה-INSERT) נוצר — זה המקרה שחייב לעבור.
//   2. הרשמה עצמית — אותה כתובת בדיוק, בלי תפקיד — נחסמת.
//   3. דומיין זר נחסם.
//   4. שורת app_users נוצרת, ודרגה קיימת אינה נדרסת.
//
// ⚠️ **מקרה 1 מדמה UPDATE אחרי INSERT ולא INSERT עם תפקיד, וזה מכוון.**
// הגרסה הראשונה של הטריגר הנדחה קראה את `NEW`, ו-`NEW` הוא צילום של השורה
// **בזמן ה-INSERT** — הוא אינו נקרא מחדש ב-commit. GoTrue כותב את
// app_metadata ב-UPDATE שאחרי, ולכן הטריגר חסם **גם את ההזמנה**: ה-Admin
// API החזיר 500. גרסה שכותבת את התפקיד כבר ב-INSERT הייתה עוברת את הבדיקה
// הזו בשלמות ונשברת בפרודקשן.
const db = require("../db/db");

const SEED = "signupcheck";
const uuid = (n) => `00000000-0000-0000-0000-0000000000c${n}`;

async function cleanup() {
  await db.prepare(`DELETE FROM app_users WHERE email LIKE '${SEED}%'`).run();
  await db.prepare(`DELETE FROM auth.users WHERE email LIKE '${SEED}%'`).run();
}

// מה ש-GoTrue שולח ב-INSERT — **בשתי הדרכים**. נמדד בגשש על המופע האמיתי:
// גם הרשמה עצמית וגם Admin API מייצרות בדיוק את זה, בלי parkomat_role.
const GOTRUE_INSERT_META = { provider: "email", providers: ["email"] };

/**
 * מדמה יצירת משתמש כפי ש-GoTrue עושה.
 * `invitedRole` — התפקיד שה-Admin API כותב ב-**UPDATE שאחרי** ה-INSERT.
 *                 null = הרשמה עצמית, שאין אחריה UPDATE כזה.
 */
async function createAuthUser(email, id, invitedRole = null) {
  await db.transaction(async () => {
    await db.prepare(
      `INSERT INTO auth.users (id, instance_id, aud, role, email, raw_app_meta_data,
                               raw_user_meta_data, created_at, updated_at)
       VALUES (?, '00000000-0000-0000-0000-000000000000', 'authenticated',
               'authenticated', ?, ?::jsonb, '{}'::jsonb, now(), now())`
    ).run(id, email, JSON.stringify(GOTRUE_INSERT_META));

    if (invitedRole) {
      await db.prepare(
        `UPDATE auth.users
            SET raw_app_meta_data = raw_app_meta_data || jsonb_build_object('parkomat_role', ?::text)
          WHERE id = ?`
      ).run(invitedRole, id);
    }
  });
}

(async () => {
  await db.prepare("SELECT 1").get();
  await cleanup();

  const checks = [];
  const add = (name, got, want) => checks.push([name, got, want]);

  // ---- 1. מוזמן ע"י מנהל — **חייב לעבור** ----
  const emailOk = `${SEED}-a@parkomat.co.il`;
  let created = true;
  try {
    await createAuthUser(emailOk, uuid(1), "operator");
  } catch (e) {
    created = false;
    console.error("   יצירה נכשלה:", e.message);
  }
  add("מוזמן ע\"י מנהל נוצר", created, true);

  if (created) {
    const meta = await db.prepare(
      "SELECT raw_app_meta_data->>'parkomat_role' AS role FROM auth.users WHERE id = ?"
    ).get(uuid(1));
    add("...והתפקיד נשמר", meta && meta.role, "operator");

    const row = await db.prepare(
      "SELECT role, supabase_uid FROM app_users WHERE LOWER(email) = LOWER(?)"
    ).get(emailOk);
    add("...ונוצרה לו שורת app_users", Boolean(row), true);
    add("...בדרגת בקר", row && row.role, "operator");
    add("...ומקושרת ל-uid", row && row.supabase_uid, uuid(1));
  }

  // ---- 2. הרשמה עצמית — **חייבת להיחסם** ----
  // ⚠️ אותו דומיין בדיוק כמו מקרה 1. ההבדל היחיד הוא ההזמנה, וזו הנקודה:
  // כתובת של החברה היא תנאי הכרחי ולא מספיק.
  let selfBlocked = false;
  try {
    await createAuthUser(`${SEED}-self@parkomat.co.il`, uuid(4));
  } catch {
    selfBlocked = true;
  }
  add("הרשמה עצמית נחסמה", selfBlocked, true);

  // ---- 3. דומיין זר ----
  let blocked = false;
  try {
    await createAuthUser(`${SEED}-b@gmail.com`, uuid(2), "operator");
  } catch {
    blocked = true;
  }
  add("דומיין זר נחסם", blocked, true);

  // ---- 4. דרגה קיימת אינה נדרסת ----
  // מנהל שהוזמן מראש, ורק אחר כך נכנס בפעם הראשונה.
  const emailMgr = `${SEED}-c@parkomat.co.il`;
  await db.prepare(
    `INSERT INTO app_users (email, role, created_at) VALUES (?, 'manager', ?)`
  ).run(emailMgr, new Date().toISOString());
  // ⚠️ עטוף ב-try: כשהטריגר נשבר, יצירה שאמורה להצליח זורקת — ובלי העטיפה
  // השער קורס עם stack trace במקום להדפיס ❌ על המקרה שנפל.
  let mgrCreated = true;
  try {
    await createAuthUser(emailMgr, uuid(3), "manager");
  } catch (e) {
    mgrCreated = false;
    console.error("   יצירת מנהל נכשלה:", e.message);
  }
  add("מנהל שהוזמן נוצר", mgrCreated, true);

  const mgr = await db.prepare(
    "SELECT role, supabase_uid FROM app_users WHERE LOWER(email) = LOWER(?)"
  ).get(emailMgr);
  add("⚠️ דרגת מנהל קיימת שרדה כניסה ראשונה", mgr && mgr.role, "manager");
  add("...ו-uid קושר בכל זאת", mgr && mgr.supabase_uid, uuid(3));

  console.log("בדיקה                                      בפועל       צפוי");
  let bad = 0;
  for (const [name, got, want] of checks) {
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${name.padEnd(42)}${String(got).slice(0, 10).padStart(10)} ${String(want).slice(0, 10).padStart(10)}  ${ok ? "✅" : "❌"}`);
  }

  await cleanup();
  console.log(bad === 0 ? "\n✅ הכניסה למערכת מתנהגת כמתוכנן" : `\n❌ ${bad} כשלים`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
