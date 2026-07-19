// api/cache.js — מטמון תגובות ל-endpoints של קריאה בלבד.
//
// ==========================================================
// למה זה קיים
// ==========================================================
// ה-DB בענן, וסיבוב רשת אליו עולה ~115ms. הנתונים משתנים רק כשמגיעה הודעה
// מאתר; בין הודעה להודעה, אותה בקשה מחזירה בדיוק את אותה תשובה.
//
// ==========================================================
// שלוש בעיות שהיו בגרסה הקודמת, ותוקנו
// ==========================================================
// 1. **הוא היה app.use גלובלי** — כלומר הוא ישב לפני *כל* מסלול ולפני כל
//    אימות. אף GET לא היה מוגן אז שום דבר לא דלף בפועל, אבל ברגע שמישהו
//    היה מוסיף GET מאחורי requireAdmin, התגובה שלו הייתה מוגשת לכל אנונימי
//    למשך 10 שניות. עכשיו זה **opt-in לכל מסלול** — מפורש, לא מרומז.
//
// 2. **הוא היה בלי תקרה, וממופתח לפי ה-URL הגולמי.** `?x=1`, `?x=2`... כל
//    אחד יצר רשומה חדשה שנשארה לנצח (רשומות נמחקו רק ב-clear מלא). זו הייתה
//    התקפת DoS בשורה אחת. עכשיו: LRU עם תקרה, ומפתח שנבנה מ**רשימה לבנה**
//    של פרמטרים מוכרים — פרמטר לא מוכר פשוט לא משפיע על המפתח.
//
// 3. **בקנה מידה הוא לא עבד בכלל.** הוא התרוקן בכל הודעה מכל אתר; עם 200
//    אתרים מדווחים ברצף, ה-TTL של 10 שניות לעולם לא מבשיל, ואחוז הפגיעה
//    שואף לאפס. וגרוע מזה: אותו אירוע ששולח SSE לכל הדשבורדים גם מרוקן את
//    המטמון — כולם שולפים בו-זמנית לתוך מטמון ריק.
//
//    התשובה היא לא לוותר על הביטול (נכונות קודמת למהירות), אלא **single-flight**:
//    אם אותה שאילתה כבר רצה, הבקשות הנוספות *ממתינות לה* במקום להריץ אותה
//    שוב. חמישים דשבורדים ששולפים את המנהל הכללי אחרי אירוע SSE מייצרים
//    חישוב **אחד**. זה מה שבאמת מגן בעומס — ולא ה-TTL.

const bus = require("../bus");

const DEFAULT_TTL_MS = 10_000;
const MAX_ENTRIES = 200;          // תקרה קשיחה — LRU מפנה את הישן ביותר

// רק פרמטרים מוכרים משפיעים על המפתח. שאר ה-query string מתעלמים ממנו,
// ולכן אי אפשר לנפח את המטמון ע"י המצאת פרמטרים.
const KEY_PARAMS = [
  "period", "from", "to", "granularity", "groupBy",
  "sites", "statuses", "minFailureRate", "limit",
];

const store = new Map();          // key → { body, expires }  (Map שומר סדר הכנסה = LRU)
const inFlight = new Map();       // key → Promise<body>

let hits = 0;
let misses = 0;
let coalesced = 0;

// כל שינוי אמיתי בנתונים מרוקן את המטמון. אתר אחד שהשתנה משפיע על
// האגרגציות של כל המערכת, ולכן אין טעם לנחש אילו מפתחות הושפעו.
bus.on("siteUpdate", () => {
  store.clear();
});

function keyFor(req) {
  const parts = [req.path];
  for (const p of KEY_PARAMS) {
    if (req.query[p] !== undefined) parts.push(`${p}=${req.query[p]}`);
  }
  return parts.join("|");
}

function read(key) {
  const entry = store.get(key);
  if (!entry) return null;

  if (entry.expires <= Date.now()) {
    store.delete(key);            // פג תוקף — מפנים מיד, לא מחכים ל-clear
    return null;
  }

  // LRU: קריאה מרעננת את המיקום בסוף
  store.delete(key);
  store.set(key, entry);
  return entry.body;
}

function write(key, body, ttlMs) {
  store.set(key, { body, expires: Date.now() + ttlMs });

  // פינוי הישן ביותר (הראשון ב-Map) עד שחוזרים לתקרה
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
}

/**
 * Middleware של מטמון למסלול בודד — opt-in:
 *
 *     app.get("/api/sites", cache(), handler)
 *
 * מוחל רק על GET, ורק על תשובות 200 (תשובת שגיאה במטמון הייתה נדבקת ל-10 שניות).
 */
function cache(ttlMs = DEFAULT_TTL_MS) {
  return function cacheMiddleware(req, res, next) {
    if (req.method !== "GET") return next();

    const key = keyFor(req);

    // --- פגיעה ---
    const cached = read(key);
    if (cached !== null) {
      hits++;
      res.setHeader("X-Cache", "HIT");
      return res.json(cached);
    }

    // --- אותה שאילתה כבר רצה: ממתינים לה במקום להריץ שוב ---
    const pending = inFlight.get(key);
    if (pending) {
      coalesced++;
      return pending.then(
        (body) => {
          res.setHeader("X-Cache", "COALESCED");
          res.json(body);
        },
        // הראשון נכשל — לא מגישים שגיאה משותפת. פשוט מריצים את המסלול רגיל.
        () => next(),
      );
    }

    misses++;
    res.setHeader("X-Cache", "MISS");

    let settle;
    const promise = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    // בלי זה, דחייה שאיש לא ממתין לה הופכת ל-unhandled rejection ומפילה את התהליך
    promise.catch(() => {});
    inFlight.set(key, promise);

    const done = () => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    };

    // תופסים את הגוף בדרך החוצה
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode === 200) {
        write(key, body, ttlMs);
        settle.resolve(body);
      } else {
        settle.reject(new Error(`status ${res.statusCode}`));
      }
      done();
      return originalJson(body);
    };

    // רשת ביטחון: אם המסלול סיים בלי res.json (שגיאה, ניתוק) — משחררים
    // את הממתינים, אחרת הם היו תקועים לנצח.
    res.on("finish", () => {
      settle.reject(new Error("no json body"));
      done();
    });

    next();
  };
}

function getCacheStats() {
  const total = hits + coalesced + misses;
  return {
    size: store.size,
    hits,
    coalesced,
    misses,
    hitRate: total ? Math.round(((hits + coalesced) / total) * 100) : 0,
  };
}

function clearCache() {
  store.clear();
}

module.exports = { cache, getCacheStats, clearCache };
