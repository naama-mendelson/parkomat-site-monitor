// tools/check-writes.js — שער: כתיבה ישירה ל-Supabase, בלי השרת.
//
// ============================================================
// למה שער חי ולא בדיקת יחידה
// ============================================================
// הכללים כאן חיים ב-`db/writes.postgres.sql` — פונקציות `SECURITY DEFINER`
// שרצות ב-Postgres. בדיקה בזיכרון לא נוגעת בהן: היא תעבור בשלמות גם אם
// ה-`GRANT` שגוי, גם אם `REVOKE FROM PUBLIC` נשכח, וגם אם בדיקת הזהות
// בגוף הפונקציה הוסרה.
//
// ⚠️ ו-`SECURITY DEFINER` הופך את זה לקריטי: הפונקציה **עוקפת RLS**. אם
// בדיקת `app.actor_display_name()` תוסר, כל מי שיש לו את המפתח הציבורי
// יוכל להשתיק כל אתר — בלי להתחבר.
//
// ============================================================
// מה נבדק, ובאיזה סדר
// ============================================================
//   1. בלי אסימון → נדחה. **זה המקרה שאם ייפול, הכול פתוח.**
//   2. בקר רגיל (לא מנהל) → **מצליח.** ההחלטה היא "ייחוס במקום מנע".
//   3. משך מעל 720 → נדחה.
//   4. אתר שאינו קיים → 404 ולא 500.
//   5. `set_by_name` מגיע מהזהות ו**מתעלם** ממה שנשלח.
//   6. שורת ביקורת ואירוע נכתבו בפועל.
//   7. משתמש שהושבת → נדחה, גם עם אסימון תקף.
//
// ואז כתיבת האתרים, שבה הכלל **הפוך** — שם תפקיד כן נדרש:
//   8.  בקר מנסה לרשום אתר → 403. **זה ההבדל מול תחזוקה.**
//   9.  מנהל רושם → 200. ⚠️ זה גם הכיסוי הראשון בכלל לרישום אתר.
//   10. אותו קוד שוב → 409, לא 500.
//   11. קוד לא תקין → 400 (הקוד נכנס לנתיב MQTT).
//   12. עדכון: NULL אינו מרוקן, מחרוזת ריקה כן.
//   13. אתר שאינו קיים → 404 בעדכון ובמחיקה.
//   14. מחיקה מחזירה את המניין שנמחק, ורושמת ביקורת ואירוע **לפניה**.
const fs = require("node:fs");
const path = require("node:path");

const SB = process.env.SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const ENV = fs.readFileSync(path.resolve(__dirname, "../../dashboard/.env"), "utf8");
const ANON = (ENV.match(/^VITE_SUPABASE_PUBLISHABLE_KEY=(.*)$/m) || [])[1]?.trim();

const STAMP = `wcheck${Date.now()}`;
const EMAIL = `${STAMP}@parkomat.co.il`;
const MGR_EMAIL = `${STAMP}mgr@parkomat.co.il`;
const PW = "WriteCheck!2026";
// ⚠️ הקוד חייב להתאים ל-`^[A-Za-z0-9_-]{1,64}$` — הוא נכנס לנתיב MQTT.
const NEW_CODE = `zz-${STAMP}`;

// ⚠️ הרשת כאן מנתקת מיוזמתה (נמדד: בערך כל בקשה שנייה). בלי חזרה השער
// היה נופל באקראי — כלומר הופך לרעש שמתעלמים ממנו.
async function f(url, opt) {
  let last;
  for (let i = 0; i < 5; i++) {
    try { return await fetch(url, opt); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 600)); }
  }
  throw last;
}

const admin = { apikey: SECRET, Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };

const rpc = (fn, body, token) =>
  f(`${SB}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: ANON, ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

(async () => {
  if (!SB || !SECRET || !ANON) {
    console.error("check-writes: חסרים SUPABASE_URL / SUPABASE_SECRET_KEY / VITE_SUPABASE_PUBLISHABLE_KEY");
    process.exit(1);
  }

  const db = require("../db/db");
  await db.init();

  const checks = [];
  const add = (name, got, want) => checks.push([name, got, want]);

  // אתר אמיתי כלשהו — השער אינו יוצר אתרים.
  const site = await db.prepare("SELECT code FROM sites ORDER BY code LIMIT 1").get();
  if (!site) { console.error("check-writes: אין אתרים במסד"); process.exit(1); }
  const CODE = site.code;

  // ⚠️ **בקר ולא מנהל.** ההחלטה היא שכל משתמש רשאי לפתוח תחזוקה, ובדיקה
  // עם מנהל הייתה עוברת גם אם בטעות נדרש תפקיד.
  const created = await f(`${SB}/auth/v1/admin/users`, {
    method: "POST", headers: admin,
    body: JSON.stringify({ email: EMAIL, password: PW, email_confirm: true,
                           app_metadata: { parkomat_role: "operator" } }),
  });
  const cb = await created.json();
  if (!created.ok) { console.error("check-writes: יצירת משתמש נכשלה:", cb.msg || cb.message); process.exit(1); }

  const token = (await (await f(`${SB}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PW }),
  })).json()).access_token;

  // ---- 1. ⚠️ בלי אסימון ----
  const anon = await rpc("start_maintenance", { p_site_code: CODE, p_duration_hours: 1 }, null);
  add("⚠️ בלי אסימון — נדחה", anon.status, 401);

  // ---- 3. משך מעל התקרה ----
  const tooLong = await rpc("start_maintenance", { p_site_code: CODE, p_duration_hours: 999 }, token);
  add("משך 999 שעות נדחה", tooLong.status, 400);

  // ---- 4. אתר שאינו קיים ----
  const noSite = await rpc("start_maintenance", { p_site_code: "___NOPE___", p_duration_hours: 1 }, token);
  add("⚠️ אתר שאינו קיים → 404, לא 500", noSite.status, 404);

  // ---- 2 + 5. בקר פותח, והשם מהזהות ----
  const started = await rpc("start_maintenance", { p_site_code: CODE, p_duration_hours: 1, p_reason: "שער" }, token);
  const sb = await started.json().catch(() => []);
  add("⚠️ בקר רגיל פותח חלון", started.status, 200);
  add("...והשם נגזר מהזהות", sb?.[0]?.set_by_name, EMAIL);

  // ---- 6. ביקורת ואירוע ----
  const aud = await db.prepare(
    "SELECT action, trust, actor_role FROM audit_log WHERE actor_name = ? AND action = ? LIMIT 1"
  ).get(EMAIL, "maintenance.start");
  add("⚠️ שורת ביקורת נכתבה", Boolean(aud), true);
  add("...עם trust=token", aud?.trust, "token");
  add("...ועם התפקיד האמיתי", aud?.actor_role, "operator");

  const ev = await db.prepare(
    "SELECT COUNT(*)::int AS n FROM events WHERE site_code = ? AND type = ? AND created_at > ?"
  ).get(CODE, "maintenance", new Date(Date.now() - 120000).toISOString());
  add("⚠️ אירוע נרשם — אחרת אף מסך לא מתעדכן", ev.n > 0, true);

  // ---- ביטול ----
  const cancelled = await rpc("cancel_maintenance", { p_site_code: CODE }, token);
  const cbody = await cancelled.json().catch(() => []);
  add("ביטול עובד", cancelled.status, 200);
  add("...וביטל שורה אחת", cbody?.[0]?.cancelled, 1);

  // ============================================================
  // כתיבת אתרים — וכאן תפקיד **כן** נדרש
  // ============================================================
  // ⚠️ צריך שני משתמשים ולא אחד: בקר מוכיח שהשער סוגר, מנהל מוכיח שהוא
  // לא סוגר על הכול. בדיקה עם מנהל בלבד הייתה עוברת גם אם
  // `app.require_manager()` הוסרה לגמרי.
  const mgrCreated = await f(`${SB}/auth/v1/admin/users`, {
    method: "POST", headers: admin,
    body: JSON.stringify({ email: MGR_EMAIL, password: PW, email_confirm: true,
                           app_metadata: { parkomat_role: "manager" } }),
  });
  if (!mgrCreated.ok) {
    const b = await mgrCreated.json().catch(() => ({}));
    console.error("check-writes: יצירת מנהל נכשלה:", b.msg || b.message); process.exit(1);
  }
  // ⚠️ **התפקיד נכתב ל-app_users ביד, ולא בטעות.** `provision_app_user`
  // רץ ב-AFTER INSERT — לפני שגו-טרו כותב את ה-app_metadata — ולכן הוא
  // אינו רואה 'manager' ויוצר את השורה כבקר. `app.current_app_role()`
  // קורא מ-app_users, ובלי השורה הזו המנהל היה נדחה ב-403 והשער היה
  // מדווח על באג שאינו קיים. (זה בדיוק מה שקרה בפועל למשתמשת אמיתית.)
  await db.prepare("UPDATE app_users SET role = 'manager' WHERE LOWER(email) = LOWER(?)").run(MGR_EMAIL);

  const mgrToken = (await (await f(`${SB}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email: MGR_EMAIL, password: PW }),
  })).json()).access_token;

  // ============================================================
  // my_role — התפקיד שהדשבורד מציג, מהמסד
  // ============================================================
  // ⚠️ **אותו מקור אמת שהכתיבות אוכפות.** אם הפונקציה הזאת תחזיר משהו אחר
  // מ-`app.current_app_role()`, המסך יציע פעולות שהמסד ידחה — או יסתיר
  // פעולות שהוא כן מתיר. השני גרוע יותר: אין ממנו מוצא על המסך.
  const roleMgr = await rpc("my_role", {}, mgrToken);
  add("my_role של מנהל", (await roleMgr.json().catch(() => null)), "manager");
  const roleOp = await rpc("my_role", {}, token);
  add("my_role של בקר", (await roleOp.json().catch(() => null)), "operator");
  const roleAnon = await rpc("my_role", {}, null);
  add("⚠️ my_role בלי אסימון — נדחה", roleAnon.status, 401);

  // ---- 8. ⚠️ בקר אינו רושם אתר ----
  const byOperator = await rpc("register_site",
    { p_code: NEW_CODE, p_site_name: "בדיקת שער" }, token);
  add("⚠️ בקר מנסה לרשום אתר → 403", byOperator.status, 403);

  // ---- 11. קוד לא תקין ----
  const badCode = await rpc("register_site",
    { p_code: "bad code/#", p_site_name: "x" }, mgrToken);
  add("קוד עם תו אסור נדחה", badCode.status, 400);

  const noName = await rpc("register_site",
    { p_code: NEW_CODE, p_site_name: "   " }, mgrToken);
  add("שם ריק נדחה", noName.status, 400);

  const badTier = await rpc("register_site",
    { p_code: NEW_CODE, p_site_name: "x", p_tier: "gold" }, mgrToken);
  add("דרגה שאינה קיימת נדחית", badTier.status, 400);

  // ---- 9. ⚠️ מנהל רושם ----
  // ⚠️ **הבדיקה הראשונה בכלל שרושמת אתר.** ה-JS המקביל
  // (`insertSite` ב-queries.js) מפרט שש עמודות ומספק שמונה מקומות, ולכן
  // `POST /api/sites` החזיר 500 מאז ומתמיד — ואף שער לא נגע בו.
  const reg = await rpc("register_site",
    { p_code: NEW_CODE, p_site_name: "אתר בדיקת שער", p_tier: "vip", p_plc_type: "doli" }, mgrToken);
  const rbody = await reg.json().catch(() => []);
  add("⚠️ מנהל רושם אתר", reg.status, 200);
  add("...והשורה נוצרה", Number(rbody?.[0]?.id) > 0, true);

  const regRow = await db.prepare("SELECT tier, plc_type, is_new_site FROM sites WHERE code = ?").get(NEW_CODE);
  add("...עם הדרגה שנשלחה", regRow?.tier, "vip");
  add("...ועם סוג המתקן", regRow?.plc_type, "doli");
  // ⚠️ ברירת המחדל היא **אתר חדש** — מונה המכונה מתחיל מאפס ולא מאמץ את
  // ערך ה-PLC. ההפך היה מנפח כל מספר במערכת באתר חדש.
  add("...וכאתר חדש כברירת מחדל", regRow?.is_new_site, 1);

  const regAudit = await db.prepare(
    "SELECT actor_role, trust FROM audit_log WHERE action = ? AND target_id = ? LIMIT 1"
  ).get("site.register", NEW_CODE);
  add("⚠️ רישום אתר נרשם בביקורת", regAudit?.actor_role, "manager");

  // ---- 10. כפילות ----
  const dup = await rpc("register_site",
    { p_code: NEW_CODE, p_site_name: "שוב" }, mgrToken);
  // ⚠️ 409 ולא 500: "כבר קיים" אינו תקלה. אילו נסמכנו על ה-UNIQUE במסד,
  // PostgREST היה מחזיר 409 גם כן — אבל עם הודעת Postgres באנגלית.
  add("⚠️ אותו קוד שוב → 409", dup.status, 409);

  // ---- 12. עדכון ----
  const upd = await rpc("update_site",
    { p_code: NEW_CODE, p_site_name: "אתר בדיקה מעודכן" }, mgrToken);
  add("מנהל מעדכן שם", upd.status, 200);
  const afterUpd = await db.prepare("SELECT site_name, tier, plc_type FROM sites WHERE code = ?").get(NEW_CODE);
  add("...השם השתנה", afterUpd?.site_name, "אתר בדיקה מעודכן");
  // ⚠️ **הבדיקה שמונעת את הבאג האמיתי:** עדכון שם חייב להשאיר את הדרגה
  // ואת סוג המתקן. פונקציה שמעדכנת את כל העמודות הייתה מוחקת אותם בשקט.
  add("⚠️ ...והדרגה לא נמחקה", afterUpd?.tier, "vip");
  add("⚠️ ...וסוג המתקן לא נמחק", afterUpd?.plc_type, "doli");

  // מחרוזת ריקה **כן** מרוקנת — זו הדרך היחידה לבטל סוג מתקן.
  await rpc("update_site", { p_code: NEW_CODE, p_plc_type: "" }, mgrToken);
  const cleared = await db.prepare("SELECT plc_type FROM sites WHERE code = ?").get(NEW_CODE);
  add("מחרוזת ריקה מרוקנת סוג מתקן", cleared?.plc_type, null);

  const updByOp = await rpc("update_site", { p_code: NEW_CODE, p_tier: "basic" }, token);
  add("בקר אינו מעדכן אתר → 403", updByOp.status, 403);

  // ---- 13. אתר שאינו קיים ----
  const updMissing = await rpc("update_site", { p_code: "___NOPE___", p_tier: "basic" }, mgrToken);
  add("⚠️ עדכון אתר שאינו קיים → 404", updMissing.status, 404);
  const delMissing = await rpc("delete_site", { p_code: "___NOPE___" }, mgrToken);
  add("⚠️ מחיקת אתר שאינו קיים → 404", delMissing.status, 404);

  // ---- 14. מחיקה ----
  const delByOp = await rpc("delete_site", { p_code: NEW_CODE }, token);
  add("⚠️ בקר אינו מוחק אתר → 403", delByOp.status, 403);

  const del = await rpc("delete_site", { p_code: NEW_CODE }, mgrToken);
  const dbody = await del.json().catch(() => []);
  add("מנהל מוחק אתר", del.status, 200);
  add("...ומקבל את המניין שנמחק", Number(dbody?.[0]?.operations), 0);
  const gone = await db.prepare("SELECT COUNT(*)::int AS n FROM sites WHERE code = ?").get(NEW_CODE);
  add("...והאתר איננו", gone.n, 0);

  // ⚠️ האירוע נבדק **אחרי** המחיקה בכוונה: הוא נרשם לפניה, ו-site_id הוא
  // ON DELETE SET NULL. שורה שנעלמה כאן פירושה שהאירוע נרשם אחרי המחיקה
  // ולכן איבד את הקישור — או לא נרשם בכלל, ואז אף מסך לא ידע.
  const delEv = await db.prepare(
    "SELECT COUNT(*)::int AS n FROM events WHERE site_code = ? AND type = ?"
  ).get(NEW_CODE, "site-deleted");
  add("⚠️ אירוע המחיקה שרד את המחיקה", delEv.n > 0, true);

  // ============================================================
  // ניהול משתמשים — ושני מגני הנעילה, חי מול המסד
  // ============================================================
  // ⚠️ **הכללים כתובים פעמיים** — ב-`auth/deactivation.js` לזרוע השרת,
  // וב-SQL לזרוע הישירה. פער ביניהם פירושו שדרך מסלול אחד אפשר להשאיר את
  // המערכת **בלי אף מנהל**, ואז אין דרך חזרה מהמסך בכלל. בדיקות היחידה
  // מכסות את עותק ה-JS; רק כאן נבדק עותק ה-SQL.
  const opRow = await db.prepare("SELECT id FROM app_users WHERE LOWER(email)=LOWER(?)").get(EMAIL);
  const mgrRow = await db.prepare("SELECT id FROM app_users WHERE LOWER(email)=LOWER(?)").get(MGR_EMAIL);

  // ---- list_users ----
  // ⚠️ הפונקציה הזאת עושה JOIN ל-`auth.users` כדי להביא `last_sign_in_at`,
  // וזה השדה שמבדיל בין מי שעובד כאן כל יום לבין הזמנה שנשלחה ולא נפתחה.
  // בלי בדיקה שהוא **מגיע לא ריק**, `LEFT JOIN` שבור היה נראה בדיוק כמו
  // "המשתמש עוד לא נכנס" — כלומר שקר שנראה כמו נתון.
  const listMgr = await rpc("list_users", {}, mgrToken);
  const listBody = await listMgr.json().catch(() => []);
  add("מנהל קורא את רשימת המשתמשים", listMgr.status, 200);
  add("...ויש בה שורות", Array.isArray(listBody) && listBody.length > 0, true);
  add("⚠️ ...וכניסה אחרונה מגיעה מ-auth.users",
      (listBody || []).some((u) => u.out_last_sign_in_at), true);
  const listOp = await rpc("list_users", {}, token);
  add("⚠️ בקר אינו קורא את רשימת המשתמשים → 403", listOp.status, 403);

  const byOpUser = await rpc("set_user_active", { p_user_id: opRow.id, p_active: false }, token);
  add("⚠️ בקר אינו משבית משתמש → 403", byOpUser.status, 403);

  const missingUser = await rpc("set_user_active", { p_user_id: 999999, p_active: false }, mgrToken);
  add("משתמש שאינו קיים → 404", missingUser.status, 404);

  // ---- מגן 1: לא משביתים את עצמך ----
  const selfOff = await rpc("set_user_active", { p_user_id: mgrRow.id, p_active: false }, mgrToken);
  add("⚠️ מנהל אינו משבית את עצמו", selfOff.status, 400);

  const selfDemote = await rpc("set_user_role", { p_user_id: mgrRow.id, p_role: "operator" }, mgrToken);
  add("⚠️ מנהל אינו מוריד את עצמו", selfDemote.status, 400);

  // ---- מגן 2: המנהל הפעיל האחרון ----
  // ⚠️ הבדיקה דורשת שיהיה **בדיוק** מנהל פעיל אחד מלבד מנהל הבדיקה, ולכן
  // היא נמדדת ולא מונחת: בייצור יש מנהלים אמיתיים, וכשיש שניים או יותר
  // הכלל **לא אמור** לחסום. הנחה עיוורת כאן הייתה הופכת את השער לתלוי
  // בכמה מנהלים יש במסד באותו יום.
  const mgrCount = await db.prepare(
    "SELECT COUNT(*)::int AS n FROM app_users WHERE role='manager' AND is_active"
  ).get();
  const other = await db.prepare(
    "SELECT id FROM app_users WHERE role='manager' AND is_active AND id <> ? LIMIT 1"
  ).get(mgrRow.id);

  if (mgrCount.n === 2 && other) {
    // ⚠️ **המקרה שנבדק כאן הוא הפוך ממה שנראה:** מנהל הבדיקה מוריד את
    // המנהל האחר, ואז יישאר מנהל פעיל אחד — כלומר זה **מותר**. הכלל חוסם
    // רק כשהיעד הוא האחרון. חוסם על 2 היה מונע כל הורדה לנצח.
    const allowed = await rpc("set_user_role", { p_user_id: other.id, p_role: "operator" }, mgrToken);
    add("הורדת מנהל כששניים פעילים — מותרת", allowed.status, 200);
    if (allowed.status === 200) {
      // עכשיו מנהל הבדיקה הוא האחרון — ואי אפשר להוריד אותו, גם לא בידי אחר.
      await db.prepare("UPDATE app_users SET role='manager' WHERE id = ?").run(other.id);
    }
  } else {
    console.log(`     │ (${mgrCount.n} מנהלים פעילים — מקרה "המנהל האחרון" נבדק על מנהל הבדיקה בלבד)`);
  }

  // ============================================================
  // ⚠️ "המנהל הפעיל האחרון" — ולמה זה נבדק בטרנזקציה ולא ב-HTTP
  // ============================================================
  // כדי שההסתעפות הזו תרוץ צריך **מנהל פעיל אחד בלבד** במסד. בייצור יש
  // ארבעה, ולהוריד שלושה מהם באמת — גם לרגע — זו בדיוק הפעולה שאין ממנה
  // חזרה אם הסקריפט ייפול באמצע.
  //
  // לכן המצב נבנה בטרנזקציה שמתגלגלת אחורה. זה עובד מפני ש-
  // `app.current_actor()` נופל ל-GUC `app.user_id` כשאין תביעת JWT —
  // אותה עקיפה שנבנתה כדי שהמדיניות תרוץ גם על Postgres רגיל. כלומר
  // הזהות מוזרקת בלי אסימון, והפונקציה נבדקת בדיוק כמו שהיא.
  //
  // ============================================================
  // ⚠️ ומה שנמצא כאן: ההסתעפות הזו **אינה בת-הגעה במקרה המסוכן**
  // ============================================================
  // הכלל אומר "אל תוריד/תשבית את המנהל הפעיל האחרון". אבל `require_manager`
  // דורש שהפועל עצמו יהיה מנהל **פעיל** — ולכן אם יש רק מנהל פעיל אחד,
  // הוא הפועל, וכל יעד ששווה לו נחסם קודם ע"י בדיקת "לא על עצמך".
  //
  // כלומר האינווריאנטה "לעולם לא אפס מנהלים" נשמרת בפועל ע"י **בדיקת
  // העצמי**, וספירת המנהלים היא הגנה בעומק. היא כן נורית במצב אחד: יעד
  // שהוא מנהל **מושבת**, כשיש מנהל פעיל אחד — שם היא חוסמת פעולה שאינה
  // מפחיתה ניהול פעיל, וההודעה מטעה.
  //
  // ⚠️ **לא שיניתי את זה.** שני העותקים (JS ו-SQL) מסכימים, וההתנהגות
  // היא חסימה עודפת ולא פרצה. הרפיית מגן נעילה היא החלטת מוצר, לא
  // תופעת לוואי של פורט.
  let lastMgrBlocked = null;
  await db.transaction(async () => {
    await db.prepare("UPDATE app_users SET role='operator' WHERE role='manager' AND id <> ?")
      .run(mgrRow.id);
    // יעד: מנהל **מושבת** — המצב היחיד שבו ההסתעפות בת-הגעה.
    await db.prepare("UPDATE app_users SET role='manager', is_active=false WHERE id = ?")
      .run(opRow.id);
    const me = await db.prepare("SELECT supabase_uid::text AS uid FROM app_users WHERE id = ?")
      .get(mgrRow.id);
    await db.prepare("SELECT set_config('app.user_id', ?, true) AS s").get(me.uid);
    try {
      await db.prepare("SELECT * FROM set_user_role(?, ?)").all(opRow.id, "operator");
      lastMgrBlocked = false;
    } catch (e) {
      lastMgrBlocked = /המנהל הפעיל האחרון/.test(e.message);
    }
    // ⚠️ הגלילה היא **דרך חריגה**, ולא ROLLBACK מפורש: db.transaction מגלגל
    // על חריגה. שכחה כאן הייתה משאירה שלושה מנהלים אמיתיים כבקרים.
    throw new Error("ROLLBACK-מכוון");
  }).catch((e) => { if (!/ROLLBACK-מכוון/.test(e.message)) throw e; });

  add("⚠️ המנהל הפעיל האחרון אינו ניתן להורדה", lastMgrBlocked, true);

  // ⚠️ ובדיקה שהגלילה אכן קרתה. בלעדיה כשל בטרנזקציה היה מוריד מנהלים
  // אמיתיים לבקרים והשער היה ממשיך לדווח ✅ על כל השאר.
  const mgrsAfter = await db.prepare(
    "SELECT COUNT(*)::int AS n FROM app_users WHERE role='manager' AND is_active"
  ).get();
  add("⚠️ ...והמסד שוחזר במלואו", mgrsAfter.n, mgrCount.n);

  // ---- השבתה תקינה, והחזרה ----
  const off = await rpc("set_user_active", { p_user_id: opRow.id, p_active: false }, mgrToken);
  add("מנהל משבית בקר", off.status, 200);
  const offRow = await db.prepare("SELECT is_active, disabled_by FROM app_users WHERE id = ?").get(opRow.id);
  add("...והשורה סומנה", offRow?.is_active, false);
  // ⚠️ **המזהה המספרי ולא המייל.** disabled_by הוא FK ל-app_users(id), וזה
  // בדיוק מה שהפיל כל השבתה בעבר — שגיאת טיפוס שנראתה כמו כפתור מקולקל.
  add("⚠️ ...ובידי מי, כמזהה", offRow?.disabled_by, mgrRow.id);

  const roleAudit = await db.prepare(
    "SELECT action FROM audit_log WHERE target_type='user' AND target_id = ? ORDER BY id DESC LIMIT 1"
  ).get(String(opRow.id));
  // ⚠️ התחילית `user.` נושאת את כל ההרשאה — מדיניות audit_log מסתירה
  // `user.%` מבקרים. שם אחר היה חושף ניהול משתמשים לכל המערכת בשקט.
  add("⚠️ הביקורת מתחילה ב-user.", String(roleAudit?.action || "").startsWith("user."), true);

  const on = await rpc("set_user_active", { p_user_id: opRow.id, p_active: true }, mgrToken);
  add("החזרה לפעילות עובדת", on.status, 200);

  const promote = await rpc("set_user_role", { p_user_id: opRow.id, p_role: "manager" }, mgrToken);
  add("העלאה למנהל תמיד מותרת", promote.status, 200);
  const sameAgain = await rpc("set_user_role", { p_user_id: opRow.id, p_role: "manager" }, mgrToken);
  add("אותו תפקיד שוב נדחה", sameAgain.status, 400);
  const badRole = await rpc("set_user_role", { p_user_id: opRow.id, p_role: "executive" }, mgrToken);
  add("תפקיד שאינו קיים נדחה", badRole.status, 400);

  // חזרה לבקר, כדי שההשבתה בהמשך תיבדק על בקר ולא על מנהל
  await rpc("set_user_role", { p_user_id: opRow.id, p_role: "operator" }, mgrToken);

  // ---- 7. ⚠️ משתמש שהושבת ----
  // אותו אסימון בדיוק, שעדיין חתום כדין. זה מה ש-identifyActor לא בדק.
  await db.prepare("UPDATE app_users SET is_active = false WHERE LOWER(email) = LOWER(?)").run(EMAIL);
  const afterOff = await rpc("start_maintenance", { p_site_code: CODE, p_duration_hours: 1 }, token);
  // ⚠️ **403 ולא 400, וזה הקוד הנכון.** הפונקציה מנפיקה
  // 'insufficient_privilege' (42501), ו-PostgREST ממפה אותו ל-403 —
  // "מזוהה, אבל אינו מורשה". 400 היה אומר "הבקשה שגויה", וזה לא המצב:
  // הבקשה תקינה לחלוטין, המשתמש הושבת.
  //
  // ⚠️ וההבחנה מול 401 של מקרה 1 היא מדויקת: שם אין אסימון בכלל, ו-
  // PostgREST דוחה לפני שהפונקציה נקראת.
  add("⚠️ מושבת נדחה — עם אותו אסימון תקף", afterOff.status, 403);

  // ⚠️ ו-my_role מחזיר 'anonymous' ולא 'operator': כך המסך יודע שהחשבון
  // הושבת, במקום להציג ממשק שכל בקשה בו מוחזרת ריקה בלי הסבר.
  const roleOff = await rpc("my_role", {}, token);
  add("⚠️ my_role של מושבת → anonymous", (await roleOff.json().catch(() => null)), "anonymous");

  // ============================================================
  // ⚠️ ניסוי — מנהל בלבד, ובקר נחסם
  // ============================================================
  // ⚠️ **זה המקרה שאם ייפול, כל אחד יכול לשנות את הסטטיסטיקה.** סימון
  // כניסוי מוריד פעולות מהמונה ותקלות מאחוז הכשל — כלומר הוא משפר את
  // המספרים. בלי הבדיקה הזו  יכולה להימחק מהפונקציה
  // ואף שער לא ירגיש.
  const testOp = await db.prepare(
    "SELECT id FROM operations WHERE excluded_at IS NULL ORDER BY id DESC LIMIT 1"
  ).get();

  const testAsOperator = await rpc("mark_as_test", { p_kind: "operation", p_id: testOp.id }, token);
  add("⚠️ בקר מנסה לסמן ניסוי — נדחה", testAsOperator.status, 403);

  const untestAsOperator = await rpc("unmark_test", { p_kind: "operation", p_id: testOp.id }, token);
  add("⚠️ בקר מנסה להחזיר לספירה — נדחה", untestAsOperator.status, 403);

  const testAnon = await rpc("mark_as_test", { p_kind: "operation", p_id: testOp.id }, null);
  add("⚠️ בלי אסימון — נדחה", testAnon.status, 401);

  // מנהל כן, ומוחזר מיד — השער אינו משנה נתוני ייצור.
  const testAsMgr = await rpc(
    "mark_as_test", { p_kind: "operation", p_id: testOp.id, p_reason: "שער" }, mgrToken);
  add("מנהל מסמן ניסוי", testAsMgr.status, 200);

  const dupe = await rpc("mark_as_test", { p_kind: "operation", p_id: testOp.id }, mgrToken);
  add("סימון כפול → 409, לא 500", dupe.status, 409);

  const badKind = await rpc("mark_as_test", { p_kind: "nope", p_id: testOp.id }, mgrToken);
  add("סוג דיווח לא תקין → 400", badKind.status, 400);

  const missing = await rpc("mark_as_test", { p_kind: "operation", p_id: 2147483000 }, mgrToken);
  add("⚠️ מזהה שאינו קיים → 404, לא 500", missing.status, 404);

  // ⚠️ **מי ומתי** — הדרישה המפורשת. שם מאומת, לא מה שנשלח.
  const marked = await db.prepare(
    "SELECT excluded_by, excluded_at, exclusion_reason FROM operations WHERE id = ?"
  ).get(testOp.id);
  add("...והשם נגזר מהזהות", marked?.excluded_by, MGR_EMAIL);
  add("...ונרשם גם מתי", Boolean(marked?.excluded_at), true);

  const testAudit = await db.prepare(
    "SELECT trust, actor_role FROM audit_log WHERE actor_name = ? AND action = ? LIMIT 1"
  ).get(MGR_EMAIL, "report.mark-test");
  add("⚠️ שורת ביקורת על הסימון", Boolean(testAudit), true);
  add("...עם trust=token", testAudit?.trust, "token");

  const restored = await rpc("unmark_test", { p_kind: "operation", p_id: testOp.id }, mgrToken);
  add("מנהל מחזיר לספירה", restored.status, 200);
  const after = await db.prepare("SELECT excluded_at, excluded_by FROM operations WHERE id = ?").get(testOp.id);
  add("⚠️ שלוש העמודות נוקו יחד", after?.excluded_at === null && after?.excluded_by === null, true);

  // ============================================================
  // ⚠️ שורות יתומות — משתמש אצלנו שאין לו חשבון ב-Supabase
  // ============================================================
  // ⚠️ **נתפס בייצור, ולא בתיאוריה:** שתי שורות `app_users` פעילות עם
  // `supabase_uid` שאין לו חשבון. הן מופיעות ברשימת המשתמשים כבקרים
  // אמיתיים ופעילים, ולעולם לא יוכלו להתחבר.
  //
  // המקור אינו באג בקוד שלנו: **מחיקת משתמש בלוח הבקרה של Supabase**
  // מסירה את חשבון ה-auth ואינה יודעת דבר על `app_users`. הנתיב שלנו מוחק
  // את שניהם, בסדר "Supabase קודם" — ולכן גם כשל בחצי השני משאיר בדיוק את
  // הצורה הזאת.
  //
  // ⚠️ הסדר ההפוך היה גרוע יותר (משתמש שיכול להתחבר בלי שורה אצלנו), אבל
  // "פחות גרוע" אינו "מזוהה". עד עכשיו שום דבר לא הבחין בזה.
  const authList = await (await f(`${SB}/auth/v1/admin/users?per_page=200`, { headers: admin })).json();
  const authUids = new Set((authList.users || []).map((u) => String(u.id)));
  const ours = await db.prepare(
    "SELECT id, email, supabase_uid::text AS uid FROM app_users WHERE is_active"
  ).all();
  // ⚠️ שורה בלי supabase_uid אינה יתומה — היא שורה שנזרעה ידנית ומעולם לא
  // חוברה לחשבון. אין מה להשוות שם, וסימונה כשגיאה היה רעש.
  const orphans = ours.filter((u) => u.uid && !authUids.has(u.uid));
  if (orphans.length) {
    for (const o of orphans) console.log(`     │ יתום: app_users #${o.id} — ${o.email}`);
  }
  add("⚠️ אין שורות app_users פעילות בלי חשבון Supabase", orphans.length, 0);

  console.log("בדיקה                                              בפועל     צפוי");
  let bad = 0;
  for (const [name, got, want] of checks) {
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${name.padEnd(50)}${String(got).slice(0, 8).padStart(8)} ${String(want).slice(0, 8).padStart(8)}  ${ok ? "✅" : "❌"}`);
    // ⚠️ **קיצור לשמונה תווים הסתיר כשל אמיתי.** "אתר בדיקת שער" מול
    // "אתר בדיקה מעודכן" נראו זהים בטבלה, כלומר השורה הצביעה ❌ לצד שני
    // ערכים שנראים שווים — ומי שקורא מסיק שהשער שבור ולא שהקוד שבור.
    // בכשל בלבד מודפס הערך המלא.
    if (!ok) console.log(`     │ בפועל: ${JSON.stringify(got)}\n     │ צפוי:  ${JSON.stringify(want)}`);
  }

  // ---- ניקוי ----
  // ⚠️ **האתר נמחק תמיד, גם אם המחיקה כבר עברה.** אחרת כשל באמצע היה
  // משאיר אתר בדיקה בייצור — והוא היה מופיע בדשבורד כאתר אמיתי מנותק.
  await db.prepare("DELETE FROM sites WHERE code = ?").run(NEW_CODE);
  await db.prepare("DELETE FROM events WHERE site_code = ?").run(NEW_CODE);
  await db.prepare("DELETE FROM audit_log WHERE target_type = 'site' AND target_id = ?").run(NEW_CODE);

  const list = await (await f(`${SB}/auth/v1/admin/users`, { headers: admin })).json();
  for (const u of (list.users || []).filter((x) => x.email === EMAIL || x.email === MGR_EMAIL)) {
    await f(`${SB}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: admin });
  }
  for (const mail of [EMAIL, MGR_EMAIL]) {
    await db.prepare("DELETE FROM app_users WHERE LOWER(email) = LOWER(?)").run(mail);
    await db.prepare("DELETE FROM audit_log WHERE actor_name = ?").run(mail);
  }

  console.log(bad === 0 ? "\n✅ הכתיבה הישירה מתנהגת כמתוכנן" : `\n❌ ${bad} כשלים`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => { console.error("check-writes:", e.message); process.exit(1); });
