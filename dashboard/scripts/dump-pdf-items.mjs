// scripts/dump-pdf-items.mjs — PDF → קובץ *.items.json בצורה שהבדיקות של המפענח קוראות.
//
// הצורה היא בדיוק מה ש-getTextContent מחזיר בדפדפן, מצומצם לשדות שהמפענח
// קורא: [{ items: [{ str, dir, transform, width, height, hasEOL }] }, ...]
// כך ש-shared/parse-inspection.mjs רץ בבדיקה על אותו קלט שהמסך יקבל.
//
// ⚠️ **ברירת המחדל מאפסת מספרי טלפון** (באותו אורך — המיקום והרוחב לא
// משתנים). הכלי נועד גם לתסקירים אמיתיים, ושם טלפון של בודק או של לקוח
// הוא פרט אישי שאסור שייכנס לריפו. `--raw` מבטל, לבדיקה מקומית בלבד.
// ⚠️ זה *לא* מנקה שמות, כתובות או פרטי חשבונית — את אלה בודקים בעיניים
// לפני commit. ה-fixtures האמיתיים נוקו כך, ועמוד החשבונית שלהם הוחלף.
//
//   cd dashboard && node scripts/dump-pdf-items.mjs <in.pdf> <out.items.json> [--raw]
import { readFileSync, writeFileSync } from "node:fs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const args = process.argv.slice(2);
const raw = args.includes("--raw");
const [input, output] = args.filter((a) => !a.startsWith("--"));
if (!input || !output) {
  console.error("usage: node scripts/dump-pdf-items.mjs <in.pdf> <out.items.json> [--raw]");
  process.exit(2);
}

const PHONE = /0\d{1,2}-?\d{7}/g;
const zero = (s) => s.replace(/\d/g, "0");
const scrub = (s) => s.replace(PHONE, zero);

// ⚠️ pdfjs מפצל מספרים לכמה פריטים ("050-696", "88", "50"), ולכן ניקוי פריט-פריט
// מפספס. רצף פריטים שכולם ספרות/מקף, שהחיבור שלהם הוא טלפון — כולם מאופסים.
const DIGITISH = /^[\d-]+$/;
function scrubSplitPhones(items) {
  for (let i = 0; i < items.length; i++) {
    if (!DIGITISH.test(items[i].str)) continue;
    let j = i;
    let joined = "";
    while (j < items.length && DIGITISH.test(items[j].str)) { joined += items[j].str; j++; }
    if (/0\d{1,2}-?\d{7}/.test(joined)) for (let k = i; k < j; k++) items[k].str = zero(items[k].str);
    i = j - 1;
  }
  return items;
}

const task = getDocument({ data: new Uint8Array(readFileSync(input)), isEvalSupported: false, verbosity: 0 });
const doc = await task.promise;
const pages = [];
for (let p = 1; p <= doc.numPages; p++) {
  const tc = await (await doc.getPage(p)).getTextContent();
  // פריטי סימון (includeMarkedContent) אין להם str — הם לא טקסט ולא נשמרים
  const items = tc.items.filter((it) => typeof it.str === "string").map((it) => ({
    str: raw ? it.str : scrub(it.str), dir: it.dir, transform: it.transform, width: it.width, height: it.height, hasEOL: it.hasEOL,
  }));
  pages.push({ items: raw ? items : scrubSplitPhones(items) });
}
await task.destroy();

writeFileSync(output, JSON.stringify(pages));
const n = pages.reduce((a, p) => a + p.items.length, 0);
console.log(`${output}: pages=${pages.length} items=${n}${raw ? " (raw — לא לעשות commit)" : ""}`);
