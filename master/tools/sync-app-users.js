// tools/sync-app-users.js — מסנכרן auth.users → public.app_users.
// שימוש: npm run sync-users
//
// ============================================================
// למה זה קיים, ולמה הוא חייב לרוץ לפני שההיקוף נכנס לתוקף
// ============================================================
// ⚠️ מרגע ש-RLS מוגבל לפי שיוך, **משתמש בלי שורה ב-app_users רואה מסך
// ריק.** לא שגיאה, לא "אין הרשאה" — פשוט אפס אתרים. משתמש קיים שנכנס
// למערכת אחרי השינוי ולפני הסנכרון היה חושב שהמערכת נמחקה.
//
// ============================================================
// למה בכלל שתי טבלאות
// ============================================================
// auth.users הוא של Supabase ואינו נוסע ב-`pg_dump --schema=public`.
// app_users הוא שלנו: כאן חיים הדרגה, השיוך, ומי צירף את מי. הקישור הוא
// עמודת supabase_uid **בלי FK** — חוק 1 בדלת היציאה.
//
// ============================================================
// שני כיוונים, ורק אחד מהם מסוכן
// ============================================================
// יצירת שורה חסרה — בטוחה לגמרי ואידמפוטנטית.
// **עדכון דרגה קיימת — לא.** מנהל שהודח לבקר ב-app_users וסנכרון היה
// מחזיר אותו למנהל מהתביעה הישנה, כלומר ההדחה הייתה מתבטלת בשקט.
// לכן: הכלי **אינו נוגע** בשורות קיימות. app_users הוא מקור האמת לדרגה.
//
// ⚠️ המשתמש הראשון במערכת נוצר כ**מנהל** בכל מקרה. בלי זה אין אף אחד
// שיכול לנהל משתמשים, והמערכת ננעלת על עצמה בהתקנה חדשה.

const db = require("../db/db");

async function syncAppUsers({ quiet = false } = {}) {
  // קריאה ראשונה — היא מנוסה מחדש בניתוק חולף, כתיבה לא.
  await db.prepare("SELECT 1").get();

  const authUsers = await db.prepare(
    `SELECT id, email,
            raw_app_meta_data->>'parkomat_role' AS role,
            raw_user_meta_data->>'full_name'    AS full_name
       FROM auth.users
      WHERE deleted_at IS NULL
      ORDER BY created_at ASC`
  ).all();

  const existing = new Set(
    (await db.prepare("SELECT LOWER(email) AS e FROM app_users").all()).map((r) => r.e)
  );

  let created = 0;
  const now = new Date().toISOString();

  for (const u of authUsers) {
    if (existing.has(String(u.email).toLowerCase())) continue;

    // אין אף מנהל פעיל? המשתמש הזה נהיה אחד — אחרת אין מי שינהל,
    // והמערכת ננעלת על עצמה בהתקנה חדשה.
    const anyManager = await db.prepare(
      "SELECT 1 FROM app_users WHERE role = 'manager' AND is_active LIMIT 1"
    ).get();

    // ⚠️ שתי קבוצות בלבד. התביעה הישנה עשויה עדיין לומר executive או
    // supervisor — שתיהן ממופות ל-manager, בדיוק כמו המיגרציה בסכמה.
    const claimed = { executive: "manager", supervisor: "manager",
                      manager: "manager", operator: "operator" }[u.role];
    const role = claimed || (anyManager ? "operator" : "manager");

    await db.prepare(
      `INSERT INTO app_users (email, full_name, role, supabase_uid, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (email) DO NOTHING`
    ).run(u.email, u.full_name || null, role, u.id, now);

    created++;
    if (!quiet) console.log(`[users] ✅ נוצרה שורה: ${u.email} · ${role}`);
  }

  // ⚠️ שורה שקיימת אך אינה מקושרת ל-uid לא תיפתר לעולם ב-app.current_app_user(),
  // כלומר המשתמש יהיה "מחובר אבל בלי זהות יישומית" — מסך ריק בלי סיבה גלויה.
  let linked = 0;
  for (const u of authUsers) {
    const r = await db.prepare(
      "UPDATE app_users SET supabase_uid = ? WHERE LOWER(email) = LOWER(?) AND supabase_uid IS NULL"
    ).run(u.id, u.email);
    if (r && r.changes) linked += r.changes;
  }

  if (!quiet) {
    console.log(`[users] ${authUsers.length} ב-auth · ${created} נוצרו · ${linked} קושרו`);
  }
  return { total: authUsers.length, created, linked };
}

if (require.main === module) {
  syncAppUsers()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err.message); process.exit(1); });
}

module.exports = { syncAppUsers };
