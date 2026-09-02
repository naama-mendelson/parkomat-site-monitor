// tools/check-agent-live.js — קוד ה-C# האמיתי כותב ל-Supabase האמיתי.
//
// ============================================================
// ⚠️ הפער שזה סוגר — ולמה אף בדיקה קיימת לא סוגרת אותו
// ============================================================
// `SupabaseWriterTests` רץ מול handler מזויף. `IngestContractTests` משווה
// מחרוזת JSON לקובץ. `check-agent-write` שולח את הקובץ — **מ-Node**.
// שלושתם חשובים, ואף אחד מהם לא מוכיח שהקוד שירוץ באתר שולח בייט אחד
// תקין: הכותרות, ה-TLS, הקידוד, וההתחברות עצמה מעולם לא נבדקו מ-C#.
//
// כאן זה נסגר: אתר וסוכן סינתטיים, משתני סביבה, `dotnet test` על הבדיקה
// החיה, ואז שאלה למסד — האם השורות באמת נחתו.
//
// ============================================================
// ⚠️ והשער הוא הסמכות על "האם הבדיקה בכלל רצה"
// ============================================================
// בדיקת xUnit שמדלגת בשקט נראית ירוקה בדיוק כמו בדיקה שעברה. הפרויקט
// הזה כבר נכווה בזה: שלושה שערים דיווחו "לא רץ" במשך חודשים ואיש לא שם
// לב, כי "לא רץ" הוא התשובה הכנה — וגם זו שגוללים מעליה.
//
// לכן הצלחת `dotnet test` **אינה** מספיקה כאן. השער בודק את המסד: אם
// השורות אינן שם, הבדיקה דילגה, וזה כישלון.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const db = require("../db/db");
const { makeSite, snapshot } = require("./lib/ingest-recorder");

const SB = process.env.SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const ANON = (fs.readFileSync(path.join(__dirname, "..", "..", "dashboard", ".env"), "utf8")
  .match(/^VITE_SUPABASE_PUBLISHABLE_KEY=(.*)$/m) || [])[1]?.trim();

const AGENT_DIR = path.join(__dirname, "..", "..", "Parkomat.Agent");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
};

const retry = async (url, opt) => {
  let last;
  for (let i = 0; i < 5; i++) {
    try { return await fetch(url, opt); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 600)); }
  }
  throw last;
};

const admin = () => ({ apikey: SECRET, Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" });

async function provisionAgent(site) {
  const email = `agentlive${Date.now()}${Math.floor(Math.random() * 900 + 100)}@parkomat.co.il`;
  const password = require("node:crypto").randomBytes(24).toString("base64url");

  const created = await retry(`${SB}/auth/v1/admin/users`, {
    method: "POST", headers: admin(),
    body: JSON.stringify({ email, password, email_confirm: true,
      app_metadata: { parkomat_role: "agent", site_code: site.code } }),
  });
  if (!created.ok) throw new Error(`יצירת סוכן נכשלה: ${(await created.text()).slice(0, 200)}`);
  const uid = (await created.json()).id;

  await db.prepare(
    "UPDATE app_users SET role = 'agent', site_id = ?, is_active = TRUE WHERE LOWER(email) = LOWER(?)"
  ).run(site.id, email);

  const cleanup = async () => {
    try { await retry(`${SB}/auth/v1/admin/users/${uid}`, { method: "DELETE", headers: admin() }); } catch { }
    try { await db.prepare("DELETE FROM app_users WHERE LOWER(email) = LOWER(?)").run(email); } catch { }
  };
  return { email, password, cleanup };
}

(async () => {
  console.log("=== check-agent-live ===\n");
  if (!SB || !SECRET || !ANON) { console.log("⚠️  אין פרטי חיבור — השער לא רץ."); process.exit(2); }
  if (!fs.existsSync(path.join(AGENT_DIR, "Parkomat.Agent.slnx"))) {
    console.log("⚠️  פרויקט הסוכן לא נמצא — השער לא רץ."); process.exit(2);
  }
  await db.init();

  // ⚠️ חותם קבוע שהשער קובע, ולא "עכשיו": שני התהליכים אינם חולקים רגע,
  // והשער חייב לדעת בדיוק אילו שורות לחפש.
  const stamp = Math.floor(Date.now() / 1000) - 1800;

  let site = null, agent = null;
  try {
    site = await makeSite();
    agent = await provisionAgent(site);

    console.log("── מריץ את בדיקת ה-C# החיה ──");
    let ran = false, output = "";
    try {
      output = execFileSync("dotnet",
        ["test", "Parkomat.Agent.slnx", "--nologo",
         "--filter", "WritesABatchToRealSupabase"],
        {
          cwd: AGENT_DIR,
          encoding: "utf8",
          timeout: 8 * 60 * 1000,
          env: {
            ...process.env,
            PARKOMAT_SB_URL: SB,
            PARKOMAT_SB_KEY: ANON,
            PARKOMAT_SB_EMAIL: agent.email,
            PARKOMAT_SB_PASSWORD: agent.password,
            PARKOMAT_SB_STAMP: String(stamp),
          },
        });
      ran = true;
    } catch (e) {
      output = String(e.stdout || "") + String(e.stderr || "");
    }

    const line = (output.match(/(Passed!|Failed!)[^\n]*/) || ["(אין שורת סיכום)"])[0];
    ok("בדיקת ה-C# עברה", ran, line.slice(0, 160));

    // ============================================================
    // ⚠️ וזו השורה שמפרידה בין "עברה" ל"בכלל רצה"
    // ============================================================
    console.log("\n── מה באמת נחת במסד ──");
    const snap = await snapshot(site.id);

    ok("⚠️ הבדיקה לא דילגה — יש שורות במסד", snap.ops.length > 0,
      "אפס פעולות: הבדיקה הסתיימה ירוקה בלי לשלוח דבר");

    ok("שתי פעולות נכתבו", snap.ops.length === 2, `${snap.ops.length}`);

    // אותו כלל שנמדד על 86 מתוך 1,013 זוגות — עכשיו דרך הקוד שירוץ באתר.
    ok("⚠️ הכרטיס עבר מהפתיחה לסגירה",
      snap.ops.find((o) => o.start_end === "end")?.card_number === "4271",
      JSON.stringify(snap.ops.map((o) => `${o.start_end}:${o.card_number}`)));

    ok("מקטעי מצב נכתבו", snap.segs.length >= 2, `${snap.segs.length}`);

    // ⚠️ העברית — זה מה שנשבר כשהמקודד בורח מכל תו שאינו ASCII, וזה
    // הקידוד שתוקן היום. כאן הוא נבדק על המסלול האמיתי מקצה לקצה.
    const fault = snap.segs.map((s) => s.fault_text).find(Boolean);
    ok("⚠️ תיאור התקלה בעברית שרד קריא",
      fault === "מיטה 5 - בוכנה 2: זמן מקסימלי לפעולה",
      JSON.stringify(fault));

    ok("המונה נשמר כבסיס (אתר חדש)",
      snap.site.cycle_total === 0 && snap.site.plc_cycle_last === 701,
      `total=${snap.site.cycle_total} base=${snap.site.plc_cycle_last}`);

  } finally {
    if (agent) await agent.cleanup();
    if (site) {
      try {
        await db.prepare("DELETE FROM operations WHERE site_id = ?").run(site.id);
        await db.prepare("DELETE FROM status_history WHERE site_id = ?").run(site.id);
        await db.prepare("DELETE FROM ingest_drops WHERE site_code = ?").run(site.code);
        await db.prepare("DELETE FROM events WHERE site_code = ?").run(site.code);
        await db.prepare("DELETE FROM sites WHERE id = ?").run(site.id);
      } catch (e) { console.error(`ניקוי נכשל: ${e.message}`); }
    }
  }

  const left = await db.prepare(
    "SELECT COUNT(*)::int AS n FROM sites WHERE code ~ '^wcheck[0-9]'").get();
  console.log("");
  ok("⚠️ אפס אתרי בדיקה נשארו", left.n === 0, `נשארו ${left.n}`);

  console.log(`\n${"=".repeat(50)}`);
  console.log(fail === 0 ? `✅ עברו ${pass}` : `❌ נפלו ${fail} · עברו ${pass}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("שגיאה:", e.message); process.exit(1); });
