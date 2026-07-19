// services/api.js — כל הקריאות ל-REST API של ה-Master

const BASE = "/api";

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

  const promise = fetch(url)
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
  const res = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

// רישום אתר חדש — { code, site_name, plc_type?, plc_ip?, site_ip? }
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
export async function startMaintenance(code, name, durationHours, reason = "") {
  const res = await fetch(`${BASE}/sites/${code}/maintenance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, duration_hours: durationHours, reason }),
  });
  if (!res.ok) return parseError(res, "שגיאה בהפעלת תחזוקה");
  return res.json();
}

// ביטול תחזוקה — פעולה חופשית, ללא קוד מנהל
export async function cancelMaintenance(code) {
  const res = await fetch(`${BASE}/sites/${code}/maintenance`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) return parseError(res, "שגיאה בביטול תחזוקה");
  return res.json();
}