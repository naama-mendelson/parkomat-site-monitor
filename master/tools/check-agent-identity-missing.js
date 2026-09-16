// אילו אתרים חסרים זהות סוכן — כלומר אינם יכולים לכתוב ישירות ל-Supabase.
//
//   node --env-file=.env tools/check-agent-identity-missing.js
//
// ============================================================
// ⚠️ נולד מ-15/09/2026: 19 אתרים איבדו את הזהות בבת אחת
// ============================================================
// זהויות הסוכן (`role='agent'`) הופיעו ב**רשימת המשתמשים**, בין בני אדם.
// 21 שורות `site-XXXX@parkomat.co.il` נראות שם בדיוק כמו זבל שצריך לנקות,
// והן נמחקו — בהיגיון מלא. המחיקה ניתקה את המסלול הישיר ב-19 אתרים באותה
// דקה, ואיש לא ידע: MQTT המשיך למסור, המסכים נשארו נכונים, ורק הפעימה מתה.
//
// ⚠️ **ומה שנשבר עם הפעימה הוא זיהוי הניתוק עצמו** — כלומר היכולת לדעת
// שאתר נפל. אתר בלי זהות אינו מציג שום סימן; הוא פשוט מפסיק לפעום, וזה
// נראה כמו אתר שקט.
//
// הסינון תוקן ב-`list_users` (סוכן אינו מופיע שם יותר), והכלי הזה קיים כדי
// לענות על השאלה השנייה: מי עדיין חסר.
//
// ⚠️ קורא בלבד. הנפקה נעשית מהדשבורד, כפתור "זהות סוכן" בכל שורת אתר —
// כי שם, ורק שם, הסיסמה מוצגת פעם אחת למי שיזין אותה בפועל.
import pg from "pg";

pg.types.setTypeParser(20, (v) => parseInt(v, 10));

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  // ============================================================
  // ⚠️ שלוש שאלות ולא אחת — והגרסה הראשונה שאלה רק את הראשונה
  // ============================================================
  // היא דיווחה `✅ לכל האתרים יש זהות` בזמן ששני אתרים לא פעמו כבר שש שעות:
  // הזהות נוצרה בדשבורד, והסיסמה מעולם לא הוזנה במחשב שבאתר.
  //
  // "יש חשבון" · "מישהו התחבר איתו" · "הוא פועם עכשיו" הם שלושה מצבים שונים,
  // וירוק על הראשון בלבד הוא בדיוק סוג הבדיקה שנותנת ביטחון בלי כיסוי.
  const { rows } = await pool.query(
    `SELECT s.code, s.site_name, s.status,
            (u.id IS NOT NULL) AS has_identity,
            a.seen_at AS last_beat,
            a.agent_version,
            au.last_sign_in_at,
            au.updated_at AS pw_changed_at
       FROM sites s
       LEFT JOIN app_users u ON u.site_id = s.id AND u.role = 'agent' AND u.is_active
       LEFT JOIN alive a     ON a.site_id = s.id
       LEFT JOIN auth.users au ON au.id = u.supabase_uid
      ORDER BY s.code`);
  await pool.end();

  const FRESH_MIN = 3; // אותו סף בדיוק כמו app.mark_silent_agents(3)
  const ageMin = (t) => (t ? (Date.now() - new Date(t)) / 60000 : null);

  const missing = rows.filter((r) => !r.has_identity);
  const have = rows.filter((r) => r.has_identity);
  const beating = have.filter((r) => {
    const a = ageMin(r.last_beat);
    return a !== null && a <= FRESH_MIN;
  });
  // ⚠️ "מעולם לא התחבר" הוא המצב הכי שקט מכולם: בדשבורד הכול נראה תקין —
  // יש זהות, היא פעילה — והאתר פשוט אינו מדווח.
  const neverSignedIn = have.filter((r) => !r.last_sign_in_at && !beating.includes(r));
  const staleBeat = have.filter((r) => !beating.includes(r) && !neverSignedIn.includes(r));

  console.log(`\n=== זהות סוכן — ${rows.length} אתרים ===\n`);
  if (missing.length) {
    console.log(`❌ חסרה זהות (${missing.length}) — לא יכולים לכתוב ישירות ל-Supabase:\n`);
    console.log(`   קוד    אתר                        פעם בעבר?`);
    for (const r of missing) {
      // ⚠️ אתר שפעם בעבר הוא אתר שהמסלול הישיר **עבד** בו ונשבר — כלומר
      // רגרסיה. אתר שמעולם לא פעם פשוט לא הופעל, וזה מצב אחר לגמרי.
      const ever = r.last_beat ? `כן — אחרונה ${String(r.last_beat).slice(0, 19)}` : "מעולם לא";
      console.log(`   ${String(r.code).padEnd(6)} ${String(r.site_name).slice(0, 25).padEnd(27)} ${ever}`);
    }
  } else {
    console.log("✅ לכל האתרים יש זהות סוכן.");
  }
  if (neverSignedIn.length) {
    console.log(`
❌ יש זהות אך **מעולם לא התחברו** (${neverSignedIn.length}) — הסיסמה לא הוזנה במחשב שבאתר:
`);
    for (const r of neverSignedIn)
      console.log(
        `   ${String(r.code).padEnd(6)} ${String(r.site_name).slice(0, 25).padEnd(27)} ` +
          // ⚠️ ISO ולא `String(Date)`. השני מתחיל ב-"Tue Sep 15 2026 ", כלומר
          // חיתוך ל-16 תווים מוחק בדיוק את השעה — הפרט היחיד שמעניין כאן.
          `סיסמה עודכנה ${r.pw_changed_at ? new Date(r.pw_changed_at).toISOString().slice(0, 16).replace("T", " ") : "—"}`
      );
  }
  if (staleBeat.length) {
    console.log(`
⚠️  התחברו בעבר אך אינם פועמים כעת (${staleBeat.length}):
`);
    for (const r of staleBeat) {
      const m = Math.round(ageMin(r.last_beat) ?? 0);
      console.log(
        `   ${String(r.code).padEnd(6)} ${String(r.site_name).slice(0, 25).padEnd(27)} ` +
          (m < 60 ? `לפני ${m} דק׳` : `לפני ${Math.round(m / 60)} שעות`)
      );
    }
  }
  if (beating.length) {
    console.log(`
✅ פועמים עכשיו (${beating.length}): ${beating.map((r) => r.code).join(", ")}`);
  }

  console.log(`\nלהנפקה: דשבורד ← ניהול ← כפתור "זהות סוכן" בשורת האתר.`);
  console.log(`⚠️ הסיסמה מוצגת **פעם אחת בלבד** — Supabase שומרת hash. להעתיק לפני סגירה.`);
  // ⚠️ נופל על כל אחד מהשלושה. אתר שאינו פועם אינו "כמעט תקין" — הוא אתר
  // שאיבדנו עליו את זיהוי הניתוק, וזה בדיוק מה שהכלי הזה קיים כדי לומר.
  process.exit(missing.length + neverSignedIn.length + staleBeat.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
