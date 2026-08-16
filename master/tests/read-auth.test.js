// tests/read-auth.test.js — כל נתיבי הקריאה דורשים אימות.
//
// ============================================================
// למה זה נבדק כרשימה ולא כהתנהגות
// ============================================================
// ⚠️ נתיב חדש שנוסף בלי `requireAuth` **לא ייכשל בשום בדיקה אחרת** — הוא
// יעבוד מצוין, יחזיר נתונים, וייראה תקין לחלוטין. זה הכשל היחיד כאן שאין
// לו שום סימפטום.
//
// לכן הבדיקה קוראת את קובץ הנתיבים עצמו ומוודאת שכל `app.get("/api/...")`
// נושא שומר. היא מכוונת לתפוס **את הנתיב הבא שמישהו יוסיף**, לא את אלה
// שכבר קיימים.
//
// ============================================================
// מה זה מגן עליו
// ============================================================
// המסלול הישיר ל-Supabase מוגן ב-RLS. השרת מתחבר כ-postgres עם
// rolbypassrls — כלומר **הוא עוקף את RLS לגמרי**. נתיב פתוח בשרת נותן את
// כל הנתונים של כל האתרים לכל מי שיודע את הכתובת, בלי קשר למדיניות.
//
// זה היה מקובל כשהכל רץ ברשת פנימית מאותו origin. הפיצול לשני קונטיינרים
// והמעבר של הקבצים לאחסון חיצוני שוברים את שתי ההנחות.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROUTES = fs.readFileSync(path.join(__dirname, "..", "api", "routes.js"), "utf8");

/** כל שורות `app.get("/api/...")` עם רשימת ה-middleware שאחריהן. */
function readRoutes() {
  const out = [];
  for (const line of ROUTES.split(/\r?\n/)) {
    const m = line.match(/^app\.get\("(\/api\/[^"]*)",(.*)$/);
    if (m) out.push({ route: m[1], rest: m[2] });
  }
  return out;
}

test("יש נתיבי קריאה לבדוק (הבדיקה עצמה לא ריקה)", () => {
  // ⚠️ בלי זה, שינוי בפורמט של routes.js היה הופך את כל הקובץ הזה לבדיקה
  // שעוברת על אפס נתיבים — ירוקה, וחסרת ערך לחלוטין.
  assert.ok(readRoutes().length >= 15, `נמצאו ${readRoutes().length} נתיבים`);
});

test("⚠️ כל נתיב קריאה נושא שומר אימות", () => {
  const unguarded = readRoutes().filter(
    (r) => !/requireAuth\b|requireAuthSse\b|requireAdmin\b/.test(r.rest),
  );
  assert.deepEqual(unguarded.map((r) => r.route), [],
    "נתיבים ללא שומר — הם מחזירים את כל הנתונים לכל מי שיודע את הכתובת");
});

test("⚠️ האימות קודם למטמון", () => {
  // מטמון לפני אימות פירושו שבקשה **לא מאומתת** מקבלת תשובה שמורה ולעולם
  // אינה מגיעה לבדיקה. הנתיב נראה מוגן, והוא דולף בדיוק כמו קודם.
  const wrong = readRoutes().filter((r) => {
    const cache = r.rest.indexOf("cache(");
    const auth = r.rest.indexOf("requireAuth");
    return cache !== -1 && auth !== -1 && cache < auth;
  });
  assert.deepEqual(wrong.map((r) => r.route), [], "cache() לפני requireAuth");
});

test("נתיב ה-SSE מקבל את השומר שיודע לקרוא אסימון משאילתה", () => {
  // ⚠️ EventSource אינו יכול לשלוח כותרות — מגבלת דפדפן, לא בחירה. לכן
  // דווקא הנתיב הזה **לא** יכול להשתמש ב-requireAuth הרגיל, ושומר שגוי
  // עליו היה מנתק את כל העדכונים החיים.
  const sse = readRoutes().find((r) => r.route === "/api/stream");
  assert.ok(sse, "נתיב /api/stream קיים");
  assert.match(sse.rest, /requireAuthSse/);
});

test("⚠️ האסימון מנוקה מכתובות שנכתבות ללוג", () => {
  // הלוג מדפיס originalUrl, ולכן בלי הניקוי כל בקשת SSE איטית הייתה כותבת
  // אסימון תקף לקובץ. זו בדיוק הסיבה שאסימון ב-URL נחות מכותרת: הוא דולף
  // למקומות שאיש לא חשב עליהם.
  const m = ROUTES.match(/function redactUrl[\s\S]*?\n}/);
  assert.ok(m, "redactUrl קיימת");

  const redactUrl = new Function(`${m[0]}; return redactUrl;`)();

  assert.equal(redactUrl("/api/stream?access_token=eyJ.SECRET"), "/api/stream?access_token=***");
  assert.equal(redactUrl("/api/x?a=1&token=abc&b=2"), "/api/x?a=1&token=***&b=2");
  // ⚠️ מוחלף ולא נמחק: URL קטוע נראה כמו בקשה שגויה ומטעה מי שמנתח לוג.
  assert.match(redactUrl("/api/stream?access_token=X"), /access_token=/);
  // כתובת בלי סוד עוברת כמות שהיא.
  assert.equal(redactUrl("/api/sites"), "/api/sites");
});

test("⚠️ הגשת הקבצים הסטטיים נשארת פתוחה", () => {
  // מסך ההתחברות עצמו הוא קובץ סטטי. אילו express.static היה מוגן, המשתמש
  // היה צריך להיות מחובר כדי לקבל את הדף שבו מתחברים — נעילה מושלמת.
  const m = ROUTES.match(/app\.use\(express\.static\(([^)]*)\)/);
  assert.ok(m, "express.static קיים");
  assert.doesNotMatch(m[0], /requireAuth/);
});

// ============================================================
// צד הלקוח: דלת החירום חייבת לשלוח אסימון
// ============================================================
// ⚠️ **זה הבאג שנוצר מההגנה עצמה.** נתיבי הקריאה בשרת הוגנו, אבל
// `getJSON` — שדרכו עוברות כל 11 קריאות מסלול-השרת — שלח `fetch(url)`
// בלי כותרות. כלומר ההגנה לא אבטחה את דלת החירום, היא **סגרה** אותה.
//
// ⚠️ ולמה זה לא היה מתגלה: המסלול הזה רץ רק כש-VITE_SUPABASE_DIRECT=false,
// והוא כבוי היום. הכשל היה מחכה בדיוק ליום שבו מישהו הופך את המתג — כלומר
// כשמשהו כבר לא עובד ולוחצים.
const API_SRC = fs.readFileSync(
  path.join(__dirname, "..", "..", "dashboard", "src", "services", "api.js"), "utf8");

test("⚠️ getJSON שולח אסימון — אחרת מסלול השרת מחזיר 401", () => {
  const m = API_SRC.match(/function getJSON[\s\S]*?\n}/);
  assert.ok(m, "getJSON קיימת");
  assert.match(m[0], /authHeaders\(\)/,
    "getJSON חייבת לצרף כותרות אימות, אחרת כל נתיבי הקריאה מחזירים 401");
});

test("כתובת ה-API ניתנת להגדרה — אחרת הפיצול שובר את הקריאות", () => {
  // ⚠️ נתיב יחסי ("/api") מפנה לשרת שממנו הגיעו הקבצים. בפיצול לשני
  // קונטיינרים זה Apache, שאין בו API — והכשל שקט לגמרי.
  assert.match(API_SRC, /VITE_API_BASE/);
  assert.match(API_SRC, /export const API_ROOT/);
});

test("⚠️ CORS מתיר את כותרת ה-Authorization", () => {
  // בלי זה כל קריאה חוצת-origin נופלת ב-preflight, לפני שהיא מגיעה לשרת
  // בכלל — והשגיאה נראית כמו תקלת אימות ולא כמו CORS.
  const m = ROUTES.match(/Access-Control-Allow-Headers",\s*"([^"]*)"/);
  assert.ok(m, "הכותרת מוגדרת");
  assert.match(m[1], /Authorization/i);
});

// ============================================================
// ⚠️ העוזר הוא ממשק קריאה בשפה חופשית — ולכן הוא באותה רשימה
// ============================================================
// הבדיקות למעלה מכסות `app.get`. `/api/chat` הוא POST, ולכן הוא **נשמט
// מהן לגמרי** — ובדיוק שם היה החור: 17 נתיבי קריאה הוגנו, והנתיב שעונה
// על אותן שאלות בשפה חופשית נשאר פתוח.
//
// לעוזר שבעה כלים שקוראים מהמסד (get_all_sites, get_site_stats,
// get_executive_stats ועוד). מי שנחסם מ-/api/sites פשוט שואל אותו
// "תן לי את כל האתרים" ומקבל את אותו מידע.

/** שורת ההגדרה של נתיב, לפי המילה הפותחת. */
function routeLine(prefix) {
  return ROUTES.split(/\r?\n/).find((l) => l.startsWith(prefix));
}

test("⚠️ נתיב העוזר דורש אימות", () => {
  const line = routeLine('app.post("/api/chat"');
  assert.ok(line, "נתיב /api/chat קיים");
  assert.match(line, /requireAuth/,
    "העוזר חושף את אותם נתונים כמו נתיבי הקריאה");
});

test("⚠️ האימות קודם למגבלת הקצב", () => {
  // בקשה לא מאומתת אינה אמורה לצרוך מהמכסה של מישהו אחר — ומגבלת הקצב
  // כאן היא לפי IP, כלומר משרד שלם חולק אותה. וכל קריאה עולה כסף ב-Groq.
  const line = routeLine('app.post("/api/chat"');
  assert.ok(line.indexOf("requireAuth") < line.indexOf("chatRateLimit"),
    "requireAuth חייב להיות ראשון");
});

test("⚠️ מגבלת קצב אינה תחליף לאימות", () => {
  // ההגנה היחידה שהייתה על הנתיב הזה. היא מרסנת שימוש — היא אינה מונעת
  // גישה, והיא לפי IP: מי שמחליף IP מקבל מכסה חדשה.
  const line = routeLine('app.post("/api/chat"');
  assert.match(line, /chatRateLimit/, "המגבלה נשארת, בנוסף לאימות");
});

// ============================================================
// ⚠️ נתיב שהשרת מגן עליו — הלקוח חייב לשלוח אליו אסימון
// ============================================================
// `askAssistant` מזרימה NDJSON, ולכן היא **fetch עצמאי** ולא עוברת דרך
// getJSON כמו שאר הקריאות. כשנתיב הצ'אט הוגן, היא נשכחה — והבוט הפסיק
// לענות.
//
// ⚠️ והתסמין מטעה לגמרי: המשתמשת רואה "העוזר לא זמין כרגע", שנשמע כמו
// תקלה בשירות ה-AI. שום דבר לא מקשר אותו לשינוי האבטחה שגרם לו.
//
// ⚠️ **הכלל מדויק ולא גורף.** נתיבי הכתיבה (רישום אתר, תחזוקה, קוד מנהל)
// שולחים `x-admin-code` ולא אסימון Supabase — זו התנהגות מתועדת ומכוונת,
// ובדיקה שדורשת מהם אסימון הייתה נכשלת על קוד תקין. לכן הרשימה נגזרת
// מ-routes.js: מה שהשרת מגן עליו ב-requireAuth, ורק הוא.
test("⚠️ כל נתיב שמוגן ב-requireAuth מקבל אסימון מהלקוח", () => {
  // ⚠️ **שיטה + נתיב, ולא נתיב לבדו.** אותו נתיב קיים פעמיים: GET /api/sites
  // מוגן ב-requireAuth, ואילו POST /api/sites הוא כתיבה שמוגנת בקוד המנהל
  // (התנהגות מתועדת ומכוונת). התאמה לפי הנתיב בלבד דורשת אסימון גם מהכתיבה,
  // ואז הבדיקה נכשלת על קוד תקין.
  const norm = (p) => p.replace(/^\/api/, "").replace(/:[a-z]+/gi, ":x");

  const guarded = new Set(
    [...ROUTES.matchAll(/app\.(get|post)\("(\/api\/[^"]*)",\s*requireAuth\b/g)]
      .map((m) => `${m[1].toUpperCase()} ${norm(m[2])}`),
  );
  assert.ok(guarded.size >= 10, `נמצאו ${guarded.size} נתיבים מוגנים`);

  const calls = [...API_SRC.matchAll(/fetch\(`\$\{BASE\}([^`]*)`,\s*\{([\s\S]*?)\n\s*\}\)/g)];
  const bad = [];
  for (const m of calls) {
    const path = m[1].replace(/\$\{[^}]*\}/g, ":x");
    // ברירת המחדל של fetch היא GET כשלא צוינה שיטה.
    const method = (m[0].match(/method:\s*"(\w+)"/) || [, "GET"])[1].toUpperCase();
    if (guarded.has(`${method} ${path}`) && !/authHeaders\(\)/.test(m[0])) {
      bad.push(`${method} ${path}`);
    }
  }

  assert.deepEqual(bad, [],
    "נתיב מוגן שנקרא בלי אסימון יחזיר 401 — והתסמין ייראה כמו תקלה בשירות");
});

test("⚠️ נתיב הצ'אט ספציפית — הוא זה שנשבר", () => {
  const m = API_SRC.match(/fetch\(`\$\{BASE\}\/chat`[\s\S]*?\n\s*\}\)/);
  assert.ok(m, "הקריאה לצ'אט קיימת");
  assert.match(m[0], /authHeaders\(\)/,
    "askAssistant אינה עוברת ב-getJSON, ולכן היא חייבת לצרף כותרות בעצמה");
});

// ============================================================
// ניהול משתמשים — מותר למנהלים בלבד
// ============================================================
// ⚠️ עד עכשיו שני הנתיבים נשאו `requireAuth` בלבד, כלומר **כל מי שמחובר**
// — גם בקר — יכול היה להזמין ולהסיר אנשים. ההפרדה בין הקבוצות הייתה
// קיימת בנתונים ולא באכיפה.
//
// זה לא הורגש כי שני המשתמשים היחידים הם מנהלים, והוא היה מתגלה ביום
// שבו נוסף הבקר הראשון — כלומר בדיוק כשההפרדה מתחילה להיות משמעותית.
test("⚠️ כל נתיבי ניהול המשתמשים דורשים מנהל", () => {
  const lines = ROUTES.split(/\r?\n/).filter((l) => /^app\.\w+\("\/api\/users/.test(l));
  assert.ok(lines.length >= 3, `נמצאו ${lines.length} נתיבים`);

  for (const l of lines) {
    assert.match(l, /requireAuth/, l.slice(0, 50));
    assert.match(l, /requireManager/, l.slice(0, 50));
  }
});

test("⚠️ requireAuth קודם ל-requireManager", () => {
  // הסדר מפריד בין "מי אתה" (401) לבין "אינך רשאי" (403). הפוך, בקשה בלי
  // אסימון הייתה מגיעה לבדיקת התפקיד עם actor ריק ומקבלת 403 — תשובה
  // שאומרת למי שאינו מחובר שהוא "לא רשאי", ומטעה גם בלוג.
  const lines = ROUTES.split(/\r?\n/).filter((l) => /^app\.\w+\("\/api\/users/.test(l));
  for (const l of lines) {
    assert.ok(l.indexOf("requireAuth") < l.indexOf("requireManager"), l.slice(0, 50));
  }
});

test("⚠️ התפקיד נקרא מהטבלה ולא מהאסימון", () => {
  // `parkomat_role` באסימון נכתב פעם אחת ותקף שעה. מנהל שהושבת ממשיך
  // לשאת 'manager' עד שיפוג — שעה שלמה של הרשאה שגויה.
  const m = ROUTES.match(/async function requireManager[\s\S]*?\n\}/);
  assert.ok(m, "requireManager קיימת");
  assert.match(m[0], /getAppUserByUid/, "חייבת לקרוא את הטבלה");
  assert.doesNotMatch(m[0], /req\.actor\.role\s*===/, "אסור להכריע לפי האסימון");
});

test("⚠️ נתיב ההשבתה מאציל את הכלל למודול הטהור", () => {
  // ⚠️ **הבדיקה הקודמת כאן חיפשה את שם המשתנה `activeManagers` בקוד
  // הנתיב, ומוטציה שכיבתה את התנאי ל-`if (false)` שרדה אותה** — השם
  // נשאר. זו בדיוק הסיבה שהכלל עבר ל-auth/deactivation.js ונבדק שם
  // כהתנהגות ולא כנוכחות.
  //
  // מה שנשאר לבדוק כאן הוא רק החיווט: שהנתיב באמת מאציל אליו.
  const i = ROUTES.indexOf('app.patch("/api/users/:id"');
  assert.ok(i > 0, "נתיב ההשבתה קיים");
  // ⚠️ החלון רחב מספיק לשני הענפים. הוא היה 2000, וענף שינוי התפקיד
  // שנוסף לפניו דחף את canDeactivate החוצה — הבדיקה נכשלה על קוד תקין.
  const body = ROUTES.slice(i, i + 4000);
  assert.ok(body.includes("canDeactivate("), "הנתיב חייב להאציל את ההחלטה");
  assert.ok(body.includes("verdict.allowed"), "ולכבד את התשובה");
});

// ============================================================
// ⚠️ **שתי הפעולות קיימות — וההחלטה הזו התהפכה**
// ============================================================
// כאן ישבה בדיקה שאסרה נתיב מחיקה: "למשתמש יש עקבות בטבלת הביקורת ובכל
// חלון תחזוקה שהפעיל, ומחיקה הייתה משאירה שורות שמצביעות לשום מקום."
//
// ⚠️ **הנימוק התברר כלא נכון, וזו הסיבה שאפשר היה להפוך את ההחלטה.** אף
// שורה היסטורית אינה **מצביעה** על משתמש: `audit_log.actor_name` ו-
// `maintenance_windows.set_by_name` הם **צילומי טקסט בלי FK**. שורת
// ביקורת ממשיכה לומר מי עשה מה גם אחרי שהמשתמש נמחק.
//
// מה שכן היה מצביע — `created_by` ו-`disabled_by` — הם FK **פנימיים**
// בתוך app_users, וקיבלו ON DELETE SET NULL בסכמה.
//
// לכן נבדק עכשיו ההפך: ששתי הפעולות קיימות, ושהן נשארות **נבדלות**.
// מחיקה שמחליפה את ההשבתה הייתה מסירה את הפעולה ההפיכה היחידה.
test("⚠️ גם השבתה וגם מחיקה — ושתיהן נבדלות", () => {
  assert.match(ROUTES, /app\.patch\("\/api\/users\/:id"/, "השבתה — הפעולה ההפיכה");
  assert.match(ROUTES, /app\.delete\("\/api\/users\/:id"/, "מחיקה — הבלתי הפיכה");
});

// ============================================================
// כלל ההשבתה — נבדק כהתנהגות, לא כנוכחות
// ============================================================
// ⚠️ הגרסה הראשונה של הבדיקה חיפשה את שם המשתנה `activeManagers` בקוד
// הנתיב. מוטציה שכיבתה את התנאי ל-`if (false)` **שרדה** — השם נשאר.
// זו בדיוק הסיבה שכלל צריך לחיות בפונקציה טהורה.
const { canDeactivate } = require("../auth/deactivation");

const U = (id, role, active = true) => ({ id, role, is_active: active });

test("בקר רגיל ניתן להשבתה", () => {
  const users = [U(1, "manager"), U(2, "operator")];
  assert.equal(canDeactivate(users, 2, 1).allowed, true);
});

test("⚠️ מנהל אינו משבית את עצמו", () => {
  // אם הוא האחרון, אין מי שיחזיר אותו.
  const users = [U(1, "manager"), U(2, "manager")];
  const v = canDeactivate(users, 1, 1);
  assert.equal(v.allowed, false);
  assert.match(v.reason, /את עצמך/);
});

test("⚠️ המנהל הפעיל האחרון אינו ניתן להשבתה", () => {
  // בלי זה המערכת נשארת בלי אף מנהל — ואי אפשר להזמין, להחזיר או לתקן
  // כלום מהמסך. השחזור היחיד הוא ידני במסד.
  const users = [U(1, "manager"), U(2, "operator"), U(3, "manager", false)];
  const v = canDeactivate(users, 1, 2);
  assert.equal(v.allowed, false, "מנהל פעיל יחיד — חסום");
  assert.match(v.reason, /האחרון/);
});

test("מנהל אחד מתוך שניים פעילים — מותר", () => {
  const users = [U(1, "manager"), U(2, "manager")];
  assert.equal(canDeactivate(users, 2, 1).allowed, true);
});

test("⚠️ מנהל מושבת אינו נספר כמנהל פעיל", () => {
  // הספירה חייבת לסנן is_active — אחרת שני מנהלים שאחד מהם כבר מושבת
  // ייראו כשניים, והאחרון יושבת גם הוא.
  const users = [U(1, "manager"), U(2, "manager", false), U(3, "operator")];
  assert.equal(canDeactivate(users, 1, 3).allowed, false);
});

test("משתמש שאינו קיים", () => {
  assert.equal(canDeactivate([U(1, "manager")], 99, 1).allowed, false);
});

// ============================================================
// רשימת המשתמשים נבנית מ-app_users, לא מ-auth.users
// ============================================================
// ⚠️ הגרסה הקודמת שלפה ישירות מ-Supabase Admin, ויצרה שלוש אי-התאמות:
// `id` היה UUID בעוד PATCH מצפה למזהה מספרי; `role` הגיע מ-app_metadata
// — המקור שאינו הסמכות; ו-`is_active` לא היה קיים כלל.
//
// שלושתן שקטות: המסך היה נראה תקין, כפתור ההשבתה היה שולח מזהה שגוי,
// ומנהל שהורד לבקר היה מוצג כמנהל עד שאסימונו יפוג.
test("⚠️ GET /api/users נבנה מ-app_users", () => {
  const i = ROUTES.indexOf('app.get("/api/users", requireAuth, requireManager');
  assert.ok(i > 0, "הנתיב קיים");
  const body = ROUTES.slice(i, i + 2000);

  assert.ok(body.includes("listAppUsers()"), "הבסיס הוא הטבלה");
  assert.ok(body.includes("is_active"), "המסך חייב לדעת מי מושבת");
});

test("⚠️ כשל בשליפת זמני הכניסה אינו מפיל את הרשימה", () => {
  // זמן הכניסה מגיע מ-Supabase והוא מידע נוסף. הרשימה עצמה — מי קיים ומי
  // מושבת — חשובה יותר, ואסור שתיעלם כי שירות חיצוני לא ענה.
  const i = ROUTES.indexOf('app.get("/api/users", requireAuth, requireManager');
  const body = ROUTES.slice(i, i + 2000);
  const admin = body.indexOf("adminUsers.listUsers()");
  assert.ok(admin > 0, "הקריאה קיימת");

  // חייבת להיות עטופה ב-try משלה, לא רק ב-try החיצוני של ה-handler.
  const before = body.slice(0, admin);
  const tries = (before.match(/try \{/g) || []).length;
  assert.ok(tries >= 2, "הקריאה החיצונית עטופה ב-try נפרד");
});

// ============================================================
// שינוי תפקיד — אותה סכנה כמו השבתה, ולכן אותם שומרים
// ============================================================
// ⚠️ **הורדת מנהל לבקר מסירה את יכולת הניהול בדיוק כמו השבתה.** כלל שמגן
// רק על ההשבתה משאיר דלת פתוחה: מורידים את המנהל האחרון לבקר, והמערכת
// נשארת בלי אף אחד שיכול להחזיר — בדיוק המצב שהשומר השני נבנה למנוע.
const { canChangeRole } = require("../auth/deactivation");

const R = (id, role, active = true) => ({ id, role, is_active: active });

test("העלאה לתפקיד מנהל תמיד מותרת", () => {
  // היא אינה מפחיתה הרשאות מאיש.
  assert.equal(canChangeRole([R(1, "manager"), R(2, "operator")], 2, 1, "manager").allowed, true);
});

test("⚠️ אי אפשר להוריד את המנהל הפעיל האחרון", () => {
  const v = canChangeRole([R(1, "manager"), R(2, "operator")], 1, 2, "operator");
  assert.equal(v.allowed, false);
  assert.match(v.reason, /האחרון/);
});

test("⚠️ מנהל אינו מוריד את עצמו", () => {
  const v = canChangeRole([R(1, "manager"), R(2, "manager")], 1, 1, "operator");
  assert.equal(v.allowed, false);
  assert.match(v.reason, /עצמך/);
});

test("מנהל אחד מתוך שניים ניתן להורדה", () => {
  assert.equal(canChangeRole([R(1, "manager"), R(2, "manager")], 2, 1, "operator").allowed, true);
});

test("⚠️ מנהל מושבת אינו נספר כמנהל פעיל", () => {
  // אחרת שני מנהלים שאחד מהם מושבת נראים כשניים, והאחרון יורד גם הוא.
  const users = [R(1, "manager"), R(2, "manager", false), R(3, "operator")];
  assert.equal(canChangeRole(users, 1, 3, "operator").allowed, false);
});

test("תפקיד שאינו ברשימה נדחה", () => {
  // ⚠️ תפקיד שאינו ב-CHECK של app_users היה יוצר משתמש
  // ש-app.current_app_role() אינה מזהה — מישהו שאיש לא יודע מה מותר לו.
  for (const bad of ["admin", "supervisor", "", null]) {
    assert.equal(canChangeRole([R(1, "manager"), R(2, "operator")], 2, 1, bad).allowed, false);
  }
});

test("שינוי לתפקיד שכבר קיים נדחה", () => {
  assert.equal(canChangeRole([R(1, "manager"), R(2, "operator")], 2, 1, "operator").allowed, false);
});

test("⚠️ ההזמנה מעבירה תפקיד, וברירת המחדל היא בקר", () => {
  // ⚠️ **הגרסה הראשונה של הבדיקה הזו חיפשה /role/ באותיות קטנות**, והקוד
  // משתמש ב-wantRole. היא נכשלה על קוד תקין — הבדיקה הייתה שגויה, לא
  // המימוש. בדיקה שנשענת על שם משתנה מסוים שברירית מטבעה.
  //
  // מה שחשוב הוא ההתנהגות: התפקיד עובר, וכל ערך שאינו manager נופל לבקר.
  const i = ROUTES.indexOf('adminUsers.createUser(');
  assert.ok(i > 0, "הקריאה קיימת");

  const around = ROUTES.slice(Math.max(0, i - 400), i + 200);
  assert.ok(around.includes('"manager" ? "manager" : "operator"')
    || around.includes("=== \"manager\""),
    "התפקיד נגזר מהבקשה מול רשימה סגורה");
  assert.ok(around.includes('"operator"'), "ברירת המחדל היא בקר");
});
test("⚠️ PATCH מקבל is_active או role — לא שניהם", () => {
  // חצי עדכון (התפקיד השתנה וההשבתה נדחתה) הוא מצב שאיש לא ביקש.
  const i = ROUTES.indexOf('app.patch("/api/users/:id"');
  const body = ROUTES.slice(i, i + 2500);
  assert.ok(body.includes("canChangeRole("), "מאציל את הכלל");
  assert.ok(body.includes("לא שניהם"), "דוחה שליחה כפולה");
});

// ============================================================
// מחיקה — אותם מגנים כמו השבתה, ומסיבה חזקה יותר
// ============================================================
// ⚠️ מנהל שהשבית את עצמו בטעות ניתן להחזרה בידי מנהל אחר. מנהל שמחק את
// עצמו ואין אחר — אין דרך חזרה מהמסך **בכלל**, כי גם המשתמש ב-Supabase
// נעלם. לכן הכללים כאן זהים, ולא מקלים.
const { canDelete } = require("../auth/deactivation");

test("בקר רגיל ניתן למחיקה", () => {
  const users = [U(1, "manager"), U(2, "operator")];
  assert.equal(canDelete(users, 2, 1).allowed, true);
});

test("⚠️ מנהל אינו מוחק את עצמו", () => {
  const users = [U(1, "manager"), U(2, "manager")];
  const v = canDelete(users, 1, 1);
  assert.equal(v.allowed, false);
  assert.match(v.reason, /את עצמך/);
});

test("⚠️ המנהל הפעיל האחרון אינו ניתן למחיקה", () => {
  const users = [U(1, "manager"), U(2, "operator"), U(3, "manager", false)];
  const v = canDelete(users, 1, 2);
  assert.equal(v.allowed, false, "מנהל פעיל יחיד — חסום");
  assert.match(v.reason, /האחרון/);
});

test("⚠️ מנהל מושבת אינו נספר כמנהל פעיל — גם במחיקה", () => {
  // אותה מלכודת בדיוק כמו בהשבתה: שני מנהלים שאחד מהם מושבת נראים כשניים.
  const users = [U(1, "manager"), U(2, "manager", false), U(3, "operator")];
  assert.equal(canDelete(users, 1, 3).allowed, false);
});

test("מנהל אחד מתוך שניים פעילים — ניתן למחיקה", () => {
  const users = [U(1, "manager"), U(2, "manager")];
  assert.equal(canDelete(users, 2, 1).allowed, true);
});

test("משתמש שאינו קיים — אין מה למחוק", () => {
  assert.equal(canDelete([U(1, "manager")], 99, 1).allowed, false);
});

// ⚠️ הנתיב חייב **להאציל** את ההחלטה ולא לשכפל אותה. תנאי inline שמעתיק
// את הכלל מתיישן בשקט ברגע שהכלל משתנה — וזו בדיוק הסיבה שהכללים הוצאו
// ל-auth/deactivation.js מלכתחילה.
test("⚠️ DELETE /api/users מאציל ל-canDelete", () => {
  const src = fs.readFileSync(require.resolve("../api/routes.js"), "utf8");
  const start = src.indexOf('app.delete("/api/users/:id"');
  assert.ok(start > 0, "הנתיב חייב להתקיים");
  const body = src.slice(start, start + 2500);
  assert.ok(body.includes("canDelete("), "הנתיב חייב להאציל את ההחלטה");
  assert.ok(body.includes("requireManager"), "מחיקה למנהלים בלבד");
});

// ⚠️ **הסדר נבדק כהתנהגות ולא כהערה.** מחיקה במסד לפני Supabase משאירה,
// בכשל, משתמש שיכול להתחבר ואין לו שורה — מאומת ובלי זהות.
test("⚠️ המחיקה ב-Supabase קודמת למחיקה במסד", () => {
  const src = fs.readFileSync(require.resolve("../api/routes.js"), "utf8");
  const start = src.indexOf('app.delete("/api/users/:id"');
  const body = src.slice(start, start + 2500);
  const sb = body.indexOf("adminUsers.deleteUser");
  const local = body.indexOf("deleteAppUser(");
  assert.ok(sb > 0 && local > 0, "שני הצדדים חייבים להימחק");
  assert.ok(sb < local, "Supabase קודם — אחרת כשל משאיר משתמש בלי שורה");
});

// ============================================================
// אין כניסה במייל — החלטת מוצר, ונבדקת ככזו
// ============================================================
// ⚠️ שתי האפשרויות (קישור כניסה, איפוס סיסמה) הוסרו במלואן. הן היו
// בנויות ועבדו, ולכן קל מאוד להחזיר אחת מהן בטעות — למשל בשחזור מ-git,
// או במי שיראה את `setNewPassword` ויניח שהבקשה חסרה בשגגה.
//
// ⚠️ והנימוק נמדד ולא משוער: בלי SMTP מוגדר, Supabase נופל למיילר המובנה
// שלו ומחזיר `429 over_email_send_rate_limit` על הבקשה הראשונה. כלומר
// הכפתורים הבטיחו מייל שלא היה מגיע.
const LOGIN_JSX = fs.readFileSync(
  path.join(__dirname, "..", "..", "dashboard", "src", "components", "Login", "Login.jsx"), "utf8");
const AUTH_JS = fs.readFileSync(
  path.join(__dirname, "..", "..", "dashboard", "src", "services", "auth.js"), "utf8");

// ⚠️ ההערות מוסרות: שני הקבצים **מתעדים** את ההסרה ולכן מזכירים את השמות.
// בדיקת-מקור אינה מבחינה בין קוד לתיאור שלו — זה כבר הפיל בדיקה אחת כאן.
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

test("⚠️ מסך ההתחברות אינו מציע מייל בשום צורה", () => {
  const code = stripComments(LOGIN_JSX);
  assert.doesNotMatch(code, /sendMagicLink/, "קישור כניסה הוסר");
  assert.doesNotMatch(code, /requestPasswordReset/, "בקשת איפוס הוסרה");
  assert.doesNotMatch(code, /שכחתי את הסיסמה/, "הכפתור הוסר");
});

test("⚠️ ושתי הפונקציות אינן קיימות ב-seam", () => {
  const code = stripComments(AUTH_JS);
  assert.doesNotMatch(code, /export async function sendMagicLink/);
  assert.doesNotMatch(code, /export async function requestPasswordReset/);
});

// ⚠️ **וזה החצי שקל לשכוח.** לוח הבקרה של Supabase עדיין מציע
// "Send password recovery" לכל משתמש. קישור כזה פותח את הדשבורד במצב
// שחזור — ובלי המסך שמקבל אותו, המשתמש נכנס מחובר **ובלי שום דרך לקבוע
// סיסמה**. הסרת הבקשה אינה מצדיקה הסרת הקבלה.
test("⚠️ אבל מסך קביעת הסיסמה נשאר — הקישור עדיין יכול להגיע", () => {
  const code = stripComments(AUTH_JS);
  assert.match(code, /export async function setNewPassword/, "הקבלה חייבת להישאר");
  assert.match(code, /export function onPasswordRecovery/, "והזיהוי של מצב השחזור");
  assert.ok(fs.existsSync(path.join(__dirname, "..", "..", "dashboard",
    "src", "components", "Login", "ResetPassword.jsx")), "והמסך עצמו");
});

// מסך שמסיר אפשרות חייב לומר מה בא במקומה — אחרת מי ששכח סיסמה
// פשוט ינסה שוב ושוב בלי לדעת שיש דרך אחרת.
test("⚠️ והמסך אומר מה כן לעשות במקום", () => {
  assert.match(LOGIN_JSX, /פנו למנהל/, "חייב להיות מסלול התאוששות כתוב");
});
