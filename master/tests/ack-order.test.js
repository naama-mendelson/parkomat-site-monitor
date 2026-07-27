// tests/ack-order.test.js — ההודעה מאושרת ל-HiveMQ רק אחרי שהיא נכתבה.
//
// הרגרסיה שהבדיקה הזו נועלת עלתה בשטח ב-26-27/07/2026: QoS 1 מבטיח מסירה
// "לפחות פעם אחת", אבל רק עד ה-PUBACK. ברירת המחדל של MQTT.js מאשרת מיד עם
// ההגעה, ומשם ההודעה חיה בזיכרון בלבד — ולכן קריסה של השרת מחקה אותה גם
// מהתור של הברוקר. חמישה אתרים נשארו עם פעולת start חסרה.
//
// כמו dispatcher.test.js, ה-stub נעשה דרך require.cache — בלי תלות חדשה
// ובלי רשת. mqtt מזויף כאן, ולכן subscriber.js לא מנסה להתחבר לשום מקום.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const MQTT = require.resolve("mqtt");
const SUBSCRIBER = require.resolve("../mqtt/subscriber");
const BUS = require.resolve("../bus");

const stub = (filename, exports) => {
  require.cache[filename] = {
    id: filename, filename, path: path.dirname(filename),
    loaded: true, children: [], paths: [], exports,
  };
};

/** טוען subscriber טרי מעל לקוח MQTT מזויף, ומחזיר אותו ואת ה-bus. */
function loadSubscriber() {
  Object.assign(process.env, {
    HIVEMQ_HOST: "test.invalid", HIVEMQ_PORT: "8883",
    MASTER_USERNAME: "u", MASTER_PASSWORD: "p",
  });

  const client = new EventEmitter();
  client.subscribe = () => {};
  client.end = (_force, _opts, cb) => cb && cb();

  stub(MQTT, { connect: () => client });
  delete require.cache[BUS];
  delete require.cache[SUBSCRIBER];
  const bus = require(SUBSCRIBER);

  return { client, bus };
}

const packetFor = (topic, payload) => ({ topic, payload: Buffer.from(payload) });

/** עוטף את handleMessage ב-Promise, כדי לבדוק *מתי* ה-callback נקרא. */
const ack = (client, packet) =>
  new Promise((resolve) => client.handleMessage(packet, (err) => resolve(err ?? null)));

test("ה-PUBACK נשלח רק אחרי שהעיבוד הסתיים", async () => {
  const { client, bus } = loadSubscriber();

  const order = [];
  let releaseProcessing;
  const processingStarted = new Promise((r) => (releaseProcessing = r));

  bus.setMessageProcessor(async () => {
    order.push("processing-start");
    await new Promise((r) => setTimeout(r, 20));
    order.push("processing-done");
  });

  const acked = ack(client, packetFor("sites/1348/state", "{}")).then(() => {
    order.push("acked");
  });

  releaseProcessing();
  await processingStarted;
  await acked;

  // זה הלב: 'acked' חייב להיות אחרי 'processing-done'. אם הוא לפניו, ההודעה
  // נמחקה מהתור של HiveMQ לפני שנכתבה — וקריסה כאן מאבדת אותה.
  assert.deepEqual(order, ["processing-start", "processing-done", "acked"]);
});

test("העיבוד מקבל את ה-topic ואת ה-payload כמחרוזת", async () => {
  const { client, bus } = loadSubscriber();

  const seen = [];
  bus.setMessageProcessor(async (topic, payload) => seen.push([topic, payload]));

  await ack(client, packetFor("sites/3513/operation", '{"start_end":"end"}'));

  assert.deepEqual(seen, [["sites/3513/operation", '{"start_end":"end"}']]);
});

test("בלי מעבד רשום — לא מאשרים, כדי שההודעה תישאר בתור", async () => {
  const { client } = loadSubscriber();

  const err = await ack(client, packetFor("sites/1348/state", "{}"));

  // callback עם שגיאה = אין PUBACK. ההודעה נשארת אצל HiveMQ ותימסר שוב,
  // וזה עדיף על לאבד אותה בשקט בגלל תקלת סדר-אתחול.
  assert.ok(err instanceof Error, "היה צריך להיכשל ולא לאשר");
});

test("כשל אפליקטיבי בעיבוד — מאשרים בכל זאת (לא חוסמים את התור)", async () => {
  const { client, bus } = loadSubscriber();

  bus.setMessageProcessor(async () => { throw new Error("DB למטה"); });

  const err = await ack(client, packetFor("sites/1348/state", "{}"));

  // הודעה תקולה שלא מאושרת הייתה חוזרת בכל חיבור מחדש וחוסמת את מה שאחריה.
  // האיזון: קריסה כבר לא מאבדת הודעה, אבל כשל עיבוד עדיין נרשם-ונזרק.
  assert.equal(err, null, "היה צריך לאשר למרות הכשל");
});

test("הודעות מעובדות אחת-אחת — ה-backpressure נשמר", async () => {
  const { client, bus } = loadSubscriber();

  let active = 0;
  let maxActive = 0;
  bus.setMessageProcessor(async () => {
    maxActive = Math.max(maxActive, ++active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
  });

  // הברוקר לא ירוץ קדימה מעבר לקצב הכתיבה: כל הודעה ממתינה ל-PUBACK של
  // קודמתה. כאן מדמים את זה — ממתינים לכל אחת לפני ששולחים את הבאה.
  for (const i of [1, 2, 3]) {
    await ack(client, packetFor(`sites/134${i}/state`, "{}"));
  }

  assert.equal(maxActive, 1, "שתי הודעות עובדו במקביל");
});
