// shared/site-address.mjs — הכתובת שבשם האתר, מפורקת לחיפוש מיקום (20/10/2026).
//
// שם האתר הוא הכתובת היחידה שיש לנו: "<רחוב> <מספר>, <עיר או קיצור>" — "הרצל 50, ת"א", "רחובות הנהר 18, ר''ג". נמדד על
// 219 האתרים בייצור: 35 כתיבים של ערים (ת"א / ת''א / יפו ת"א, רשל"צ / רשל''צ / רשל'''צ / ראשלצ / ראשל"צ, ר"ג / ר''ג,
// י''ם / ירשלים, רמהש, הודש, בת-ים…), 11 טווחים ("19-11", "5 - 7", "12/10", "מכבי 15/הגליל 16"), ו-4 שאין בהם במה לחפש:
// בלי מספר ("פלורנטין, ת"א", "נמל מסילות, ת"א") או בלי עיר ("פייבל 17"). אלה לא מנוחשים — מסמנים אותם ביד על המפה.
//
// ⚠️ בלי \b: ב-JavaScript \b מכיר רק אותיות לטיניות, ולכן /\bר"ג\b/ לא תופס אף פעם עברית (כך קרה בכלי של 15/10).
// הקיצורים מזוהים על **כל** חלק העיר, אחרי נרמול גרשיים — לא בתוך טקסט חופשי.
// ⚠️ משמש את tools/geocode-sites.js (חיפוש ב-OpenStreetMap) ונבדק ב-master/tests/site-address.test.js.

/** שם העיר כמו ש-OpenStreetMap כותבים אותו בעברית, לפי הכתיב בשם האתר (אחרי normCity). */
const CITY_BY_KEY = {
  "תא": "תל אביב-יפו", "תל אביב": "תל אביב-יפו", "תל אביב יפו": "תל אביב-יפו", "יפו": "תל אביב-יפו", "יפו תא": "תל אביב-יפו",
  "תא יפו": "תל אביב-יפו",
  "רג": "רמת גן", "רמת גן": "רמת גן",
  "רשלצ": "ראשון לציון", "ראשלצ": "ראשון לציון", "ראשון לציון": "ראשון לציון",
  "ים": "ירושלים", "ירושלים": "ירושלים", "ירשלים": "ירושלים",
  "רמהש": "רמת השרון", "רמת השרון": "רמת השרון",
  "הודש": "הוד השרון", "הוד השרון": "הוד השרון",
  "כס": "כפר סבא", "כפר סבא": "כפר סבא",
  "פת": "פתח תקווה", "פתח תקווה": "פתח תקווה", "פתח תקוה": "פתח תקווה",
  "בב": "בני ברק", "בני ברק": "בני ברק",
  "קא": "קריית אונו", "קרית אונו": "קריית אונו", "קריית אונו": "קריית אונו",
  "חולון": "חולון", "בת ים": "בת ים", "הרצליה": "הרצליה", "רעננה": "רעננה", "גבעתיים": "גבעתיים", "יהוד": "יהוד",
  "נתניה": "נתניה", "רחובות": "רחובות", "נס ציונה": "נס ציונה", "גבעת שמואל": "גבעת שמואל", "אור יהודה": "אור יהודה",
  "ראש העין": "ראש העין", "מודיעין": "מודיעין-מכבים-רעות", "אשדוד": "אשדוד", "חיפה": "חיפה", "באר שבע": "באר שבע",
};

// גרשיים וגרש בכל הצורות (" ' ״ ׳ ‘ ’ “ ” ו-'' כפול), ומקף / רווחים מיותרים — מנורמלים לפני ההשוואה
const QUOTES = /["'״׳‘’“”`]/g;

/** מפתח עיר: בלי גרשיים, מקף = רווח, רווחים מצומצמים. "ר''ג" → "רג", "בת-ים" → "בת ים", "יפו ת"א" → "יפו תא". */
export function normCity(s) {
  return String(s ?? "").replace(QUOTES, "").replace(/[-–־]/g, " ").replace(/\s+/g, " ").trim();
}

/** העיר הרשמית לפי הכתיב, או null כשאינה מוכרת. */
export function cityName(raw) {
  return CITY_BY_KEY[normCity(raw)] ?? null;
}

/**
 * מפרק שם אתר. מחזיר תמיד אובייקט:
 *   { street, number, city, cityRaw, ok: true }                         — אפשר לחפש
 *   { street, number, city, cityRaw, ok: false, reason: "no_number" | "no_city" | "unknown_city" | "empty" }
 * - הסוגריים מוסרים ("אוארבך 7, ת"א (בית הקשתות)").
 * - טווח או שני מספרים — המספר הראשון ("בארט 19-11" → 19, "מכבי 15/הגליל 16" → מכבי 15).
 * - העיר היא מה שאחרי הפסיק האחרון; בלי פסיק — אין עיר (לא מנחשים: "פייבל 17").
 */
export function parseSiteAddress(name) {
  const clean = String(name ?? "").replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return { street: "", number: null, city: null, cityRaw: "", ok: false, reason: "empty" };
  const comma = clean.lastIndexOf(",");
  const cityRaw = comma >= 0 ? clean.slice(comma + 1).trim() : "";
  let streetPart = (comma >= 0 ? clean.slice(0, comma) : clean).trim();
  // שני רחובות ("מכבי 15/הגליל 16") — הראשון. "12/10" (שני מספרים באותו רחוב) נשאר עם המספר הראשון למטה.
  const slashStreet = streetPart.match(/^(.*?\d+)\s*\/\s*[^\d\s]/);
  if (slashStreet) streetPart = slashStreet[1];
  const m = streetPart.match(/^(.*?)(\d+)/);
  const street = (m ? m[1] : streetPart).replace(/\s+/g, " ").trim();
  const number = m ? Number(m[2]) : null;
  const city = cityRaw ? cityName(cityRaw) : null;
  const base = { street, number, city, cityRaw };
  if (!street) return { ...base, ok: false, reason: "empty" };
  if (number == null) return { ...base, ok: false, reason: "no_number" };
  if (!cityRaw) return { ...base, ok: false, reason: "no_city" };
  if (!city) return { ...base, ok: false, reason: "unknown_city" };
  return { ...base, ok: true };
}

/** השם הקצר להצגה ליד טכנאי: הרחוב והמספר, בלי העיר ("הרצל 50, ת"א" → "הרצל 50"). */
export function siteShortName(name) {
  const s = String(name ?? "").replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const comma = s.indexOf(",");
  return (comma >= 0 ? s.slice(0, comma) : s).trim() || s;
}
