// master.js — מנצח: מדליק MQTT, ingestion, ו-API (כולל SSE)

const bus = require("./bus");
require("./mqtt/subscriber");
const { handleMessage } = require("./ingestion/dispatcher");
const { startApiServer } = require("./api/routes");

console.log("master: started");

bus.on("message", (topic, data) => {
  handleMessage(topic, data);
});

startApiServer();

// תחזוקה יומית: גיבוי → סיכום → ניקוי (בודק כל 24 שעות)
const { runBackup } = require("./tools/backup-db");
const { runMonthlySummary } = require("./tools/monthly-summary");
const { runCleanup } = require("./tools/cleanup-old-data");

function dailyMaintenance() {
  // כל שלב עטוף בנפרד: כשל בסיכום/ניקוי לא צריך להפיל את השרת (MQTT + API)
  // ולא צריך למנוע את השלבים האחרים. חריגה לא-מטופלת כאן הייתה מסיימת את התהליך.
  const steps = [
    ["גיבוי", runBackup],           // 1. ביטוח — לפני כל שינוי
    ["סיכום חודשי", runMonthlySummary], // 2. לחודש שנגמר
    ["ניקוי", runCleanup],          // 3. מעל שנה
  ];
  for (const [name, step] of steps) {
    try {
      step();
    } catch (err) {
      console.error(`[maintenance] שלב '${name}' נכשל:`, err.message);
    }
  }
}

setTimeout(dailyMaintenance, 10 * 1000);
setInterval(dailyMaintenance, 24 * 60 * 60 * 1000);