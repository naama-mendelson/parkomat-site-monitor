// tools/check-single-instance.js — שער: שרת שני מסרב לעלות.
//
// ============================================================
// למה שער ולא בדיקת יחידה
// ============================================================
// הכלל כולו הוא התנהגות של `pg_try_advisory_lock` על **חיבור session אמיתי**.
// בדיקה בזיכרון עם מסד מדומה תעבור בשלמות גם אם הנעילה נתפסת על ה-transaction
// pooler — כלומר בדיוק במקרה שבו היא לא מגינה על כלום.
//
// ⚠️ ולכן מקרה 3 כאן, והוא החשוב: הוא תופס נעילה דרך ה-pool ומוודא שהיא
// **לא** מספיקה. בלעדיו הבדיקה הייתה ירוקה גם על מימוש שבור.
const { Client } = require("pg");
const { acquireSingleInstanceLock } = require("../db/single-instance");

const URL_ = process.env.DATABASE_URL;

// ⚠️ מפתח בדיקה ולא מפתח הייצור: השער תופס, מוודא דחייה, ומשחרר. עם המפתח
// האמיתי הוא היה מתנגש בשרת החי ונופל **דווקא כשהמערכת עובדת כשורה**.
const TEST_KEYS = [0x74657374, 0x6c6f636b];   // "test" "lock"
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  if (!URL_) {
    console.error("check-single-instance: חסר DATABASE_URL");
    process.exit(1);
  }

  const checks = [];
  // ⚠️ הפרמטר הרביעי הוא **הסיבה**, והוא נוסף אחרי ששער זה נפל פעם אחת
  // מתוך חמש והשורה אמרה רק "false מול true". שער שנופל בלי לומר למה הוא
  // שער שמריצים שוב ומקווים — כלומר שער שלומדים להתעלם ממנו.
  const add = (name, got, want, why = "") => checks.push([name, got, want, why]);

  // ============================================================
  // ⚠️ ניקוי נעילת בדיקה תלויה — לפני הכול, ולא לפני מקרה 5 בלבד
  // ============================================================
  // מקרה 5 למטה הורג בכוונה את ה-backend של הנעילה שהוא עצמו תפס. מול
  // ה-pooler של Supabase הריגת backend אינה בהכרח מסיימת את ה-session
  // (זה בדיוק הכשל שמקרה 6 מתעד), ולכן הנעילה עלולה להישאר תלויה —
  // וההרצה **הבאה** של השער נכשלת.
  //
  // ⚠️ ונמדד שזה מפיל לא רק את מקרה 5: כשנעילת הבדיקה תפוסה, גם
  // מקרים 1–4 נופלים, כי הם פותחים ב-`acquireSingleInstanceLock` על
  // אותם מפתחות. לכן הניקוי בראש — שם הוא מגן על כל השער.
  //
  // ⚠️ והוא בטוח: המפתחות הם של הבדיקה בלבד (0x74657374/0x6c6f636b),
  // ולא אלה שהשרת החי מחזיק. אותה הבחנה בדיוק שמקרה 5 כבר מקפיד עליה
  // כשהוא הורג — ראה ההערה על application_name שם.
  {
    // ⚠️ require מקומי: `sessionUrlFor` מפורק מהמודול בהמשך הקובץ (מקרה 4),
    // והבלוק הזה רץ לפניו. שימוש בקבוע שטרם אותחל זורק ReferenceError —
    // וזה בדיוק מה שקרה בהעברה לכאן.
    const { sessionUrlFor: sessionUrl } = require("../db/single-instance");
    const pre = new Client({ connectionString: sessionUrl(URL_), ssl: { rejectUnauthorized: false } });
    pre.on("error", () => { /* ניתוק בזמן הניקוי אינו אמור להפיל את השער */ });
    try {
      await pre.connect();
      const cleared = await pre.query(
        `SELECT pg_terminate_backend(l.pid) FROM pg_locks l
          WHERE l.locktype = 'advisory' AND l.granted
            AND l.classid = $1 AND l.objid = $2 AND l.pid <> pg_backend_pid()`, TEST_KEYS);
      if (cleared.rows.length) console.log(`(נוקו ${cleared.rows.length} נעילות בדיקה תלויות מהרצה קודמת)
`);
    } catch { /* ניקוי מיטבי — כשל כאן ידווח דרך המקרה שייפול */ }
    await pre.end().catch(() => {});
  }


  // ---- 1. המופע הראשון תופס ----
  let release = null;
  try {
    release = await acquireSingleInstanceLock(URL_, TEST_KEYS);
    add("המופע הראשון עולה", true, true);
  } catch (e) {
    add("המופע הראשון עולה", false, true);
    console.error("   ", e.message.split("\n")[0]);
  }

  // ---- 2. המופע השני נדחה ----
  // ⚠️ וזה המקרה שכל הקובץ קיים בשבילו.
  let secondBlocked = false;
  let secondMsg = "";
  if (release) {
    try {
      const r2 = await acquireSingleInstanceLock(URL_, TEST_KEYS);
      await r2();                       // אם בכל זאת עלה — משחררים כדי לא להשאיר זבל
    } catch (e) {
      secondBlocked = true;
      secondMsg = e.message.split("\n")[0];
    }
  }
  add("המופע השני נדחה", secondBlocked, true);
  add("...וההודעה מסבירה למה", /שרת master אחר/.test(secondMsg), true);

  // ---- 3. אחרי שחרור אפשר שוב ----
  // בלי זה, נעילה שנתקעת לנצח הייתה "עוברת" את מקרה 2 בהצטיינות.
  let reacquired = false;
  if (release) {
    await release();
    try {
      const r3 = await acquireSingleInstanceLock(URL_, TEST_KEYS);
      reacquired = true;
      await r3();
    } catch { /* נשאר false */ }
  }
  add("⚠️ אחרי שחרור אפשר לעלות שוב", reacquired, true);

  // ---- 4. ⚠️ הנעילה יושבת על חיבור session ולא על ה-pooler ----
  // ============================================================
  // למה בדיקה מבנית ולא התנהגותית — וזה תיקון של הבדיקה, לא ויתור
  // ============================================================
  // הגרסה הראשונה כאן תפסה נעילה דרך ה-pooler (6543) מחיבור אחד וניסתה
  // לתפוס שוב מחיבור שני, בציפייה שתצליח — כלומר שתוכיח שהנעילה שם חסרת
  // ערך. ⚠️ **והבדיקה עצמה יצאה הפכפכה**: התוצאה תלויה בשאלה אם ה-pooler
  // ניתב במקרה את שני החיבורים לאותו backend. הרצה אחת החזירה true והבאה
  // false, על אותו קוד בדיוק.
  //
  // שער שנופל באקראי גרוע משער שלא קיים — הוא מלמד להתעלם. לכן נבדק כאן
  // מה שאפשר לקבוע בוודאות: שהמודול מכוון לפורט ה-session. אם מישהו יסיר
  // את ההמרה, זה נתפס מיד.
  const { sessionUrlFor } = require("../db/single-instance");
  const lockUrl = sessionUrlFor(URL_);
  add("⚠️ הנעילה על פורט session ולא על ה-pooler",
      lockUrl.includes(":5432/") && !lockUrl.includes(":6543/"), true);

  // ...ו-pid יציב על אותו חיבור הוא **התכונה** שנעילת session נשענת עליה.
  // אין דבר כזה "לפעמים" — session אמיתי מחזיר את אותו backend תמיד.
  let pidStable = false;
  const lockClient = new Client({ connectionString: lockUrl, ssl: { rejectUnauthorized: false } });
  try {
    await lockClient.connect();
    const a = await lockClient.query("SELECT pg_backend_pid() AS p");
    const b = await lockClient.query("SELECT pg_backend_pid() AS p");
    pidStable = a.rows[0].p === b.rows[0].p;
  } catch { /* נשאר false ומדווח */ }
  await lockClient.end().catch(() => {});
  add("...ו-backend יציב בין שאילתות", pidStable, true);

  // ---- 5. ⚠️ ניתוק של חיבור הנעילה אינו מפיל את התהליך ----
  // ============================================================
  // באג אמיתי שהיה כאן, ולכן הבדיקה
  // ============================================================
  // `Client` של pg הוא EventEmitter. ניתוק בלי מאזין ל-'error' מפיל את **כל
  // התהליך** על unhandled error. בגרסה הראשונה המאזין נרשם רק **אחרי**
  // שאילתת הנעילה, כלומר כל ניתוק בזמנה הרג את השרת — מנגנון ההגנה כסיבת
  // הקריסה.
  //
  // כאן זה נבדק בכוח: תופסים נעילה, הורגים את ה-backend שלה מבחוץ
  // (`pg_terminate_backend`), וממתינים. אם המאזין חסר, התהליך הזה מת כאן
  // ומעולם לא יגיע לטבלת התוצאות.
  let survived = false;
  let why5 = "";

  const lock5 = await acquireSingleInstanceLock(URL_, TEST_KEYS)
    .catch((e) => { why5 = `לא ניתן לתפוס את נעילת הבדיקה: ${e.message}`; return null; });
  if (!lock5 && !why5) why5 = "נעילת הבדיקה תפוסה — ייתכן שנשארה תלויה מהרצה קודמת";
  if (lock5) {
    const killer = new Client({ connectionString: sessionUrlFor(URL_), ssl: { rejectUnauthorized: false } });
    try {
      await killer.connect();
      // ⚠️ **מצומצם למפתח הבדיקה, ולא ל-application_name.** הגרסה הראשונה
      // הרגה כל חיבור עם השם הזה — כלומר גם את הנעילה של **השרת החי**, בשקט,
      // והשאירה את הפרודקשן בלי הגנה עד ההפעלה הבאה. בדיקה שמנטרלת את מה
      // שהיא בודקת היא גרועה מאין בדיקה.
      const killed = await killer.query(
        `SELECT pg_terminate_backend(l.pid) AS ok
           FROM pg_locks l
          WHERE l.locktype = 'advisory' AND l.granted
            AND l.classid = $1 AND l.objid = $2
            AND l.pid <> pg_backend_pid()`, TEST_KEYS
      );

      // ⚠️ **אם לא נהרג כלום, המקרה נכשל ולא עובר.** הגרסה הראשונה סיננה לפי
      // application_name — שנמחק ע"י ה-pooler ל-"Supavisor" — ולכן לא הרגה
      // דבר, והבדיקה "עברה" בלי לבדוק שום דבר. זו בדיוק בדיקה שלילית שעוברת
      // מהסיבה הלא נכונה, ובלי התנאי הזה אין שום דרך להבחין.
      if (killed.rows.length === 0) {
        why5 = "לא נהרג אף backend — הבדיקה לא בדקה כלום";
      } else {
        // שהות לאירוע ה-'error' להגיע ולהתפוצץ, אם אין מי שיתפוס אותו.
        await new Promise((r) => setTimeout(r, 1500));
        survived = true;
      }
    } catch (e) { why5 = `חריגה בזמן הבדיקה: ${e.message}`; }
    await killer.end().catch(() => {});
    await lock5().catch(() => {});
  }
  add("⚠️ ניתוק חיבור הנעילה אינו מפיל את התהליך", survived, true, why5);

  // ---- 6. ⚠️ נעילה בסרק משוחררת אוטומטית ----
  // ============================================================
  // הכשל שקרה בפועל, פעמיים באותו יום
  // ============================================================
  // נעילת advisory משוחררת כשה-session נגמר. מול ה-pooler של Supabase
  // `kill` של התהליך **אינו** מסיים את ה-session — הוא נשאר פתוח בצד
  // Postgres, והנעילה איתו. נמדד: 11.5 דקות, ואחר כך 32 דקות, שבהן השרת
  // סירב לעלות בהודעה "שרת אחר כבר רץ" **בזמן שלא רץ שום שרת**.
  //
  // ⚠️ וזה יקרה בכל `docker compose restart`, כלומר בכל עדכון על השרת.
  //
  // ⚠️ **בדיקה מבנית, ואני אומר זאת במפורש.** אי אפשר לזייף "סרק של דקה"
  // מבחוץ: `state_change` נקבע ע"י Postgres, ואין דרך לדחוף אותו אחורה.
  // גרסה קודמת של הבדיקה הזו ניתקה socket בכוח כדי "לדמות" — וזה לא הוכיח
  // כלום על הסף, **והשאיר נעילה תקועה מאחוריה** לכמה דקות.
  //
  // ההתנהגות עצמה נמדדה על המופע החי, פעמיים: 11.5 דקות ואחר כך 32 דקות
  // של סירוב לעלות בזמן שלא רץ שום שרת. מה שנבדק כאן הוא שהמנגנון והסף
  // **קיימים** — ושהסף אינו קטן מ-60ש', כי keep-alive רץ כל 20ש' וסף
  // צמוד מדי היה מפנה שרת חי.
  const srcPath = path.join(__dirname, "..", "db", "single-instance.js");
  const src = fs.readFileSync(srcPath, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  add("⚠️ קיים מנגנון שחרור לנעילה בסרק",
      /idle_seconds\s*>=\s*STALE_AFTER_SECONDS/.test(src)
      && /pg_terminate_backend/.test(src), true);

  const threshold = Number((src.match(/STALE_AFTER_SECONDS\s*=\s*(\d+)/) || [])[1]);
  add("...והסף 60ש' לפחות — שלוש החמצות keep-alive", threshold >= 60, true);

  // ============================================================
  // ⚠️ הפינג על חיבור הנעילה — הבדיקה שנולדה מהבאג עצמו
  // ============================================================
  // המנגנון שלמעלה מכריז על מחזיק כמת אחרי 60 שניות בסרק. זה תקף **רק** אם
  // חיבור הנעילה מריץ שאילתה מדי פעם — ובמשך תקופה הוא לא עשה זאת: ה-
  // keepalive שב-master.js מחמם את ה-pool (6543), בעוד הנעילה יושבת על
  // חיבור session נפרד (5432) שנפתח פעם אחת ואז שותק לנצח.
  //
  // ⚠️ **התוצאה שנמדדה בייצור: סרק של 1,825 שניות על שרת חי לחלוטין**,
  // ותהליך שני הרג לו את ה-session ועלה לצידו. שני מאסטרים על אותו
  // clientId — בדיוק מה שהקובץ הזה קיים כדי למנוע.
  //
  // ⚠️ ו**שתי** קריאות ולא אחת: יש שני מסלולי הצלחה — נעילה שנתפסה מיד,
  // ונעילה שנתפסה אחרי שחרור תקוע. הגרסה הראשונה של התיקון כיסתה רק את
  // השני, כלומר השאירה את ההגנה מתה בדיוק במקרה הנפוץ.
  add("⚠️ חיבור הנעילה מפונג — אחרת ההגנה מתה אחרי דקה",
      /function startLockPing/.test(src)
      && /client\.query\(["'`]SELECT 1["'`]\)/.test(src), true);

  // ⚠️ `= startLockPing(` ולא `startLockPing(` — התבנית הרחבה תופסת גם את
  // **הגדרת** הפונקציה, ואז שני מסלולים נספרים כשלושה והבדיקה מאבדת משמעות.
  add("...בשני מסלולי ההצלחה, לא רק באחד",
      (src.match(/=\s*startLockPing\(client\)/g) || []).length === 2, true);

  const pingMs = Number((src.match(/LOCK_PING_MS\s*=\s*([\d_]+)/) || [])[1]?.replace(/_/g, ""));
  add("...ובמרווח קטן מהסף", pingMs > 0 && pingMs / 1000 < threshold, true);

  console.log("בדיקה                                      בפועל       צפוי");
  let bad = 0;
  for (const [name, got, want, why] of checks) {
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${name.padEnd(42)}${String(got).slice(0, 10).padStart(10)} ${String(want).slice(0, 10).padStart(10)}  ${ok ? "✅" : "❌"}`);
    if (!ok && why) console.log(`   └─ ${why}`);
  }

  console.log(bad === 0 ? "\n✅ שרת אחד בלבד יכול לרוץ" : `\n❌ ${bad} כשלים`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
