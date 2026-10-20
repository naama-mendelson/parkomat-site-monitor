// tools/geocode-sites.js — מיקום משוער לכל אתר, לפי הכתובת שבשם, מ-OpenStreetMap (Nominatim). (20/10/2026)
//
//   node --env-file=.env tools/geocode-sites.js              ← הרצה יבשה: מחפש (עם מטמון), מסכם, לא כותב כלום
//   node --env-file=.env tools/geocode-sites.js --apply      ← כותב דרך public.site_geo_import (לעולם לא דורס סימון ידני)
//   --only=1227,1102   רק האתרים האלה      --refresh   מחפש מחדש גם מה שבמטמון
//   --csv=<רשימת הפרויקטים של ויזנט>   גיבוי: הכתובת באנגלית לפי קוד הפרויקט, כשהחיפוש בעברית לא מצא (כתיב שונה ב-OSM)
//
// ============================================================
// ⚠️ למה, ומה נשלח
// ============================================================
// בעלת המוצר (20/10/2026): "רק מיקומים ולאיזה אתרים הם קרובים", ואחר כך "כן, עכשיו" להצעה משוערת מהכתובת לכל האתרים,
// שעורך מאשר או מתקן על המפה. לאף אתר לא היה מיקום.
// - **נשלחת הכתובת בלבד** (רחוב, מספר, עיר) — לא קוד אתר, לא שם לקוח.
// - **תנאי השימוש של Nominatim:** לכל היותר בקשה בשנייה (כאן 1.1 שניות), User-Agent שמזהה את האפליקציה, בלי שימוש כבד.
//   219 אתרים = כמה דקות, פעם אחת. המטמון (קובץ בתיקיית ה-tmp של המחשב, לא במאגר — הכתובות אינן לגיט) מונע חיפוש חוזר.
//   התוצאות ברישיון ODbL; המפה בדשבורד כבר מציגה "© OpenStreetMap".
// - ⚠️ לא גוגל: התנאים שלהם אוסרים לשמור את התוצאות או להציג אותן על מפה שאינה שלהם.
//
// ============================================================
// הדיוק — מה המסך יקרא "משוער"
// ============================================================
// house  = Nominatim החזיר נקודה באותה עיר, עם אותו מספר בית (או טווח שמכיל אותו).
// street = אותה עיר, אותו רחוב, בלי המספר — נקודה כלשהי ברחוב (נמדד: ברמת גן ובהוד השרון זה מה שחוזר לרוב).
// area   = שכונה / אזור.
// "משוער" במסך = street / area. אתר שלא נמצא, או שאין בשמו מספר או עיר (4 ב-20/10), נשאר בלי מיקום — לסימון ביד.
// ⚠️ עיר אחרת = לא נמצא: "הרצל" קיים בכל עיר, ותוצאה מעיר אחרת גרועה מאין תוצאה.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "Parkomat-SiteMonitor/1.0 (one-off geocoding of car-park site addresses)";
const GAP_MS = 1100;
const CACHE = path.join(os.tmpdir(), "parkomat-geocode-cache.json");
const IL = { latMin: 29.3, latMax: 33.4, lonMin: 34.2, lonMax: 35.95 };   // כמו sites_geo_shape

const normCityKey = (s) => String(s ?? "").replace(/["'״׳‘’“”`]/g, "").replace(/[-–־]/g, " ").replace(/\s+/g, " ").trim();

/** מספר הבית של התוצאה מתאים לשלנו: "50", "50א", טווח "48-52" שמכיל 50. */
function houseMatches(houseNumber, number) {
  const s = String(houseNumber ?? "").trim();
  if (!s || number == null) return false;
  const range = s.match(/^(\d+)\s*[-–]\s*(\d+)/);
  if (range) { const a = Number(range[1]), b = Number(range[2]); return number >= Math.min(a, b) && number <= Math.max(a, b); }
  const m = s.match(/^(\d+)/);
  return !!m && Number(m[1]) === number;
}

/** התוצאה באותה עיר שביקשנו (city / town / village / municipality, או בשם המלא). */
function sameCity(result, city) {
  const want = normCityKey(city);
  if (!want) return false;
  const a = result?.address || {};
  const names = [a.city, a.town, a.village, a.municipality, a.city_district].filter(Boolean).map(normCityKey);
  if (names.includes(want)) return true;
  // "תל אביב-יפו" מול "תל אביב יפו", ושמות שבהם העיר מופיעה רק ב-display_name
  return normCityKey(result?.display_name).split(",").map((x) => x.trim()).includes(want);
}

// מילים שאינן שם הרחוב עצמו ("שדרות ירושלים" = "שד׳ ירושלים" = "ירושלים"); ה׳ הידיעה בראש מילה של 4+ אותיות מושמטת
// ("הפלמח" = "פלמח"), כמו בכלי של 15/10.
const STREET_STOP = new Set(["רחוב", "רח", "שדרות", "שד", "דרך", "סמטת", "סמ", "כיכר", "שביל", "מעלה", "משעול"]);
const streetWords = (s) => normCityKey(s).split(" ").filter((w) => w && !STREET_STOP.has(w) && !/^[0-9]+$/.test(w))
  .map((w) => (w.length >= 4 && w.startsWith("ה") ? w.slice(1) : w));

// ⚠️ כתיב מלא וחסר: באותו רחוב OpenStreetMap ושם האתר כותבים אחרת — נמדד 20/10: "שנקין" / "שינקין", "וילנא" / "וילנה",
// "ארלוזרוב" / "ארלוזורוב", "כנרת" / "כינרת", "בורכוב" / "בורוכוב", "ז'בוטניסקי" / "ז'בוטינסקי". ההשוואה על השלד:
// בלי י׳ ו-ו׳, בלי גרש, ובלי א׳ / ה׳ בסוף המילה.
const skel = (w) => String(w).replace(/['׳`]/g, "").replace(/[יו]/g, "").replace(/[אה]$/, "");

/** התוצאה באותו רחוב: מילה משותפת של 3+ אותיות (לפי השלד), או כל מילות הרחוב כשהן קצרות ("תל חי", "חד נס"). */
function sameStreet(result, street) {
  const a = result?.address || {};
  const road = a.road || a.pedestrian || a.footway || a.square || "";
  const want = streetWords(street), got = new Set(streetWords(road).map(skel).filter(Boolean));
  if (!want.length || !got.size) return false;
  const common = want.filter((w) => skel(w) && got.has(skel(w)));
  return common.some((w) => w.length >= 3) || common.length === want.length;
}

/** הדיוק של תוצאה אחת: house / street / area. */
function precisionOf(result, number) {
  const rank = Number(result?.place_rank ?? 0);
  if (houseMatches(result?.address?.house_number, number) && rank >= 28) return "house";
  const type = String(result?.addresstype ?? result?.type ?? "");
  if (result?.category === "highway" || type === "road" || (rank >= 26 && rank <= 27)) return "street";
  if (rank >= 28) return "street";   // בניין בלי המספר שלנו — לא אותו בניין, אבל אותו רחוב
  return "area";
}

const ORDER = { house: 0, street: 1, area: 2 };

/** הבחירה מתוך תשובת Nominatim: באותה עיר, בתוך ישראל, הדיוק הטוב ביותר. null כשאין. */
function pickResult(results, parsed) {
  let best = null;
  for (const r of Array.isArray(results) ? results : []) {
    const lat = Number(r?.lat), lon = Number(r?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < IL.latMin || lat > IL.latMax || lon < IL.lonMin || lon > IL.lonMax) continue;
    if (!sameCity(r, parsed.city) || !sameStreet(r, parsed.street)) continue;
    const precision = precisionOf(r, parsed.number);
    if (!best || ORDER[precision] < ORDER[best.precision]) best = { lat: +lat.toFixed(6), lon: +lon.toFixed(6), precision };
  }
  return best;
}

/**
 * השאילתות לאתר, לפי הסדר; עוצרים כשנמצא הבניין:
 *   1. מובנית — רחוב + מספר, עיר;   2. טקסט חופשי בעברית;
 *   3. הכתובת באנגלית מרשימת הפרויקטים של ויזנט, כשיש ("Sheinkin St 74, Tel Aviv-Yafo") — עוקפת את הבדלי הכתיב בעברית;
 *   4. הרחוב בלי המספר — לפחות "משוער, לפי הרחוב".
 */
function buildQueries(parsed, english = "") {
  const common = { format: "jsonv2", addressdetails: "1", limit: "5", countrycodes: "il", "accept-language": "he" };
  const out = [
    new URLSearchParams({ ...common, street: `${parsed.number} ${parsed.street}`, city: parsed.city }),
    new URLSearchParams({ ...common, q: `${parsed.street} ${parsed.number}, ${parsed.city}` }),
  ];
  // ⚠️ טווח בכתובת האנגלית ("Arlozorov St 67-69, Bat Yam") — Nominatim לא מחזיר כלום; המספר הראשון כן (נמדד 20/10)
  const en = String(english ?? "").trim().replace(/(\d+)\s*[-–/]\s*\d+/, "$1");
  if (en) out.push(new URLSearchParams({ ...common, q: en }));
  out.push(new URLSearchParams({ ...common, street: parsed.street, city: parsed.city }));
  // ואחרון: הרחוב באנגלית בלי המספר ("Arlozorov St, Bat Yam") — כשהכתיב העברי ב-OSM שונה משלנו
  const enStreet = en.replace(/\s*\d+[א-תA-Za-z]?\b/g, "").replace(/\s+,/g, ",").replace(/\s+/g, " ").trim();
  if (enStreet && enStreet !== en) out.push(new URLSearchParams({ ...common, q: enStreet }));
  return out.map((p) => `${NOMINATIM}?${p}`);
}

/** רשימת הפרויקטים של ויזנט (CSV) → { קוד פרויקט: הכתובת באנגלית }. העמודות: מספר פרוייקט … project name (האחרונה). */
function parseProjectsCsv(text) {
  const rows = [];
  let cur = [], f = "", q = false;
  const s = String(text ?? "").replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { f += '"'; i++; }
      else if (ch === '"') q = false;
      else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { cur.push(f); f = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && s[i + 1] === "\n") i++; cur.push(f); rows.push(cur); cur = []; f = ""; }
    else f += ch;
  }
  if (f || cur.length) { cur.push(f); rows.push(cur); }
  const head = rows.shift() || [];
  const iCode = head.findIndex((h) => /מספר\s*פרו/.test(h)), iEn = head.findIndex((h) => /project name/i.test(h));
  const map = {};
  if (iCode < 0 || iEn < 0) return map;
  for (const r of rows) { const code = String(r[iCode] ?? "").trim(), en = String(r[iEn] ?? "").trim(); if (code && en) map[code] = en; }
  return map;
}

module.exports = { houseMatches, sameCity, sameStreet, precisionOf, pickResult, buildQueries, parseProjectsCsv };

// ============================================================
// ההרצה
// ============================================================
async function main() {
  const APPLY = process.argv.includes("--apply");
  const REFRESH = process.argv.includes("--refresh");
  const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").map((s) => s.trim()).filter(Boolean);
  const CSV = (process.argv.find((a) => a.startsWith("--csv=")) || "").slice(6);
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL חסר — node --env-file=.env tools/geocode-sites.js");
  // הכתובות באנגלית מרשימת הפרויקטים של ויזנט (קובץ מחוץ למאגר), לפי קוד הפרויקט = קוד האתר
  const english = CSV ? parseProjectsCsv(fs.readFileSync(CSV, "utf8")) : {};
  if (CSV) console.log(`(כתובות באנגלית מרשימת הפרויקטים: ${Object.keys(english).length})`);
  const { parseSiteAddress } = await import(pathToFileURL(path.join(__dirname, "..", "..", "shared", "site-address.mjs")).href);
  const { Client } = require("pg");

  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { cache = {}; }
  let last = 0;
  const get = async (url) => {
    if (!REFRESH && cache[url]) return cache[url];
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, "Accept-Language": "he" }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Nominatim ${res.status}`);
    const body = await res.json();
    cache[url] = body;
    try { fs.writeFileSync(CACHE, JSON.stringify(cache)); } catch { /* מטמון הוא נוחות */ }
    return body;
  };

  // ⚠️ חיבור קצר לכל שלב: החיפוש לוקח דקות (בקשה בשנייה), וה-pooler של Supabase סוגר חיבור שמחכה — בגרסה הראשונה זה
  // הפיל את הכלי באתר 80 מתוך 219 ("Connection terminated unexpectedly"). קוראים, סוגרים, מחפשים, ומתחברים שוב רק לכתיבה.
  const connect = async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    c.on("error", () => { /* חיבור שנסגר מהצד השני — השאילתה הבאה תיכשל ותגיד */ });
    await c.connect();
    return c;
  };
  let sites;
  {
    const db = await connect();
    try {
      // ⚠️ הרצה יבשה עובדת גם לפני שה-SQL הוחל (אין עדיין עמודות מיקום); --apply בלעדיהן — עוצר ואומר למה
      const hasGeo = (await db.query(`SELECT 1 FROM information_schema.columns
                                       WHERE table_schema = 'public' AND table_name = 'sites' AND column_name = 'geo_source'`)).rowCount > 0;
      if (!hasGeo && APPLY) throw new Error("עמודות המיקום עוד לא קיימות בייצור — קודם node --env-file=.env tools/apply-sql.js --apply");
      if (!hasGeo) console.log("(עמודות המיקום עוד לא קיימות בייצור — הרצה יבשה בלבד)");
      sites = (await db.query(`SELECT code, site_name, ${hasGeo ? "geo_source" : "NULL::text AS geo_source"} FROM sites ORDER BY code`)).rows;
    } finally { await db.end().catch(() => {}); }
  }
  if (ONLY.length) sites = sites.filter((s) => ONLY.includes(s.code));

  const rows = [], notFound = [], skipped = [], counts = { house: 0, street: 0, area: 0 };
  for (const s of sites) {
    if (s.geo_source === "manual") { skipped.push(`${s.code} | ${s.site_name} | סומן ביד — לא נוגעים`); continue; }
    const parsed = parseSiteAddress(s.site_name);
    if (!parsed.ok) { notFound.push(`${s.code} | ${s.site_name} | ${parsed.reason}`); continue; }
    let best = null;
    for (const url of buildQueries(parsed, english[s.code])) {
      let results;
      try { results = await get(url); } catch (e) { notFound.push(`${s.code} | ${s.site_name} | שגיאה: ${e.message}`); best = null; break; }
      const pick = pickResult(results, parsed);
      if (pick && (!best || ORDER[pick.precision] < ORDER[best.precision])) best = pick;
      if (best?.precision === "house") break;
    }
    if (!best) { if (!notFound.some((x) => x.startsWith(`${s.code} |`))) notFound.push(`${s.code} | ${s.site_name} | לא נמצא באותה עיר`); continue; }
    counts[best.precision]++;
    rows.push({ code: s.code, name: s.site_name, ...best });
    process.stdout.write(`\r${rows.length + notFound.length + skipped.length}/${sites.length}`);
  }
  process.stdout.write("\n");

  console.log(`\nאתרים: ${sites.length} · בניין: ${counts.house} · רחוב (משוער): ${counts.street} · אזור (משוער): ${counts.area} · ` +
              `לא נמצא: ${notFound.length} · סומנו ביד: ${skipped.length}`);
  if (notFound.length) console.log("\nלא נמצא — לסימון ביד:\n  " + notFound.join("\n  "));
  const approx = rows.filter((r) => r.precision !== "house");
  if (approx.length) console.log("\nמשוער (רחוב / אזור):\n  " + approx.map((r) => `${r.code} | ${r.name} | ${r.precision}`).join("\n  "));

  if (!APPLY) {
    console.log(`\nהרצה יבשה — לא נכתב כלום. לכתיבה: node --env-file=.env tools/geocode-sites.js --apply`);
    return;
  }
  const db = await connect();
  try {
    const r = await db.query("SELECT public.site_geo_import($1::jsonb) AS r",
      [JSON.stringify(rows.map(({ code, lat, lon, precision }) => ({ code, lat, lon, precision })))]);
    console.log("\n✅ נכתב:", JSON.stringify(r.rows[0].r));
  } finally { await db.end().catch(() => {}); }
}

if (require.main === module) {
  main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
}
