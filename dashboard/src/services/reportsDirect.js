// services/reportsDirect.js — סימון דיווח כ**ניסוי**, ישירות ל-Supabase.
//
// ============================================================
// מה זה עושה, ובמילים של מי שביקש
// ============================================================
// "הקפצתי דלתות חניון כדי לבדוק שהמערכת עובדת, ועכשיו אני רוצה להסיר את
// זה מהסטטיסטיקה." הדיווח **נשאר** — הוא רק מסומן כניסוי, נושא את שם מי
// שניסה, ואינו נספר.
//
// ⚠️ **"ניסוי" ולא "בוטל", וזו לא בחירת מילים.** "בוטל" מתאר פעולה
// מנהלית; "ניסוי" מתאר מה קרה. מי שיקרא את הלוג בעוד חצי שנה צריך את
// השני.
//
// ============================================================
// ⚠️ מה **לא** נמצא כאן
// ============================================================
// הכלל שרק מנהל רשאי אינו בקובץ הזה אלא ב-`app.require_manager()` שבתוך
// הפונקציה ב-SQL. הסתרת הכפתור מבקר היא נוחות, לא הגנה — DevTools פתוח
// לכל אחד. ההסתרה קיימת מסיבה אחרת לגמרי: מסך שמציע פעולה שתיכשל ב-403
// הוא הדרך האמינה לגרום למישהו להסיק שהמערכת שבורה.
import { supabase, isSupabaseConfigured } from "./supabase";

/** שני הסוגים שהפונקציה ב-SQL מכירה. כל ערך אחר מוחזר משם כ-400. */
export const TEST_KINDS = { OPERATION: "operation", FAULT: "fault" };

function messageFor(error) {
  if (!error) return "שגיאה לא ידועה";
  // ⚠️ 42501 היא ההודעה של Postgres ("permission denied for function"), לא
  // שלנו — ומי שיראה אותה לא יבין שהמשמעות היא "אין לך הרשאה".
  if (error.code === "42501") return "הפעולה מותרת למנהלים בלבד";
  return error.message || "הפעולה נכשלה";
}

/**
 * מסמן דיווח כניסוי. `kind` הוא 'operation' או 'fault'.
 * זורק Error עם הודעה בעברית.
 */
export async function markAsTestDirect(kind, id, note = "") {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");

  const { data, error } = await supabase.rpc("mark_as_test", {
    p_kind: String(kind),
    p_id: Number(id),
    p_reason: note ? String(note) : null,
  });
  if (error) throw new Error(messageFor(error));

  // RETURNS TABLE מגיע כמערך גם על שורה אחת.
  const row = Array.isArray(data) ? data[0] : data;
  return {
    kind: row?.kind ?? kind,
    id: row?.id ?? id,
    markedAt: row?.excluded_at ?? null,
    markedBy: row?.excluded_by ?? null,
  };
}

/** מבטל את הסימון — הדיווח חוזר להיספר. */
export async function unmarkTestDirect(kind, id) {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");

  const { error } = await supabase.rpc("unmark_test", {
    p_kind: String(kind),
    p_id: Number(id),
  });
  if (error) throw new Error(messageFor(error));
  return { kind, id };
}

// ============================================================
// סיווג מחדש — תקלה שהייתה בעצם תחזוקה
// ============================================================
// ⚠️ **שכבה מעל, לא מחיקה.** `status` נשאר 'error' בבסיס הנתונים לנצח;
// `reclassified_to` מכסה עליו בקריאה. זו הדרישה המפורשת — לראות מה זה
// היה לפני ומי שינה — ו-UPDATE על השדה המקורי היה מוחק בדיוק את זה.
//
// ⚠️ ולכן זה **שונה מסימון ניסוי**: ניסוי מוציא אירוע מהספירה, סיווג
// מחדש מעביר אותו מעמודה לעמודה. תקלה שסווגה כתחזוקה עדיין מורידה
// זמינות — היא פשוט מפסיקה להיספר כתקלה. שתי פעולות, שתי משמעויות.
export async function reclassifyStatusDirect(id, to = "maintenance") {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");

  const { data, error } = await supabase.rpc("reclassify_status", {
    p_id: Number(id),
    p_to: to === null ? null : String(to),
  });
  if (error) throw new Error(messageFor(error));

  const row = Array.isArray(data) ? data[0] : data;
  return { id: row?.id ?? id, was: row?.was ?? null, now: row?.now_is ?? null, by: row?.by_name ?? null };
}
