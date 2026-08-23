// db/db.js — חיבור ל-PostgreSQL (Supabase) + שכבת תאימות דקה.
//
// ============================================================
// למה יש כאן שכבת תאימות ולא pool.query גולמי בכל מקום
// ============================================================
// queries.js הוא 1,700 שורות עם ~200 שאילתות בדפוס אחיד:
//     db.prepare(sql).get(a, b)   /   .all(...)   /   .run(...)
// המעבר ל-pg דורש שני שינויים מכניים בכל אחת מהן: '?' → '$1,$2', ואיסוף
// התוצאה מ-rows. לעשות את זה ידנית 200 פעם = 200 הזדמנויות לטעות — במיוחד
// בשאילתות שנבנות דינמית, שבהן מספר ה-placeholders משתנה בזמן ריצה
// (getExecutiveStatsFiltered בונה IN (...) לפי כמות האתרים שנבחרו).
//
// לכן ההמרה נעשית *במקום אחד*: prepare() מקבל SQL עם '?', ממיר ל-$n, ומריץ.
// queries.js שומר על אותו מבנה בדיוק — רק הופך ל-async. פחות קוד שהשתנה =
// פחות סיכון, וההיגיון העסקי לא נגע כלל.
//
// ההבדל האמיתי שכן חוצה את הגבול: get/all/run מחזירים Promise. כל קורא חייב await.
// ============================================================

const { Pool, Client, types } = require("pg");
const fs = require("fs");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");

// ============================================================
// קריטי: COUNT(*) ו-SUM(int) ב-Postgres מחזירים BIGINT, ו-pg מחזיר BIGINT
// כ*מחרוזת* (כדי לא לאבד דיוק מעל 2^53). בלי השורה הזו getSiteStats היה
// מחזיר operations: "16" במקום 16 — ואז `operations === 0` נכשל בשקט,
// והדשבורד היה מקבל מחרוזות במקום מספרים. המספרים כאן רחוקים מהגבול.
// 20 = ה-OID של int8 (BIGINT).
// ============================================================
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("db: חסר DATABASE_URL בסביבה (.env)");
}

const pool = new Pool({
  connectionString,
  // Supabase מחייב SSL. rejectUnauthorized: false — התעבורה עדיין מוצפנת.
  ssl: { rejectUnauthorized: false },
  // ============================================================
  // גודל ה-pool — למה 20 ולא 10
  // ============================================================
  // כל endpoint של הפאנל עכשיו יורה את השאילתות שלו במקביל (Promise.all).
  // אבל פתיחת פאנל יורה ~6 בקשות בו-זמנית (detail/stats/maintenance/analytics/
  // insights/list) = ~50 שאילתות שמתחרות על החיבורים. עם max=10 אפילו שאילתה
  // בודדת (maintenance) המתינה ~0.8ש' לחיבור פנוי, וכל בקשה שהייתה 0.3ש'
  // לבדה תפחה ל-1.5ש'. ה-transaction pooler (פורט 6543) בנוי בדיוק לזה —
  // הרבה חיבורים קצרים — ולכן הרחבה ל-20 מקטינה את ההמתנה בלי סיכון.
  max: 20,
  // ============================================================
  // idleTimeoutMillis — חייב להיות *גדול* ממרווח ה-keepalive (20ש')
  // ============================================================
  // קודם היה 30ש': חיבור סרק נסגר אחרי 30ש', והפינג הגיע כשכבר לא נשאר אף
  // חיבור. כך ה-pool ישב ריק וקר בין הפינגים, והבקשה הראשונה אחרי חוסר-פעילות
  // שילמה ~2.4ש'. עם 120ש' ≫ 20ש', החיבורים שה-keepalive מחמם שורדים בין
  // הפינגים ונשארים חמים ברצף. ראה ה-keepalive ב-master.js (מחמם כמה חיבורים
  // במקביל, כל 20ש', כי Supabase מתקרר תוך ~30ש').
  idleTimeoutMillis: 120_000,
  connectionTimeoutMillis: 15_000,

  // ============================================================
  // keepAlive + query_timeout — מה שמונע המתנה נצחית על שקע מת
  // ============================================================
  // ה-pooler של Supabase סוגר חיבורים מיוזמתו (מתועד למעלה). כשזה קורה
  // *באמצע* טרנזקציה בלי keepAlive, נוצר שקע חצי-פתוח: מבחינת Postgres
  // ה-session ממתין ל-ClientRead, ומבחינתנו ה-await פשוט לא חוזר לעולם.
  //
  // זה בדיוק מה שקרה ב-28-29/07 והשבית את הקליטה ל-15 שעות: טרנזקציה של
  // applyStateChange נתקעה אחרי ה-INSERT ל-status_history, לא שלחה COMMIT,
  // והחזיקה FOR UPDATE על שורת האתר. כל הודעה נוספת לאותו אתר נחסמה 120
  // שניות עד statement_timeout, ה-dispatcher ניסה חמש פעמים, וההמתנה
  // הצטברה עד שפעימת ה-MQTT (60ש') הוחמצה — ניתוק, חיבור מחדש, HiveMQ
  // מוסר את כל התור מחדש, ואותה הודעה נתקעת שוב. 26 מחזורים, 2 הודעות
  // שאבדו, והתור לא התנקז.
  //
  // keepAlive גורם למערכת ההפעלה לזהות עמית מת ולהפיל את השקע בשגיאה,
  // ו-query_timeout הוא הרשת האחרונה: כל await *חייב* להסתיים, גם אם אף
  // חבילה לא חוזרת. 30ש' רחב בהרבה מהשאילתה האיטית ביותר שנמדדה (~1.7ש').
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  query_timeout: 30_000,
});

// שגיאה על חיבור סרק לא אמורה להפיל את התהליך
pool.on("error", (err) => {
  console.error("db: שגיאה על חיבור סרק —", err.message);
});

// ============================================================
// שגיאות חולפות — וניסיון חוזר, אבל לא על הכול
// ============================================================
// ה-transaction pooler של Supabase מנתק חיבורים ביוזמתו: אחרי חוסר פעילות,
// בזמן תחזוקה בצד שלהם, וסתם באמצע. התוצאה שנראתה בפועל היא ECONNRESET על
// שאילתה שנשלחה על חיבור שהיה חי לפני רגע. זה לא באג אצלנו — זה אופי הסביבה.
//
// ה-Master נפל על זה בעלייה: main() ב-master.js מסתיים ב-process.exit(1), ולכן
// ניתוק חולף אחד בשנייה הלא-נכונה השאיר את השרת למטה. מאחורי Docker עם
// restart: unless-stopped זה מתקן את עצמו; על שרת always-on בלי מנהל תהליכים
// הוא פשוט נשאר מכובה, ואיש לא שומע כלום.
//
// ⚠️ הניסיון החוזר כאן מכוון בכוונה רק למה שבטוח לחזור עליו. פירוט למטה
// ב-runQuery: קריאות כן, כתיבות לא.
const TRANSIENT_CODES = new Set([
  // שכבת ה-socket
  "ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH",
  // מחלקת 08 של Postgres — כשלי חיבור
  "08000", "08001", "08003", "08004", "08006",
  // הברוקר/השרת סוגר או עדיין לא מוכן
  "57P01", "57P02", "57P03", "53300",
  // 57014 = query_canceled: פקודה שנקטעה ב-statement_timeout. כאן זה כמעט
  // תמיד המתנה לנעילה שתפוגה — למשל DDL בעלייה שממתין לנעילה שמחזיק
  // session תלוי מקריסה קודמת. זה מצב חולף מעצם הגדרתו, ובלעדיו העלייה
  // נכשלה עם "canceling statement due to statement timeout" והשרת נשאר
  // מכובה. בטוח לניסיון חוזר: רק קריאות ו-init חוזרים (ראה runQuery).
  "57014",
  // 55P03 = lock_not_available: ויתור על המתנה לנעילה בגלל lock_timeout
  // שנקבע בטרנזקציה. חולף מעצם הגדרתו — מי שהחזיק את הנעילה משחרר תוך
  // מילישניות בדרך כלל. (בתוך טרנזקציה אין ניסיון חוזר ברמת השאילתה ממילא;
  // שם ה-dispatcher מנסה את ההודעה כולה מחדש, וזה הנכון.)
  "55P03",
]);

// חלק מכשלי החיבור של pg מגיעים בלי code — רק כהודעה. אלה הנוסחים שנצפו.
const TRANSIENT_MESSAGES = [
  "connection terminated",
  "connection ended unexpectedly",
  "client has encountered a connection error",
  "timeout exceeded when trying to connect",
  "server closed the connection unexpectedly",
];

function isTransient(err) {
  if (!err) return false;
  if (TRANSIENT_CODES.has(err.code)) return true;
  const message = String(err.message || "").toLowerCase();
  return TRANSIENT_MESSAGES.some((fragment) => message.includes(fragment));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// אותם מספרים כמו ב-ingestion/dispatcher.js (5 ניסיונות, 250ms מוכפל עד 4ש'),
// כדי שלא יהיו שתי מדיניות backoff שונות באותו תהליך.
const MAX_ATTEMPTS = 5;

/**
 * מריץ פעולה, וחוזר עליה ב-backoff מעריכי כל עוד הכשל הוא *חולף*.
 * שגיאה שאינה חולפת (SQL שגוי, הפרת אילוץ) נזרקת מיד — אין טעם לנסות שוב,
 * וניסיון חוזר עליה רק היה מסתיר תקלה אמיתית מאחורי חמש שורות לוג.
 *
 * חשוף כדי שקוראים שהפעולה שלהם אידמפוטנטית יוכלו לעטוף אותה (ראה
 * ensureAdminCode ב-api/routes.js — upsert, ולכן בטוח לחזור עליו).
 */
async function retryTransient(operation, label) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS || !isTransient(err)) throw err;

      const backoffMs = Math.min(250 * 2 ** (attempt - 1), 4000);
      console.warn(
        `db: ${label} נכשל בניתוק חולף (${err.code || err.message}) — ` +
        `ניסיון ${attempt}/${MAX_ATTEMPTS}, שוב בעוד ${backoffMs}ms`);
      await sleep(backoffMs);
    }
  }
}

// ============================================================
// טרנזקציות
// ============================================================
// applyStateChange חייב להיות אטומי: סגירת המצב הקודם + פתיחת החדש + עדכון
// האתר. הפונקציות הפנימיות (closeOpenStatus וכו') לא מקבלות client כפרמטר,
// ולכן משתמשים ב-AsyncLocalStorage: בתוך transaction() כל קריאה ל-db רצה על
// אותו client — בלי לשנות אף חתימה של פונקציה.
const txStore = new AsyncLocalStorage();

// היעד לשאילתה: ה-client של הטרנזקציה אם אנחנו בתוכה, אחרת ה-pool
const executor = () => txStore.getStore() || pool;

// ============================================================
// תור לכל client — כי לחיבור אחד יש ערוץ פרוטוקול אחד
// ============================================================
// pool.query מקצה client לכל שאילתה, ולכן Promise.all עליו בטוח לגמרי.
// **בתוך טרנזקציה זה הפוך**: executor() מחזיר client יחיד, ו-Promise.all
// יורה עליו כמה שאילתות במקביל. pg מסמן את זה כמיושן ("client is already
// executing a query") — לחיבור Postgres יש ערוץ אחד, והתוצאות עלולות
// להתערבב או להיזרק.
//
// זה אינו תיאורטי: getAllSitesGlobals עושה Promise.all על חמש שאילתות.
// בייצור הוא נקרא מנתיב REST ורץ על ה-pool, ולכן תקין; ברגע שנקרא בתוך
// טרנזקציה הוא נפל לסירוגין — מה שהתגלה כשהוא נכנס לשער ה-parity.
//
// הפתרון הוא שרשור ולא נעילה: כל שאילתה על client נתון ממתינה לקודמתה.
// **בייצור המחיר אפס** — בתוך טרנזקציה שאילתות ממילא חייבות להיות סדרתיות,
// והשרשור רק הופך את זה למפורש במקום לתלוי-מזל. ה-pool אינו נכנס לתור.
const clientQueues = new WeakMap();

function runOn(target, sql, params) {
  if (target === pool) return pool.query(sql, params);

  const prev = clientQueues.get(target) || Promise.resolve();
  // catch על החוליה הקודמת: שאילתה שנכשלה לא אמורה להרעיל את הבאות בתור —
  // הטרנזקציה כולה תתגלגל לאחור ממילא, וזה תפקידו של transaction().
  const next = prev.catch(() => {}).then(() => target.query(sql, params));
  clientQueues.set(target, next);
  return next;
}

// ============================================================
// טרנזקציה מקננת — מצטרפת, ולא פותחת חדשה
// ============================================================
// בלי הבדיקה הזו, קריאה ל-transaction() *מתוך* טרנזקציה הייתה שולפת client
// **שני** מה-pool ומריצה עליו BEGIN נפרד. שני ה-clients הם שני חיבורים נפרדים
// מבחינת Postgres, ולכן:
//
//   הטרנזקציה החיצונית מחזיקה SELECT ... FOR UPDATE על שורת האתר,
//   הפנימית מבקשת לנעול את *אותה* שורה — ומחכה לשחרור שלעולם לא יגיע,
//   כי מי שמחזיק אותה מחכה לפנימית שתסתיים. deadlock מלא.
//
// זה נעשה רלוונטי ברגע שקליטת ה-operation הפכה לאטומית: handleOperation פותח
// טרנזקציה, ובתוכה applyCycleCounter (וגם applyStateChange) פותחים משלהם.
//
// ההצטרפות היא הסמנטיקה הנכונה כאן, לא savepoint: רוצים הכול-או-כלום. אם שלב
// פנימי נכשל, הטרנזקציה החיצונית מתגלגלת לאחור במלואה — בדיוק מה שנדרש כדי
// שהפעולה והמונה לא ייצאו מסינכרון.
async function transaction(fn) {
  if (txStore.getStore()) {
    return await fn();
  }

  const client = await pool.connect();

  // ============================================================
  // ⚠️ המאזין הזה הוא מה שמפריד בין שגיאה לקריסה
  // ============================================================
  // client שנשלף מה-pool הוא EventEmitter. כשה-pooler של Supabase מנתק את
  // החיבור באמצע טרנזקציה, pg פולט עליו אירוע 'error'. ב-Node, אירוע 'error'
  // **בלי מאזין** אינו נבלע — הוא הופך לחריגה שמפילה את כל התהליך.
  //
  // זה הפיל את ה-Master שלוש פעמים ב-27/07, ובכל פעם גם השאיר sessions
  // תלויים ב-Postgres שהחזיקו נעילה על operations וחסמו את העלייה מחדש שלו.
  // בשילוב עם אישור-לפני-כתיבה (ראה mqtt/subscriber.js) כל קריסה כזו גם
  // מחקה הודעות שכבר אושרו ל-HiveMQ.
  //
  // המאזין אינו "מטפל" בכשל — ה-await שנכשל ממילא זורק וה-catch למטה מגלגל
  // לאחור. הוא רק מונע את הקריסה, וזוכר שהחיבור פגום כדי שלא יחזור ל-pool.
  let socketError = null;
  const onClientError = (err) => {
    socketError = err;
    console.error("db: החיבור נפל באמצע טרנזקציה —", err.message);
  };
  client.on("error", onClientError);

  try {
    // ============================================================
    // שני חסמים ברמת הטרנזקציה — SET LOCAL, ולא SET
    // ============================================================
    // אלה ההגנות של Postgres עצמו, והן היו כבויות (שתיהן 0 בשרת):
    //
    //   lock_timeout — ממתין לנעילה מוותר אחרי 5ש' במקום להיתקע 120ש' עד
    //   statement_timeout. זה מה שהופך התנגשות רגעית לניסיון חוזר זול,
    //   במקום לחסום את תור האתר לדקות ולהרעיב את לולאת האירועים.
    //
    //   idle_in_transaction_session_timeout — Postgres הורג בעצמו טרנזקציה
    //   שנשארה פתוחה בלי פעילות. זו הרשת שתופסת גם כשל שלא חזינו: גם אם
    //   התהליך שלנו ייתקע שוב, הנעילה תשוחרר תוך 30ש' במקום להחזיק לנצח.
    //
    // **SET LOCAL ולא SET**: מול ה-transaction pooler של Supabase כל
    // טרנזקציה עלולה לנחות על backend אחר, ולכן הגדרה ברמת session אינה
    // שלנו ואינה מובטחת. SET LOCAL חי בדיוק כל עוד הטרנזקציה — וזה בדיוק
    // הטווח שאנחנו רוצים להגן עליו. הכול בשאילתה אחת, בלי סיבוב נוסף.
    await client.query(
      "BEGIN; SET LOCAL lock_timeout = '5s'; " +
      "SET LOCAL idle_in_transaction_session_timeout = '30s'"
    );
    const result = await txStore.run(client, fn);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("db: ROLLBACK נכשל —", rollbackErr.message);
    }
    throw err;
  } finally {
    client.removeListener("error", onClientError);
    // release(err) הורס את החיבור במקום להחזירו ל-pool. חיבור שנשבר באמצע
    // טרנזקציה עלול לחזור עם טרנזקציה פתוחה, והשואל הבא היה יורש אותה.
    client.release(socketError || undefined);
  }
}

// ============================================================
// המרת '?' ל-'$1, $2, ...'
// ============================================================
// מדלגים על סימני שאלה שבתוך מחרוזת ('...'), כדי לא להשחית SQL תקין.
// אין כרגע '?' בתוך מחרוזות בקוד, אבל ההגנה זולה והתקלה הייתה שקטה.
//
// ============================================================
// ⚠️ הערות SQL **אינן** מדולגות — וזו מלכודת שכבר נשכה
// ============================================================
// הפונקציה מדלגת על מחרוזות בלבד. `--` ו-`/* */` נראים לה כמו טקסט רגיל,
// ולכן **סימן שאלה בתוך הערה נספר כפרמטר**.
//
// מה שקרה בפועל: הערה שהסבירה את הפורמט וכתבה בתוכה `site_id IN (?,?)`
// הוסיפה שני פרמטרים רפאים, המספור זז, והשאילתה נפלה על
// `could not determine data type of parameter $1` — שגיאה שאינה רומזת
// כלל על הערה.
//
// ⚠️ אל תכתבו '?' בהערות SQL. תיאור פורמט של מצייני מקום צריך להיכתב
// במילים ("שני מצייני מקום") או בהערת JS מחוץ למחרוזת ה-SQL.
//
// לא הוספתי דילוג על הערות: הוא מוסיף שני מצבים לפרסר על בעיה שכל כולה
// היא הרגל כתיבה, ופרסר מסובך יותר הוא סיכון גדול יותר מהתקלה שהוא מונע.
function toPositional(sql) {
  let out = "";
  let i = 0;
  let n = 0;
  let inString = false;

  while (i < sql.length) {
    const ch = sql[i];

    if (inString) {
      out += ch;
      if (ch === "'" && sql[i + 1] === "'") {
        out += sql[++i];          // '' = גרש בורח, לא סוף מחרוזת
      } else if (ch === "'") {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === "'") { inString = true; out += ch; i++; continue; }
    if (ch === "?") { out += `$${++n}`; i++; continue; }

    out += ch;
    i++;
  }

  return out;
}

// ============================================================
// ה-API התואם ל-better-sqlite3 — אבל אסינכרוני
// ============================================================
// ============================================================
// מונה שאילתות — הכלי שמאתר N+1
// ============================================================
// מול SQLite מקומי שאילתה עלתה מיקרו-שניות, ולכן "שאילתה לכל אתר" לא הורגשה.
// מול Postgres מרוחק כל שאילתה היא סיבוב רשת שלם (~50-150ms), ו-100 שאילתות
// הן 10 שניות. המונה הזה הופך את זה למדיד במקום לניחוש.
const counters = { queries: 0, ms: 0 };

function getQueryStats() {
  return { ...counters };
}

function resetQueryStats() {
  counters.queries = 0;
  counters.ms = 0;
}

async function runOnce(text, params) {
  const started = process.hrtime.bigint();
  try {
    return await runOn(executor(), text, params);
  } finally {
    counters.queries++;
    counters.ms += Number(process.hrtime.bigint() - started) / 1e6;
  }
}

// ============================================================
// למה קריאות חוזרות וכתיבות לא
// ============================================================
// כשחיבור נופל באמצע שליחת שאילתה, אין שום דרך לדעת מהשגיאה אם השרת הספיק
// לבצע אותה או לא. עבור SELECT זה לא משנה — אין תופעות לוואי, וניסיון חוזר
// מחזיר את אותה תשובה. עבור INSERT זה משנה מאוד: ניסיון חוזר "בטוח למראה"
// היה יוצר שורה שנייה ב-status_history, וזו בדיוק מחלקת השיבוש שהמערכת כבר
// נכוותה בה (מקטעים כפולים, משכים שליליים, זמינות מורעלת).
//
// לכן כתיבה לא חוזרת *כאן*. היא לא נשארת בלי הגנה: מסלול הקליטה חוזר על
// ההודעה **השלמה** ב-ingestion/dispatcher.js, ושם זה בטוח כי הפעולה כולה
// אידמפוטנטית — טרנזקציות מתגלגלות לאחור, ה-dedup נשמר במפתח UNIQUE, ויש
// שומרי backfill/ללא-שינוי. ניסיון חוזר על היחידה הנכונה, בשכבה הנכונה.
//
// גם בתוך טרנזקציה לא חוזרים: חיבור שנפל הרג את הטרנזקציה כולה, וניסיון חוזר
// על שאילתה בודדת רק יתנגש ב-"current transaction is aborted". מי שחוזר על
// טרנזקציה הוא מי שפתח אותה.
async function runQuery(text, params, { retryable = false } = {}) {
  if (!retryable || txStore.getStore()) {
    return runOnce(text, params);
  }
  return retryTransient(() => runOnce(text, params), "שאילתת קריאה");
}

function prepare(sql) {
  const text = toPositional(sql);

  return {
    /** שורה אחת, או undefined אם אין (כמו .get של better-sqlite3) */
    async get(...params) {
      const res = await runQuery(text, params, { retryable: true });
      return res.rows[0];
    },

    /** כל השורות */
    async all(...params) {
      const res = await runQuery(text, params, { retryable: true });
      return res.rows;
    },

    /**
     * INSERT / UPDATE / DELETE.
     * מחזיר את אותם שדות ש-better-sqlite3 החזיר:
     *   changes         — כמה שורות הושפעו
     *   lastInsertRowid — ה-id של השורה החדשה (רק אם ה-SQL כולל RETURNING id)
     */
    async run(...params) {
      const res = await runQuery(text, params);
      return {
        changes: res.rowCount,
        lastInsertRowid: res.rows[0]?.id,
      };
    },
  };
}

// הרצת SQL גולמי (DDL)
async function exec(sql) {
  await runOn(executor(), sql);
}

// ============================================================
// אתחול: יצירת הסכמה + השלמת עמודות חסרות
// ============================================================
// schema.postgres.sql משתמש ב-CREATE TABLE IF NOT EXISTS, ולכן עמודה שנוספה
// לטבלה *קיימת* לא תיווצר. ב-Postgres יש ADD COLUMN IF NOT EXISTS — פשוט
// ובטוח יותר מהבדיקה שהייתה ב-SQLite (PRAGMA table_info).
// נקרא גם מ-master.js (לפני MQTT) וגם מ-startApiServer (לשימוש עצמאי).
// שומרים את ה-Promise כדי שהאתחול ירוץ *פעם אחת* גם אם קראו לו פעמיים.
let initPromise = null;

// האם האתחול הושלם בהצלחה. נחשף ל-/health כדי שבדיקת החיות תדע להבדיל בין
// "התהליך חי" ל"התהליך באמת מוכן לעבוד" — קונטיינר ששרת ה-HTTP שלו עלה אבל
// הסכמה לא אותחלה הוא קונטיינר שבור, ו-Docker צריך לדעת זאת.
let ready = false;

function isReady() {
  return ready;
}

function init() {
  if (initPromise) return initPromise;

  // ============================================================
  // האתחול חוזר על עצמו — כאן זה בטוח לחלוטין
  // ============================================================
  // כל ה-DDL כאן הוא CREATE TABLE IF NOT EXISTS ו-ADD COLUMN IF NOT EXISTS,
  // כלומר אידמפוטנטי מעצם הגדרתו: הרצה שנייה אינה משנה דבר. לכן דווקא בשלב
  // הזה מותר לחזור בלי כל הסתייגות — וזה גם השלב שהפיל את השרת בפועל, כי
  // main() ב-master.js יוצא ב-exit(1) על כל שגיאה ממנו.
  //
  // שימו לב שכל ניסיון בונה Client חדש: אחרי ניתוק, ה-Client הקודם אינו
  // שמיש (pg מסמן אותו ככזה), ולכן שימוש חוזר בו היה מבטיח כשל.
  initPromise = retryTransient(async () => {
    const schema = fs.readFileSync(path.join(__dirname, "schema.postgres.sql"), "utf8");

    // ה-transaction pooler (6543) מנתק את החיבור כשמריצים סקריפט עם כמה
    // פקודות SQL (ECONNRESET) — הוא נועד לשאילתות בודדות. הסכמה היא סקריפט
    // DDL שלם, ולכן היא רצה פעם אחת דרך חיבור session (5432), שתומך בזה.
    // אחרי האתחול הכול חוזר לרוץ על ה-pool המהיר.
    const sessionUrl = connectionString.replace(":6543/", ":5432/");
    const setup = new Client({ connectionString: sessionUrl, ssl: { rejectUnauthorized: false } });

    await setup.connect();
    try {
      await setup.query(schema);
      await setup.query(`
        ALTER TABLE sites ADD COLUMN IF NOT EXISTS plc_type    TEXT;
        ALTER TABLE sites ADD COLUMN IF NOT EXISTS is_new_site INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE sites ADD COLUMN IF NOT EXISTS tier        TEXT NOT NULL DEFAULT 'basic';
      `);

      // ============================================================
      // מפתח ה-dedup עובר מ-occurred_at ל-reported_at
      // ============================================================
      // occurred_at הוא מעכשיו זמן ה"אמת" של השרת, והוא **מיושר** כשהשעון
      // באתר מקדים (ראה ingestion/plausibility.js). כלומר הוא תלוי ברגע
      // הקליטה — ולכן הוא כבר לא יכול לשמש מפתח זיהוי: מסירה חוזרת של QoS-1
      // הייתה מקבלת ערך אחר ונכנסת כשורה שנייה.
      //
      // reported_at הוא מה שהסוכן אמר, כפי שאמר. הוא אינו משתנה לעולם, ולכן
      // מסירה חוזרת נופלת על אותו מפתח בדיוק ונחסמת.
      //
      // הסדר כאן אינו מקרי: קודם ממלאים, אחר כך יוצרים את האינדקס החדש, ורק
      // בסוף מסירים את הישן — כך אין רגע אחד שבו הטבלה חשופה בלי הגנת dedup.
      await setup.query(`
        ALTER TABLE operations ADD COLUMN IF NOT EXISTS reported_at TEXT;

        UPDATE operations SET reported_at = occurred_at WHERE reported_at IS NULL;

        CREATE UNIQUE INDEX IF NOT EXISTS ux_operations_dedup
          ON operations (site_id, reported_at, start_end, entry_exit, card_number);

        ALTER TABLE operations
          DROP CONSTRAINT IF EXISTS operations_site_id_occurred_at_start_end_entry_exit_card_nu_key;
      `);

      // ============================================================
      // superseded_by — מעבר פיזי אחד = פעולה אחת
      // ============================================================
      // רכב מתחיל כניסה, קורית תקלה תוך כדי, המצב חוזר ל'מוכן', ואותו כרטיס
      // מנסה שוב. עד עכשיו זה נספר כ**שתי** פעולות חניה, למרות שהרכב עבר
      // פעם אחת — או בכלל לא עבר בניסיון הראשון.
      //
      // הניסיון הראשון מצביע על השני: superseded_by = id של הפעולה שהחליפה
      // אותו. כל מדד מוסיף תנאי אחד — `superseded_by IS NULL` — ולכן ההפרדה
      // בין "מה קרה" (השורה נשארת) לבין "מה נספר" (היא מוחרגת) היא במקום
      // אחד ולא פזורה בכל שאילתה.
      //
      // ⚠️ העמודה **לא** מוחקת מידע. השורה נשארת בטבלה עם הכרטיס והחותם,
      // וייחוס התקלה לכרטיס ("תקלות בכניסה") ממשיך לעבוד — הניסיון הראשון
      // הוא בדיוק זה שבגללו קרתה התקלה, ומחיקתו הייתה מאבדת את מי שהיה בפנים.
      //
      // ON DELETE SET NULL ולא CASCADE: אם הניסיון השני נמחק (שמירת נתונים),
      // הראשון חייב **לחזור להיספר** — הוא הפעולה היחידה שנותרה. CASCADE היה
      // מוחק אותו ומעלים את שתיהן.
      await setup.query(`
        ALTER TABLE operations ADD COLUMN IF NOT EXISTS superseded_by INTEGER;

        DO $$ BEGIN
          ALTER TABLE operations
            ADD CONSTRAINT operations_superseded_by_fkey
            FOREIGN KEY (superseded_by) REFERENCES operations(id) ON DELETE SET NULL;
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;

        -- כל מדד מסנן על העמודה הזו; בלי אינדקס חלקי כל ספירה סורקת את הטבלה.
        CREATE INDEX IF NOT EXISTS idx_operations_superseded
          ON operations (site_id, occurred_at) WHERE superseded_by IS NULL;
      `);

      // ============================================================
      // cycle_counter — המונה הגולמי של הבקר, לכל פעולה
      // ============================================================
      // הערך הגיע בכל הודעת operation מאז ומתמיד (ה-dispatcher אפילו מוודא
      // שהוא מספר שלם), אבל **נזרק** אחרי שעדכן את הסכום המצטבר על האתר.
      // התוצאה: אפשר לדעת כמה מחזורים המכונה עשתה **בסך הכל**, אבל לא כמה
      // עשתה בחודש מסוים. getCycleDelta היה פונקציה שמחזירה null, ובכנות —
      // לא היה לה מאיפה לקחת.
      //
      // ⚠️ **זה מתקן קדימה בלבד.** לפעולות שכבר נכתבו אין את הערך ואין מאיפה
      // לשחזר אותו — המונה אינו נגזר מהנתונים אלא מגיע מהבקר. דוח מחזורים
      // לתקופה שקדמה לשינוי הזה יישאר ריק, וזה חייב להיאמר במסך ולא להיראות
      // כמו אפס מחזורים.
      //
      // NULL מותר במפורש: הוא מבדיל בין "לא נשמר" (היסטוריה) לבין "0 מחזורים".
      await setup.query(`
        ALTER TABLE operations ADD COLUMN IF NOT EXISTS cycle_counter INTEGER;
      `);

      // ============================================================
      // fault_text — תיאור התקלה מהבקר
      // ============================================================
      // עד היום כל התקלות נראו זהות במסך: "מושבת". אין דרך לדעת אם זו תקלת
      // חיישן, כרטיס שלא נקרא או תקלה מכנית — ולכן אי אפשר גם לקבץ תקלות
      // לפי סוג ולומר "האתר נפל 6 פעמים, כולן מאותה סיבה".
      //
      // הבקר חושף מחרוזת בסגנון C (תו לכל register, מסתיימת באפס), הסוכן
      // קורא אותה כשהמצב משתנה לתקלה, והיא נשמרת כאן.
      //
      // ⚠️ **קדימה בלבד.** לתקלות שכבר נרשמו אין תיאור ואין מאיפה לשחזר —
      // הטקסט חי ברגע התקלה בבקר בלבד. שורה היסטורית תישאר NULL, וזה חייב
      // להיראות במסך כ"לא נשמר" ולא כ"אין תיאור".
      //
      // ⚠️ ו-NULL מובחן מ-'' במפורש: NULL = לא נקרא (סוכן ישן / בקר בלי
      // התכונה), '' = נקרא והיה ריק. שני דברים שונים שאסור למזג.
      await setup.query(`
        ALTER TABLE status_history ADD COLUMN IF NOT EXISTS fault_text TEXT;
      `);

      // ============================================================
      // הוצאה מהסטטיסטיקה — סימון, ולא מחיקה
      // ============================================================
      // ⚠️ **הכלל היחיד שחייב להישמר כאן: השורה נשארת.** הדרישה הייתה
      // "שיהיה כתוב מה בוטל ועל ידי מי", ומחיקה הופכת את זה לבלתי אפשרי —
      // אין על מה לכתוב. `excluded_at IS NULL` הוא "נספר", ולא יותר מזה.
      //
      // ⚠️ ולמה זו אינה עוד עמודת is_anomaly: `is_anomaly` הוא שיפוט של
      // **הקליטה** על סמך הנתון (מעבר לא סביר), והוא נקבע אוטומטית. זו
      // החלטה של **אדם** — "הקפצנו את הדלת בכוונה" — ולכן היא נושאת שם,
      // סיבה וזמן. מיזוג השניים היה מוחק את ההבחנה בין "המערכת חשדה"
      // לבין "מנהל הצהיר", ואי אפשר לשחזר אותה אחר כך.
      //
      // ⚠️ שלוש עמודות ולא טבלה נפרדת: לוג הפעילות כבר קורא בדיוק את
      // השורות האלה, ולכן טבלה צדדית הייתה מוסיפה JOIN לכל רינדור של הלוג
      // רק כדי לומר מי ביטל. הרישום העמיד הנוסף יושב ב-audit_log.
      // ⚠️ maintenance_windows נוספה כאן אחר כך: חלון תחזוקה אינו רק שורה
      // בלוג — הוא **הופך** זמן של מקטעים אחרים לתחזוקה, ולכן הוא חייב
      // להיות ניתן לסימון בדיוק כמו השניים האחרים.
      for (const table of ["operations", "status_history", "maintenance_windows"]) {
        await setup.query(`
          ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS excluded_at      TEXT;
          ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS excluded_by      TEXT;
          ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS exclusion_reason TEXT;
        `);
        // ⚠️ אינדקס **חלקי**. המקרה הרגיל הוא שאין הוצאות כלל, ואינדקס מלא
        // על עמודה שכולה NULL הוא נפח בלי תועלת. החלקי משרת את השאילתה
        // האחת שכן צריכה אותו — "מה הוצא ובידי מי" — ונשאר זעיר.
        await setup.query(`
          CREATE INDEX IF NOT EXISTS idx_${table}_excluded
            ON ${table}(site_id, excluded_at) WHERE excluded_at IS NOT NULL;
        `);
      }

      // ============================================================
      // פונקציות המדדים — נטענות בכל עלייה, אחרי הסכמה
      // ============================================================
      // אותו היגיון בדיוק כמו ה-DDL שמעליו: כל פונקציה היא CREATE OR REPLACE,
      // ולכן ההרצה אידמפוטנטית והרצה שנייה מחליפה גוף באותו גוף. אין כאן
      // מנגנון הגירות מגורסאות, ולא צריך — הקובץ *הוא* מצב היעד.
      //
      // **אחרי** הסכמה ולא לפניה: הפונקציות מתייחסות ל-status_history ולעמודות
      // שנוספות ב-ALTER למעלה. סדר הפוך היה נכשל ב-clone טרי עם
      // "relation does not exist".
      //
      // רץ על אותו חיבור session (5432) מאותה סיבה: זהו סקריפט מרובה-פקודות,
      // וה-transaction pooler מנתק עליו.
      const functions = fs.readFileSync(path.join(__dirname, "functions.postgres.sql"), "utf8");
      await setup.query(functions);

      // זהות ומדיניות שורה. **אחרי** הפונקציות, כי הוא נותן עליהן GRANT
      // EXECUTE — סדר הפוך היה נכשל על "function does not exist".
      const security = fs.readFileSync(path.join(__dirname, "security.postgres.sql"), "utf8");
      await setup.query(security);

      // ============================================================
      // פעולות כתיבה שהדפדפן קורא ישירות — **אחרי** security
      // ============================================================
      // ⚠️ הסדר אינו סגנוני: הפונקציות כאן קוראות ל-`app.current_actor()`,
      // ל-`app.current_app_role()` ול-`app.is_active_user()`, וכולן נוצרות
      // ב-security.postgres.sql. סדר הפוך נכשל על "function does not exist"
      // ב-clone טרי — כלומר עובר בפיתוח ונופל בהתקנה חדשה.
      const writes = fs.readFileSync(path.join(__dirname, "writes.postgres.sql"), "utf8");
      await setup.query(writes);

      // ============================================================
      // ⚠️ התחזוקה היומית — מוחלת, אבל **אינה רצה כאן**
      // ============================================================
      // הקובץ מגדיר את פונקציות הניקוי ואת לוח הזמנים ב-pg_cron. השרת רק
      // **מתקין** אותן; מי שמריץ הוא Postgres, בשעה קבועה, בלי תלות בשאלה
      // אם השרת חי. זה כל מה שהעברה הזו קנתה.
      //
      // ⚠️ כישלון כאן אינו מפיל את העלייה: pg_cron הוא הרחבה שעשויה לא
      // להיות מותקנת במופע חדש או ב-Postgres שאינו Supabase, והשרת חייב
      // לעלות ולקלוט MQTT גם אז. תחזוקה שלא נקבעה היא הפסד; קליטה שלא
      // עלתה היא נזק.
      try {
        const cron = fs.readFileSync(path.join(__dirname, "cron.postgres.sql"), "utf8");
        await setup.query(cron);
      } catch (err) {
        console.warn("db: תזמון התחזוקה לא הוחל —", err.message);
      }

      // ============================================================
      // ⚠️ ההתראות **אינן** כאן, ובכוונה
      // ============================================================
      // הסכמה שלהן חיה ב-supabase/migrations/ ומוחלת ב-supabase db push,
      // יחד עם ה-Edge Function ששולחת. השרת אינו מעורב בהתראות בשום שלב —
      // הוא נופל, וזה בדיוק הרגע שבו הן נחוצות.
      //
      // ⚠️ גרסה קודמת החילה אותן כאן, וזה היה שגוי בכיוון: היא קשרה תכונה
      // שכל מטרתה לא לתלות בשרת — לעלייה של אותו שרת.
    } finally {
      // end() על חיבור שכבר מת זורק, וזה היה מחליף את השגיאה האמיתית (הניתוק)
      // בשגיאה משנית — ואז isTransient לא היה מזהה אותה והניסיון החוזר לא היה קורה.
      try { await setup.end(); } catch { /* כבר מנותק */ }
    }

    const { rows } = await pool.query("SELECT current_database() AS db");
    ready = true;
    console.log(`db: ready — PostgreSQL (${rows[0].db})`);
  }, "אתחול הסכמה");

  // כשל סופי לא "נועל" את האתחול: בלי האיפוס, כל קורא עתידי היה מקבל את אותו
  // Promise דחוי לנצח ולא היה יכול לנסות שוב, גם אם ה-DB חזר מזמן.
  initPromise.catch(() => { initPromise = null; });

  return initPromise;
}

async function close() {
  await pool.end();
}

module.exports = {
  prepare, exec, transaction, init, close, pool, getQueryStats, resetQueryStats,
  isReady,
  // חשופים לקוראים שרוצים לעטוף פעולה אידמפוטנטית משלהם בניסיון חוזר.
  retryTransient, isTransient,
};
