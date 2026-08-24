// האזנה קצרה ל-HiveMQ — קריאה בלבד, כדי לענות "האם הסוכנים משדרים כרגע".
//
// ⚠️ **clientId נפרד ו-clean:true, וזה קריטי.** חיבור עם ה-clientId של
// המאסטר היה עושה שני נזקים: מנתק את המאסטר אם הוא כן רץ אי-שם, ועם
// clean:true אף **מוחק את ה-session השמור** — כלומר מוחק בדיוק את התור
// שאני בא לבדוק. הבדיקה הייתה הורסת את מה שהיא מודדת.
const mqtt = require("mqtt");

const url = `mqtts://${process.env.HIVEMQ_HOST}:${process.env.HIVEMQ_PORT || 8883}`;
const SECONDS = Number(process.argv[2] || 45);

const client = mqtt.connect(url, {
  username: process.env.MASTER_USERNAME,
  password: process.env.MASTER_PASSWORD,
  clientId: `probe-readonly-${process.pid}`,
  clean: true,
});

const retained = [];
const live = [];
let connectedAt = 0;

client.on("connect", () => {
  connectedAt = Date.now();
  console.log(`מחובר ל-${process.env.HIVEMQ_HOST} · מאזין ${SECONDS} שניות\n`);
  client.subscribe(["sites/+/state", "sites/+/operation", "sites/+/bridge"], { qos: 1 });
});

client.on("message", (topic, payload, packet) => {
  // ⚠️ ההודעות שמגיעות ברגע הראשון הן retained — המצב האחרון ששודר, לא
  // שידור חדש. ההבחנה היא כל התשובה: retained אומר "כך היה", הודעה חיה
  // אומרת "המתקן פועל עכשיו".
  const rec = { topic, body: payload.toString().slice(0, 120), retain: packet.retain };
  (packet.retain || Date.now() - connectedAt < 2500 ? retained : live).push(rec);
});

client.on("error", (e) => { console.error("שגיאת חיבור:", e.message); process.exit(1); });

setTimeout(() => {
  const byTopic = (arr, suffix) => arr.filter((r) => r.topic.endsWith(suffix));

  console.log(`── הודעות retained (המצב האחרון ששודר, לא שידור חדש) — ${retained.length} ──`);
  const bridges = byTopic(retained, "/bridge");
  const up = bridges.filter((b) => b.body.trim() === "1");
  console.log(`  bridge: ${bridges.length} אתרים · מחוברים כרגע: ${up.length} · מנותקים: ${bridges.length - up.length}`);
  for (const b of bridges) {
    console.log(`    ${b.topic.replace("sites/", "").replace("/bridge", "").padEnd(10)} ${b.body.trim() === "1" ? "מחובר" : "⚠️ מנותק"}`);
  }
  console.log(`  state: ${byTopic(retained, "/state").length} · operation: ${byTopic(retained, "/operation").length}`);

  console.log(`\n── שידורים חיים במהלך ההאזנה — ${live.length} ──`);
  if (!live.length) console.log("  אף הודעה חדשה לא הגיעה בחלון הזה.");
  for (const m of live.slice(0, 15)) console.log(`  ${m.topic}  ${m.body}`);

  client.end(true, () => process.exit(0));
}, SECONDS * 1000);
