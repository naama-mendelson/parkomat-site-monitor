// ingestion/operation-handler.js — מטפל בהודעת operation: שומר ב-DB ומונה סייקלים מצטבר מהבקר

const { insertOperation, applyCycleCounter, applyStateChange,
        updateLastSeenIfNewer, getOpenStatusStartedAt } = require("../db/queries");
const bus = require("../bus");

const VALID_STATE = "operating";

async function handleOperation(site, data) {
  const occurredAt = new Date(data.timestamp * 1000).toISOString();
  const receivedAt = new Date().toISOString();

  const opState = data.state;
  const isValid = opState === VALID_STATE;
  const isAnomaly = isValid ? 0 : 1;

  const saveResult = await insertOperation(
    site.id,
    data.start_end,
    data.entry_exit,
    data.user,
    opState,
    isAnomaly,
    occurredAt,
    receivedAt
  );

  if (!saveResult.inserted) {
    console.log(`[operation] אתר ${site.code}: כפילות דולגה (${data.entry_exit}/${data.start_end})`);
    return;
  }

  // פעולה שהתקבלה היא סימן חיים — מקדמים את last_seen (קדימה בלבד).
  await updateLastSeenIfNewer(site.id, occurredAt);

  // הגנת backfill: הודעה שקרתה לפני תחילת המצב הנוכחי הגיעה מאוחר.
  const openStartedAt = await getOpenStatusStartedAt(site.id);
  const isBackfill = openStartedAt && occurredAt < openStartedAt;

  // שדה ה-state בהודעת operation הוא *תמיד* "operating" (תג קבוע של הסוכן, ראה
  // OperationDetector.BuildOperation) — הוא מתאר את סוג הפעולה, לא את המצב החי של
  // האתר. המצב החי נקבע רק מהודעות state, שהסוכן מפרסם *לפני* ה-operation באותו סבב.
  //
  // לכן הודעת operation לא מכתיבה סטטוס. בפרט הודעת end מגיעה *אחרי* שהאתר כבר חזר
  // ל-ready (הודעת ה-state הקודמת), ולולא החריגה כאן הייתה מחזירה אותו בטעות
  // ל-operating וקוברת את מצב ה-ready (זה הבאג ש"ready באמצע יציאה" חשף).
  //
  // רשת ביטחון: רק הודעת start יכולה למשוך את הסטטוס ל-operating — למקרה
  // שהודעת ה-state=operating אבדה. זה תמיד תואם לכיוון הנכון (תחילת פעולה).
  const isStart = data.start_end === "start";
  if (isStart && data.state !== site.status && !isBackfill) {
    await applyStateChange(site.id, data.state, occurredAt);
    console.log(`[operation] אתר ${site.code}: state סונכרן מ-start ${site.status} → ${data.state}`);
  }

  const isEnd = data.start_end === "end";

  // עדכון מונה הסייקלים — רק על end, לפי הערך מהבקר (מצטבר, מטפל ב-reset)
  let cycleResult = null;
  if (isEnd) {
    cycleResult = await applyCycleCounter(site.id, data.cycle_counter, occurredAt);
   if (cycleResult.mode === "reset") {
      console.warn(`[operation] 🔄 אתר ${site.code}: זוהה reset! הבקר ירד (${cycleResult.last} → ${cycleResult.current}). מונה מצטבר = ${cycleResult.total}`);
    } else if (cycleResult.mode === "first") {
      console.log(`[operation] אתר ${site.code}: קריאה ראשונה (בסיס=${cycleResult.current}). מונה מצטבר = ${cycleResult.total}`);
    } else if (cycleResult.mode === "backfill") {
      console.warn(`[operation] ⏮️ אתר ${site.code}: הודעה מאוחרת (Backfill) — בקר=${cycleResult.current}, התעלמנו מהמונה. מונה מצטבר = ${cycleResult.total}`);
    } else {
      console.log(`[operation] אתר ${site.code}: end/${data.entry_exit} | מונה מצטבר = ${cycleResult.total} (בקר=${cycleResult.current})`);
    }
  } else {
    console.log(`[operation] אתר ${site.code}: start/${data.entry_exit} (ללא עדכון מונה)`);
  }

  if (isAnomaly) {
    console.warn(`[operation] ⚠️ אנומליה! אתר ${site.code}: פעולה (${data.entry_exit}) במצב '${opState}'`);
  }

  bus.emit("siteUpdate", {
    type: "operation",
    code: site.code,
    startEnd: data.start_end,
    entryExit: data.entry_exit,
    cardNumber: data.user,
    cycleCounter: data.cycle_counter,
    cycleTotal: cycleResult ? cycleResult.total : null,
    state: opState,
    isAnomaly: isAnomaly,
    occurredAt: occurredAt,
  });
}

module.exports = { handleOperation };