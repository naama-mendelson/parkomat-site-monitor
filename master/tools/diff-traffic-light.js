// diff-traffic-light — האם הלוח אצלנו זהה ללוח ב-Monday.
//
// ⚠️ **קורא בלבד.** משווה תא מול תא מול קובץ הייצוא ומדפיס כל הפרש.
// אין כאן `--apply`: תיקון נעשה דרך היבואן, שעבר הרצה יבשה.
//
//   node --env-file=.env tools/diff-traffic-light.js <file.xlsx>
//
// ⚠️ **ההשוואה לפי `Monday ID` ולא לפי שם.** השם הוא בדיוק מה שנבדל
// בין שני הלוחות ("הורקנוס" מול "הורקונוס"), ולכן השוואה לפיו הייתה
// מדווחת על הפרשים שהיא עצמה יצרה.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const db = require("../db/db");

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error("שימוש: node --env-file=.env tools/diff-traffic-light.js <file.xlsx>");
  process.exit(1);
}

function readSheet(xlsx) {
  const tmp = path.join(require("node:os").tmpdir(), `tl-diff-${process.pid}.json`);
  try {
    execFileSync("python", ["-c", `
import openpyxl, json, sys, datetime, io, re
wb = openpyxl.load_workbook(sys.argv[1], data_only=True)
ws = wb[wb.sheetnames[0]]
BIDI = re.compile("[" + chr(0x200e) + chr(0x200f) + chr(0x202a) + "-" + chr(0x202e)
                  + chr(0x2066) + "-" + chr(0x2069) + chr(0xfeff) + "]")
def cell(c):
    if c is None: return ""
    if isinstance(c, (datetime.datetime, datetime.date)): return c.strftime("%Y-%m-%d")
    return BIDI.sub("", str(c)).strip()
rows = [[cell(c) for c in r] for r in ws.iter_rows(values_only=True)]
io.open(sys.argv[2], "w", encoding="utf-8").write(json.dumps({"rows": rows}, ensure_ascii=False))
`, xlsx, tmp], { stdio: ["ignore", "ignore", "pipe"] });
    return JSON.parse(fs.readFileSync(tmp, "utf8")).rows;
  } finally { try { fs.unlinkSync(tmp); } catch { /* אין מה לנקות */ } }
}

// אותה מפה בדיוק כמו ביבואן. ⚠️ אם הן ייפרדו, הדוח הזה יאמר "זהה"
// על לוח שאינו זהה — ולכן היא נכתבת פעם אחת לכל עמודה ובאותו סדר.
const MAP = [
  [0, "אתר"], [2, "להתייחס כ"], [3, "סוג הסכם שירות במקור"], [4, "סוג הסכם שירות"],
  [5, "אחריות"], [6, "הערות"], [7, "ועד / ת.ניהול / נציג"], [8, "איש קשר נוסף"],
  [9, "קיל"], [10, "מורשה כניסה למרתף"], [11, "סוג הסכם שירות 2"],
  [12, "תאריך תחילת הסכם חדש"], [13, "מרחב מוגן"],
];

const KIND_VALUE = {
  "VIP": "vip", "מורחב": "ext", "בסיסי": "basic",
  "לא בשירות": "no_service", "תחזוקה בלבד": "maintenance_only",
  "תחזוקה": "maintenance_only", "אין": "none",
};
const MAPPED = new Set(["להתייחס כ", "סוג הסכם שירות במקור"]);

async function main() {
  const rows = readSheet(path.resolve(file));
  const hdr = rows.findIndex((r) => r[0] === "Name");

  const src = new Map();
  for (let i = hdr + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r.some((x) => x !== "")) continue;
    if (r[0] === "Name") continue;
    if (r[0] && r.slice(1).every((x) => x === "")) continue;
    const id = String(r[14] ?? "").trim();
    if (id) src.set(id, r);
  }

  const { rows: cols } = await db.pool.query(
    `SELECT key, label FROM traffic_light_columns ORDER BY position`);
  const byLabel = new Map(cols.map((c) => [c.label, c.key]));
  const kMid = byLabel.get("Monday ID");
  const { rows: ours } = await db.pool.query(`SELECT id, cells FROM traffic_light_rows`);

  const mine = new Map();
  const noId = [];
  for (const r of ours) {
    const id = String(r.cells?.[kMid] ?? "").trim();
    if (id) mine.set(id, r); else noId.push(r);
  }

  console.log(`Monday: ${src.size} שורות · אצלנו: ${ours.length} (${mine.size} עם מזהה)\n`);

  const missing = [...src.keys()].filter((id) => !mine.has(id));
  const extra = [...mine.keys()].filter((id) => !src.has(id));

  console.log(`שורות שיש ב-Monday ואין אצלנו: ${missing.length}`);
  for (const id of missing.slice(0, 20)) console.log(`   "${src.get(id)[0]}"`);
  console.log(`\nשורות שיש אצלנו ואין ב-Monday: ${extra.length}`);
  for (const id of extra.slice(0, 20)) {
    const r = mine.get(id);
    console.log(`   "${r.cells[byLabel.get("אתר")] ?? ""}"`);
  }
  console.log(`\nשורות אצלנו בלי מזהה Monday: ${noId.length}`);
  for (const r of noId.slice(0, 20))
    console.log(`   "${r.cells[byLabel.get("אתר")] ?? "(ללא שם)"}"`);

  // ---------- הפרשי תאים ----------
  let diffs = 0;
  const byColumn = new Map();
  const samples = [];
  for (const [id, s] of src) {
    const m = mine.get(id);
    if (!m) continue;
    for (const [i, label] of MAP) {
      const key = byLabel.get(label);
      if (!key) continue;
      let want = String(s[i] ?? "").trim();
      if (MAPPED.has(label) && want) want = KIND_VALUE[want] ?? want;
      const got = String(m.cells?.[key] ?? "").trim();
      if (want !== got) {
        diffs++;
        byColumn.set(label, (byColumn.get(label) ?? 0) + 1);
        if (samples.length < 25)
          samples.push(`   ${String(s[0]).slice(0, 22).padEnd(24)} ${label.padEnd(22)} Monday="${want.slice(0, 26)}"  אצלנו="${got.slice(0, 26)}"`);
      }
    }
  }

  console.log(`\nתאים שונים: ${diffs}`);
  for (const [label, n] of [...byColumn.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`   ${String(label).padEnd(24)} ${n}`);
  if (samples.length) { console.log("\nדוגמאות:"); samples.forEach((x) => console.log(x)); }

  console.log(diffs === 0 && missing.length === 0
    ? "\n✅ הלוחות זהים"
    : "\n⚠️ יש הפרשים");
  await db.pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
