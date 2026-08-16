// services/api.js — כל הקריאות ל-REST API של ה-Master

// ============================================================
// כתובת ה-API — יחסית בפיתוח, מוחלטת בפיצול לשני קונטיינרים
// ============================================================
// ⚠️ **"/api" עובד רק כששני הצדדים באותו origin.** היום זה המצב: בפיתוח
// דרך ה-proxy של Vite, ובייצור הישן השרת הגיש גם את הקבצים.
//
// ברגע שהדשבורד יושב ב-Apache (או באחסון החיצוני של החברה) והשרת בקונטיינר
// אחר, נתיב יחסי מפנה אל **שרת הקבצים** — שאין בו API בכלל. הכשל שקט
// לחלוטין: הדף נטען יפה, הנתונים פשוט לא מגיעים, וזה נראה כמו תקלת רשת.
//
// ⚠️ ריק נשאר "/api" בכוונה, ולא נופל לברירת מחדל כלשהי: כל ערך שננחש כאן
// היה נכון לסביבה אחת ושגוי בכל השאר. סביבה שצריכה כתובת מוחלטת אומרת
// אותה במפורש (VITE_API_BASE), וסביבה שלא — ממשיכה לעבוד כמו קודם.
//
// ⚠️ הערך נצרב בזמן **הבנייה** (Vite מחליף אותו בטקסט), ולכן הוא ARG
// ב-Dockerfile.web ולא משתנה סביבה בזמן ריצה.
export const API_ROOT = (import.meta.env?.VITE_API_BASE || "").replace(/\/+$/, "");
const BASE = `${API_ROOT}/api`;

// ==========================================================
// איחוד בקשות זהות שנמצאות באוויר (in-flight dedupe)
// ==========================================================
// אם שתי קומפוננטות מבקשות את אותו URL באותו רגע, אין שום סיבה לשלוח שתי
// בקשות — הן יקבלו את אותה תשובה בדיוק. במקום זה חולקים את אותו Promise.
//
// זה קורה יותר ממה שנדמה: React ב-StrictMode (מצב פיתוח) מריץ כל effect
// *פעמיים* בכוונה, ולכן כל שליפה נורית פעמיים. בלי האיחוד הזה, מספר
// הבקשות בפאנל הרשת של הדפדפן כפול מהאמת.
//
// הרשומה נמחקת ברגע שהבקשה נגמרה (גם בכשל), כדי שהתוצאה לא "תיתקע"
// במטמון — זה dedupe, לא cache.
const inFlight = new Map();

function getJSON(url, errorMessage) {
  const existing = inFlight.get(url);
  if (existing) return existing;

  // ============================================================
  // אסימון בכל קריאת קריאה — לא רק בנתיבי הניהול
  // ============================================================
  // ⚠️ **כל 11 הקריאות שעוברות כאן הן "דלת החירום"** — המסלול שרץ כש-
  // VITE_SUPABASE_DIRECT=false, כלומר הדרך חזרה מ-Supabase. מרגע שנתיבי
  // הקריאה בשרת מוגנים, שליחה בלי אסימון מחזירה 401 על כל אחת מהן.
  //
  // כלומר בלי השורות האלה ההגנה לא "מאבטחת את דלת החירום" — היא **סוגרת**
  // אותה. וזה היה מתגלה רק ביום שמישהו יהפוך את המתג, בלחץ, כשמשהו כבר
  // לא עובד.
  //
  // ⚠️ ה-dedupe נשאר לפי ה-URL ולא כולל את האסימון: יש משתמש אחד בכל
  // לשונית, ושתי בקשות לאותו URL הן אותה בקשה. מפתח שכולל אסימון היה
  // מבטל את האיחוד בלי שום תועלת.
  const promise = authHeaders()
    .then((headers) => fetch(url, { headers }))
    .then((res) => {
      if (!res.ok) throw new Error(errorMessage);
      return res.json();
    })
    .finally(() => {
      inFlight.delete(url);
    });

  inFlight.set(url, promise);
  return promise;
}

// חשוף לבדיקות בלבד — כמה בקשות נמצאות כרגע באוויר
export function _inFlightCount() {
  return inFlight.size;
}

// שליפת כל האתרים
export function fetchSites() {
  return getJSON(`${BASE}/sites`, "שגיאה בטעינת אתרים");
}

// ===== ניהול (admin) =====
// הקוד נשמר ב-sessionStorage: נמחק כשסוגרים את הלשונית, ולא נשאר על המחשב.
// ⚠️ זו איננה מערכת הרשאות — הקוד משותף ועובר בכל בקשה. הוא מונע טעויות, לא תוקף.
const ADMIN_KEY = "parkomat.adminCode";

export function getAdminCode() {
  try {
    return sessionStorage.getItem(ADMIN_KEY);
  } catch {
    return null;
  }
}

export function storeAdminCode(code) {
  try {
    if (code) sessionStorage.setItem(ADMIN_KEY, code);
    else sessionStorage.removeItem(ADMIN_KEY);
  } catch {
    /* אחסון חסום — מצב הניהול יחיה רק בזיכרון */
  }
}

// ============================================================
// כותרות עם אסימון המשתמש — לנתיבים שדורשים זהות אמיתית
// ============================================================
// שונה מ-adminHeaders: שם זה סוד משותף בלי זהות, וכאן זו זהות מאומתת.
// הזמנת משתמש דורשת את השנייה — אחרת אי אפשר לרשום *מי* הזמין, וזה כל
// מה שמאזן את העובדה שההזמנה פתוחה לכל מחובר.
async function authHeaders() {
  // import דינמי כדי שהמודול הזה לא ייגרר ל-supabase-js בכל טעינה.
  const { supabase } = await import("./supabase");
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * הזמנת משתמש חדש. פתוח לכל מי שמחובר.
 *
 * הסיסמה הזמנית מוחזרת **פעם אחת** ואינה נשמרת בשום מקום — המזמין מעביר
 * אותה למוזמן. הסיבה שזו יצירה עם סיסמה ולא הזמנה במייל היא ש-SMTP של
 * Supabase בברירת מחדל מוגבל לבודדים לשעה, ולעיתים רק לחברי הצוות — כלומר
 * מייל שנשלח ולא מגיע, בלי שגיאה. ראה master/auth/admin.js.
 */
export async function inviteUser(email, role = "operator") {
  const res = await fetch(`${BASE}/users/invite`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ email, role }),
  });
  if (!res.ok) await parseError(res, "הזמנת המשתמש נכשלה");
  return res.json();
}

/** מי כבר במערכת — כדי לא להזמין כפולים. */
export async function fetchUsers() {
  const res = await fetch(`${BASE}/users`, { headers: await authHeaders() });
  if (!res.ok) await parseError(res, "שגיאה בטעינת המשתמשים");
  return res.json();
}

// ============================================================
// השבתה והחזרה לפעילות — למנהלים בלבד (השרת אוכף)
// ============================================================
// ⚠️ **השבתה היא ההפיכה מבין השתיים, ולכן היא ברירת המחדל במסך.** היא
// מנתקת גישה ומשאירה את השורה, כך שאפשר להחזיר. מחיקה (`deleteUser`
// למטה) מסירה גם את המשתמש ב-Supabase ואי אפשר לחזור ממנה.
//
// ⚠️ והשרת מסרב להשבית את המנהל הפעיל האחרון ואת המבצע עצמו — ראה
// auth/deactivation.js. הכפתור כאן אינו מסתיר את המקרים האלה, הוא
// מציג את הסיבה שחוזרת: הסתרה ב-UI מלמדת שהכלל אינו קיים.
export async function setUserActive(id, isActive) {
  const res = await fetch(`${BASE}/users/${id}`, {
    method: "PATCH",
    headers: await authHeaders(),
    body: JSON.stringify({ is_active: isActive }),
  });
  if (!res.ok) await parseError(res, "עדכון המשתמש נכשל");
  return res.json();
}

// ⚠️ שדה אחד לכל בקשה — השרת דוחה שליחה של שניהם. חצי עדכון (התפקיד
// השתנה וההשבתה נדחתה) הוא מצב שאיש לא ביקש ואי אפשר להסביר.
export async function setUserRole(id, role) {
  const res = await fetch(`${BASE}/users/${id}`, {
    method: "PATCH",
    headers: await authHeaders(),
    body: JSON.stringify({ role }),
  });
  if (!res.ok) await parseError(res, "שינוי התפקיד נכשל");
  return res.json();
}

// ============================================================
// מחיקה מלאה — ובלתי הפיכה
// ============================================================
// ⚠️ מסירה גם את המשתמש ב-Supabase, ולכן אין "החזרה": מי שנמחק חוזר רק
// כהזמנה חדשה, עם מזהה חדש. השבתה (`setUserActive`) היא הפעולה ההפיכה,
// והיא זו שמתאימה לרוב המקרים.
//
// ⚠️ מה שנשאר: שורות הביקורת וחלונות התחזוקה שומרים **שם כטקסט** ולא
// הפניה, ולכן ההיסטוריה ממשיכה לומר מי עשה מה. זה מה שהופך את המחיקה
// לאפשרית מלכתחילה.
export async function deleteUser(id) {
  const res = await fetch(`${BASE}/users/${id}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });
  if (!res.ok) await parseError(res, "מחיקת המשתמש נכשלה");
  return res.json();
}
function adminHeaders() {
  const code = getAdminCode();
  return {
    "Content-Type": "application/json",
    ...(code ? { "x-admin-code": code } : {}),
  };
}

async function parseError(res, fallback) {
  const body = await res.json().catch(() => null);
  throw new Error(body?.error || fallback);
}

// ===== עוזר ה-AI — בהזרמה =====
//
// *לא* עובר דרך getJSON: זה POST, ואסור לו להשתתף בביטול-כפילויות (dedupe) של
// קריאות ה-GET — שתי שאלות זהות הן שתי שאלות, לא אחת.
//
// השרת מחזיר NDJSON: שורת JSON לכל נתח.
//   { t: "טקסט" }                    — נתח טקסט
//   { done: true, toolsUsed: [...] } — סיום
//   { error: "..." }                 — כשל *אחרי* שההזרמה כבר התחילה
//
// onToken נקרא לכל נתח, כדי שהתשובה תיכתב על המסך תוך כדי שהיא נוצרת.
export async function askAssistant(messages, onToken) {
  // ============================================================
  // ⚠️ אסימון — הנתיב הזה מוגן, בדיוק כמו נתיבי הקריאה
  // ============================================================
  // לעוזר שבעה כלים שקוראים מהמסד, ולכן הוא **ממשק קריאה בשפה חופשית**
  // לאותם נתונים. השארתו פתוח הייתה עוקפת את כל האבטחה בשורה אחת: מי
  // שנחסם מ-/api/sites פשוט שואל "תן לי את כל האתרים".
  //
  // ⚠️ וזה נשכח כאן כשהנתיב הוגן, כי הקריאה הזו **אינה עוברת דרך getJSON**
  // — היא מזרימה NDJSON ולכן היא fetch עצמאי. התוצאה: הבוט הפסיק לענות,
  // בלי שום קשר גלוי לשינוי שגרם לזה.
  const res = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ messages }),
  });

  // כשל *לפני* ההזרמה (503/400/429) — עדיין JSON רגיל
  if (!res.ok) await parseError(res, "העוזר לא זמין כרגע");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let text = "";
  let toolsUsed = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // חותכים רק על \n שלם — נתח רשת יכול להיחתך באמצע שורה,
    // ו-JSON.parse על חצי שורה זורק.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      if (msg.error) throw new Error(msg.error);
      if (msg.t) {
        text += msg.t;
        onToken?.(msg.t);
      }
      if (msg.done) toolsUsed = msg.toolsUsed || [];
    }
  }

  return { text, toolsUsed };
}

// בדיקת קוד מנהל (לפתיחת מצב ניהול)
export async function verifyAdminCode(code) {
  const res = await fetch(`${BASE}/admin/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) await parseError(res, "קוד מנהל שגוי");
  return res.json();
}

// שינוי קוד המנהל
export async function changeAdminCode(currentCode, newCode) {
  const res = await fetch(`${BASE}/admin/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentCode, newCode }),
  });
  if (!res.ok) await parseError(res, "שינוי הקוד נכשל");
  return res.json();
}

// עדכון אתר: שם ו/או קוד
export async function updateSite(code, payload) {
  const res = await fetch(`${BASE}/sites/${code}`, {
    method: "PATCH",
    headers: adminHeaders(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) await parseError(res, "עדכון האתר נכשל");
  return res.json();
}

// מחיקת אתר (וכל ההיסטוריה שלו)
export async function deleteSite(code) {
  const res = await fetch(`${BASE}/sites/${code}`, {
    method: "DELETE",
    headers: adminHeaders(),
  });
  if (!res.ok) await parseError(res, "מחיקת האתר נכשלה");
  return res.json();
}

// רישום אתר חדש — { code, site_name, plc_type?, tier? }
// הרישום הוא השער לקליטה: ה-Master דוחה הודעות מאתר שאינו רשום, ולכן רק
// אחרי קריאה זו מתחיל המידע מהאתר להישמר. קוד האתר חייב להיות זהה ל-SiteId
// שמוגדר בסוכן שרץ באתר.
export async function registerSite(payload) {
  const res = await fetch(`${BASE}/sites`, {
    method: "POST",
    headers: adminHeaders(),   // הוספת אתר היא פעולת ניהול — השרת דורש קוד
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    // ה-Master מחזיר { error: "..." } בעברית — מעבירים אותו כמו שהוא.
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || `רישום האתר נכשל (${res.status})`);
  }
  return res.json();
}

// שליפת אתר בודד + operations אחרונות
export function fetchSiteDetail(code) {
  return getJSON(`${BASE}/sites/${code}`, `אתר ${code} לא נמצא`);
}

// שליפת אנליטיקה לפי תקופה — period: week | month | year
export function fetchSiteAnalytics(code, period) {
  return getJSON(`${BASE}/sites/${code}/analytics?period=${period}`, "שגיאה בטעינת נתונים");
}

// שליפת סטטיסטיקה מעמיקה ("עוד מידע") — period: week | month | year
export function fetchSiteInsights(code, period) {
  return getJSON(`${BASE}/sites/${code}/insights?period=${period}`, "שגיאה בטעינת נתונים מורחבים");
}

// אותה סטטיסטיקה מעמיקה, אך מצרפת על *כל* האתרים (מנהל כללי → "כל האתרים")
export function fetchGlobalInsights(period) {
  return getJSON(`${BASE}/insights?period=${period}`, "שגיאה בטעינת נתוני כלל האתרים");
}

/**
 * לוג הפעילות, עם סינון ודפדוף — מסלול נפרד מ-insights.
 *
 * הלוג הגיע קודם רק כחלק מחבילת ה-insights, ולכן היה תקוע על עמוד אחד: כל
 * החלפת מסנן הייתה מושכת מחדש גם את המדדים, הגרפים וטבלת הכרטיסים. כאן
 * מושכים רשימה בלבד.
 *
 * @param code קוד אתר, או null ללוג המצרף (כל האתרים)
 * @param opts { period, filter, card, offset, limit }
 */
export function fetchActivityLog(code, { period = "week", filter = "all", card, offset = 0, limit = 300 } = {}) {
  const qs = new URLSearchParams({ period, filter, offset: String(offset), limit: String(limit) });
  // ⚠️ רק אם יש ערך: `card=` ריק היה מגיע כמחרוזת ריקה ומסנן לאפס שורות.
  if (card) qs.set("card", card);

  const url = code
    ? `${BASE}/sites/${code}/activity?${qs}`
    : `${BASE}/activity?${qs}`;
  return getJSON(url, "שגיאה בטעינת לוג הפעילות");
}

/**
 * דוח חודשי לטווח תאריכים חופשי.
 * @param code קוד אתר, או null לכל האתרים
 */
export function fetchMonthlyReport(code, from, to) {
  const qs = new URLSearchParams({ from, to });
  if (code) qs.set("site", code);
  return getJSON(`${BASE}/report/monthly?${qs}`, "שגיאה בהפקת הדוח");
}

// ===== ממשקי הניהול =====

/**
 * תמונה עסקית כוללת (מנהל כללי).
 * params יכול להכיל: period | from+to | sites[] | statuses[] | minFailureRate |
 *                    groupBy | granularity
 */
export function fetchExecutiveStats(params = {}) {
  const q = new URLSearchParams();

  if (params.from && params.to) {
    q.set("from", params.from);
    q.set("to", params.to);
  } else if (params.period) {
    q.set("period", params.period);
  }

  if (params.sites?.length) q.set("sites", params.sites.join(","));
  if (params.statuses?.length) q.set("statuses", params.statuses.join(","));
  if (params.minFailureRate > 0) q.set("minFailureRate", String(params.minFailureRate));
  if (params.groupBy) q.set("groupBy", params.groupBy);
  if (params.granularity) q.set("granularity", params.granularity);

  return getJSON(`${BASE}/stats/executive?${q.toString()}`, "שגיאה בטעינת נתוני ההנהלה");
}

// נתונים תפעוליים לכל האתרים (מנהל בקרה)
export function fetchSupervisorStats(period) {
  return getJSON(`${BASE}/stats/supervisor?period=${period}`, "שגיאה בטעינת הנתונים התפעוליים");
}

// שליפת סטטיסטיקות אתר
export function fetchSiteStats(code) {
  return getJSON(`${BASE}/sites/${code}/stats`, "שגיאה בטעינת סטטיסטיקות");
}

// בדיקת תחזוקה פעילה
export function fetchMaintenance(code) {
  return getJSON(`${BASE}/sites/${code}/maintenance`, "שגיאה בבדיקת תחזוקה");
}

// הפעלת תחזוקה — פעולה חופשית, ללא קוד מנהל (השרת פתח את המסלול במכוון).
// ============================================================
// תחזוקה — פעולת ניהול, ולכן עם קוד מנהל
// ============================================================
// שני הנתיבים האלה היו פתוחים לחלוטין בשרת. תחזוקה אינה תווית: היא
// מדכאת רישום תקלות לגמרי ומוחרגת ממכנה הזמינות, כלומר היא משתיקה אתר
// אמיתי עד 30 יום ומשנה מספרים בדוחות. עכשיו השרת דורש קוד מנהל
// (requireAdmin), ולכן הקריאות נושאות אותו.
//
// מי שכבר נכנס למצב ניהול לא ירגיש שינוי — הקוד שמור ו-adminHeaders
// מצרף אותו. מי שלא, יקבל 401 במקום להפעיל תחזוקה.
export async function startMaintenance(code, name, durationHours, reason = "") {
  const res = await fetch(`${BASE}/sites/${code}/maintenance`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ name, duration_hours: durationHours, reason }),
  });
  if (!res.ok) return parseError(res, "שגיאה בהפעלת תחזוקה");
  return res.json();
}

// ביטול תחזוקה — מוגן גם הוא: הוא מחזיר את האתר לספירת התקלות ולמכנה
// הזמינות, ולכן משנה מספרים בדיוק כמו ההפעלה.
export async function cancelMaintenance(code) {
  const res = await fetch(`${BASE}/sites/${code}/maintenance`, {
    method: "DELETE",
    headers: adminHeaders(),
  });
  if (!res.ok) return parseError(res, "שגיאה בביטול תחזוקה");
  return res.json();
}