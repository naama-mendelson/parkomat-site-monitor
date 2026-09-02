// tools/check-edge-grants.js — כל טבלה ש-Edge Function נוגעת בה מוענקת לה,
// וכל קריאת מסד שלה בודקת שגיאה.
//
// ============================================================
// ⚠️ הכשל שזה סוגר — והוא היה חי בייצור בשתי הפונקציות
// ============================================================
// נמדד על כל 20 הטבלאות ב-`public`: לכולן היה בדיוק
// `REFERENCES, TRIGGER, TRUNCATE` — השארית שנגזרת מבעלות, ולא גישה
// לנתונים. **המפתח הסודי לא יכול היה לקרוא שורה אחת דרך PostgREST.**
//
// הסיבה אינה החלטה: הטבלאות נוצרות ע"י `db.init()` שלנו ולא דרך לוח
// הבקרה של Supabase, ולכן ברירות המחדל של הפרויקט (`GRANT ALL … TO
// service_role`) מעולם לא חלו עליהן. אף אחד לא כתב את הכלל הזה — הוא
// פשוט נשאר.
//
// **שני הנפגעים נכשלו אחרת, ושניהם בשקט:**
//
//   invite-user  — עדכון הדרגה חזר 42501, השגיאה לא נבדקה, והקריאה
//                  החזירה **200** עם גוף שמכריז `role: "manager"`.
//                  המוזמן קיבל 403 בכל פעולת ניהול, בלי שום הסבר.
//
//   notify-fault — ההתראה עצמה נשלחה (פונקציות מקבלות EXECUTE כברירת
//                  מחדל), אבל החלון מ-`settings` התעלם ו-`push_last_sent`
//                  לא נקרא ולא נכתב. כלומר **מניעת ההצפה לא התקיימה**.
//                  התסמין הוא ההפך משתיקה, ולכן איש לא היה מייחס אותו
//                  לשגיאת הרשאה.
//
// ============================================================
// ⚠️ ולמה **שני** החצאים, ולא רק ההענקה
// ============================================================
// הענקה חסרה בלי בדיקת שגיאה = כשל בלתי נראה. בדיקת שגיאה בלי הענקה =
// כשל רועש שמתקנים ביום. **בדיקת השגיאה היא מה שהופך את הבאג הבא לניתן
// לגילוי**, ולכן היא נאכפת כאן בפני עצמה — גם על טבלה שכן מוענקת.
//
// ============================================================
// ⚠️ ומה שהשער **אינו** עושה: הוא אינו מאשר הענקה גורפת
// ============================================================
// `GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role` היה מספק
// את החצי הראשון ומוחק את התשובה לשאלה "מי כותב לטבלה הזו". לכן השער
// אוכף גם את הכיוון ההפוך: **כל** טבלה שאף Edge Function אינה נוגעת בה
// חייבת להישאר סגורה בפני service_role.
const fs = require("node:fs");
const path = require("node:path");
const db = require("../db/db");

const FUNCS = path.resolve(__dirname, "../../supabase/functions");

// שיטת הקריאה → ההרשאה שהיא דורשת. בלי אף אחת מהן זו קריאה (GET).
const VERBS = [
  [".insert(", ["INSERT"]],
  [".upsert(", ["INSERT", "UPDATE"]],
  [".update(", ["UPDATE"]],
  [".delete(", ["DELETE"]],
  [".select(", ["SELECT"]],
];

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
};

/**
 * פירוק לפי `;`.
 *
 * ⚠️ היוריסטיקה, ובמפורש: אלה קבצים קטנים שבהם אין `;` בתוך מחרוזת או
 * בתוך אובייקט. אם זה ישתנה, השער ידווח על משהו שנראה שגוי — וזו התוצאה
 * הנכונה, כי פירוק שנשבר בשקט גרוע מפירוק שמתלונן.
 */
const statements = (src) => src.split(";");

(async () => {
  console.log("=== check-edge-grants ===\n");

  if (!fs.existsSync(FUNCS)) {
    console.log("⚠️  אין תיקיית Edge Functions — השער לא רץ.");
    process.exit(2);
  }
  await db.init();

  const dirs = fs.readdirSync(FUNCS)
    .filter((d) => fs.existsSync(path.join(FUNCS, d, "index.ts")));
  ok("נמצאו Edge Functions", dirs.length > 0, `${dirs.length}`);

  // טבלה → קבוצת הרשאות שנדרשות ממנה, על פני כל הפונקציות.
  const needed = new Map();

  console.log("\n── מה כל פונקציה נוגעת בו, ומי בודק שגיאה ──");
  for (const d of dirs) {
    const src = fs.readFileSync(path.join(FUNCS, d, "index.ts"), "utf8");

    for (const st of statements(src)) {
      const isCall = /await\s+[\w.]+\.(from|rpc)\s*\(/.test(st);
      if (!isCall) continue;

      // ⚠️ החצי השני: קריאה שאינה קושרת `error` בולעת כל כשל.
      //
      // ⚠️ והדרישה היא **פירוק** ולא הופעת המילה: `/\berror\b/` על כל
      // הקטע היה עובר על הערה שמזכירה "error" מעל קריאה שאינה בודקת
      // דבר — כלומר בדיקה שמאשרת את עצמה מתוך התיעוד שלה.
      const named = (st.match(/\.(from|rpc)\s*\(\s*"([a-z_]+)"/) || [])[2] || "(לא ידוע)";
      ok(`${d}: ${named} — השגיאה נבדקת`, /\{[^{}]*\berror\b[^{}]*\}\s*=/.test(st));

      const tbl = (st.match(/\.from\s*\(\s*"([a-z_]+)"\s*\)/) || [])[1];
      if (!tbl) continue; // rpc — הרשאת EXECUTE, ולפונקציות יש ברירת מחדל

      const chain = st.slice(st.indexOf(`.from("${tbl}")`));
      const verbs = VERBS.filter(([m]) => chain.includes(m)).flatMap(([, v]) => v);
      const set = needed.get(tbl) ?? new Set();
      for (const v of (verbs.length ? verbs : ["SELECT"])) set.add(v);
      needed.set(tbl, set);
    }
  }

  ok("⚠️ נמצאו קריאות מסד בכלל", needed.size > 0,
    "אפס — סימן שהפירוק נשבר, לא שאין קריאות");

  // ============================================================
  // החצי החי — מה המסד באמת מעניק
  // ============================================================
  // ⚠️ **ומה שהחצי הזה אינו מוכיח, בכנות.** `db.init()` למעלה מחיל את
  // `security.postgres.sql`, כלומר את ההענקות עצמן. לכן טבלה שכתובה
  // בקובץ **תמיד** תימצא מוענקת כאן — השער ריפא אותה שנייה קודם.
  //
  // מה שהוא כן מוכיח, וזה מה שנשבר בפועל:
  //   • טבלה שפונקציה נוגעת בה **ואינה בקובץ** — נשארת בלי הרשאה ונופלת.
  //   • הענקה שהקובץ מנסה ומדלגת (הטבלה אינה קיימת) — נופלת כאן בזמן
  //     שהחצי של הקובץ עובר, וזה בדיוק ההפרש שמפריד ביניהם.
  //
  // כלומר הטענה היא "**הקובץ שלם ומוחל**", ולא "הייצור מוענק ברגע זה".
  // מאחר ש-`db.init()` רץ בכל עליית master, השנייה נובעת מהראשונה בפריסה
  // הבאה — אבל לא לפניה.
  const rows = await db.prepare(`
    SELECT table_name, privilege_type
      FROM information_schema.role_table_grants
     WHERE grantee = 'service_role' AND table_schema = 'public'`).all();

  const granted = new Map();
  for (const r of rows) {
    if (!granted.has(r.table_name)) granted.set(r.table_name, new Set());
    granted.get(r.table_name).add(r.privilege_type);
  }

  console.log("\n── ההרשאות במסד ──");
  for (const [tbl, verbs] of [...needed].sort()) {
    const have = granted.get(tbl) ?? new Set();
    const missing = [...verbs].filter((v) => !have.has(v));
    ok(`${tbl} — ${[...verbs].sort().join(", ")}`, missing.length === 0,
      `חסר: ${missing.join(", ")}`);
  }

  // ============================================================
  // ⚠️ הכלל ההפוך: **כל** טבלה שאינה נדרשת חייבת להיות סגורה
  // ============================================================
  // הגרסה הראשונה החזיקה רשימה קבועה של חמש טבלאות "רגישות". זו הייתה
  // בדיקה חלשה מכפי שנראתה: טבלה חדשה — או אחת שלא חשבתי עליה — הייתה
  // נפתחת ל-service_role בלי שאיש יידע, כי היא פשוט לא ברשימה.
  //
  // הניסוח הנכון הוא ההפוך: מה ש-Edge Function מוכיחה שהיא צריכה מוענק,
  // וכל השאר סגור. זה מתחזק את עצמו — טבלה חדשה מוגנת ביום שהיא נוצרת.
  const DATA_VERBS = ["SELECT", "INSERT", "UPDATE", "DELETE"];
  const allTables = await db.prepare(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1").all();

  console.log("\n── וכל טבלה אחרת סגורה ──");
  const opened = [];
  for (const { tablename } of allTables) {
    if (needed.has(tablename)) continue;
    const have = granted.get(tablename) ?? new Set();
    const open = DATA_VERBS.filter((v) => have.has(v));
    if (open.length) opened.push(`${tablename} (${open.join(", ")})`);
  }
  ok(`⚠️ אף טבלה מיותרת אינה פתוחה ל-service_role (${allTables.length - needed.size} נבדקו)`,
    opened.length === 0, `נפתחו: ${opened.join(" · ")} — הענקה גורפת?`);

  // ⚠️ ומינימום הרשאות על מה שכן מוענק. נמדד ש-`SELECT` על `app_users`
  // **נחוץ** לעדכון (הפילטר `WHERE supabase_uid = …` קורא את העמודה),
  // ולכן הבדיקה היא על הפעלים שמעבר לנדרש ולא על שוויון עיוור.
  for (const [tbl, verbs] of [...needed].sort()) {
    const extra = DATA_VERBS.filter((v) => (granted.get(tbl) ?? new Set()).has(v) && !verbs.has(v));
    // SELECT מותר תמיד: PostgREST זקוק לו לכל פילטר, גם בעדכון ובמחיקה.
    const real = extra.filter((v) => v !== "SELECT");
    ok(`⚠️ ${tbl} — בלי הרשאות מעבר לנדרש`, real.length === 0, `עודף: ${real.join(", ")}`);
  }

  // ⚠️ ההענקה חייבת להיות **בקובץ**, לא רק במסד. הענקה שהוחלה ביד חיה
  // עד ההקמה הבאה של המסד, ואינה נוסעת ב-pg_dump אל Postgres אחר —
  // כלומר בדיוק הדבר שכלל דלת היציאה בא למנוע.
  const sql = fs.readFileSync(path.resolve(__dirname, "../db/security.postgres.sql"), "utf8");

  // ⚠️ **נבדק בתוך הבלוק, ולא בביטוי `GRANT … ON <טבלה>`.** הגרסה
  // הראשונה חיפשה את הצורה המילולית, ונפלה על ארבע הטבלאות ברגע
  // שההענקות הפכו ללולאה עם `format()` — שינוי שנעשה מסיבה טובה (טבלה
  // שאינה קיימת הייתה מפילה את עליית השרת). כלומר בדיקה שנצמדת לניסוח
  // ולא לתוכן מייצרת אדום על תיקון נכון, וזה בדיוק סוג האדום שמלמד
  // אנשים לעקוף שער.
  //
  // ⚠️ **ומסתיים ב-`\n$$;`, לא ב-`END $$;`** — וזה היה באג בשער הזה עצמו.
  // כל הבלוקים בקובץ נסגרים `END;` ואז `$$;` בשורה נפרדת. ביטוי שחיפש
  // `END $$;` תפס מהבלוק הראשון בקובץ ועד לסופו — כ-19,000 תווים — ואז
  // מבחן ההכלה `'settings'` הצליח כי המילה מופיעה במקום אחר לגמרי.
  // **השער עבר מהסיבה הלא נכונה**, וזו התוצאה הגרועה ביותר האפשרית כאן.
  const blocks = (sql.match(/DO \$\$[\s\S]*?\n\$\$;/g) || [])
    .filter((b) => b.includes("service_role"));
  ok("⚠️ נמצא בלוק הענקות אחד ל-service_role", blocks.length === 1,
    `נמצאו ${blocks.length} — פיצול ההענקות לשניים מסתיר אחד מהם`);
  const grantBlock = blocks.join("\n");

  // ⚠️ תקרה על הגודל: בלוק שתופס חצי קובץ פירושו שהחילוץ נשבר שוב, ואז
  // כל בדיקת ההכלה שמתחתיו חסרת ערך.
  ok("⚠️ הבלוק בגודל סביר", grantBlock.length > 0 && grantBlock.length < 3000,
    `${grantBlock.length} תווים — החילוץ נשבר?`);

  console.log("\n── וההענקה כתובה בקובץ ולא רק במסד ──");
  for (const tbl of [...needed.keys()].sort()) {
    ok(`⚠️ ${tbl} מופיעה ב-security.postgres.sql`,
      new RegExp(`'${tbl}'`).test(grantBlock),
      "הוענקה ביד? היא תיעלם בהקמה הבאה");
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(fail === 0 ? `✅ עברו ${pass}` : `❌ נפלו ${fail} · עברו ${pass}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("check-edge-grants: נפל —", e.message); process.exit(1); });
