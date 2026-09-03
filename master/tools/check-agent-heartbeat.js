// tools/check-agent-heartbeat.js — הדופק שיחליף את הצוואה של MQTT.
//
// ============================================================
// ⚠️ למה זה חייב שער משלו
// ============================================================
// `check-heartbeat` בודק את אות החיים של **השרת** — הבאנר "נתונים
// אינם מתעדכנים". זה מנגנון אחר לגמרי: שם השרת מדווח על עצמו, וכאן
// **האתר** מדווח על עצמו, ומי שמבחין בשתיקתו הוא `pg_cron` בתוך
// Postgres.
//
// ⚠️ וההבדל הזה הוא כל הנקודה: הסריקה רצה בתוך המסד, ולכן היא שורדת
// את נפילת ה-master. שלוש הנפילות הרב-יומיות שנמדדו לא נתפסו ע"י שום
// מנגנון קיים בדיוק מפני שכולם רצו על המחשב שנפל.
//
// ============================================================
// מה נבדק, ומה כל בדיקה מונעת
// ============================================================
// מחזור חיים שלם על אתר סינתטי: אין דופק → פועם → שותק → מסומן →
// לא מסומן שוב. כל שלב כאן מייצג כשל שהיה קורה בלעדיו.
const db = require("../db/db");
const { makeSite } = require("./lib/ingest-recorder");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
};

const iso = (d) => d.toISOString();

(async () => {
  console.log("=== check-agent-heartbeat ===\n");
  await db.init();

  let site = null, email = null;
  try {
    site = await makeSite();
    // ⚠️ שורת `app_users` בלבד, בלי משתמש auth: הבדיקה אינה זקוקה
    // להתחברות, והיא **לא** יוצרת חשבון שאפשר להיכנס איתו. פחות מה
    // שיכול להישאר מאחור.
    email = `wcheckbeat${Date.now()}@parkomat.co.il`;
    await db.prepare(
      "INSERT INTO app_users (email, role, site_id, is_active, created_at) VALUES (?,?,?,TRUE,?)"
    ).run(email, "agent", site.id, iso(new Date()));

    const state = async () => await db.prepare(
      "SELECT a.seen_at, a.beats, a.agent_version, s.status FROM sites s " +
      "LEFT JOIN alive a ON a.site_id = s.id WHERE s.id = ?").get(site.id);
    // ⚠️ upsert ולא UPDATE: השורה אינה קיימת עד הפעימה הראשונה, וזה
    // בדיוק ההבדל בין "טרם נפרס" ל"מת".
    const beatAt = async (minsAgo) =>
      db.prepare(
        "INSERT INTO alive (site_id, seen_at, beats) VALUES (?, ?, 1) " +
        "ON CONFLICT (site_id) DO UPDATE SET seen_at = EXCLUDED.seen_at, beats = alive.beats + 1")
        .run(site.id, iso(new Date(Date.now() - minsAgo * 60000)));
    const scan = async () => db.prepare("SELECT * FROM app.mark_silent_agents(12)").all();
    const segs = async () => (await db.prepare(
      "SELECT COUNT(*)::int n FROM status_history WHERE site_id = ? AND status = 'no_comm'"
    ).get(site.id)).n;

    // ---- 1. סוכן שהוקם ועוד לא פעם ----
    // ⚠️ NULL אינו "מת". סוכן שהוקם ועוד לא נפרס מעולם לא כתב, והתראה
    // עליו היא רעש על התקנה שטרם קרתה.
    ok("⚠️ סוכן שטרם פעם אינו מסומן כמת", (await scan()).length === 0);

    // ---- 2. הדופק נרשם ----
    await beatAt(0);
    ok("פעימה נרשמת בטבלת alive", (await state()).seen_at !== null);
    ok("⚠️ ואתר שפעם עכשיו אינו מסומן", (await scan()).length === 0);

    // ---- 2ב. הטבלה אינה גדלה, והמונה כן ----
    // ⚠️ **זו התכונה שמאפשרת פעימה כל דקה בכלל.** 18 אתרים × 1,440 פעימות
    // ביום הם 25,920 כתיבות — ואם כל אחת הייתה שורה, הטבלה הייתה גדלה
    // במיליון שורות בחודשיים וצריכה משימת גיזום משלה. `ON CONFLICT` דורס,
    // אז 18 שורות נשארות 18 לנצח.
    await beatAt(0);
    const rows = async () => (await db.prepare(
      "SELECT COUNT(*)::int n FROM alive WHERE site_id = ?").get(site.id)).n;
    ok("⚠️ פעימה שנייה אינה מוסיפה שורה", (await rows()) === 1, `${await rows()}`);
    ok("⚠️ ומונה הפעימות כן עולה", (await state()).beats >= 2, `${(await state()).beats}`);

    // ⚠️ **הגרסה נבדקת ב-`check-agent-write`, לא כאן, ובכוונה.**
    // ה-`COALESCE` ששומר אותה יושב בתוך `ingest_batch`, וכדי להגיע אליו
    // צריך זהות סוכן אמיתית. בדיקה כאן הייתה כותבת ל-`alive` ישירות ואז
    // מוודאת שהכתיבה הישירה שלה עצמה לא מחקה כלום — כלומר בודקת את השער
    // ולא את הפונקציה, ועוברת גם אם ה-COALESCE יימחק.

    // ---- 3. שתיקה מעבר לסף ----
    await beatAt(20);
    const marked = await scan();
    ok("אחרי 20 דקות שתיקה — מסומן", marked.length === 1, JSON.stringify(marked));
    ok("...והמצב עבר ל-no_comm", (await state()).status === "no_comm", (await state()).status);

    // ⚠️ **מקטע ולא רק צ'יפ.** סימון דרך UPDATE ישיר על sites.status היה
    // משנה את המסך ומשאיר את ההיסטוריה בלי המקטע — כלומר חישוב זמינות
    // שאינו יודע שהאתר היה מנותק. לכן הסימון עובר ב-app.ingest_state.
    ok("⚠️ ונפתח מקטע מצב בהיסטוריה", (await segs()) === 1, `${await segs()}`);

    // ---- 4. סריקה חוזרת ----
    // ⚠️ **הבדיקה החשובה ביותר כאן, והסריקה רצה עכשיו כל דקה.**
    // מקטע חדש בכל סריקה היה 1,440 מקטעי נתק ביום, והזמינות הופכת לרעש.
    // ⚠️ ומי שמונע את זה הוא **שומר האי-שינוי ב-`app.ingest_state`**, ולא
    // התנאי `status <> 'no_comm'` בסריקה — מוטציה הראתה שהסרתו משאירה את
    // השער ירוק. התנאי חוסך קריאה מיותרת; ההגנה יושבת שם.
    await scan();
    await scan();
    ok("⚠️ סריקה חוזרת אינה פותחת מקטע שני", (await segs()) === 1, `${await segs()}`);

    // ---- 5. תחזוקה גוברת ----
    // אתר שמישהו הכניס לתחזוקה אמור להיות שקט.
    await db.prepare("UPDATE sites SET status = 'maintenance' WHERE id = ?").run(site.id);
    ok("⚠️ אתר בתחזוקה אינו מסומן כשקט", (await scan()).length === 0);

    // ---- 6. אתר בלי סוכן — לא נוגעים בו ----
    // ⚠️ **הבדיקה שמונעת את הכשל הגרוע ביותר כאן.** אתר שעדיין על MQTT
    // בלבד לעולם אין לו שורה ב-alive, וסריקה תמימה הייתה מסמנת את כל
    // 16 האתרים כמתים ברגע שהיא נדלקת.
    await db.prepare("DELETE FROM app_users WHERE LOWER(email) = LOWER(?)").run(email);
    await db.prepare("UPDATE sites SET status = 'ready' WHERE id = ?").run(site.id);
    ok("⚠️ אתר בלי זהות סוכן אינו נסרק כלל", (await scan()).length === 0);

    // ---- 7. הסף עצמו ----
    // ⚠️ סף שאינו פרמטר היה מספר קסם בתוך המשימה, ושינויו היה דורש
    // עריכה של הקריאה. כאן נבדק שהוא באמת משפיע.
    await db.prepare(
      "INSERT INTO app_users (email, role, site_id, is_active, created_at) VALUES (?,?,?,TRUE,?)"
    ).run(email, "agent", site.id, iso(new Date()));
    await beatAt(20);
    ok("⚠️ סף גדול מהשתיקה — אינו מסמן",
      (await db.prepare("SELECT * FROM app.mark_silent_agents(60)").all()).length === 0);
  } finally {
    // ⚠️ ניקוי בכל מסלול יציאה, כולל כשל. שער שמותיר אתר סינתטי בייצור
    // מייצר בדיוק את הזיהום ש-check-no-residue קיים כדי לתפוס.
    if (site) {
      for (const t of ["alive", "status_history", "operations", "suppressed_faults"])
        await db.prepare(`DELETE FROM ${t} WHERE site_id = ?`).run(site.id).catch(() => {});
      await db.prepare("DELETE FROM events WHERE site_code = ?").run(site.code).catch(() => {});
      if (email) await db.prepare("DELETE FROM app_users WHERE LOWER(email) = LOWER(?)")
        .run(email).catch(() => {});
      await db.prepare("DELETE FROM sites WHERE id = ?").run(site.id).catch(() => {});
    }
  }

  const left = await db.prepare(
    "SELECT COUNT(*)::int AS n FROM app_users WHERE email LIKE 'wcheckbeat%'").get();
  console.log("");
  ok("⚠️ אפס זהויות סוכן סינתטיות נשארו", left.n === 0, `נשארו ${left.n}`);

  console.log(`\n${"=".repeat(50)}`);
  console.log(fail === 0 ? `✅ עברו ${pass}` : `❌ נפלו ${fail} · עברו ${pass}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("check-agent-heartbeat: נפל —", e.message); process.exit(1); });
