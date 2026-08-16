// tools/check-permissions.js — שער: מטריצת ההרשאות, נמדדת חי.
//
// ============================================================
// למה שער חי ולא בדיקת יחידה
// ============================================================
// הכלל מפוזר על פני שלוש שכבות שאף אחת מהן אינה רואה את השנייה: middleware
// ב-Express (`requireManager`), טריגרים על `auth.users`, ו-RLS ב-Postgres.
// בדיקה בזיכרון מאמתת שכל שכבה עושה את שלה — ולא שהצירוף שלהן מייצר את
// הכלל שהוזמן.
//
// ⚠️ וזה כבר קרה כאן פעמיים: `requireAuth` נוסף ל-17 מסלולים ו-`askAssistant`
// נשכח כי הוא fetch עצמאי; והשבתת משתמש "עבדה" בשרת בזמן שה-RLS עדיין נתן
// לו לקרוא. בשני המקרים כל בדיקות היחידה היו ירוקות.
//
// לכן כאן נכנסים באמת: מנהל אמיתי ובקר אמיתי, אסימונים אמיתיים, מול השרת
// שרץ — ומנסים כל פעולה משני הצדדים.
//
// ============================================================
// מה נדרש
// ============================================================
//   node --env-file=.env tools/check-permissions.js
// דורש שהשרת ירוץ (PARITY_API, ברירת מחדל http://localhost:4000).
const fs = require("node:fs");
const path = require("node:path");

const API = process.env.PARITY_API || "http://localhost:4000";
const SB_URL = process.env.SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;

const ENV = fs.readFileSync(path.resolve(__dirname, "../../dashboard/.env"), "utf8");
const ANON = (ENV.match(/^VITE_SUPABASE_PUBLISHABLE_KEY=(.*)$/m) || [])[1]?.trim();

const STAMP = `permcheck${Date.now()}`;
const MGR = `${STAMP}.mgr@parkomat.co.il`;
const OPR = `${STAMP}.opr@parkomat.co.il`;
const PW = "PermCheck!2026";

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

async function signIn(email) {
  const r = await f(`${SB_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PW }),
  });
  const b = await r.json();
  if (!r.ok) throw new Error(`התחברות ${email} נכשלה: ${r.status} ${b.msg || b.error_description || ""}`);
  return b.access_token;
}

/** קריאה ל-API של השרת עם אסימון, ומחזירה את הסטטוס בלבד. */
async function call(token, method, route, body) {
  const r = await f(`${API}${route}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return r.status;
}

async function cleanup() {
  const r = await f(`${SB_URL}/auth/v1/admin/users`, { headers: adminHeaders });
  const l = await r.json();
  for (const u of (l.users || []).filter((u) => u.email?.startsWith(STAMP.slice(0, 9)))) {
    await f(`${SB_URL}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: adminHeaders });
  }
  const db = require("../db/db");
  await db.prepare("DELETE FROM app_users WHERE email LIKE 'permcheck%'").run();
}

(async () => {
  if (!SB_URL || !SECRET || !ANON) {
    console.error("check-permissions: חסרים SUPABASE_URL / SUPABASE_SECRET_KEY / VITE_SUPABASE_PUBLISHABLE_KEY");
    process.exit(1);
  }

  // השרת חייב לרוץ — בלעדיו כל בקשה נכשלת וזה נראה כמו "הכול חסום".
  try {
    await f(`${API}/api/sites`);
  } catch {
    console.error(`check-permissions: השרת אינו עונה ב-${API}. הפעילי אותו, או קבעי PARITY_API.`);
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

  // ⚠️ **PATCH מצפה למזהה המספרי של app_users, לא ל-UUID של Supabase.**
  // שליחת ה-UUID מחזירה 400 "מזהה משתמש לא תקין" — וזו בדיוק אי-ההתאמה
  // שכבר שברה את כפתור ההשבתה במסך פעם אחת (ראה ההערה ב-GET /api/users).
  const appId = async (email) =>
    (await db.prepare("SELECT id FROM app_users WHERE LOWER(email) = LOWER(?)").get(email))?.id;
  const oprAppId = await appId(OPR);
  const mgrAppId = await appId(MGR);

  // ---- מה שמנהל יכול ----
  add("מנהל רואה את רשימת המשתמשים",       await call(mgrTok, "GET", "/api/users"), 200);
  add("מנהל מוסיף בקר",                     await call(mgrTok, "POST", "/api/users/invite",
      { email: `${STAMP}.new1@parkomat.co.il`, role: "operator" }), 200);
  add("מנהל מוסיף מנהל",                    await call(mgrTok, "POST", "/api/users/invite",
      { email: `${STAMP}.new2@parkomat.co.il`, role: "manager" }), 200);

  // ⚠️ **והמנהל שהוזמן הוא באמת מנהל — זו הבדיקה שתופסת את הבאג האמיתי.**
  // "ההזמנה החזירה 200" אינה מוכיחה כלום: היא החזירה 200 גם כשהמוזמן נחת
  // כבקר, כי `parkomat_role` נכתב ל-Supabase בלבד ו-app_users נשאר
  // 'operator'. לכן נבדק כאן מה שקובע — שהוא מצליח לבצע פעולת ניהול.
  const invitedRole = await db
    .prepare("SELECT role FROM app_users WHERE LOWER(email) = LOWER(?)")
    .get(`${STAMP}.new2@parkomat.co.il`);
  add("...והוא באמת מנהל ב-app_users", invitedRole?.role, "manager");

  const invitedOprRole = await db
    .prepare("SELECT role FROM app_users WHERE LOWER(email) = LOWER(?)")
    .get(`${STAMP}.new1@parkomat.co.il`);
  add("...והמוזמן כבקר נשאר בקר", invitedOprRole?.role, "operator");
  add("מנהל משבית בקר",                     await call(mgrTok, "PATCH", `/api/users/${oprAppId}`, { is_active: false }), 200);
  add("מנהל מחזיר בקר",                     await call(mgrTok, "PATCH", `/api/users/${oprAppId}`, { is_active: true }), 200);
  add("מנהל משנה דרגה",                     await call(mgrTok, "PATCH", `/api/users/${oprAppId}`, { role: "manager" }), 200);

  // ---- ⚠️ ומה שבקר **אינו** יכול — זה החצי שקובע ----
  await call(mgrTok, "PATCH", `/api/users/${oprAppId}`, { role: "operator" });
  const oprFresh = await signIn(OPR);

  add("⚠️ בקר אינו רואה את רשימת המשתמשים", await call(oprFresh, "GET", "/api/users"), 403);
  add("⚠️ בקר אינו מוסיף משתמש",            await call(oprFresh, "POST", "/api/users/invite",
      { email: `${STAMP}.hack@parkomat.co.il`, role: "operator" }), 403);
  add("⚠️ בקר אינו משבית אף אחד",           await call(oprFresh, "PATCH", `/api/users/${mgrAppId}`, { is_active: false }), 403);
  add("⚠️ בקר אינו מעלה את עצמו למנהל",     await call(oprFresh, "PATCH", `/api/users/${oprAppId}`, { role: "manager" }), 403);

  // ---- ומה שבקר כן צריך לראות ----
  add("בקר רואה את האתרים",                 await call(oprFresh, "GET", "/api/sites"), 200);

  // ---- בלי אסימון בכלל ----
  add("⚠️ בלי אסימון — אתרים חסומים",        await call(null, "GET", "/api/sites"), 401);
  add("⚠️ בלי אסימון — משתמשים חסומים",      await call(null, "GET", "/api/users"), 401);

  // ---- דומיין זר ----
  let foreignBlocked = false;
  try { await createUser(`${STAMP}@gmail.com`, "operator"); } catch { foreignBlocked = true; }
  add("⚠️ דומיין זר נדחה", foreignBlocked, true);

  // ---- ⚠️ משתמש מושבת אינו קורא, גם עם אסימון תקף ----
  // זה הכשל שכבר קרה: השרת השבית, וה-RLS עדיין נתן לקרוא.
  const victim = `${STAMP}.dead@parkomat.co.il`;
  await createUser(victim, "operator");
  const victimAppId = await appId(victim);
  const victimTok = await signIn(victim);
  add("משתמש פעיל קורא אתרים", await call(victimTok, "GET", "/api/sites"), 200);
  await call(mgrTok, "PATCH", `/api/users/${victimAppId}`, { is_active: false });
  add("⚠️ ואחרי השבתה — אותו אסימון נחסם", await call(victimTok, "GET", "/api/sites"), 403);

  // ============================================================
  // ⚠️ השרשרת האמיתית: הזמנה → סיסמה זמנית → **כניסה בפועל**
  // ============================================================
  // כל שאר הבדיקות כאן יוצרות משתמשים עם סיסמה שאנחנו קובעים, ולכן אף
  // אחת מהן לא נוגעת בחוליה שבאמת משמשת: הסיסמה ש-`auth/admin.js`
  // **מייצר** ומחזיר פעם אחת, ושמישהו מקליד בפועל.
  //
  // ⚠️ אם `createUser` יפסיק להחזיר `tempPassword`, או יחזיר סיסמה שאינה
  // זו שנקבעה, או ישכח `email_confirm` — כל הבדיקות האחרות יישארו ירוקות
  // והמסך ימשיך להציג סיסמה. היא פשוט לא תעבוד, ואיש לא יידע עד שמישהו
  // ינסה להיכנס איתה.
  const fresh = `${STAMP}.flow@parkomat.co.il`;
  const invRes = await f(`${API}/api/users/invite`, {
    method: "POST",
    headers: { Authorization: `Bearer ${mgrTok}`, "Content-Type": "application/json" },
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

  add("⚠️ בקר אינו מוחק אף אחד", await call(oprFresh, "DELETE", `/api/users/${victim2AppId}`), 403);
  add("מנהל מוחק בקר",          await call(mgrTok, "DELETE", `/api/users/${victim2AppId}`), 200);

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

  // והאסימון שכבר היה בידו מת גם הוא.
  add("...והאסימון הישן שלו נחסם", await call(victim2Tok, "GET", "/api/sites"), 403);

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

  add("⚠️ מי שצירף אחרים ניתן למחיקה", await call(mgrTok, "DELETE", `/api/users/${inviterAppId}`), 200);
  const orphan = await db
    .prepare("SELECT created_by FROM app_users WHERE LOWER(email) = LOWER(?)").get(invitee);
  add("...וההצבעה אליו התאפסה ל-NULL", orphan?.created_by, null);

  // ---- ⚠️ המנהל הפעיל האחרון אינו ניתן למחיקה ----
  add("⚠️ מנהל אינו מוחק את עצמו", await call(mgrTok, "DELETE", `/api/users/${mgrAppId}`), 400);

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
