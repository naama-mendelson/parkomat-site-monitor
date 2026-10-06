// utils/pmOutbox.js — תיבת יוצאים במכשיר לביקור תחזוקה מונעת.
//
// ============================================================
// ⚠️ למה המכשיר שומר קודם, והשרת אחר כך
// ============================================================
// הביקור נעשה בחניון תת-קרקעי, שם הקליטה נופלת באמצע פריט. טופס שכותב
// ישר לשרת היה מציג "שגיאה" על כל וי שסומן בלי קליטה — והגרוע מזה, מחזיר
// את הווי לאחור. הטכנאי היה מסמן שוב, ושוב, ובסוף מוותר.
//
// לכן: כל שינוי נכתב קודם כאן ומוצג מיד, והשרת מתעדכן ברקע.
//   • וי והערה → localStorage['pm.outbox.<visitId>'] =
//       {itemId: {checked?, checkedBy?, note?, noteBy?, seq, rev}}.
//     **הערך האחרון מנצח**, ו**לעולם אינו מוחזר לאחור** — גם לא כשהשליחה נכשלה.
//     seq = סדר ההכנסה (נשמר בעדכונים — כך נשלחים פריטים שונים), rev = גרסת
//     הערך (עולה בכל שינוי — כך עותק ישן לעולם אינו גובר על חדש).
//   • תמונות (דחוסות) → IndexedDB 'parkomat-pm' / 'photos', לפי client_id.
//     ⚠️ ולא localStorage: 5MB בסך הכול, ותמונה אחת ב-base64 היא ~250KB.
//   • ריקון סדרתי: כשהמכשיר חוזר לרשת, כשהדף חוזר להיות גלוי, וכל 15 שניות.
//     כל שליחה חוזרת בטוחה — השרת מזהה client_id ואינו כופל.
//
// ============================================================
// ⚠️ "נשלח ואושר, השרת עוד לא נקרא מחדש" — שכבה שנשמרת
// ============================================================
// ברגע שהשרת מאשר רשומה היא יוצאת מהתיבה. אם הקריאה הבאה של pm_site
// נכשלת (וזה המצב הרגיל בחניון) — המסך היה מציג את מצב השרת **הישן**:
// וי שנעלם, תמונה שלא נספרת, "חסר פריט חובה" על פריט שהושלם. לכן כל
// אישור נרשם ב-localStorage['pm.acked.<visitId>'] עם חותמת זמן, ונמחק רק
// כשמגיעה תשובת שרת ש**התחילה אחרי** האישור (`pruneAcked`). שעון קיר ולא
// מונה בזיכרון: המונה מתאפס ברענון, והשכבה צריכה לשרוד גם אותו.
//
// ============================================================
// ⚠️ מחיקת תמונה שאולי כבר בשרת — "ביטול" שנשמר
// ============================================================
// תמונה שנשלחה (או בדרך ברגע זה) עשויה להיות בשרת גם אם לא קיבלנו תשובה.
// מחיקה מקומית בלבד הייתה משאירה אותה שם — והיא הייתה נכנסת לביקור החתום
// בלי שהטכנאי ידע. לכן הסרה כזו נרשמת כ"ביטול" (localStorage['pm.undo']),
// נספרת כשינוי ממתין (חוסמת הגשה וסגירה), ונפתרת בריקון דרך `senders.photoUndo`.
//
// ⚠️ **אחסון שאינו זמין (מצב פרטי, אתר חסום) אינו שגיאה שעוצרת את הטופס.**
// התיבה עוברת לזיכרון, `persistent` הופך ל-false, וההורה מציג באנר "המכשיר
// אינו שומר טיוטה — אל תסגרו את הדף". כל גישה לאחסון עטופה ב-try/catch.
// ⚠️ ו-false אינו נעול: חיבור IndexedDB שאבד (iOS מנתק אותו כשה-PWA ברקע,
// למשל בזמן שהמצלמה פתוחה) נפתח מחדש בפעולה הבאה, ומה שחיכה בזיכרון עובר
// אליו. בלי זה כל תמונה אחרי הניתוק הראשון הייתה מתה עם הלשונית.
//
// ⚠️ **שתי לשוניות (PWA + דפדפן באנדרואיד) חולקות את אותו אחסון.** שדות
// ב-localStorage נקראים מחדש בכל פעם, אבל אינדקס התמונות יושב בזיכרון של כל
// לשונית. לכן כל הוספה/הסרה של תמונה מודיעה ב-BroadcastChannel, ו-`refreshIndex`
// קורא מחדש את IndexedDB (חזרה לדף, כל סבב, ולפני הגשה). בלי זה לשונית אחת
// הייתה אומרת "הכול נשמר", מגישה — ו-clearVisit היה מוחק תמונה שלא ראתה.
// ⚠️ וכך גם בהסרה: לשונית A עשויה להעלות תמונה שצולמה ב-B. ההחלטה "אולי כבר
// בשרת" נשענת על IndexedDB (sent) ולא רק על הזיכרון של B, וה-ack ב-A רושם
// "ביטול" כשהתמונה הוסרה בזמן השליחה (הודעת del, או רשומה שנעלמה מהדיסק).
//
// ============================================================
// חוזה השולחים (senders) — הקובץ הזה אינו מכיר את Supabase
// ============================================================
//   drain({
//     check: (visitId, itemId, checked) => Promise,
//     note:  (visitId, itemId, note)    => Promise,
//     photo: (visitId, itemId, clientId, {mime, data, thumb}) => Promise<{id}|void>,
//     photoUndo?: (visitId, itemId, clientId, fileId|null) => Promise,
//   })
// כל שולח **חייב** לזרוק שגיאה שנבנתה ב-`sendError(error, status)` (למטה),
// או לסמן אותה בעצמו:
//   • `network: true`   — אין חיבור (PostgREST מחזיר status 0 ואינו זורק).
//     הסבב נעצר מיד: בלי רשת אין טעם לחכות לזמן הקצוב של כל רשומה.
//     ⚠️ הודעה בעברית ב-`new Error(messageFor(error))` אינה ניתנת לזיהוי —
//     בלי הסימון, סבב בלי קליטה מחכה עשר דקות לכל עשר תמונות.
//   • `timeout: true`   — (בנוסף ל-network) תם הזמן. ⚠️ בתמונה זה **לא** עוצר
//     את הסבב: קישור חלש שלא מספיק להעלות 600KB ב-60 שניות עדיין מעביר וי
//     של כמה בתים. התמונה מקבלת השהיה עולה משלה (עד דקה — TIMEOUT_BACKOFF_MAX_MS),
//     והסבב ממשיך. חזרת קליטה או חזרה לדף מעירות אותה מיד (`wakeTimedOut`).
//   • `permanent: true` — הביקור כבר הוגש/נמחק: הרשומה יוצאת מהתור ונרשמת ב-`dropped`.
//   • `rejected: true`  — השרת דחה את הרשומה עצמה (מכסה, סוג קובץ, הרשאה):
//     היא נשארת, **אינה נשלחת שוב אוטומטית**, ומוצגת ב-`pendingFor().stuck`
//     עם הסיבה, כדי שהטכנאי יחליט — "נסה שוב" או "ותר".
//   • כל שגיאה אחרת — ניסיון חוזר בהשהיה עולה (15 ש' → 10 דק'), ואחרי
//     MAX_ATTEMPTS היא נתקעת כמו rejected. בלי זה רשומה שנדחית תמיד הייתה
//     מעלה תמונה כל 15 שניות על החבילה של הטכנאי, לנצח.
//
// ⚠️ **הרשומות שייכות למשתמש — לכל שדה בנפרד.** `setOwner(userId)` אחרי
// התחברות: שדה שהוכנס ע"י משתמש אחר במכשיר משותף לא יישלח בזהות של הנוכחי
// — אחרת השרת היה מייחס לו עבודה שלא עשה (הכלל: ייחוס, לא מניעה). הבעלות
// לכל שדה ולא לכל פריט: B שמסמן וי בפריט שבו ממתינה הערה של A היה "מאמץ"
// את ההערה — והיא נשלחת בשמו. רשומה זרה נספרת ב-`foreign`, וההורה מציע `discardForeign()`.

const LS_PREFIX = "pm.outbox.";
const ACK_PREFIX = "pm.acked.";
const UNDO_KEY = "pm.undo";
const DB_NAME = "parkomat-pm";
const STORE = "photos";
const LOCK_NAME = "parkomat-pm-outbox";
const CHANNEL = "parkomat-pm";
const DROPPED_KEEP = 20;
const ACK_MAX_AGE_MS = 30 * 24 * 60 * 60_000;     // טיוטה נמחקת אחרי 30 יום (D16) — גם השכבה שלה
export const MAX_ATTEMPTS = 6;
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_MAX_MS = 10 * 60_000;
// ⚠️ תמונה שרק תם זמנה (הקישור חי, חלש מדי ל-600KB) — תקרה נמוכה משלה. התקרה
// המשותפת (10 דק') נועדה לרשומה שהשרת דוחה שוב ושוב; כאן היא הייתה משאירה
// טכנאי שכבר עלה לרחוב, בקליטה מלאה, לחכות דקות להעלאה — וההגשה חסומה בינתיים.
// ואין אירוע 'online' שיעיר אותה: navigator.onLine היה אמת כל הזמן.
const TIMEOUT_BACKOFF_MAX_MS = 60_000;
const FIELDS = ["checked", "note"];

// ---------------- מצב ----------------
let lsOk = null;                        // null = טרם נבדק (בדיקת קריאה בלבד — כתיבה שנכשלה אינה נועלת)
let idbOk = true;                       // תוצאת הפעולה האחרונה, לא דגל נעול
const memItems = new Map();             // visitId → {itemId: entry} — מה שלא הצליח להיכתב ל-localStorage
const memAcked = new Map();             // visitId → שכבת "אושר" — כשאין localStorage
let memUndo = null;                     // {clientId: undo} — כשאין localStorage
const memPhotos = new Map();            // clientId → רשומה מלאה, כשאין IndexedDB
const photoIndex = new Map();           // clientId → {clientId, visitId, itemId, thumb, createdAt, seq, by, sent}
const retryState = new Map();           // מפתח רשומה → {attempts, nextAt, lastError, stuck, entry}
const ackedThumbs = new Map();          // clientId → {visitId, thumb} — ממוזערת של תמונה שאושרה (בזיכרון)
const inflight = new Set();             // clientId שנשלח ברגע זה
const writing = new Set();              // clientId שנוסף לאינדקס ועוד לא נכתב ל-IndexedDB
const sentIds = new Set();              // clientId שנמסר לשולח לפחות פעם אחת (גם כשסימון הדיסק נכשל)
const removedElsewhere = new Set();     // clientId שלשונית אחרת הסירה בזמן שנשלח כאן
let indexPromise = null;
let dbPromise = null;
let flushing = false;
let draining = null;
let rerun = false;
let lastError = null;
let lastSyncAt = null;
let owner = null;
let seqCounter = 0;
let storageListening = false;
let channel;                            // undefined = טרם נפתח; null = אין BroadcastChannel
const dropped = [];
const listeners = new Set();

const key = (visitId) => `${LS_PREFIX}${visitId}`;

// מונה עולה: גדול מכל מה שניתן קודם, גם באותה מילישנייה וגם בין לשוניות.
function nextSeq() {
  seqCounter = Math.max(Date.now() * 1000, seqCounter + 1);
  return seqCounter;
}

const photoOrder = (p) => p.seq ?? (p.createdAt || 0) * 1000;
const isMine = (e) => owner == null || e?.by == null || e.by === owner;
// בעלות לשדה: `${field}By`, ובהעדרו `by` הישן (רשומות שנכתבו לפני הפיצול).
const ownerOf = (e, f) => (e?.[`${f}By`] !== undefined ? e[`${f}By`] : (e?.by ?? null));
const mineField = (e, f) => !!e && f in e && (owner == null || ownerOf(e, f) == null || ownerOf(e, f) === owner);
const hasMine = (e) => FIELDS.some((f) => mineField(e, f));
const hasForeign = (e) => owner != null && FIELDS.some((f) => e && f in e && !mineField(e, f));
const fieldKey = (visitId, itemId, field) => `f|${visitId}|${itemId}|${field}`;
const photoKey = (clientId) => `p|${clientId}`;
const undoKey = (clientId) => `u|${clientId}`;
const deviceOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;

function dropField(entry, field) {
  delete entry[field];
  delete entry[`${field}By`];
  return FIELDS.some((f) => f in entry);
}

// ---------------- localStorage ----------------
function lsAvailable() {
  if (lsOk !== null) return lsOk;
  try {
    const probe = `${LS_PREFIX}__probe`;
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    lsOk = true;
  } catch {
    lsOk = false;
  }
  return lsOk;
}

function readJson(k) {
  if (!lsAvailable()) return null;
  try {
    const raw = window.localStorage.getItem(k);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// true = נכתב לדיסק. ⚠️ כתיבה שנכשלה (מכסה מלאה) מוחקת את העותק הישן — אחרת
// אחרי רענון הוא היה חוזר, ומחזיר ערך שכבר השתנה.
function writeJson(k, obj, empty) {
  if (!lsAvailable()) return false;
  try {
    if (empty) window.localStorage.removeItem(k);
    else window.localStorage.setItem(k, JSON.stringify(obj));
    return true;
  } catch {
    try { window.localStorage.removeItem(k); } catch { /* חסום לגמרי */ }
    return false;
  }
}

function readVisit(visitId) {
  const out = { ...(readJson(key(visitId)) || {}) };
  // החדש גובר לפי rev — ולא "הזיכרון תמיד גובר": עותק ישן ששרד באחד המקומות
  // לעולם לא יחזיר וי שהטכנאי ביטל.
  const mem = memItems.get(String(visitId)) || {};
  for (const [itemId, v] of Object.entries(mem)) {
    const cur = out[itemId];
    if (!cur || (v.rev ?? Infinity) >= (cur.rev ?? 0)) out[itemId] = v;
  }
  return out;
}

function writeVisit(visitId, obj) {
  const v = String(visitId);
  const empty = Object.keys(obj).length === 0;
  if (writeJson(key(v), obj, empty)) { memItems.delete(v); return; }
  if (empty) memItems.delete(v);
  else memItems.set(v, obj);
}

function visitIds() {
  const ids = new Set(memItems.keys());
  if (lsAvailable()) {
    try {
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k && k.startsWith(LS_PREFIX) && !k.endsWith("__probe")) ids.add(k.slice(LS_PREFIX.length));
      }
    } catch { /* אין גישה — רק מה שבזיכרון */ }
  }
  return [...ids];
}

// ---------------- שכבת "אושר" ----------------
// {items: {itemId: {checked?: {value, at}, note?: {value, at}}}, photos: {clientId: {itemId, fileId, at}}}
function readAcked(visitId) {
  const v = String(visitId);
  const src = memAcked.has(v) ? JSON.parse(JSON.stringify(memAcked.get(v))) : readJson(`${ACK_PREFIX}${v}`);
  return { items: src?.items || {}, photos: src?.photos || {} };
}

function writeAcked(visitId, a) {
  const v = String(visitId);
  const empty = !Object.keys(a.items).length && !Object.keys(a.photos).length;
  if (writeJson(`${ACK_PREFIX}${v}`, a, empty)) { memAcked.delete(v); return; }
  if (empty) memAcked.delete(v);
  else memAcked.set(v, a);
}

function recordAckField(visitId, itemId, field, value) {
  const a = readAcked(visitId);
  const e = a.items[itemId] || (a.items[itemId] = {});
  e[field] = { value, at: Date.now() };
  writeAcked(visitId, a);
}

function recordAckPhoto(visitId, itemId, clientId, fileId, thumb) {
  const a = readAcked(visitId);
  a.photos[clientId] = { itemId: String(itemId), fileId: fileId ?? null, at: Date.now() };
  writeAcked(visitId, a);
  if (thumb) ackedThumbs.set(clientId, { visitId: String(visitId), thumb });
}

// שכבות של ביקורים שנשכחו (טיוטה שנמחקה אחרי 30 יום, אתר שלא נפתח שוב).
function sweepAcked() {
  if (!lsAvailable()) return;
  const old = Date.now() - ACK_MAX_AGE_MS;
  try {
    const keys = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(ACK_PREFIX)) keys.push(k);
    }
    for (const k of keys) {
      const a = readJson(k);
      const ats = [
        ...Object.values(a?.items || {}).flatMap((e) => FIELDS.map((f) => e?.[f]?.at).filter(Number.isFinite)),
        ...Object.values(a?.photos || {}).map((p) => p?.at).filter(Number.isFinite),
      ];
      if (!ats.length || Math.max(...ats) < old) window.localStorage.removeItem(k);
    }
  } catch { /* ניקוי בלבד */ }
}

// ---------------- ביטולי תמונה ----------------
function readUndo() {
  if (memUndo) return { ...memUndo };
  return { ...(readJson(UNDO_KEY) || {}) };
}

function writeUndo(obj) {
  const empty = Object.keys(obj).length === 0;
  if (writeJson(UNDO_KEY, obj, empty)) { memUndo = null; return; }
  memUndo = empty ? null : obj;
}

const hasUndo = (clientId) => !!readUndo()[clientId];

function removeUndo(clientId) {
  const u = readUndo();
  if (!u[clientId]) return;
  delete u[clientId];
  writeUndo(u);
}

// ---------------- IndexedDB ----------------
function openDb() {
  if (dbPromise) return dbPromise;
  const p = new Promise((resolve, reject) => {
    try {
      if (typeof indexedDB === "undefined") throw new Error("no indexedDB");
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const st = db.createObjectStore(STORE, { keyPath: "clientId" });
          st.createIndex("visitId", "visitId", { unique: false });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // חיבור שנסגר מבחוץ (iOS, שדרוג גרסה בלשונית אחרת) — הבא ייפתח מחדש.
        db.onclose = () => { if (dbPromise === p) dbPromise = null; };
        db.onversionchange = () => {
          try { db.close(); } catch { /* */ }
          if (dbPromise === p) dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error || new Error("indexedDB open failed"));
      req.onblocked = () => reject(new Error("indexedDB blocked"));
    } catch (err) {
      reject(err);
    }
  });
  dbPromise = p;
  // ⚠️ פתיחה שנכשלה אינה נשמרת: הניסיון הבא פותח מחדש.
  p.catch(() => { if (dbPromise === p) dbPromise = null; });
  return p;
}

function runTx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    let out;
    const tx = db.transaction(STORE, mode);   // InvalidStateError כשהחיבור מת — נתפס למעלה
    const req = fn(tx.objectStore(STORE));
    if (req) req.onsuccess = () => { out = req.result; };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error || new Error("indexedDB tx failed"));
    tx.onabort = () => reject(tx.error || new Error("indexedDB tx aborted"));
  });
}

// פעולה אחת, וניסיון חוזר **אחד** על חיבור חדש. idbOk = תוצאת הפעולה האחרונה.
async function idb(mode, fn) {
  let out;
  try {
    out = await runTx(await openDb(), mode, fn);
  } catch {
    dbPromise = null;
    try {
      out = await runTx(await openDb(), mode, fn);
    } catch (err2) {
      idbOk = false;
      throw err2;
    }
  }
  idbOk = true;
  if (memPhotos.size && !flushing) flushMemPhotos();
  return out;
}

// חיבור חזר — מה שחיכה בזיכרון עובר לדיסק, כדי לשרוד סגירת לשונית.
async function flushMemPhotos() {
  flushing = true;
  try {
    for (const [clientId, rec] of [...memPhotos]) {
      try {
        await runTx(await openDb(), "readwrite", (st) => st.put(rec));
        if (memPhotos.get(clientId) === rec) memPhotos.delete(clientId);
      } catch {
        idbOk = false;
        break;
      }
    }
  } finally {
    flushing = false;
    emit();
  }
}

const meta = (r) => ({
  clientId: r.clientId, visitId: String(r.visitId), itemId: r.itemId, thumb: r.thumb,
  createdAt: r.createdAt, seq: r.seq, by: r.by ?? null, sent: !!r.sent,
});

function loadIndex() {
  indexPromise ??= idb("readonly", (st) => st.getAll())
    .then((rows) => { for (const r of rows || []) if (!photoIndex.has(r.clientId)) photoIndex.set(r.clientId, meta(r)); })
    .catch(() => {
      // ⚠️ לא נשמר כישלון: אחרי שהחיבור יחזור, הקריאה הבאה תטען שוב.
      indexPromise = null;
    })
    .finally(emit);
  return indexPromise;
}

/**
 * קורא מחדש את IndexedDB: מוסיף מה שלשונית אחרת הכניסה, ומסיר מה שהיא שלחה
 * או מחקה. מפתחות בלבד (getAllKeys) — רשומה מלאה נקראת רק כשהיא חדשה לנו.
 * כישלון קריאה משאיר את האינדקס כמות שהוא.
 */
export async function refreshIndex() {
  await loadIndex();
  let keys;
  try {
    keys = await idb("readonly", (st) => st.getAllKeys());
  } catch {
    return;
  }
  const have = new Set(keys || []);
  let changed = false;
  for (const cid of [...photoIndex.keys()]) {
    if (have.has(cid) || memPhotos.has(cid) || writing.has(cid) || inflight.has(cid)) continue;
    photoIndex.delete(cid);
    changed = true;
  }
  for (const cid of have) {
    if (photoIndex.has(cid)) continue;
    try {
      const r = await idb("readonly", (st) => st.get(cid));
      if (r && !photoIndex.has(cid)) { photoIndex.set(cid, meta(r)); changed = true; }
    } catch { /* בפעם הבאה */ }
  }
  if (changed) emit();
}

// ⚠️ "לא קיים" ו"הקריאה נכשלה" הם שני דברים: הראשון מוחק מהאינדקס, השני
// משאיר. בלבול ביניהם הוציא תמונה מהתור בגלל תקלת קריאה רגעית — התיבה
// נראתה ריקה, "הגשה" נפתחה, והתמונה מעולם לא עלתה.
async function getPhotoRecord(clientId) {
  if (memPhotos.has(clientId)) return memPhotos.get(clientId);
  const rec = await idb("readonly", (st) => st.get(clientId));   // זורק בכישלון
  return rec ?? null;                                            // null = באמת לא קיים
}

async function deletePhotoRecord(clientId) {
  memPhotos.delete(clientId);
  photoIndex.delete(clientId);
  retryState.delete(photoKey(clientId));
  try { await idb("readwrite", (st) => st.delete(clientId)); } catch { /* היה בזיכרון בלבד */ }
  post({ t: "del", clientId });
}

// סימון "נמסר לשולח" — כדי שהסרה מאוחרת תדע שהתמונה אולי כבר בשרת, גם אחרי רענון.
async function markSent(rec) {
  sentIds.add(rec.clientId);
  const m = photoIndex.get(rec.clientId);
  if (m) m.sent = true;
  if (rec.sent) return;
  rec.sent = true;
  if (memPhotos.has(rec.clientId)) return;
  try { await idb("readwrite", (st) => st.put(rec)); } catch { /* sentIds מכסה את הלשונית הזו */ }
}

// כל הרשומות של ביקור ב-IndexedDB, גם כאלה שאינן באינדקס שבזיכרון.
async function deleteVisitPhotosFromDb(visitId) {
  try {
    await idb("readwrite", (st) => {
      const req = st.index("visitId").openCursor(IDBKeyRange.only(String(visitId)));
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) { cur.delete(); cur.continue(); }
      };
      return null;
    });
  } catch { /* אין IndexedDB — מה שבזיכרון כבר נמחק */ }
}

// ---------------- לשוניות אחרות ----------------
function chan() {
  if (channel !== undefined) return channel;
  channel = null;
  try {
    if (typeof BroadcastChannel === "function") {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = (e) => onMessage(e?.data);
      channel.unref?.();          // ב-node: ערוץ פתוח אינו מחזיק את התהליך בחיים
    }
  } catch {
    channel = null;
  }
  return channel;
}

function post(msg) {
  try { chan()?.postMessage(msg); } catch { /* אין ערוץ — refreshIndex בחזרה לדף מכסה */ }
}

function onMessage(m) {
  if (!m || typeof m !== "object") return;
  if (m.t === "add" && m.meta?.clientId) {
    if (!photoIndex.has(m.meta.clientId)) photoIndex.set(m.meta.clientId, { ...m.meta, visitId: String(m.meta.visitId) });
  } else if (m.t === "del" && m.clientId) {
    // ⚠️ נשלחת מכאן ברגע זה: הלשונית האחרת הסירה תמונה שאולי כבר בשרת. נזכרים,
    // וה-ack ירשום "ביטול" במקום "אושרה" (ראה drainOnce) — אחרת היא נכנסת לביקור
    // החתום, כשבלשונית ששם הוסרה כתוב "כל השינויים נשמרו".
    if (inflight.has(m.clientId)) { removedElsewhere.add(m.clientId); return; }
    if (memPhotos.has(m.clientId)) return;
    photoIndex.delete(m.clientId);
    retryState.delete(photoKey(m.clientId));
  } else if (m.t === "sync") {
    refreshIndex();
    return;
  }
  emit();
}

// ---------------- התראות ----------------
function foreignCount() {
  if (owner == null) return 0;
  let n = 0;
  for (const id of visitIds()) for (const e of Object.values(readVisit(id))) if (hasForeign(e)) n++;
  for (const p of photoIndex.values()) if (!isMine(p)) n++;
  for (const u of Object.values(readUndo())) if (!isMine(u)) n++;
  return n;
}

function stuckList(visitId) {
  const out = [];
  for (const [k, s] of retryState) {
    if (!s.stuck) continue;
    if (visitId != null && String(s.entry.visitId) !== String(visitId)) continue;
    out.push({ key: k, ...s.entry, error: s.lastError, attempts: s.attempts });
  }
  return out;
}

function snapshot() {
  return {
    pending: pendingCount(),
    persistent: isPersistent(),
    draining: !!draining,
    lastError,
    lastSyncAt,
    dropped: dropped.slice(),
    stuck: stuckList().length,
    foreign: foreignCount(),
  };
}

function emit() {
  if (!listeners.size) return;
  const s = snapshot();
  for (const fn of listeners) {
    try { fn(s); } catch { /* מאזין שבור לא עוצר את האחרים */ }
  }
}

// לשונית אחרת שינתה את התיבה — המונים כאן מתעדכנים.
function listenStorage() {
  if (storageListening || typeof window === "undefined") return;
  storageListening = true;
  chan();
  sweepAcked();
  try {
    window.addEventListener("storage", (e) => {
      if (e.key == null || e.key.startsWith(LS_PREFIX) || e.key.startsWith(ACK_PREFIX) || e.key === UNDO_KEY) emit();
    });
  } catch { /* */ }
}

/** מנוי לשינויים. נקרא מיד עם המצב הנוכחי. מחזיר פונקציית ביטול. */
export function subscribe(fn) {
  listeners.add(fn);
  listenStorage();
  loadIndex();
  try { fn(snapshot()); } catch { /* */ }
  return () => listeners.delete(fn);
}

/** האם מה שבתיבה ישרוד סגירת הדף. false → באנר "אל תסגרו את הדף". */
export function isPersistent() {
  return lsAvailable() && idbOk && memItems.size === 0 && memPhotos.size === 0 && memUndo == null;
}

/** מבטיח שאינדקס התמונות נטען מ-IndexedDB (אחרי רענון דף). */
export function ready() {
  return loadIndex();
}

/** המשתמש המחובר (מזהה יציב). null = לא ידוע — אז כל הרשומות נחשבות שלו. */
export function setOwner(userId) {
  owner = userId == null ? null : String(userId);
  emit();
}

// ---------------- API: הוספה ----------------
function setField(visitId, itemId, field, value) {
  const obj = readVisit(visitId);
  const prev = obj[itemId] || {};
  const next = { ...prev, [field]: value, [`${field}By`]: owner, seq: prev.seq ?? nextSeq(), rev: nextSeq() };
  // ⚠️ רשומה ישנה עם `by` אחד לפריט: הבעלות של השדה השני נשמרת לפני שהוא נמחק —
  // אחרת הערה של A שממתינה הייתה הופכת לשל B ברגע ש-B מסמן וי באותו פריט.
  if ("by" in next) {
    for (const f of FIELDS) if (f !== field && f in next && next[`${f}By`] === undefined) next[`${f}By`] = prev.by ?? null;
    delete next.by;
  }
  obj[itemId] = next;
  writeVisit(visitId, obj);
  // ערך חדש = הזדמנות חדשה: ההשהיה והתקיעה של הערך הקודם אינן חלות עליו.
  retryState.delete(fieldKey(String(visitId), itemId, field));
  emit();
}

export function enqueueCheck(visitId, itemId, checked) {
  setField(visitId, itemId, "checked", !!checked);
}

export function enqueueNote(visitId, itemId, note) {
  setField(visitId, itemId, "note", String(note ?? ""));
}

/** שומר תמונה דחוסה במכשיר. מחזיר {queued:true, persisted} — persisted=false = בזיכרון בלבד. */
export async function enqueuePhoto(visitId, itemId, clientId, compressed) {
  const rec = {
    clientId,
    visitId: String(visitId),
    itemId,
    mime: compressed.mime,
    data: compressed.data,
    thumb: compressed.thumb,
    createdAt: Date.now(),
    seq: nextSeq(),
    by: owner,
  };
  writing.add(clientId);
  photoIndex.set(clientId, meta(rec));
  let persisted = false;
  try {
    await idb("readwrite", (st) => st.put(rec));
    memPhotos.delete(clientId);
    persisted = true;
  } catch {
    memPhotos.set(clientId, rec);
  } finally {
    writing.delete(clientId);
  }
  if (persisted) post({ t: "add", meta: meta(rec) });
  emit();
  return { queued: true, persisted };
}

/**
 * מסיר תמונה ממתינה (הטכנאי מחק אותה לפני סנכרון).
 * ⚠️ תמונה שכבר נמסרה לשולח — או שנשלחת ברגע זה — אולי כבר בשרת: נרשם
 * "ביטול" שנספר כממתין ונפתר בריקון (photoUndo). מחיקה מקומית בלבד הייתה
 * משאירה אותה בשרת, והיא הייתה נכנסת לביקור החתום.
 */
export async function removePhoto(clientId) {
  const m = photoIndex.get(clientId) || (memPhotos.has(clientId) ? meta(memPhotos.get(clientId)) : null);
  let maybeSent = !!m && (inflight.has(clientId) || sentIds.has(clientId) || m.sent);
  // ⚠️ ולא רק מה שהלשונית הזו יודעת: לשונית אחרת (PWA + דפדפן) אולי שולחת אותה
  // עכשיו, או שלחה ולא קיבלה תשובה — וסימנה `sent` ב-IndexedDB לפני השליחה
  // (markSent). האינדקס שבזיכרון כאן לא ראה את זה. קריאה שנכשלה = לא ידוע →
  // ביטול; ביטול של תמונה שאינה בשרת עולה שאלה אחת לשרת, ולא יותר.
  if (m && !maybeSent && !memPhotos.has(clientId)) {
    try { maybeSent = !!(await getPhotoRecord(clientId))?.sent; } catch { maybeSent = true; }
  }
  if (maybeSent) {
    const u = readUndo();
    u[clientId] = { visitId: String(m.visitId), itemId: String(m.itemId), by: m.by ?? owner, fileId: null, at: Date.now() };
    writeUndo(u);
  }
  await deletePhotoRecord(clientId);
  emit();
}

// ---------------- API: קריאה ----------------
/**
 * מה שעדיין ממתין לביקור (של המשתמש הנוכחי): ערכים למיזוג **מעל** מצב השרת,
 * תמונות ממתינות, ביטולי תמונה, ו-stuck — רשומות שהשרת דחה, עם הסיבה
 * (ל"נסה שוב"/"ותר"). `waiting` = מה שעוד יישלח לבד (בלי התקועות).
 */
export function pendingFor(visitId) {
  const v = String(visitId);
  const stuck = stuckList(v);
  const stuckKeys = new Set(stuck.map((s) => s.key));
  const items = {};
  let waiting = 0;
  for (const [itemId, e] of Object.entries(readVisit(v))) {
    const o = {};
    let live = false;
    for (const f of FIELDS) {
      if (!mineField(e, f)) continue;
      o[f] = e[f];
      if (!stuckKeys.has(fieldKey(v, itemId, f))) live = true;
    }
    if (Object.keys(o).length) { items[itemId] = o; if (live) waiting++; }
  }
  const photos = [...photoIndex.values()]
    .filter((p) => p.visitId === v && isMine(p))
    .sort((a, b) => photoOrder(a) - photoOrder(b));
  for (const p of photos) if (!stuckKeys.has(photoKey(p.clientId))) waiting++;
  const undo = Object.entries(readUndo())
    .filter(([, u]) => String(u.visitId) === v && isMine(u))
    .map(([clientId, u]) => ({ clientId, itemId: String(u.itemId) }));
  for (const u of undo) if (!stuckKeys.has(undoKey(u.clientId))) waiting++;
  return { items, photos, undo, stuck, waiting };
}

/** מספר הרשומות הממתינות (פריט עם וי והערה = 1). בלי visitId — בכל הביקורים. */
export function pendingCount(visitId) {
  const ids = visitId == null ? visitIds() : [String(visitId)];
  let n = 0;
  for (const id of ids) for (const e of Object.values(readVisit(id))) if (hasMine(e)) n++;
  for (const p of photoIndex.values()) {
    if ((visitId == null || p.visitId === String(visitId)) && isMine(p)) n++;
  }
  for (const u of Object.values(readUndo())) {
    if ((visitId == null || String(u.visitId) === String(visitId)) && isMine(u)) n++;
  }
  return n;
}

/** כמה שינויים של הביקור יצאו מהתור כי הביקור כבר לא פתוח (מאז שהלשונית נפתחה). */
export function droppedCount(visitId) {
  return dropped.filter((d) => String(d.visitId) === String(visitId)).length;
}

/**
 * מה שהשרת אישר ועוד לא נקרא ממנו מחדש (ראה הכותרת). `at` — מתי אושר.
 * @returns {{items: Object<string,{checked?:{value,at}, note?:{value,at}}>,
 *            photos: Array<{clientId, itemId, fileId, at, thumb}>}}
 */
export function ackedFor(visitId) {
  const a = readAcked(visitId);
  return {
    items: a.items,
    photos: Object.entries(a.photos).map(([clientId, p]) => ({
      clientId, itemId: String(p.itemId), fileId: p.fileId ?? null, at: p.at, thumb: ackedThumbs.get(clientId)?.thumb ?? null,
    })),
  };
}

/** תשובת שרת שהשליפה שלה התחילה ב-`readStartedAt` מכסה כל אישור שקדם לה. */
export function pruneAcked(visitId, readStartedAt) {
  if (!Number.isFinite(readStartedAt) || readStartedAt <= 0) return;
  const a = readAcked(visitId);
  let changed = false;
  for (const [itemId, e] of Object.entries(a.items)) {
    for (const f of FIELDS) if (e?.[f] && !(e[f].at >= readStartedAt)) { delete e[f]; changed = true; }
    if (!FIELDS.some((f) => e && f in e)) { delete a.items[itemId]; changed = true; }
  }
  for (const [cid, p] of Object.entries(a.photos)) {
    if (!(p?.at >= readStartedAt)) { delete a.photos[cid]; changed = true; }
  }
  if (changed) { writeAcked(visitId, a); emit(); }
}

/** תמונה שאושרה ונמחקה עכשיו מהשרת (לפי ה-id שלה) — יוצאת מהשכבה. */
export function forgetAckedPhoto(visitId, clientId) {
  const a = readAcked(visitId);
  if (!a.photos[clientId]) return;
  delete a.photos[clientId];
  writeAcked(visitId, a);
  emit();
}

/** ממוזערת שמורה בזיכרון לתמונה שצולמה כאן ואושרה (null אם אין). */
export function thumbFor(clientId) {
  return clientId ? ackedThumbs.get(clientId)?.thumb ?? null : null;
}

/** אחרי הגשה/ביטול: מנקה כל שארית של הביקור — גם של משתמשים אחרים, וגם מה שלא באינדקס. */
export async function clearVisit(visitId) {
  const v = String(visitId);
  writeVisit(v, {});
  memItems.delete(v);
  writeAcked(v, { items: {}, photos: {} });
  memAcked.delete(v);
  const u = readUndo();
  let undoChanged = false;
  for (const [cid, x] of Object.entries(u)) if (String(x.visitId) === v) { delete u[cid]; undoChanged = true; }
  if (undoChanged) writeUndo(u);
  for (const [cid, t] of [...ackedThumbs]) if (t.visitId === v) ackedThumbs.delete(cid);
  for (let i = dropped.length - 1; i >= 0; i--) if (String(dropped[i].visitId) === v) dropped.splice(i, 1);
  await loadIndex();          // אינדקס שעוד לא נטען (מיד אחרי רענון) היה מפספס תמונות
  for (const p of [...photoIndex.values()]) if (p.visitId === v) await deletePhotoRecord(p.clientId);
  for (const [clientId, rec] of [...memPhotos]) if (rec.visitId === v) memPhotos.delete(clientId);
  await deleteVisitPhotosFromDb(v);
  for (const [k, s] of [...retryState]) if (String(s.entry.visitId) === v) retryState.delete(k);
  post({ t: "sync" });
  emit();
}

/** רשומה תקועה → ניסיון נוסף בסבב הבא. בלי מפתח — כולן. */
export function retryStuck(entryKey) {
  for (const [k, s] of [...retryState]) {
    if (entryKey == null || k === entryKey) {
      if (s.stuck || entryKey != null) retryState.delete(k);
    }
  }
  emit();
}

/**
 * תמונות שתם זמנן (קישור חלש) — יוצאות מההשהיה ומנסות בסבב הבא. נקרא כשהקליטה
 * חוזרת וכשהדף חוזר להיות גלוי: טכנאי שעלה לרחוב ופתח את הטלפון לא צריך לחכות
 * לסוף ההשהיה שנצברה במרתף. רשומות שהשרת דחה (stuck) אינן מושפעות.
 */
export function wakeTimedOut() {
  let n = 0;
  for (const s of retryState.values()) {
    if (s.timedOut && !s.stuck && s.nextAt > 0) { s.nextAt = 0; n++; }
  }
  if (n) emit();
  return n;
}

/** ויתור על רשומה תקועה (מפתח מ-pendingFor().stuck). הערך המקומי נמחק. */
export async function discardStuck(entryKey) {
  const s = retryState.get(entryKey);
  if (!s) return;
  const e = s.entry;
  if (e.kind === "photo") {
    await deletePhotoRecord(e.clientId);
  } else if (e.kind === "undo") {
    removeUndo(e.clientId);       // התמונה נשארת בשרת — זו ההחלטה של מי שוויתר
  } else {
    const field = e.kind === "check" ? "checked" : "note";
    const now = readVisit(e.visitId);
    const cur = now[e.itemId];
    if (cur && field in cur) {
      if (!dropField(cur, field)) delete now[e.itemId];
      writeVisit(e.visitId, now);
    }
  }
  retryState.delete(entryKey);
  emit();
}

/** מוחק רשומות של משתמשים אחרים במכשיר (אחרי אישור בממשק). */
export async function discardForeign() {
  if (owner == null) return;
  for (const id of visitIds()) {
    const obj = readVisit(id);
    let changed = false;
    for (const [itemId, e] of Object.entries(obj)) {
      for (const f of FIELDS) {
        if (f in e && !mineField(e, f)) {
          changed = true;
          if (!dropField(e, f)) delete obj[itemId];
        }
      }
    }
    if (changed) writeVisit(id, obj);
  }
  for (const p of [...photoIndex.values()]) if (!isMine(p)) await deletePhotoRecord(p.clientId);
  const u = readUndo();
  let undoChanged = false;
  for (const [cid, x] of Object.entries(u)) if (!isMine(x)) { delete u[cid]; undoChanged = true; }
  if (undoChanged) writeUndo(u);
  emit();
}

// ---------------- סיווג שגיאות ----------------
const NET_RE = /failed to fetch|networkerror|network request failed|load failed|timeouterror|aborterror|timed? ?out|ERR_INTERNET|ERR_NETWORK/i;
const TIMEOUT_RE = /timeouterror|aborterror|timed? ?out|signal is aborted|aborted/i;

/**
 * שגיאת PostgREST (`{error, status}` מ-supabase-js, שאינו זורק) → Error עם
 * הסימון שהתיבה מבינה. השולחים זורקים את מה שזה מחזיר.
 *   status 0 / abort / timeout            → network (וזמן קצוב → גם timeout)
 *   5xx, 408, 429, 401, JWT (PGRST30x)    → זמני (ניסיון חוזר בהשהיה)
 *   שאר 4xx                               → rejected (נתקע, מוצג, לא נשלח שוב לבד)
 * @param {{message?:string, code?:string}|Error|null} error
 * @param {number} [status]
 * @param {string} [message] — הטקסט למשתמש (למשל messageFor(error))
 */
export function sendError(error, status, message) {
  const raw = String(error?.message || error || "");
  const err = new Error(message || raw || "השליחה נכשלה");
  err.cause = error;
  err.status = status;
  err.code = error?.code;
  const code = String(error?.code || "");
  const name = error?.name || "";
  if (status === 0 || name === "AbortError" || name === "TimeoutError" || NET_RE.test(raw)) {
    err.network = true;
    if (name === "AbortError" || name === "TimeoutError" || TIMEOUT_RE.test(raw)) err.timeout = true;
  } else if (status >= 500 || status === 408 || status === 429 || status === 401 || /^PGRST30/.test(code)) {
    // זמני
  } else if (status >= 400 || /^(P0001|22|23|42501|PT4)/.test(code)) {
    err.rejected = true;
  }
  return err;
}

function isNetworkError(err) {
  if (!err) return false;
  if (err.network) return true;
  if (err.status === 0) return true;
  const name = err.name || "";
  if (name === "AbortError" || name === "TimeoutError") return true;
  if (NET_RE.test(String(err.message || ""))) return true;
  // הדפדפן עצמו אומר שאין רשת — גם כשההודעה בעברית ואין סימון
  return !deviceOnline();
}

function isTimeout(err) {
  if (!err) return false;
  if (err.timeout) return true;
  const name = err.name || "";
  return name === "AbortError" || name === "TimeoutError" || TIMEOUT_RE.test(String(err.cause?.message || ""));
}

function recordDrop(entry, err) {
  dropped.push({ ...entry, reason: err?.message || String(err), at: new Date().toISOString() });
  while (dropped.length > DROPPED_KEEP) dropped.shift();
}

const backoffMs = (attempts) => Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempts - 1));

/**
 * שליחה אחת. מחזיר "stop" (אין רשת — עוצרים את הסבב), "error" (נשארה בתור),
 * "skip" (בהשהיה/תקועה), אחרת undefined.
 * @param {{ack:(result)=>any, discard:()=>any}} done — ack אחרי הצלחה (עם תוצאת השולח),
 *   discard כשהשרת אומר שהרשומה לעולם לא תתקבל (הביקור הוגש/נמחק).
 * @param {boolean} heavy — רשומה כבדה (תמונה): זמן קצוב אינו עוצר את הסבב.
 */
async function attempt(rkey, entry, run, done, force, heavy = false) {
  const st = retryState.get(rkey);
  if (!force && st && (st.stuck || st.nextAt > Date.now())) return "skip";
  try {
    const result = await run();
    await done.ack(result);
    retryState.delete(rkey);
    lastSyncAt = new Date().toISOString();
    return undefined;
  } catch (err) {
    lastError = err?.message || String(err);
    if (err?.permanent) {
      await done.discard();
      retryState.delete(rkey);
      recordDrop(entry, err);
      return undefined;
    }
    if (isNetworkError(err)) {
      // לא נספר כניסיון: הרשומה עצמה תקינה, הרשת לא.
      // ⚠️ חוץ מתמונה שתם זמנה כשהמכשיר מחובר: הקישור חי אבל חלש מדי לה. עצירת
      // הסבב כאן הייתה חוסמת לנצח כל וי והערה של הביקור — ומעלה אותה שוב כל
      // 15 שניות בלי השהיה. היא מקבלת השהיה משלה (לא נתקעת), והסבב ממשיך.
      if (!(heavy && isTimeout(err) && deviceOnline())) return "stop";
      const attempts = (st?.attempts ?? 0) + 1;
      const wait = Math.min(TIMEOUT_BACKOFF_MAX_MS, backoffMs(attempts));
      retryState.set(rkey, { attempts, nextAt: Date.now() + wait, lastError, stuck: false, entry, timedOut: true });
      return "error";
    }
    const attempts = (st?.attempts ?? 0) + 1;
    retryState.set(rkey, {
      attempts,
      nextAt: Date.now() + backoffMs(attempts),
      lastError,
      stuck: !!err?.rejected || attempts >= MAX_ATTEMPTS,
      entry,
    });
    return "error";
  } finally {
    emit();
  }
}

const resultId = (res) => {
  const raw = res && typeof res === "object" ? res.id : res;
  const n = Number(raw);
  return raw != null && Number.isFinite(n) ? n : null;
};

async function drainOnce(senders, force) {
  if (!deviceOnline()) return;
  await loadIndex();
  let failed = false;
  const ids = new Set([
    ...visitIds(),
    ...[...photoIndex.values()].map((p) => p.visitId),
    ...Object.values(readUndo()).map((u) => String(u.visitId)),
  ]);

  for (const visitId of ids) {
    // ⚠️ וי והערות לפני תמונות. בקשה של כמה בתים עוברת גם בקישור שלא מעלה
    // 600KB בזמן — וטכנאי שצילם ואז סימן עשרה פריטים לא אמור לחכות לתמונה.
    // השרת אינו קושר וי לתמונה (pm_visit_item_check לא מסתכל ב-pm_files),
    // וההגשה ממילא דורשת שהתיבה כולה תתרוקן.
    // פריטים לפי סדר ההכנסה (seq), ולא לפי סדר המפתחות: ב-JS מפתח שהוא מספר
    // שלם ממוין תמיד בסדר עולה, ופריט 3 היה נשלח לפני פריט 7 שסומן קודם.
    const items = Object.entries(readVisit(visitId))
      .filter(([, e]) => hasMine(e))
      .sort(([, a], [, b]) => (a.seq ?? 0) - (b.seq ?? 0));
    for (const [itemId, entry] of items) {
      for (const field of FIELDS) {
        if (!mineField(entry, field)) continue;
        const value = entry[field];
        // ⚠️ הסרה רק אם הערך לא השתנה בזמן השליחה. וי שבוטל ואז סומן שוב
        // בזמן שהבקשה הקודמת בדרך — הערך החדש נשאר בתור ויישלח בסבב הבא.
        const removeIfSame = () => {
          const now = readVisit(visitId);
          const cur = now[itemId];
          if (cur && field in cur && cur[field] === value) {
            if (!dropField(cur, field)) delete now[itemId];
            writeVisit(visitId, now);
          }
        };
        const r = await attempt(
          fieldKey(visitId, itemId, field),
          { kind: field === "checked" ? "check" : "note", visitId, itemId, value },
          () => (field === "checked" ? senders.check(visitId, itemId, value) : senders.note(visitId, itemId, value)),
          {
            // ⚠️ השכבה נכתבת **לפני** שהרשומה יוצאת מהתיבה — בלי רגע ביניים
            // שבו המסך נופל למצב השרת הישן.
            ack: () => { recordAckField(visitId, itemId, field, value); removeIfSame(); },
            discard: removeIfSame,
          },
          force,
        );
        if (r === "stop") return;
        if (r === "error") failed = true;
      }
    }

    const photos = [...photoIndex.values()]
      .filter((p) => p.visitId === visitId && isMine(p))
      .sort((a, b) => photoOrder(a) - photoOrder(b));
    for (const p of photos) {
      const cid = p.clientId;
      const rkey = photoKey(cid);
      const st = retryState.get(rkey);
      if (!force && st && (st.stuck || st.nextAt > Date.now())) continue;
      let r;
      inflight.add(cid);
      try {
        let rec;
        try {
          rec = await getPhotoRecord(cid);
        } catch {
          failed = true;          // קריאה מקומית נכשלה — הרשומה נשארת, ננסה בסבב הבא
          continue;
        }
        if (!rec) { photoIndex.delete(cid); continue; }
        if (!photoIndex.has(cid)) continue;          // הוסרה בזמן הקריאה
        // הוסרה בלשונית אחרת לפני שנשלחה מכאן — לא שולחים. ⚠️ גם אחרי markSent:
        // ה-put שלו מחזיר לדיסק רשומה שהלשונית האחרת מחקה ברגע שבין הקריאה לכתיבה.
        if (removedElsewhere.has(cid)) { photoIndex.delete(cid); retryState.delete(rkey); continue; }
        await markSent(rec);
        if (removedElsewhere.has(cid)) { await deletePhotoRecord(cid); continue; }
        r = await attempt(
          rkey,
          { kind: "photo", visitId, itemId: p.itemId, clientId: cid },
          () => senders.photo(visitId, rec.itemId, cid, { mime: rec.mime, data: rec.data, thumb: rec.thumb }),
          {
            ack: async (res) => {
              const fileId = resultId(res);
              const u = readUndo();
              // ⚠️ הוסרה בזמן השליחה — כאן (ביטול קיים), בלשונית אחרת שהודיעה, או בלשונית
              // אחרת שעוד לא הודיעה (הרשומה כבר לא ב-IndexedDB). בכל אחד מהם: ביטול עם
              // ה-id, ולא "אושרה" — אחרת היא נשארת בשרת ונכנסת לביקור החתום.
              let gone = !!u[cid] || removedElsewhere.has(cid);
              if (!gone && !memPhotos.has(cid)) {
                try { gone = (await getPhotoRecord(cid)) == null; } catch { /* לא ידוע — נשארת "אושרה" */ }
              }
              if (gone) {
                const base = { visitId: String(visitId), itemId: String(rec.itemId), by: rec.by ?? owner, at: Date.now() };
                writeUndo({ ...readUndo(), [cid]: { ...base, ...(u[cid] || {}), fileId } });
              } else {
                recordAckPhoto(visitId, rec.itemId, cid, fileId, rec.thumb);
              }
              await deletePhotoRecord(cid);
            },
            discard: () => deletePhotoRecord(cid),
          },
          force,
          true,
        );
      } finally {
        inflight.delete(cid);
        removedElsewhere.delete(cid);
        // הוסרה בזמן השליחה: סימון ה-sent עלול היה להחזיר את הרשומה לדיסק
        if (hasUndo(cid)) await deletePhotoRecord(cid);
      }
      if (r === "stop") return;
      if (r === "error") failed = true;
    }

    for (const [cid, u] of Object.entries(readUndo())) {
      if (String(u.visitId) !== visitId || !isMine(u) || inflight.has(cid)) continue;
      const r = await attempt(
        undoKey(cid),
        { kind: "undo", visitId, itemId: String(u.itemId), clientId: cid },
        () => senders.photoUndo?.(visitId, u.itemId, cid, u.fileId ?? null),
        { ack: () => removeUndo(cid), discard: () => removeUndo(cid) },
        force,
      );
      if (r === "stop") return;
      if (r === "error") failed = true;
    }
  }
  if (!failed && retryState.size === 0) lastError = null;
}

// ⚠️ שתי לשוניות (PWA + דפדפן) חולקות את אותו אחסון. בלי נעילה שתיהן היו
// שולחות את אותן רשומות — תמונה עולה פעמיים, ווי וביטולו מתחרים ונוחתים
// בסדר הפוך. Web Locks עם ifAvailable: מי שלא קיבל את המנעול מדלג.
async function drainExclusive(senders, force) {
  let locks;
  try { locks = typeof navigator !== "undefined" ? navigator.locks : undefined; } catch { locks = undefined; }
  if (locks?.request) {
    try {
      return await locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
        if (lock) await drainOnce(senders, force);
      });
    } catch (err) {
      if (err?.name !== "SecurityError" && err?.name !== "NotSupportedError") throw err;
    }
  }
  return drainOnce(senders, force);
}

/**
 * ריקון סדרתי של כל התיבה. קריאה בזמן ריקון מחזירה את אותה הבטחה, ומסמנת
 * סבב נוסף — כך שינוי שנוסף באמצע אינו מחכה 15 שניות.
 * `{force:true}` — מתעלם מהשהיה ומתקיעה (כפתור "סנכרן עכשיו").
 */
export function drain(senders, { force = false } = {}) {
  if (draining) {
    rerun = true;
    return draining;
  }
  draining = (async () => {
    try {
      let rounds = 0;
      let f = force;
      do {
        rerun = false;
        await drainExclusive(senders, f);
        f = false;
        rounds++;
      } while (rerun && rounds < 3);
    } finally {
      draining = null;
      emit();
    }
  })();
  emit();
  return draining;
}

/** ריקון אוטומטי: חזרה לרשת, חזרה לדף, וכל 15 שניות. מחזיר פונקציית עצירה. */
export function startAutoDrain(senders, { intervalMs = 15_000 } = {}) {
  // ⚠️ refreshIndex ולא רק loadIndex: תמונה שלשונית אחרת הכניסה (ונהרגה לפני
  // ששלחה) נכנסת לאינדקס כאן — ונשלחת מכאן.
  const run = () => {
    refreshIndex()
      .then(() => (pendingCount() > 0 ? drain(senders) : undefined))
      .catch(() => {});
  };
  const wake = () => { wakeTimedOut(); run(); };
  const onVisible = () => {
    if (document.visibilityState === "visible") wake();
  };
  window.addEventListener("online", wake);
  document.addEventListener("visibilitychange", onVisible);
  const timer = setInterval(run, intervalMs);
  run();
  return () => {
    window.removeEventListener("online", wake);
    document.removeEventListener("visibilitychange", onVisible);
    clearInterval(timer);
  };
}
