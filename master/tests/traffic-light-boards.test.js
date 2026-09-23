// tests/traffic-light-boards.test.js — שני לוחות באותן טבלאות.
//
// ============================================================
// מה נבדק כאן, ולמה דווקא מקומית
// ============================================================
// "רמזור רובוטי" ו"רמזור מכפילים" הם שני דשבורדים נפרדים שחולקים את
// `traffic_light_columns` ו-`traffic_light_rows`. השאלה היחידה שיכולה
// לשבור משהו קיים היא **דליפה בין הלוחות**, ובפרט דליפה אל
// ‏`app.service_agreement` — שמזינה את חלון מדידת הזמינות של אתר מנוטר.
//
// ⚠️ **והמקרה הזה נבנה כאן, לא נשלל בקריאת קוד.** שורת מכפילים עם תא
// תחת המפתח של "קוד אתר" היא בדיוק מה שהיה משנה לאתר את המדד בלי שאיש
// נגע בו — מספר שזז על המסך בלי סיבה נראית. הבדיקה יוצרת אותה במפורש.
//
// רץ מול PGlite (Postgres 17 מקומי) שמריץ את `db.init()` האמיתי — לא
// מול הייצור. ראה tests/helpers/local-pg.js.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const local = require("./helpers/local-pg");

const skip = !local.available() && "PGlite אינו מותקן (npm ci --omit=dev)";
let h;
const MGR = "77777777-7777-7777-7777-777777777777";

before(async () => {
  if (skip) return;
  h = await local.boot();
  await h.pg.query(
    `INSERT INTO app_users (email, role, is_active, supabase_uid, created_at)
     VALUES ('mgr@parkomat.co.il','manager',true,$1,now())`, [MGR]);
});
after(async () => { if (h) await h.close(); });

/** מריץ כמנהל — הפונקציות דורשות app.require_manager(). */
const mgr = (sql, args = []) =>
  h.as("authenticated", MGR, (tx) => tx.query(sql, args));

const board = async (name) =>
  (await h.pg.query(`SELECT public.tl_board($1) AS b`, [name])).rows[0].b;

test("שורות ועמודות קיימות שייכות ללוח הרובוטי", { skip }, async () => {
  // ⚠️ זו ההגירה עצמה: ברירת המחדל היא מה שממלא את מה שכבר קיים.
  // בלעדיה הן היו מקבלות NULL, וכל שאילתה מסוננת הייתה מחזירה לוח ריק —
  // כלומר הלוח שעובד היום נעלם מהמסך ברגע ההחלה.
  await mgr(`SELECT public.tl_add_column('עמודה ותיקה','text')`);
  const rows = await h.pg.query(
    `SELECT DISTINCT board FROM traffic_light_columns`);
  assert.deepEqual(rows.rows.map((r) => r.board), ["robotic"]);
});

test("קריאה בלי ארגומנט מחזירה את הלוח הרובוטי", { skip }, async () => {
  // ⚠️ זה מה שמאפשר לדשבורד ישן לעבוד מול SQL חדש. בלי ברירת המחדל,
  // רגע ההחלה היה מסך ריק לכל מי שלא רענן.
  const b = (await h.pg.query(`SELECT public.tl_board() AS b`)).rows[0].b;
  assert.equal(b.board, "robotic");
  assert.ok(b.columns.length >= 1);
});

test("כל לוח רואה רק את מה ששלו", { skip }, async () => {
  await mgr(`SELECT public.tl_add_column('סוג מתקן','text','[]'::jsonb,'multipliers')`);
  const rid = (await mgr(`SELECT public.tl_add_row(NULL,'multipliers') AS id`)).rows[0].id;

  const rob = await board("robotic");
  const mul = await board("multipliers");

  assert.ok(!rob.columns.some((c) => c.label === "סוג מתקן"),
    "עמודת מכפילים דלפה ללוח הרובוטי");
  assert.ok(mul.columns.some((c) => c.label === "סוג מתקן"));
  assert.ok(!rob.rows.some((r) => String(r.id) === String(rid)),
    "שורת מכפילים דלפה ללוח הרובוטי");
  assert.ok(mul.rows.some((r) => String(r.id) === String(rid)));
});

test("המיקום נספר בתוך הלוח ולא על פני שניהם", { skip }, async () => {
  // ⚠️ בלי הסינון, העמודה הראשונה בלוח חדש הייתה מקבלת את המיקום
  // שאחרי העמודה האחרונה של הלוח השני — לוח ריק שמתחיל במיקום 16.
  const mul = await board("multipliers");
  assert.equal(Number(mul.columns[0].position), 1,
    `העמודה הראשונה בלוח המכפילים במיקום ${mul.columns[0].position}`);
});

test("⚠️ שורת מכפילים אינה משנה את חלון הזמינות של אתר מנוטר", { skip }, async () => {
  // ---- אתר מנוטר, מחובר ללוח הרובוטי כ"בסיסי" ----
  const site = (await h.pg.query(
    `INSERT INTO sites (code, site_name, status, registered_at, last_seen)
     VALUES ('9001','אתר בדיקה','ready',now(),now()) RETURNING id`)).rows[0].id;

  await mgr(`SELECT public.tl_add_column('קוד אתר','text')`);
  await mgr(`SELECT public.tl_add_column('להתייחס כ','status')`);
  const kCode = (await h.pg.query(
    `SELECT key FROM traffic_light_columns WHERE board='robotic' AND label='קוד אתר'`)).rows[0].key;
  const kKind = (await h.pg.query(
    `SELECT key FROM traffic_light_columns WHERE board='robotic' AND label='להתייחס כ'`)).rows[0].key;

  const rob = (await mgr(`SELECT public.tl_add_row() AS id`)).rows[0].id;
  await mgr(`SELECT public.tl_set_cell($1,$2,to_jsonb('9001'::text))`, [rob, kCode]);
  await mgr(`SELECT public.tl_set_cell($1,$2,to_jsonb('basic'::text))`, [rob, kKind]);

  const before = (await h.pg.query(
    `SELECT app.service_agreement($1) AS a`, [site])).rows[0].a;
  assert.equal(before, "basic", "הבסיס עצמו אינו עובד — הבדיקה חסרת משמעות בלעדיו");

  // ---- ועכשיו שורת מכפילים שנושאת את אותו קוד, תחת אותו מפתח ----
  // זה המקרה המסוכן: אותה טבלה, אותו מפתח JSONB, קוד אתר אמיתי.
  const bad = (await mgr(`SELECT public.tl_add_row(NULL,'multipliers') AS id`)).rows[0].id;
  await mgr(`SELECT public.tl_set_cell($1,$2,to_jsonb('9001'::text))`, [bad, kCode]);
  await mgr(`SELECT public.tl_set_cell($1,$2,to_jsonb('vip'::text))`, [bad, kKind]);

  // ⚠️ **המיקום נמוך מזה של השורה הלגיטימית — בכוונה.** בלי זה
  // ה-`ORDER BY` היה מכריע לטובת השורה הנכונה בלאו הכי, והבדיקה
  // היתה נשארת ירוקה גם אחרי מחיקת השומר — זה נמדד במוטציה.
  await h.pg.query(`UPDATE traffic_light_rows SET position = -1 WHERE id = $1`, [bad]);

  const after = (await h.pg.query(
    `SELECT app.service_agreement($1) AS a`, [site])).rows[0].a;
  assert.equal(after, "basic",
    `שורת מכפילים שינתה את ההסכם מ-basic ל-${after} — כלומר את חלון מדידת הזמינות`);
});

test("שם לוח שאינו מוכר נדחה", { skip }, async () => {
  // ⚠️ בלי ה-CHECK, שגיאת כתיב יוצרת לוח שלישי בלתי-נראה: השורות
  // נכתבות, אף אחד לא רואה אותן, ואין שגיאה.
  await assert.rejects(
    () => h.pg.query(
      `INSERT INTO traffic_light_rows (cells, position, board) VALUES ('{}'::jsonb, 1, 'robtic')`),
    /tl_rows_board_known|check/i);
});

// ============================================================
// ⚠️ הסכנה ש-PGlite אינה יכולה לראות
// ============================================================
// הוספת פרמטר אינה מחליפה פונקציה — היא יוצרת **עומס יתר שני**,
// ושתי גרסאות של אותה פונקציה גורמות ל-PostgREST לסרב לקריאה. זה בדיוק
// מה שקרה ב-17/09/2026, כשעותק ישן של `ingest_batch` חזר לחיים
// ו**כל האתרים הפסיקו לכתוב**.
//
// ⚠️ והסכנה הזו **אינה ניתנת לתפיסה ב-PGlite**: מסד טרי מעולם לא
// החזיק את החתימה הישנה, ולכן השמטת ה-DROP לא תיצור בו כפילות וכל
// הבדיקות יישארו ירוקות. רק הייצור היה נשבר. לכן השער הזה קורא
// את ה-SQL עצמו.
const fs = require("node:fs");
const path = require("node:path");

test("⚠️ לכל חתימה שהשתנתה יש DROP מפורש לפניה", () => {
  const sql = fs.readFileSync(
    path.join(__dirname, "..", "db", "traffic-light.postgres.sql"), "utf8");

  // ארבע החתימות הישנות — בדיוק כפי שהן חיות בייצור היום.
  for (const sig of [
    "public.tl_board()",
    "public.tl_add_column(text, text, jsonb)",
    "public.tl_add_row(double precision)",
    "public.tl_paste_rows(jsonb)",
  ]) {
    assert.ok(sql.includes("DROP FUNCTION IF EXISTS " + sig + ";"),
      `חסר \`DROP FUNCTION IF EXISTS ${sig};\` — החלה על הייצור תיצור שתי גרסאות, ` +
      "ו-PostgREST יסרב לקריאה כולה");
  }
});

test("השומר קיים בשני חישובי הזמינות", () => {
  // בדיקה התנהגותית למעלה מכסה את `service_agreement`. זו מוודאת
  // שגם `service_plan` — שאינה נבדקת שם — לא נשכחה.
  const sql = fs.readFileSync(
    path.join(__dirname, "..", "db", "service-hours.postgres.sql"), "utf8");
  const n = (sql.match(/board = 'robotic'/g) || []).length;
  assert.ok(n >= 6,
    `נמצאו ${n} סינוני לוח — צפויים ששה: שורות ומפתחות בשתי הפונקציות`);
});

test("⚠️ עידכון רוחב עמודה אינו משנה את חישוב הזמינות", { skip }, async () => {
  // השומר על הלוח סוגר דליפה בין לוחות. זו הסכנה השנייה,
  // והיא קיימת **בתוך** הלוח הרובוטי: שתי עמודות באותה
  // תווית, ו-`LIMIT 1` בלי `ORDER BY` מכריע לפי סדר הערמה.
  // תוויות כפולות הן המצב הטבעי של הייבוא הזה — בגיליון
  // המכפילים "סוג הסכם שירות" מופיעה פעמיים.
  const site = (await h.pg.query(
    `INSERT INTO sites (code, site_name, status, registered_at, last_seen)
     VALUES ('9002','אתר רוחב','ready',now(),now()) RETURNING id`)).rows[0].id;

  const kCode = (await h.pg.query(
    `SELECT key FROM traffic_light_columns WHERE board='robotic' AND label='קוד אתר'
      ORDER BY position, id LIMIT 1`)).rows[0].key;
  const kKind = (await h.pg.query(
    `SELECT key FROM traffic_light_columns WHERE board='robotic' AND label='להתייחס כ'
      ORDER BY position, id LIMIT 1`)).rows[0].key;

  const row = (await mgr(`SELECT public.tl_add_row() AS id`)).rows[0].id;
  await mgr(`SELECT public.tl_set_cell($1,$2,to_jsonb('9002'::text))`, [row, kCode]);
  await mgr(`SELECT public.tl_set_cell($1,$2,to_jsonb('ext'::text))`, [row, kKind]);
  assert.equal((await h.pg.query(`SELECT app.service_agreement($1) AS a`, [site])).rows[0].a, "ext");

  // עמודה שנייה באותה תווית, באותו לוח
  await mgr(`SELECT public.tl_add_column('קוד אתר','text')`);
  const id1 = (await h.pg.query(
    `SELECT id FROM traffic_light_columns WHERE key = $1`, [kCode])).rows[0].id;

  // ועכשיו פעולת ממשק שגרתית לחלוטין — שינוי רוחב
  await mgr(`SELECT public.tl_update_column($1,NULL,NULL,NULL,240)`, [id1]);

  assert.equal(
    (await h.pg.query(`SELECT app.service_agreement($1) AS a`, [site])).rows[0].a, "ext",
    "שינוי רוחב עמודה שינה את ההסכם — כלומר התשובה נקבעת לפי סדר הערמה");
});

test("⚠️ השורות הקיימות בייצור מקבלות את הלוח הרובוטי", () => {
  // ⚠️ **גם זה בלתי ניתן לתפיסה ב-PGlite**: מסד טרי אין בו 153 שורות
  // קיימות שהברירת המחדל צריכה למלא, וכל הכתיבות החדשות מעבירות
  // לוח מפורש. בייצור ברירת מחדל שגויה = הלוח הקיים נעלם מהמסך.
  const sql = fs.readFileSync(
    path.join(__dirname, "..", "db", "traffic-light.postgres.sql"), "utf8");
  // ⚠️ השוואת מחרוזת על טקסט עם רווחים מנורמלים, ולא רגקס. הניסוח
  // הראשון כאן בנה `new RegExp("…\s+…")` — וב-JS, בתוך מחרוזת רגילה,
  // ‏`\s` הוא פשוט `s`. הרגקס חיפש `traffic_light_columnss+ADD` ולא
  // התאים לעולם: שער אדום על קוד תקין.
  const flat = sql.replace(/\s+/g, " ");
  for (const t of ["traffic_light_columns", "traffic_light_rows"]) {
    assert.ok(
      flat.includes(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS board TEXT NOT NULL DEFAULT 'robotic';`),
      `ב-${t} חסרה ברירת המחדל 'robotic' — 153 השורות הקיימות לא ישוייכו לשום לוח`);
  }
});

test("⚠️ אין `LIMIT 1` חשוף בחישובי הזמינות", () => {
  // ⚠️ **וגם זה אינו נתפס ב-PGlite.** ההיפוך תלוי בכך ש-`UPDATE`
  // מעביר את ה-tuple לסוף הערמה, וזה תלוי במצב הדף — במסד קטן
  // העדכון נשאר במקום (HOT) והסדר לא משתנה. נמדד במוטציה:
  // הסרת ה-ORDER BY השאירה את כל הבדיקות ירוקות. בייצור, לעומת
  // זאת, ctid של שורה 208 קטן משל 151 — הסדר כבר מעורבב.
  const sql = fs.readFileSync(
    path.join(__dirname, "..", "db", "service-hours.postgres.sql"), "utf8");
  assert.equal((sql.match(/ORDER BY position, id LIMIT 1\)/g) || []).length, 4,
    "ארבעת מפתחות העמודות חייבים ORDER BY מפורש");
  assert.equal((sql.match(/ORDER BY r\.position, r\.id/g) || []).length, 2,
    "שתי התאמות השורה חייבות ORDER BY מפורש");
});
