// services/reloadDirect.js — רענון יזום לכל מי שפתוח.
//
// ============================================================
// ⚠️ מה זה **לא** יכול לעשות
// ============================================================
// הקוד הזה מגיע רק לדפדפנים שכבר טענו אותו. טאב שפתוח מאתמול מריץ את
// הגרסה של אתמול, ואין בה מאזין — כלומר **אי אפשר לרענן אותו מרחוק**,
// בשום דרך. זו מגבלה ולא החלטה: הרענון הראשון תמיד ידני.
//
// מהפריסה הבאה והלאה זה עובד: כל מי שמחובר יקבל את האירוע ויטען מחדש.
import { supabase, isSupabaseConfigured } from "./supabase";

/**
 * מנוי לפקודת רענון.
 *
 * ⚠️ דרך `events` ולא ערוץ משלו: זו טבלת חוזה האירועים, כל דשבורד כבר
 * מנוי עליה, ואירוע רענון אינו סוד — אין כאן מה להדליף.
 *
 * @returns פונקציית ניתוק
 */
export function subscribeReload(onReload) {
  if (!isSupabaseConfigured) return () => {};

  const channel = supabase
    .channel("parkomat-reload")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "events", filter: "type=eq.reload" },
      (msg) => {
        // ⚠️ מתעלמים מאירועים ישנים: מנוי שנפתח אחרי נתק עלול לקבל שורה
        // מלפני שעה, ואז הדף היה נטען מחדש בלי שאיש ביקש. שתי דקות הן
        // חלון נדיב לרשת איטית וצר מדי כדי לתפוס אירוע של אתמול.
        const at = msg?.new?.created_at;
        if (at && Date.now() - Date.parse(at) > 2 * 60_000) return;
        onReload(msg?.new?.payload ?? {});
      },
    )
    .subscribe();

  return () => supabase.removeChannel(channel);
}

/** שולח פקודת רענון לכולם. מנהלת בלבד — נאכף ב-RPC, לא כאן. */
export async function broadcastReload() {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");
  const { error } = await supabase.rpc("broadcast_reload");
  if (error) throw new Error(error.message || "השליחה נכשלה");
}
