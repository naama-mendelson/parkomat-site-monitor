// services/vehiclesDirect.js — רכבי הטכנאים מאיתוראן (20/10/2026). קריאה אחת: public.vehicles_live_list.
//
// ⚠️ אין כאן פנייה לאיתוראן ואין טוקן: הסנכרון רץ ב-Supabase (pg_cron → Edge Function ituran-sync), והדפדפן קורא רק
// את הטבלה שהוא ממלא. סיסמת איתוראן אינה מגיעה לדפדפן לעולם.
import { supabase, isSupabaseConfigured } from "./supabase";

/** { vehicles: [...], alerts: [...] | undefined, sync: {last_ok_at, vehicles, last_error, last_error_at} | null, now } */
export async function fetchVehicles() {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");
  const { data, error } = await supabase.rpc("vehicles_live_list");
  if (error) throw new Error(error.message || "טעינת הרכבים נכשלה");
  return {
    vehicles: Array.isArray(data?.vehicles) ? data.vehicles : [],
    // ⚠️ 21/10/2026: "צריכים טכנאי עכשיו". עד אז לא הועבר מכאן, והפס לא הופיע בייצור בכלל — הבדיקות בדפדפן החליפו את
    // השכבה הזו במוק שהחזיר אותו ישירות. undefined = מסד ישן בלי השדה (המסך בלי הפס, כמו קודם).
    alerts: Array.isArray(data?.alerts) ? data.alerts : undefined,
    sync: data?.sync ?? null,
    now: data?.now ?? new Date().toISOString(),
  };
}

// ⚠️ "רכבים ברשימה" (fetchFleet / saveFleet) הוחלף ב-22/10/2026 ב"ניהול טכנאים" — מנהל בלבד, טכנאי = שם + רכב.

const need = () => { if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד"); };

/** ניהול הטכנאים (מנהל בלבד): { techs: [{plate, nickname, in_ituran, tech_id, name, phone, open_task}], available: [{plate, nickname}] } */
export async function fetchRoster() {
  need();
  const { data, error } = await supabase.rpc("tech_roster");
  if (error) throw new Error(error.message || "טעינת רשימת הטכנאים נכשלה");
  return {
    techs: Array.isArray(data?.techs) ? data.techs : [],
    available: Array.isArray(data?.available) ? data.available : [],
  };
}

/** הוספת טכנאי (שם + רכב) או שינוי שם. { tech_id, changed, created, renamed, linked, shown_added } */
export async function saveRosterTech(plate, name) {
  need();
  const { data, error } = await supabase.rpc("tech_roster_set", { p_plate: plate, p_name: name });
  if (error) throw new Error(error.message || "השמירה נכשלה");
  return data;
}

/** הסרת טכנאי: יוצא מהרשימה ומושבת (ההיסטוריה נשמרת). { changed, tech_id } */
export async function removeRosterTech(plate) {
  need();
  const { data, error } = await supabase.rpc("tech_roster_remove", { p_plate: plate });
  if (error) throw new Error(error.message || "ההסרה נכשלה");
  return data;
}

/** דוח הטכנאים לתקופה (22/10/2026). from / to = ימים בישראל, 'YYYY-MM-DD'. { from, to, first_day, team, techs } */
export async function fetchTechStats(from, to) {
  need();
  const { data, error } = await supabase.rpc("tech_stats", { p_from: from, p_to: to });
  if (error) throw new Error(error.message || "טעינת הסטטיסטיקה נכשלה");
  return { ...data, techs: Array.isArray(data?.techs) ? data.techs : [] };
}

/** טכנאי אחד לתקופה: { plate, tech, nickname, days, visits, visits_total, sites } */
export async function fetchTechHistory(plate, from, to) {
  need();
  const { data, error } = await supabase.rpc("tech_history", { p_plate: plate, p_from: from, p_to: to });
  if (error) throw new Error(error.message || "טעינת ההיסטוריה נכשלה");
  return {
    ...data,
    days: Array.isArray(data?.days) ? data.days : [],
    visits: Array.isArray(data?.visits) ? data.visits : [],
    sites: Array.isArray(data?.sites) ? data.sites : [],
  };
}

/** לפי אתר לתקופה: [{code, name, visits, tech_count, total_s, avg_s, max_s, last, techs: [...]}] */
export async function fetchSiteVisitStats(from, to) {
  need();
  const { data, error } = await supabase.rpc("site_visit_stats", { p_from: from, p_to: to });
  if (error) throw new Error(error.message || "טעינת הסטטיסטיקה לפי אתר נכשלה");
  return Array.isArray(data) ? data : [];
}

/** כל האתרים עם המיקום שלהם (20/10/2026): [{code, name, monitored, lat, lon, source, precision, set_at, set_by}]. */
export async function fetchSiteLocations() {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");
  const { data, error } = await supabase.rpc("site_locations_list");
  if (error) throw new Error(error.message || "טעינת מיקומי האתרים נכשלה");
  return Array.isArray(data) ? data : [];
}

/**
 * עורך מסמן או מאשר מיקום של אתר (מקור "ידני"). lat/lon null = ניקוי. expectedAt = geo_set_at שהמסך ראה ('' כשלא היה):
 * מסך ישן מקבל שגיאה במקום לדרוס סימון של מישהו אחר. כל המפתחות נשלחים במפורש — PostgREST בוחר פונקציה לפי המפתחות.
 */
export async function saveSiteLocation(code, lat, lon, expectedAt) {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");
  const { data, error } = await supabase.rpc("site_geo_set", {
    p_code: code, p_lat: lat ?? null, p_lon: lon ?? null, p_expected_at: expectedAt ?? null,
  });
  if (error) throw new Error(error.message || "שמירת המיקום נכשלה");
  return data;
}
