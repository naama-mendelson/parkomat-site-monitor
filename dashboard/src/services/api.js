// services/api.js — כל הקריאות ל-REST API של ה-Master

const BASE = "/api";

// שליפת כל האתרים
export async function fetchSites() {
  const res = await fetch(`${BASE}/sites`);
  if (!res.ok) throw new Error("שגיאה בטעינת אתרים");
  return res.json();
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
export async function fetchSiteDetail(code) {
  const res = await fetch(`${BASE}/sites/${code}`);
  if (!res.ok) throw new Error(`אתר ${code} לא נמצא`);
  return res.json();
}

// שליפת אנליטיקה לפי תקופה — period: week | month | year
export async function fetchSiteAnalytics(code, period) {
  const res = await fetch(`${BASE}/sites/${code}/analytics?period=${period}`);
  if (!res.ok) throw new Error("שגיאה בטעינת נתונים");
  return res.json();
}

// שליפת סטטיסטיקה מעמיקה ("עוד מידע") — period: week | month | year
export async function fetchSiteInsights(code, period) {
  const res = await fetch(`${BASE}/sites/${code}/insights?period=${period}`);
  if (!res.ok) throw new Error("שגיאה בטעינת נתונים מורחבים");
  return res.json();
}

// ===== ממשקי הניהול =====

/**
 * תמונה עסקית כוללת (מנהל כללי).
 * params יכול להכיל: period | from+to | sites[] | statuses[] | minFailureRate |
 *                    groupBy | granularity
 */
export async function fetchExecutiveStats(params = {}) {
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

  const res = await fetch(`${BASE}/stats/executive?${q.toString()}`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "שגיאה בטעינת נתוני ההנהלה");
  }
  return res.json();
}

// נתונים תפעוליים לכל האתרים (מנהל בקרה)
export async function fetchSupervisorStats(period) {
  const res = await fetch(`${BASE}/stats/supervisor?period=${period}`);
  if (!res.ok) throw new Error("שגיאה בטעינת הנתונים התפעוליים");
  return res.json();
}

// שליפת סטטיסטיקות אתר
export async function fetchSiteStats(code) {
  const res = await fetch(`${BASE}/sites/${code}/stats`);
  if (!res.ok) throw new Error("שגיאה בטעינת סטטיסטיקות");
  return res.json();
}

// בדיקת תחזוקה פעילה
export async function fetchMaintenance(code) {
  const res = await fetch(`${BASE}/sites/${code}/maintenance`);
  if (!res.ok) throw new Error("שגיאה בבדיקת תחזוקה");
  return res.json();
}

// הפעלת תחזוקה
export async function startMaintenance(code, name, durationHours, reason = "") {
  const res = await fetch(`${BASE}/sites/${code}/maintenance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, duration_hours: durationHours, reason }),
  });
  if (!res.ok) throw new Error("שגיאה בהפעלת תחזוקה");
  return res.json();
}

// ביטול תחזוקה
export async function cancelMaintenance(code) {
  const res = await fetch(`${BASE}/sites/${code}/maintenance`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("שגיאה בביטול תחזוקה");
  return res.json();
}