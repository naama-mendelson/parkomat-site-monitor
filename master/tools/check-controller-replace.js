// tools/check-controller-replace.js — הוחלף בקר, והמונה לא זז.
//
// ============================================================
// ⚠️ למה זה שער ולא בדיקת יחידה
// ============================================================
// `cycle_total` הוא **בלתי הפיך**: מספר שנוסף אליו בטעות אינו ניתן
// להסרה, כי אין דרך לדעת אילו מחזורים היו אמיתיים. זה גם המונה היחיד
// שמעיד על מה שאבד בנפילות — 1,097 מחזורים נמדדו כך.
//
// ============================================================
// ⚠️ הבעיה שאי אפשר להסיק ממנה
// ============================================================
// בקר שנפל לו החשמל והתאפס ל-0 בשעה 09:00, וב-09:05 הוא על 5 — חמשת
// המחזורים האלה **אמיתיים**, ולכן הקליטה מוסיפה אותם.
// בקר **שהוחלף** מגיע עם מחזורי בדיקות מפעל, ואותם אסור להוסיף.
//
// שני המקרים נראים זהים לחלוטין מהמספר. נמדד: בקר חדש עם 87 מחזורי
// מפעל מוסיף 87 מחזורים מדומים.
const db = require("../db/db");
const { makeSite } = require("./lib/ingest-recorder");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
};

(async () => {
  console.log("=== check-controller-replace ===\n");
  await db.init();

  let site = null;
  try {
    site = await makeSite();
    const iso = new Date().toISOString();

    // אתר ותיק: מונה היסטורי גדול, בסיס קיים.
    await db.prepare(
      "UPDATE sites SET cycle_total = 1200000, plc_cycle_last = 45000, is_new_site = 0 WHERE id = ?"
    ).run(site.id);

    // ---------- 1. המצב לפני — וזה הכשל שהפיצ'ר מתקן ----------
    // ⚠️ בלי הסימון, בקר חדש עם 87 מחזורי מפעל מוסיף אותם.
    const before = await db.prepare(
      "SELECT * FROM app.decide_cycle_update(45000, ?, 1200000, 0, 87, ?)"
    ).get(new Date(Date.now() - 3600000).toISOString(), iso);
    ok("⚠️ בלי סימון — 87 מחזורי מפעל נספרים בטעות",
       before.total === 1200087, `קיבל ${before.total}`);

    // ---------- 2. הסימון ----------
    const mgr = await db.prepare(
      "SELECT supabase_uid FROM app_users WHERE role='manager' AND is_active AND supabase_uid IS NOT NULL LIMIT 1"
    ).get();
    if (!mgr) { console.log("אין מנהל פעיל — לא ניתן לבדוק"); process.exit(2); }
    await db.prepare("SELECT set_config('app.user_id', ?, false)").get(mgr.supabase_uid);

    const r = await db.prepare("SELECT * FROM public.mark_controller_replaced(?)").get(site.code);
    ok("הפעולה מחזירה את המונה שנשמר", r.cycle_total === 1200000, `${r.cycle_total}`);
    ok("...ואת הבסיס הקודם", r.previous_baseline === 45000, `${r.previous_baseline}`);

    // ---------- 3. ⚠️ שני השדות יחד — וזה הלב ----------
    // איפוס הבסיס לבדו, בלי is_new_site=1, **הורס** את המונה: ענף ה-first
    // מאמץ את הערך הנוכחי. נמדד: 1,200,000 → 87.
    const st = await db.prepare(
      "SELECT cycle_total, plc_cycle_last, is_new_site FROM sites WHERE id = ?"
    ).get(site.id);
    ok("הבסיס אופס", st.plc_cycle_last === null, `${st.plc_cycle_last}`);
    ok("⚠️ ו-is_new_site הועבר ל-1 — בלעדיו המונה נהרס", st.is_new_site === 1, `${st.is_new_site}`);
    ok("המונה עצמו לא זז", st.cycle_total === 1200000, `${st.cycle_total}`);

    // ---------- 4. הקריאה הראשונה מהבקר החדש ----------
    const after = await db.prepare(
      "SELECT * FROM app.decide_cycle_update(?, NULL, ?, ?, 87, ?)"
    ).get(st.plc_cycle_last, st.cycle_total, st.is_new_site, iso);
    ok("⚠️ הקריאה הראשונה נקלטת כבסיס בלבד", after.total === 1200000, `${after.total}`);
    ok("...והבסיס החדש הוא 87", after.next_last === 87, `${after.next_last}`);

    // ---------- 5. וממשיך לספור נורמלית ----------
    // ⚠️ הבדיקה שמונעת "תיקנו את ההוספה והרסנו את הספירה": אחרי הבסיס,
    // מחזורים אמיתיים חייבים להיספר כרגיל.
    const next = await db.prepare(
      "SELECT * FROM app.decide_cycle_update(87, ?, 1200000, 1, 95, ?)"
    ).get(iso, new Date(Date.now() + 60000).toISOString());
    ok("⚠️ ואחר כך סופר רגיל — 8 מחזורים אמיתיים נוספו",
       next.mode === "normal" && next.total === 1200008, `${next.mode} ${next.total}`);

    // ---------- 6. שורת ביקורת ----------
    const au = await db.prepare(
      "SELECT action FROM audit_log WHERE target_id = ? ORDER BY id DESC LIMIT 1"
    ).get(site.code);
    ok("⚠️ נרשמה שורת ביקורת", au?.action === "site.controller_replaced", `${au?.action}`);

    // ---------- 7. אתר שאינו קיים ----------
    let notFound = null;
    try { await db.prepare("SELECT * FROM public.mark_controller_replaced(?)").get("__nope__"); }
    catch (e) { notFound = e.message; }
    ok("אתר לא קיים נדחה", notFound !== null);
  } finally {
    if (site) {
      for (const t of ["alive", "status_history", "operations"])
        await db.prepare(`DELETE FROM ${t} WHERE site_id = ?`).run(site.id).catch(() => {});
      await db.prepare("DELETE FROM audit_log WHERE target_id = ?").run(site.code).catch(() => {});
      await db.prepare("DELETE FROM events WHERE site_code = ?").run(site.code).catch(() => {});
      await db.prepare("DELETE FROM sites WHERE id = ?").run(site.id).catch(() => {});
    }
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(fail === 0 ? `✅ עברו ${pass}` : `❌ נפלו ${fail} · עברו ${pass}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("check-controller-replace: נפל —", e.message); process.exit(1); });
