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
const fs = require("node:fs");
const path = require("node:path");

const SB = process.env.SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const ENV = fs.readFileSync(path.resolve(__dirname, "../../dashboard/.env"), "utf8");
const ANON = (ENV.match(/^VITE_SUPABASE_PUBLISHABLE_KEY=(.*)$/m) || [])[1]?.trim();

const STAMP = `wcheck${Date.now()}`;
const EMAIL = `${STAMP}@parkomat.co.il`;
const PW = "WriteCheck!2026";

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
  }

  // ---- ניקוי ----
  const list = await (await f(`${SB}/auth/v1/admin/users`, { headers: admin })).json();
  for (const u of (list.users || []).filter((x) => x.email === EMAIL)) {
    await f(`${SB}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: admin });
  }
  await db.prepare("DELETE FROM app_users WHERE LOWER(email) = LOWER(?)").run(EMAIL);
  await db.prepare("DELETE FROM audit_log WHERE actor_name = ?").run(EMAIL);

  console.log(bad === 0 ? "\n✅ הכתיבה הישירה מתנהגת כמתוכנן" : `\n❌ ${bad} כשלים`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => { console.error("check-writes:", e.message); process.exit(1); });
