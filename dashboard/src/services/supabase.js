// services/supabase.js — הלקוח היחיד. אף קומפוננטה לא מייבאת supabase-js.
//
// ============================================================
// למה הכול עובר דרך הקובץ הזה
// ============================================================
// זה ה-seam שמאפשר לעזוב את Supabase בעתיד בלי לגעת באף מסך. הכלל היחיד
// שצריך לשמור עליו: **אין import של supabase-js מחוץ ל-services/**. ברגע
// שקריאה כזו תופיע בקומפוננטה, ה-seam נעלם וההגירה הופכת לחיפוש.
//
// שכבת הגישה לנתונים (PostgREST) היא החלק הנייד: postgrest-js עובד מול כל
// PostgREST, ו-PostgREST הוא תוכנה עומדת בפני עצמה שרצה גם בהתקנה עצמית.
// זו הסיבה שהוא נבחר כשכבת הגישה מלכתחילה.
//
// ============================================================
// המפתח כאן הוא publishable, ואין בכך סוד
// ============================================================
// הוא נועד להיות חשוף בדפדפן. הוא אינו מעניק דבר מעבר למה ש-RLS מתיר —
// וההגנה היא המדיניות בבסיס הנתונים, לא סודיות המפתח. נבדק בפועל: קריאה
// עם המפתח הזה בלי אסימון משתמש מחזירה permission denied על טבלת sites.
//
// ⚠️ מפתח ה-Secret של הפרויקט אסור שיגיע לכאן בשום מצב — הוא עוקף RLS
// לחלוטין, כלומר גם חושף הכול וגם מסתיר באגי מדיניות עד יום ההגירה.

import { createClient } from "@supabase/supabase-js";

const URL = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

// חסרה הגדרה — כושל בקול ולא בשקט. דשבורד שמנסה לדבר עם undefined מייצר
// שגיאות רשת מבלבלות במקום להגיד מה חסר.
export const isSupabaseConfigured = Boolean(URL && KEY);

if (!isSupabaseConfigured) {
  console.error(
    "supabase: חסרים VITE_SUPABASE_URL או VITE_SUPABASE_PUBLISHABLE_KEY ב-dashboard/.env"
  );
}

export const supabase = isSupabaseConfigured
  ? createClient(URL, KEY, {
      auth: {
        // ה-session נשמר ב-localStorage ומתחדש לבד. במסך קיר שפתוח יומיים
        // זה מה שמונע התנתקות באמצע משמרת.
        persistSession: true,
        autoRefreshToken: true,
        // ============================================================
        // חייב להיות true מרגע שיש התחברות עם Google
        // ============================================================
        // היה false כשהייתה רק סיסמה. ב-OAuth הזרימה היא: יציאה ל-Google,
        // חזרה לכאן עם האסימון ב-fragment של ה-URL. עם false ה-SDK מתעלם
        // מה-fragment — כלומר החזרה "מצליחה", ה-URL נראה תקין, ואין session.
        // כשל שקט קלאסי: אין שגיאה, פשוט חוזרים למסך ההתחברות.
        detectSessionInUrl: true,
      },
    })
  : null;
