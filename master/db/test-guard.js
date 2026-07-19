// db/test-guard.js — ההגנה שמונעת מבדיקות לגעת בפרודקשן.
//
// ============================================================
// למה זה קיים
// ============================================================
// עד היום היה מסד נתונים אחד, וה-DATABASE_URL שלו הצביע על הפרודקשן. כל בדיקה
// שכתבתי רצה על נתוני אמת — ובסבב קודם באמת זיהמתי את ה-DB של הלקוח: שני חלונות
// תחזוקה על אתר 1234 ומקטע no_comm שקרי. זו לא הייתה תקלה נדירה; זו הייתה
// התוצאה הצפויה של המבנה.
//
// ============================================================
// למה סימון *חיובי* ולא רשימה שחורה
// ============================================================
// הדרך המתבקשת היא "אם ה-URL מכיל את ה-ref של הפרודקשן — סרב". זו הגנה שבירה:
// היא מניחה שאני יודע מראש את כל כתובות הפרודקשן שיהיו אי-פעם, והיא נכשלת
// *פתוח* — כלומר URL שלא הכרתי עובר בשקט. בהגנה כזו טעות אחת בכתובת = נזק לאמת.
//
// לכן ההגנה הפוכה: **מסד הבדיקות מסומן מבפנים**, בשורה בטבלת settings.
// סקריפט הרסני דורש לראות את הסימון, ומסרב אם אינו שם. פרודקשן לעולם לא ייצור
// את השורה הזו, ולכן הוא מוגן — גם אם ה-URL הועתק לשם בטעות, וגם אם ייווצר
// בעתיד פרויקט חדש שאיש לא חשב עליו. הכשל הוא **סגור**: ספק ⇒ סירוב.
//
// זו הסיבה שהסימון יושב ב-DB ולא ב-.env: משתנה סביבה הוא מה שהתכוונת אליו,
// אבל שורה במסד היא מה שבאמת התחברת אליו.

const fs = require("fs");
const path = require("path");
const db = require("./db");

const MARKER_KEY = "environment";
const MARKER_VALUE = "test";
const ENV_TEST_FILE = path.join(__dirname, "..", ".env.test");

// ============================================================
// חסם ראשון: משתנה סביבה שדורס את .env.test
// ============================================================
// גיליתי את זה במדידה, לא בהנחה: ב-Node, אם DATABASE_URL כבר קיים בסביבת
// המעטפת, הוא **גובר** על --env-file. כלומר טרמינל אחד עם
// `export DATABASE_URL=<פרודקשן>` הופך את `npm run test:db:reset` לפקודה
// שמרוקנת את הפרודקשן — בלי שאף אחד יראה משהו חריג בשורת הפקודה.
//
// סימון ה-DB (למטה) היה עוצר גם את זה, אבל הודעת השגיאה הייתה מבלבלת
// ("זה לא מסד בדיקות" — כשהקובץ *כן* מצביע על מסד בדיקות). הבדיקה הזו
// מצביעה ישירות על הסיבה האמיתית.
function assertEnvFileWins() {
  if (!fs.existsSync(ENV_TEST_FILE)) return;   // אין קובץ — אין מה להשוות

  const fromFile = fs
    .readFileSync(ENV_TEST_FILE, "utf8")
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith("DATABASE_URL="))
    ?.trim()
    .slice("DATABASE_URL=".length)
    .replace(/^["']|["']$/g, "");

  if (!fromFile) return;

  if (process.env.DATABASE_URL !== fromFile) {
    throw new Error(
      `\n⛔ משתנה הסביבה DATABASE_URL דורס את .env.test\n\n` +
        `   בפועל מחובר אל: ${mask(process.env.DATABASE_URL)}\n` +
        `   .env.test אומר:  ${mask(fromFile)}\n\n` +
        `   ב-Node, DATABASE_URL שכבר קיים במעטפת גובר על --env-file.\n` +
        `   נקה אותו לפני ההרצה:   unset DATABASE_URL   (PowerShell: $env:DATABASE_URL=$null)\n`
    );
  }
}

const mask = (url) => (url || "(ריק)").replace(/:\/\/([^:]+):[^@]*@/, "://$1:***@");

/**
 * קורא את סימון הסביבה מתוך ה-DB שאליו אנחנו *באמת* מחוברים.
 * מחזיר null אם אין טבלת settings (מסד ריק לגמרי) או אין שורת סימון.
 */
async function readMarker() {
  try {
    const row = await db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(MARKER_KEY);
    return row?.value ?? null;
  } catch (err) {
    // הטבלה עוד לא קיימת — מסד חדש לחלוטין. זה לא כשל.
    if (err.code === "42P01") return null;   // undefined_table
    throw err;
  }
}

/** כותב את הסימון. נקרא רק מ-init, ורק אחרי שווידאנו שהמסד ריק/מסומן. */
async function stampMarker() {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`
    )
    .run(MARKER_KEY, MARKER_VALUE, new Date().toISOString());
}

/**
 * החוסם. כל סקריפט שכותב/מוחק בבדיקות חייב לקרוא לזה *לפני* שהוא נוגע בנתונים.
 * זורק — ולא מחזיר false — כדי שאי אפשר יהיה להתעלם מהתוצאה בטעות.
 */
async function assertTestDatabase() {
  assertEnvFileWins();          // חסם 1 — הסביבה לא דורסת את קובץ הבדיקות
  const marker = await readMarker();   // חסם 2 — המסד עצמו מעיד שהוא מסד בדיקות

  if (marker !== MARKER_VALUE) {
    const where = describeTarget();
    throw new Error(
      `\n` +
        `╔══════════════════════════════════════════════════════════════╗\n` +
        `║  ⛔  עצור — זה אינו מסד בדיקות                                ║\n` +
        `╚══════════════════════════════════════════════════════════════╝\n` +
        `היעד:   ${where}\n` +
        `סימון:  ${marker === null ? "אין" : `"${marker}"`}  (נדרש: "${MARKER_VALUE}")\n\n` +
        `הסקריפט הזה כותב או מוחק נתונים, והמסד שאליו הוא מחובר אינו מסומן\n` +
        `כמסד בדיקות. סביר מאוד שזה הפרודקשן.\n\n` +
        `אם זה באמת מסד בדיקות חדש — הרץ קודם:  npm run test:db:init\n`
    );
  }
}

/** תיאור היעד ללוג — בלי הסיסמה. */
function describeTarget() {
  return mask(process.env.DATABASE_URL);
}

module.exports = {
  assertTestDatabase,
  assertEnvFileWins,
  readMarker,
  stampMarker,
  describeTarget,
  MARKER_KEY,
  MARKER_VALUE,
};
