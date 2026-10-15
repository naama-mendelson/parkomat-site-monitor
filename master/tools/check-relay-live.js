// tools/check-relay-live.js — הממסר לוויזנט, מקצה לקצה, מול הרכיבים האמיתיים (15/10/2026).
//
//   node --env-file=.env tools/check-relay-live.js
//
// ============================================================
// ⚠️ הפער שזה סוגר
// ============================================================
// WizenetRelayTests (C#) רץ מול handler מזויף וחיבור WebSocket מזויף — כלומר הפרוטוקול נבדק מול מה שכתבנו בעצמנו.
// wizenet-relay.test.js רץ על Postgres מקומי. אף אחד מהם לא מוכיח את מה שיקרה באתר: שההצטרפות ל-Realtime האמיתי
// מתקבלת, שסוכן רשאי לקרוא את events דרכו, שפונקציית ה-Edge הפרוסה מוסרת את הטוקן, ושוויזנט עונים לממסר.
//
// כאן: אתר וסוכן סינתטיים + שורת ממסר, הקוד האמיתי של הסוכן רץ מהמחשב הזה (בישראל), ושתי בקשות אמיתיות לתור:
//   1. רענון רשימות — שאילתת קריאה בלבד אצל ויזנט.
//   2. שינוי סטטוס לקריאה שאינה קיימת (999999999) — ויזנט עונים "לא נמצאה", ושום דבר אצלם אינו משתנה. זה מוכיח
//      שהטוקן מתקבל גם לפונקציות העדכון, בלי לגעת בקריאה אמיתית.
// ונמדד: כמה זמן מהכנסה לתור עד שהממסר לקח — שנייה (הפעמון) או דקה (הבדיקה העצמית).
//
// ⚠️ בלי db.init(): הוא מחיל את כל ה-SQL מחדש על הייצור. כאן — חיבור pg פשוט, ורק השורות של הבדיקה.
// ⚠️ ובזמן הבדיקה הממסר הסינתטי הוא הממסר החי היחיד — שלושת האמיתיים עוד לא שואלים. בקשה אמיתית שתיכנס בדקות
// האלה תילקח על ידו ותישלח מהמחשב הזה; זה תקין (אותה פעולה), אבל עדיף להריץ כשהכפתור עוד כבוי.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { Client } = require("pg");

const SB = process.env.SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const ANON = (fs.readFileSync(path.join(__dirname, "..", "..", "dashboard", ".env"), "utf8")
  .match(/^VITE_SUPABASE_PUBLISHABLE_KEY=(.*)$/m) || [])[1]?.trim();
const AGENT_DIR = path.join(__dirname, "..", "..", "Parkomat.Agent");
const WHO = "בדיקה חיה (check-relay-live)";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const admin = () => ({ apikey: SECRET, Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" });

async function until(what, fn, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`לא קרה תוך ${Math.round(ms / 1000)} שנ׳: ${what}`);
    await sleep(250);
  }
}

(async () => {
  console.log("=== check-relay-live ===\n");
  if (!SB || !SECRET || !ANON || !process.env.DATABASE_URL) { console.log("⚠️  אין פרטי חיבור — השער לא רץ."); process.exit(2); }

  const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-live-"));
  const stopFile = path.join(tmp, "stop"), logFile = path.join(tmp, "relay.log");
  let site = null, uid = null, email = null, child = null, out = "";
  const ids = [];
  try {
    // ---- אתר, סוכן, שורת ממסר ----
    const code = `wcheck${Date.now()}${Math.floor(Math.random() * 900 + 100)}`;
    site = (await q(`INSERT INTO sites (code, site_name, status, registered_at, is_new_site)
                      VALUES ($1, $2, 'ready', $3, 1) RETURNING id, code`,
      [code, `בדיקת ממסר ${code}`, new Date(Date.now() - 86400000).toISOString()]))[0];
    email = `relaylive${Date.now()}${Math.floor(Math.random() * 900 + 100)}@parkomat.co.il`;
    const password = crypto.randomBytes(24).toString("base64url");
    const created = await fetch(`${SB}/auth/v1/admin/users`, {
      method: "POST", headers: admin(),
      body: JSON.stringify({ email, password, email_confirm: true, app_metadata: { parkomat_role: "agent", site_code: code } }),
    });
    if (!created.ok) throw new Error(`יצירת סוכן נכשלה: ${(await created.text()).slice(0, 200)}`);
    uid = (await created.json()).id;
    await q(`UPDATE app_users SET role = 'agent', site_id = $1, is_active = TRUE WHERE lower(email) = lower($2)`, [site.id, email]);
    await q(`INSERT INTO wizenet_relays (site_id) VALUES ($1)`, [site.id]);

    // ---- הסוכן האמיתי, ברקע ----
    console.log("── מריץ את הממסר (C#) ──");
    child = spawn("dotnet", ["test", "Parkomat.Agent.slnx", "--nologo", "--filter", "RelayRunsAgainstRealSupabase"], {
      cwd: AGENT_DIR,
      env: { ...process.env, PARKOMAT_RELAY_URL: SB, PARKOMAT_RELAY_KEY: ANON, PARKOMAT_RELAY_EMAIL: email,
        PARKOMAT_RELAY_PASSWORD: password, PARKOMAT_RELAY_STOP: stopFile, PARKOMAT_RELAY_LOG: logFile },
    });
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const exited = new Promise((r) => child.on("exit", (c) => r(c)));

    // ---- הממסר עלה: שאל את התור, והפעמון מחובר ----
    const rel = await until("הממסר שאל את התור עם פעמון מחובר", async () =>
      (await q(`SELECT polled_at, socket_ok, agent_version FROM wizenet_relays WHERE site_id = $1`, [site.id]))
        .find((r) => r.polled_at && r.socket_ok), 240_000);
    ok("הממסר שואל את התור, והפעמון (Realtime) מחובר", true, `גרסה ${rel.agent_version}`);

    const enqueue = async (kind, calls, ticket = null, field = null, value = null) => {
      const id = Number((await q(`SELECT app.wizenet_enqueue($1, $2, $3, $4, $5::jsonb, $6, NULL) AS id`,
        [kind, ticket, field, value, JSON.stringify(calls), WHO]))[0].id);
      ids.push(id);
      return id;
    };
    const finalOf = (id, ms) => until(`בקשה ${id} נסגרה`, async () =>
      (await q(`SELECT state, result, response, attempt, failed_sites,
                       extract(epoch FROM claimed_at - created_at) AS to_claim,
                       extract(epoch FROM finished_at - created_at) AS to_finish
                  FROM wizenet_requests WHERE id = $1`, [id]))
        .find((r) => ["done", "failed", "expired"].includes(r.state)), ms);

    // ---- 1. רענון רשימות ----
    console.log("\n── 1. רענון רשימות (קריאה בלבד) ──");
    const lists = (await q(`SELECT app.wizenet_lookup_calls() AS c`))[0].c;
    const r1 = await finalOf(await enqueue("lookups", lists), 90_000);
    ok("הבקשה נסגרה בהצלחה", r1.state === "done", `${r1.state}: ${r1.result}`);
    ok("ויזנט החזירו את שתי הרשימות", /^נטענו \d+ סטטוסים ו-\d+ סוגי קריאה$/.test(r1.result || ""), r1.result);
    ok("⚠️ נלקחה תוך שניות — הפעמון, לא הבדיקה של כל דקה", Number(r1.to_claim) < 5,
      `לקיחה אחרי ${Number(r1.to_claim).toFixed(2)} שנ׳, סגירה אחרי ${Number(r1.to_finish).toFixed(2)} שנ׳`);

    // ---- 2. שינוי לקריאה שאינה קיימת ----
    console.log("\n── 2. שינוי סטטוס לקריאה שאינה קיימת (999999999) ──");
    const r2 = await finalOf(await enqueue("update",
      [{ func: "wizeApp_updateCallStatus", body: { callid: "999999999", callstatusid: "148" } }],
      "999999999", "status", "148"), 90_000);
    ok("ויזנט קיבלו את הטוקן לפונקציית העדכון, וענו", r2.state === "failed" && r2.result && !/טוקן|הפניה|חיבור|לא ענו/.test(r2.result),
      `${r2.state}: ${r2.result}`);
    ok("והתשובה היא 'לא נמצאה' — שום דבר לא השתנה אצלם", r2.result === "הקריאה לא נמצאה בוויזנט",
      `${r2.result} | ${String(r2.response || "").slice(0, 160)}`);
    ok("נלקחה תוך שניות", Number(r2.to_claim) < 5, `${Number(r2.to_claim).toFixed(2)} שנ׳`);
    ok("נשלחה פעם אחת", r2.attempt === 1 && r2.failed_sites.length === 0, `attempt ${r2.attempt}`);

    // ---- 3. חידוש ההזדהות על החיבור החי ----
    // ⚠️ בשטח החיבור פתוח שעות, והאסימון של Supabase חי שעה. בלי access_token בזמן, Supabase סוגר את הערוץ בשקט.
    // הבדיקה בצד ה-C# מחליפה לאסימון של התחברות שנייה; כאן — מחכים שהפעמון ישלח אותו, ובודקים שהוא עדיין מצלצל.
    console.log("\n── 3. חידוש ההזדהות על החיבור החי ──");
    const logHas = (s) => fs.existsSync(logFile) && fs.readFileSync(logFile, "utf8").includes(s);
    await until("האסימון הוחלף בצד ה-C#", () => logHas("token swapped"), 60_000);
    await until("הפעמון שלח את האסימון החדש", () => logHas("realtime token renewed"), 60_000);
    await sleep(3000);   // אם Supabase היה דוחה את האסימון — כאן הערוץ היה נסגר
    const r3 = await finalOf(await enqueue("update",
      [{ func: "wizeApp_updateCallStatus", body: { callid: "999999999", callstatusid: "148" } }],
      "999999999", "status", "148"), 90_000);
    ok("⚠️ אחרי החידוש — הפעמון עדיין מצלצל (נלקחה תוך שניות)", Number(r3.to_claim) < 5,
      `${Number(r3.to_claim).toFixed(2)} שנ׳ · ${r3.result}`);
    ok("והחיבור לא נפל ולא התחבר מחדש", !logHas("realtime down") && !logHas("closed by the server"));
  } catch (e) {
    ok("השער רץ עד הסוף", false, e.message);
  } finally {
    // ---- עצירה וניקוי ----
    try { fs.writeFileSync(stopFile, "stop"); } catch { }
    if (child) {
      const code = await Promise.race([new Promise((r) => child.on("exit", r)), sleep(60_000).then(() => "timeout")]);
      if (code === "timeout") { child.kill(); ok("הממסר נעצר בזמן", false, "נהרג אחרי 60 שנ׳"); }
      const line = (out.match(/(Passed!|Failed!)[^\n]*/) || ["(אין שורת סיכום)"])[0];
      ok("בדיקת ה-C# עברה (הלולאה לא נפלה, והפעמון התחבר)", /Passed!/.test(line), line.slice(0, 160));
    }
    if (fs.existsSync(logFile)) {
      const log = fs.readFileSync(logFile, "utf8");
      console.log("\n── יומן הממסר ──\n" + log.split(/\r?\n/).filter(Boolean).map((l) => "   " + l).join("\n"));
      ok("⚠️ הטוקן של ויזנט לא נכתב ליומן", !/token"?\s*[:=]/i.test(log) && !log.includes("Authorization"));
      ok("אין אזהרות ביומן", !/ WARN /.test(log));
    }
    try { if (ids.length) await q(`DELETE FROM wizenet_requests WHERE id = ANY($1::bigint[])`, [ids]); } catch (e) { console.error("ניקוי בקשות:", e.message); }
    try { if (site) await q(`DELETE FROM wizenet_relays WHERE site_id = $1`, [site.id]); } catch (e) { console.error("ניקוי ממסר:", e.message); }
    try { if (uid) await fetch(`${SB}/auth/v1/admin/users/${uid}`, { method: "DELETE", headers: admin() }); } catch { }
    try { if (email) await q(`DELETE FROM app_users WHERE lower(email) = lower($1)`, [email]); } catch { }
    try { if (site) await q(`DELETE FROM sites WHERE id = $1`, [site.id]); } catch (e) { console.error("ניקוי אתר:", e.message); }
    const left = (await q(`SELECT (SELECT count(*) FROM sites WHERE code ~ '^wcheck[0-9]')::int sites,
                                  (SELECT count(*) FROM wizenet_relays r LEFT JOIN sites s ON s.id = r.site_id
                                    WHERE s.code IS NULL OR s.code ~ '^wcheck')::int relays,
                                  (SELECT count(*) FROM app_users WHERE email ~ '^relaylive')::int users`))[0];
    ok("⚠️ שום דבר מהבדיקה לא נשאר", left.sites === 0 && left.relays === 0 && left.users === 0, JSON.stringify(left));
    await db.end();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${"=".repeat(50)}`);
  console.log(fail === 0 ? `✅ עברו ${pass}` : `❌ נפלו ${fail} · עברו ${pass}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("שגיאה:", e.message); process.exit(1); });
