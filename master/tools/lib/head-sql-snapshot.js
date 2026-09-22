// tools/lib/head-sql-snapshot.js — מה ה-SQL שב-HEAD יוצר, לפי Postgres אמיתי מקומי.
//
//   node tools/lib/head-sql-snapshot.js <קובץ-פלט.json>
//
// ============================================================
// ⚠️ למה תהליך נפרד, ולא פונקציה באותו כלי
// ============================================================
// `local-pg.boot()` דורס את `DATABASE_URL` למסד המקומי **ואז** טוען את
// `db/db.js`. מרגע זה מטמון המודולים של Node מחזיק חיבור למסד המקומי,
// ו-`require` נוסף — גם אחרי החזרת המשתנה — מחזיר את אותו מופע.
//
// ⚠️ **נמדד ב-22/09/2026:** `apply-sql.js` צילם את HEAD ואז ניסה להחיל על
// הייצור. ההחלה הלכה למסד המקומי שכבר נסגר, הכלי נפל על
// "Called end on pool more than once" — והייצור **לא השתנה בכלל**, בזמן
// שהכלי דיווח שהוא מחיל. כלי שמדווח על כתיבה שלא קרתה גרוע מכלי שנופל.
//
// תהליך נפרד הוא הגבול היחיד שמטמון מודולים אינו חוצה.
const fs = require("node:fs");
const path = require("node:path");

const OUT = process.argv[2];
if (!OUT) { console.error("שימוש: head-sql-snapshot.js <קובץ-פלט.json>"); process.exit(2); }

// ⚠️ מנקים את המשתנה כדי ששום דבר כאן לא יוכל להגיע לייצור בטעות.
delete process.env.DATABASE_URL;

const { FN_SQL, POL_SQL, CRON_SQL } = require("./sql-shape");

(async () => {
  const local = await require(path.join(__dirname, "..", "..", "tests", "helpers", "local-pg.js")).boot();
  try {
    const snap = {
      fns: (await local.pg.query(FN_SQL)).rows,
      pols: (await local.pg.query(POL_SQL)).rows,
      cron: (await local.pg.query(CRON_SQL)).rows,
    };
    fs.writeFileSync(OUT, JSON.stringify(snap));
  } finally { await local.close(); }
  process.exit(0);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
