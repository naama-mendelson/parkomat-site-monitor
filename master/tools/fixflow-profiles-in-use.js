// אילו סוגי אתרים באמת קיימים אצלנו — ואילו מסמכים ב-FixFlow אינם נוגעים לאף אתר שלנו.
//
//   node --env-file=.env tools/fixflow-profiles-in-use.js
//
// FixFlow מחזיקה 117 אתרים ו-19 פרופילים, שהם כל מה שלולק וביטנקם בנו אי פעם.
// אנחנו מנטרים 28. מסמך של סוג מכונה שאין לנו אינו "מידע נוסף" — הוא רעש בחיפוש
// של מוקדן באמצע אירוע.
//
// ============================================================
// ⚠️ הגשר אינו `sites.site_name`, והניסיון הראשון נשבר עליו
// ============================================================
// השמות ב-SiteMonitor נכתבו לתצוגה ("הירקון 224, ת\"א") והשמות ב-FixFlow הגיעו
// מקובץ אתרים אחר ("הירקון 38 ת\"א"). התאמה לפי דמיון נתנה **את אותו ציון בדיוק**
// ל-`ז'בוטניסקי 6 → ז'בוטינסקי 6` (נכון) ול-`ברנדיס 38 → הירקון 38` (שגוי לגמרי) —
// מספר רחוב ו"ת\"א" מספיקים כדי להרים אותו. קישור אתרים לפי ציון דמיון אינו בטוח.
//
// הרמזור הוא הגשר: הוא מחזיק **קוד אתר ושם** באותה שורה, והשמות שבו הם אלה
// שהוקלדו מול אותו קובץ אתרים שממנו נולדו שמות FixFlow. לכן ההתאמה דרכו היא
// שוויון מחרוזות אחרי נרמול, ולא ניחוש.
import { DatabaseSync } from "node:sqlite";
import pg from "pg";

const FIXFLOW_DB =
  process.env.FIXFLOW_DB_PATH ||
  "C:\\Users\\נעמהמנדלסון\\Documents\\FixFlow\\server\\data\\parkomat.sqlite";

const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// גרש בודד, גרשיים ואפוסטרוף כפול הם אותו תו בעיני מי שהקליד. "ר''ג" ו-"ר\"ג" זהים.
const norm = (s) =>
  String(s ?? "")
    .replace(BIDI, "")
    .replace(/['`׳״"]+/g, "")
    .replace(/[,\-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

async function main() {
  const ff = new DatabaseSync(FIXFLOW_DB, { readOnly: true });
  const ffSites = ff
    .prepare(
      `SELECT s.id, s.name, p.id AS profile_id, p.name AS profile, sy.name AS system
         FROM sites s
         JOIN profiles p ON p.id = s.profile_id
         JOIN systems sy ON sy.id = p.system_id
        WHERE s.deleted_at IS NULL`
    )
    .all();
  const profiles = ff
    .prepare(
      `SELECT p.id, p.name, sy.name AS system,
              (SELECT COUNT(*) FROM faults f WHERE f.profile_id = p.id AND f.deleted_at IS NULL) AS faults,
              (SELECT COUNT(*) FROM procedures pr WHERE pr.profile_id = p.id AND pr.deleted_at IS NULL) AS procs
         FROM profiles p JOIN systems sy ON sy.id = p.system_id`
    )
    .all();
  ff.close();

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows: monitored } = await pool.query(`SELECT code, site_name, plc_type, control_system FROM sites ORDER BY code`);
  const { rows: tlCols } = await pool.query(`SELECT key, label FROM traffic_light_columns`);
  const { rows: tlRows } = await pool.query(`SELECT cells FROM traffic_light_rows`);
  await pool.end();

  const colId = (label) => tlCols.find((c) => c.label === label)?.key;
  const SITE = colId("אתר");
  const CODE = colId("קוד אתר");

  // ⚠️ תא "קוד אתר" יכול להחזיק **שני קודים** ("1376, 3501" — שני מתקנים באותו
  // אתר פיזי). פיצול, אחרת שניהם נופלים בשקט.
  const nameByCode = new Map();
  for (const r of tlRows) {
    const raw = r.cells?.[CODE];
    const name = r.cells?.[SITE];
    if (!raw || !name) continue;
    for (const code of String(raw).split(/[,\s]+/).filter(Boolean)) nameByCode.set(code.trim(), name);
  }

  const ffByName = new Map();
  for (const f of ffSites) {
    if (!ffByName.has(norm(f.name))) ffByName.set(norm(f.name), []);
    ffByName.get(norm(f.name)).push(f);
  }

  const used = new Map(); // profile_id -> { profile, system, codes[] }
  const unmatched = [];
  for (const s of monitored) {
    const tlName = nameByCode.get(String(s.code));
    const hit = tlName ? ffByName.get(norm(tlName)) : null;
    if (!hit || hit.length === 0) {
      unmatched.push({ ...s, tlName: tlName ?? null });
      continue;
    }
    for (const h of hit) {
      if (!used.has(h.profile_id)) used.set(h.profile_id, { profile: h.profile, system: h.system, codes: [] });
      used.get(h.profile_id).codes.push(s.code);
    }
  }

  console.log(`\n=== סוגי אתרים שקיימים אצלנו ===`);
  console.log(`אתרים מנוטרים: ${monitored.length}   ·   אתרים ב-FixFlow: ${ffSites.length}   ·   פרופילים ב-FixFlow: ${profiles.length}\n`);

  const inUse = profiles.filter((p) => used.has(p.id));
  const idle = profiles.filter((p) => !used.has(p.id));

  console.log(`✅ בשימוש (${inUse.length}):`);
  for (const p of inUse.sort((a, b) => b.faults - a.faults)) {
    const u = used.get(p.id);
    console.log(
      `   ${String(p.faults).padStart(3)} תקלות · ${String(p.procs).padStart(2)} נהלים   ${p.system.padEnd(7)} ${p.name.padEnd(30)} ← ${u.codes.join(", ")}`
    );
  }

  const idleDocs = idle.reduce((s, p) => s + p.faults + p.procs, 0);
  console.log(`\n⛔ אינם בשימוש (${idle.length}) — ${idleDocs} מסמכים:`);
  for (const p of idle.sort((a, b) => b.faults - a.faults))
    console.log(`   ${String(p.faults).padStart(3)} תקלות · ${String(p.procs).padStart(2)} נהלים   ${p.system.padEnd(7)} ${p.name}`);

  if (unmatched.length) {
    console.log(`\n⚠️  אתרים שלנו שלא נמצאו ב-FixFlow (${unmatched.length}):`);
    for (const s of unmatched)
      console.log(`   ${String(s.code).padEnd(6)} ${String(s.site_name).padEnd(26)} plc=${s.plc_type ?? "—"}   ברמזור: ${s.tlName ?? "— אין שורה —"}`);
  }

  // ============================================================
  // ⚠️ העיגון האמיתי הוא plc_type, לא שם האתר
  // ============================================================
  // החלק שמעל נשען על התאמת שם, והשם נכשל ב-9 מתוך 28 האתרים. התוצאה הייתה
  // ש-`שאטל מסילה` (31 מסמכים) הופיע כ"אינו בשימוש" — בזמן שאתר 1376 נקרא
  // **נמל מסילות** ו-plc_type שלו הוא shuttle-x. מסקנה "176 מסמכים מיותרים"
  // שנשענת על כך הייתה מוחקת תוכן של מכונה שאנחנו כן מפעילים.
  //
  // `plc_type` נכתב בהגדרות הסוכן בכל אתר — אינו ניחוש ואינו תלוי איות.
  const byType = new Map();
  for (const m of monitored) {
    const t = m.plc_type || "(לא הוגדר)";
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(m);
  }
  console.log("\n=== סוגי המכונה בפועל, לפי plc_type בהגדרות הסוכן ===");
  for (const [t, list] of [...byType].sort((a, b) => b[1].length - a[1].length)) {
    const profs = new Set();
    for (const m of list) {
      const tlName = nameByCode.get(String(m.code));
      for (const h of (tlName ? ffByName.get(norm(tlName)) : null) ?? []) profs.add(h.system + " / " + h.profile);
    }
    console.log(`   ${t.padEnd(14)} ${String(list.length).padStart(2)} אתרים   ${list.map((m) => m.code).join(", ")}`);
    console.log(`                  פרופיל ב-FixFlow: ${profs.size ? [...profs].join(" · ") : "— לא ידוע —"}`);
  }

  const total = profiles.reduce((s, p) => s + p.faults + p.procs, 0);
  console.log(`\nסך הכול ${total} מסמכים · ${total - idleDocs} נוגעים לאתרים שלנו · ${idleDocs} אינם`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
