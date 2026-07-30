// auth/jwks.js — משיכת מפתחות ציבוריים וקאשינג שלהם.
//
// ============================================================
// למה זה נדרש
// ============================================================
// Supabase חותם אסימונים ב-ES256 ומפרסם את המפתח הציבורי ב-
//     <SUPABASE_URL>/auth/v1/.well-known/jwks.json
// כלומר האימות אינו דורש שום סוד — רק את המפתח הציבורי. זה גם למה
// SUPABASE_JWT_SECRET אינו נדרש בפרויקט הזה: סוד שאינו נשמר אינו יכול לדלוף.
//
// ============================================================
// שלוש החלטות שמונעות תקלות אמיתיות
// ============================================================
// 1. **מטמון עם TTL.** משיכה לכל בקשה הייתה מוסיפה סיבוב רשת חוצה-אינטרנט
//    לכל אימות, ולהפוך את Supabase לנקודת כשל של כל קריאה מוגנת.
//
// 2. **משיכה מחדש על kid לא מוכר, אבל עם רצפה.** החלפת מפתחות (rotation)
//    מייצרת kid חדש שאינו במטמון, ובלי משיכה מחדש כל האסימונים החדשים היו
//    נדחים עד שה-TTL יפוג. מצד שני, בלי רצפה בין משיכות, מבול אסימונים
//    פגומים עם kid מומצא היה הופך אותנו למכונת הצפה נגד Supabase. הרצפה
//    היא מה שמונע מהתיקון להיות הבעיה הבאה.
//
// 3. **כשל במשיכה אינו "אסימון תקין" ואינו "אסימון פסול".** הוא כשל
//    זמני, ולכן הוא נזרק כלפי מעלה ומתורגם ל-null בשכבת האימות — לא
//    למטמון שלילי שינציח את הכשל.

const crypto = require("crypto");

const JWKS_TTL_MS = 10 * 60_000;        // מפתחות מתחלפים בקצב של חודשים
const REFETCH_FLOOR_MS = 30_000;        // הרצפה מסעיף 2
const FETCH_TIMEOUT_MS = 5_000;

let cache = new Map();                  // kid → crypto.KeyObject
let fetchedAt = 0;
let inFlight = null;                    // איחוד משיכות מקבילות

function jwksUrl() {
  const base = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  return base ? `${base}/auth/v1/.well-known/jwks.json` : null;
}

async function fetchJwks() {
  const url = jwksUrl();
  if (!url) throw new Error("auth: SUPABASE_URL לא מוגדר");

  // משיכה אחת בלבד גם אם עשר בקשות הגיעו יחד — אחרת בקשה ראשונה אחרי
  // התפוגה מייצרת מבול משיכות זהות.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`auth: JWKS החזיר ${res.status}`);
      const body = await res.json();
      if (!body || !Array.isArray(body.keys)) throw new Error("auth: JWKS בפורמט לא צפוי");

      const next = new Map();
      for (const jwk of body.keys) {
        if (!jwk || typeof jwk.kid !== "string") continue;
        // רק מפתחות חתימה. מפתח הצפנה שייכנס לכאן היה נכשל באימות בכל מקרה,
        // אבל עדיף לדחות אותו בשלב הזה ולא בשלב האימות.
        if (jwk.use && jwk.use !== "sig") continue;
        try {
          // Node תומך ב-JWK ישירות מגרסה 15 — בלי המרה ידנית של x/y.
          next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: "jwk" }));
        } catch {
          // מפתח בודד פגום לא יפיל את השאר
        }
      }
      if (next.size === 0) throw new Error("auth: JWKS בלי מפתחות שמישים");

      cache = next;
      fetchedAt = Date.now();
      return cache;
    } finally {
      clearTimeout(timer);
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * מחזיר מפתח ציבורי לפי kid, או null אם אינו קיים.
 * זורק רק כשהמשיכה עצמה נכשלה (ראה החלטה 3 בראש הקובץ).
 */
async function getKey(kid) {
  const fresh = Date.now() - fetchedAt < JWKS_TTL_MS;

  if (fresh && cache.has(kid)) return cache.get(kid);
  if (!fresh) await fetchJwks();
  if (cache.has(kid)) return cache.get(kid);

  // kid לא מוכר על מטמון טרי — ייתכן שהמפתחות התחלפו. משיכה מחדש, אך לא
  // יותר מפעם אחת לכל REFETCH_FLOOR_MS.
  if (Date.now() - fetchedAt > REFETCH_FLOOR_MS) {
    await fetchJwks();
    if (cache.has(kid)) return cache.get(kid);
  }

  return null;
}

function isConfigured() {
  return Boolean(jwksUrl());
}

// לבדיקות: מאפשר להזריק מפתחות בלי רשת, ולאפס בין מקרים.
function _setCacheForTests(keysByKid) {
  cache = new Map(keysByKid);
  fetchedAt = Date.now();
}
function _reset() {
  cache = new Map();
  fetchedAt = 0;
  inFlight = null;
}

module.exports = { getKey, isConfigured, jwksUrl, _setCacheForTests, _reset };
