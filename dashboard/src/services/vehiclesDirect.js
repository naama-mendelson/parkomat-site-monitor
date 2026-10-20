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
