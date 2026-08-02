// services/auth.js — ה-seam של האימות בצד הלקוח.
//
// ============================================================
// למה יש seam גם כאן, ומה הוא כן ואינו מבטיח
// ============================================================
// בצד השרת ה-seam הוא אימות אסימון (auth/provider.js). בצד הלקוח הפעולה
// היא הפוכה: **הנפקה** — התחברות מול GoTrue, בדפדפן, כך שהשרת לא רואה
// סיסמה לעולם.
//
// מה שה-seam הזה מבטיח: כל המסכים קוראים ל-signIn/signOut/onAuthChange,
// ואף אחד מהם אינו יודע ש-Supabase קיים. החלפת ספק היא החלפת הקובץ הזה.
//
// מה שהוא **אינו** מבטיח, ואין טעם להעמיד פנים: זרימות שקיימות ב-GoTrue
// ולא נכתבו אצלנו — אישור אימייל, איפוס סיסמה, magic link. במעבר להתקנה
// עצמית הן ייכתבו, וזה מקבל־בהכרח ולא הפתעה. שם הפונקציות זהה; ההתנהגות
// מאחוריהן תהיה שלנו.

import { supabase, isSupabaseConfigured } from "./supabase";

/** { user, error } — user הוא null כשההתחברות נכשלה. */
export async function signIn(email, password) {
  if (!isSupabaseConfigured) {
    return { user: null, error: "האימות אינו מוגדר בדשבורד (חסר VITE_SUPABASE_URL)" };
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: String(email || "").trim(),
    password: String(password || ""),
  });

  if (error) {
    // ============================================================
    // הודעה אחת לשם שגוי ולסיסמה שגויה — בכוונה
    // ============================================================
    // "האימייל לא קיים" מגלה למי שמנחש אילו חשבונות קיימים. GoTrue מחזיר
    // כאן "Invalid login credentials" בשני המקרים, ואנחנו לא מפרקים אותה
    // לשני מקרים כדי "לעזור למשתמש".
    const generic = /invalid login credentials/i.test(error.message)
      ? "אימייל או סיסמה שגויים"
      : error.message;
    return { user: null, error: generic };
  }

  return { user: mapUser(data.user), error: null };
}

export async function signOut() {
  if (!isSupabaseConfigured) return;
  await supabase.auth.signOut();
}

/** אורך סיסמה מינימלי. נאכף גם ב-GoTrue; כאן כדי לומר זאת *לפני* סבב רשת. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * שינוי סיסמה. { error } — null בהצלחה.
 *
 * ============================================================
 * למה מאמתים את הסיסמה הנוכחית, למרות ש-Supabase אינו דורש זאת
 * ============================================================
 * updateUser({ password }) מצליח על סמך ה-session בלבד. במוצר הזה זו בעיה
 * ממשית ולא תיאורטית: הדשבורד רץ על **מסך משותף בחדר בקרה**, שנשאר מחובר
 * לאורך משמרות — זו בדיוק הסיבה שנוסף כפתור יציאה. בלי אימות, כל מי שעובר
 * ליד מסך פתוח יכול להחליף את הסיסמה ולנעל בחוץ את בעל החשבון.
 *
 * האימות נעשה בהתחברות מחדש עם הסיסמה הנוכחית. זה גם *הדרך היחידה* לדעת
 * שהיא נכונה — GoTrue אינו חושף נקודת קצה של "אמת סיסמה".
 *
 * ⚠️ התחברות מוצלחת **מחליפה את ה-session** באותו משתמש. זה תקין, ומכוון:
 * אם השינוי ייכשל בשלב הבא, המשתמש נשאר מחובר ולא נזרק החוצה באמצע.
 */
export async function changePassword(currentPassword, nextPassword) {
  if (!isSupabaseConfigured) return { error: "האימות אינו מוגדר בדשבורד" };

  const next = String(nextPassword || "");
  if (next.length < MIN_PASSWORD_LENGTH) {
    return { error: `הסיסמה החדשה צריכה ${MIN_PASSWORD_LENGTH} תווים לפחות` };
  }

  const { data } = await supabase.auth.getSession();
  const email = data.session?.user?.email;
  if (!email) return { error: "אין חיבור פעיל. יש להתחבר מחדש." };

  const { error: reauth } = await supabase.auth.signInWithPassword({
    email,
    password: String(currentPassword || ""),
  });
  if (reauth) {
    return /invalid login credentials/i.test(reauth.message)
      ? { error: "הסיסמה הנוכחית שגויה" }
      : { error: reauth.message };
  }

  const { error } = await supabase.auth.updateUser({ password: next });
  if (error) {
    // GoTrue דוחה סיסמה זהה לקודמת בהודעה באנגלית; מתרגמים את המקרה השכיח.
    return /should be different|same as the old/i.test(error.message)
      ? { error: "הסיסמה החדשה זהה לנוכחית" }
      : { error: error.message };
  }

  return { error: null };
}

/** ה-session הנוכחי, או null. נקרא בעלייה כדי לא לבקש התחברות מחדש. */
export async function currentUser() {
  if (!isSupabaseConfigured) return null;
  const { data } = await supabase.auth.getSession();
  return data.session ? mapUser(data.session.user) : null;
}

/**
 * מאזין לשינויי אימות. מחזיר פונקציית ביטול.
 *
 * נדרש ולא רק נוח: ה-session מתחדש לבד ברקע, ויכול גם לפוג. במסך קיר
 * שפתוח יומיים זה מה שמבדיל בין "התנתק והמסך ריק בשקט" לבין מסך התחברות.
 */
export function onAuthChange(callback) {
  if (!isSupabaseConfigured) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session ? mapUser(session.user) : null);
  });
  return () => data.subscription.unsubscribe();
}

// ============================================================
// התפקיד נקרא מ-app_metadata, ובאותו סדר כמו בשרת וב-SQL
// ============================================================
// Supabase מקנן את app_metadata ואינו משטח אותו לתביעה עליונה. שלוש
// השכבות — הדשבורד, auth/providers/supabase.js, ו-app.current_role() —
// חייבות לקרוא באותו סדר, אחרת אותו משתמש מקבל תפקיד אחד במסך ותפקיד אחר
// במדיניות ה-RLS. אי-התאמה כזו מתגלה רק כשמישהו רואה מה שאינו אמור.
//
// user_metadata אינו נקרא: המשתמש יכול לערוך אותו בעצמו.
function mapUser(u) {
  if (!u) return null;
  const role =
    u.app_metadata?.parkomat_role ||
    u.parkomat_role ||
    "operator";                    // ברירת מחדל שמרנית: צפייה בלבד
  return { id: u.id, email: u.email ?? null, role };
}
