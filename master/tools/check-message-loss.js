// check-message-loss.js — למה הודעות מתפספסות. חמישה גלאים בלתי תלויים.
//
// ============================================================
// ⚠️ למה חמישה ולא אחד
// ============================================================
// ingest_drops תופס רק כשלים **שהגיעו לשרת ונכשלו**. הודעה שאבדה ברשת,
// שנבלעה בשומר, או שהסוכן מעולם לא שידר — אינה מופיעה שם. באג ה-"//"
// נמצא רק כי הוא הותיר עקבה; כל השאר היו נעלמים בשקט.
//
// ⚠️ הגלאי החזק כאן הוא **מונה המחזורים**: הוא עולה במונוטוניות בבקר,
// ולכן חור בו הוא הוכחה ישירה לפעולה שאבדה — בלי תלות בשום לוג שלנו.
const db = require("../db/db");

const HOURS = Number(process.env.LOSS_HOURS || 48);
const since = new Date(Date.now() - HOURS * 3600e3).toISOString();
const findings = [];

(async () => {
  const now = new Date();
  console.log(`בדיקת אובדן הודעות · ${HOURS} שעות אחרונות\n`);

  // ---- 1. כשלים מפורשים ----
  console.log("=".repeat(62));
  console.log("1. הודעות שהגיעו ונכשלו (ingest_drops)");
  const drops = await db.prepare(
    "SELECT reason, COUNT(*)::int AS n, MAX(at) AS last, MIN(detail) AS sample " +
    "FROM ingest_drops WHERE at > ? GROUP BY reason ORDER BY n DESC"
  ).all(since);
  if (!drops.length) console.log("   ✅ אין");
  for (const d of drops) {
    console.log(`   ${String(d.n).padStart(4)} × ${d.reason}  · אחרון ${d.last.slice(0,16)}`);
    if (d.sample) console.log(`        ${String(d.sample).slice(0, 70)}`);
    findings.push(`${d.n} כשלי קליטה (${d.reason})`);
  }

  // ---- 2. פעולות יתומות ----
  // ============================================================
  // ⚠️ כאן ישב גלאי "חורים במונה המחזורים", והוא הוסר כי היה שגוי
  // ============================================================
  // ההנחה הייתה שהמונה עולה באחד לכל פעולה, ולכן קפיצה מ-1305 ל-1307
  // פירושה פעולה שאבדה. **זה לא נכון:** המונה הוא מונה חופשי של המכונה
  // שנדגם ברגע ההודעה. נמדד באתר 3513 — start=1304→end=1305 (עלה בתוך
  // הפעולה), ואז start=1306, אבל גם end=1309→start=1309 (לא עלה בכלל).
  // אפס חריגות ואפס מוחלפות באותו טווח.
  //
  // ⚠️ הגלאי דיווח 15 "פעולות אבודות" שכולן תקינות. התראה שקרית היא
  // גרועה מהיעדר התראה, כי היא מלמדת להתעלם גם מהאמיתיות.
  //
  // מה שכן תקף: **start בלי end תואם**. כל פעולה נפתחת ונסגרת, ולכן
  // start שנשאר פתוח כשכבר התחילה פעולה חדשה = הודעת end שלא הגיעה.
  console.log(String.fromCharCode(10) + "=".repeat(62));
  console.log("2. פעולות שנפתחו ולא נסגרו");
  const orphans = await db.prepare(`
    WITH seq AS (
      SELECT o.site_id, o.occurred_at, o.start_end,
             LEAD(o.start_end) OVER (PARTITION BY o.site_id ORDER BY o.occurred_at, o.id) AS nxt,
             LEAD(o.occurred_at) OVER (PARTITION BY o.site_id ORDER BY o.occurred_at, o.id) AS nxt_at
        FROM operations o
       WHERE o.occurred_at > ? AND o.is_anomaly = 0 AND o.superseded_by IS NULL
    )
    SELECT s.code, seq.occurred_at, seq.nxt_at
      FROM seq JOIN sites s ON s.id = seq.site_id
     WHERE seq.start_end = 'start' AND seq.nxt = 'start'
     ORDER BY seq.occurred_at DESC LIMIT 10
  `).all(since);
  if (!orphans.length) console.log("   ✅ אין — כל פעולה שנפתחה נסגרה");
  for (const o of orphans) {
    console.log(`   ⚠️ ${o.code}  ${o.occurred_at.slice(0,16)}  נפתחה, והבאה נפתחה ב-${String(o.nxt_at).slice(0,16)} בלי סגירה`);
    findings.push(`אתר ${o.code}: פעולה בלי end`);
  }
  // ---- 3. מקטעים פתוחים זמן חריג ----
  console.log("\n" + "=".repeat(62));
  console.log("3. מקטעים פתוחים זמן חריג — סימן להודעה שלא הגיעה");
  const open = await db.prepare(`
    SELECT s.code, s.site_name, h.status, h.started_at, s.last_seen
      FROM status_history h JOIN sites s ON s.id = h.site_id
     WHERE h.ended_at IS NULL ORDER BY h.started_at
  `).all();
  for (const o of open) {
    const mins = Math.round((now - new Date(o.started_at)) / 60000);
    const seen = Math.round((now - new Date(o.last_seen)) / 60000);
    // ⚠️ operating ארוך הוא החשוד: ready יכול להימשך לילה שלם בלגיטימיות.
    const bad = (o.status === "operating" && mins > 30) || (o.status !== "no_comm" && seen > 180);
    if (bad) {
      console.log(`   ⚠️ ${o.code}  ${o.status}  פתוח ${Math.floor(mins/60)}ש'${mins%60}ד'  · נראה לפני ${seen} דק'  ${o.site_name}`);
      findings.push(`אתר ${o.code}: ${o.status} פתוח ${Math.floor(mins/60)} שעות`);
    }
  }
  if (!findings.some((f) => f.includes("פתוח"))) console.log("   ✅ אין");

  // ---- 4. פעולה בלי מצב תואם ----
  console.log("\n" + "=".repeat(62));
  console.log("4. ⚠️ פעולות שהגיעו בזמן שהמצב הרשום אינו 'בפעולה'");
  console.log("   כל פעולה מלווה בשינוי מצב. אי-התאמה = הודעת מצב שאבדה.");
  const mism = await db.prepare(`
    SELECT s.code, o.occurred_at, o.start_end,
           (SELECT COALESCE(h.reclassified_to, h.status) FROM status_history h
             WHERE h.site_id = o.site_id AND h.started_at <= o.occurred_at
             ORDER BY h.started_at DESC LIMIT 1) AS state_then
      FROM operations o JOIN sites s ON s.id = o.site_id
     WHERE o.occurred_at > ? AND o.start_end = 'start'
       AND o.is_anomaly = 0 AND o.superseded_by IS NULL
     ORDER BY o.occurred_at DESC
  `).all(since);
  const bad4 = mism.filter((m) => m.state_then && m.state_then !== "operating");
  if (!bad4.length) console.log("   ✅ אין — כל פעולה התחילה כשהמצב 'בפעולה'");
  for (const m of bad4.slice(0, 10)) {
    console.log(`   ⚠️ ${m.code}  ${m.occurred_at.slice(0,16)}  פעולה התחילה והמצב היה '${m.state_then}'`);
  }
  if (bad4.length) findings.push(`${bad4.length} פעולות בלי מצב 'בפעולה' תואם`);

  // ---- 5. אתרים ששותקים ----
  console.log("\n" + "=".repeat(62));
  console.log("5. ⚠️ הגשר מחובר אבל האתר שותק — הסוכן חי ואינו מדווח");
  console.log("   זה האות היחיד שמבדיל בין אתר שקט לאתר מת.");
  const stuck = await db.prepare(
    "SELECT code, site_name, status, last_seen, bridge_seen_at FROM sites " +
    "WHERE bridge_connected = 1 ORDER BY last_seen"
  ).all();
  let flagged = 0;
  for (const b of stuck) {
    const mins = Math.round((now - new Date(b.last_seen)) / 60000);
    // ⚠️ הסף גבוה בכוונה: נמדד שפערי שקט תקינים מגיעים ל-40 שעות. סף
    // נמוך היה מצייץ על מערכות בריאות — כלומר מלמד להתעלם.
    if (mins > 300) {
      flagged++;
      console.log(`   ⚠️ ${b.code}  ${b.status.padEnd(11)} שקט ${Math.floor(mins/60)} שעות · גשר מחובר (${String(b.bridge_seen_at).slice(0,16)})  ${b.site_name}`);
      findings.push(`אתר ${b.code}: גשר מחובר אך שקט ${Math.floor(mins/60)} שעות`);
    }
  }
  if (!stuck.length) console.log("   (טרם התקבל דיווח גשר — יתמלא אחרי הפריסה)");
  else if (!flagged) console.log("   ✅ אין");

  console.log(String.fromCharCode(10) + "=".repeat(62));
  console.log("6. ⚠️ סחיפת שעון — חותם הסוכן מול זמן הקליטה שלנו");
  console.log("   הסוכן חותם כל הודעה בשעון שלו. שעון שסוחף מזיז משכים,");
  console.log("   סדר, ואת שומר ה-backfill — ומעל 300ש' הודעות נדחות.");
  const ev = await db.prepare(
    "SELECT site_code, created_at, payload FROM events " +
    "WHERE created_at > ? AND site_code IS NOT NULL ORDER BY id DESC LIMIT 800"
  ).all(new Date(now - 24 * 3600e3).toISOString());
  const bySite = new Map();
  for (const r of ev) {
    let pl; try { pl = typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload; } catch { continue; }
    if (!pl?.occurredAt) continue;
    const sk = (new Date(r.created_at) - new Date(pl.occurredAt)) / 1000;
    if (!Number.isFinite(sk)) continue;
    if (!bySite.has(r.site_code)) bySite.set(r.site_code, []);
    bySite.get(r.site_code).push(sk);
  }
  const median = (arr) => { const q = [...arr].sort((x, y) => x - y); return q[Math.floor(q.length / 2)]; };
  const perSite = [...bySite.entries()].map(([code, v]) => ({ code, m: median(v), n: v.length }));
  if (!perSite.length) { console.log("   (אין אירועים בטווח)"); }
  else {
    // ⚠️ הבסיס נמדד ולא מונח: הוא כולל רשת, תור וכתיבה. חריגה מזוהה
    // ביחס לחציון של **כל** האתרים, לא מול אפס — אחרת כל המערכת
    // הייתה נראית סוחפת בכל פעם שהעומס עולה.
    const base = median(perSite.map((x) => x.m));
    console.log(`   בסיס המערכת: ${Math.round(base)} שניות`);
    let odd = 0;
    for (const x of perSite.sort((p1, p2) => Math.abs(p2.m - base) - Math.abs(p1.m - base))) {
      const diff = Math.round(x.m - base);
      if (Math.abs(diff) >= 10) {
        odd++;
        console.log(`   ⚠️ ${x.code}  ${diff > 0 ? "+" : ""}${diff} שניות מהבסיס  (חציון ${Math.round(x.m)}ש', ${x.n} אירועים)`);
        findings.push(`אתר ${x.code}: שעון סוטה ב-${diff} שניות`);
      }
    }
    if (!odd) console.log("   ✅ כל האתרים בטווח הבסיס");
  }

  console.log(String.fromCharCode(10) + "=".repeat(62));
  console.log("7. אתרים שלא נשמעו זמן חריג");
  const quiet = await db.prepare(
    "SELECT code, site_name, status, last_seen FROM sites ORDER BY last_seen"
  ).all();
  for (const q of quiet) {
    const mins = Math.round((now - new Date(q.last_seen)) / 60000);
    if (mins > 240) {
      console.log(`   ⚠️ ${q.code}  ${q.status.padEnd(11)} לפני ${Math.floor(mins/60)} שעות  ${q.site_name}`);
      findings.push(`אתר ${q.code}: שותק ${Math.floor(mins/60)} שעות`);
    }
  }
  if (!quiet.some((q) => (now - new Date(q.last_seen)) / 60000 > 240)) console.log("   ✅ כולם נשמעו ב-4 השעות");

  console.log("\n" + "=".repeat(62));
  console.log(findings.length ? `נמצאו ${findings.length} ממצאים` : "✅ לא נמצא אובדן הודעות");
  process.exit(0);
})();
