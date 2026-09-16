// מה שמוגש למוקדן מול הכונן — ישירות, בלי המתווך.
//
//   node --env-file=.env tools/check-fixflow-vs-drive.js
//
// ============================================================
// ⚠️ למה זה לא מיותר אחרי שני האימותים שכבר קיימים
// ============================================================
// `verifyContent` מוכיח שהכונן זהה ל-SQLite. `migrate-fixflow-data` מוכיח
// ש-SQLite זהה ל-Supabase. מתבקש להסיק שהכונן זהה ל-Supabase — **וזו בדיוק
// ההנחה שאסור להניח**: שתי הבדיקות רצות בזמנים שונים, על שני עותקים, וכל
// סנכרון שרץ בין השתיים שובר את השרשרת בלי שאף אחת מהן תבחין.
//
// ומה שמוגש למוקדן באמצע אירוע הוא **Supabase**, לא SQLite. אז זו הבדיקה
// שסופרת: הכונן מול מה שהדפדפן באמת מקבל.
//
// ⚠️ **והשוואה על `source_text` ולא על עץ הטיפול, בכוונה.** העץ הוא נגזרת
// של המחלץ — הוא משתנה עם כל שיפור בו, ולכן "שונה מהכונן" בעץ אינו אומר
// שמשהו אבד. `source_text` הוא המסמך כלשונו, וזו הטענה הבינארית היחידה
// שאפשר להעמיד: או שהוא עותק נאמן, או שלא.
import pg from "pg";
import { listSourceDocs, readSourceDoc, normalizeText } from
  "file:///C:/Users/נעמהמנדלסון/Documents/FixFlow/server/src/import/source.js";
import { SOURCE_ROOT, SYSTEM_ROOTS, EXPORT_OVERLAY } from
  "file:///C:/Users/נעמהמנדלסון/Documents/FixFlow/server/src/config.js";

const TABLES = ["ff_faults", "ff_procedures", "ff_site_fault_overrides"];

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();

  // ⚠️ הקריאה נעשית בתפקיד `authenticated` — לא כ-postgres. בדיקה שקוראת
  // כבעלים מאמתת נתונים שאולי המוקדן כלל אינו רואה, וזה שער שעובר על מסך
  // ריק.
  await c.query("BEGIN");
  await c.query("SET LOCAL ROLE authenticated");

  const inSupabase = new Map(); // source_path → { table, text }
  for (const t of TABLES)
    for (const r of (await c.query(
      `SELECT source_path, source_text FROM public.${t}
        WHERE source_path IS NOT NULL AND deleted_at IS NULL`)).rows)
      inSupabase.set(r.source_path, { table: t, text: r.source_text ?? "" });

  let checked = 0, identical = 0;
  const missing = [], differ = [], unreadable = [];

  for (const root of Object.values(SYSTEM_ROOTS)) {
    for (const entry of listSourceDocs(root, SOURCE_ROOT, EXPORT_OVERLAY)) {
      if (!entry.readable) { unreadable.push(entry.relPath); continue; }
      const row = inSupabase.get(entry.relPath);
      if (!row) { missing.push(entry.relPath); continue; }
      checked++;
      const onDrive = normalizeText(readSourceDoc(entry).text);
      if (onDrive === normalizeText(row.text)) identical++;
      else {
        const a = onDrive.split("\n"), b = normalizeText(row.text).split("\n");
        let at = -1;
        for (let i = 0; i < Math.max(a.length, b.length); i++)
          if (a[i] !== b[i]) { at = i; break; }
        differ.push({ relPath: entry.relPath, line: at + 1, drive: a[at] ?? "(אין)", supabase: b[at] ?? "(אין)" });
      }
      inSupabase.delete(entry.relPath);
    }
  }

  await c.query("ROLLBACK");
  c.release();
  await pool.end();

  console.log(`\n=== ${SOURCE_ROOT}  →  Supabase ===\n`);
  console.log(`מסמכים שנבדקו: ${checked}   ·   זהים מילה במילה: ${identical}`);

  const line = (label, n, list, fmt = (x) => x) => {
    console.log(`${n ? "❌" : "✅"} ${label.padEnd(38)} ${n}`);
    for (const x of list.slice(0, 8)) console.log(`      ${fmt(x)}`);
    if (list.length > 8) console.log(`      … ועוד ${list.length - 8}`);
  };

  line("מסמכים בכונן שאינם ב-Supabase", missing.length, missing);
  line("מסמכים שהטקסט שונה", differ.length, differ,
    (d) => `${d.relPath}  (שורה ${d.line}: כונן "${String(d.drive).slice(0, 50)}" ≠ Supabase "${String(d.supabase).slice(0, 50)}")`);
  // ⚠️ שורה ב-Supabase שאין לה מסמך בכונן היא נוהל שמוצג למוקדן ואין לו
  // מקור — כלומר בדיוק מה שאי אפשר לאמת ואי אפשר לתקן.
  line("שורות ב-Supabase בלי מסמך בכונן", inSupabase.size, [...inSupabase.keys()]);

  if (unreadable.length)
    console.log(`\n⚠️  מסמכים בכונן שלא ניתן לקרוא: ${unreadable.length} (מסמכי Google — ראה gdoc-export/README.md)`);

  const bad = missing.length + differ.length + inSupabase.size;
  console.log(bad
    ? `\n❌ ${bad} אי-התאמות`
    : `\n✅ כל מסמך שניתן לקרוא מהכונן זהה למה שמוגש מ-Supabase.`);
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
