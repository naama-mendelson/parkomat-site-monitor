// tests/page-all.test.js — עימוד השליפות מ-PostgREST.
//
// ============================================================
// ⚠️ למה זה נבדק
// ============================================================
// `pageAll` הוא הדרך היחידה שבה ארבעה מסלולים ישירים (executive,
// insights, activity, detail) מביאים יותר מ-1,000 שורות. עד עכשיו לא
// הייתה לו אף בדיקה — ומדובר בקוד שאם יפספס עמוד, המסך יציג "סה\"כ"
// שנראה סמכותי ופשוט קטן מהאמת. זה בדיוק הכשל שהקובץ שלו מתאר.
//
// ⚠️ הבדיקות האלה נכתבו כשהעימוד עבר מסדרתי למקבילי. הן מכסות את מה
// שהמעבר יכול לשבור: סדר השורות, זיהוי הסוף, וספירת הבקשות.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const MOD = pathToFileURL(
  path.join(__dirname, "..", "..", "dashboard", "src", "services", "pageAll.js")
).href;

const PAGE = 1000;

/**
 * בונה `build` מזויף מעל מערך שורות. סופר כמה בקשות נשלחו וכמה מהן
 * רצו במקביל — ⚠️ המקביליות היא כל הנקודה של השינוי, ובדיקה שסופרת רק
 * שורות הייתה עוברת גם על הגרסה הסדרתית האיטית.
 */
function fakeSource(total, { failAt = null, errorCode = null } = {}) {
  const all = Array.from({ length: total }, (_, i) => ({ i }));
  const stats = { requests: 0, maxParallel: 0, inFlight: 0, ranges: [] };

  const build = (from, to) => {
    stats.requests++;
    stats.ranges.push([from, to]);
    stats.inFlight++;
    stats.maxParallel = Math.max(stats.maxParallel, stats.inFlight);

    return {
      then(resolve) {
        // ⚠️ setTimeout ולא resolve מיידי: בלי הפסקה אמיתית, קריאות
        // "מקביליות" היו נפתרות בזו אחר זו ו-maxParallel היה תמיד 1 —
        // כלומר הבדיקה הייתה מדווחת ירוק על קוד סדרתי.
        setTimeout(() => {
          stats.inFlight--;
          if (errorCode && stats.requests >= (failAt ?? 1)) {
            resolve({ data: null, error: { code: errorCode, message: "boom" } });
            return;
          }
          resolve({ data: all.slice(from, to + 1), error: null });
        }, 5);
      },
    };
  };

  return { build, stats };
}

test("פחות מעמוד — בקשה אחת בלבד", async () => {
  const { pageAll } = await import(MOD);
  const { build, stats } = fakeSource(12);
  const { rows, capped } = await pageAll(build);

  assert.equal(rows.length, 12);
  assert.equal(capped, false);
  // ⚠️ בקשה אחת ולא חמש: רוב הקריאות במערכת קטנות, ואצווה מקבילה
  // בשבילן היא בזבוז שמחליף בעיה אחת באחרת.
  assert.equal(stats.requests, 1);
});

test("עמוד מלא בדיוק — נדרשת בקשה נוספת כדי לדעת שנגמר", async () => {
  const { pageAll } = await import(MOD);
  const { build } = fakeSource(PAGE);
  const { rows, capped } = await pageAll(build);

  assert.equal(rows.length, PAGE);
  assert.equal(capped, false);
});

test("שורות ארוכות — כל השורות חוזרות, ובסדר", async () => {
  const { pageAll } = await import(MOD);
  const total = 7597;                       // המספר האמיתי מ-status_history
  const { build } = fakeSource(total);
  const { rows, capped } = await pageAll(build);

  assert.equal(rows.length, total);
  assert.equal(capped, false);
  // ⚠️ הסדר הוא התכונה שהמקביליות הכי מסכנת. כל החישובים במורד הזרם
  // מניחים סדר כרונולוגי — קיפול ריצוד, מקטעים, דליים.
  for (let i = 0; i < total; i++) {
    assert.equal(rows[i].i, i, `שורה ${i} אינה במקומה`);
  }
});

test("העמודים נשלפים במקביל — זה כל השינוי", async () => {
  const { pageAll } = await import(MOD);
  const { build, stats } = fakeSource(7597);
  await pageAll(build);

  assert.ok(stats.maxParallel > 1,
    `maxParallel=${stats.maxParallel} — העימוד עדיין סדרתי`);
});

test("תקרה — capped כשנגמרות השורות המותרות", async () => {
  const { pageAll } = await import(MOD);
  // ⚠️ מקור אינסופי למעשה: יותר שורות מהתקרה. capped חייב להידלק,
  // אחרת המסך יציג סכום חלקי כאילו הוא מלא.
  const { build } = fakeSource(50000);
  const { rows, capped } = await pageAll(build, 3000);

  assert.equal(capped, true);
  assert.ok(rows.length >= 3000, `נשלפו ${rows.length}`);
});

test("תקרה שלא נגמרה — capped כבוי", async () => {
  const { pageAll } = await import(MOD);
  const { build } = fakeSource(2500);
  const { capped } = await pageAll(build, 20000);
  assert.equal(capped, false);
});

test("שגיאת הרשאה מתורגמת לעברית", async () => {
  const { pageAll } = await import(MOD);
  const { build } = fakeSource(5000, { errorCode: "42501" });
  await assert.rejects(() => pageAll(build), /נדרשת התחברות/);
});

test("שגיאה באמצע אצווה מקבילה אינה נבלעת", async () => {
  const { pageAll } = await import(MOD);
  // ⚠️ הכשל שמקביליות מזמינה: אחת מארבע בקשות נכשלת. Promise.all
  // דוחה — אבל רק אם לא עטפו אותו ב-catch שמחזיר מערך ריק, וזה בדיוק
  // ה"תיקון" הטבעי שהיה הופך שגיאה לנתונים חסרים בשקט.
  const { build } = fakeSource(9000, { failAt: 3, errorCode: "PGRST100" });
  await assert.rejects(() => pageAll(build), /boom/);
});
