// tools/check-watchdog.js — שומר הקליטה מתריע כשצריך, ושותק כשלא.
//
// ============================================================
// ⚠️ למה זה שער ולא בדיקת יחידה
// ============================================================
// השומר חי כפונקציית SQL שמתוזמנת ב-pg_cron, ומפעילה `net.http_post`.
// שלושת החלקים — הפונקציה, התזמון וה-pg_net — קיימים רק במסד, ומוק
// בזיכרון היה בודק בדיוק את מה שלא חשוב.
//
// ============================================================
// ⚠️ מה שנבדק כאן הוא בעיקר **השתיקה**
// ============================================================
// התראה שמצייצת סתם היא גרועה מאין התראה: היא מלמדת להשתיק, ואז גם
// האמיתית מושתקת. שתי מדידות על שבוע נתונים שללו את התכנון הראשון —
// פער p95 לכל אתר הוא 5 עד 40 שעות, ובשבוע היו 5 פערים גלובליים מעל
// 3 שעות. לכן ההתראה נשענת על אותות **ודאיים** בלבד, וזה מה שנאמת.
//
// ⚠️ הכול בטרנזקציה שמתגלגלת אחורה: השער אינו שולח התראות אמיתיות ואינו
// משאיר סימני דה-דופ שישתיקו את ההתראה הבאה בייצור.
const path = require("node:path");

(async () => {
  const db = require("../db/db");
  await db.init();

  const checks = [];
  const add = (name, got, want) => checks.push([name, got, want]);
  const NOW = () => new Date().toISOString();

  // ---- מבנה: קיים ומתוזמן ----
  const job = await db.prepare(
    "SELECT schedule FROM cron.job WHERE jobname = ?"
  ).get("parkomat-ingestion-health").catch(() => null);
  add("השומר מתוזמן", Boolean(job), true);
  add("...כל 10 דקות", job?.schedule, "*/10 * * * *");

  // ⚠️ **בתוך Postgres ולא ב-master.** שומר שיושב בתהליך שהוא בא לשמור
  // עליו מת יחד איתו — בדיוק במצב שבו הוא נחוץ.
  const fs = require("node:fs");
  const masterSrc = fs.readFileSync(path.join(__dirname, "..", "master.js"), "utf8");
  add("⚠️ השומר אינו ב-master", /check_ingestion_health/.test(masterSrc), false);

  // ---- התנהגות, בטרנזקציה שמתגלגלת ----
  const scenario = async (setup) => {
    let rows = [];
    try {
      await db.transaction(async () => {
        await setup();
        rows = await db.prepare("SELECT alerted, detail FROM app.check_ingestion_health(10, 15)").all();
        throw new Error("ROLLBACK");
      });
    } catch (e) { if (e.message !== "ROLLBACK") throw e; }
    return rows.map((r) => r.alerted);
  };

  const setBeat = (minutesAgo) => db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
  ).run("server_heartbeat", new Date(Date.now() - minutesAgo * 60000).toISOString(), NOW());

  // ⚠️ **מנקה גם זריקות אמיתיות שנמצאות בחלון.** בלעדיה מספיקה זריקה
  // אחת בייצור ב-15 הדקות האחרונות כדי שכל תרחיש "אינו מתריע" ייפול
  // בטעות — וגרוע מזה: תרחיש "אובדן אמיתי מתריע" היה **עובר בזכותה**,
  // כלומר נשאר ירוק גם אם gave_up_after_retries היה מושתק בטעות.
  const clearDrops = () => db.prepare("DELETE FROM ingest_drops WHERE at > ?")
    .run(new Date(Date.now() - 15 * 60000).toISOString());

  const clearDedup = () => db.prepare(
    "DELETE FROM settings WHERE key IN (?, ?)"
  ).run("alert_last_heartbeat", "alert_last_drops");

  // 1. ⚠️ אות חיים טרי + אין זריקות → **שקט**. זו הבדיקה החשובה.
  add("⚠️ הכול תקין — שותק", (await scenario(async () => {
    await clearDedup(); await setBeat(1);
    await db.prepare("DELETE FROM ingest_drops WHERE at > ?")
      .run(new Date(Date.now() - 15 * 60000).toISOString());
  })).length, 0);

  // 2. אות חיים בן שעה → מתריע
  add("אות חיים מיושן — מתריע", (await scenario(async () => {
    await clearDedup(); await setBeat(60);
  })).includes("heartbeat_stale"), true);

  // 3. ⚠️ דה-דופ: התראה שנשלחה לפני רגע אינה חוזרת
  add("⚠️ לא מתריע פעמיים באותה שעה", (await scenario(async () => {
    await setBeat(60);
    await db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
    ).run("alert_last_heartbeat", NOW(), NOW());
  })).includes("heartbeat_stale"), false);

  // 4. זריקה בקליטה → מתריע
  add("זריקה בקליטה — מתריע", (await scenario(async () => {
    await clearDedup(); await setBeat(1); await clearDrops();
    await db.prepare(
      "INSERT INTO ingest_drops (at, topic, site_code, kind, reason) VALUES (?, ?, ?, ?, ?)"
    ).run(NOW(), "sites/9999/state", "9999", "state", "state_backfill");
  })).includes("drops"), true);

  // 5. ⚠️ אתר לא רשום **אינו** מתריע — הוא סוכן שצריך לכבות בשטח, לא
  //    תקלה בקליטה. הכללתו הייתה הופכת את ההתראה לרעש קבוע (1416).
  add("⚠️ אתר לא רשום אינו מתריע", (await scenario(async () => {
    await clearDedup(); await setBeat(1); await clearDrops();
    await db.prepare(
      "INSERT INTO ingest_drops (at, topic, site_code, kind, reason) VALUES (?, ?, ?, ?, ?)"
    ).run(NOW(), "sites/9999/state", "9999", "state", "site_not_registered");
  })).includes("drops"), false);

  // ============================================================
  // 5.1 ⚠️ שאר המשפחות השקטות — נמדדו כרעש אמיתי בייצור
  // ============================================================
  // הסינון היה על סיבה **אחת** בלבד, ובפועל ההתראה ירתה כל שעה על
  // מכשירים שאינם שלנו ועל דחיות שהמערכת עשתה נכון. ב-24 שעות:
  // bridge_site_not_registered ×29, no_comm_rejected ×11,
  // unknown_topic ×3 — וכל זה קבר את האות היחיד שחשוב.
  for (const reason of [
    "bridge_site_not_registered",   // מכשיר שאינו שלנו — משימה בשטח
    "unknown_topic",                // topic שבור, אותו דבר
    "no_comm_rejected",             // הקליטה דחתה **נכון** צוואה מאוחרת
    "bridge_disconnect_rejected",   // אותו נימוק
  ]) {
    add(`⚠️ ${reason} אינו מתריע`, (await scenario(async () => {
      await clearDedup(); await setBeat(1); await clearDrops();
      await db.prepare(
        "INSERT INTO ingest_drops (at, topic, site_code, kind, reason) VALUES (?, ?, ?, ?, ?)"
      ).run(NOW(), "sites/9999/state", "9999", "state", reason);
    })).includes("drops"), false);
  }

  // ⚠️ ואובדן אמיתי **כן** מתריע — בלי זה כל הסינון למעלה יכול היה
  // להשתיק גם את מה שהשומר קיים בשבילו.
  add("⚠️ הודעה שאבדה באמת — מתריע", (await scenario(async () => {
    await clearDedup(); await setBeat(1); await clearDrops();
    await db.prepare(
      "INSERT INTO ingest_drops (at, topic, site_code, kind, reason) VALUES (?, ?, ?, ?, ?)"
    ).run(NOW(), "sites/9999/state", "9999", "state", "gave_up_after_retries");
  })).includes("drops"), true);

  // 6. ⚠️ אין אות חיים בכלל → שותק. שרת שטרם נפרס עם התכונה אינו "מת",
  //    והתראה עליו הייתה מצייצת על מערכת תקינה.
  add("⚠️ אין אות חיים כלל — שותק", (await scenario(async () => {
    await clearDedup();
    await db.prepare("DELETE FROM settings WHERE key = ?").run("server_heartbeat");
    await db.prepare("DELETE FROM ingest_drops WHERE at > ?")
      .run(new Date(Date.now() - 15 * 60000).toISOString());
  })).length, 0);

  console.log("בדיקה                                          בפועל       צפוי");
  let bad = 0;
  for (const [n, got, want] of checks) {
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${n.padEnd(44)} ${String(got).padStart(8)} ${String(want).padStart(10)}  ${ok ? "✅" : "❌"}`);
  }
  console.log("");
  console.log(bad ? `❌ ${bad} כשלים` : "✅ השומר מתריע כשצריך ושותק כשלא");
  process.exit(bad ? 1 : 0);
})().catch((err) => {
  console.error("check-watchdog: נפל —", err.message);
  process.exit(1);
});
