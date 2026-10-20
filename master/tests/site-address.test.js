// tests/site-address.test.js — הכתובת שבשם האתר (shared/site-address.mjs), לחיפוש מיקום. השמות כאן — הכתיבים שנמדדו
// בייצור ב-20/10/2026 (כתובות רחוב, לא שמות אנשים).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSiteAddress, cityName, normCity, siteShortName } from "../../shared/site-address.mjs";

test("ערים: כל 35 הכתיבים שנמדדו בייצור מתורגמים לשם הרשמי", () => {
  const cases = [
    ['ת"א', "תל אביב-יפו"], ["ת''א", "תל אביב-יפו"], ['יפו ת"א', "תל אביב-יפו"], ["יפו", "תל אביב-יפו"],
    ["תל אביב-יפו", "תל אביב-יפו"],
    ['ר"ג', "רמת גן"], ["ר''ג", "רמת גן"], ["רמת גן", "רמת גן"],
    ['רשל"צ', "ראשון לציון"], ["רשל''צ", "ראשון לציון"], ["רשל'''צ", "ראשון לציון"], ["ראשלצ", "ראשון לציון"],
    ["ראשל''צ", "ראשון לציון"], ['ראשל"צ', "ראשון לציון"], ["ראשון לציון", "ראשון לציון"],
    ["ירושלים", "ירושלים"], ["י''ם", "ירושלים"], ["ירשלים", "ירושלים"],
    ["רמהש", "רמת השרון"], ["רמת השרון", "רמת השרון"], ["הודש", "הוד השרון"], ["הוד השרון", "הוד השרון"],
    ["כ''ס", "כפר סבא"], ["פ''ת", "פתח תקווה"], ['פ"ת', "פתח תקווה"],
    ["חולון", "חולון"], ["הרצליה", "הרצליה"], ["בת ים", "בת ים"], ["בת-ים", "בת ים"], ["רעננה", "רעננה"],
    ["גבעתיים", "גבעתיים"], ["יהוד", "יהוד"], ["נתניה", "נתניה"], ["רחובות", "רחובות"],
    ["ת״א", "תל אביב-יפו"], ["ר׳׳ג", "רמת גן"],   // גרשיים עבריים
  ];
  for (const [raw, want] of cases) assert.equal(cityName(raw), want, raw);
  assert.equal(cityName("עיר שלא קיימת"), null);
  assert.equal(cityName(""), null);
  // "ים" אינו "בת ים" ולהפך
  assert.equal(normCity("בת-ים"), "בת ים");
  assert.equal(cityName("ים"), "ירושלים");
});

test("פירוק: רחוב, מספר ועיר; סוגריים מוסרים", () => {
  assert.deepEqual(parseSiteAddress('הרצל 50, ת"א'), { street: "הרצל", number: 50, city: "תל אביב-יפו", cityRaw: 'ת"א', ok: true });
  assert.deepEqual(parseSiteAddress("רחובות הנהר 18, ר''ג"),
    { street: "רחובות הנהר", number: 18, city: "רמת גן", cityRaw: "ר''ג", ok: true });
  const p = parseSiteAddress('אוארבך 7, ת"א (בית הקשתות)');
  assert.deepEqual([p.street, p.number, p.city, p.ok], ["אוארבך", 7, "תל אביב-יפו", true]);
  assert.deepEqual(parseSiteAddress("  כל ישראל   חברים 10 ,  ת''א ").street, "כל ישראל חברים");
});

test("טווחים ושני מספרים — המספר הראשון; שני רחובות — הראשון", () => {
  const n = (s) => { const p = parseSiteAddress(s); return [p.street, p.number, p.ok]; };
  assert.deepEqual(n('בארט 19-11, ת"א'), ["בארט", 19, true]);
  assert.deepEqual(n('רבי עקיבא 5 - 7, ת"א'), ["רבי עקיבא", 5, true]);
  assert.deepEqual(n("בית לחם 12/10, חולון"), ["בית לחם", 12, true]);
  assert.deepEqual(n('שדרות ירושלים 92/94, ר"ג'), ["שדרות ירושלים", 92, true]);
  assert.deepEqual(n("מכבי 15/הגליל 16, רעננה"), ["מכבי", 15, true]);
  assert.deepEqual(n('ישראל בק 11-19, ת"א'), ["ישראל בק", 11, true]);
});

test("מה שלא מנחשים: בלי מספר, בלי עיר, עיר לא מוכרת, ריק", () => {
  assert.equal(parseSiteAddress('פלורנטין, ת"א').reason, "no_number");
  assert.equal(parseSiteAddress('נמל מסילות, ת"א').reason, "no_number");
  const noCity = parseSiteAddress("פייבל 17");
  assert.deepEqual([noCity.ok, noCity.reason, noCity.street, noCity.number], [false, "no_city", "פייבל", 17]);
  assert.equal(parseSiteAddress("הדקל 3, עיר בדויה").reason, "unknown_city");
  assert.equal(parseSiteAddress("").reason, "empty");
  assert.equal(parseSiteAddress(null).reason, "empty");
  assert.equal(parseSiteAddress("12, ת\"א").reason, "empty");   // מספר בלי רחוב
});

test("שם קצר להצגה ליד טכנאי: בלי העיר ובלי סוגריים", () => {
  assert.equal(siteShortName('הרצל 50, ת"א'), "הרצל 50");
  assert.equal(siteShortName('אוארבך 7, ת"א (בית הקשתות)'), "אוארבך 7");
  assert.equal(siteShortName("פייבל 17"), "פייבל 17");
  assert.equal(siteShortName(""), "");
});
