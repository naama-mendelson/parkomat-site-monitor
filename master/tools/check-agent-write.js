// tools/check-agent-write.js — סוכן כותב לבסיס הנתונים. מקצה לקצה.
//
// ============================================================
// ⚠️ מה זה מוכיח שאף שער אחר אינו מוכיח
// ============================================================
// כל שערי ההשוואה של הקליטה רצים דרך ה-pool — כלומר הם מוכיחים שה-SQL
// נכון, ואינם חוצים את PostgREST כלל. זה בדיוק הלקח שכבר עלה כאן פעם:
// **שער השוואה אינו רואה מה שכבת התחבורה זרקה.**
//
// ⚠️ ובלי השער הזה זה כבר קרה: `app.ingest_operation` ו-`app.ingest_state`
// נבנו, נבדקו ב-45 השוואות, ו**לא היו נגישות לסוכן בכלל** — PostgREST
// מחפש רק בסכמת `public`, והן ב-`app`. הקריאה חוזרת 404 עם PGRST202.
// שני שערים ירוקים על קוד שאיש לא יכול להשתמש בו.
//
// ============================================================
// ⚠️ והטענה החשובה כאן היא **הבידוד**, לא ההצלחה
// ============================================================
// שסוכן יכול לכתוב לאתר שלו זה חצי. החצי השני — שהוא **אינו יכול** לכתוב
// לאתר אחר — הוא כל מה שעומד בין דליפת סיסמה של אתר אחד לבין נזק ל-16.
// הדלת הציבורית אינה מקבלת מזהה אתר; היא גוזרת אותו מהזהות. השער הזה
// מוודא שאין דרך לעקוף את זה.
const fs = require("node:fs");
const path = require("node:path");
const db = require("../db/db");
const { makeSite, snapshot } = require("./lib/ingest-recorder");

const SB = process.env.SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const ANON = (fs.readFileSync(path.join(__dirname, "..", "..", "dashboard", ".env"), "utf8")
  .match(/^VITE_SUPABASE_PUBLISHABLE_KEY=(.*)$/m) || [])[1]?.trim();

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

/** יוצר סוכן אמיתי לאתר, מתחבר, ומחזיר אסימון + ניקוי. */
async function provisionAgent(site) {
  const email = `agentw${Date.now()}${Math.floor(Math.random() * 900 + 100)}@parkomat.co.il`;
  const password = require("node:crypto").randomBytes(24).toString("base64url");

  const created = await retry(`${SB}/auth/v1/admin/users`, {
    method: "POST", headers: admin(),
    body: JSON.stringify({ email, password, email_confirm: true,
      app_metadata: { parkomat_role: "agent", site_code: site.code } }),
  });
  if (!created.ok) throw new Error(`יצירת סוכן נכשלה: ${(await created.text()).slice(0, 200)}`);
  const uid = (await created.json()).id;

  // ⚠️ הדרגה והשיוך נכתבים ביד: provision_app_user רץ ב-AFTER INSERT, לפני
  // שגו-טרו כותב את app_metadata, ולכן השורה נולדת כ-operator בלי site_id.
  await db.prepare(
    "UPDATE app_users SET role = 'agent', site_id = ?, is_active = TRUE WHERE LOWER(email) = LOWER(?)"
  ).run(site.id, email);

  const signIn = await retry(`${SB}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signIn.ok) throw new Error(`התחברות סוכן נכשלה: ${(await signIn.text()).slice(0, 200)}`);
  const token = (await signIn.json()).access_token;

  const cleanup = async () => {
    try { await retry(`${SB}/auth/v1/admin/users/${uid}`, { method: "DELETE", headers: admin() }); } catch { }
    try { await db.prepare("DELETE FROM app_users WHERE LOWER(email) = LOWER(?)").run(email); } catch { }
  };
  return { token, email, cleanup };
}

const callBatch = (token, messages) =>
  retry(`${SB}/rest/v1/rpc/ingest_batch`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_messages: messages }),
  });

(async () => {
  console.log("=== check-agent-write ===\n");
  if (!SB || !SECRET || !ANON) { console.log("⚠️  אין פרטי חיבור — השער לא רץ."); process.exit(2); }
  await db.init();

  // ⚠️ האתרים והסוכנים נוצרים **מחוץ** לטרנזקציה: הכתיבה מגיעה דרך הרשת,
  // כלומר מחיבור אחר לגמרי, והוא אינו רואה טרנזקציה שלא בוצעה. הניקוי
  // מפורש, ורץ בכל מסלול יציאה.
  const t0 = Math.floor(Date.now() / 1000) - 600;
  const iso = (s) => new Date(s * 1000).toISOString();

  let mine = null, other = null, agent = null;
  try {
    mine = await makeSite();
    other = await makeSite();
    agent = await provisionAgent(mine);

    // ---------- 1. הסוכן כותב לאתר שלו ----------
    console.log("── הסוכן כותב ──");
    const r = await callBatch(agent.token, [
      { kind: "state", status: "operating", occurred_at: iso(t0) },
      { kind: "operation", start_end: "start", entry_exit: "entry", card: "77",
        state: "operating", occurred_at: iso(t0), cycle: 100 },
      { kind: "operation", start_end: "end", entry_exit: "entry", card: "",
        state: "operating", occurred_at: iso(t0 + 30), cycle: 101 },
      { kind: "state", status: "ready", occurred_at: iso(t0 + 35) },
    ]);
    const body = await r.json();
    ok("הקריאה מצליחה", r.status === 200, `${r.status} ${JSON.stringify(body).slice(0, 160)}`);
    ok("חוזרת תוצאה לכל הודעה", Array.isArray(body) && body.length === 4,
      JSON.stringify(body).slice(0, 160));

    const snap = await snapshot(mine.id);
    ok("שתי פעולות נכתבו", snap.ops.length === 2, `${snap.ops.length}`);
    // ⚠️ אותו כלל שנמדד על 86 מתוך 1,013 זוגות — והוא חייב לעבוד גם דרך
    // הדלת הזו, לא רק ב-pool.
    ok("⚠️ הכרטיס עבר מהפתיחה לסגירה",
      snap.ops.find((o) => o.start_end === "end")?.card_number === "77");
    ok("מקטעי מצב נכתבו", snap.segs.length >= 2, `${snap.segs.length}`);
    ok("המונה נשמר כבסיס (אתר חדש)",
      snap.site.cycle_total === 0 && snap.site.plc_cycle_last === 101,
      `total=${snap.site.cycle_total} base=${snap.site.plc_cycle_last}`);

    // ---------- 2. הבידוד ----------
    console.log("\n── הבידוד ──");
    const otherBefore = await snapshot(other.id);

    // ⚠️ הניסיון הישיר: לשלוח מזהה אתר אחר בתוך המטען. הדלת הציבורית אינה
    // מסתכלת עליו בכלל — ולכן הכתיבה נוחתת אצל **הסוכן**, לא אצל היעד.
    await callBatch(agent.token, [
      { kind: "operation", site_id: other.id, start_end: "start", entry_exit: "exit",
        card: "666", state: "operating", occurred_at: iso(t0 + 100), cycle: 500 },
    ]);
    const otherAfter = await snapshot(other.id);
    ok("⚠️ מזהה אתר במטען אינו משנה דבר",
      otherAfter.ops.length === otherBefore.ops.length,
      `לאתר הזר יש עכשיו ${otherAfter.ops.length} פעולות`);

    // ---------- 3. מנהל אינו סוכן ----------
    const { gateToken } = require("./lib/gate-user");
    const mgr = await gateToken(SB, ANON, SECRET, retry);
    try {
      const mr = await callBatch(mgr.token, [
        { kind: "state", status: "error", occurred_at: iso(t0 + 200) },
      ]);
      // ⚠️ מנהל הוא לא סוכן, ו-agent_site_id() מחזירה לו NULL. אילו NULL
      // היה נקרא כ"ללא הגבלה", מנהל היה יכול לזייף קליטה לכל אתר.
      ok("⚠️ מנהל נדחה — אינו סוכן", mr.status === 403 || mr.status === 400,
        `קיבל ${mr.status}`);
    } finally { await mgr.cleanup(); }

    // ---------- 4. סוג לא מוכר נרשם ----------
    console.log("\n── שאר הכללים ──");
    const ur = await callBatch(agent.token, [{ kind: "bogus", occurred_at: iso(t0 + 300) }]);
    const ub = await ur.json();
    ok("סוג לא מוכר נדחה ומדווח",
      ur.status === 200 && ub[0]?.outcome === "rejected" && ub[0]?.detail === "unknown_kind",
      JSON.stringify(ub).slice(0, 120));
    const drops = (await snapshot(mine.id)).drops.map((d) => d.reason);
    ok("⚠️ והדחייה נרשמה ל-ingest_drops", drops.includes("unknown_kind"),
      JSON.stringify(drops));

    // ---------- 5. תקרת האצווה ----------
    const big = Array.from({ length: 201 }, (_, i) =>
      ({ kind: "state", status: "ready", occurred_at: iso(t0 + 400 + i) }));
    const br = await callBatch(agent.token, big);
    ok("⚠️ אצווה ענקית נדחית", br.status >= 400,
      `קיבלה ${br.status} — אצווה בלי תקרה מקפיאה את שורת האתר`);

    // ---------- 6. סוכן מושבת ----------
    await db.prepare("UPDATE app_users SET is_active = FALSE WHERE LOWER(email) = LOWER(?)")
      .run(agent.email);
    const dr = await callBatch(agent.token, [
      { kind: "state", status: "error", occurred_at: iso(t0 + 700) },
    ]);
    // ⚠️ האסימון עדיין תקף — ההשבתה חייבת לתפוס **בצד המסד**, אחרת
    // "השבתתי את האתר" אינה משביתה דבר עד שהאסימון יפוג.
    ok("⚠️ השבתה חוסמת מיד, למרות אסימון תקף", dr.status === 403 || dr.status === 400,
      `קיבל ${dr.status}`);

  } finally {
    if (agent) await agent.cleanup();
    for (const s of [mine, other]) {
      if (!s) continue;
      try {
        await db.prepare("DELETE FROM operations WHERE site_id = ?").run(s.id);
        await db.prepare("DELETE FROM status_history WHERE site_id = ?").run(s.id);
        await db.prepare("DELETE FROM ingest_drops WHERE site_code = ?").run(s.code);
        await db.prepare("DELETE FROM events WHERE site_code = ?").run(s.code);
        await db.prepare("DELETE FROM sites WHERE id = ?").run(s.id);
      } catch (e) { console.error(`ניקוי אתר ${s.code} נכשל: ${e.message}`); }
    }
  }

  // ⚠️ והאישור שהניקוי באמת עבד. שער שמותיר אתרי בדיקה בייצור הוא בדיוק
  // מה ש-check-no-residue קיים בשבילו.
  const left = await db.prepare(
    "SELECT COUNT(*)::int AS n FROM sites WHERE code ~ '^(wcheck|gate)[0-9]'").get();
  console.log("");
  ok("⚠️ אפס אתרי בדיקה נשארו", left.n === 0, `נשארו ${left.n}`);

  console.log(`\n${"=".repeat(50)}`);
  console.log(fail === 0 ? `✅ עברו ${pass}` : `❌ נפלו ${fail} · עברו ${pass}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("שגיאה:", e.message); process.exit(1); });
