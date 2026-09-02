// tools/check-permissions.js — שער: מטריצת ההרשאות, נמדדת חי.
//
// ============================================================
// למה שער חי ולא בדיקת יחידה
// ============================================================
// הכלל מפוזר על פני שלוש שכבות שאף אחת מהן אינה רואה את השנייה: גוף
// פונקציות ה-RPC (`app.require_manager()`), טריגרים על `auth.users`, ו-RLS
// על הטבלאות. בדיקה בזיכרון מאמתת שכל שכבה עושה את שלה — ולא שהצירוף
// שלהן מייצר את הכלל שהוזמן.
//
// ⚠️ וזה כבר קרה כאן פעמיים: `requireAuth` נוסף ל-17 מסלולים ו-`askAssistant`
// נשכח כי הוא fetch עצמאי; והשבתת משתמש "עבדה" בשרת בזמן שה-RLS עדיין נתן
// לו לקרוא. בשני המקרים כל בדיקות היחידה היו ירוקות.
//
// לכן כאן נכנסים באמת: מנהל אמיתי ובקר אמיתי, אסימונים אמיתיים, מול
// Supabase — ומנסים כל פעולה משני הצדדים.
//
// ============================================================
// ⚠️ השער כוון מחדש — הצד שהוא בדק **נמחק**
// ============================================================
// עד היום הוא קרא ל-`/api/users`, `/api/users/invite` ו-`/api/sites` על
// שרת ב-:4000. אף אחד מהמסלולים האלה אינו קיים: `api/routes.js` מגיש היום
// **שניים** — `/api/chat` ו-`/health`. כלומר בדיקת הנגישות שבראש הקובץ
// נכשלה בכל הרצה, השער יצא בקוד 2, ו-`gates.js` הדפיס "אין עליהם ידיעה".
//
// ⚠️ וזה גרוע מ"לא רץ": ההודעה *"הפעילי את השרת"* שולחת מישהו לנסות לתקן
// דבר בלתי אפשרי. שרת שיעלה לא יגיש את המסלולים האלה, כי הם אינם בקוד.
//
// המטריצה עצמה לא השתנתה — רק היכן היא נאכפת:
//
//   רשימת משתמשים · השבתה · שינוי דרגה · מחיקה  →  RPC דרך PostgREST
//   הזמנה                                        →  Edge Function invite-user
//   קריאת אתרים                                  →  PostgREST על הטבלה
//
// ⚠️ **וההפרש בין 401 ל"אפס שורות" הוא ממצא, לא פרט טכני.** בשרת, קריאה
// בלי אסימון קיבלה 401 — דחייה מפורשת. מול PostgREST עם המפתח הציבורי
// היא מקבלת **200 ורשימה ריקה**, כי RLS מסננת שורות ואינה דוחה בקשות.
// שתי התשובות בטוחות באותה מידה, אבל קוד שמצפה לשגיאה יראה "אין אתרים"
// ויציג מסך ריק במקום לבקש התחברות. לכן שתי הצורות נבדקות בנפרד.
//
// ============================================================
// מה נדרש
// ============================================================
//   node --env-file=.env tools/check-permissions.js
// אין צורך בשרת.
const fs = require("node:fs");
const path = require("node:path");

const SB_URL = process.env.SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;

const ENV = fs.readFileSync(path.resolve(__dirname, "../../dashboard/.env"), "utf8");
const ANON = (ENV.match(/^VITE_SUPABASE_PUBLISHABLE_KEY=(.*)$/m) || [])[1]?.trim();

const STAMP = `permcheck${Date.now()}`;
const MGR = `${STAMP}.mgr@parkomat.co.il`;
const OPR = `${STAMP}.opr@parkomat.co.il`;
// ============================================================
// ⚠️ סיסמה אקראית לכל ריצה — קבועה כאן הייתה חור אבטחה אמיתי
// ============================================================
// כאן היה `"PermCheck!2026"`, כלומר **סיסמה שכתובה בקוד הפתוח** שבה נוצר
// חשבון **מנהל** במסד הייצור. הניקוי רץ ביציאה ובכל מסלול כשל — אבל לא
// כשהתהליך נהרג: Ctrl+C, נפילת חשמל, או שער שמישהו עוצר באמצע.
//
// ⚠️ **וזה כבר קרה בפרויקט הזה**: חשבון מנהל שנשאר פעיל בייצור מריצת
// שער שהופסקה. עם סיסמה קבועה, חשבון כזה אינו רק "שורה מיותרת" — הוא
// כניסה פתוחה בדרגת מנהל, ומנהל מוחק אתר ואת כל ההיסטוריה שלו.
//
// אקראית אינה מונעת את החשבון היתום; היא מונעת שיהיה לו ערך למי שקורא
// את המאגר. `check-no-residue` הוא מה שתופס את היתום עצמו.
const PW = require("node:crypto").randomBytes(24).toString("base64url") + "!aA9";

// ⚠️ הרשת כאן מנתקת חיבורים מיוזמתה (נמדד: בערך כל בקשה שנייה). בלי חזרה
// השער היה נופל באקראי — כלומר הופך לרעש שמתעלמים ממנו.
async function f(url, opt) {
  let last;
  for (let i = 0; i < 5; i++) {
    try { return await fetch(url, opt); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 500)); }
  }
  throw last;
}

const adminHeaders = { apikey: SECRET, Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };

async function createUser(email, role) {
  const r = await f(`${SB_URL}/auth/v1/admin/users`, {
    method: "POST", headers: adminHeaders,
    body: JSON.stringify({ email, password: PW, email_confirm: true, app_metadata: { parkomat_role: role } }),
  });
  const b = await r.json();
  if (!r.ok) throw new Error(`יצירת ${email} נכשלה: ${r.status} ${b.msg || b.message || ""}`);
  return b.id;
}

async function signIn(email, password = PW) {
  const r = await f(`${SB_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const b = await r.json();
  if (!r.ok) throw new Error(`התחברות ${email} נכשלה: ${r.status} ${b.msg || b.error_description || ""}`);
  return b.access_token;
}

// ⚠️ הכותרות **בדיוק כמו בדפדפן**: apikey ציבורי + Bearer של המשתמש. זו
// לא קוסמטיקה — שליחת האסימון לבדו מחזירה 401 מ-PostgREST, ומי שיראה זאת
// יסיק "אין הרשאה" במקום "חסרה כותרת".
const hdr = (token) => ({
  apikey: ANON,
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
  "Content-Type": "application/json",
});

/** קריאת RPC דרך PostgREST — מחזירה סטטוס בלבד. */
async function rpc(token, name, args = {}) {
  const r = await f(`${SB_URL}/rest/v1/rpc/${name}`, {
    method: "POST", headers: hdr(token), body: JSON.stringify(args),
  });
  return r.status;
}

/** קריאה ל-Edge Function — מחזירה סטטוס בלבד. */
async function edge(token, name, body) {
  const r = await f(`${SB_URL}/functions/v1/${name}`, {
    method: "POST", headers: hdr(token), body: JSON.stringify(body),
  });
  return r.status;
}

/**
 * כמה שורות אתרים המשתמש הזה רואה.
 *
 * ⚠️ **מספר ולא סטטוס.** RLS מסננת שורות; היא אינה דוחה בקשות. משתמש
 * מושבת מקבל 200 עם `[]`, וזו התשובה הנכונה — אבל בדיקה שמסתכלת בסטטוס
 * בלבד הייתה מדווחת שהכול תקין בדיוק כשההגנה נעלמה.
 *
 * ⚠️ **וכשל חוזר כמחרוזת, לא כמספר — וזה היה באג אמיתי כאן.** הגרסה
 * הראשונה החזירה `r.status`, והבדיקה "בקר רואה את האתרים" שאלה
 * `> 0`. תשובת `403` הייתה עוברת אותה — כלומר **חסימה מלאה הייתה
 * נקראת כהצלחה**, וזו בדיוק הבדיקה שאמורה להוכיח שבקר כן רואה.
 * מחרוזת נכשלת ב-`> 0` וגם מודפסת קריא בטבלה.
 */
async function siteRows(token) {
  const r = await f(`${SB_URL}/rest/v1/sites?select=id&limit=5`, { headers: hdr(token) });
  if (!r.ok) return `HTTP ${r.status}`;
  const b = await r.json().catch(() => []);
  return Array.isArray(b) ? b.length : 0;
}

async function cleanup() {
  const r = await f(`${SB_URL}/auth/v1/admin/users`, { headers: adminHeaders });
  const l = await r.json();
  for (const u of (l.users || []).filter((u) => u.email?.startsWith(STAMP.slice(0, 9)))) {
    await f(`${SB_URL}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: adminHeaders });
  }
  const db = require("../db/db");
  await db.prepare("DELETE FROM app_users WHERE email LIKE 'permcheck%'").run();

  // ============================================================
  // ⚠️ ושורות הביקורת — עקבה שהשער הזה לא הותיר קודם כי הוא לא רץ
  // ============================================================
  // כל פעולת ניהול כאן (הזמנה, השבתה, שינוי דרגה, מחיקה) כותבת שורת
  // ביקורת דרך `app.record_write_audit`, ו-`audit_log` **נקרא ע"י כל
  // משתמש פעיל**. 21 שורות על שם "permcheck…" הופיעו בייצור ברגע שהשער
  // חזר לרוץ — כלומר עקבה שנוצרה מיד כשהתיקון עבד.
  //
  // ⚠️ ולמה זה חשוב יותר משאר העקבות: הן נראות **בדיוק כמו** פעולות ניהול
  // אמיתיות של אדם, במסך שאנשים קוראים כדי לענות על "מי עשה מה".
  //
  // ⚠️ ביטוי רגולרי ולא `LIKE 'permcheck%'`: `actor_name` מגיע מ-
  // `app.actor_display_name()`, שמעדיף שם מלא על כתובת. היום אין שם מלא
  // למשתמשי השער ולכן זו הכתובת — אבל בדיקה שנשענת על כך הייתה מפסיקה
  // לנקות ברגע שמישהו יוסיף שם, בלי שום סימן.
  await db.prepare("DELETE FROM audit_log WHERE actor_name ~ 'permcheck[0-9]'").run();
}

(async () => {
  if (!SB_URL || !SECRET || !ANON) {
    console.error("check-permissions: חסרים SUPABASE_URL / SUPABASE_SECRET_KEY / VITE_SUPABASE_PUBLISHABLE_KEY");
    process.exit(1);
  }

  const checks = [];
  const add = (name, got, want) => checks.push([name, got, want]);

  await cleanup();

  // ============================================================
  // ⚠️ המנהל הראשון נזרע ישירות ב-app_users, ולא דרך Admin API
  // ============================================================
  // וזה לא קיצור דרך אלא תיאור נכון של המערכת: `parkomat_role` ב-
  // app_metadata **אינו** קובע את הדרגה. `provision_app_user` הוא AFTER
  // INSERT ורץ לפני ש-GoTrue כותב את המטא-דאטה, ולכן הוא נותן 'operator'
  // לכולם. הדרגה נקבעת ב-app_users — או ע"י מסלול ההזמנה, או כאן.
  //
  // ⚠️ וזו בדיוק הסיבה שהגרסה הראשונה של השער דיווחה על שבעה כשלים: היא
  // יצרה "מנהל" דרך Admin API, הוא נחת כבקר, וכל פעולת ניהול קיבלה 403.
  // הממצא היה אמיתי — הזמנת מנהל אכן יצרה בקר — אבל הזריעה כאן חייבת
  // לעקוף אותו, אחרת אין מנהל שיזמין אף אחד.
  const db = require("../db/db");
  await createUser(MGR, "manager");
  await db.prepare("UPDATE app_users SET role = 'manager' WHERE LOWER(email) = LOWER(?)").run(MGR);
  await createUser(OPR, "operator");
  const mgrTok = await signIn(MGR);

  // ⚠️ **ה-RPC מצפה למזהה המספרי של app_users, לא ל-UUID של Supabase.**
  // שליחת ה-UUID מחזירה 404 על חתימה שאינה קיימת (PGRST202) — וזו בדיוק
  // אי-ההתאמה שכבר שברה את כפתור ההשבתה במסך פעם אחת.
  const appId = async (email) =>
    (await db.prepare("SELECT id FROM app_users WHERE LOWER(email) = LOWER(?)").get(email))?.id;
  const oprAppId = await appId(OPR);
  const mgrAppId = await appId(MGR);

  // ---- מה שמנהל יכול ----
  add("מנהל רואה את רשימת המשתמשים", await rpc(mgrTok, "list_users"), 200);
  add("מנהל מוסיף בקר", await edge(mgrTok, "invite-user",
      { email: `${STAMP}.new1@parkomat.co.il`, role: "operator" }), 200);
  add("מנהל מוסיף מנהל", await edge(mgrTok, "invite-user",
      { email: `${STAMP}.new2@parkomat.co.il`, role: "manager" }), 200);

  // ⚠️ **והמנהל שהוזמן הוא באמת מנהל — זו הבדיקה שתופסת את הבאג האמיתי.**
  // "ההזמנה החזירה 200" אינה מוכיחה כלום: היא החזירה 200 גם כשהמוזמן נחת
  // כבקר, כי `parkomat_role` נכתב ל-Supabase בלבד ו-app_users נשאר
  // 'operator'. לכן נבדק כאן מה שקובע — הדרגה בטבלה.
  const invitedRole = await db
    .prepare("SELECT role FROM app_users WHERE LOWER(email) = LOWER(?)")
    .get(`${STAMP}.new2@parkomat.co.il`);
  add("...והוא באמת מנהל ב-app_users", invitedRole?.role, "manager");

  const invitedOprRole = await db
    .prepare("SELECT role FROM app_users WHERE LOWER(email) = LOWER(?)")
    .get(`${STAMP}.new1@parkomat.co.il`);
  add("...והמוזמן כבקר נשאר בקר", invitedOprRole?.role, "operator");

  add("מנהל משבית בקר",
      await rpc(mgrTok, "set_user_active", { p_user_id: oprAppId, p_active: false }), 200);
  add("מנהל מחזיר בקר",
      await rpc(mgrTok, "set_user_active", { p_user_id: oprAppId, p_active: true }), 200);
  add("מנהל משנה דרגה",
      await rpc(mgrTok, "set_user_role", { p_user_id: oprAppId, p_role: "manager" }), 200);

  // ---- ⚠️ ומה שבקר **אינו** יכול — זה החצי שקובע ----
  await rpc(mgrTok, "set_user_role", { p_user_id: oprAppId, p_role: "operator" });
  const oprFresh = await signIn(OPR);

  add("⚠️ בקר אינו רואה את רשימת המשתמשים", await rpc(oprFresh, "list_users"), 403);
  add("⚠️ בקר אינו מוסיף משתמש", await edge(oprFresh, "invite-user",
      { email: `${STAMP}.hack@parkomat.co.il`, role: "operator" }), 403);
  add("⚠️ בקר אינו משבית אף אחד",
      await rpc(oprFresh, "set_user_active", { p_user_id: mgrAppId, p_active: false }), 403);
  add("⚠️ בקר אינו מעלה את עצמו למנהל",
      await rpc(oprFresh, "set_user_role", { p_user_id: oprAppId, p_role: "manager" }), 403);

  // ---- ומה שבקר כן צריך לראות ----
  add("בקר רואה את האתרים", (await siteRows(oprFresh)) > 0, true);

  // ---- בלי אסימון בכלל ----
  //
  // ⚠️ שתי צורות, ולא אחת — ושתיהן חוזרות **401**, וזה היה ממצא.
  //
  // הציפייה הראשונה כאן הייתה "200 ורשימה ריקה": RLS מסננת שורות ואינה
  // דוחה בקשות, ולכן `anon` אמור היה לקבל `[]`. **נמדד שלא** — המפתח
  // הציבורי בפורמט החדש (`sb_publishable_…`) אינו JWT, ולכן PostgREST
  // דוחה עוד לפני שכל מדיניות נבחנת.
  //
  // זו תשובה **חזקה יותר** מסינון שורות, ולכן היא נבדקת כפי שהיא: בקשה
  // אנונימית נעצרת בשער ולא בטבלה. אילו הפורמט היה חוזר ל-JWT ציבורי,
  // הבדיקה הזו הייתה מתחילה להחזיר 200 — וזה בדיוק הרגע שבו צריך לחזור
  // ולוודא שהמדיניות עדיין דורשת `authenticated`.
  const noKey = await f(`${SB_URL}/rest/v1/sites?select=id&limit=1`);
  add("⚠️ בלי מפתח כלל — נדחה", noKey.status, 401);
  add("⚠️ מפתח ציבורי בלבד — אתרים חסומים", await siteRows(null), "HTTP 401");
  add("⚠️ מפתח ציבורי בלבד — אין רשימת משתמשים", await rpc(null, "list_users"), 401);

  // ---- דומיין זר ----
  let foreignBlocked = false;
  try { await createUser(`${STAMP}@gmail.com`, "operator"); } catch { foreignBlocked = true; }
  add("⚠️ דומיין זר נדחה", foreignBlocked, true);

  // ---- ⚠️ משתמש מושבת אינו קורא, גם עם אסימון תקף ----
  // זה הכשל שכבר קרה: השרת השבית, וה-RLS עדיין נתן לקרוא. היום המדיניות
  // עצמה קוראת `app.is_active_user()`, וזו הבדיקה שמוכיחה זאת.
  const victim = `${STAMP}.dead@parkomat.co.il`;
  await createUser(victim, "operator");
  const victimAppId = await appId(victim);
  const victimTok = await signIn(victim);
  add("משתמש פעיל קורא אתרים", (await siteRows(victimTok)) > 0, true);
  await rpc(mgrTok, "set_user_active", { p_user_id: victimAppId, p_active: false });
  add("⚠️ ואחרי השבתה — אותו אסימון מקבל אפס שורות", await siteRows(victimTok), 0);

  // ============================================================
  // ⚠️ השרשרת האמיתית: הזמנה → סיסמה זמנית → **כניסה בפועל**
  // ============================================================
  // כל שאר הבדיקות כאן יוצרות משתמשים עם סיסמה שאנחנו קובעים, ולכן אף
  // אחת מהן לא נוגעת בחוליה שבאמת משמשת: הסיסמה שה-Edge Function
  // **מייצר** ומחזיר פעם אחת, ושמישהו מקליד בפועל.
  //
  // ⚠️ אם היא תפסיק לחזור, או תחזור שונה מזו שנקבעה, או `email_confirm`
  // יישכח — כל הבדיקות האחרות יישארו ירוקות והמסך ימשיך להציג סיסמה.
  // היא פשוט לא תעבוד, ואיש לא יידע עד שמישהו ינסה להיכנס איתה.
  const fresh = `${STAMP}.flow@parkomat.co.il`;
  const invRes = await f(`${SB_URL}/functions/v1/invite-user`, {
    method: "POST", headers: hdr(mgrTok),
    body: JSON.stringify({ email: fresh, role: "operator" }),
  });
  const invBody = await invRes.json().catch(() => ({}));
  add("הזמנה מחזירה סיסמה זמנית", Boolean(invBody.tempPassword), true);

  const freshLogin = await f(`${SB_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email: fresh, password: invBody.tempPassword }),
  });
  add("⚠️ והמשתמש נכנס איתה בפועל", freshLogin.ok, true);

  // ============================================================
  // מחיקה — ולא רק שהיא מחזירה 200
  // ============================================================
  const victim2 = `${STAMP}.del@parkomat.co.il`;
  await createUser(victim2, "operator");
  const victim2AppId = await appId(victim2);
  const victim2Tok = await signIn(victim2);

  add("⚠️ בקר אינו מוחק אף אחד", await rpc(oprFresh, "delete_user", { p_id: victim2AppId }), 403);
  add("מנהל מוחק בקר", await rpc(mgrTok, "delete_user", { p_id: victim2AppId }), 200);

  // ⚠️ "200" אינו מוכיח מחיקה. שלוש בדיקות נפרדות, כי המחיקה נוגעת בשלושה
  // מקומות ואפשר להצליח בחלקם.
  const stillHere = await db.prepare("SELECT id FROM app_users WHERE id = ?").get(victim2AppId);
  add("...והשורה נעלמה מ-app_users", Boolean(stillHere), false);

  // ⚠️ **וגם מ-Supabase — אחרת הוא עדיין יכול להתחבר.** מחיקה חלקית משאירה
  // משתמש מאומת בלי שורה, כלומר בלי זהות במערכת.
  const gone = await f(`${SB_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email: victim2, password: PW }),
  });
  add("...ואינו יכול להתחבר יותר", gone.ok, false);

  // והאסימון שכבר היה בידו מת גם הוא — כלומר אינו רואה שורה אחת.
  add("...והאסימון הישן שלו מקבל אפס שורות", await siteRows(victim2Tok), 0);

  // ---- ⚠️ ומחיקת מי שכבר צירף אחרים — המקרה שנופל בלי ON DELETE SET NULL ----
  // `created_by` ו-`disabled_by` הם FK פנימיים בתוך app_users. בלי הסעיף
  // הזה Postgres דוחה את המחיקה על הפרת אילוץ — כלומר דווקא הוותיקים,
  // שהם בדיוק מי שירצו למחוק, אינם ניתנים למחיקה.
  const inviter = `${STAMP}.inviter@parkomat.co.il`;
  await createUser(inviter, "operator");
  const inviterAppId = await appId(inviter);
  const invitee = `${STAMP}.invitee@parkomat.co.il`;
  await createUser(invitee, "operator");
  await db.prepare("UPDATE app_users SET created_by = ? WHERE LOWER(email) = LOWER(?)")
    .run(inviterAppId, invitee);

  add("⚠️ מי שצירף אחרים ניתן למחיקה",
      await rpc(mgrTok, "delete_user", { p_id: inviterAppId }), 200);
  const orphan = await db
    .prepare("SELECT created_by FROM app_users WHERE LOWER(email) = LOWER(?)").get(invitee);
  add("...וההצבעה אליו התאפסה ל-NULL", orphan?.created_by, null);

  // ---- ⚠️ המנהל הפעיל האחרון אינו ניתן למחיקה ----
  add("⚠️ מנהל אינו מוחק את עצמו", await rpc(mgrTok, "delete_user", { p_id: mgrAppId }), 400);

  console.log("בדיקה                                          בפועל     צפוי");
  let bad = 0;
  for (const [name, got, want] of checks) {
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${name.padEnd(46)}${String(got).padStart(8)} ${String(want).padStart(8)}  ${ok ? "✅" : "❌"}`);
  }

  await cleanup();
  console.log(bad === 0 ? "\n✅ ההרשאות מתנהגות כמתוכנן" : `\n❌ ${bad} כשלים`);
  process.exit(bad === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error("check-permissions:", e.message);
  try { await cleanup(); } catch { /* ניקוי מיטבי */ }
  process.exit(1);
});
