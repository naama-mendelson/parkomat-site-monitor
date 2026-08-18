// tools/lib/gate-user.js — משתמש זמני לשערים שצריכים אסימון אמיתי.
//
// ============================================================
// ⚠️ למה זה נכתב: שער שתלוי בחשבון של אדם נשבר כשהאדם נמחק
// ============================================================
// שלושת שערי ה-PostgREST דרשו `PARITY_EMAIL` / `PARITY_PASSWORD` — כלומר
// חשבון אנושי אמיתי וסיסמתו. **וזה בדיוק מה שקרה:** החשבון שבו הם השתמשו
// נמחק, ומאותו רגע שלושה מתוך שלושה-עשר שערים לא יכלו לרוץ בכלל. הם לא
// דיווחו על תקלה — הם דיווחו "לא רץ", וזה המצב שכל gates.js נבנה כדי
// שיהיה גלוי. גלוי, אבל עדיין לא נבדק.
//
// ⚠️ ולא פחות חשוב: הפתרון הקודם דרש שסיסמה של אדם תשב במשתנה סביבה או
// בהיסטוריית הפקודות. משתמש חד-פעמי שנוצר ונמחק באותה ריצה מסיר את הצורך.
//
// ============================================================
// מה זה **לא** פותר, ובכוונה
// ============================================================
// ⚠️ המשתמש נוצר דרך ה-Admin API, כלומר דרוש `SUPABASE_SECRET_KEY`. זה לא
// מחליף את בדיקת ההרשאות — הוא רק מספק זהות לבדיקות **פריטי** (השוואת
// מספרים בין JS ל-SQL), שאין להן עניין במי המשתמש. מי-מורשה-למה נבדק
// ב-check-permissions וב-check-writes, ושם המשתמשים נוצרים באותה שיטה.
//
// ⚠️ והתפקיד הוא `manager` במתכוון: שערי הפריטי משווים את מה שהדשבורד
// מציג למנהל. בקר רואה פחות (check-scope בודק בדיוק את זה), ולכן שער
// שירוץ כבקר היה משווה תת-קבוצה ומדווח על התאמה מלאה.
const PW = "GateUser!2026";

/**
 * מחזיר `{ token, email, cleanup }`.
 *
 * ⚠️ אם `PARITY_EMAIL` / `PARITY_PASSWORD` הוגדרו — הם מנצחים, ו-`cleanup`
 * אינו עושה דבר. זה נשמר כדי שאפשר יהיה לבדוק כניסה של חשבון אמיתי, ולא
 * רק של חשבון שהשער בנה לעצמו.
 */
async function gateToken(sbUrl, anonKey, secretKey, fetchFn = fetch) {
  const envEmail = process.env.PARITY_EMAIL;
  const envPassword = process.env.PARITY_PASSWORD;

  const signIn = async (email, password) => {
    const r = await fetchFn(`${sbUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!r.ok) throw new Error(`התחברות נכשלה: ${r.status} ${(await r.text()).slice(0, 120)}`);
    return (await r.json()).access_token;
  };

  // ⚠️ הסיסמה מוחזרת ולא רק האסימון: parity-shape נכנס דרך
  // `supabase.auth.signInWithPassword` של הלקוח האמיתי — כלומר **בדיוק
  // המסלול שהדפדפן מריץ** — ואסימון גולמי לא היה מאכלס לו session.
  if (envEmail && envPassword) {
    return {
      token: await signIn(envEmail, envPassword),
      email: envEmail, password: envPassword, cleanup: async () => {},
    };
  }

  if (!secretKey) {
    throw new Error("gate-user: אין PARITY_EMAIL/PARITY_PASSWORD ואין SUPABASE_SECRET_KEY");
  }

  const admin = { apikey: secretKey, Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" };
  // ⚠️ הדומיין חייב להיות parkomat.co.il — טריגר `enforce_user_creation`
  // חוסם כל כתובת אחרת, כולל של שער.
  const email = `gate${Date.now()}@parkomat.co.il`;

  const created = await fetchFn(`${sbUrl}/auth/v1/admin/users`, {
    method: "POST", headers: admin,
    body: JSON.stringify({
      email, password: PW, email_confirm: true,
      app_metadata: { parkomat_role: "manager" },
    }),
  });
  if (!created.ok) {
    throw new Error(`gate-user: יצירת משתמש נכשלה: ${(await created.text()).slice(0, 200)}`);
  }
  const uid = (await created.json()).id;

  // ⚠️ **התפקיד נכתב ל-app_users ביד, וזה לא מיותר.** `provision_app_user`
  // רץ ב-AFTER INSERT — לפני שגו-טרו כותב את ה-app_metadata — ולכן הוא
  // בונה את השורה כבקר. `app.current_app_role()` קורא מ-app_users, לא
  // מהתביעה, ובלי השורה הזו המשתמש היה מנהל בנייר בלבד.
  const db = require("../../db/db");
  await db.prepare("UPDATE app_users SET role = 'manager' WHERE LOWER(email) = LOWER(?)").run(email);

  const token = await signIn(email, PW);

  // ⚠️ מוחק את **שני** הצדדים. מחיקת חשבון ה-auth בלבד משאירה שורת
  // app_users יתומה — בדיוק המצב שנמצא בייצור, ושעליו check-writes נופל
  // עכשיו. שער שמייצר את התקלה שהוא בא לתפוס הוא הגרוע שבכולם.
  const cleanup = async () => {
    try {
      await fetchFn(`${sbUrl}/auth/v1/admin/users/${uid}`, { method: "DELETE", headers: admin });
      await db.prepare("DELETE FROM app_users WHERE LOWER(email) = LOWER(?)").run(email);
    } catch (e) {
      console.error(`⚠️ ניקוי משתמש השער נכשל (${email}): ${e.message}`);
    }
  };

  return { token, email, password: PW, cleanup };
}

module.exports = { gateToken };
