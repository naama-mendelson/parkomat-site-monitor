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
// ============================================================
// ⚠️ אקראית לכל ריצה — וכאן זה חמור יותר מב-check-permissions
// ============================================================
// כאן היה `"GateUser!2026"` — סיסמה בקוד הפתוח, שבה נוצר חשבון **מנהל**
// במסד הייצור. הקובץ הזה משרת שלושה שערים, כלומר החשבון הזה נוצר הרבה
// יותר פעמים מכל אחר, וכל ריצה שנקטעת משאירה אותו חי.
//
// ⚠️ **וזה כבר קרה**: חשבון מנהל נשאר פעיל בייצור מריצת שער שהופסקה.
// מנהל מוחק אתר ואת כל ההיסטוריה שלו, ולכן זו אינה עקבה — זו כניסה.
//
// אקראית אינה מונעת את החשבון היתום; היא מונעת שיהיה לו ערך למי שקורא
// את המאגר. `check-no-residue` הוא מה שתופס את היתום עצמו.
const PW = require("node:crypto").randomBytes(24).toString("base64url") + "!aA9";

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

  // ============================================================
  // ⚠️ רשת ביטחון — מסלול יציאה שאיש לא צפה
  // ============================================================
  // הניקוי נקרא במסלולי היציאה **המפורשים** של כל שער, לא ב-finally. די
  // בחריגה אחת שלא נתפסה כדי לדלג עליו.
  //
  // ⚠️ וזה קרה: שגיאת רשת הפילה שער לפני הקריאה, ונשאר בייצור חשבון
  // **מנהל פעיל** — gate1788088486802@parkomat.co.il, עם הרשאה למחוק אתר
  // ואת כל ההיסטוריה שלו, ובלי שאיש יודע עליו. הוא התגלה יום אחרי, בידי
  // check-no-residue.
  //
  // ⚠️ הרשת יושבת **כאן ולא בשבעת השערים**: תיקון בשבעה מקומות נשחק ביום
  // שבו ייכתב שער שמיני. `exit` אינו יכול להמתין ל-await, ולכן נתפסות
  // החריגות עצמן — שם עוד אפשר לנקות לפני שהתהליך מת.
  const steps = [];
  const addCleanup = (fn) => steps.push(fn);

  let done = false;
  const runAll = async () => {
    if (done) return;                       // הניקוי חייב להיות אידמפוטנטי:
    done = true;                            // השערים קוראים לו גם בעצמם.
    for (const fn of steps) {
      try { await fn(); } catch (e) { console.error(`⚠️ שלב ניקוי נכשל: ${e.message}`); }
    }
    await cleanup();
  };

  const bail = async (why, err) => {
    console.error(`⚠️ ${why} — מנקה את משתמש השער לפני יציאה: ${err?.stack ?? err}`);
    await runAll();
    process.exit(1);
  };
  process.on("uncaughtException", (e) => { bail("חריגה שלא נתפסה", e); });
  process.on("unhandledRejection", (e) => { bail("דחייה שלא טופלה", e); });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { bail(sig, "הופסק"); });

  return { token, email, password: PW, cleanup: runAll, addCleanup };
}

module.exports = { gateToken };
