// tools/parity-ingest-op.js — מסלול התפעולים: המסלול הקיים מול ה-SQL.
//
// ============================================================
// ⚠️ שני אתרים סינתטיים, אותן הודעות, והשוואת התוצאה
// ============================================================
// כל תרחיש רץ פעמיים בתוך אותה טרנזקציה שמתבטלת: פעם דרך `handleMessage`
// (המסלול שרץ היום בייצור) ופעם דרך `app.ingest_operation`. שני האתרים
// נבראים זה לצד זה, מקבלים את אותן הודעות באותו סדר, ואז מצולמים.
//
// ⚠️ **אתרים סינתטיים, לא אמיתיים** — וזו אינה נוחות: `applyStateChange`
// נועל את שורת האתר ב-FOR UPDATE, והרצה על אתר של לקוח הייתה מעכבת את
// הקליטה החיה שלו לכל אורך ההשוואה.
//
// ⚠️ **והתרחישים מיוצרים ולא נלקחים מהייצור.** הכללים שנבדקים כאן —
// ירושת כרטיס, איחוד ריצוד, ניסיון חוזר — נולדו ממקרים **נדירים**:
// 86 מתוך 1,013 זוגות, 33 מקרי ריצוד בכל ההיסטוריה. השוואה על הודעות
// אקראיות מהייצור הייתה עוברת בלי לגעת באף אחד מהם, ומדווחת ירוק.
const db = require("../db/db");
const { makeSite, runJs, snapshot } = require("./lib/ingest-recorder");

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

/** מריץ את אותן הודעות דרך ה-SQL, על אתר משלו. */
async function runSql(site, messages) {
  for (const m of messages) {
    if (m.kind !== "operation") {
      // ⚠️ הודעות state עדיין עוברות במסלול הקיים: הפורט שלהן טרם נכתב.
      // בלעדיהן אין מקטעי מצב, ואז שומר ה-backfill ו"תחזוקה גוברת" לא
      // נבדקים כלל — כלומר חצי מהכללים היו נראים ירוקים בלי לרוץ.
      const { handleMessage } = require("../ingestion/dispatcher");
      await handleMessage(`sites/${site.code}/${m.kind}`, Buffer.from(JSON.stringify(m.payload)));
      continue;
    }
    const p = m.payload;
    await db.prepare(
      "SELECT * FROM app.ingest_operation(?, ?, ?, ?, ?, ?, ?, ?)"
    ).get(site.id, p.start_end, p.entry_exit, p.user ?? "", p.state,
          new Date(p.timestamp * 1000).toISOString(),
          new Date(p.timestamp * 1000).toISOString(),
          Number.isInteger(p.cycle_counter) ? p.cycle_counter : null);
  }
  return await snapshot(site.id);
}

// ⚠️ הצילומים מושווים בלי `id` ובלי `reported_at`: מזהים הם רצף גלובלי
// והם **חייבים** להיבדל בין שני אתרים. מה שמושווה הוא ההחלטות.
const shape = (snap) => ({
  ops: snap.ops.map((o) => ({
    start_end: o.start_end, entry_exit: o.entry_exit, card: o.card_number,
    state: o.state, anomaly: o.is_anomaly, at: o.occurred_at,
    cycle: o.cycle_counter, superseded: o.superseded ?? null,
  })),
  segs: snap.segs.map((s) => ({ status: s.status, from: s.started_at, to: s.ended_at })),
  site: { status: snap.site.status, last_seen: snap.site.last_seen,
          cycle_total: snap.site.cycle_total, plc_cycle_last: snap.site.plc_cycle_last },
});

async function scenario(name, build) {
  const t0 = Math.floor(Date.now() / 1000) - 7200;
  const messages = build(t0);
  let jsSnap = null, sqlSnap = null;

  await db.transaction(async () => {
    const a = await makeSite();
    const b = await makeSite();
    jsSnap = await runJs(a, messages);
    sqlSnap = await runSql(b, messages);
    throw new Error("ROLLBACK-BY-DESIGN");
  }).catch((e) => { if (!String(e.message).includes("ROLLBACK-BY-DESIGN")) throw e; });

  const before = diffs;
  const j = shape(jsSnap), s = shape(sqlSnap);
  cmp(`${name} · תפעולים`, j.ops, s.ops);
  cmp(`${name} · מקטעים`, j.segs, s.segs);
  cmp(`${name} · שורת האתר`, j.site, s.site);
  if (before === diffs) console.log(`  ✅ ${name}`);
}

(async () => {
  console.log("=== parity-ingest-op ===\n");
  await db.init();

  const op = (ts, start_end, entry_exit, user, cycle) =>
    ({ kind: "operation", payload: { timestamp: ts, start_end, entry_exit, user, cycle_counter: cycle, state: "operating" } });
  const st = (ts, state) => ({ kind: "state", payload: { timestamp: ts, state } });

  await scenario("זוג פשוט", (t) => [
    st(t, "operating"), op(t, "start", "entry", "77", 100),
    op(t + 30, "end", "entry", "77", 101), st(t + 35, "ready"),
  ]);

  // ⚠️ הכלל שנמדד על 86 מתוך 1,013 זוגות.
  await scenario("סגירה ריקה — ירושת כרטיס", (t) => [
    st(t, "operating"), op(t, "start", "exit", "42", 200),
    op(t + 25, "end", "exit", "", 201), st(t + 30, "ready"),
  ]);

  // ⚠️ הסגירה נושאת את הכרטיס של הרכב **הבא** — הצורה המסוכנת יותר,
  // כי היא נראית כנתון תקין.
  await scenario("סגירה עם כרטיס זר", (t) => [
    st(t, "operating"), op(t, "start", "exit", "10", 300),
    op(t + 20, "end", "exit", "6", 301), st(t + 25, "ready"),
  ]);

  await scenario("מסירה חוזרת של QoS-1", (t) => [
    st(t, "operating"), op(t, "start", "entry", "5", 400),
    op(t + 15, "end", "entry", "5", 401),
    op(t + 15, "end", "entry", "5", 401),
    st(t + 20, "ready"),
  ]);

  // ⚠️ 33 מקרים בכל ההיסטוריה, כולם 1–13 שניות.
  await scenario("ריצוד MODE — איחוד", (t) => [
    st(t, "operating"), op(t, "start", "exit", "9", 500),
    op(t + 5, "end", "exit", "9", 501),
    op(t + 8, "start", "exit", "9", 501),
    op(t + 40, "end", "exit", "9", 502), st(t + 45, "ready"),
  ]);

  await scenario("מונה — אתחול בקר", (t) => [
    st(t, "operating"), op(t, "start", "entry", "1", 5000),
    op(t + 20, "end", "entry", "1", 5000),
    op(t + 60, "start", "entry", "2", 3),
    op(t + 80, "end", "entry", "2", 3), st(t + 85, "ready"),
  ]);

  await scenario("מונה — קפיצה חשודה", (t) => [
    st(t, "operating"), op(t, "start", "entry", "1", 100),
    op(t + 20, "end", "entry", "1", 100),
    op(t + 40, "start", "entry", "2", 65535),
    op(t + 60, "end", "entry", "2", 65535), st(t + 65, "ready"),
  ]);

  // ⚠️ פעולה בזמן תחזוקה מהבקר: הסטטוס לא יימשך ל-operating.
  await scenario("תחזוקה גוברת", (t) => [
    st(t, "maintenance"),
    op(t + 30, "start", "entry", "3", 700),
    op(t + 50, "end", "entry", "3", 701),
  ]);

  // ============================================================
  // ⚠️ התרחיש הזה נוסף אחרי שמוטציה **עברה** את השער
  // ============================================================
  // הפלתי בכוונה את הכלל `last_seen` זז קדימה בלבד — והשער נשאר ירוק.
  // הסיבה: כל התרחישים ששת שולחים הודעות בסדר זמנים עולה, ולכן ההבדל
  // בין "קדימה בלבד" ל"תמיד" אינו יכול להתגלות בהם.
  //
  // ⚠️ וזה בדיוק באג ייצור מתועד: *"הודעה שהגיעה באיחור גררה את last_seen
  // אחורה"*. אתר שדיווח לפני שנייה היה נראה כמי שלא נראה כבר שעה.
  //
  // ההודעה המאוחרת נשלחת **אחרי** הודעה חדשה יותר, וזה המצב האמיתי:
  // פריקת תור אחרי נתק מוסרת הודעות ישנות אל תוך הווה חדש יותר.
  await scenario("הודעה מאוחרת — last_seen אינו נסוג", (t) => [
    st(t, "operating"),
    op(t + 600, "start", "entry", "8", 800),
    op(t + 630, "end", "entry", "8", 801),
    st(t + 640, "ready"),
    // ⚠️ 10 דקות **אחורה**, ומגיעה עכשיו.
    op(t + 60, "start", "exit", "9", 802),
    op(t + 90, "end", "exit", "9", 803),
  ]);

  console.log(`\n${"=".repeat(50)}`);
  console.log(diffs === 0
    ? `✅ נקי — ${checks} השוואות, 0 הבדלים`
    : `❌ ${diffs} הבדלים מתוך ${checks} השוואות`);
  process.exit(diffs === 0 ? 0 : 1);
})().catch((e) => { console.error("שגיאה:", e.message); process.exit(1); });
