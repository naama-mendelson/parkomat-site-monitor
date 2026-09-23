// services/trafficLightDirect.js — לוח הרמזור, מול Supabase ישירות.
//
// ⚠️ **הכלל "מנהלים בלבד" אינו כאן.** הוא ב-`app.require_manager()` שבתוך
// כל פונקציה, שקוראת את התפקיד **מהטבלה** ולא מהאסימון. קוד המנהל שהמסך
// מבקש הוא נוחות ותו לא — מנהל שהודח לפני חמש דקות לא יוכל לכתוב גם אם
// הוא זוכר את הקוד. אותו דפוס בדיוק כמו ניהול האתרים.
//
// ⚠️ **ואין כאן זרוע שרת.** `master` מגיש שתי נתיבות ומעולם לא ידע על
// הלוח הזה, ולכן אין למה ליפול חזרה.
import { supabase } from "./supabase";

// ============================================================
// ⚠️ הלוח הוא ארגומנט, וברירת המחדל היא הרובוטי
// ============================================================
// יש שני דשבורדים באותן טבלאות — "רמזור רובוטי" ו"רמזור מכפילים" —
// והם מוחלפים בטאב בתוך אותו מסך. ברירת המחדל כאן אינה נוחות: היא מה
// שמאפשר לקוד ישן שאינו מעביר לוח להמשיך לעבוד בדיוק כמו קודם, בדיוק
// כמו `DEFAULT 'robotic'` בצד ה-SQL.
//
// ⚠️ **ולכן הסדר הבטוח הוא SQL קודם ואז הדשבורד.** דשבורד חדש שמעביר
// ‏`p_board` אל SQL ישן מקבל שגיאה על ארגומנט שאינו קיים; הכיוון ההפוך
// עובד. פריסה בסדר ההפוך פירושה לוח ריק לכל מי שפתח את המסך.
const ROBOTIC = "robotic";


function fail(error, what) {
  if (error) throw new Error(`${what}: ${error.message}`);
}

/** הלוח כולו — עמודות ושורות בקריאה אחת. */
export async function fetchBoard(board = ROBOTIC) {
  const { data, error } = await supabase.rpc("tl_board", { p_board: board });
  fail(error, "טעינת הלוח נכשלה");
  return {
    // ⚠️ הלוח חוזר מהשרת ולא נלקח מהבקשה: כך מסך שהחליף טאב באמצע
    // שליפה יכול לזהות תשובה שהגיעה מאוחר ושייכת ללוח הקודם.
    board: data?.board ?? board,
    columns: data?.columns ?? [],
    rows: data?.rows ?? [],
  };
}

export async function addColumn(label, kind = "text", options = [], board = ROBOTIC) {
  const { data, error } = await supabase.rpc("tl_add_column", {
    p_label: label,
    p_kind: kind,
    p_options: options,
    p_board: board,
  });
  fail(error, "הוספת עמודה נכשלה");
  return data;
}

/**
 * ⚠️ רק מה שהשתנה נשלח. השרת עושה `COALESCE` על כל שדה, ולכן שינוי
 * רוחב אינו יכול לדרוס בטעות את רשימת האפשרויות.
 */
export async function updateColumn(id, patch) {
  const { error } = await supabase.rpc("tl_update_column", {
    p_id: id,
    p_label: patch.label ?? null,
    p_kind: patch.kind ?? null,
    p_options: patch.options ?? null,
    p_width: patch.width ?? null,
  });
  fail(error, "עדכון העמודה נכשל");
}

export async function deleteColumn(id) {
  const { error } = await supabase.rpc("tl_delete_column", { p_id: id });
  fail(error, "מחיקת העמודה נכשלה");
}

export async function moveColumn(id, position) {
  const { error } = await supabase.rpc("tl_move_column", { p_id: id, p_position: position });
  fail(error, "הזזת העמודה נכשלה");
}

export async function addRow(after = null, board = ROBOTIC) {
  const { data, error } = await supabase.rpc("tl_add_row", { p_after: after, p_board: board });
  fail(error, "הוספת שורה נכשלה");
  return data;
}

export async function deleteRow(id) {
  const { error } = await supabase.rpc("tl_delete_row", { p_id: id });
  fail(error, "מחיקת השורה נכשלה");
}

export async function moveRow(id, position) {
  const { error } = await supabase.rpc("tl_move_row", { p_id: id, p_position: position });
  fail(error, "הזזת השורה נכשלה");
}

/**
 * תא בודד.
 *
 * ⚠️ **תא ולא שורה**, כדי ששני עורכים בו-זמנית לא ימחקו זה את זה: שליחת
 * השורה כולה הופכת כל שמירה לדריסה של מה שהאחר כתב בתא אחר.
 */
export async function setCell(rowId, key, value) {
  const { error } = await supabase.rpc("tl_set_cell", {
    p_row: rowId,
    p_key: key,
    // ⚠️ `null` מוחק את המפתח בצד השרת — כך תא שנוקה אינו משאיר
    // מחרוזת ריקה ב-JSONB.
    p_value: value === "" || value === null || value === undefined ? null : value,
  });
  fail(error, "שמירת התא נכשלה");
}

/**
 * הדבקה של כמה שורות בבת אחת.
 *
 * ⚠️ מילוי לוח של 40 שורות דרך `setCell` הוא מאות קריאות רשת. זו הדרך
 * שבה הלוח באמת ימולא, ולכן היא קריאה אחת.
 */
export async function pasteRows(rows, board = ROBOTIC) {
  const { data, error } = await supabase.rpc("tl_paste_rows", { p_rows: rows, p_board: board });
  fail(error, "ההדבקה נכשלה");
  return data;
}
