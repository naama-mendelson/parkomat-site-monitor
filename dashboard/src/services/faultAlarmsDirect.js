// services/faultAlarmsDirect.js — התראות תקלה שממתינות לאישור.
//
// הטבלה נכתבת רק בצד המסד: טריגר על `events` פותח שורה על כל מעבר אל
// תקלה, ו-`ack_fault_alarms` מאשר. מכאן — קריאה, אישור ומנוי. ראה
// master/db/fault-alarms.postgres.sql.
import { supabase, isSupabaseConfigured } from "./supabase";

/** כמה ממתינות נטענות. החלון מציג חלק ומספר את השאר. */
const OPEN_LIMIT = 200;

export async function fetchOpenAlarmsDirect() {
  const { data, error } = await supabase
    .from("fault_alarms")
    .select("id, site_code, occurred_at, raised_at, fault_text")
    .is("acked_at", null)
    .order("id", { ascending: false })
    .limit(OPEN_LIMIT);
  if (error) throw new Error(`טעינת התראות התקלה נכשלה: ${error.message}`);
  return data ?? [];
}

/** @returns כמה אושרו עכשיו. 0 פירושו שמישהו אחר כבר אישר — לא שגיאה. */
export async function ackAlarmsDirect(ids, name) {
  const { data, error } = await supabase.rpc("ack_fault_alarms", { p_ids: ids, p_acked_by: name });
  if (error) throw new Error(error.message || "האישור נכשל");
  return data?.[0]?.acked ?? 0;
}

// ⚠️ **INSERT וגם UPDATE.** התראה חדשה היא INSERT (מהטריגר); אישור במסך
// אחר הוא UPDATE — ובלעדיו החלון היה נשאר פתוח כאן אחרי שמישהו כבר אישר.
// אין כאן בדיקת תפקיד: Realtime מכבד RLS, ומה שהמנוי מקבל הוא מה שמותר לו.
export function subscribeAlarmsDirect(onChange) {
  if (!isSupabaseConfigured) return () => {};
  const channel = supabase
    .channel("parkomat-fault-alarms")
    .on("postgres_changes", { event: "*", schema: "public", table: "fault_alarms" }, () => onChange())
    .subscribe();
  return () => supabase.removeChannel(channel);
}
