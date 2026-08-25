// replay-drops.js — משדר מחדש הודעות שאבדו, מתוך ingest_drops.
//
// ============================================================
// ⚠️ לא כופה — מעביר דרך השומרים הרגילים
// ============================================================
// כל הודעה עוברת ב-applyStateChange, בדיוק כמו הודעה חיה. המשמעות:
//   • הודעה שעדיין רלוונטית (אין אחריה מצב חדש) — תיכתב.
//   • הודעה שההיסטוריה כבר עברה מעליה — **תידחה בשומר ה-backfill**,
//     וזה נכון: הכנסת מקטע לאמצע ציר זמן סגור מחייבת לפצל מקטעים
//     קיימים, כלומר לשכתב היסטוריה. זה גרוע מאובדן, כי אובדן לפחות
//     גלוי.
//
// ⚠️ מה שנדחה **אינו נזרק** — הוא נרשם ב-suppressed_faults, הטבלה
// שנועדה בדיוק לזה: "התקלה קרתה, ואינה נספרת במדדים". כך היא מופיעה
// ביומן ולא משנה זמינות או אחוז כשל.
const db = require("./../db/db");
const { applyStateChange, insertSuppressedFault } = require("../db/queries");

const DRY = !process.argv.includes("--apply");

(async () => {
  const drops = await db.prepare(
    "SELECT id, at, site_code, payload FROM ingest_drops " +
    "WHERE kind = 'state' AND reason = 'gave_up_after_retries' " +
    "ORDER BY site_code, at"
  ).all();

  console.log(`${drops.length} הודעות מצב שאבדו${DRY ? "  (הרצה יבשה — לא נכתב כלום)" : ""}\n`);

  const sites = new Map();
  for (const s of await db.prepare("SELECT id, code, site_name FROM sites").all()) sites.set(s.code, s);

  let written = 0, rejected = 0, logged = 0, skipped = 0;

  for (const d of drops) {
    const site = sites.get(d.site_code);
    if (!site) { console.log(`  ⬜ ${d.site_code} — אתר לא רשום, מדלג`); skipped++; continue; }

    let msg;
    try { msg = JSON.parse(d.payload); } catch { console.log(`  ⬜ ${d.id} — תוכן לא תקין`); skipped++; continue; }
    if (!msg?.state || !msg.timestamp) { skipped++; continue; }

    // חותמת המקור, לא של עכשיו — זו כל הנקודה.
    const occurredAt = new Date(msg.timestamp * 1000).toISOString();
    const label = `${d.site_code} · ${occurredAt} · ${msg.state}`;

    if (DRY) { console.log(`  · ${label}`); continue; }

    try {
      const res = await applyStateChange(site.id, msg.state, occurredAt, msg.fault_text || null);
      if (res?.skipped) {
        rejected++;
        // נדחה בשומר — נרשם לתצוגה בלבד
        try {
          await insertSuppressedFault({
            siteId: site.id, occurredAt,
            faultText: msg.fault_text || "תקלה שאבדה בקליטה ושוחזרה",
            reason: "replay",
          });
          logged++;
          console.log(`  ↩️  ${label} — נדחה (${res.skipped}), נרשם ביומן`);
        } catch (e) {
          console.log(`  ❌ ${label} — נדחה, והרישום ביומן נכשל: ${e.message}`);
        }
      } else {
        written++;
        console.log(`  ✅ ${label} — נכתב להיסטוריה`);
      }
    } catch (e) {
      console.log(`  ❌ ${label} — ${e.message}`);
    }
  }

  console.log("\n" + "=".repeat(56));
  if (DRY) {
    console.log("הרצה יבשה. להחיל בפועל:  node tools/replay-drops.js --apply");
  } else {
    console.log(`  נכתבו להיסטוריה : ${written}`);
    console.log(`  נדחו ונרשמו ביומן: ${logged}`);
    console.log(`  דולגו            : ${skipped}`);
  }
  process.exit(0);
})();
