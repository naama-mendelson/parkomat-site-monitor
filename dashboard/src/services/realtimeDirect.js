// services/realtimeDirect.js — עדכונים חיים מ-Supabase Realtime, במקום SSE.
//
// ============================================================
// זה הפער האחרון בתמונה, והוא היה החשוב מכולם
// ============================================================
// כל הקריאות עברו ל-Supabase — אבל הדשבורד עדיין החזיק **חיבור פתוח לשרת**
// (`new EventSource("/api/stream")`). כל עוד הוא קיים, "הדשבורד מדבר רק עם
// Supabase" אינו נכון: יש ערוץ חי, קבוע, שתלוי בכך שהשרת חי ונגיש מהדפדפן.
//
// ============================================================
// למה זה החלפת קורא ולא כתיבה מחדש
// ============================================================
// `events` היא **חוזה האירועים ולא התעבורה** — השרת כותב אליה שורה לכל אירוע
// סמנטי דרך bus.publish, ואותה מטענה בדיוק היא מה ש-SSE שידר. כלומר יש שני
// קוראים לאותה טבלה, ולא שני מנגנונים:
//
//     SSE       — השרת קורא את מה שהוא עצמו פרסם ודוחף ללקוח   (זרוע ב')
//     Realtime  — הדפדפן מנוי ישירות על ה-INSERT               (זרוע א')
//
// ⚠️ ולכן ה-SSE **לא נמחק**. VITE_SUPABASE_DIRECT=false מחזיר אליו, והוא
// חייב להישאר עובד.
//
// ============================================================
// מה Realtime נותן ש-SSE לא, ומה הוא לוקח
// ============================================================
// **נותן:** אין תלות בזמינות השרת מהדפדפן.
//
// **לוקח — וזו נקודה שצריך להכיר:** ל-SSE ולו כאחד אין מסירה חוזרת. הודעה
// שנשלחת בזמן שהלקוח מנותק פשוט אבדה. לכן `onReconnect` נשאר קריטי בשני
// המצבים: בחזרה מנתק שולפים מחדש ולא מסתמכים על "מה שהתפספס יגיע".
//
// זו בדיוק הסיבה ש-`events` נושאת `id` מונוטוני — replay אפשרי. הוא ממומש
// בשרת (`GET /api/stream/since`) ואינו מנוצל כאן; שליפה מלאה בחזרה מנתק
// פשוטה יותר ואינה תלויה בשמירת הסמן האחרון בין רענוני דף.

import { supabase, isSupabaseConfigured } from "./supabase";

/**
 * מנוי לעדכונים חיים.
 *
 * @param onUpdate    (payload) => void — אותה מטענה בדיוק ש-SSE מסר
 * @param onReconnect () => void — נקרא כשהערוץ חוזר אחרי נתק
 * @returns פונקציית ניתוק
 */
export function subscribeRealtime(onUpdate, onReconnect) {
  if (!isSupabaseConfigured) {
    console.warn("realtime: Supabase אינו מוגדר — אין עדכונים חיים");
    return () => {};
  }

  // ⚠️ הדגל הזה הוא מה שמונע שליפה מיותרת בטעינה הראשונה: המנוי הראשון
  // מדווח 'SUBSCRIBED' מיד, והרשימה בדיוק נטענה. רק חיבור **אחרי נתק** הוא
  // סיבה לסגור פער. אותו שיקול בדיוק כמו sawDisconnect ב-useSSE.
  let sawDisconnect = false;

  const channel = supabase
    .channel("parkomat-events")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "events" },
      (msg) => {
        // ⚠️ payload היא עמודת JSONB, ולכן היא כבר אובייקט — לא מחרוזת.
        // JSON.parse עליה (כמו ב-SSE) היה זורק על כל אירוע.
        const body = msg?.new?.payload;
        if (body) onUpdate(body);
      }
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        if (!sawDisconnect) return;
        sawDisconnect = false;
        console.info("Realtime reconnected — refetching to close the gap.");
        onReconnect?.();
        return;
      }
      // CHANNEL_ERROR / TIMED_OUT / CLOSED — supabase-js מתחבר מחדש לבד,
      // ואנחנו רק זוכרים שהיה פער כדי לסגור אותו כשהוא יחזור.
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        sawDisconnect = true;
        console.warn(`Realtime ${status} — reconnecting automatically...`);
      }
    });

  return () => supabase.removeChannel(channel);
}
