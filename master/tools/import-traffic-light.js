// import-traffic-light — מייבא לוח Monday שיוצא ל-Excel אל לוח הרמזור.
//
// ============================================================
// ⚠️ הרצה יבשה היא ברירת המחדל
// ============================================================
//   node --env-file=.env tools/import-traffic-light.js <file.xlsx>
//   node --env-file=.env tools/import-traffic-light.js <file.xlsx> --apply
//
// בלי `--apply` הכלי **קורא בלבד** ומדפיס בדיוק מה היה משתנה. ייבוא של
// 150 שורות שאי אפשר לראות מראש הוא בדיוק הסוג של פעולה שמגלים שהייתה
// שגויה אחרי שכבר אין למה לחזור.
//
// ============================================================
// ⚠️ שלושה כללים שאי אפשר לוותר עליהם
// ============================================================
// 1. **עמודת "קוד אתר" לעולם אינה נכתבת.** היא החיבור בין הלוח לאתרים
//    המנוטרים, היא נבנתה ביד, והיא מה שקובע לאילו אתרים הזמינות מחושבת
//    לפי שעות שירות. ייבוא שדורס אותה מנתק 17 אתרים בשקט.
//
// 2. **הערכים של "להתייחס כ" נשמרים באנגלית, והתווית בעברית.**
//    ‏`app.service_agreement` משווה ל-vip/ext/basic. כתיבת "מורחב" כערך
//    הייתה מחזירה את כל האתרים המחוברים ל-24/7 — בלי שגיאה, בלי לוג,
//    ובלי שאיש ישים לב עד שמישהו ישווה מספרים. הלוח **נראה** בעברית
//    כי `label` הוא מה שמוצג; `value` הוא מה שמחשבים לפיו.
//
// 3. **התאמה לפי אותיות, לא לפי מחרוזת.** "אביגיל 20 ר\"ג" בקובץ מול
//    "אביגיל 20, ר\"ג" בלוח הם אותה שורה. בלי זה נוצרות 33 כפילויות
//    בהרצה אחת.

const fs = require("node:fs");
const path = require("node:path");
const db = require("../db/db");

const file = process.argv[2];
const APPLY = process.argv.includes("--apply");

if (!file || !fs.existsSync(file)) {
  console.error("שימוש: node --env-file=.env tools/import-traffic-light.js <file.xlsx> [--apply]");
  process.exit(1);
}

// ⚠️ openpyxl אינו זמין ב-Node; קוראים את ה-xlsx כ-zip של XML. אין כאן
// תלות חדשה ב-package.json בכוונה — כלי חד-פעמי שגורר חבילה הוא חבילה
// שתישאר בפרויקט לנצח.
const { execFileSync } = require("node:child_process");

function readSheet(xlsx) {
  // ⚠️ **דרך קובץ ולא דרך stdout.** ה-stdout של Python כאן הוא cp1255,
  // ו-`json.dumps(ensure_ascii=False)` נפל עליו על תו כיווניות. כתיבה
  // לקובץ עם קידוד מפורש עוקפת את קידוד המסוף לגמרי.
  const tmp = path.join(require("node:os").tmpdir(), `tl-import-${process.pid}.json`);
  try {
    execFileSync("python", ["-c", `
import openpyxl, json, sys, datetime, io, re
wb = openpyxl.load_workbook(sys.argv[1], data_only=True)
ws = wb[wb.sheetnames[0]]
# tokens of direction control - invisible, unsearchable, and they break
# every future comparison. Stripped on the way in.
BIDI = re.compile("[" + chr(0x200e) + chr(0x200f) + chr(0x202a) + "-" + chr(0x202e)
                  + chr(0x2066) + "-" + chr(0x2069) + chr(0xfeff) + "]")
def cell(c):
    if c is None: return ""
    if isinstance(c, (datetime.datetime, datetime.date)): return c.strftime("%Y-%m-%d")
    return BIDI.sub("", str(c)).strip()
rows = [[cell(c) for c in r] for r in ws.iter_rows(values_only=True)]
io.open(sys.argv[2], "w", encoding="utf-8").write(
    json.dumps({"name": wb.sheetnames[0], "rows": rows}, ensure_ascii=False))
`, xlsx, tmp], { stdio: ["ignore", "ignore", "pipe"] });
    return JSON.parse(fs.readFileSync(tmp, "utf8"));
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* אין מה לנקות */ }
  }
}

// ⚠️ אותיות וספרות בלבד, **בסדר**. פיסוק ורווחים אינם זהות.
const letters = (s) => String(s ?? "").replace(/[^0-9א-תA-Za-z]/g, "");

// ⚠️ המיפוי הזה הוא הלב. ערך שאינו כאן נכתב כפי שהוא ומדווח — לא
// מנוחש, ולא נבלע לברירת מחדל.
const KIND_VALUE = {
  "VIP": "vip",
  "מורחב": "ext",
  "בסיסי": "basic",
  "לא בשירות": "no_service",
  "תחזוקה בלבד": "maintenance_only",
  "תחזוקה": "maintenance_only",
  "אין": "none",
};

const KIND_COLOR = {
  vip: "#00c875", ext: "#fdab3d", basic: "#c4c4c4",
  no_service: "#e2445c", maintenance_only: "#a25ddc", none: "#808080",
};

// עמודת הקובץ → תווית העמודה אצלנו. `null` = לא מיובאת.
const MAP = [
  { from: "Name", to: "אתר", kind: "text" },
  { from: "Subitems", to: null },
  { from: "להתייחס כ", to: "להתייחס כ", kind: "status", mapped: true },
  { from: "סוג הסכם שירות במקור", to: "סוג הסכם שירות במקור", kind: "status", mapped: true },
  { from: "סוג הסכם שירות", to: "סוג הסכם שירות", kind: "status" },
  { from: "אחריות", to: "אחריות", kind: "text" },
  { from: "הערות", to: "הערות", kind: "text" },
  // ⚠️ שם העמודה בקובץ הוא "ועד/ח.ניהול/נציג" ואצלנו "ועד / ת.ניהול / נציג"
  // (ח מול ת, ורווחים). ההתאמה היא לפי **מיקום** ברשימה הזו ולא לפי שם,
  // בדיוק מהסיבה שהתאמת שמות נכשלה על "ז'בוטינסקי".
  { from: "ועד/ח.ניהול/נציג", to: "ועד / ת.ניהול / נציג", kind: "text" },
  { from: "איש קשר נוסף", to: "איש קשר נוסף", kind: "text" },
  { from: "קיל", to: "קיל", kind: "text" },
  { from: "מורשה כניסה למרתף", to: "מורשה כניסה למרתף", kind: "text" },
  // ⚠️ העמודה השנייה באותו שם — נשמרת בנפרד לפי החלטה מפורשת: ב-7
  // שורות היא סותרת את הראשונה ("חדש" מול "ישן"), כלומר איחוד היה
  // מוחק מידע.
  { from: "סוג הסכם שירות", to: "סוג הסכם שירות 2", kind: "status", second: true },
  { from: "תאריך תחילת הסכם חדש", to: "תאריך תחילת הסכם חדש", kind: "date" },
  { from: "מרחב מוגן", to: "מרחב מוגן", kind: "text" },
  // ⚠️ מזהה Monday נשמר — הוא מה שיהפוך ייבוא חוזר לעדכון ולא לכפילות.
  { from: "Item ID (auto generated)", to: "Monday ID", kind: "text" },
];

function newKey() {
  return "c" + new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17)
       + Math.floor(Math.random() * 900 + 100);
}

async function main() {
  const sheet = readSheet(path.resolve(file));
  const rows = sheet.rows;

  const hdrIdx = rows.findIndex((r) => r[0] === "Name");
  if (hdrIdx < 0) { console.error("לא נמצאה שורת כותרות (Name)"); process.exit(1); }

  // ⚠️ הקובץ מכיל קבוצה שנייה: שורת שם קבוצה ואחריה שורת כותרות חוזרת.
  // בלי זיהוין הן היו נכנסות כשתי שורות נתונים אמיתיות.
  let group = "";
  const records = [];
  for (let i = hdrIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r.some((c) => c !== "")) continue;
    if (r[0] === "Name") continue;                      // כותרת חוזרת
    if (r[0] && r.slice(1).every((c) => c === "")) { group = r[0]; continue; }  // שם קבוצה

    // ⚠️ **שורה בלי שם נזרקת.** בקובץ יש שורה כזו — שרידי הפרדה בין
    // קבוצות — והיא נכנסה כשורה אמיתית בהרצה הראשונה, עם תא תאריך
    // בודד ותו לא. שורה בלי שם אינה ניתנת לזיהוי, לא תתאים לעולם
    // בהרצה הבאה, ולכן כל ייבוא חוזר היה מוסיף עוד אחת.
    if (!String(r[0] ?? "").trim()) continue;

    records.push({ row: r, group });
  }

  // ============================================================
  // ⚠️ הלוח הרובוטי בלבד — בכל שאילתה, קריאה וכתיבה
  // ============================================================
  // מאז 23/09/2026 אותן טבלאות מחזיקות גם את לוח המכפילים. בלי הסינון
  // הכלי הזה היה הורס את שני הלוחות בהרצה אחת:
  //   • `cols[0]` הוא עמודת השם, ושתי עמודות "אתר" יושבות שתיהן ב-position 1.
  //     אם של המכפילים יוצאת ראשונה, אף שורה רובוטית לא מזוהה — וכל 153
  //     השורות נכנסות מחדש ככפילות.
  //   • `byLabel` לפי תווית: "אחריות" ו"איש קשר נוסף" קיימות בשני הלוחות
  //     באותו position, ותאים רובוטיים היו נכתבים תחת מפתח של המכפילים —
  //     שם אין להם עמודה, כלומר נעלמים מהמסך.
  //   • `UPDATE … WHERE label` על "סוג הסכם שירות" דורס את רשימת
  //     האפשרויות של העמודה בעלת אותו שם בלוח המכפילים.
  const { rows: cols } = await db.pool.query(
    `SELECT id, key, label, kind, options, position FROM traffic_light_columns
      WHERE board = 'robotic' ORDER BY position, id`);
  const { rows: existing } = await db.pool.query(
    `SELECT id, cells FROM traffic_light_rows WHERE board = 'robotic'`);

  const byLabel = new Map(cols.map((c) => [c.label, c]));
  const codeCol = byLabel.get("קוד אתר");

  // ---------- אילו עמודות חסרות ----------
  const plan = { newCols: [], newOpts: new Map(), newRows: [], updates: [], unknownKinds: new Set() };
  let seenSecond = 0;
  const resolved = [];
  for (let i = 0; i < MAP.length; i++) {
    const m = MAP[i];
    if (!m.to) { resolved.push(null); continue; }
    let col = byLabel.get(m.to);
    if (!col) plan.newCols.push({ label: m.to, kind: m.kind });
    resolved.push({ ...m, col });
  }

  // ---------- שורות ----------
  const byLetters = new Map();
  for (const r of existing) {
    const nameKey = cols[0].key;
    const L = letters(r.cells?.[nameKey]);
    if (L) byLetters.set(L, r);
  }

  for (const rec of records) {
    const name = rec.row[0];
    const L = letters(name);
    const hit = byLetters.get(L);
    const cells = {};

    for (let i = 0; i < resolved.length; i++) {
      const m = resolved[i];
      if (!m) continue;
      let v = rec.row[i] ?? "";
      if (v === "") continue;

      if (m.mapped) {
        const mapped = KIND_VALUE[v];
        if (!mapped) { plan.unknownKinds.add(v); continue; }
        if (!plan.newOpts.has(m.to)) plan.newOpts.set(m.to, new Map());
        plan.newOpts.get(m.to).set(mapped, { value: mapped, label: v, color: KIND_COLOR[mapped] });
        v = mapped;
      } else if (m.kind === "status") {
        if (!plan.newOpts.has(m.to)) plan.newOpts.set(m.to, new Map());
        plan.newOpts.get(m.to).set(v, { value: v, label: v, color: null });
      }
      cells[m.to] = v;
    }
    if (rec.group) cells["קבוצה"] = rec.group;

    if (hit) plan.updates.push({ id: hit.id, name, cells, before: hit.cells });
    else plan.newRows.push({ name, cells });
  }

  if (!byLabel.get("קבוצה")) plan.newCols.push({ label: "קבוצה", kind: "status" });

  // ---------- דוח ----------
  console.log(`קובץ: ${path.basename(file)} · גיליון "${sheet.name}"`);
  console.log(`שורות נתונים: ${records.length}  (אחרי דילוג על כותרות וקבוצות)`);
  console.log(`קבוצות: ${[...new Set(records.map((r) => r.group).filter(Boolean))].join(" · ") || "—"}`);
  console.log("");
  console.log(`עמודות שייווצרו (${plan.newCols.length}): ` +
    plan.newCols.map((c) => `"${c.label}"(${c.kind})`).join("  ") || "—");

  for (const [label, opts] of plan.newOpts) {
    const col = byLabel.get(label);
    const have = new Set((col?.options ?? []).map((o) => String(o.value)));
    const add = [...opts.values()].filter((o) => !have.has(String(o.value)));
    if (add.length) console.log(`אפשרויות שיתווספו ל-"${label}" (${add.length}): ` +
      add.map((o) => `${o.label}→${o.value}`).join("  "));
  }

  if (plan.unknownKinds.size)
    console.log(`\n⚠️ ערכי הסכם שלא זוהו ולא יובאו: ${[...plan.unknownKinds].join(" · ")}`);

  console.log(`\nשורות חדשות: ${plan.newRows.length}`);
  console.log(`שורות שיתעדכנו: ${plan.updates.length}`);

  let touched = 0, kept = 0;
  for (const u of plan.updates) {
    const diffs = [];
    for (const [label, v] of Object.entries(u.cells)) {
      const col = byLabel.get(label);
      if (!col) continue;
      const before = String(u.before?.[col.key] ?? "").trim();
      if (before !== String(v)) diffs.push(`${label}: "${before}"→"${v}"`);
    }
    if (diffs.length) { touched += diffs.length; if (plan.updates.indexOf(u) < 6) console.log(`  ${u.name}: ` + diffs.slice(0, 3).join(" · ")); }
    else kept++;
  }
  console.log(`  סה"כ תאים שישתנו: ${touched} · שורות בלי שינוי: ${kept}`);
  console.log(`\n⚠️ עמודת "קוד אתר" אינה נכתבת. ${existing.filter((r) => String(r.cells?.[codeCol?.key] ?? "").trim()).length} שורות מחוברות — כולן נשמרות.`);

  if (!APPLY) { console.log("\n— הרצה יבשה. להרצה אמיתית: --apply"); await db.pool.end(); return; }

  // ---------- ביצוע ----------
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    let pos = Math.max(...cols.map((c) => Number(c.position))) + 1;
    for (const c of plan.newCols) {
      const key = newKey();
      await client.query(
        `INSERT INTO traffic_light_columns (key,label,kind,width,position,board) VALUES ($1,$2,$3,$4,$5,'robotic')`,
        [key, c.label, c.kind, 200, pos++]);
      byLabel.set(c.label, { key, label: c.label, kind: c.kind, options: [] });
    }

    for (const [label, opts] of plan.newOpts) {
      const col = byLabel.get(label);
      const have = new Map((col.options ?? []).map((o) => [String(o.value), o]));
      let i = have.size;
      for (const o of opts.values())
        if (!have.has(String(o.value)))
          have.set(String(o.value), { ...o, color: o.color ?? PALETTE[i++ % PALETTE.length] });
      await client.query(
        `UPDATE traffic_light_columns SET options = $2::jsonb WHERE board = 'robotic' AND label = $1`,
        [label, JSON.stringify([...have.values()])]);
    }

    const put = (cells) => {
      const o = {};
      for (const [label, v] of Object.entries(cells)) {
        const col = byLabel.get(label);
        if (col) o[col.key] = v;
      }
      return o;
    };

    for (const u of plan.updates) {
      // ⚠️ מיזוג ולא דריסה — ובפרט `קוד אתר` נשאר כפי שהוא.
      await client.query(
        `UPDATE traffic_light_rows SET cells = cells || $2::jsonb WHERE id = $1 AND board = 'robotic'`,
        [u.id, JSON.stringify(put(u.cells))]);
    }

    let rpos = Number((await client.query(
      `SELECT COALESCE(MAX(position),0)+1 p FROM traffic_light_rows WHERE board = 'robotic'`)).rows[0].p);
    for (const n of plan.newRows) {
      await client.query(
        `INSERT INTO traffic_light_rows (cells, position, board) VALUES ($1::jsonb, $2, 'robotic')`,
        [JSON.stringify(put(n.cells)), rpos++]);
    }

    await client.query("COMMIT");
    console.log(`\n✅ בוצע: ${plan.newRows.length} שורות חדשות, ${plan.updates.length} עודכנו.`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("\n❌ נכשל — שום דבר לא נשמר:", e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await db.pool.end();
  }
}

const PALETTE = ["#00c875", "#fdab3d", "#e2445c", "#0086c0", "#a25ddc",
                 "#579bfc", "#ffcb00", "#808080", "#037f4c", "#ff158a"];

main().catch((e) => { console.error(e); process.exit(1); });
