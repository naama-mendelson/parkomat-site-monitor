// tools/lib/mutation-safety.js — מה שהופך מוטציה על הייצור לבטוחה להחזרה.
//
// ============================================================
// ⚠️ למה זה קיים — שלושה כשלים בכלי המוטציה, כולם שקטים
// ============================================================
// `mutate-direct-drops`, `mutate-beat-recovery` ו-`mutate-direct-events` מחליפים
// פונקציה חיה במוטנט, מריצים שער בתהליך נפרד, ומחזירים. טרנזקציה שמתגלגלת
// חזרה אינה אפשרית שם — השער פותח חיבור משלו ולא היה רואה DDL שלא בוצע commit.
// ולכן כל מה שמגן על הייצור הוא איך שההחזרה נעשית, והיא נעשתה כך:
//
//   1. **"התקין" נלקח מהקובץ, לא מהמסד.** הרצת הכלי **פרסה לייצור** כל מה
//      שהיה בקובץ — גם שינוי שלא נבדק, שלא בוצע commit, ושאיש לא התכוון לפרוס.
//   2. **החזרה בניסיון אחד, בלי אימות.** ניתוק חולף של ה-pooler גם בהחזרה
//      שבלולאה וגם בזו שב-finally השאיר את המוטנט חי — ו-`main()` נדחה בלי
//      טיפול, כך ששום שורה לא אמרה שהייצור מקולקל.
//   3. **הסדר ב-finally** (`direct-events`): זריקה בהחזרת פונקציה אחת דילגה על
//      השנייה.
//
// מכאן שלושה כללים: **(א)** מסרבים לרוץ כשהגוף החי שונה מהקובץ; **(ב)** מחזירים
// את מה שהיה חי (`pg_get_functiondef`), כל פונקציה בנפרד ועם ניסיונות חוזרים;
// **(ג)** מאמתים ב-md5 של `prosrc` שכל אחת חזרה בדיוק, ומדווחים בקול אם לא.

/** הגוף שבין `$fn$` ל-`$fn$` בקטע CREATE FUNCTION מהקובץ. */
function bodyOf(createSql, tag = "$fn$") {
  const a = createSql.indexOf(tag);
  const b = createSql.lastIndexOf(tag);
  if (a < 0 || b <= a) throw new Error(`לא נמצא גוף ${tag} בהגדרה`);
  return createSql.slice(a + tag.length, b);
}

// ⚠️ CRLF מול LF: אותו קובץ יכול להגיע משני מחשבים שונים. ההשוואה היא על
// התוכן, לא על סוף השורה.
const norm = (s) => String(s).replace(/\r\n/g, "\n");

async function liveOf(pool, regprocedure) {
  const r = await pool.query(
    `SELECT p.prosrc, pg_get_functiondef(p.oid) AS def
       FROM pg_proc p WHERE p.oid = $1::regprocedure`, [regprocedure]);
  if (!r.rows[0]) throw new Error(`הפונקציה ${regprocedure} אינה קיימת במסד`);
  return { prosrc: r.rows[0].prosrc, def: r.rows[0].def };
}

/**
 * צילום הפונקציות החיות, אחרי אימות שהן זהות לקובץ.
 * @param targets [{ regprocedure, createSql }]
 */
async function snapshotMatchingFile(pool, targets) {
  const snaps = [];
  for (const t of targets) {
    const live = await liveOf(pool, t.regprocedure);
    if (norm(live.prosrc) !== norm(bodyOf(t.createSql))) {
      throw new Error(
        `\n⛔ ${t.regprocedure} בייצור **שונה** מהקובץ.\n` +
        `   הרצת המוטציות הייתה פורסת את הקובץ לייצור בזמן ההחזרה. מסרב.\n` +
        `   החילו את הקובץ במכוון (או משכו את מה שחי), ואז הריצו שוב.\n`);
    }
    snaps.push({ regprocedure: t.regprocedure, def: live.def, prosrc: live.prosrc });
  }
  return snaps;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * מחזיר כל פונקציה לצילום שלה — כל אחת בנפרד, עד 5 ניסיונות — ומאמת.
 * @returns רשימת כשלים (ריקה = הכול חזר בדיוק).
 */
async function restoreAndVerify(pool, snaps) {
  const failures = [];
  for (const s of snaps) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await pool.query(s.def);
        const live = await liveOf(pool, s.regprocedure);
        if (live.prosrc === s.prosrc) { lastErr = null; break; }
        lastErr = new Error("הגוף החי אינו זהה לצילום אחרי ההחזרה");
      } catch (e) {
        lastErr = e;
      }
      await sleep(250 * attempt);
    }
    if (lastErr) failures.push(`${s.regprocedure}: ${lastErr.message}`);
  }
  return failures;
}

function reportRestore(failures) {
  if (!failures.length) return 0;
  console.log("\n⛔⛔ הייצור נשאר עם מוטנט — ההחזרה נכשלה:");
  for (const f of failures) console.log("   " + f);
  console.log("   החילו את הקובץ ביד מיד (db.init / psql), ובדקו שוב.");
  return failures.length;
}

module.exports = { bodyOf, snapshotMatchingFile, restoreAndVerify, reportRestore };
