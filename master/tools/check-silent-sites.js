// check-silent-sites — אתר בודד שמנותק שעות, ומי שמבחין בכך.
//
// ============================================================
// ⚠️ למה השער הזה קיים: 510 שעות שאיש לא ידע עליהן
// ============================================================
// `app.detect_blackout` בודק `MAX(received_at)` על **כל** האתרים יחד, כלומר
// הוא עונה על "האם המערכת חשוכה". אתר אחד שנפל בזמן שהשאר מדווחים עובר
// מתחת לו — וזה קרה:
//
//     3452  18/08 07:50 → 27/08 12:00   220.2 שעות   ואיש לא ידע
//     2439                               88.9
//     2438                               71.0 ו-68.2
//     1376                               29.8
//     1284                               24.2
//     1348                                7.5
//
// שישה אתרים, 510 שעות של השבתה, **אפס התראות**.
//
// ============================================================
// ⚠️ והאות אינו שקט — זה ההבדל שכל התכנון תלוי בו
// ============================================================
// שקט נפסל כאות במדידה: הסוכן משדר על שינוי בלבד, ולכן פערים של 61–68 שעות
// בין הודעות הם שגרה בחניון שקט. סף שלא מצפצף עליהם ארוך מהנפילות שאנו
// מנסים לתפוס.
//
// לכן האות הוא **הודעה שהתקבלה**: הצוואה של הגשר פותחת מקטע `no_comm` תוך
// 90 שניות, והשאלה היחידה היא כמה זמן הוא נשאר פתוח. חניון שקט אינו מייצר
// מקטע כזה כלל.
//
//   node --env-file=.env tools/check-silent-sites.js
const db = require("../db/db");

let failures = 0;
const results = [];

function check(label, ok, detail = "") {
  results.push({ label, ok, detail });
  if (!ok) failures++;
}

// ⚠️ **הזרעה בתוך טרנזקציה שמתגלגלת אחורה** — אותה תבנית כמו check-writes.
// השער רץ מול הייצור, ומקטע `no_comm` מזויף שנשאר בטבלה הוא בדיוק התקלה
// שהשער בא לצוד: הוא היה מוצג בדשבורד כאתר מנותק, ומזייף את הזמינות.
async function inRolledBackTx(fn) {
  return db.transaction(async () => {
    const out = await fn();
    // הזריקה היא מה שמגלגל אחורה; היא נתפסת בחוץ.
    const err = new Error("__rollback__");
    err.payload = out;
    throw err;
  }).catch((e) => {
    if (e.message === "__rollback__") return e.payload;
    throw e;
  });
}

const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, ".000Z");

(async () => {
  // ============================================================
  // 1. הסף — נבדק על ההיסטוריה האמיתית, בלי לכתוב דבר
  // ============================================================
  // ⚠️ זה אפשרי רק כי `detect_silent_sites` מקבל `p_at` ובוחן **חפיפה**
  // ולא `ended_at IS NULL`. הגרסה הראשונה שאלה "פתוח עכשיו?", ולכן החזירה
  // כלום על כל תאריך היסטורי — כלומר לא היה אפשר להוכיח שהיא תופסת את
  // המקרה שבגללו היא נכתבה. גלאי שאי אפשר להריץ על העבר הוא גלאי שאיש
  // אינו יודע מה הוא תופס.
  const at = (t) => db.prepare(
    "SELECT site_code, quiet_hours FROM app.detect_silent_sites(6, ?::timestamptz)"
  ).all(t);

  const before = await at("2026-08-18T10:00:00Z");   // 2.2 שעות לתוך הניתוק
  const after = await at("2026-08-18T14:00:00Z");    // 6.2 שעות
  const during = await at("2026-08-25T00:00:00Z");   // 160 שעות
  const recovered = await at("2026-08-27T13:00:00Z"); // אחרי שחזר

  check("מתחת לסף — שותק", before.every((r) => r.site_code !== "3452"),
    JSON.stringify(before));
  check("6.2 שעות — מתריע על 3452", after.some((r) => r.site_code === "3452"),
    JSON.stringify(after));
  check("עדיין מתריע כל עוד פתוח", during.some((r) => r.site_code === "3452"));
  check("שותק ברגע שהאתר חזר", recovered.every((r) => r.site_code !== "3452"),
    JSON.stringify(recovered));

  // ============================================================
  // 2. מה שאסור להתריע עליו — ואין לזה דוגמה בייצור
  // ============================================================
  // ⚠️ שלושת המקרים כאן אינם קיימים בנתונים האמיתיים, ולכן בדיקה שנשענת
  // על ההיסטוריה בלבד הייתה **עיוורת** להם ועוברת. זה בדיוק הלקח של
  // `site_globals`: ארבע מוטציות רצו מול הייצור ורק אחת נתפסה, לא כי
  // ה-SQL היה נכון אלא כי לנתונים אין מקרים כאלה.
  const seeded = await inRolledBackTx(async () => {
    const site = await db.prepare(
      "SELECT id, code FROM sites ORDER BY id LIMIT 1").get();
    const long = iso(Date.now() - 30 * 3600 * 1000);   // 30 שעות אחורה
    const out = {};

    const seed = async (status, extra) => {
      await db.prepare(
        `INSERT INTO status_history (site_id, status, started_at, ended_at,
           excluded_at, reclassified_to)
         VALUES (?, 'no_comm', ?, NULL, ?, ?)`
      ).run(site.id, long, extra.excluded ?? null, extra.reclass ?? null);
    };

    const found = async () => (await db.prepare(
      "SELECT site_code FROM app.detect_silent_sites(6)").all())
      .filter((r) => r.site_code === site.code).length;

    out.code = site.code;
    out.baseline = await found();

    await seed("no_comm", {});
    out.plain = await found();

    await db.prepare("DELETE FROM status_history WHERE site_id = ? AND started_at = ?")
      .run(site.id, long);

    await seed("no_comm", { excluded: long });
    out.excluded = await found();

    await db.prepare("DELETE FROM status_history WHERE site_id = ? AND started_at = ?")
      .run(site.id, long);

    await seed("no_comm", { reclass: "maintenance" });
    out.reclassified = await found();

    return out;
  });

  check("מקטע פתוח בן 30 שעות — מתריע",
    seeded.plain > seeded.baseline,
    `baseline=${seeded.baseline} plain=${seeded.plain}`);

  // ⚠️ `excluded_at` אומר "אל תספור את זה" בכל שאר המערכת. גלאי שמתריע
  // על מקטע מסומן שולח מישהו לנסוע לאתר בגלל רשומה שמישהו כבר ביטל.
  check("מקטע שסומן כניסוי — אינו מתריע",
    seeded.excluded === seeded.baseline,
    `excluded=${seeded.excluded}`);

  // ⚠️ תקלה שסווגה מחדש כתחזוקה אינה ניתוק. זה אותו כלל
  // (`COALESCE(reclassified_to, status)`) ש-check-effective-status אוכף
  // על כל שאר הקוראים, ואחת-עשרה שאילתות פספסו אותו בפעם הקודמת.
  check("מקטע שסווג מחדש כתחזוקה — אינו מתריע",
    seeded.reclassified === seeded.baseline,
    `reclassified=${seeded.reclassified}`);

  // ============================================================
  // 3. השער לא השאיר שריד
  // ============================================================
  // ⚠️ הטענה החשובה ביותר בקובץ. מקטע `no_comm` פתוח שנשאר בייצור מוצג
  // בדשבורד כאתר מנותק ומזייף את הזמינות — כלומר שער שנכשל בניקוי מייצר
  // בדיוק את התקלה שהוא צד.
  const residue = await db.prepare(
    `SELECT COUNT(*)::int n FROM status_history
      WHERE status = 'no_comm' AND ended_at IS NULL
        AND started_at > ?`).get(iso(Date.now() - 36 * 3600 * 1000));

  check("לא נשאר מקטע no_comm פתוח מהשער", residue.n === 0,
    `${residue.n} מקטעים פתוחים ב-36 השעות האחרונות`);

  // ============================================================
  console.log("=".repeat(64));
  for (const r of results) {
    console.log(`  ${r.ok ? "✅" : "❌"} ${r.label}${r.detail ? "   " + r.detail : ""}`);
  }
  console.log("=".repeat(64));
  if (failures) {
    console.log(`❌ ${failures} בדיקות נכשלו`);
    process.exit(1);
  }
  console.log("✅ אתר שמנותק שעות מייצר התראה, ומקטע מסומן לא");
})()
  .catch((e) => { console.error("❌ " + e.message); process.exit(1); })
  .finally(() => { if (db.close) db.close(); });
