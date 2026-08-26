// ingestion/operation-handler.js — מטפל בהודעת operation: שומר ב-DB ומונה סייקלים מצטבר מהבקר

const db = require("../db/db");
const { insertOperation, applyCycleCounter, applyStateChange,
        updateLastSeenIfNewer, getOpenStatusStartedAt,
        getActiveMaintenance, inheritCardFromStart,
        supersedeInterruptedAttempt, supersedeFlicker } = require("../db/queries");
const bus = require("../bus");

const VALID_STATE = "operating";

// ============================================================
// כל הכתיבות של פעולה אחת — טרנזקציה אחת
// ============================================================
// קודם הן היו ארבע כתיבות עצמאיות: insertOperation, updateLastSeenIfNewer,
// applyStateChange, applyCycleCounter. כל אחת commit בנפרד, וזה שבר את הקישור
// שביניהן ברגע שנוסף ניסיון חוזר על שגיאות DB חולפות:
//
//   insertOperation מצליח  →  applyCycleCounter נכשל (ECONNRESET מה-pooler)
//   → handleMessage מנסה שוב את ההודעה **השלמה**
//   → insertOperation מחזיר עכשיו duplicate ויוצא מוקדם (וזה נכון!)
//   → **applyCycleCounter לעולם לא ירוץ עבור הפעולה הזאת.**
//
// התוצאה: שורת הפעולה קיימת ב-operations, אבל cycle_total לא התקדם בגללה.
// זה חוסר-סינכרון שקט וקבוע בין ספירת הפעולות למונה הבלאי, והוא נעשה סביר
// יותר בדיוק כשהתשתית מתנדנדת — כלומר כשהכי חשוב שהנתונים יהיו נכונים.
//
// עם טרנזקציה אחת: כשל בכל שלב מגלגל לאחור גם את ה-INSERT, ולכן הניסיון החוזר
// מתחיל מדף חלק ומבצע את שני הצדדים. ה-dedup ממשיך להגן על מסירה חוזרת
// *אמיתית* של QoS-1 — שם ה-INSERT הוא זה שנכשל, ואין מה לגלגל.
//
// db.transaction מצטרפת לטרנזקציה קיימת ולא פותחת חדשה (ראה db.js), ולכן
// applyCycleCounter ו-applyStateChange שבתוכה רצים על אותו חיבור ואותה נעילה.
async function handleOperation(site, data) {
  const occurredAt = new Date(data.timestamp * 1000).toISOString();
  const receivedAt = new Date().toISOString();

  // החותם כפי שהאתר שידר אותו — לפני כל יישור. זהו מפתח ה-dedup, ולכן הוא
  // חייב לשרוד ללא שינוי בין מסירות חוזרות. ה-dispatcher מציב אותו; אם הוא
  // חסר (קורא ישן/בדיקה), נופלים ל-occurred_at וההתנהגות זהה לקודם.
  const reportedAt = new Date(
    (data.reported_timestamp ?? data.timestamp) * 1000).toISOString();

  const opState = data.state;
  const isValid = opState === VALID_STATE;
  const isAnomaly = isValid ? 0 : 1;

  // האירועים נאספים ומשודרים **אחרי** ה-commit: שידור מתוך הטרנזקציה היה
  // מודיע לדשבורדים על נתון שעדיין עלול להתגלגל לאחור.
  const result = await db.transaction(() =>
    persistOperation(site, data, { occurredAt, receivedAt, reportedAt, opState, isAnomaly }));

  if (result.emit) {
    bus.publish(result.emit);
  }
}

async function persistOperation(site, data, { occurredAt, receivedAt, reportedAt, opState, isAnomaly }) {
  // ==========================================================
  // הכרטיס של הפעולה נקבע ב**פתיחה**, לא בסגירה
  // ==========================================================
  // שני כשלים שונים הובילו לאותה מסקנה, ושניהם נמדדו על נתוני אמת:
  //
  //   1. **סגירה ריקה** — בחלק מהבקרים רגיסטר הכרטיס מתאפס לפני שה-MODE
  //      יוצא ממצב הפעולה. exit/start נשא כרטיס ב-100%, exit/end רק ב-67%.
  //
  //   2. **סגירה עם הכרטיס של הרכב הבא** — חמור יותר, כי הוא לא נראה כחסר
  //      אלא כנתון תקין. נמדד: 86 מתוך 1,013 זוגות (8.5%), ובחולדה 4 לבדה 66.
  //      הרצף בגולדברג 5 מדגים:
  //
  //          03:45  exit/start  כרטיס 10
  //          03:51  exit/end    כרטיס 6     <- הכרטיס של הפעולה הבאה
  //          04:33  exit/start  כרטיס 6
  //          04:39  exit/end    כרטיס 7     <- ושוב
  //
  //      השורש בסוכן: _operationCard מאמץ **כל** כרטיס לא-ריק שנראה לאורך
  //      הפעולה, ולכן נהג שמעביר כרטיס בזמן שהפעולה הקודמת עוד רצה — גונב
  //      אותה. תוקן גם שם, אבל השרת אינו יכול לחכות לעדכון גרסה בשטח.
  //
  // הכלל: **הפתיחה קובעת.** היא נלכדת ברגע שה-MODE נכנס למצב פעולה, כלומר
  // ברגע שהרכב הזה התחיל לעבור — אין רגע מדויק ממנו. הסגירה משמשת רק
  // כשלפתיחה אין כרטיס כלל.
  //
  // ⚠️ start ריק נשאר ריק. זה אומר שהבקר לא קרא כרטיס, וזה מידע אמיתי.
  let cardNumber = data.user;
  if (data.start_end === "end") {
    const fromStart = await inheritCardFromStart(site.id, data.entry_exit, occurredAt);
    if (fromStart && fromStart !== cardNumber) {
      console.log(
        `[operation] אתר ${site.code}: כרטיס תוקן ל-'${fromStart}' לפי הפתיחה` +
        (cardNumber ? ` (הסגירה נשאה '${cardNumber}' — כנראה הרכב הבא)` : " (הסגירה הגיעה ריקה)"));
      cardNumber = fromStart;
    }
  }

  const saveResult = await insertOperation(
    site.id,
    data.start_end,
    data.entry_exit,
    cardNumber,
    opState,
    isAnomaly,
    occurredAt,
    receivedAt,
    reportedAt,
    // המונה הגולמי מהבקר — נשמר לכל פעולה כדי שיהיה אפשר לחשב מחזורים
    // **לתקופה** ולא רק בסך הכל. ה-dispatcher כבר אימת שהוא מספר שלם על
    // הודעות end; על start הוא עשוי להיות חסר, ואז נשמר NULL.
    data.cycle_counter
  );

  // ⚠️ חייבים לצאת כאן, ומיד.
  //
  // insertOperation תופס את שגיאת ה-UNIQUE (23505) ומחזיר inserted:false. אבל
  // ב-Postgres שגיאה בתוך טרנזקציה **מבטלת אותה**: כל פקודה נוספת תיפול על
  // "current transaction is aborted". כל עוד יוצאים מיד — אין מה לאבד (הכתיבה
  // היחידה עד כאן היא ה-INSERT שנכשל), וה-COMMIT על טרנזקציה מבוטלת מתנהג
  // כ-ROLLBACK ואינו זורק.
  //
  // מי שיוסיף כאן פקודה *אחרי* הבדיקה הזו יקבל כשל בכל מסירה חוזרת של QoS-1 —
  // כלומר בדיוק במקרה השגרתי. אם צריך להמשיך אחרי כפילות, זה מחייב SAVEPOINT.
  if (!saveResult.inserted) {
    console.log(`[operation] אתר ${site.code}: כפילות דולגה (${data.entry_exit}/${data.start_end})`);
    return { emit: null };
  }

  // פעולה שהתקבלה היא סימן חיים — מקדמים את last_seen (קדימה בלבד).
  await updateLastSeenIfNewer(site.id, occurredAt);

  // ==========================================================
  // ניסיון חוזר מאחד את הניסיון שנקטע — מעבר פיזי אחד = פעולה אחת
  // ==========================================================
  // רכב מתחיל כניסה, קורית תקלה תוך כדי, המצב חוזר ל'מוכן', ואותו כרטיס
  // מנסה שוב. עד עכשיו זה נספר כשתי פעולות חניה, למרות שהרכב עבר פעם אחת.
  //
  // נעשה **כאן ולא בכלי בלבד**: כלי שרץ ידנית מתקן את העבר, אבל כל תקלה
  // חדשה הייתה מוסיפה עוד ספירה כפולה עד שמישהו יזכור להריץ אותו שוב. אותו
  // כלל, שני מסלולים — ולכן הוא נאכף בקליטה, וה-kli נשאר לתיקון ההיסטוריה.
  //
  // רק על start: הפתיחה החדשה היא שמצביעה אחורה על הסגירה שנקטעה.
  if (data.start_end === "start") {
    // ---- ריצוד MODE: אותו מעבר, נקטע ונפתח מחדש תוך שניות ----
    // נבדק **ראשון** ובלי תנאי על הכרטיס: הריצוד קורה באמצע מעבר אחד, ולעתים
    // הרגיסטר טרם נקרא ולכן צד אחד ריק. נמדד: 33 מקרים, כולם 1–13 שניות,
    // ועם הטיה של פי שלושה לטובת יציאות — כלומר מקור שיטתי לתפוסה שלילית.
    const flick = await supersedeFlicker(
      site.id, data.entry_exit, occurredAt, saveResult.id
    );
    if (flick) {
      console.log(
        `[operation] אתר ${site.code}: ריצוד MODE — הפעולה שנקטעה (${flick}) לא תיספר בנפרד`
      );
    }

    // ---- ניסיון חוזר אחרי תקלה: אותו כרטיס, עד 30 דקות ----
    // רק אם לא היה ריצוד: שניהם מסמנים את אותה עמודה, ואיחוד כפול היה
    // מנסה להחריג פעולה שכבר הוחרגה.
    if (!flick && cardNumber) {
      const merged = await supersedeInterruptedAttempt(
        site.id, data.entry_exit, cardNumber, occurredAt, saveResult.id
      );
      if (merged) {
        console.log(
          `[operation] אתר ${site.code}: ניסיון חוזר — הניסיון שנקטע (${merged}) לא ייספר בנפרד`
        );
      }
    }
  }

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
  // ==========================================================
  // גם כאן: מצב תחזוקה גובר על הכל
  // ==========================================================
  // handleState בודק תחזוקה לפני שהוא מקבל error, אבל המסלול הזה לא בדק
  // כלום — ולכן פעולה בזמן חלון ידני משכה את הסטטוס ל-'operating' ודרסה את
  // התחזוקה. אותה החלטה מוצרית, שני מסלולי קליטה, וכלל שנאכף רק באחד מהם
  // הוא כלל שלא נאכף.
  //
  // הבדיקה נעשית רק כשבאמת עומדים לשנות סטטוס — כדי לא לשלם שאילתה על כל
  // הודעת start בשגרה.
  const isStart = data.start_end === "start";
  if (isStart && data.state !== site.status && !isBackfill) {
    const inMaintenance =
      site.status === "maintenance" || Boolean(await getActiveMaintenance(site.id));

    if (inMaintenance) {
      console.log(
        `[operation] אתר ${site.code}: פעולה בזמן תחזוקה — הסטטוס לא שונה (התחזוקה גוברת)`);
    } else {
      // ⚠️ אותו תיקון כמו ב-state-handler: הודעה שהגארד חסם אינה "סונכרנה".
      // הלוג הישן הכריז על סנכרון שלא קרה, וזה הופך חקירה של מצב שגוי
      // במסך למרדף אחרי שורה שמשקרת.
      const synced = await applyStateChange(site.id, data.state, occurredAt);
      if (synced?.skipped) {
        console.warn(
          `[operation] ⚠️ אתר ${site.code}: סנכרון state ל-${data.state} **לא בוצע** — ${synced.skipped}`
        );
      } else {
        console.log(`[operation] אתר ${site.code}: state סונכרן מ-start ${site.status} → ${data.state}`);
      }
    }
  }

  const isEnd = data.start_end === "end";

  // עדכון מונה הסייקלים — רק על end, לפי הערך מהבקר (מצטבר, מטפל ב-reset)
  let cycleResult = null;
  if (isEnd) {
    cycleResult = await applyCycleCounter(site.id, data.cycle_counter, occurredAt);
    if (cycleResult.mode === "reset") {
      console.warn(`[operation] 🔄 אתר ${site.code}: זוהה reset! הבקר ירד (${cycleResult.last} → ${cycleResult.current}). מונה מצטבר = ${cycleResult.total}`);
    } else if (cycleResult.mode === "reset_suspect") {
      // נפילה לערך גבוה מדי מכדי להיות אתחול בקר. לא הוספנו כלום למונה
      // המצטבר — ניפוח שלו הוא קבוע ובלתי הפיך. הבסיס כן הוזז, כדי שבקר
      // שהוחלף באמת ימשיך להיספר נכון מכאן.
      console.error(
        `[operation] ⛔ אתר ${site.code}: נפילת מונה חשודה (${cycleResult.last} → ${cycleResult.current}) — ` +
        `גבוה מדי לאתחול בקר. לא נוספו ${cycleResult.ignoredAmount} מחזורים; מונה מצטבר נשאר ${cycleResult.total}. ` +
        `בדוק את כתובת רגיסטר המונה בהגדרות הסוכן.`);
    } else if (cycleResult.mode === "jump_suspect") {
      // ⚠️ קפיצה שאינה אפשרית פיזית — הכיוון ההפוך של reset_suspect,
      // ובדיוק אותו טיפול: לא הוספנו כלום (ניפוח cycle_total הוא קבוע
      // ובלתי הפיך), והבסיס כן הוזז. 65535 הוא הערך שקריאת Modbus כושלת
      // מחזירה, ולכן הוא החשוד הראשון.
      console.error(
        `[operation] ⛔ אתר ${site.code}: קפיצת מונה חשודה (${cycleResult.last} → ${cycleResult.current}) — ` +
        `מהירה מדי מכדי להיות אמיתית. לא נוספו ${cycleResult.ignoredAmount} מחזורים; מונה מצטבר נשאר ${cycleResult.total}. ` +
        `אם הערך הוא 65535 — זו כמעט תמיד קריאת Modbus שנכשלה.`);
    } else if (cycleResult.mode === "invalid") {
      console.error(
        `[operation] ⛔ אתר ${site.code}: מונה בקר פסול (${cycleResult.current}) — התעלמנו. ` +
        `מונה מצטבר נשאר ${cycleResult.total}.`);
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

  // מוחזר ולא משודר כאן: handleOperation משדר אחרי ה-commit.
  return {
    emit: {
      type: "operation",
      code: site.code,
      startEnd: data.start_end,
      entryExit: data.entry_exit,
      // הכרטיס המושלם ולא data.user: אחרת הכרטיס נשמר ב-DB אבל הכרטיס
      // בדשבורד מתעדכן בזמן אמת לערך ריק, ורק ריענון מלא היה מתקן.
      cardNumber,
      cycleCounter: data.cycle_counter,
      cycleTotal: cycleResult ? cycleResult.total : null,
      state: opState,
      isAnomaly: isAnomaly,
      occurredAt: occurredAt,
    },
  };
}

module.exports = { handleOperation };