// services/announcementsDirect.js — הכרזות חד-פעמיות.
//
// ============================================================
// ההכרזה עצמה חיה בקוד, ורק "מי כבר ראה" חי במסד
// ============================================================
// אין כאן מודל תוכן ואין מסך ניהול. הכרזה חדשה = ערך חדש ברשימה למטה
// ופריסה — וזה נכון, כי הטקסט ממילא נכתב על ידי מי שמפרס.
//
// ⚠️ **המפתח לעולם אינו חוזר בשימוש.** מי שראה `field-reports-v1` לא
// יראה אותו שוב לנצח; שינוי הטקסט תחת אותו מפתח פירושו הכרזה שאיש לא
// יראה. הכרזה חדשה מקבלת מפתח חדש, תמיד.
import { supabase, isSupabaseConfigured } from "./supabase";

/**
 * ההכרזות הפעילות, מהחדשה לישנה. `key` נשמר במסד; השאר מוצג.
 */
export const ANNOUNCEMENTS = [
  {
    key: "field-reports-v1",
    title: "חדש: דיווח מהשטח",
    // ⚠️ בלי "מגיע להנהלה": מי שמדווח על דלת שמרעישה אינו צריך לדעת
    // למי זה נוסע, והמשפט הזה קורא כמו הודעה מלמעלה. מה שכן חשוב לומר
    // הוא **מה לעשות** ואיפה הכפתור.
    body:
      "אפשר עכשיו לשלוח דיווח על תקלה או ממצא ישירות מהדשבורד — " +
      "כולל צילומי מסך.\n\n" +
      "הכפתור 📮 בשורה העליונה. ממלאים שם, כותבים מה ראיתם, " +
      "וגוררים תמונה לתוך הטופס אם יש.",
  },
];

/**
 * ההכרזה הראשונה שהמשתמש הנוכחי טרם ראה, או null.
 *
 * ⚠️ דרך RPC ולא `select` על app_users: הטבלה קריאה לכל מחובר, ולכן
 * `.select().limit(1)` מחזיר את השורה הראשונה בטבלה ולא את שלי. אותו באג
 * נפל פעם ב-pushDirect; שם הוא הופיע כ-403, וכאן הוא היה שקט לגמרי —
 * ההכרזה פשוט לא הייתה קופצת למי שמישהו אחר כבר סגר.
 */
export async function pendingAnnouncement() {
  if (!isSupabaseConfigured) return null;

  const { data, error } = await supabase.rpc("my_seen_announcements");
  // ⚠️ שגיאה כאן **אינה** מציגה את ההכרזה. הצגה בכל פעם שהרשת מגמגמת היא
  // בדיוק מה שהופך הכרזה חד-פעמית למטרד — ועדיף לפספס פעם אחת מאשר
  // לקפוץ שוב ושוב למי שכבר סגר.
  if (error) return null;

  const row = Array.isArray(data) ? data[0] : data;
  const seen = new Set(row?.seen ?? row?.seen_announcements ?? []);
  return ANNOUNCEMENTS.find((a) => !seen.has(a.key)) ?? null;
}

/** "ראיתי" — לא יוצג שוב, בשום מכשיר. */
export async function markAnnouncementSeen(key) {
  if (!isSupabaseConfigured) return;
  const { error } = await supabase.rpc("mark_announcement_seen", { p_key: key });
  if (error) throw new Error(error.message || "השמירה נכשלה");
}
