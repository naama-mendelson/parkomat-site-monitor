// services/reportsLiveDirect.js — דיווח חדש, בזמן אמת.
//
// ============================================================
// ⚠️ ישירות על field_reports, ולא דרך events
// ============================================================
// `events` היא חוזה האירועים של המערכת, וזה היה נראה כמו המקום הנכון.
// אבל היא **קריאה לכל מאומת** — אירוע עליה היה מדליף לכל החברה שהוגש
// דיווח, ואת תוכנו אם היה נכנס למטען.
//
// המדיניות על `field_reports` היא "מנהלת, או שלי", ו-Realtime מכבד RLS:
// מנוי מקבל שורה **רק אם המדיניות מתירה לו לקרוא אותה**. כלומר הדחיפה
// מגיעה למי שצריך ולא לאחרים — בלי שום תנאי בקוד הזה.
//
// ⚠️ ולכן גם אין כאן בדיקת תפקיד. תנאי כזה היה **נראה** כמו הגנה בזמן
// שההגנה האמיתית היא המדיניות, והוא היה מסתיר את העובדה הזו מהקורא הבא.
import { supabase, isSupabaseConfigured } from "./supabase";

/**
 * מנוי לדיווחים חדשים.
 *
 * @param onReport (row) => void — נקרא לכל דיווח חדש שהמנוי רשאי לראות
 * @returns פונקציית ניתוק
 */
export function subscribeNewReports(onReport) {
  if (!isSupabaseConfigured) return () => {};

  const channel = supabase
    .channel("parkomat-field-reports")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "field_reports" },
      (msg) => {
        const row = msg?.new;
        if (row) onReport(row);
      },
    )
    .subscribe();

  return () => supabase.removeChannel(channel);
}
