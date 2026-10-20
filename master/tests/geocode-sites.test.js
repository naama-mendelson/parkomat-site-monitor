// tests/geocode-sites.test.js — הבחירה מתוך תשובות OpenStreetMap (tools/geocode-sites.js). התשובות כאן בנויות בצורת
// התשובה של Nominatim (jsonv2 עם addressdetails); הכתובות — רחובות אמיתיים, בלי שמות לקוחות.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { houseMatches, sameCity, sameStreet, precisionOf, pickResult, buildQueries, parseProjectsCsv } = require("../tools/geocode-sites");

const res = (over = {}) => ({
  lat: "32.0700000", lon: "34.7800000", place_rank: 30, category: "place", addresstype: "building",
  display_name: "50, הרצל, תל אביב-יפו, ישראל",
  address: { house_number: "50", road: "הרצל", city: "תל אביב-יפו", country: "ישראל" },
  ...over,
});
const parsed = { street: "הרצל", number: 50, city: "תל אביב-יפו", ok: true };

test("מספר בית: זהה, עם אות, או טווח שמכיל אותו", () => {
  assert.equal(houseMatches("50", 50), true);
  assert.equal(houseMatches("50א", 50), true);
  assert.equal(houseMatches("48-52", 50), true);
  assert.equal(houseMatches("52-48", 50), true);
  assert.equal(houseMatches("51", 50), false);
  assert.equal(houseMatches("", 50), false);
  assert.equal(houseMatches(undefined, 50), false);
  assert.equal(houseMatches("50", null), false);
});

test("אותה עיר ואותו רחוב — אחרת התוצאה נפסלת", () => {
  assert.equal(sameCity(res(), "תל אביב-יפו"), true);
  assert.equal(sameCity(res({ address: { road: "הרצל", town: "רמת גן" }, display_name: "הרצל, רמת גן" }), "תל אביב-יפו"), false);
  assert.equal(sameCity(res({ address: { road: "הרצל" }, display_name: "50, הרצל, תל אביב-יפו, ישראל" }), "תל אביב-יפו"), true);
  assert.equal(sameStreet(res(), "הרצל"), true);
  assert.equal(sameStreet(res({ address: { road: "שדרות ירושלים" } }), "שדרות ירושלים"), true);
  assert.equal(sameStreet(res({ address: { road: "שדרות ירושלים" } }), "ירושלים"), true);
  assert.equal(sameStreet(res({ address: { road: "הפלמ\"ח" } }), "פלמח"), true);          // ה׳ הידיעה וגרשיים
  assert.equal(sameStreet(res({ address: { road: "תל חי" } }), "תל חי"), true);             // מילים קצרות — כולן
  assert.equal(sameStreet(res({ address: { road: "תל גיבורים" } }), "תל חי"), false);
  assert.equal(sameStreet(res({ address: { road: "אלנבי" } }), "הרצל"), false);
  assert.equal(sameStreet(res({ address: {} }), "הרצל"), false);
});

test("כתיב מלא וחסר: אותו רחוב גם כשהכתיב שונה (נמדד ב-20/10), אבל לא רחוב אחר", () => {
  const road = (r) => res({ address: { road: r, city: "תל אביב-יפו" } });
  for (const [ours, osm] of [["שנקין", "שינקין"], ["וילנא", "וילנה"], ["ארלוזרוב", "ארלוזורוב"], ["כנרת", "כינרת"],
                             ["בורכוב", "בורוכוב"], ["ז'בוטניסקי", "ז'בוטינסקי"], ["יהושוע בן נון", "יהושע בן נון"]]) {
    assert.equal(sameStreet(road(osm), ours), true, `${ours} / ${osm}`);
  }
  assert.equal(sameStreet(road("שינקין"), "סוקולוב"), false);
  assert.equal(sameStreet(road("ויצמן"), "ויצמן"), true);
  // עיר עם מקף עברי ומקף ארוך, כמו ש-OSM כותבים את תל אביב
  assert.equal(sameCity(res({ address: { road: "שינקין", city: "תל־אביב–יפו" } }), "תל אביב-יפו"), true);
});

test("רשימת הפרויקטים של ויזנט: קוד → הכתובת באנגלית; שדות במירכאות עם פסיקים", () => {
  const csv = "﻿מספר פרוייקט,שם פרויקט,סטטוס פרוייקט,project name\r\n" +
    "1400,\"שנקין 74, תל אביב-יפו\",4.3 בהסכם שירות,\"Sheinkin St 74, Tel Aviv-Yafo\"\r\n" +
    "3511,וילנא 9 תל אביב,4.3 בהסכם שירות,\n" +
    "1342,\"שפר 22-20, תל אביב-יפו\",4.3,\"Shefer St \"\"20-22\"\", Tel Aviv-Yafo\"";
  assert.deepEqual(parseProjectsCsv(csv), { 1400: "Sheinkin St 74, Tel Aviv-Yafo", 1342: 'Shefer St "20-22", Tel Aviv-Yafo' });
  assert.deepEqual(parseProjectsCsv("a,b\n1,2"), {});   // בלי העמודות — ריק, לא זריקה
  assert.deepEqual(parseProjectsCsv(""), {});
});

test("דיוק: בניין עם אותו מספר = house; רחוב או בניין אחר = street; שכונה = area", () => {
  assert.equal(precisionOf(res(), 50), "house");
  assert.equal(precisionOf(res({ address: { house_number: "52", road: "הרצל" } }), 50), "street");
  assert.equal(precisionOf(res({ place_rank: 26, category: "highway", addresstype: "road", address: { road: "הרצל" } }), 50), "street");
  assert.equal(precisionOf(res({ place_rank: 20, category: "place", addresstype: "suburb", address: {} }), 50), "area");
});

test("בחירה: הדיוק הטוב ביותר באותה עיר ואותו רחוב, בתוך ישראל; אחרת null", () => {
  const street = res({ lat: "32.0710", lon: "34.7810", place_rank: 26, category: "highway", addresstype: "road",
                       address: { road: "הרצל", city: "תל אביב-יפו" } });
  const otherCity = res({ lat: "32.0800", address: { house_number: "50", road: "הרצל", city: "רמת גן" }, display_name: "50, הרצל, רמת גן" });
  const otherStreet = res({ lat: "32.0900", address: { house_number: "50", road: "אלנבי", city: "תל אביב-יפו" } });
  assert.deepEqual(pickResult([street, otherCity, res()], parsed), { lat: 32.07, lon: 34.78, precision: "house" });
  assert.deepEqual(pickResult([otherCity, otherStreet, street], parsed), { lat: 32.071, lon: 34.781, precision: "street" });
  assert.equal(pickResult([otherCity, otherStreet], parsed), null);
  assert.equal(pickResult([res({ lat: "0", lon: "0" })], parsed), null);           // מחוץ לישראל
  assert.equal(pickResult([res({ lat: "34.78", lon: "32.07" })], parsed), null);   // הפוך
  assert.equal(pickResult([], parsed), null);
  assert.equal(pickResult(null, parsed), null);
  assert.deepEqual(pickResult([res({ lat: "32.07123456789", lon: "34.78123456789" })], parsed),
                   { lat: 32.071235, lon: 34.781235, precision: "house" });         // 6 ספרות
});

test("השאילתות: מובנית, טקסט חופשי, באנגלית כשיש, ואז הרחוב בלבד; רק הכתובת נשלחת, בעברית, בישראל", () => {
  const plain = buildQueries(parsed).map((u) => new URL(u));
  assert.equal(plain.length, 3);   // בלי כתובת באנגלית — שלוש
  const all = buildQueries(parsed, " Herzl St 50, Tel Aviv-Yafo ").map((u) => new URL(u));
  assert.equal(all.length, 5);
  const [a, b, c, d, e] = all;
  assert.equal(e.searchParams.get("q"), "Herzl St, Tel Aviv-Yafo");   // הרחוב באנגלית בלי המספר
  // טווח באנגלית — Nominatim לא מחזיר כלום על "67-69"; המספר הראשון
  const r = buildQueries({ street: "ארלוזרוב", number: 67, city: "בת ים" }, "Arlozorov St 67-69, Bat Yam").map((u) => new URL(u));
  assert.deepEqual([r[2].searchParams.get("q"), r[4].searchParams.get("q")], ["Arlozorov St 67, Bat Yam", "Arlozorov St, Bat Yam"]);
  assert.equal(a.origin + a.pathname, "https://nominatim.openstreetmap.org/search");
  assert.equal(a.searchParams.get("street"), "50 הרצל");
  assert.equal(a.searchParams.get("city"), "תל אביב-יפו");
  assert.equal(b.searchParams.get("q"), "הרצל 50, תל אביב-יפו");
  assert.equal(c.searchParams.get("q"), "Herzl St 50, Tel Aviv-Yafo");
  assert.equal(d.searchParams.get("street"), "הרצל");   // בלי המספר
  assert.equal(d.searchParams.get("city"), "תל אביב-יפו");
  for (const u of [a, b, c, d]) {
    assert.equal(u.searchParams.get("countrycodes"), "il");
    assert.equal(u.searchParams.get("accept-language"), "he");
    assert.equal(u.searchParams.get("format"), "jsonv2");
    // שום דבר מעבר לכתובת: לא קוד אתר ולא שם לקוח
    const keys = [...u.searchParams.keys()].sort();
    assert.ok(JSON.stringify(keys) === JSON.stringify(["accept-language", "addressdetails", "city", "countrycodes", "format", "limit", "street"])
           || JSON.stringify(keys) === JSON.stringify(["accept-language", "addressdetails", "countrycodes", "format", "limit", "q"]), keys.join());
  }
});
