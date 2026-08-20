// בדיקה חיה: הסיווג עובר מה-DB דרך הציר המשותף עד לצ'יפים.
// מריצים מתוך master/ עם --env-file=.env
import fs from "node:fs";
import { buildActivityLog } from "../../shared/timeline.mjs";

const SB = process.env.SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const ANON = (fs.readFileSync("../dashboard/.env", "utf8")
  .match(/^VITE_SUPABASE_PUBLISHABLE_KEY=(.*)$/m) || [])[1]?.trim();

async function f(url, opt) {
  let last;
  for (let i = 0; i < 5; i++) {
    try { return await fetch(url, opt); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 600)); }
  }
  throw last;
}

// ============================================================
// ⚠️ המשתמש נבנה ב-gate-user, ולא ביד — וזה תוקן אחרי כשל אמיתי
// ============================================================
// הגרסה הראשונה כאן יצרה מנהל בעצמה ומחקה בסוף רק את חשבון ה-auth. שורת
// `app_users` נשארה — כלומר **השער ייצר בדיוק את התקלה ש-check-writes
// צד**: שורה פעילה עם supabase_uid שאין מאחוריו חשבון. ארבע ריצות, ארבעה
// יתומים, ו-check-writes נפל על לכלוך של שער אחר.
//
// gate-user מוחק את שני הצדדים בכל מסלול יציאה, כולל כישלון. הוא גם כותב
// את התפקיד ל-app_users ביד — `app.is_manager()` קורא מהטבלה ולא
// מהאסימון, ו-provision_app_user רץ לפני שגו-טרו כותב את app_metadata,
// כך שהשורה נולדת כבקר. `app_metadata: manager` לבדו אינו מספיק.
const { createRequire } = await import("node:module");
const { gateToken } = createRequire(import.meta.url)("./lib/gate-user");
const { token, cleanup: dropUser } = await gateToken(SB, ANON, SECRET, f);

const H = { apikey: ANON, Authorization: `Bearer ${token}` };
const get = async (q) => (await f(`${SB}/rest/v1/${q}`, { headers: H })).json();
const rpc = async (fn, body) => {
  const r = await f(`${SB}/rest/v1/rpc/${fn}`, {
    method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

const cleanup = () => dropUser();

try {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();

  const cand = await get(`status_history?status=eq.error&ended_at=not.is.null&started_at=gte.${since}` +
                         `&reclassified_to=is.null&select=id,site_id,status,started_at&order=started_at.desc&limit=1`);
  if (!cand?.length) { console.error("אין מקטע תקלה בטווח"); await cleanup(); process.exit(1); }
  const T = cand[0];
  console.log(`מקטע נבחר: id=${T.id} · אתר ${T.site_id} · ${T.started_at}`);

  async function timelineFor() {
    const [states, ops, maint] = await Promise.all([
      get(`status_history?site_id=eq.${T.site_id}&started_at=gte.${since}&select=id,site_id,status,started_at,ended_at,fault_text,excluded_at,excluded_by,reclassified_to,reclassified_by,reclassified_at&limit=10000`),
      get(`operations?site_id=eq.${T.site_id}&occurred_at=gte.${since}&select=*&limit=10000`),
      get(`maintenance_windows?site_id=eq.${T.site_id}&started_at=gte.${since}&select=*&limit=10000`),
    ]);
    const out = {};
    for (const flt of ["all", "error", "maintenance", "repair", "test", "reclassified"]) {
      out[flt] = buildActivityLog({ ops, states, maint, filter: flt, limit: 5000 });
    }
    const row = [...out.all.entries, ...out.reclassified.entries]
      .find((e) => e.kind === "status" && e.id === T.id);
    return { out, row };
  }

  const before = await timelineFor();
  const chips = (o) => `תקלות=${o.error.total} · תחזוקה=${o.maintenance.total} · סווגו מחדש=${o.reclassified.total} · תפעול תקלה=${o.repair.total} · ניסויים=${o.test.total}`;
  console.log("\n── לפני ──");
  console.log(`  מוצג כ: ${before.row?.status} · originalStatus=${before.row?.originalStatus ?? "—"}`);
  console.log(`  צ'יפים: ${chips(before.out)}`);

  const rc = await rpc("reclassify_status", { p_id: T.id, p_to: "maintenance" });
  if (rc.status !== 200) { console.error("❌ reclassify:", rc.status, JSON.stringify(rc.body)); await cleanup(); process.exit(1); }
  console.log(`\nRPC: was=${rc.body[0].was} → ${rc.body[0].now_is} · בידי ${rc.body[0].by_name}`);

  const after = await timelineFor();
  console.log("\n── אחרי ──");
  console.log(`  מוצג כ: ${after.row?.status} · originalStatus=${after.row?.originalStatus}`);
  console.log(`  שונה בידי: ${after.row?.reclassifiedBy} · ${after.row?.reclassifiedAt}`);
  console.log(`  צ'יפים: ${chips(after.out)}`);

  const raw = (await get(`status_history?id=eq.${T.id}&select=status,reclassified_to`))[0];
  console.log(`\n  ב-DB: status=${raw.status} (המקור) · reclassified_to=${raw.reclassified_to}`);

  const checks = [
    ["השורה מוצגת כתחזוקה", after.row?.status === "maintenance"],
    ["המקור נשמר ב-DB ומוצג במסך", raw.status === "error" && after.row?.originalStatus === "error"],
    ["מי שינה מוצג", Boolean(after.row?.reclassifiedBy)],
    ["מונה התקלות ירד", after.out.error.total < before.out.error.total],
    ["מונה התחזוקה עלה", after.out.maintenance.total > before.out.maintenance.total],
    ["הצ'יפ 'סווגו מחדש' תופס", after.out.reclassified.total === before.out.reclassified.total + 1],
    // ============================================================
    // ⚠️ הבדיקה שמוכיחה שהסיווג הוחל **בכניסה** ולא בתווית
    // ============================================================
    // התחזוקה עלתה ב-2 ולא ב-1, ו"תפעול תקלה" ירד ב-1 — וזה בדיוק הנכון:
    // מקטע התחזוקה שבא מיד אחרי אותה "תקלה" נספר כטיפול בתקלה רק משום
    // שקדמה לו תקלה. מרגע שהיא איננה תקלה, הוא תחזוקה שגרתית.
    //
    // ⚠️ אילו הסיווג היה מוחל בשכבת התצוגה בלבד, המספר הזה לא היה זז —
    // והמסך היה מראה "תחזוקה" שאחריה "תפעול תקלה" בלי שום תקלה בסביבה.
    // זו השורה שתיפול אם מישהו יעביר את ההחלפה למטה, ל-describe.
    ["'תפעול תקלה' ירד — הסיווג הוחל לפני החישוב",
      after.out.repair.total === before.out.repair.total - 1],
  ];

  const undo = await rpc("reclassify_status", { p_id: T.id, p_to: null });
  const back = await timelineFor();
  checks.push(["ביטול מחזיר לתקלה", undo.status === 200 && back.row?.status === "error"
    && back.out.error.total === before.out.error.total && back.out.reclassified.total === before.out.reclassified.total]);

  console.log("\n" + "=".repeat(54));
  let bad = 0;
  for (const [n, ok] of checks) { if (!ok) bad++; console.log(`  ${ok ? "✅" : "❌"} ${n}`); }
  console.log("=".repeat(54));
  console.log(bad ? `❌ ${bad} כשלים` : "✅ הכל עבר");
  await cleanup();
  process.exit(bad ? 1 : 0);
} catch (e) {
  console.error("שגיאה:", e.message);
  await cleanup();
  process.exit(1);
}
