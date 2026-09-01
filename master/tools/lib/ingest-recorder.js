// tools/lib/ingest-recorder.js — מריץ הודעות קליטה ומצלם בדיוק מה הן הותירו.
//
// ============================================================
// ⚠️ למה זה קיים, ולמה זה חייב להיות מדויק
// ============================================================
// זהו צד הייחוס של שער ההשוואה לקליטה. הקליטה היא **הקוד היחיד במערכת
// שנוגע בנתוני לקוחות בכתיבה**, ו-1,872 שורות שלה נולדו מכשלים שנמדדו
// בייצור. פורט שלה ל-SQL בלי השוואה מדויקת הוא כתיבה מחדש על עיוור.
//
// ============================================================
// ⚠️ למה בייצור, ולמה זה בטוח
// ============================================================
// `.env.test` אינו קיים — מסד הבדיקות שהתיעוד מניח איננו. שתי הגנות
// מחליפות אותו, ושתיהן כבר בשימוש ב-check-writes וב-check-agent-identity:
//
//   1. **הכול בטרנזקציה שמתבטלת.** `db.transaction` מצטרפת לטרנזקציה
//      קיימת ואינה פותחת חדשה (db.js), ולכן גם הטרנזקציות הפנימיות של
//      handleOperation ו-handleState נבלעות בה ומתגלגלות איתה.
//
//   2. **אתר סינתטי.** ⚠️ וזו ההגנה שאין לה תחליף: `applyStateChange`
//      עושה `SELECT ... FOR UPDATE` על שורת האתר. הרצה על אתר אמיתי
//      הייתה נועלת אותו לכל אורך ההשוואה, והקליטה החיה של אותו אתר
//      הייתה ממתינה מאחור. אתר משלנו נוגע רק בעצמו.
const db = require("../../db/db");
const { handleMessage } = require("../../ingestion/dispatcher");

// ⚠️ קידומת שמתאימה לתבנית ש-check-no-residue סורק, כדי ששארית — אם
// אי-פעם תיווצר — תיתפס ולא תשב בייצור בשקט.
const PREFIX = "wcheck";

/** יוצר אתר סינתטי בתוך הטרנזקציה הנוכחית. */
async function makeSite({ isNewSite = 1 } = {}) {
  const code = `${PREFIX}${Date.now()}${Math.floor(Math.random() * 900 + 100)}`;
  await db.prepare(
    "INSERT INTO sites (code, site_name, status, registered_at, is_new_site) " +
    "VALUES (?, ?, 'ready', ?, ?)"
  ).run(code, `בדיקת קליטה ${code}`, new Date(Date.now() - 86400000).toISOString(), isNewSite);
  return await db.prepare("SELECT * FROM sites WHERE code = ?").get(code);
}

// ============================================================
// ⚠️ הצילום משמיט מזהים וזמני-קבלה — ובכוונה
// ============================================================
// `id` הוא רצף, ו-`received_at` הוא "עכשיו של השרת". שניהם שונים בין
// הרצה להרצה ובין שני מימושים, ואינם אומרים דבר על **נכונות**. השוואה
// שכוללת אותם נכשלת תמיד, ואז מפסיקים להריץ אותה.
//
// ⚠️ מה שכן נשמר במלואו: `occurred_at`, `reported_at`, `is_anomaly`,
// הכרטיס, המונה, וכל שורת זריקה עם הסיבה שלה. אלה **ההחלטות** של
// הקליטה, וכל אחת מהן היא כלל שנולד מכשל.
async function snapshot(siteId) {
  const ops = await db.prepare(
    "SELECT start_end, entry_exit, card_number, state, is_anomaly, occurred_at, " +
    "reported_at, cycle_counter, superseded_by IS NOT NULL AS superseded " +
    "FROM operations WHERE site_id = ? ORDER BY occurred_at, start_end, entry_exit"
  ).all(siteId).catch(async () => {
    // ⚠️ נפילה חזרה בלי superseded_by: העמודה עשויה שלא להתקיים בכל מופע,
    // ושער שנופל על סכימה במקום על נכונות מלמד להתעלם ממנו.
    return await db.prepare(
      "SELECT start_end, entry_exit, card_number, state, is_anomaly, occurred_at, " +
      "reported_at, cycle_counter FROM operations WHERE site_id = ? " +
      "ORDER BY occurred_at, start_end, entry_exit"
    ).all(siteId);
  });

  const segs = await db.prepare(
    "SELECT status, started_at, ended_at, fault_text FROM status_history " +
    "WHERE site_id = ? ORDER BY started_at, status"
  ).all(siteId);

  const site = await db.prepare(
    "SELECT status, last_seen, cycle_total, plc_cycle_last, cycle_last_ts FROM sites WHERE id = ?"
  ).get(siteId);

  const drops = await db.prepare(
    "SELECT reason, kind, site_code FROM ingest_drops WHERE site_code = " +
    "(SELECT code FROM sites WHERE id = ?) ORDER BY at, reason"
  ).all(siteId);

  return { ops, segs, site, drops };
}

// ============================================================
// ⚠️ SAVEPOINT לכל הודעה — וזה לא ניקיון, זו נכונות
// ============================================================
// **נתפס בהרצה הראשונה של המקליט הזה.** מסירה חוזרת של QoS-1 מייצרת
// UNIQUE violation; `insertOperation` תופס אותה ומחזיר `inserted:false`,
// וההודעה נבלעת כראוי. אבל ב-Postgres שגיאה בתוך טרנזקציה **מבטלת את
// כולה** — כל פקודה נוספת נופלת על `current transaction is aborted`.
//
// בייצור זה תקין ומתועד (operation-handler.js:112-121): לכל הודעה יש
// טרנזקציה משלה, וה-COMMIT על טרנזקציה מבוטלת מתנהג כ-ROLLBACK. אבל כאן
// כל ההודעות חולקות טרנזקציה אחת, ולכן הכפילות הרגה את כל ההרצה — כלומר
// **המקליט לא היה יכול להזין אפילו רצף שגרתי אחד**.
//
// SAVEPOINT מחזיר את הסמנטיקה של ייצור: כל הודעה עצמאית, וכישלון שלה
// מגלגל לאחור רק אותה. אותו קומנטר בקוד הקליטה כבר אמר שזה מה שנדרש.
//
// ⚠️ והבדיקה היא `SELECT 1` ולא `try/catch`: השגיאה נבלעת **בתוך**
// handleMessage ואינה מגיעה לכאן. הדרך היחידה לדעת שהטרנזקציה מתה היא
// לשאול אותה.
async function runOne(site, m) {
  const sp = `sp_ingest_${Math.random().toString(36).slice(2, 10)}`;
  await db.prepare(`SAVEPOINT ${sp}`).run();

  try {
    await handleMessage(`sites/${site.code}/${m.kind}`, Buffer.from(JSON.stringify(m.payload)));
  } catch {
    // כשל שכן הגיע לכאן — מגלגלים רק את ההודעה הזו.
  }

  try {
    await db.prepare("SELECT 1 AS ok").get();
    await db.prepare(`RELEASE SAVEPOINT ${sp}`).run();
  } catch {
    await db.prepare(`ROLLBACK TO SAVEPOINT ${sp}`).run();
    await db.prepare(`RELEASE SAVEPOINT ${sp}`).run();
  }
}

/**
 * מזין רצף הודעות דרך המסלול הקיים ומחזיר צילום.
 * ⚠️ נקרא **בתוך** טרנזקציה שהקורא פותח ומגלגל לאחור.
 */
async function runJs(site, messages) {
  for (const m of messages) await runOne(site, m);
  return await snapshot(site.id);
}

module.exports = { makeSite, snapshot, runJs, PREFIX };
