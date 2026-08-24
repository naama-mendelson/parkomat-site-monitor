// tools/check-drops.js — הודעה שנזרקת משאירה עקבות ששורדות restart.
//
// ============================================================
// ⚠️ למה זה שער, ולא בדיקת יחידה
// ============================================================
// זה נבנה אחרי אובדן אמיתי: אתר היה בתקלה שלוש שעות והמסך הראה "בפעולה".
// הסוכן שידר, HiveMQ אישר ב-`PUBACK RC:0`, וההודעה נעלמה אצלנו — וכשחיפשנו
// את ה"למה", הקונטיינר כבר נוצר מחדש והלוג נמחק איתו.
//
// הבדיקה חייבת לרוץ **מול המסד האמיתי**: כל התועלת של הטבלה היא שהיא
// שורדת את התהליך, ומוק בזיכרון בודק בדיוק את מה שלא חשוב.
const path = require("node:path");

(async () => {
  const db = require("../db/db");
  await db.init();
  const { recordIngestDrop } = require("../db/queries");

  const checks = [];
  const add = (name, got, want) => checks.push([name, got, want]);

  // ⚠️ topic ייחודי לריצה: השער מריץ פעמיים באותה דקה בזמן פיתוח, וזיכרון
  // ה-dedup היה בולע את הקריאה השנייה ומכשיל את השער על עצמו.
  const TOPIC = `sites/__dropcheck${process.pid}/state`;
  const PAYLOAD = JSON.stringify({ timestamp: 1787481855, state: "error" });

  try {
    // ---- 1. הרישום נכתב, עם המטען המלא ----
    await recordIngestDrop({
      topic: TOPIC, siteCode: "__drop", kind: "state",
      reason: "state_late_vs_open_segment",
      detail: "occurredAt=X < openStartedAt=Y", payload: PAYLOAD,
    });

    const row = await db.prepare(
      "SELECT reason, detail, payload, site_code, kind FROM ingest_drops WHERE topic = ? ORDER BY id DESC LIMIT 1"
    ).get(TOPIC);

    add("הזריקה נרשמה", Boolean(row), true);
    add("...עם הסיבה", row?.reason, "state_late_vs_open_segment");
    // ⚠️ המטען הוא כל התועלת: בלעדיו יש "משהו נזרק" ואי אפשר להשוות למה
    // שהסוכן חושב ששלח, ואי אפשר לשדר מחדש ביד.
    add("⚠️ ...ועם המטען המלא", row?.payload, PAYLOAD);
    add("...ועם קוד האתר", row?.site_code, "__drop");

    // ---- 2. ⚠️ הגנת ההצפה ----
    // אתר לא רשום שמשדר כל שנייה היה מייצר אלפי שורות ביום. אותה
    // (topic, reason) בתוך דקה נבלעת.
    await recordIngestDrop({ topic: TOPIC, siteCode: "__drop", kind: "state",
                             reason: "state_late_vs_open_segment", payload: PAYLOAD });
    const dup = await db.prepare(
      "SELECT COUNT(*)::int AS n FROM ingest_drops WHERE topic = ? AND reason = ?"
    ).get(TOPIC, "state_late_vs_open_segment");
    add("⚠️ חזרה בתוך דקה נבלעת", dup.n, 1);

    // ---- 3. סיבה אחרת על אותו topic **כן** נרשמת ----
    // ⚠️ ההבחנה הזו חיונית: אתר שזורק גם על שעון וגם על גארד הוא מקרה
    // שונה לגמרי מאתר שזורק על אותה סיבה שוב ושוב.
    await recordIngestDrop({ topic: TOPIC, siteCode: "__drop", kind: "state",
                             reason: "timestamp_rejected", payload: PAYLOAD });
    const other = await db.prepare(
      "SELECT COUNT(*)::int AS n FROM ingest_drops WHERE topic = ? AND reason = ?"
    ).get(TOPIC, "timestamp_rejected");
    add("סיבה אחרת נרשמת בנפרד", other.n, 1);

    // ---- 4. ⚠️ כשל ברישום אינו זורק ----
    // אם הרישום היה זורק, הודעה הייתה נאבדת בגלל הכשל ברישום של הודעה
    // שנאבדה. זה בדיוק האבסורד שהטבלה נועדה למנוע.
    let threw = false;
    try {
      await recordIngestDrop({ topic: `${TOPIC}/x`, reason: "x".repeat(300),
                               detail: "y".repeat(9000), payload: "z".repeat(90000) });
    } catch { threw = true; }
    add("⚠️ רישום חריג אינו זורק", threw, false);

    // ---- 5. הפריקה קיימת ומתוזמנת ----
    const job = await db.prepare(
      "SELECT COUNT(*)::int AS n FROM cron.job WHERE jobname = ?"
    ).get("parkomat-prune-ingest-drops").catch(() => ({ n: 0 }));
    add("⚠️ הגריפה מתוזמנת (אחרת הטבלה גדלה לנצח)", job.n, 1);
  } finally {
    await db.prepare("DELETE FROM ingest_drops WHERE topic LIKE ?").run(`sites/__dropcheck${process.pid}/%`);
  }

  console.log("בדיקה                                             בפועל          צפוי");
  let bad = 0;
  for (const [n, got, want] of checks) {
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${n.padEnd(46)} ${String(got).slice(0, 14).padStart(14)} ${String(want).slice(0, 14).padStart(14)}  ${ok ? "✅" : "❌"}`);
  }
  console.log("");
  console.log(bad ? `❌ ${bad} כשלים` : "✅ זריקות נרשמות ושורדות");
  process.exit(bad ? 1 : 0);
})().catch((err) => {
  console.error("check-drops: נפל —", err.message);
  process.exit(1);
});
