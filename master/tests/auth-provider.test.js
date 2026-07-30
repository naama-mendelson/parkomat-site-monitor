// tests/auth-provider.test.js — חוזה האימות, מול **שני** הספקים.
//
// ============================================================
// למה אותם מקרים רצים פעמיים
// ============================================================
// המצב העצמי אינו בשימוש. קוד רדום שאינו נבדק נרקב בשקט ונכשל בדיוק ביום
// שבו הוא נדרש — ולכן כל מקרה כאן רץ מול שני הספקים, ושניהם חייבים להחזיר
// את **אותה צורה** ולדחות את אותם קלטים.
//
// הבדיקות רצות במנותק לחלוטין: אין רשת, אין Docker, אין Supabase. אסימון
// נחתם מקומית באותו אלגוריתם שבו GoTrue חותם (HS256 מול הסוד המשותף),
// והאימות נבדק עליו.
//
// ⚠️ מה שבמפורש **אינו** נבדק כאן: זרימות ההרשמה, ההתחברות, אישור האימייל
// ואיפוס הסיסמה של Supabase. אלה המוצר שלהם, לא הקוד שלנו. בדיקה שלהם
// דורשת להרים את מחסנית ה-Docker שלהם ב-CI, נשברת בקצב השחרורים שלהם ולא
// בשלנו — וכשבדיקה נשברת מסיבות שאינן שלך, מפסיקים להסתכל בה. מה שנבדק
// הוא ה-seam: שאסימון תקין מתקבל וכל השאר נדחה.

const { test } = require("node:test");
const assert = require("node:assert");

const { sign } = require("../auth/jwt");

const SECRET = "test-secret-אין-לו-שימוש-בפרודקשן-0123456789";

// שני הספקים נטענים ישירות ולא דרך provider.js, כדי שהבדיקה לא תהיה תלויה
// ב-AUTH_PROVIDER של הסביבה. הסודות מוזרקים דרך env לפני ה-require.
process.env.SUPABASE_JWT_SECRET = SECRET;
process.env.AUTH_JWT_SECRET = SECRET;
process.env.AUTH_JWT_ISSUER = "parkomat";

const supabase = require("../auth/providers/supabase");
const selfhosted = require("../auth/providers/selfhosted");

// ספק Supabase אינו אוכף מנפיק כברירת מחדל (הוא נגזר מכתובת הפרויקט),
// והעצמי כן. לכן כל ספק מקבל את המנפיק שהוא מצפה לו.
const CASES = [
  { name: "supabase", provider: supabase, iss: undefined },
  { name: "selfhosted", provider: selfhosted, iss: "parkomat" },
];

const tokenFor = (claims, iss, opts) =>
  sign({ ...(iss ? { iss } : {}), ...claims }, SECRET, opts);

for (const { name, provider, iss } of CASES) {
  test(`${name}: אסימון תקין מתקבל, ובאותה צורה`, () => {
    const t = tokenFor({ sub: "user-1", email: "a@b.co", parkomat_role: "supervisor" }, iss);
    const r = provider.verifyToken(t);

    assert.ok(r, "אסימון תקין נדחה");
    assert.deepStrictEqual(Object.keys(r).sort(), ["email", "role", "userId"]);
    assert.strictEqual(r.userId, "user-1");
    assert.strictEqual(r.email, "a@b.co");
    assert.strictEqual(r.role, "supervisor");
  });

  test(`${name}: בלי parkomat_role — נופל ל-operator, לא לתפקיד גבוה`, () => {
    // ברירת מחדל שמרנית: אסימון בלי תפקיד מקבל צפייה, לא ניהול.
    const r = provider.verifyToken(tokenFor({ sub: "user-2" }, iss));
    assert.ok(r);
    assert.strictEqual(r.role, "operator");
    assert.strictEqual(r.email, null);
  });

  test(`${name}: אסימון שפג — נדחה`, () => {
    const t = tokenFor({ sub: "user-3" }, iss, { expiresInSeconds: -10 });
    assert.strictEqual(provider.verifyToken(t), null);
  });

  test(`${name}: חתימה שנגעו בה — נדחית`, () => {
    const t = tokenFor({ sub: "user-4" }, iss);
    const parts = t.split(".");
    // הופכים תו אחד בחתימה
    const sig = parts[2];
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    assert.strictEqual(provider.verifyToken(`${parts[0]}.${parts[1]}.${flipped}`), null);
  });

  test(`${name}: מטענה שנגעו בה בלי לחתום מחדש — נדחית`, () => {
    // התקיפה המעניינת: להעלות את התפקיד. החתימה מכסה את המטענה, ולכן
    // כל שינוי בה מפיל את האימות.
    const t = tokenFor({ sub: "user-5", parkomat_role: "operator" }, iss);
    const [h, , s] = t.split(".");
    const evil = Buffer.from(JSON.stringify({ sub: "user-5", parkomat_role: "executive", exp: 9e9 }))
      .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    assert.strictEqual(provider.verifyToken(`${h}.${evil}.${s}`), null);
  });

  test(`${name}: alg:"none" — נדחה`, () => {
    // חולשת ה-JWT הקלאסית: תוקף מצהיר שאין חתימה. ה-alg נאכף מבחוץ
    // ואינו נקרא מהאסימון, ולכן זה נדחה.
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const t = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "x", exp: 9e9 })}.`;
    assert.strictEqual(provider.verifyToken(t), null);
  });

  test(`${name}: אסימון שנחתם בסוד אחר — נדחה`, () => {
    const t = sign({ sub: "user-6", ...(iss ? { iss } : {}) }, "סוד-אחר-לגמרי-9876543210");
    assert.strictEqual(provider.verifyToken(t), null);
  });

  test(`${name}: קלט מעוות — null ולא חריגה`, () => {
    for (const bad of [null, undefined, "", "abc", "a.b", "a.b.c.d", 42, {}, "..", "x.y.z"]) {
      assert.strictEqual(provider.verifyToken(bad), null, `לא החזיר null עבור ${JSON.stringify(bad)}`);
    }
  });

  test(`${name}: sub חסר או ריק — נדחה`, () => {
    assert.strictEqual(provider.verifyToken(tokenFor({ email: "a@b.co" }, iss)), null);
    assert.strictEqual(provider.verifyToken(tokenFor({ sub: "" }, iss)), null);
  });

  test(`${name}: מוגדר כשיש סוד`, () => {
    assert.strictEqual(provider.isConfigured(), true);
  });
}

// ===== מה ששונה בין הספקים, ובכוונה =====

test("selfhosted: אכיפת מנפיק — אסימון של מערכת אחרת נדחה", () => {
  // אסימון תקין לחלוטין, חתום באותו סוד, אבל iss אחר. במצב עצמי זה נדחה:
  // אסימון של מערכת אחרת אינו אסימון שלנו.
  const t = sign({ sub: "user-7", iss: "מערכת-אחרת" }, SECRET);
  assert.strictEqual(selfhosted.verifyToken(t), null);
});

test("selfhosted: issueToken → verifyToken סוגר מעגל", () => {
  // המסלול שמוכיח שהמצב הרדום עובד מקצה לקצה, בלי רשת.
  const t = selfhosted.issueToken({ userId: "u-8", email: "c@d.co", role: "executive" });
  const r = selfhosted.verifyToken(t);
  assert.ok(r);
  assert.strictEqual(r.userId, "u-8");
  assert.strictEqual(r.role, "executive");
});

test("supabase: התחברות אינה חלק מה-seam", () => {
  // אסימטריה מכוונת, ולא השמטה: ב-Supabase ההתחברות קורית בדפדפן מול
  // GoTrue והשרת לא רואה סיסמה. הבדיקה מקבעת את זה כדי שלא "יתוקן" בטעות
  // ע"י הוספת signIn לספק אחד בלבד.
  assert.strictEqual(typeof supabase.issueToken, "undefined");
  assert.strictEqual(typeof selfhosted.issueToken, "function");
});

test("שני הספקים אינם מוגדרים בלי סוד — נכשל סגור", () => {
  // "לא מוגדר" חייב להיות "אין זהות" ולא "כולם מאומתים".
  const saved = [process.env.SUPABASE_JWT_SECRET, process.env.AUTH_JWT_SECRET];
  try {
    delete require.cache[require.resolve("../auth/providers/supabase")];
    delete require.cache[require.resolve("../auth/providers/selfhosted")];
    process.env.SUPABASE_JWT_SECRET = "";
    process.env.AUTH_JWT_SECRET = "";

    const sb = require("../auth/providers/supabase");
    const sh = require("../auth/providers/selfhosted");

    assert.strictEqual(sb.isConfigured(), false);
    assert.strictEqual(sh.isConfigured(), false);
    // אסימון תקין לגמרי — ובכל זאת null, כי אין במה לאמת אותו.
    const t = sign({ sub: "u", iss: "parkomat" }, SECRET);
    assert.strictEqual(sb.verifyToken(t), null);
    assert.strictEqual(sh.verifyToken(t), null);
  } finally {
    process.env.SUPABASE_JWT_SECRET = saved[0];
    process.env.AUTH_JWT_SECRET = saved[1];
    delete require.cache[require.resolve("../auth/providers/supabase")];
    delete require.cache[require.resolve("../auth/providers/selfhosted")];
  }
});

test("provider.js: ספק לא מוכר זורק עם רשימת הקיימים", () => {
  const saved = process.env.AUTH_PROVIDER;
  try {
    delete require.cache[require.resolve("../auth/provider")];
    process.env.AUTH_PROVIDER = "אין-כזה";
    assert.throws(() => require("../auth/provider"), /supabase.*selfhosted|selfhosted.*supabase/);
  } finally {
    process.env.AUTH_PROVIDER = saved;
    delete require.cache[require.resolve("../auth/provider")];
  }
});

test("provider.js: ברירת המחדל היא supabase — המצב הפעיל", () => {
  const saved = process.env.AUTH_PROVIDER;
  try {
    delete require.cache[require.resolve("../auth/provider")];
    delete process.env.AUTH_PROVIDER;
    const p = require("../auth/provider");
    assert.strictEqual(p.info().provider, "supabase");
  } finally {
    if (saved === undefined) delete process.env.AUTH_PROVIDER;
    else process.env.AUTH_PROVIDER = saved;
    delete require.cache[require.resolve("../auth/provider")];
  }
});

test("provider.js: AUTH_PROVIDER=selfhosted מחליף מצב בלי לגעת בקוד", () => {
  // זו כל הטענה של "החלפה היא שינוי הגדרה": משתנה סביבה אחד.
  const saved = process.env.AUTH_PROVIDER;
  try {
    delete require.cache[require.resolve("../auth/provider")];
    process.env.AUTH_PROVIDER = "selfhosted";
    const p = require("../auth/provider");
    assert.strictEqual(p.info().provider, "selfhosted");
  } finally {
    if (saved === undefined) delete process.env.AUTH_PROVIDER;
    else process.env.AUTH_PROVIDER = saved;
    delete require.cache[require.resolve("../auth/provider")];
  }
});
