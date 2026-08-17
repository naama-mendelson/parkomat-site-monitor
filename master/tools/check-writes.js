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
