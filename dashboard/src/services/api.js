// services/api.js — כל הקריאות ל-REST API של ה-Master

const BASE = "/api";

// שליפת כל האתרים
export async function fetchSites() {
  const res = await fetch(`${BASE}/sites`);
  if (!res.ok) throw new Error("שגיאה בטעינת אתרים");
  return res.json();
}

// רישום אתר חדש — { code, site_name, plc_type?, plc_ip?, site_ip? }
// הרישום הוא השער לקליטה: ה-Master דוחה הודעות מאתר שאינו רשום, ולכן רק
// אחרי קריאה זו מתחיל המידע מהאתר להישמר. קוד האתר חייב להיות זהה ל-SiteId
// שמוגדר בסוכן שרץ באתר.
export async function registerSite(payload) {
  const res = await fetch(`${BASE}/sites`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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