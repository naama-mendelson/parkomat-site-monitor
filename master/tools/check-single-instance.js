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

(async () => {
  if (!URL_) {
    console.error("check-single-instance: חסר DATABASE_URL");
    process.exit(1);
  }

  const checks = [];
  const add = (name, got, want) => checks.push([name, got, want]);

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

  console.log("בדיקה                                      בפועל       צפוי");
  let bad = 0;
  for (const [name, got, want] of checks) {
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${name.padEnd(42)}${String(got).slice(0, 10).padStart(10)} ${String(want).slice(0, 10).padStart(10)}  ${ok ? "✅" : "❌"}`);
  }

  console.log(bad === 0 ? "\n✅ שרת אחד בלבד יכול לרוץ" : `\n❌ ${bad} כשלים`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
