// tools/check-reports.js — שער חי לדיווחי השטח, מול PostgREST האמיתי.
//
// ============================================================
// ⚠️ למה שער חי ולא unit test
// ============================================================
// כל מה שמעניין כאן חי ב-SQL ובמדיניות RLS: התקרות, הזהות, ומי רואה את
// מה. בדיקה ב-JS הייתה בודקת קוד שאינו הגבול. הגבול הוא PostgREST, ורק
// פנייה אמיתית אליו מוכיחה משהו.
//
// ⚠️ ובעיקר: plpgsql אינו מאמת שמות עמודות ביצירת הפונקציה. INSERT עם
// עמודה שאינה קיימת נוצר בהצלחה ונכשל רק בזמן ריצה — וזה בדיוק מה שקרה
// כאן ל-audit_log. שער שרץ הוא הדבר היחיד שתופס את זה.
//
//   node --env-file=.env tools/check-reports.js
const db = require("../db/db.js");

// ⚠️ המפתח הציבורי חי ב-.env של הדשבורד ולא של השרת — הוא נצרב לחבילה
// בזמן הבנייה ואין לו מה לעשות בסביבת השרת. אותה קריאה בדיוק כמו
// check-writes.js.
const fs = require("node:fs");
const path = require("node:path");
const DASH_ENV = fs.readFileSync(path.resolve(__dirname, "../../dashboard/.env"), "utf8");

const SB = process.env.SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const ANON = (DASH_ENV.match(/^VITE_SUPABASE_PUBLISHABLE_KEY=(.*)$/m) || [])[1]?.trim();
const f = (...a) => fetch(...a);

const admin = { apikey: SECRET, Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };

const rpc = (fn, body, token) =>
  f(`${SB}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: ANON,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

const rest = (path, token) =>
  f(`${SB}/rest/v1/${path}`, {
    headers: { apikey: ANON, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });

// תמונה חוקית זעירה — PNG בגודל 1×1.
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

(async () => {
  if (!SB || !SECRET || !ANON) {
    console.error("check-reports: חסרים SUPABASE_URL / SUPABASE_SECRET_KEY / VITE_SUPABASE_PUBLISHABLE_KEY");
    process.exit(1);
  }
  await db.init();

  const checks = [];
  const add = (name, got, want) => checks.push([name, got, want]);
  const stamp = Date.now();

  const site = await db.prepare("SELECT code FROM sites ORDER BY code LIMIT 1").get();
  const CODE = site.code;

  // שני משתמשים: בקר (מדווח) ומנהלת (מקבלת). ⚠️ שניהם נחוצים — כל מה
  // שהבדיקה באה לוודא הוא ההבדל ביניהם.
  const mk = async (role, tag) => {
    // ============================================================
    // ⚠️ קידומת מזוהה — כי הדיווח קופץ למנהלת על המסך
    // ============================================================
    // השער הזה יוצר דיווחים **אמיתיים בייצור**, ומרגע שנוסף החלון הקופץ
    // בזמן אמת כל הרצה שלו זרקה למנהלת חלון עם דיווח מדומה. קרה שש פעמים
    // ביום אחד, והיא שאלה בצדק מי כתב את זה.
    //
    // הכתובת נושאת עכשיו את הקידומת שהדשבורד מסנן (ראה GATE_USER_RE
    // ב-reportsLiveDirect). ⚠️ הסינון בתצוגה בלבד — הדיווח נשמר, נבדק
    // ונמחק כרגיל, והשער ממשיך לבדוק את מה שהוא בא לבדוק.
    const email = `gatebot${stamp}${tag}@parkomat.co.il`;
    const pw = `Rc!${stamp}${tag}`;
    const r = await f(`${SB}/auth/v1/admin/users`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({
        email, password: pw, email_confirm: true,
        app_metadata: { parkomat_role: role },
      }),
    });
    if (!r.ok) {
      console.error("יצירת משתמש נכשלה:", JSON.stringify(await r.json()));
      process.exit(1);
    }
    const tok = (await (await f(`${SB}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: pw }),
    })).json()).access_token;

    // ============================================================
    // ⚠️ התפקיד נכתב ביד — app_metadata לבדו אינו מספיק
    // ============================================================
    // `provision_app_user` הוא AFTER INSERT על auth.users, והוא רץ **לפני**
    // ש-GoTrue כותב את app_metadata. לכן השורה ב-app_users נוחתת תמיד
    // כ-'operator', ו-`app.current_app_role()` קורא מהטבלה ולא מהתביעה —
    // כלומר 'מנהלת' שנוצרה כך היא מנהלת בשם בלבד.
    //
    // ⚠️ זה הפיל חמש בדיקות כאן ונראה **בדיוק** כמו באג במוצר: המנהלת לא
    // ראתה את הדיווח ולא יכלה לסמן 'טופל'. אותו לקח מתועד ב-gate-user.js.
    if (role === "manager") {
      await db.prepare("UPDATE app_users SET role = 'manager' WHERE LOWER(email) = LOWER(?)").run(email);
    }

    return { email, token: tok };
  };

  const op = await mk("operator", "a");
  const mgr = await mk("manager", "b");
  const other = await mk("operator", "c");

  // ---- 1. אנונימי נחסם ----
  add("⚠️ בלי אסימון — נדחה",
    (await rpc("submit_field_report", { p_body: "בדיקה אנונימית", p_reported_by_name: "שער" }, null)).status, 401);

  // ---- 2. טקסט קצר מדי ----
  add("דיווח בן שני תווים נדחה",
    (await rpc("submit_field_report", { p_body: "או", p_reported_by_name: "שער" }, op.token)).status, 400);

  // ---- 2.5 שם חובה ----
  // ⚠️ הזהות כבר מאומתת, ובכל זאת השם נדרש: sherut@parkomat.co.il היא
  // תיבה משותפת ולאף משתמש אין full_name — החשבון עונה על "מאיפה נשלח"
  // ולא על "מי ראה". אותו כלל בדיוק כמו p_performed_by בתחזוקה.
  add("⚠️ בלי שם — נדחה",
    (await rpc("submit_field_report", { p_body: "ראיתי משהו מוזר בשער" }, op.token)).status, 400);

  add("⚠️ שם בן תו אחד נדחה",
    (await rpc("submit_field_report",
      { p_body: "ראיתי משהו מוזר בשער", p_reported_by_name: "א" }, op.token)).status, 400);

  add("⚠️ רווחים בלבד נדחים",
    (await rpc("submit_field_report",
      { p_body: "ראיתי משהו מוזר בשער", p_reported_by_name: "   " }, op.token)).status, 400);

  // ---- 3. אתר שאינו קיים → 404 ולא 500 ----
  add("⚠️ אתר שאינו קיים → 404",
    (await rpc("submit_field_report",
      { p_body: "יש כאן רעש מוזר", p_site_code: "___NOPE___", p_reported_by_name: "שער" }, op.token)).status, 404);

  // ---- 4. סוג קובץ לא נתמך ----
  add("קובץ שאינו תמונה נדחה",
    (await rpc("submit_field_report",
      { p_body: "מצרף קובץ", p_reported_by_name: "שער", p_files: [{ mime: "application/pdf", data: TINY_PNG }] },
      op.token)).status, 400);

  // ---- 5. יותר מארבע תמונות ----
  add("⚠️ חמש תמונות נדחות",
    (await rpc("submit_field_report", {
      p_body: "מצרף הרבה",
      p_reported_by_name: "שער",
      p_files: Array.from({ length: 5 }, () => ({ mime: "image/png", data: TINY_PNG })),
    }, op.token)).status, 400);

  // ---- 6. דיווח תקין עם תמונה ----
  const okRes = await rpc("submit_field_report", {
    p_body: "הדלת מרעישה בכל פתיחה — צילום מצורף",
    p_reported_by_name: "יוסי מהתחזוקה",
    p_site_code: CODE,
    p_files: [{ mime: "image/png", data: TINY_PNG }],
  }, op.token);
  const okBody = await okRes.json().catch(() => []);
  const id = okBody && okBody[0] ? okBody[0].id : null;
  add("⚠️ בקר רגיל מדווח", okRes.status, 200);
  add("...ומקבל מזהה", Number.isFinite(Number(id)), true);

  const row = await db.prepare("SELECT * FROM field_reports WHERE id = ?").get(id);
  add("...הזהות נגזרה מהאסימון", row && row.reported_by, op.email);
  add("...והשיוך לאתר נשמר", Boolean(row && row.site_id), true);
  add("...המצב הוא open", row && row.status, "open");
  add("⚠️ והשם המוקלד נשמר לצד החשבון", row && row.reported_by_name, "יוסי מהתחזוקה");

  const files = await db
    .prepare("SELECT COUNT(*)::int AS n FROM field_report_files WHERE report_id = ?")
    .get(id);
  add("⚠️ התמונה נשמרה", files && files.n, 1);

  const aud = await db.prepare(
    "SELECT trust, actor_role FROM audit_log WHERE actor_name = ? AND action = ? LIMIT 1"
  ).get(op.email, "field_report.submit");
  add("⚠️ שורת ביקורת נכתבה", Boolean(aud), true);
  add("...עם trust=token", aud && aud.trust, "token");

  // ---- 7. מי רואה מה ----
  const mineSeen = await (await rest(`field_reports?id=eq.${id}&select=id`, op.token)).json();
  add("⚠️ המדווח רואה את הדיווח שלו", Array.isArray(mineSeen) && mineSeen.length, 1);

  const mgrSeen = await (await rest(`field_reports?id=eq.${id}&select=id`, mgr.token)).json();
  add("⚠️ המנהלת רואה אותו", Array.isArray(mgrSeen) && mgrSeen.length, 1);

  // בקר **אחר** אינו רואה — זו כל המשמעות של "שיגיע רק אליי".
  const otherSeen = await (await rest(`field_reports?id=eq.${id}&select=id`, other.token)).json();
  add("⚠️ בקר אחר אינו רואה", Array.isArray(otherSeen) && otherSeen.length, 0);

  const otherFiles = await (await rest(`field_report_files?report_id=eq.${id}&select=id`, other.token)).json();
  add("⚠️ ואינו רואה את התמונה", Array.isArray(otherFiles) && otherFiles.length, 0);

  add("⚠️ קריאה אנונימית חסומה", (await rest("field_reports?select=id", null)).status, 401);

  // ---- 8. סגירה — מנהלת בלבד ----
  add("⚠️ בקר אינו יכול לסמן טופל",
    (await rpc("resolve_field_report", { p_id: id }, op.token)).status, 403);

  const done = await rpc("resolve_field_report", { p_id: id, p_note: "טופל בשטח" }, mgr.token);
  add("מנהלת מסמנת טופל", done.status, 200);

  const after = await db.prepare("SELECT status, resolved_by FROM field_reports WHERE id = ?").get(id);
  add("...המצב התעדכן", after && after.status, "done");
  add("...ונרשם מי סגר", after && after.resolved_by, mgr.email);

  const twice = await rpc("resolve_field_report", { p_id: id }, mgr.token);
  const tb = await twice.json().catch(() => []);
  add("⚠️ סגירה כפולה מחזירה 0 ולא שגיאה", tb && tb[0] ? tb[0].updated : null, 0);

  // ---- 9. ⚠️ אין חתימה ישנה ששורדת ----
  // הוספת פרמטר יוצרת **עומס** ולא החלפה. אם החתימה בת שלושת הפרמטרים
  // שרדה, כל קורא שיפנה אליה עוקף את דרישת השם לגמרי — וזה בדיוק מה
  // שקרה פעם ב-start_maintenance.
  const sigs = await db.prepare(
    "SELECT COUNT(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace " +
    "WHERE n.nspname='public' AND p.proname='submit_field_report'"
  ).get();
  add("⚠️ חתימה אחת בלבד — אין דרך לעקוף", sigs && sigs.n, 1);

  // ---- ניקוי ----
  await db.prepare("DELETE FROM field_reports WHERE id = ?").run(id);

  // ============================================================
  // ⚠️ גם שורות הביקורת — הן נתון אמיתי לכל דבר
  // ============================================================
  // audit_log קריא לכל משתמש פעיל, ושורה של משתמש סינתטי מופיעה שם
  // כפעולה שאיש לא עשה. check-no-residue תפס 17 כאלה שהצטברו ביום אחד
  // — כולן משערים שנכתבו כאן, וכולן היו נשארות לנצח.
  //
  // ⚠️ אותו לקח בדיוק שמתועד ב-check-no-residue על 297 שורות שהצטברו
  // על אתר 1284: ניקוי חלקי הוא ניקוי שלא נעשה.
  await db.prepare("DELETE FROM audit_log WHERE actor_name ~ ?").run("^gatebot[0-9]");
  for (const u of [op, mgr, other]) {
    const r = await db.prepare("SELECT supabase_uid FROM app_users WHERE email = ?").get(u.email);
    if (r && r.supabase_uid) {
      await f(`${SB}/auth/v1/admin/users/${r.supabase_uid}`, { method: "DELETE", headers: admin });
    }
    await db.prepare("DELETE FROM app_users WHERE email = ?").run(u.email);
  }

  console.log("\n" + "=".repeat(70));
  let fail = 0;
  for (const [name, got, want] of checks) {
    const ok = String(got) === String(want);
    if (!ok) fail++;
    console.log(`  ${ok ? "✅" : "❌"} ${name.padEnd(44)} ${String(got).padStart(7)} ${String(want).padStart(7)}`);
  }
  console.log("=".repeat(70));
  console.log(fail === 0 ? "\n✅ דיווחי השטח מתנהגים כמתוכנן" : `\n❌ ${fail} כשלים`);
  process.exit(fail === 0 ? 0 : 1);
})();
