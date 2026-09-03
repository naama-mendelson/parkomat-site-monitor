// tools/check-ingest-recorder.js — המקליט עצמו תקין.
//
// ============================================================
// ⚠️ למה שער על כלי בדיקה, ולא רק על מה שהוא בודק
// ============================================================
// `lib/ingest-recorder.js` הוא **צד הייחוס** של שער ההשוואה לקליטה שייכתב
// מעליו. מקליט שבור אינו נכשל — הוא מפיק צילום ריק או חלקי, וההשוואה מולו
// יוצאת ירוקה. כלומר בדיוק אותה מחלה שתועדה כאן שוב ושוב: בדיקה שאינה
// יכולה לבדוק אינה אישור.
//
// ⚠️ **וזה כבר קרה, בהרצה הראשונה של המקליט.** מסירה חוזרת של QoS-1
// מייצרת UNIQUE violation; `insertOperation` תופס אותה כראוי, אבל
// ב-Postgres שגיאה בתוך טרנזקציה מבטלת את **כולה**. כל ההודעות כאן
// חולקות טרנזקציה אחת, ולכן הודעה כפולה אחת הרגה את כל ההרצה — המקליט
// לא היה יכול להזין אפילו רצף שגרתי. SAVEPOINT לכל הודעה מחזיר את
// הסמנטיקה של ייצור, שם לכל הודעה יש טרנזקציה משלה.
//
// ⚠️ **הכול רץ בייצור בטרנזקציה שמתבטלת, על אתר סינתטי.** `.env.test`
// אינו קיים. האתר הסינתטי אינו נוחות: `applyStateChange` נועל את שורת
// האתר ב-FOR UPDATE, והרצה על אתר אמיתי הייתה מעכבת את הקליטה החיה שלו.
const db = require("../db/db");
const { makeSite, runJs } = require("./lib/ingest-recorder");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
};

(async () => {
  console.log("=== check-ingest-recorder ===\n");
  await db.init();

  // ⚠️ **רק מספר האתרים נמדד גלובלית, והשאר לפי האתר הסינתטי.**
  // הגרסה הקודמת השוותה ספירות גלובליות של operations ו-status_history
  // לפני ואחרי — ונמדד שהיא נופלת על **תנועה אמיתית**: אתר 2438 רשם תפעול
  // ב-05:38:51 באמצע ריצה, והשער דיווח "עקבות בייצור" על מכונית שנכנסה
  // לחניון. שער שנופל כי הנתונים זזו הוא שער שלומדים להתעלם ממנו.
  //
  // מה שהוא באמת בודק: שהאתר הסינתטי וכל מה שהוא כתב נעלמו. זה נמדד לפי
  // מזהה האתר, והוא חסין לתנועה חיה לחלוטין.
  const sitesBefore = (await db.prepare("SELECT COUNT(*)::int n FROM sites").get()).n;

  const t0 = Math.floor(Date.now() / 1000) - 600;
  let snap = null, ghost = null;

  await db.transaction(async () => {
    const site = await makeSite();
    ghost = { id: site.id, code: site.code };

    snap = await runJs(site, [
      { kind: "state",     payload: { timestamp: t0,      state: "ready" } },
      { kind: "state",     payload: { timestamp: t0 + 60, state: "operating" } },
      { kind: "operation", payload: { timestamp: t0 + 60, start_end: "start", entry_exit: "entry", user: "77", cycle_counter: 100, state: "operating" } },
      // ⚠️ סגירה **ריקה** — נמדד בשטח: exit/start נושא כרטיס ב-100%,
      // exit/end רק ב-67%. הכלל הוא שהפתיחה קובעת.
      { kind: "operation", payload: { timestamp: t0 + 90, start_end: "end", entry_exit: "entry", user: "", cycle_counter: 101, state: "operating" } },
      { kind: "state",     payload: { timestamp: t0 + 95, state: "ready" } },
      // ⚠️ מסירה חוזרת של QoS-1, אותו חותם בדיוק.
      { kind: "operation", payload: { timestamp: t0 + 90, start_end: "end", entry_exit: "entry", user: "", cycle_counter: 101, state: "operating" } },
    ]);

    throw new Error("ROLLBACK-BY-DESIGN");
  }).catch((e) => { if (!String(e.message).includes("ROLLBACK-BY-DESIGN")) throw e; });

  console.log("── המקליט מזין ומצלם ──");
  ok("הצילום אינו ריק", snap && Array.isArray(snap.ops) && snap.ops.length > 0,
     "מקליט ריק מייצר השוואה ירוקה לשווא");

  // ⚠️ הטענה המרכזית: **הרצף המשיך אחרי הכפילות.** בלי SAVEPOINT היה כאן 0.
  ok("⚠️ הרצף שרד מסירה חוזרת", snap.ops.length === 2,
     `${snap.ops.length} תפעולים — צפוי 2 (הכפילות נבלעת, השאר נשמר)`);

  const start = snap.ops.find((o) => o.start_end === "start");
  const end = snap.ops.find((o) => o.start_end === "end");
  ok("הפתיחה נשמרה", Boolean(start));
  ok("הסגירה נשמרה", Boolean(end));

  // ⚠️ הכלל שנמדד על 86 מתוך 1,013 זוגות: הכרטיס נקבע בפתיחה.
  ok("⚠️ הכרטיס עבר מהפתיחה לסגירה", end?.card_number === "77",
     `הסגירה נושאת '${end?.card_number}' — הגיעה ריקה וצריכה לרשת '77'`);

  ok("מקטעי מצב נרשמו", snap.segs.length >= 2, `${snap.segs.length} מקטעים`);
  ok("המקטע האחרון פתוח", snap.segs.at(-1)?.ended_at === null);

  // אתר חדש: הקריאה הראשונה היא בסיס בלבד, המצטבר נשאר 0.
  ok("⚠️ אתר חדש — המונה נשאר 0 והבסיס נשמר",
     snap.site.cycle_total === 0 && snap.site.plc_cycle_last === 101,
     `total=${snap.site.cycle_total} base=${snap.site.plc_cycle_last}`);

  ok("last_seen התקדם", Boolean(snap.site.last_seen));
  ok("אין זריקות ברצף תקין", snap.drops.length === 0,
     JSON.stringify(snap.drops));

  const sitesAfter = (await db.prepare("SELECT COUNT(*)::int n FROM sites").get()).n;

  // ⚠️ נמדד לפי מזהה האתר הסינתטי — כלומר בדיוק מה שהשער יצר, ולא מה
  // ש-16 החניונים עשו בינתיים.
  const leftovers = await db.prepare(
    "SELECT (SELECT COUNT(*)::int FROM sites          WHERE id      = ?) s, " +
    "       (SELECT COUNT(*)::int FROM operations     WHERE site_id = ?) o, " +
    "       (SELECT COUNT(*)::int FROM status_history WHERE site_id = ?) h, " +
    "       (SELECT COUNT(*)::int FROM ingest_drops   WHERE site_code = ?) d"
  ).get(ghost.id, ghost.id, ghost.id, ghost.code);

  console.log("");
  ok("⚠️ האתר הסינתטי וכל מה שכתב נעלמו",
     leftovers.s === 0 && leftovers.o === 0 && leftovers.h === 0 && leftovers.d === 0,
     `נשארו ${JSON.stringify(leftovers)} עבור אתר ${ghost.code}`);

  // ⚠️ נשמר גלובלית **רק** בגלל שתנועה חיה אינה יוצרת אתרים. אתר שנשאר
  // הוא בדיוק הזיהום ש-check-no-residue קיים כדי לתפוס.
  ok("⚠️ ומספר האתרים לא השתנה", sitesBefore === sitesAfter,
     `${sitesBefore} → ${sitesAfter}`);

  console.log(`\n${"=".repeat(50)}`);
  console.log(fail === 0 ? `✅ עברו ${pass}` : `❌ נפלו ${fail} · עברו ${pass}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("שגיאה:", e.message); process.exit(1); });
