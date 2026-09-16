// מעלה את תוכן FixFlow מה-SQLite שעל המחשב אל Supabase.
//
//   node --env-file=.env tools/migrate-fixflow-data.js          ריצה יבשה
//   node --env-file=.env tools/migrate-fixflow-data.js --apply  כתיבה
//
// ============================================================
// ⚠️ שני מאגרים — ולמה זו החלטה ולא פשרה
// ============================================================
// `syncFromSource` קורא קבצי Word מ-`G:\תיקיות אחסון שיתופי\איתור תקלות`.
// ל-Postgres אין ולא תהיה גישה לכונן ממופה, ולכן **שלב פרסום הוא מובנה**:
// הכונן → SQLite על המחשב → Supabase.
//
// ⚠️ **ושני מאגרים סוטים זה מזה — זה הכשל שכל הפרויקט הזה נבנה סביב מניעתו.**
// לכן הכלי אינו "מעתיק ומקווה": אחרי הכתיבה הוא **משווה כל שורה** לפי תקציר
// תוכן, ונכשל בקול על כל הבדל. מראה שאינה נבדקת אינה מראה; היא עותק שני
// שמזדקן.
//
// ⚠️ **גם שורות מחוקות רכות עוברות.** `deleted_at` הוא נתון ולא היעדר: תקלה
// שיצאה משימוש עדיין מוצבעת מחריגות ומאירועים, ומראה שמשמיטה אותה מייצרת
// מצביעים שבורים בצד השני.
import pg from "pg";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

const APPLY = process.argv.includes("--apply");
const SQLITE =
  process.env.FIXFLOW_DB_PATH || "C:/Users/נעמהמנדלסון/Documents/FixFlow/server/data/parkomat.sqlite";

// ⚠️ הסדר הוא סדר התלות, לא אלפביתי. `ff_faults` מצביעה על `ff_profiles`,
// ולכן הפרה של הסדר נכשלת על מפתח זר — וזה הרבה יותר טוב מאשר להצליח.
const TABLES = [
  { pg: "ff_systems", lite: "systems",
    cols: ["id", "name", "sort_order", "data", "created_at", "updated_at", "deleted_at"] },
  { pg: "ff_profiles", lite: "profiles",
    cols: ["id", "system_id", "name", "sort_order", "in_service", "data", "created_at", "updated_at", "deleted_at"] },
  { pg: "ff_components", lite: "components",
    cols: ["id", "profile_id", "name", "sort_order", "data", "created_at", "updated_at", "deleted_at"] },
  { pg: "ff_faults", lite: "faults",
    cols: ["id", "profile_id", "component_id", "title", "warning", "handling", "sort_order", "source",
           "fingerprint", "data", "source_path", "source_hash", "source_synced_at", "source_text",
           "created_at", "updated_at", "deleted_at"] },
  { pg: "ff_procedures", lite: "procedures",
    cols: ["id", "profile_id", "title", "warning", "handling", "sort_order", "source", "data",
           "source_path", "source_hash", "source_synced_at", "source_text",
           "created_at", "updated_at", "deleted_at"] },
  { pg: "ff_sites", lite: "sites",
    cols: ["id", "code", "name", "profile_id", "data", "created_at", "updated_at", "deleted_at"] },
  { pg: "ff_site_fault_overrides", lite: "site_fault_overrides",
    cols: ["id", "site_id", "fault_id", "handling", "warning", "base_fault_hash", "data",
           "author_name", "source_path", "source_hash", "source_synced_at", "source_text",
           "created_at", "updated_at", "deleted_at"] },
];

const JSON_COLS = new Set(["data", "handling"]);
const BOOL_COLS = new Set(["in_service"]);
const TS_COLS = new Set(["created_at", "updated_at", "deleted_at", "source_synced_at"]);

// ⚠️ ערך אחד, שתי שפות. SQLite מחזיק JSON כמחרוזת, בוליאני כ-0/1 וזמן כטקסט;
// Postgres רוצה jsonb, boolean ו-timestamptz. המרה שגויה כאן אינה מתפוצצת —
// היא כותבת `"null"` כמחרוזת, ואז המסך מציג נוהל ריק בלי שום שגיאה.
function toPg(col, v) {
  if (v === null || v === undefined) return null;
  if (BOOL_COLS.has(col)) return v === 1 || v === true || v === "1";
  if (JSON_COLS.has(col)) {
    if (typeof v !== "string") return JSON.stringify(v);
    try { JSON.parse(v); return v; } catch { throw new Error(`${col} אינו JSON תקין: ${String(v).slice(0, 60)}`); }
  }
  if (TS_COLS.has(col)) {
    const s = String(v).trim();
    if (!s) return null;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw new Error(`${col} אינו זמן תקין: "${s}"`);
    return d.toISOString();
  }
  return v;
}

// ============================================================
// ⚠️ JSON קנוני — אחרת האימות נופל על נתונים תקינים
// ============================================================
// `jsonb` **ממיין מפתחות**. אותו צומת יוצא מ-SQLite כ-
// `{id,type,source,text}` ומ-Postgres כ-`{id,text,type,source}`, והשוואת
// `JSON.stringify` הייתה מדווחת 319 שורות שונות — על נתונים
// זהים לחלוטין. נמדד: מתוך 17 העמודות, **אחת** נראתה שונה, וההבדל
// היה כולו סדר.
//
// ⚠️ **וסדר איברים במערך כן נשמר**, וזה מה שחשוב: רצף הצעדים
// הוא הנוהל. מיון מפתחות אינו נוגע בו — ולכן הקינון כאן **ממיין
// מפתחות ושומר מערכים כסדרם**. מיון מערך היה מסתיר היפוך צעדים,
// כלומר הופך את השער לעיוור בדיוק במקום שהוא נבנה לשמור עליו.
const canon = (v) => {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
};

// תקציר תוכן של שורה — מה שמשווים אחרי הכתיבה.
const digest = (cols, row) =>
  createHash("sha256")
    .update(cols.map((c) => {
      const v = row[c];
      if (v === null || v === undefined) return "\u0000";
      if (v instanceof Date) return v.toISOString();
      if (BOOL_COLS.has(c)) return v === true || v === 1 || v === "1" ? "1" : "0";
      if (JSON_COLS.has(c)) return JSON.stringify(canon(typeof v === "string" ? JSON.parse(v) : v));
      return String(v);
    }).join("\u0001"))
    .digest("hex");

async function main() {
  const lite = new DatabaseSync(SQLITE, { readOnly: true });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  let failures = 0;

  try {
    console.log(`\n=== ${SQLITE} → Supabase ===`);
    console.log(APPLY ? "(כתיבה)\n" : "(ריצה יבשה — לא נכתב דבר. לכתיבה: --apply)\n");

    for (const t of TABLES) {
      const rows = lite.prepare(`SELECT ${t.cols.join(",")} FROM ${t.lite}`).all();
      const before = (await c.query(`SELECT COUNT(*)::int AS n FROM public.${t.pg}`)).rows[0].n;

      if (APPLY) {
        await c.query("BEGIN");
        // ⚠️ `ON CONFLICT DO UPDATE` ולא מחיקה-והוספה. מחיקה הייתה מפילה
        // מפתחות זרים של טבלאות שתלויות בשורה, ובנתיים משאירה את המסד
        // במצב שאין בו את הנוהל — כלומר חלון שבו מוקדן מקבל רשימה ריקה.
        for (const r of rows) {
          const vals = t.cols.map((col) => toPg(col, r[col]));
          const ph = t.cols.map((_, i) => `$${i + 1}`).join(",");
          const upd = t.cols.filter((x) => x !== "id").map((x) => `${x}=EXCLUDED.${x}`).join(",");
          await c.query(
            `INSERT INTO public.${t.pg} (${t.cols.join(",")}) VALUES (${ph})
             ON CONFLICT (id) DO UPDATE SET ${upd}`, vals);
        }
        // ⚠️ שורה שנעלמה מה-SQLite לגמרי (לא נמחקה רכות — נעלמה) חייבת
        // לרדת גם כאן, אחרת המראה צוברת שורות שאין להן מקור.
        const ids = rows.map((r) => r.id);
        await c.query(
          `DELETE FROM public.${t.pg} WHERE NOT (id = ANY($1::text[]))`, [ids.length ? ids : [""]]);
        await c.query("COMMIT");
      }

      // ---- אימות: כל שורה, לא רק הספירה ----
      const after = await c.query(`SELECT ${t.cols.join(",")} FROM public.${t.pg}`);
      const mine = new Map(rows.map((r) => [r.id, digest(t.cols, r)]));
      const theirs = new Map(after.rows.map((r) => [r.id, digest(t.cols, r)]));

      const missing = [...mine.keys()].filter((k) => !theirs.has(k));
      const extra = [...theirs.keys()].filter((k) => !mine.has(k));
      const differ = [...mine.entries()].filter(([k, h]) => theirs.has(k) && theirs.get(k) !== h);

      const ok = !missing.length && !extra.length && !differ.length;
      if (!ok && APPLY) failures++;
      console.log(
        `  ${APPLY ? (ok ? "✅" : "❌") : "·"} ${t.pg.padEnd(26)}` +
        `SQLite ${String(rows.length).padStart(5)}   Supabase ${String(before).padStart(5)} → ${String(after.rowCount).padStart(5)}` +
        (ok ? "" : `   חסרות ${missing.length} · עודפות ${extra.length} · שונות ${differ.length}`));
      if (!ok && differ.length) console.log(`        דוגמה: ${differ[0][0]}`);
    }

    console.log(APPLY
      ? (failures ? `\n❌ ${failures} טבלאות אינן תואמות` : "\n✅ כל שורה ב-Supabase זהה ל-SQLite")
      : "\nלכתיבה:  node --env-file=.env tools/migrate-fixflow-data.js --apply");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    console.error(`\n❌ ${e.message}`);
    failures++;
  } finally {
    lite.close();
    c.release();
    await pool.end();
  }
  process.exit(failures ? 1 : 0);
}

main();
