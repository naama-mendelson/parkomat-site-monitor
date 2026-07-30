// tests/auth-provider.test.js — חוזה האימות, מול **שני** הספקים.
//
// ============================================================
// למה אותם מקרים רצים פעמיים
// ============================================================
// המצב העצמי אינו בשימוש. קוד רדום שאינו נבדק נרקב בשקט ונכשל בדיוק ביום
// שבו הוא נדרש — ולכן כל מקרה כאן רץ מול שני הספקים, ושניהם חייבים להחזיר
// את **אותה צורה** ולדחות את אותם קלטים.
//
// ============================================================
// כל ספק נבדק באלגוריתם שהוא באמת פוגש. זה תיקון של טעות אמיתית.
// ============================================================
// הגרסה הראשונה של הקובץ חתמה HS256 והזינה אותו לשני הספקים. זה "עבר",
// ובדיוק בכך היה הכשל: הפרויקט האמיתי ב-Supabase חותם **ES256** ומפרסם
// מפתח ציבורי ב-JWKS, כלומר ספק Supabase לא היה מאמת שום אסימון אמיתי אף
// פעם — והבדיקה הסתירה את זה במקום לחשוף אותו, כי היא בדקה אותו מול
// אסימונים שהיא עצמה המציאה.
//
// לכן:
//   supabase   → זוג מפתחות EC P-256 נוצר כאן, חתימת ES256, והמפתח הציבורי
//                מוזרק למטמון ה-JWKS (jwks._setCacheForTests). בלי רשת.
//   selfhosted → HS256 מול סוד משותף, כמו במציאות.
//
// המסקנה הכללית: בדיקת חוזה שממציאה את הקלט שלה בודקת את עצמה. הקלט חייב
// להיות באותו פורמט שהמערכת האמיתית מייצרת.
//
// ⚠️ מה שבמפורש **אינו** נבדק כאן: זרימות ההרשמה, ההתחברות, אישור האימייל
// ואיפוס הסיסמה של Supabase. אלה המוצר שלהם, לא הקוד שלנו. בדיקה שלהם
// דורשת להרים את מחסנית ה-Docker שלהם ב-CI, נשברת בקצב השחרורים שלהם ולא
// בשלנו — וכשבדיקה נשברת מסיבות שאינן שלך, מפסיקים להסתכל בה. מה שנבדק
// הוא ה-seam: שאסימון תקין מתקבל וכל השאר נדחה.

const { test } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

const { sign, b64urlEncode } = require("../auth/jwt");

const HS_SECRET = "test-secret-אין-לו-שימוש-בפרודקשן-0123456789";
const SUPABASE_URL = "https://test-project.supabase.co";
const SUPABASE_ISS = `${SUPABASE_URL}/auth/v1`;

process.env.AUTH_JWT_SECRET = HS_SECRET;
process.env.AUTH_JWT_ISSUER = "parkomat";
process.env.SUPABASE_URL = SUPABASE_URL;

const supabase = require("../auth/providers/supabase");
const selfhosted = require("../auth/providers/selfhosted");
const jwks = require("../auth/jwks");

// ===== חתימת ES256 לבדיקות, בלי רשת =====
const KID = "test-kid-1";
const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
jwks._setCacheForTests([[KID, publicKey]]);

function signEs256(payload, { kid = KID, key = privateKey, expiresInSeconds = 3600 } = {}) {
  const header = { alg: "ES256", typ: "JWT", kid };
  const now = Math.floor(Date.now() / 1000);
  const body = { iat: now, exp: now + expiresInSeconds, iss: SUPABASE_ISS, ...payload };
  const input = `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(JSON.stringify(body))}`;
  // ieee-p1363 — חתימת JWT היא r‖s גולמי ולא DER. ראה auth/jwt.js.
  const sig = crypto.sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `${input}.${b64urlEncode(sig)}`;
}

const signHs256 = (payload, opts) =>
  sign({ iss: "parkomat", ...payload }, HS_SECRET, opts);

// כל ספק והמפעל שמייצר לו אסימונים באלגוריתם שהוא באמת פוגש.
const CASES = [
  { name: "supabase", provider: supabase, mint: signEs256 },
  { name: "selfhosted", provider: selfhosted, mint: signHs256 },
];

for (const { name, provider, mint } of CASES) {
  test(`${name}: אסימון תקין מתקבל, ובאותה צורה`, async () => {
    const r = await provider.verifyToken(
      mint({ sub: "user-1", email: "a@b.co", parkomat_role: "supervisor" }));

    assert.ok(r, "אסימון תקין נדחה");
    assert.deepStrictEqual(Object.keys(r).sort(), ["email", "role", "userId"]);
    assert.strictEqual(r.userId, "user-1");
    assert.strictEqual(r.email, "a@b.co");
    assert.strictEqual(r.role, "supervisor");
  });

  test(`${name}: בלי parkomat_role — נופל ל-operator, לא לתפקיד גבוה`, async () => {
    // ברירת מחדל שמרנית: אסימון בלי תפקיד מקבל צפייה, לא ניהול.
    const r = await provider.verifyToken(mint({ sub: "user-2" }));
    assert.ok(r);
    assert.strictEqual(r.role, "operator");
    assert.strictEqual(r.email, null);
  });

  test(`${name}: אסימון שפג — נדחה`, async () => {
    assert.strictEqual(
      await provider.verifyToken(mint({ sub: "user-3" }, { expiresInSeconds: -10 })), null);
  });

  test(`${name}: חתימה שנגעו בה — נדחית`, async () => {
    const [h, p, s] = mint({ sub: "user-4" }).split(".");
    const flipped = (s[0] === "A" ? "B" : "A") + s.slice(1);
    assert.strictEqual(await provider.verifyToken(`${h}.${p}.${flipped}`), null);
  });

  test(`${name}: מטענה שנגעו בה בלי לחתום מחדש — נדחית`, async () => {
    // התקיפה המעניינת: להעלות את התפקיד. החתימה מכסה את המטענה, ולכן
    // כל שינוי בה מפיל את האימות.
    const [h, , s] = mint({ sub: "user-5", parkomat_role: "operator" }).split(".");
    const evil = b64urlEncode(JSON.stringify(
      { sub: "user-5", parkomat_role: "executive", exp: 9e9, iss: SUPABASE_ISS }));
    assert.strictEqual(await provider.verifyToken(`${h}.${evil}.${s}`), null);
  });

  test(`${name}: alg:"none" — נדחה`, async () => {
    // חולשת ה-JWT הקלאסית: תוקף מצהיר שאין חתימה. ה-alg נאכף מבחוץ
    // ואינו נקרא מהאסימון, ולכן זה נדחה.
    const t = `${b64urlEncode(JSON.stringify({ alg: "none", typ: "JWT", kid: KID }))}.` +
              `${b64urlEncode(JSON.stringify({ sub: "x", exp: 9e9, iss: SUPABASE_ISS }))}.`;
    assert.strictEqual(await provider.verifyToken(t), null);
  });

  test(`${name}: אסימון שנחתם במפתח אחר — נדחה`, async () => {
    const other = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    const t = name === "supabase"
      ? signEs256({ sub: "user-6" }, { key: other })          // מפתח EC אחר
      : sign({ sub: "user-6", iss: "parkomat" }, "סוד-אחר-לגמרי-9876543210");
    assert.strictEqual(await provider.verifyToken(t), null);
  });

  test(`${name}: קלט מעוות — null ולא חריגה`, async () => {
    for (const bad of [null, undefined, "", "abc", "a.b", "a.b.c.d", 42, {}, "..", "x.y.z"]) {
      assert.strictEqual(await provider.verifyToken(bad), null,
        `לא החזיר null עבור ${JSON.stringify(bad)}`);
    }
  });

  test(`${name}: sub חסר או ריק — נדחה`, async () => {
    assert.strictEqual(await provider.verifyToken(mint({ email: "a@b.co" })), null);
    assert.strictEqual(await provider.verifyToken(mint({ sub: "" })), null);
  });

  test(`${name}: מוגדר`, async () => {
    assert.strictEqual(provider.isConfigured(), true);
  });
}

// ===== מה ששונה בין הספקים, ובכוונה =====

test("supabase: אסימון HS256 נדחה — אי אפשר להחליף אלגוריתם", async () => {
  // התקיפה שהאכיפה מבחוץ מונעת: תוקף חותם HS256 במפתח הציבורי המוכר
  // ומצהיר alg:HS256. אם ה-alg היה נקרא מהאסימון, זה היה עובר.
  const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const t = sign({ sub: "attacker", iss: SUPABASE_ISS }, pubPem);
  assert.strictEqual(await supabase.verifyToken(t), null);
});

test("supabase: alg שאינו ES256 נדחה — גם כשהחתימה עצמה תקינה", async () => {
  // ============================================================
  // הבדיקה הזו נוספה אחרי שמוטציה חשפה שהיא חסרה
  // ============================================================
  // ביטול אכיפת ה-alg **לא הפיל** אף בדיקה. הסיבה: הבדיקות האחרות נפסלו
  // מסיבות אחרות — אסימון HS256 נפל על kid חסר, ו-alg:"none" נפל על חתימה
  // ריקה. כלומר האכיפה עצמה לא הייתה מכוסה.
  //
  // כאן היא מבודדת: כותרת שמצהירה RS256, kid תקין, ו**חתימת ECDSA תקינה
  // לגמרי** על אותו קלט. כל שאר הבדיקות עוברות עליה; רק אכיפת ה-alg פוסלת
  // אותה. הסירו את האכיפה — הבדיקה הזו תיפול.
  //
  // שווה לציין מה המוטציה גם לימדה: אכיפת ה-alg כאן היא **הגנה בעומק ולא
  // הבקרה העיקרית**. הבקרה העיקרית היא שאין ניתוב לפי אלגוריתם בכלל —
  // verifyEs256 מבצע ECDSA ותמיד ECDSA, ולכן אסימון HS256 נכשל על החתימה
  // גם בלי הבדיקה. זה העיצוב שמונע החלפת אלגוריתם מכל וכל.
  const header = b64urlEncode(JSON.stringify({ alg: "RS256", typ: "JWT", kid: KID }));
  const body = b64urlEncode(JSON.stringify({ sub: "u", exp: 9e9, iss: SUPABASE_ISS }));
  const input = `${header}.${body}`;
  const sig = crypto.sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" });

  assert.strictEqual(await supabase.verifyToken(`${input}.${b64urlEncode(sig)}`), null);
});

test("supabase: kid שאינו ב-JWKS — נדחה, ולא 'ננסה את כל המפתחות'", async () => {
  // מפתח שהוצא משימוש חוזר להיות קביל אם מנסים את כולם. לכן ה-kid מחייב.
  assert.strictEqual(await supabase.verifyToken(signEs256({ sub: "u" }, { kid: "no-such-kid" })), null);
});

test("supabase: אסימון בלי kid — נדחה", async () => {
  const header = b64urlEncode(JSON.stringify({ alg: "ES256", typ: "JWT" }));
  const body = b64urlEncode(JSON.stringify({ sub: "u", exp: 9e9, iss: SUPABASE_ISS }));
  const input = `${header}.${body}`;
  const sig = crypto.sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" });
  assert.strictEqual(await supabase.verifyToken(`${input}.${b64urlEncode(sig)}`), null);
});

test("supabase: מנפיק אחר — אסימון של פרויקט אחר אינו שלנו", async () => {
  assert.strictEqual(
    await supabase.verifyToken(signEs256({ sub: "u", iss: "https://other.supabase.co/auth/v1" })),
    null);
});

test("supabase: המנפיק נגזר מ-SUPABASE_URL", () => {
  assert.strictEqual(supabase.expectedIssuer(), SUPABASE_ISS);
});

test("selfhosted: אכיפת מנפיק — אסימון של מערכת אחרת נדחה", async () => {
  const t = sign({ sub: "user-7", iss: "מערכת-אחרת" }, HS_SECRET);
  assert.strictEqual(await selfhosted.verifyToken(t), null);
});

test("selfhosted: אסימון ES256 נדחה — גם בכיוון הזה האלגוריתם נאכף", async () => {
  assert.strictEqual(await selfhosted.verifyToken(signEs256({ sub: "u" })), null);
});

test("selfhosted: issueToken → verifyToken סוגר מעגל", async () => {
  // המסלול שמוכיח שהמצב הרדום עובד מקצה לקצה, בלי רשת.
  const r = await selfhosted.verifyToken(
    selfhosted.issueToken({ userId: "u-8", email: "c@d.co", role: "executive" }));
  assert.ok(r);
  assert.strictEqual(r.userId, "u-8");
  assert.strictEqual(r.role, "executive");
});

test("supabase: התחברות אינה חלק מה-seam", async () => {
  // אסימטריה מכוונת, ולא השמטה: ב-Supabase ההתחברות קורית בדפדפן מול
  // GoTrue והשרת לא רואה סיסמה. הבדיקה מקבעת את זה כדי שלא "יתוקן" בטעות
  // ע"י הוספת signIn לספק אחד בלבד.
  assert.strictEqual(typeof supabase.issueToken, "undefined");
  assert.strictEqual(typeof selfhosted.issueToken, "function");
});

test("שני הספקים אינם מוגדרים בלי הגדרה — נכשל סגור", async () => {
  // "לא מוגדר" חייב להיות "אין זהות" ולא "כולם מאומתים".
  const saved = [process.env.SUPABASE_URL, process.env.AUTH_JWT_SECRET];
  try {
    for (const m of ["../auth/providers/supabase", "../auth/providers/selfhosted", "../auth/jwks"]) {
      delete require.cache[require.resolve(m)];
    }
    process.env.SUPABASE_URL = "";
    process.env.AUTH_JWT_SECRET = "";

    const sb = require("../auth/providers/supabase");
    const sh = require("../auth/providers/selfhosted");

    assert.strictEqual(sb.isConfigured(), false);
    assert.strictEqual(sh.isConfigured(), false);
    assert.strictEqual(await sb.verifyToken(signEs256({ sub: "u" })), null);
    assert.strictEqual(await sh.verifyToken(signHs256({ sub: "u" })), null);
  } finally {
    process.env.SUPABASE_URL = saved[0];
    process.env.AUTH_JWT_SECRET = saved[1];
    for (const m of ["../auth/providers/supabase", "../auth/providers/selfhosted", "../auth/jwks"]) {
      delete require.cache[require.resolve(m)];
    }
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
    assert.strictEqual(require("../auth/provider").info().provider, "supabase");
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
    assert.strictEqual(require("../auth/provider").info().provider, "selfhosted");
  } finally {
    if (saved === undefined) delete process.env.AUTH_PROVIDER;
    else process.env.AUTH_PROVIDER = saved;
    delete require.cache[require.resolve("../auth/provider")];
  }
});
