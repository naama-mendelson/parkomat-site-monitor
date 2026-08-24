// tests/admin-gate.test.js — מי פותח את מסך ניהול האתרים, ודרך מה הוא כותב.
//
// ============================================================
// ⚠️ אלה בדיקות **מבנה**, ולא בדיקות התנהגות — וההבחנה חשובה
// ============================================================
// `useAdmin` הוא hook של React ו-`AdminPanel` הוא קומפוננטה; שניהם דורשים
// רינדור, ואין כאן DOM. לכן מה שנבדק כאן הוא **שהחיווט נכון**, לא שהמסך
// אכן נראה כך. את זה רק דפדפן יודע.
//
// ⚠️ ולמה זה עדיין שווה משהו: הכשלים שהבדיקות האלה תופסות הם כולם
// **שקטים**. קומפוננטה שממשיכה לייבא כתיבה מ-`services/api` תעבוד מושלם
// כל עוד השרת חי — ותפסיק לעבוד ביום שהוא ייפול, שהוא בדיוק היום שבו
// המעבר ל-Supabase היה אמור לעזור. `vite build` אינו TypeScript ואינו
// מתלונן על כלום מזה.
//
// ⚠️ **ההערות נחתכות לפני כל התאמה.** הקבצים כאן מתועדים בכבדות, ופעמיים
// בפרויקט הזה הערה שלי הכילה בעצמה את הביטוי שנחפש — כלומר הבדיקה עברה
// בזכות התיעוד ולא בזכות הקוד.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const SRC = path.join(__dirname, "..", "..", "dashboard", "src");

/** קורא קובץ בלי הערות — אחרת התיעוד עצמו עונה על הבדיקה. */
function code(rel) {
  const p = path.join(SRC, rel);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    // JSX comments: {/* … */} — נחתכו כבר ע"י הכלל הראשון, נשארו הסוגריים
    .replace(/\{\s*\}/g, "");
}

test("⚠️ הכתיבות עוברות ב-dataSource, לא ב-services/api", () => {
  for (const rel of [
    "components/AdminPanel/AdminPanel.jsx",
    "components/AddSiteModal/AddSiteModal.jsx",
    "components/DetailPanel/DetailPanel.jsx",
    "components/UsersPanel/UsersPanel.jsx",
    "views/SupervisorView/SupervisorView.jsx",
  ]) {
    const src = code(rel);
    if (src === null) continue;

    // כל ייבוא מ-services/api בקובץ הזה
    const fromApi = [...src.matchAll(/import\s*\{([^}]+)\}\s*from\s*["'][^"']*services\/api["']/g)]
      .flatMap((m) => m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()));

    // ⚠️ הרשימה השחורה היא **חמש פעולות הכתיבה** שעברו ל-Postgres. הן
    // עדיין מיוצאות מ-services/api בכוונה — זו זרוע השרת של המתג — ולכן
    // הכשל היחיד האפשרי הוא שקומפוננטה תייבא אותן משם ישירות, ותעקוף את
    // המתג בלי שאיש יבחין.
    // ⚠️ `inviteUser` ו-`deleteUser` **אינם** ברשימה, וזה מכוון: הן דורשות
    // את מפתח ה-Secret של GoTrue ואין להן זרוע ישירה כלל. הכללתן כאן
    // הייתה מפילה את הבדיקה על הקוד הנכון היחיד האפשרי.
    for (const banned of [
      "registerSite", "updateSite", "deleteSite",
      "startMaintenance", "cancelMaintenance",
      "fetchUsers", "setUserActive", "setUserRole",
    ]) {
      assert.ok(
        !fromApi.includes(banned),
        `${rel} מייבא ${banned} מ-services/api — עוקף את המתג`,
      );
    }
  }
});

test("⚠️ במצב ישיר ההרשאה היא תפקיד, ולא הקוד המשותף", () => {
  const src = code("hooks/useAdmin.js");
  assert.ok(src, "hooks/useAdmin.js חסר");

  assert.match(src, /useDirect/, "useAdmin אינו מסתכל על המתג בכלל");
  assert.match(src, /role\s*===\s*["']manager["']/, "אין בדיקת תפקיד manager");

  // ============================================================
  // ⚠️ הבדיקה שבאמת מפילה מוטציה
  // ============================================================
  // הזרוע הישירה אסור שתסתמך על הקוד המשותף. גרסה שתחזיר אותו תעבוד
  // מושלם על מסך של מנהל שמכיר את `admin123`, ותיראה כמו "הרשאות
  // עובדות" — עד שהקוד יוחלף ומנהל אמיתי ייחסם.
  // ============================================================
  // ⚠️ הענף נחתך בסוגר הסוגר שלו, ולא עד סוף הקובץ
  // ============================================================
  // חיתוך עד הסוף כולל גם את **זרוע השרת**, שבה `unlock: unlockByCode`
  // נכון לחלוטין — ולכן הבדיקה נפלה על הקוד התקין. הגרסה הקודמת "עברה"
  // רק מפני שהרשימה השחורה הייתה קצרה מדי; ברגע שהושלמה, הפגם התגלה.
  const start = src.indexOf("if (useDirect)");
  assert.ok(start > 0, "אין ענף ישיר ב-useAdmin");
  // הסוגר בהזחה של שתי רווחים הוא זה שסוגר את ה-if; ההחזרה שבתוכו
  // מוזחת בארבעה.
  const end = src.indexOf("\n  }", start);
  assert.ok(end > start, "לא נמצא סוף הענף הישיר");
  const direct = src.slice(start, end);

  // ⚠️ **הרשימה כוללת את `unlockByCode`, ולא רק את `verifyAdminCode`.**
  // הגרסה הראשונה של הבדיקה חיפשה רק קריאה מוטבעת, ולכן המוטציה
  // הסבירה בפועל — `unlock: unlockByCode` — **עברה אותה**. העטיפה
  // מוגדרת מחוץ לענף, ולכן שמה הוא מה שצריך להיאסר.
  for (const banned of ["unlockByCode", "verifyAdminCode", "storeAdminCode", "codeUnlocked"]) {
    assert.ok(
      !new RegExp(`\\b${banned}\\b`).test(direct),
      `הענף הישיר נוגע ב-${banned} — כלומר בקוד המשותף`,
    );
  }

  // וההיפך: ההרשאה נגזרת מהתפקיד, במפורש.
  assert.match(direct, /unlocked:\s*isManager\b/, "unlocked בענף הישיר אינו נגזר מהתפקיד");

  // ============================================================
  // ⚠️ roleGated לפי תפקיד, ולא `true` קבוע
  // ============================================================
  // כאן נדרש קודם `roleGated: true`, וזה היה **באג**: מנהל שלחץ "נעל" קיבל
  // את מסך התפקיד — "התפקיד שלך: מנהל · לשינוי התפקיד יש לפנות למנהל אחר" —
  // משפט חסר פשר במצב הזה, **ובלי שום דרך לפתוח בחזרה**. דלת בלי מפתח.
  //
  // מנהל שנעל חסום משום שביקש, לא בגלל תפקידו, ולכן הוא מגיע לטופס
  // הסיסמה. בקר נשאר עם מסך התפקיד, שהוא התשובה הנכונה עבורו.
  assert.match(direct, /roleGated:\s*!isManager/, "roleGated בענף הישיר אינו נגזר מהתפקיד");

  // ============================================================
  // ⚠️ **נעול כברירת מחדל, ונפתח בקוד בכל פתיחה** — וזו החלטת מוצר
  // ============================================================
  // הדרישה: "תמיד נעול, כל פעם צריך לכתוב את הסיסמה, אין בכלל אופציה נעל".
  // כלומר `unlocked` **אינו** נגזר מהתפקיד לבדו — נדרש גם אישור קוד שנעשה
  // בפתיחה הזו.
  //
  // ⚠️ ולכן דגל שנשמר בין פתיחות היה **שובר** את הדרישה: הוא היה זוכר
  // שנפתח ומדלג על הקוד בפעם הבאה. state שמת עם פירוק הרכיב הוא כאן
  // התנהגות **נכונה** ולא באג — ההפך מהתכנון הקודם, שבו "נעל" היה כפתור
  // וההיזכרות הייתה הדרישה.
  assert.match(direct, /unlocked:\s*isManager\s*&&\s*\w+/,
    "unlocked בענף הישיר אינו דורש אישור נוסף מעל התפקיד");
  assert.ok(
    !/sessionStorage|localStorage/.test(src),
    "הנעילה הישירה נשמרת בין פתיחות — הדרישה היא קוד בכל פתיחה",
  );

  // ⚠️ "אין בכלל אופציה נעל": הפעולה קיימת בחוזה כדי שהמסך לא ייפול על
  // קריאה חסרה, אבל היא חייבת להיות ריקה — כפתור שנועל מיותר כשממילא
  // נעול בכל פתיחה, והוא מה שהיה שבור קודם.
  //
  // ⚠️ נקרא **גולמי** ולא דרך `code()`: אותו helper מסיר `{}` (ניקוי שאריות
  // של הערות JSX), ולכן `lock: () => {}` מגיע אליו כ-`lock: () => ,` —
  // כלומר בדיוק הצורה שאני צריך לזהות נמחקת לפני הבדיקה.
  const rawHook = fs.readFileSync(path.join(SRC, "hooks/useAdmin.js"), "utf8");
  const rawDirect = rawHook.slice(rawHook.indexOf("if (useDirect)"));
  assert.match(rawDirect.slice(0, 600), /lock:\s*\(\)\s*=>\s*\{\s*\}/,
    "יש עדיין פעולת נעילה אמיתית — הדרישה היא שלא יהיה כפתור נעל");
});

test("⚠️ מסך הנעילה לא מציע להקליד קוד כשההרשאה לפי תפקיד", () => {
  const src = code("components/AdminPanel/AdminPanel.jsx");
  assert.ok(src, "AdminPanel.jsx חסר");

  assert.match(src, /roleGated/, "AdminPanel אינו קורא את roleGated");

  // ⚠️ הענף של roleGated חייב להופיע **לפני** מסך הקוד, אחרת בקר במצב
  // ישיר היה מקבל טופס שלא יעזור לו לעולם — ומסיק שהקליד שגוי.
  const roleBranch = src.indexOf("!unlocked && roleGated");
  const codeBranch = src.indexOf("handleUnlock}");
  assert.ok(roleBranch > 0, "אין ענף נעילה לפי תפקיד");
  assert.ok(
    roleBranch < codeBranch,
    "מסך הקוד מקדים את מסך התפקיד — בקר יקבל טופס חסר תוחלת",
  );

  // "שנה קוד מנהל" משנה סוד שאף כתיבה אינה שולחת יותר במצב ישיר.
  assert.match(
    src,
    /!roleGated\s*&&[\s\S]{0,200}שנה קוד מנהל/,
    "כפתור 'שנה קוד מנהל' אינו מוסתר במצב ישיר",
  );
});
