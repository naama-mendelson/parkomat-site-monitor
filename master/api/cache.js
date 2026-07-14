// api/cache.js — מטמון תגובות ל-endpoints של קריאה בלבד.
//
// ============================================================
// למה זה נחוץ דווקא עכשיו
// ============================================================
// ה-DB עבר לענן (Supabase, אירלנד), וסיבוב רשת בודד אליו עולה ~115ms.
// זו רצפה שאי אפשר לרדת מתחתיה בשום אופטימיזציית SQL — היא פיזיקה.
//
// אבל הנתונים משתנים *רק* כשמגיעה הודעה מאתר. בין הודעה להודעה, אותה
// בקשה תחזיר בדיוק את אותה תשובה. הדשבורד שולף מחדש בכל אירוע SSE, בכל
// החלפת תפקיד ובכל שינוי תקופה — ורוב השליפות האלה מיותרות לגמרי.
//
// לכן: שומרים את התגובה, ומבטלים את המטמון ברגע שמשהו באמת השתנה
// (bus 'siteUpdate' — נורה בקליטת הודעה, ברישום אתר, בתחזוקה ובמחיקה).
//
// TTL קצר בנוסף לביטול: חלק מהמדדים נמדדים "עד עכשיו" (זמינות, שעות
// השבתה), ולכן הם זזים קלות עם הזמן גם בלי נתון חדש. TTL של 10 שניות
// חוסם סחיפה כזו — 10 שניות מתוך שבוע הן שגיאה זניחה, ומעבר לכך התשובה
// מחושבת מחדש ממילא.
// ============================================================

const bus = require("../bus");

const TTL_MS = 10_000;

const store = new Map();   // url → { body, expires }
let hits = 0;
let misses = 0;

// כל שינוי אמיתי בנתונים מרוקן את המטמון. עדיף לרוקן הכול מלנסות לנחש
// אילו מפתחות הושפעו — אתר אחד שהשתנה משפיע על האגרגציות של כל המערכת.
bus.on("siteUpdate", () => {
  store.clear();
});

/**
 * Middleware: מגיש מהמטמון אם יש, ואחרת שומר את התגובה בדרך החוצה.
 * מוחל רק על GET, ורק על מסלולים שהם קריאה טהורה.
 */
function cacheMiddleware(req, res, next) {
  if (req.method !== "GET") return next();

  // SSE הוא זרם פתוח — אסור לגעת בו
  if (req.path === "/api/stream") return next();

  const key = req.originalUrl;
  const entry = store.get(key);

  if (entry && entry.expires > Date.now()) {
    hits++;
    res.setHeader("X-Cache", "HIT");
    return res.json(entry.body);
  }

  misses++;
  res.setHeader("X-Cache", "MISS");

  // עוטפים את res.json כדי לתפוס את הגוף בדרך החוצה
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    // שומרים רק תשובות תקינות. שגיאה במטמון הייתה נדבקת ל-10 שניות.
    if (res.statusCode === 200) {
      store.set(key, { body, expires: Date.now() + TTL_MS });
    }
    return originalJson(body);
  };

  next();
}

function getCacheStats() {
  return { size: store.size, hits, misses };
}

function clearCache() {
  store.clear();
}

module.exports = { cacheMiddleware, getCacheStats, clearCache };
