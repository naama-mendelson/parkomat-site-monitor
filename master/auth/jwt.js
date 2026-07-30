// auth/jwt.js — אימות וחתימה של JWT ב-HS256, על node:crypto בלבד.
//
// ============================================================
// למה לא ספרייה
// ============================================================
// HS256 הוא HMAC-SHA256 על "header.payload", ושלושים שורות מכסות אותו
// במלואו. הוספת תלות עבור זה הייתה מוסיפה משטח שדרוגים ואבטחה לכל אורך
// חיי הפרויקט — ובעיקר: הקובץ הזה חייב לרוץ **זהה** בשני מצבי האימות
// (Supabase ועצמי), כי הוא נקודת ההשוואה שמוכיחה שהם מחזירים אותו דבר.
// קוד שאני שולט בו הוא קוד שאפשר לבדוק בשני המסלולים בלי רשת ובלי Docker.
//
// ============================================================
// שני אלגוריתמים, ולא בגלל "ליתר ביטחון"
// ============================================================
// נכתב כאן קודם ש-HS256 מספיק ושאסימטרי "יתווסף כשיהיה צורך". הצורך הגיע
// מיד: הפרויקט ב-Supabase חותם ב-**ES256** ומפרסם מפתח ציבורי ב-JWKS
// (נבדק מול .well-known/jwks.json — alg: ES256, kty: EC, crv: P-256).
// כלומר ספק Supabase שמאמת HS256 מול סוד משותף לא היה מאמת שום אסימון
// אמיתי, אף פעם. זו הסיבה שיש כאן שני מסלולים:
//
//   HS256  — סימטרי, סוד משותף. המצב העצמי: אנחנו חותמים ואנחנו מאמתים.
//   ES256  — אסימטרי, מפתח ציבורי מ-JWKS. Supabase חותם, אנחנו רק מאמתים.
//
// היתרון של האסימטרי אינו רק תאימות: אין שום סוד לאמת בו, ולכן אין סוד
// לאחסן ואין סוד לדלוף. זו הסיבה ש-SUPABASE_JWT_SECRET אינו נדרש.
//
// שתי מלכודות שנסגרות למטה, ושתיהן חולשות JWT קלאסיות:
//   • ה-alg נאכף מבחוץ ולעולם אינו נקרא מהאסימון.
//   • אסימון ES256 אינו יכול להיות מאומת במסלול ה-HS256 ולהיפך, כי כל
//     מסלול דורש alg מדויק. בלי זה תוקף מגיש אסימון HS256 חתום במפתח
//     הציבורי המוכר, ומתקבל.
//
// **alg נאכף מבחוץ ולא נקרא מהאסימון.** קבלת ה-alg שכתוב ב-header היא
// חולשת ה-JWT הקלאסית: תוקף כותב alg:"none" (או מחליף ל-HS256 מול מפתח
// ציבורי מוכר) והחתימה מפסיקה להיות חסם. כאן ה-header נבדק *מול* HS256,
// והאסימון נדחה אם הוא מצהיר משהו אחר.

const crypto = require("crypto");

const b64urlEncode = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

/** חתימה — משמשת את המצב העצמי ואת הבדיקות. */
function sign(payload, secret, { expiresInSeconds = 3600 } = {}) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = { iat: now, exp: now + expiresInSeconds, ...payload };

  const encoded =
    `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(JSON.stringify(body))}`;
  const sig = crypto.createHmac("sha256", secret).update(encoded).digest();
  return `${encoded}.${b64urlEncode(sig)}`;
}

/**
 * אימות. מחזיר את המטענה, או null בכל כשל — בלי לזרוק ובלי להסביר מה
 * נכשל. הבחנה בין "חתימה שגויה" ל"פג תוקף" בהודעה לקורא היא דליפת מידע
 * שמסייעת לתוקף למשש את הגבול; מי שצריך לדעת מסתכל בלוג.
 *
 * @param opts.clockToleranceSeconds סובלנות לסחיפת שעונים. 0 כברירת מחדל:
 *        השרת מסנכרן NTP, ולכן אין סיבה לפתוח חלון.
 */
/** פירוק בלבד, בלי אימות. מוציא את החלקים כדי ששני המסלולים ישתפו אותם. */
function decode(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  try {
    const header = JSON.parse(b64urlDecode(h).toString("utf8"));
    const payload = JSON.parse(b64urlDecode(p).toString("utf8"));
    if (!header || !payload || typeof payload !== "object") return null;
    return { header, payload, signingInput: `${h}.${p}`, signature: b64urlDecode(s) };
  } catch {
    return null;   // base64/JSON פגום
  }
}

// בדיקות הזמן והמנפיק — משותפות לשני האלגוריתמים, כדי שלא ייווצר מסלול
// שמאמת חתימה אך שוכח שהאסימון פג.
function claimsValid(payload, { issuer, clockToleranceSeconds }) {
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && now > payload.exp + clockToleranceSeconds) return false;
  if (typeof payload.nbf === "number" && now + clockToleranceSeconds < payload.nbf) return false;
  // מנפיק שאינו מי שציפינו לו — אסימון תקין של מערכת אחרת אינו אסימון שלנו.
  if (issuer && payload.iss !== issuer) return false;
  return true;
}

function verify(token, secret, { issuer = null, clockToleranceSeconds = 0 } = {}) {
  if (typeof secret !== "string" || secret.length === 0) return null;

  const d = decode(token);
  if (!d) return null;

  // ה-alg נאכף, לא נקרא. אסימון ES256 לא ייכנס לכאן.
  if (d.header.alg !== "HS256") return null;

  const expected = crypto.createHmac("sha256", secret).update(d.signingInput).digest();
  // אורך שונה מפיל את timingSafeEqual, ולכן נבדק קודם.
  if (d.signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(d.signature, expected)) return null;

  return claimsValid(d.payload, { issuer, clockToleranceSeconds }) ? d.payload : null;
}

/**
 * אימות ES256 מול מפתח ציבורי (JWK מ-JWKS).
 *
 * @param resolveKey (kid) => Promise<crypto.KeyObject|null> — מחזיר מפתח לפי
 *        ה-kid שבכותרת. אסינכרוני כי JWKS נמשך מהרשת ונשמר במטמון.
 *
 * שתי נקודות שקל לטעות בהן:
 *   • dsaEncoding: 'ieee-p1363' — חתימת JWT היא r‖s גולמי (64 בתים), ולא
 *     DER. בלי הדגל הזה Node מצפה ל-DER וכל אימות תקין נכשל.
 *   • ה-kid חייב להתאים. אסימון בלי kid, או עם kid שאינו ב-JWKS, נדחה —
 *     ולא "מנסים את כל המפתחות", שזה בדיוק איך שמפתח שהוצא משימוש חוזר
 *     להיות קביל.
 */
async function verifyEs256(token, resolveKey, { issuer = null, clockToleranceSeconds = 0 } = {}) {
  const d = decode(token);
  if (!d) return null;
  if (d.header.alg !== "ES256") return null;
  if (typeof d.header.kid !== "string" || !d.header.kid) return null;

  let key;
  try {
    key = await resolveKey(d.header.kid);
  } catch {
    return null;   // כשל בהבאת JWKS אינו "אסימון תקין"
  }
  if (!key) return null;

  let ok = false;
  try {
    ok = crypto.verify(
      "sha256",
      Buffer.from(d.signingInput),
      { key, dsaEncoding: "ieee-p1363" },
      d.signature
    );
  } catch {
    return null;   // חתימה מעוותת
  }
  if (!ok) return null;

  return claimsValid(d.payload, { issuer, clockToleranceSeconds }) ? d.payload : null;
}

module.exports = { sign, verify, verifyEs256, decode, b64urlEncode, b64urlDecode };
