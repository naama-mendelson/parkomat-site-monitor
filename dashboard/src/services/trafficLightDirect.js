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

function fail(error, what) {
  if (error) throw new Error(`${what}: ${error.message}`);
}

/** הלוח כולו — עמודות ושורות בקריאה אחת. */
export async function fetchBoard() {
  const { data, error } = await supabase.rpc("tl_board");
  fail(error, "טעינת הלוח נכשלה");
  return {
    columns: data?.columns ?? [],
    rows: data?.rows ?? [],
  };
}

export async function addColumn(label, kind = "text", options = []) {
  const { data, error } = await supabase.rpc("tl_add_column", {
    p_label: label,
    p_kind: kind,
    p_options: options,
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

export async function addRow(after = null) {
  const { data, error } = await supabase.rpc("tl_add_row", { p_after: after });
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
export async function pasteRows(rows) {
  const { data, error } = await supabase.rpc("tl_paste_rows", { p_rows: rows });
  fail(error, "ההדבקה נכשלה");
  return data;
}
