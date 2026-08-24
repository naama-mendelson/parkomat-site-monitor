// lib/totp.js — חישוב קוד TOTP לשערי בדיקה בלבד.
//
// ⚠️ אינו בשימוש בייצור. הוא קיים כדי ששער יוכל להוכיח את **המחזור
// המלא**: רישום גורם שני, קוד אמיתי, ואימות שהוא באמת מעלה ל-aal2.
// בלעדיו השער יכול להוכיח רק שהחסימה קיימת — לא שיש דרך לעבור אותה,
// וזה בדיוק ההבדל בין אבטחה לבין נעילה של כולם בחוץ.
const crypto = require("crypto");

function base32Decode(s) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of s.toUpperCase().replace(/=+$/, "").replace(/\s/g, "")) {
    const i = A.indexOf(c);
    if (i < 0) continue;
    bits += i.toString(2).padStart(5, "0");
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

/** קוד בן 6 ספרות לחלון של 30 שניות. offset מזיז חלונות (לבדיקת קוד ישן). */
function totp(secret, offset = 0) {
  const counter = Math.floor(Date.now() / 1000 / 30) + offset;
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const o = hmac[hmac.length - 1] & 0x0f;
  const n = ((hmac[o] & 0x7f) << 24) | (hmac[o + 1] << 16) | (hmac[o + 2] << 8) | hmac[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

module.exports = { totp, base32Decode };
