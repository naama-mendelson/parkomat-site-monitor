// tools/check-agent-identity.js — זהות הסוכן: מתוחמת, ולא נחסמת.
//
// ============================================================
// ⚠️ שתי טענות, ושתיהן חייבות להיבדק — לא אחת
// ============================================================
// 1. **התיחום עובד** — סוכן מזוהה כסוכן ורואה את האתר **שלו**.
// 2. **הוא אינו נחסם** — ביום שבו MFA יידלק, הוא ממשיך לעבוד.
//
// ⚠️ והשנייה היא זו שאין לה שום סימן כשהיא נשברת. `app.came_from_token()`
// פוטר את השרת ואת השערים, שאין להם אסימון כלל — אבל **סוכן כן מגיע עם
// אסימון**, ולכן הוא נופל בדיוק לצד הלא-נכון של אותה שורה. בלי הפטור, ביום
// שמישהו ידליק את mfa_required_for_manager כל האתרים שכותבים ישירות
// יפסיקו לדווח: בלי שגיאה במסך, בלי התראה, ובלי קשר נראה לעין בין הדגל
// לבין השקט.
//
// ⚠️ **הכול רץ בטרנזקציה שמתבטלת**, כמו check-writes: המשתמש הסינתטי
// נוצר, נבדק, וההחזרה מוודאת שהמסד חזר בדיוק למה שהיה. אין כאן שאריות
// בייצור — וזו אותה משמעת ש-check-no-residue אוכף.
const db = require("../db/db");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
};

(async () => {
  console.log("=== check-agent-identity ===\n");
  await db.init();

  // ---------- החלק הסטטי: הפטור קיים בקוד ----------
  const fs = require("node:fs");
  const path = require("node:path");
  const SEC = fs.readFileSync(path.join(__dirname, "..", "db", "security.postgres.sql"), "utf8");
  const BODY = (SEC.match(/CREATE OR REPLACE FUNCTION app\.require_mfa\(\)[\s\S]*?\$fn\$;/) || [""])[0];

  console.log("── הפטור בקוד ──");
  ok("נמצא גוף require_mfa", BODY.length > 100);
  ok("⚠️ require_mfa פוטרת סוכן במפורש", /app\.is_agent\(\)/.test(BODY),
     "בלי זה, הדלקת MFA משתיקה את כל האתרים בלי שום סימן");
  // ⚠️ הסדר חשוב: הפטור חייב להיות **לפני** בדיקת ה-aal, אחרת הוא לא
  // נמצא בדרך של הזריקה בכלל.
  ok("הפטור קודם לבדיקת aal",
     BODY.indexOf("app.is_agent()") > 0 &&
     BODY.indexOf("app.is_agent()") < BODY.indexOf("aal2"));

  // ---------- החלק החי: הכול בטרנזקציה שמתבטלת ----------
  console.log("\n── התנהגות מול המסד ──");

  const before = await db.prepare("SELECT COUNT(*)::int AS n FROM app_users").get();
  const site = await db.prepare("SELECT id, code FROM sites ORDER BY id LIMIT 1").get();
  if (!site) { console.log("אין אתרים — לא ניתן לבדוק"); process.exit(2); }

  const uid = require("node:crypto").randomUUID();
  const email = `agentcheck${Date.now()}@parkomat.co.il`;

  await db.transaction(async () => {
    await db.prepare(
      "INSERT INTO app_users (email, full_name, role, is_active, supabase_uid, site_id, created_at) " +
      "VALUES (?, ?, 'agent', TRUE, ?::uuid, ?, now()::text)"
    ).run(email, "בדיקת סוכן", uid, site.id);

    // ⚠️ הזהות מוזרקת דרך ה-GUC ולא דרך אסימון — אותו מנגנון בדיוק
    // ש-app.current_actor() נופל אליו, וזה מה שמאפשר לבדוק בלי GoTrue.
    await db.prepare("SELECT set_config('app.user_id', ?, true)").get(uid);

    const r = await db.prepare(
      "SELECT app.is_agent() AS is_agent, app.agent_site_id() AS sid, " +
      "app.is_manager() AS is_mgr, app.current_app_role() AS role"
    ).get();

    ok("מזוהה כסוכן", r.is_agent === true);
    ok("מתוחם לאתר שלו", r.sid === site.id, `קיבל ${r.sid}, צפוי ${site.id}`);
    ok("⚠️ אינו מנהל", r.is_mgr === false,
       "סוכן שנחשב מנהל יכול למחוק אתר");
    ok("הדרגה נקראת מהטבלה", r.role === "agent");

    // ⚠️ סוכן מושבת חייב לאבד את השיוך **מיד**. השבתה שמשאירה כתיבה
    // פתוחה היא כפתור שאומר "הושבת" ולא משבית — בדיוק הבאג שתועד
    // ב-is_active_user.
    await db.prepare("UPDATE app_users SET is_active = FALSE WHERE supabase_uid = ?::uuid").run(uid);
    const off = await db.prepare("SELECT app.agent_site_id() AS sid, app.is_agent() AS a").get();
    ok("⚠️ השבתה מנתקת את הכתיבה מיד", off.sid === null && off.a === false);

    // סוכן בלי site_id אינו סוכן לעניין כתיבה — NULL הוא כישלון ולא "הכול".
    await db.prepare(
      "UPDATE app_users SET is_active = TRUE, site_id = NULL WHERE supabase_uid = ?::uuid"
    ).run(uid);
    const nosite = await db.prepare("SELECT app.agent_site_id() AS sid").get();
    ok("⚠️ סוכן בלי אתר מקבל NULL ולא הרשאה גורפת", nosite.sid === null);

    // ⚠️ אתר אחד, סוכן פעיל אחד. שני סוכנים לאותו אתר הם בדיוק מה שקרה
    // באתר 1284 — שני תהליכים ששידרו במקביל.
    let dup = null;
    try {
      await db.prepare(
        "INSERT INTO app_users (email, role, is_active, supabase_uid, site_id, created_at) " +
        "VALUES (?, 'agent', TRUE, ?::uuid, ?, now()::text)"
      ).run(`dup${Date.now()}@parkomat.co.il`, require("node:crypto").randomUUID(), site.id);
      await db.prepare(
        "UPDATE app_users SET site_id = ? WHERE supabase_uid = ?::uuid"
      ).run(site.id, uid);
    } catch (e) { dup = e.message; }
    ok("⚠️ אין שני סוכנים פעילים לאותו אתר", dup !== null, "האינדקס הייחודי לא תפס");

    throw new Error("ROLLBACK-BY-DESIGN");
  }).catch((e) => {
    if (!String(e.message).includes("ROLLBACK-BY-DESIGN")) throw e;
  });

  // ⚠️ והאישור שהטרנזקציה באמת התבטלה. בדיקה שמותירה שורות בייצור היא
  // בדיוק התקלה ש-check-no-residue קיים בשבילה.
  const after = await db.prepare("SELECT COUNT(*)::int AS n FROM app_users").get();
  const left = await db.prepare(
    "SELECT COUNT(*)::int AS n FROM app_users WHERE email ~ '^(agentcheck|dup)[0-9]'"
  ).get();
  console.log("");
  ok("המסד חזר בדיוק למה שהיה", after.n === before.n && left.n === 0,
     `לפני ${before.n}, אחרי ${after.n}, שאריות ${left.n}`);

  console.log(`\n${"=".repeat(50)}`);
  console.log(fail === 0 ? `✅ עברו ${pass}` : `❌ נפלו ${fail} · עברו ${pass}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("שגיאה:", e.message); process.exit(1); });
