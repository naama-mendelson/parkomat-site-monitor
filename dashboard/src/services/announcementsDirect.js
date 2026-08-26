// services/announcementsDirect.js — הודעות מערכת.
//
// ============================================================
// ⚠️ ההודעות עברו מהקוד למסד, וזה שינוי מהותי
// ============================================================
// בגרסה הראשונה הן היו מערך קבוע כאן: הודעה חדשה = שינוי קוד ופריסה. זה
// הספיק להכרזה אחת — ומרגע שהמנהלת רוצה לכתוב בעצמה, זה הופך את היכולת
// לבלתי שמישה, כי היא תלויה במפתח.
//
// ⚠️ ההצטלבות "מה כבר ראיתי" נעשית **ב-SQL ולא כאן**. שליחת כל ההודעות
// ללקוח כדי שיסנן בעצמו הייתה עובדת, אבל היא גדלה בלי גבול עם השנים —
// ומי שנכנס בפעם הראשונה היה מקבל את כל ההיסטוריה ורואה אותה אחת-אחת.
import { supabase, isSupabaseConfigured } from "./supabase";

/**
 * ההודעה הראשונה שהמשתמש הנוכחי טרם ראה, או null.
 *
 * ⚠️ דרך RPC ולא `select` על app_users: הטבלה קריאה לכל מחובר, ולכן
 * `.select().limit(1)` מחזיר את השורה הראשונה בטבלה ולא את שלי. אותו באג
 * נפל פעם ב-pushDirect; שם הוא הופיע כ-403, וכאן הוא היה **שקט לגמרי** —
 * ההודעה פשוט לא הייתה קופצת למי שמישהו אחר כבר סגר.
 */
export async function pendingAnnouncement() {
  if (!isSupabaseConfigured) return null;

  const { data, error } = await supabase.rpc("pending_announcement");
  // ⚠️ שגיאה כאן **אינה** מציגה הודעה. הצגה בכל פעם שהרשת מגמגמת היא
  // בדיוק מה שהופך הודעה חד-פעמית למטרד — ועדיף לפספס פעם אחת מאשר
  // לקפוץ שוב ושוב למי שכבר סגר.
  if (error) return null;

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  // ⚠️ המפתח הנשמר הוא **המזהה כמחרוזת**, כדי שיחיה לצד מפתחות ישנים
  // מהקוד באותה עמודה בלי מיגרציה של נתונים.
  return { key: String(row.id), title: row.title, body: row.body, createdAt: row.created_at };
}

/** "ראיתי" — לא יוצג שוב, בשום מכשיר. */
export async function markAnnouncementSeen(key) {
  if (!isSupabaseConfigured) return;
  const { error } = await supabase.rpc("mark_announcement_seen", { p_key: String(key) });
  if (error) throw new Error(error.message || "השמירה נכשלה");
}

export const MAX_TITLE = 120;
export const MAX_ANN_BODY = 2000;

/**
 * פרסום הודעת מערכת. מנהלת בלבד — נאכף ב-RPC, לא כאן.
 *
 * ⚠️ ההודעה קופצת על המסך של **כל** מי שנכנס ועוצרת אותו עד שילחץ. זו
 * הפרעה יזומה לכל החברה, ולא הערה בפינה — ולכן היא מוגבלת למנהלת.
 */
export async function publishAnnouncement({ title, body }) {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");

  const { data, error } = await supabase.rpc("publish_announcement", {
    p_title: String(title ?? "").trim(),
    p_body: String(body ?? "").trim(),
  });
  if (error) throw new Error(error.message || "הפרסום נכשל");

  const row = Array.isArray(data) ? data[0] : data;
  return { id: row?.id ?? null };
}

/** ההודעות שפורסמו — למסך הניהול. RLS מתירה קריאה לכל מאומת. */
export async function fetchAnnouncements(limit = 30) {
  if (!isSupabaseConfigured) return [];
  const { data, error } = await supabase
    .from("announcements")
    .select("id, title, body, created_by, created_at, is_active")
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message || "השליפה נכשלה");
  return data || [];
}
