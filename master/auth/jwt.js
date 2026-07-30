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
// ⚠️ HS256 בלבד, בכוונה. הפרויקט מאמת אסימונים שהוא או Supabase חתמו,
// ושניהם עם סוד משותף. RS256/ES256 ידרשו JWKS ומשיכת מפתחות ציבוריים —
// יתווסף כשיהיה צורך, לא "ליתר ביטחון".
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
function verify(token, secret, { issuer = null, clockToleranceSeconds = 0 } = {}) {
  if (typeof token !== "string" || typeof secret !== "string" || secret.length === 0) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [h, p, s] = parts;

  let header, payload;
  try {
    header = JSON.parse(b64urlDecode(h).toString("utf8"));
    payload = JSON.parse(b64urlDecode(p).toString("utf8"));
  } catch {
    return null;   // base64/JSON פגום
  }

  // ה-alg נאכף, לא נקרא. ראה ההסבר בראש הקובץ.
  if (!header || header.alg !== "HS256") return null;
  if (!payload || typeof payload !== "object") return null;

  const expected = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest();
  const actual = b64urlDecode(s);
  // אורך שונה מפיל את timingSafeEqual, ולכן נבדק קודם.
  if (actual.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(actual, expected)) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && now > payload.exp + clockToleranceSeconds) return null;
  if (typeof payload.nbf === "number" && now + clockToleranceSeconds < payload.nbf) return null;

  // מנפיק שאינו מי שציפינו לו — אסימון תקין של מערכת אחרת אינו אסימון שלנו.
  if (issuer && payload.iss !== issuer) return null;

  return payload;
}

module.exports = { sign, verify, b64urlEncode, b64urlDecode };
