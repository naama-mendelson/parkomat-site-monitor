// רשת הביטחון של משתמש השער נדרכת **לפני** השלבים שיכולים להיכשל.
//
// ============================================================
// ⚠️ למה זה קיים: אותו כשל, פעמיים, ובשנייה הרשת כבר הייתה שם
// ============================================================
// `gateToken` יוצר משתמש **מנהל פעיל בייצור** ומוחק אותו בסוף. בין
// היצירה למסירת ה-cleanup לקורא יש שני שלבים שיכולים לזרוק: עדכון
// התפקיד ב-app_users, וההתחברות.
//
// ⚠️ **פעם ראשונה:** כשל שם השאיר את gate1788088486802@parkomat.co.il
// בייצור — חשבון מנהל, עם הרשאה למחוק אתר ואת כל ההיסטוריה שלו. בעקבותיו
// נוספה רשת (uncaughtException / unhandledRejection / SIGINT).
//
// ⚠️ **פעם שנייה, 07/09/2026:** gate1788764563853@parkomat.co.il, אותו
// דבר בדיוק — **כי הרשת הותקנה אחרי `signIn`**. כשל לפניה הפיל את
// הקריאה בזמן שהרשת עוד לא נדרכה ו-cleanup עוד לא הוחזר, ואז אין מי
// שימחק. הרשת הייתה נכונה ובמקום הלא נכון.
//
// ⚠️ ובשתי הפעמים מי שתפס היה check-no-residue, יום אחרי. הבדיקה הזו
// תופסת את הסדר עצמו, לפני שמישהו מריץ משהו.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "tools", "lib", "gate-user.js"), "utf8");

const at = (needle) => {
  const i = SRC.indexOf(needle);
  assert.ok(i > 0, `לא נמצא בקוד: ${needle}`);
  return i;
};

test("⚠️ הרשת נדרכת אחרי היצירה ולפני ההתחברות", () => {
  const created = at("const uid = (await created.json()).id;");
  const net = at('process.on("uncaughtException"');
  const signin = at("token = await signIn(email, PW);");

  assert.ok(net > created,
    "הרשת מותקנת לפני שהמשתמש קיים — אין מה לנקות, והיא מיותרת שם");
  assert.ok(net < signin,
    "הרשת מותקנת אחרי ההתחברות — כשל ביניהם משאיר מנהל פעיל בייצור");
});

test("⚠️ שלבי הביניים עטופים ומנקים לפני שהם זורקים", () => {
  // החגורה השנייה: גם אם הרשת תוסר יום אחד, כשל בין היצירה למסירה
  // מנקה לפני שהוא ממשיך הלאה. בלי זה הקורא מקבל חריגה **ובלי**
  // cleanup — כלומר אין לו שום דרך לתקן.
  const created = at("const uid = (await created.json()).id;");
  const body = SRC.slice(created);

  const tryAt = body.indexOf("try {");
  const runAt = body.indexOf("await runAll();\n    throw e;");
  assert.ok(tryAt > 0, "אין try סביב שלבי הביניים");
  assert.ok(runAt > tryAt, "ה-catch אינו מנקה לפני שהוא זורק הלאה");
});

test("⚠️ הניקוי מוחק את שני הצדדים", () => {
  // מחיקת חשבון ה-auth בלבד משאירה שורת app_users יתומה — בדיוק המצב
  // ש-check-writes נופל עליו. שער שמייצר את התקלה שהוא בא לתפוס הוא
  // הגרוע שבכולם.
  const c = SRC.slice(at("const cleanup = async () => {"));
  assert.match(c.slice(0, 400), /admin\/users\/\$\{uid\}/);
  assert.match(c.slice(0, 400), /DELETE FROM app_users/);
});

test("⚠️ הניקוי אידמפוטנטי — השערים קוראים לו גם בעצמם", () => {
  // כל שער קורא cleanup במסלול היציאה שלו, והרשת קוראת לו שוב. בלי
  // השומר, הקריאה השנייה הייתה מנסה למחוק משתמש שכבר נמחק ומדפיסה
  // שגיאה שנראית כמו תקלה אמיתית.
  assert.match(SRC, /if \(done\) return;/);
});
