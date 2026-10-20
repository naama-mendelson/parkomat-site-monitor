// services/vehiclesDirect.js — רכבי הטכנאים מאיתוראן (20/10/2026). קריאה אחת: public.vehicles_live_list.
//
// ⚠️ אין כאן פנייה לאיתוראן ואין טוקן: הסנכרון רץ ב-Supabase (pg_cron → Edge Function ituran-sync), והדפדפן קורא רק
// את הטבלה שהוא ממלא. סיסמת איתוראן אינה מגיעה לדפדפן לעולם.
import { supabase, isSupabaseConfigured } from "./supabase";

/** { vehicles: [...], sync: {last_ok_at, vehicles, last_error, last_error_at} | null, now } */
export async function fetchVehicles() {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");
  const { data, error } = await supabase.rpc("vehicles_live_list");
  if (error) throw new Error(error.message || "טעינת הרכבים נכשלה");
  return {
    vehicles: Array.isArray(data?.vehicles) ? data.vehicles : [],
    sync: data?.sync ?? null,
    now: data?.now ?? new Date().toISOString(),
  };
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
