// clear-retained-will — מוחק צוואת גשר שמורה ב-HiveMQ.
//
// ============================================================
// ⚠️ למה זה נחוץ: אתר שעזב את MQTT, ו-MQTT שעדיין זוכר אותו
// ============================================================
// הודעת ה-notification של גשר Mosquitto מתפרסמת **retained**, ולכן HiveMQ
// שומר אותה ומוסר אותה לכל מנוי חדש. אתר שעבר למסלול הישיר וה-Mosquitto
// שלו כובה משאיר שם `"0"` — "הגשר מנותק" — **לנצח**.
//
// ⚠️ **נמדד ב-08/09/2026:** כל עלייה של master מסרה מחדש את הצוואה של
// 2438 מ-06/09, וסימנה אתר חי כמנותק. נוסף שומר שדוחה אותה, אבל השומר
// מטפל בסימפטום: ההודעה עדיין מגיעה, נרשמת כזריקה, ותמשיך להגיע לנצח.
// כאן מוחקים אותה במקור.
//
// ============================================================
// ⚠️ שני דברים שאסור לעשות כאן, ושניהם תועדו כבר בדם
// ============================================================
// 1. **לא להתחבר ב-clientId של master.** ל-master יש clientId **קבוע**
//    (זה מה שמחזיק את התור ב-HiveMQ), ו-MQTT דורש ייחודיות — שני תהליכים
//    באותו מזהה מנתקים זה את זה בלולאה אינסופית ואף אחד לא קולט כלום.
//    כאן: מזהה משלנו, ו-`clean: true` כדי שלא ייווצר session מתמשך.
// 2. **לא למחוק צוואה של אתר שחי על MQTT.** שם היא **מנגנון זיהוי הניתוק
//    היחיד** לנפילת חשמל — מחיקתה משאירה אתר מת שנראה תקין. הכלי מסרב,
//    ומתיר רק אתר עם פעימה טרייה במסלול הישיר, או קוד שאינו רשום כלל.
//
//   node --env-file=.env tools/clear-retained-will.js <קוד-אתר> [...]
//   node --env-file=.env tools/clear-retained-will.js --phantoms

const mqtt = require("mqtt");
const db = require("../db/db");

const HOST = process.env.HIVEMQ_HOST;
const PORT = process.env.HIVEMQ_PORT;
const USERNAME = process.env.MASTER_USERNAME;
const PASSWORD = process.env.MASTER_PASSWORD;

// ⚠️ מזהה משלנו, ולא MASTER_CLIENT_ID. ראה הערה 1 למעלה.
const CLIENT_ID = `parkomat-retain-clear-${process.pid}`;

// ⚠️ ל-master יש ב-HiveMQ הרשאת **מנוי** — הוא אינו מפרסם מעולם.
// פרסום שנדחה ב-ACL **אינו מחזיר שגיאה** — ה-PUBACK פשוט לא מגיע,
// והכלי נתלה לנצח בלי לומר מילה. לכן פסק זמן מפורש.
const PUBLISH_TIMEOUT_MS = 8000;

// אפשר להצביע על חשבון אחר (למשל זה של הסוכן, שכן מפרסם).
const PUB_USER = process.env.CLEAR_USERNAME || USERNAME;
const PUB_PASS = process.env.CLEAR_PASSWORD || PASSWORD;
const BEAT_FRESH_SECONDS = 180;

if (!HOST || !PORT || !USERNAME || !PASSWORD) {
  console.error("❌ חסרים HIVEMQ_HOST / HIVEMQ_PORT / MASTER_USERNAME / MASTER_PASSWORD");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function allowed(code) {
  const site = await db.prepare("SELECT id FROM sites WHERE code = ?").get(code);
  if (!site) return { ok: true, why: "האתר אינו רשום — צוואה יתומה" };

  const beat = await db
    .prepare("SELECT EXTRACT(EPOCH FROM (now() - seen_at)) AS age FROM alive WHERE site_id = ?")
    .get(site.id);
  const age = beat?.age == null ? null : Number(beat.age);

  if (age !== null && age < BEAT_FRESH_SECONDS) {
    return { ok: true, why: `הסוכן פועם במסלול הישיר (לפני ${Math.round(age)}s)` };
  }
  return {
    ok: false,
    why: age === null
      ? "האתר על MQTT בלבד — הצוואה היא זיהוי הניתוק היחיד שלו"
      : `הפעימה האחרונה לפני ${Math.round(age)}s — לא נחשב מסלול ישיר פעיל`,
  };
}

async function main() {
  const args = process.argv.slice(2);
  let codes = args.filter((a) => !a.startsWith("--"));

  // ⚠️ קודים שאינם רשומים כלל — שאריות בדיקות שמייצרות רעש בכל עלייה.
  if (args.includes("--phantoms")) {
    const rows = await db.prepare(
      `SELECT DISTINCT site_code FROM ingest_drops
        WHERE reason IN ('bridge_site_not_registered','unknown_topic')
          AND topic LIKE 'sites/%/bridge'`).all();
    codes = codes.concat(rows.map((r) => r.site_code ?? "").filter((c) => c !== null));
  }

  if (codes.length === 0) {
    console.error("שימוש: node --env-file=.env tools/clear-retained-will.js <קוד> [...] [--phantoms]");
    process.exit(1);
  }

  const targets = [];
  for (const code of [...new Set(codes)]) {
    const v = await allowed(code);
    console.log(`${v.ok ? "✅" : "⛔"} ${code || "(ריק)"} — ${v.why}`);
    if (v.ok) targets.push(code);
  }
  if (targets.length === 0) { console.log("\nאין מה למחוק."); return; }

  // ⚠️ **שני חיבורים, ולא מסיבות סגנון.** הקריאה חייבת להיעשות בחשבון של
  // master — הוא המנוי האמיתי, ומה שהוא רואה בעלייה הוא כל השאלה. קריאה
  // בחשבון המפרסם עלולה להחזיר "אין" רק מפני שה-ACL שלו אינו מתיר לו
  // לראות את ה-topic, ואז **"אסור לי לראות" נראה בדיוק כמו "אין מה
  // למחוק"** — אותה מלכודת היעדר שהפילה כאן כבר את בדיקת ה"אחרי".
  const reader = mqtt.connect(`mqtts://${HOST}:${PORT}`, {
    username: USERNAME, password: PASSWORD,
    clientId: `${CLIENT_ID}-read`, clean: true,
  });
  await new Promise((res, rej) => { reader.once("connect", res); reader.once("error", rej); });

  const client = mqtt.connect(`mqtts://${HOST}:${PORT}`, {
    username: PUB_USER, password: PUB_PASS, clientId: CLIENT_ID, clean: true,
  });
  await new Promise((res, rej) => { client.once("connect", res); client.once("error", rej); });
  console.log(`\nמחובר: פרסום כ-${PUB_USER === USERNAME ? "master" : PUB_USER} · קריאה כ-master`);

  // ---------- לפני: מה שמור באמת ----------
  // ⚠️ קוראים לפני שמוחקים. מחיקה של משהו שלא היה שם נראית זהה להצלחה,
  // וזו בדיוק הדרך לדווח "טופל" על בעיה שנשארה.
  const seen = new Map();
  const topics = targets.map((c) => `sites/${c}/bridge`);
  reader.on("message", (t, p, packet) => {
    if (packet.retain) seen.set(t, p.toString() || "(ריק)");
  });
  await new Promise((r) => reader.subscribe(topics, { qos: 1 }, r));
  await sleep(3000);

  console.log("\nשמור כרגע:");
  for (const t of topics) console.log(`  ${t}  ->  ${seen.has(t) ? seen.get(t) : "— אין —"}`);

  // ---------- המחיקה ----------
  // ⚠️ מטען באורך אפס עם retain הוא **הדרך היחידה** למחוק שמור ב-MQTT.
  // פרסום "1" היה משאיר שמור חדש ומשקר: "הגשר מחובר" באתר בלי גשר.
  for (const t of topics) {
    const acked = await Promise.race([
      new Promise((r) => client.publish(t, "", { retain: true, qos: 1 }, () => r(true))),
      sleep(PUBLISH_TIMEOUT_MS).then(() => false),
    ]);
    if (acked) {
      console.log(`  נשלח: ${t}`);
    } else {
      console.log(`  ⏱️ ללא אישור: ${t} — כנראה אין הרשאת פרסום למשתמש הזה`);
      console.log(`     אפשר להצביע על חשבון מפרסם: CLEAR_USERNAME / CLEAR_PASSWORD`);
    }
  }

  client.end(true);
  reader.end(true);

  // ---------- אחרי: **חיבור חדש לגמרי** ----------
  // ⚠️ **הגרסה הראשונה עשתה unsubscribe+subscribe על אותו חיבור,
  // והיא דיווחה הצלחה על מחיקה שלא קרתה.** HiveMQ לא מסר
  // את ההודעה השמורה שוב לאותו לקוח, וההיעדר נראה בדיוק כמו
  // מחיקה. הדרך היחידה לבדוק היא לעשות מה ש-master עושה בעלייה:
  // להתחבר מחדש.
  const check = mqtt.connect(`mqtts://${HOST}:${PORT}`, {
    username: USERNAME, password: PASSWORD,
    clientId: `${CLIENT_ID}-check`, clean: true,
  });
  await new Promise((res, rej) => { check.once("connect", res); check.once("error", rej); });

  const after = new Map();
  check.on("message", (t, p, packet) => { if (packet.retain) after.set(t, p.toString() || "(ריק)"); });
  await new Promise((r) => check.subscribe(topics, { qos: 1 }, r));
  await sleep(3000);

  console.log("\nאחרי — מה שמנוי חדש מקבל (חיבור נפרד):");
  let bad = 0;
  for (const t of topics) {
    const still = after.has(t);
    console.log(`  ${still ? "❌" : "✅"} ${t}  ->  ${still ? after.get(t) : "— אין —"}`);
    if (still) bad++;
  }
  check.end(true);

  console.log(bad ? `\n❌ ${bad} נשארו` : "\n✅ הצוואות נמחקו — עליית master הבאה לא תקבל אותן");
  process.exitCode = bad ? 1 : 0;
}

main()
  .catch((e) => { console.error("❌", e.message); process.exitCode = 1; })
  .finally(async () => { await db.close(); });
