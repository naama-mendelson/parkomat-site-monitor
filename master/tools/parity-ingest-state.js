// tools/parity-ingest-state.js — מסלול המצב: המסלול הקיים מול ה-SQL.
//
// ============================================================
// ⚠️ מה נבדק כאן, ולמה כל אחד מהם קשה לתפוס אחרת
// ============================================================
// כל תרחיש רץ פעמיים בתוך אותה טרנזקציה שמתבטלת, על שני אתרים סינתטיים:
// פעם דרך `handleMessage` (מה שרץ היום בייצור) ופעם דרך `app.ingest_state`.
//
// ⚠️ **הצוואה המאוחרת** אינה יכולה להיבדק על נתוני ייצור אקראיים: היא
// דורשת אתר שנשמע לפני פחות מ-90 שניות ומיד אחריו הודעת no_comm. זה קורה
// בדיוק כשהתור נפרק אחרי נתק — כלומר במקרה שאיש אינו מייצר בכוונה.
//
// ⚠️ **תקלה בזמן תחזוקה** דורשת חלון תחזוקה פעיל, ובייצור יש **אפס**
// חלונות ידניים. כלומר בלי לייצר אותו, הכלל היה נראה ירוק בלי לרוץ.
const db = require("../db/db");
const { makeSite, runJs, snapshot } = require("./lib/ingest-recorder");
const { handleMessage } = require("../ingestion/dispatcher");

let checks = 0, diffs = 0;

function cmp(label, a, b) {
  checks++;
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A === B) return true;
  diffs++;
  console.log(`  ❌ ${label}`);
  console.log(`     JS : ${A}`);
  console.log(`     SQL: ${B}`);
  return false;
}

async function runSql(site, messages) {
  for (const m of messages) {
    if (m.kind !== "state") {
      await handleMessage(`sites/${site.code}/${m.kind}`, Buffer.from(JSON.stringify(m.payload)));
      continue;
    }
    const p = m.payload;
    await db.prepare("SELECT * FROM app.ingest_state(?, ?, ?, ?)").get(
      site.id, p.state,
      new Date(p.timestamp * 1000).toISOString(),
      p.faultText ?? null);
  }
  return await snapshot(site.id);
}

// ⚠️ ה-`no_comm` נחתם ב"עכשיו" בשני הצדדים, ולכן החותם שלו **חייב**
// להיבדל בשבריר שנייה. הוא מנוטרל בהשוואה, ובמקומו נבדק שהמצב עצמו זהה —
// אחרת השער היה אדום תמיד ואיש לא היה מריץ אותו.
const NOCOMM = "<<עכשיו>>";
const norm = (v, status) => (status === "no_comm" ? NOCOMM : v);

const shape = (snap) => ({
  segs: snap.segs.map((s) => ({
    status: s.status,
    from: norm(s.started_at, s.status),
    to: s.ended_at === null ? null : "<<סגור>>",
    fault: s.fault_text,
  })),
  site: { status: snap.site.status, last_seen: norm(snap.site.last_seen, null) },
  drops: snap.drops.map((d) => d.reason),
});

async function scenario(name, build, opts = {}) {
  const t0 = Math.floor(Date.now() / 1000) - 7200;
  const messages = build(t0);
  let a = null, b = null, jsSnap = null, sqlSnap = null;

  await db.transaction(async () => {
    a = await makeSite();
    b = await makeSite();
    if (opts.window) {
      // חלון תחזוקה ידני על שני האתרים, זהה לחלוטין.
      for (const s of [a, b]) {
        await db.prepare(
          "INSERT INTO maintenance_windows (site_id, set_by_name, reason, started_at, duration_hours, expires_at) " +
          "VALUES (?, 'parity-ingest-state', 'בדיקה', ?, 2, ?)"
        ).run(s.id, new Date(Date.now() - 60000).toISOString(),
              new Date(Date.now() + 3600000).toISOString());
      }
    }
    jsSnap = await runJs(a, messages);
    sqlSnap = await runSql(b, messages);
    throw new Error("ROLLBACK-BY-DESIGN");
  }).catch((e) => { if (!String(e.message).includes("ROLLBACK-BY-DESIGN")) throw e; });

  const before = diffs;
  const j = shape(jsSnap), s = shape(sqlSnap);
  cmp(`${name} · מקטעים`, j.segs, s.segs);
  cmp(`${name} · שורת האתר`, j.site, s.site);
  if (before === diffs) console.log(`  ✅ ${name}`);
}

(async () => {
  console.log("=== parity-ingest-state ===\n");
  await db.init();

  const st = (ts, state, faultText) =>
    ({ kind: "state", payload: { timestamp: ts, state, ...(faultText ? { faultText } : {}) } });

  await scenario("רצף מצבים פשוט", (t) => [
    st(t, "ready"), st(t + 60, "operating"), st(t + 120, "ready"),
  ]);

  await scenario("אותו מצב פעמיים — אין מקטע חדש", (t) => [
    st(t, "operating"), st(t + 30, "operating"), st(t + 60, "ready"),
  ]);

  await scenario("תקלה ואז חזרה", (t) => [
    st(t, "ready"), st(t + 60, "error"), st(t + 90, "ready"),
  ]);

  // ⚠️ הודעה מאוחרת מול המקטע הפתוח — נזרקת.
  await scenario("הודעת state מאוחרת", (t) => [
    st(t, "ready"), st(t + 600, "operating"), st(t + 300, "error"),
  ]);

  // ⚠️ תקלה בזמן תחזוקה מהבקר: מושמטת לגמרי מהמדדים.
  await scenario("תקלה בזמן תחזוקה מהבקר", (t) => [
    st(t, "maintenance"), st(t + 60, "error"),
  ]);

  // ⚠️ ואותו כלל דרך חלון ידני — הצורה שאין לה **אף מקרה** בייצור.
  await scenario("תקלה בזמן חלון ידני", (t) => [
    st(t, "ready"), st(t + 60, "error"),
  ], { window: true });

  await scenario("תיאור תקלה שהגיע באיחור", (t) => [
    st(t, "ready"), st(t + 60, "error"), st(t + 70, "error", "מיטה 5 - בוכנה 2"),
  ]);

  // ============================================================
  // ⚠️ שני התרחישים האלה נוספו אחרי ששתי מוטציות **עברו** את השער
  // ============================================================
  // הפלתי בכוונה את הכלל "no_comm אינו מעדכן last_seen" ואת סף הצוואה
  // (90→0). שניהם עברו, מסיבה אחת: **לא היה כאן אף תרחיש שמשדר no_comm.**
  // כלומר כל מסלול הנתק — הכלל היחיד שמפריד בין "האתר שקט" ל"האתר נראה" —
  // לא נבדק כלל, והשער דיווח ירוק.
  const NOW = Math.floor(Date.now() / 1000);

  // ⚠️ האתר נשמע לפני שעתיים ⇒ השתיקה ארוכה מ-90 שניות ⇒ הצוואה מתקבלת.
  // וכשהיא מתקבלת, `last_seen` **אינו זז** — נתק אינו סימן חיים.
  await scenario("נתק מתקבל — last_seen אינו זז", (t) => [
    st(t, "ready"),
    st(t + 60, "operating"),
    st(NOW, "no_comm"),
  ]);

  // ⚠️ האתר נשמע לפני עשר שניות ⇒ הצוואה **מאוחרת** ונדחית. לצוואה אין
  // חותם משלה, ולכן היא נחתמת ב"עכשיו" — תמיד הזמן החדש ביותר שקיים —
  // ובלי הסף הזה היא הייתה עוברת את שומר ה-backfill, דורסת את המצב
  // העדכני, ומסמנת כמנותק אתר שדיווח לפני שנייה.
  await scenario("צוואה מאוחרת נדחית", () => [
    st(NOW - 600, "ready"),
    st(NOW - 10, "operating"),   // נשמע לפני 10 שניות
    st(NOW, "no_comm"),          // < 90 ⇒ נדחית
  ]);

  console.log(`\n${"=".repeat(50)}`);
  console.log(diffs === 0
    ? `✅ נקי — ${checks} השוואות, 0 הבדלים`
    : `❌ ${diffs} הבדלים מתוך ${checks} השוואות`);
  process.exit(diffs === 0 ? 0 : 1);
})().catch((e) => { console.error("שגיאה:", e.message); process.exit(1); });
