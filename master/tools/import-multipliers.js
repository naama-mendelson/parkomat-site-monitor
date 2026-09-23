// import-multipliers — מייבא את "רמזור מכפילים" מ-Excel אל לוח המכפילים.
//
// ============================================================
// ⚠️ הרצה יבשה היא ברירת המחדל
// ============================================================
//   node --env-file=.env tools/import-multipliers.js <file.xlsx>
//   node --env-file=.env tools/import-multipliers.js <file.xlsx> --apply
//   node --env-file=.env tools/import-multipliers.js <file.xlsx> --json out.json
//
// בלי `--apply` הכלי **קורא בלבד** ומדפיס בדיוק מה היה נכתב.
// ‏`--json` כותב את הלוח כפי שהיה נראה, בלי לגעת במסד — כך אפשר לראות
// אותו על המסך לפני שמשהו נוגע בייצור.
//
// ============================================================
// ⚠️ הנתונים נשמרים בדיוק כפי שהם. שום נרמול.
// ============================================================
// זו דרישה מפורשת, והיא נאכפת כאן בארבע צורות:
//
// 1. **ריק נשאר ריק.** אין ברירות מחדל, אין השלמה מהקשר, אין ניחוש.
// 2. **`Max3` ו-`MAX3` נשארים שניים.** בגיליון יש 34 ערכים שונים
//    ב"סוג מתקן" על 113 שורות מלאות, כולל הבדלי רישיות וצירופים כמו
//    `Max3D/Max3/Max2`. נרמול הוא **שינוי נתונים**, לא ניקיון — ומי
//    שמאחד אותם מוחק הבחנה שאולי מישהו סומך עליה.
// 3. **שתי העמודות באותו שם נשארות שתיים.** "סוג הסכם שירות" מופיעה
//    בגיליון פעמיים (עמודות 2 ו-5). בלוח הרובוטי כבר נמדד שמיזוג כזה
//    מוחק מידע — שם הן סותרות זו את זו ב-7 שורות — ולכן השנייה נשמרת
//    תחת שם מובחן, בדיוק כמו שם.
// 4. **כמעט הכול `text`.** עמודת `status` הייתה כופה רשימה סגורה, וכל
//    ערך שמחוצה לה נבלע בשקט. היחידה שהיא `status` היא זו שהתצוגה
//    מקבצת לפיה, ויש בה חמישה ערכים מדודים ותו לא.
//
// ============================================================
// ⚠️ ומה מחליף את `Item ID` של Monday
// ============================================================
// בייצוא הרובוטי יש עמודת `Item ID`, והיא מה שהופך ייבוא חוזר
// ל**עדכון** במקום לכפילות. בגיליון הזה **אין** אותה. לכן הזהות היא
// **שם האתר, מנורמל לאותיות וספרות בלבד** — אותו כלל בדיוק שבו
// ‏`import-traffic-light` מזהה שורה קיימת ("אביגיל 20 ר\"ג" מול
// "אביגיל 20, ר\"ג"). זה מספיק כאן כי 130 השמות **ייחודיים** — נמדד.
//
// ⚠️ ושם שישתנה בגיליון ייראה כשורה חדשה. זה מדווח בהרצה היבשה
// כ"שורות חדשות", ומי שרואה מספר גדול מהצפוי יודע לעצור.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const BOARD = "multipliers";

const file = process.argv[2];
const APPLY = process.argv.includes("--apply");
const jsonAt = process.argv.indexOf("--json");
const JSON_OUT = jsonAt > 0 ? process.argv[jsonAt + 1] : null;

if (!file || !fs.existsSync(file)) {
  console.error("שימוש: node --env-file=.env tools/import-multipliers.js <file.xlsx> [--apply] [--json out.json]");
  process.exit(1);
}

// ⚠️ דרך קובץ ולא דרך stdout: ה-stdout של Python כאן הוא cp1255, ו-
// `json.dumps(ensure_ascii=False)` נפל עליו על תו כיווניות.
function readSheet(xlsx) {
  const tmp = path.join(require("node:os").tmpdir(), `mul-${process.pid}.json`);
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

// ⚠️ אותיות וספרות בלבד, **בסדר**. פיסוק ורווחים אינם זהות.
const letters = (s) => String(s ?? "").replace(/[^0-9א-תA-Za-z]/g, "");

// עמודת הגיליון → העמודה אצלנו. `null` = לא מיובאת.
// ⚠️ המיפוי לפי **מיקום** ולא לפי שם, כי שתי עמודות חולקות שם.
const MAP = [
  { at: 0,  to: "אתר",                  kind: "text" },
  { at: 1,  to: null },                 // Subitems — ריקה לגמרי (0 מתוך 130)
  { at: 2,  to: "סוג הסכם שירות",       kind: "status" },
  { at: 3,  to: "סוג מתקן",             kind: "text" },
  { at: 4,  to: "עם / בלי שלט",         kind: "text" },
  { at: 5,  to: "סוג הסכם שירות 2",     kind: "text" },
  { at: 6,  to: "אחריות",               kind: "text" },
  { at: 7,  to: "הסכם שירות",           kind: "text" },
  { at: 8,  to: "ועד / ח.ניהול / נציג", kind: "text" },
  { at: 9,  to: "איש קשר נוסף",         kind: "text" },
  { at: 10, to: "מספר מתקנים",          kind: "text" },
];

// ⚠️ הצבעים לעמודת הקיבוץ — מהפלטה של Monday, כדי שמי שמסתכל על שני
// הלוחות יזהה את אותו ערך. ערך שאינו כאן מקבל אפור ואינו נבלע.
const COLORS = {
  "בסיסי": "#0086c0",
  "לא בשירות": "#e2445c",
  "אין": "#808080",
  "לא נמסר": "#c4c4c4",
};

function parse(rows) {
  const hdr = rows.findIndex((r) => r[0] === "Name");
  if (hdr < 0) throw new Error("לא נמצאה שורת כותרות (Name)");

  const out = [];
  const skipped = [];
  for (let i = hdr + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r.some((c) => c !== "")) continue;
    if (r[0] === "Name") continue;                                   // כותרת חוזרת
    if (r[0] && r.slice(1).every((c) => c === "")) continue;         // שם קבוצה
    // ⚠️ שורה בלי שם נזרקת ומדווחת: אין לה זהות, ולכן כל ייבוא חוזר
    // היה מוסיף עוד אחת.
    if (!String(r[0] ?? "").trim()) { skipped.push(i + 1); continue; }
    out.push(r);
  }
  return { records: out, skipped };
}

function build(records) {
  const values = new Map();          // תווית → Set של ערכים (לעמודת הסטטוס)
  const built = records.map((r) => {
    const cells = {};
    for (const m of MAP) {
      if (!m.to) continue;
      const v = String(r[m.at] ?? "").trim();
      if (v === "") continue;        // ⚠️ ריק נשאר ריק
      cells[m.to] = v;
      if (m.kind === "status") {
        if (!values.has(m.to)) values.set(m.to, new Set());
        values.get(m.to).add(v);
      }
    }
    return { name: String(r[0]).trim(), cells };
  });
  return { built, values };
}

async function main() {
  const rows = readSheet(path.resolve(file));
  const { records, skipped } = parse(rows);
  const { built, values } = build(records);

  // ---------- דוח ----------
  console.log(`קובץ: ${path.basename(file)}`);
  console.log(`שורות נתונים: ${built.length}`);
  if (skipped.length) console.log(`⚠️ שורות בלי שם שדולגו: ${skipped.join(", ")}`);

  const names = built.map((b) => letters(b.name));
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  console.log(dupes.length
    ? `⚠️ שמות כפולים (זהות לא ייחודית!): ${[...new Set(dupes)].join(" · ")}`
    : "זהות: שם האתר — ייחודי בכל 130 השורות ✅");

  console.log("\nעמודות שייווצרו:");
  for (const m of MAP) {
    if (!m.to) continue;
    const filled = built.filter((b) => b.cells[m.to] !== undefined).length;
    const distinct = new Set(built.map((b) => b.cells[m.to]).filter(Boolean)).size;
    console.log(`   ${m.to.padEnd(22)} ${m.kind.padEnd(7)} מלאים ${String(filled).padStart(3)}/${built.length}  ערכים שונים ${distinct}`);
  }

  for (const [label, set] of values) {
    console.log(`\nאפשרויות "${label}" (${set.size}): ${[...set].join(" · ")}`);
  }

  // ⚠️ ההוכחה שאין נרמול — מודפסת, לא מובטחת.
  const kinds = new Set(built.map((b) => b.cells["סוג מתקן"]).filter(Boolean));
  const ci = new Set([...kinds].map((k) => k.toLowerCase()));
  console.log(`\n"סוג מתקן": ${kinds.size} ערכים כפי שהם. ` +
    `איחוד רישיות היה מוריד ל-${ci.size} — כלומר מוחק ${kinds.size - ci.size} הבחנות. לא נעשה.`);

  const columns = MAP.filter((m) => m.to).map((m, i) => ({
    id: 1000 + i,
    key: `m${i}`,
    label: m.to,
    kind: m.kind,
    options: values.has(m.to)
      ? [...values.get(m.to)].map((v) => ({ value: v, label: v, color: COLORS[v] || "#9aadbd" }))
      : [],
    width: 180,
    position: i + 1,
  }));
  const byLabel = new Map(columns.map((c) => [c.label, c.key]));
  const asRows = built.map((b, i) => ({
    id: 2000 + i,
    position: i + 1,
    cells: Object.fromEntries(
      Object.entries(b.cells).map(([label, v]) => [byLabel.get(label), v])),
  }));

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ board: BOARD, columns, rows: asRows }, null, 1));
    console.log(`\n📄 הלוח נכתב ל-${JSON_OUT} — בלי לגעת במסד.`);
  }

  if (!APPLY) {
    console.log("\n— הרצה יבשה. שום דבר לא נכתב. להרצה אמיתית: --apply");
    return;
  }

  // ---------- ביצוע ----------
  const db = require("../db/db");
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    const have = new Map((await client.query(
      `SELECT key, label FROM traffic_light_columns WHERE board = $1`, [BOARD]))
      .rows.map((r) => [r.label, r.key]));

    let pos = Number((await client.query(
      `SELECT COALESCE(MAX(position),0) p FROM traffic_light_columns WHERE board = $1`,
      [BOARD])).rows[0].p);

    for (const c of columns) {
      if (have.has(c.label)) continue;
      const key = "c" + new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17)
                + Math.floor(Math.random() * 900 + 100);
      await client.query(
        `INSERT INTO traffic_light_columns (key,label,kind,options,width,position,board)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)`,
        [key, c.label, c.kind, JSON.stringify(c.options), 180, ++pos, BOARD]);
      have.set(c.label, key);
    }

    const existing = (await client.query(
      `SELECT id, cells FROM traffic_light_rows WHERE board = $1`, [BOARD])).rows;
    const kName = have.get("אתר");
    const byLetters = new Map(existing.map((r) => [letters(r.cells?.[kName]), r]));

    let added = 0, updated = 0;
    let rpos = Number((await client.query(
      `SELECT COALESCE(MAX(position),0) p FROM traffic_light_rows WHERE board = $1`,
      [BOARD])).rows[0].p);

    for (const b of built) {
      const cells = {};
      for (const [label, v] of Object.entries(b.cells)) cells[have.get(label)] = v;
      const hit = byLetters.get(letters(b.name));
      if (hit) {
        // ⚠️ מיזוג ולא דריסה, כמו ביבואן הרובוטי: מה שמישהו הוסיף ביד
        // בעמודה שאינה בגיליון אינו נמחק בייבוא חוזר.
        await client.query(
          `UPDATE traffic_light_rows SET cells = cells || $2::jsonb, updated_at = now()
            WHERE id = $1`, [hit.id, JSON.stringify(cells)]);
        updated++;
      } else {
        await client.query(
          `INSERT INTO traffic_light_rows (cells, position, board) VALUES ($1::jsonb,$2,$3)`,
          [JSON.stringify(cells), ++rpos, BOARD]);
        added++;
      }
    }

    await client.query("COMMIT");
    console.log(`\n✅ בוצע: ${added} שורות חדשות, ${updated} עודכנו.`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("\n❌ נכשל — שום דבר לא נשמר:", e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await db.pool.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
