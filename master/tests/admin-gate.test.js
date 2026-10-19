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
  // 19/10/2026 (שלושה תפקידים): "יכול לערוך" — מנהל או עורך (canEdit) — ולא מנהל בלבד
  assert.match(direct, /unlocked:\s*editable\b/, "unlocked בענף הישיר אינו נגזר מהתפקיד");
  assert.match(src, /const editable = canEdit\(user\?\.role\)/, "editable אינו נגזר מ-canEdit");

  // ============================================================
  // ⚠️ roleGated לפי תפקיד, ולא `true` קבוע
  // ============================================================
  // כאן נדרש קודם `roleGated: true`, וזה היה **באג**: מנהל שלחץ "נעל" קיבל
  // את מסך התפקיד — "התפקיד שלך: מנהל · לשינוי התפקיד יש לפנות למנהל אחר" —
  // משפט חסר פשר במצב הזה, **ובלי שום דרך לפתוח בחזרה**. דלת בלי מפתח.
  //
  // מנהל שנעל חסום משום שביקש, לא בגלל תפקידו, ולכן הוא מגיע לטופס
  // הסיסמה. בקר נשאר עם מסך התפקיד, שהוא התשובה הנכונה עבורו.
  assert.match(direct, /roleGated:\s*!editable/, "roleGated בענף הישיר אינו נגזר מהתפקיד");

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
  assert.match(direct, /unlocked:\s*editable\s*&&\s*[(\w]/,
    "unlocked בענף הישיר אינו דורש אישור נוסף מעל התפקיד");
  // ⚠️ עד 19/10/2026 כאן נדרש שלא יישמר דבר בין פתיחות ("קוד בכל פתיחה"). בעלת המוצר הפכה את זה: "שזה יחזיק את הקוד
  // נגיד לפחות לכחצי שעה". הזיכרון חי ב-adminCodeDirect.js בלבד (הבדיקה הבאה), וה-hook עצמו לא נוגע באחסון.
  assert.ok(
    !/sessionStorage|localStorage/.test(src),
    "useAdmin ניגש לאחסון בעצמו — הזיכרון של חצי השעה הוא ב-adminCodeDirect.js בלבד",
  );
  assert.match(direct, /unlocked:\s*editable\s*&&\s*[(]\s*codeOkThisOpen\s*[|][|]\s*remembered\s*[)]/,
    "unlocked בענף הישיר אינו 'אושר בפתיחה הזו או בחצי השעה האחרונה'");

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

// ============================================================
// ⚠️ חצי שעה בלי להקיש שוב (19/10/2026) — התנהגות, לא רק טקסט
// ============================================================
// הפונקציות נשלפות מהקובץ ומורצות מול sessionStorage מדומה: הקובץ מייבא את supabase, ולכן אי אפשר לייבא אותו כאן.
// נבדק: חצי שעה בדיוק (הגבול הוא "לפני", לא "עד וכולל"), משתמש אחר אינו נהנה מהאישור, נשמר רק מועד התפוגה ולא הקוד,
// ואחסון חסום (מצב פרטי) נכשל בשקט ונועל — לא פותח.
function loadRemember(storage) {
  const raw = fs.readFileSync(path.join(SRC, "services/adminCodeDirect.js"), "utf8");
  const from = raw.indexOf("export const ADMIN_CODE_REMEMBER_MS");
  const fnStart = raw.indexOf("export function rememberAdminCode");
  const to = raw.indexOf("\n}", fnStart) + 2;
  assert.ok(from > 0 && fnStart > from && to > fnStart, "לא נמצאו פונקציות הזיכרון ב-adminCodeDirect.js");
  const body = raw.slice(from, to).replace(/export /g, "");
  return new Function("sessionStorage",
    body + "; return { ADMIN_CODE_REMEMBER_MS, adminCodeStillValid, rememberAdminCode };")(storage);
}
function fakeStorage() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

test("⚠️ קוד המנהל נזכר חצי שעה, לכל משתמש בנפרד, ונשמר רק מועד התפוגה", () => {
  const st = fakeStorage();
  const r = loadRemember(st);
  const MIN = 60e3, t0 = 1_800_000_000_000;
  assert.equal(r.ADMIN_CODE_REMEMBER_MS, 30 * MIN);
  assert.equal(r.adminCodeStillValid("u1", t0), false, "לפני אישור — נעול");
  r.rememberAdminCode("u1", t0);
  assert.equal(r.adminCodeStillValid("u1", t0 + 29 * MIN), true);
  assert.equal(r.adminCodeStillValid("u1", t0 + 30 * MIN - 1), true);
  assert.equal(r.adminCodeStillValid("u1", t0 + 30 * MIN), false, "בדיוק חצי שעה — כבר פג");
  assert.equal(r.adminCodeStillValid("u2", t0 + MIN), false, "משתמש אחר על אותו מסך — נעול");
  // רק מועד, ובמפתח של המשתמש
  assert.deepEqual([...st.m.keys()], ["parkomat.adminCodeOkUntil:u1"]);
  assert.equal(st.m.get("parkomat.adminCodeOkUntil:u1"), String(t0 + 30 * MIN));
  // חלון נע: אישור נוסף מאריך
  r.rememberAdminCode("u1", t0 + 20 * MIN);
  assert.equal(r.adminCodeStillValid("u1", t0 + 45 * MIN), true);
  // אחסון חסום — לא זורק, ונועל
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const b = loadRemember(broken);
  assert.doesNotThrow(() => b.rememberAdminCode("u1", t0));
  assert.equal(b.adminCodeStillValid("u1", t0), false);
  // ⚠️ sessionStorage ולא localStorage: סגירת הלשונית נועלת
  const raw = fs.readFileSync(path.join(SRC, "services/adminCodeDirect.js"), "utf8");
  const from = raw.indexOf("export const ADMIN_CODE_REMEMBER_MS");
  const block = raw.slice(from, raw.indexOf("\n}", raw.indexOf("export function rememberAdminCode")) + 2);
  assert.ok(/sessionStorage/.test(block) && !/localStorage/.test(block),
    "הזיכרון אינו ב-sessionStorage — ב-localStorage הוא היה שורד סגירת לשונית");
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
    // 19/10/2026: מנהל בלבד — roleGated כבר מכניס עורך, וקוד הניהול המשותף אינו של עורך
    /isManager\s*&&[\s\S]{0,200}שנה קוד מנהל/,
    "כפתור 'שנה קוד מנהל' אינו מוסתר ממי שאינו מנהל",
  );
});
