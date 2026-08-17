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

// ============================================================
// ⚠️ אין כאן sendMagicLink, ואין requestPasswordReset — הוסרו במכוון
// ============================================================
// שתיהן היו בנויות ועבדו, והוסרו בהחלטת מוצר: **הכניסה היא בסיסמה בלבד.**
//
// ⚠️ הסיבה מעשית ולא עקרונית. בלי SMTP מוגדר, Supabase נופל למיילר
// המובנה שלו — מוגבל לכמה מיילים בשעה, **ושולח רק לחברי הפרויקט**. נמדד:
// `429 over_email_send_rate_limit` על הבקשה הראשונה. כלומר הכפתורים
// הבטיחו מייל שלא היה מגיע, והמשתמש היה ממתין וממתין.
//
// ⚠️ **מה שנשאר, ולמה:** `setNewPassword` ו-`onPasswordRecovery` למטה
// **לא** הוסרו. לוח הבקרה של Supabase עדיין מציע "Send password recovery",
// וקישור כזה פותח את הדשבורד במצב שחזור. בלי המסך שמקבל אותו, המשתמש
// היה מגיע מחובר — ובלי שום דרך לקבוע סיסמה. זה בדיוק הכשל שהמסך ההוא
// נבנה למנוע.
//
// מסלול ההתאוששות היום: מנהל מנפיק סיסמה חדשה. כתוב במפורש במסך ההתחברות.
// אם יוגדר SMTP, ראה SMTP.md — ההחזרה היא כתיבת שתי הפונקציות מחדש.

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

// ============================================================
// ⚠️ התפקיד נקרא מהמסד, ולא מהתביעה שבאסימון
// ============================================================
// `mapUser` למעלה מחזיר את `parkomat_role` מה-app_metadata — תביעה שנכתבת
// **פעם אחת** ותקפה שעה. זה היה מקובל כל עוד התפקיד היה רמז לתצוגה בלבד.
//
// ⚠️ **זה הפסיק להיות מקובל** כשמסך ניהול האתרים עבר להיפתח לפי תפקיד:
//   • מנהל שהורד לבקר המשיך לראות את המסך עד שהאסימון פג, וכל פעולה שם
//     חזרה ב-403 — מסך שמציע מה שאינו יכול.
//   • ובכיוון ההפוך, שגרוע יותר: בקר שהועלה למנהל **לא** ראה את המסך
//     למרות שהמסד כבר התיר לו, ולא הייתה שום דרך להבין למה.
//
// `public.my_role()` היא אותה `app.current_app_role()` שהמסד עצמו אוכף
// בכל פונקציית כתיבה — כלומר צד אחד של אמת, ולא שני.
//
// ⚠️ **נפילה חזרה לתביעה בכשל רשת, ולא ל-"בקר".** זה נראה כמו הבחירה
// הפחות זהירה והוא ההפוך: האכיפה במסד בכל מקרה, ולכן מסך שנפתח בטעות
// אינו פרצה — הפעולות בו ייכשלו. נפילה ל-"בקר" הייתה נועלת מנהל אמיתי
// מחוץ למסך בגלל הבהוב רשת, וזו תקלה שאין ממנה מוצא על המסך.
async function withDbRole(user) {
  const base = mapUser(user);
  if (!base) return null;

  try {
    const { data, error } = await supabase.rpc("my_role");
    // 'anonymous' הוא תשובה תקפה — כך נראה משתמש שהושבת.
    if (!error && typeof data === "string" && data) return { ...base, role: data };
  } catch { /* ראה למעלה — נשארים עם התביעה */ }

  return base;
}

/** ה-session הנוכחי, או null. נקרא בעלייה כדי לא לבקש התחברות מחדש. */
export async function currentUser() {
  if (!isSupabaseConfigured) return null;
  const { data } = await supabase.auth.getSession();
  return data.session ? withDbRole(data.session.user) : null;
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
    if (!session) return callback(null);

    // ============================================================
    // ⚠️ ה-RPC נדחה ל-setTimeout, וזו אינה קוסמטיקה
    // ============================================================
    // supabase-js מריץ את המאזין הזה **בתוך מנעול פנימי**, וקריאה נוספת
    // ל-supabase מתוכו (כולל `rpc`, שצריכה את האסימון) עלולה להיתקע על
    // אותו מנעול — כלומר המסך היה נשאר לנצח על "טוען". הדחייה למיקרו-
    // משימה משחררת את המנעול לפני הקריאה.
    //
    // ⚠️ ולכן גם ה-callback נקרא **פעמיים** בפועל: פעם עם התפקיד מהתביעה
    // (מיד) ופעם עם התפקיד מהמסד (מיד אחר כך). זה מכוון — המסך לא ממתין
    // לרשת כדי להיפתח, והוא מתקן את עצמו כשהתשובה האמיתית מגיעה.
    callback(mapUser(session.user));
    setTimeout(() => { withDbRole(session.user).then(callback).catch(() => {}); }, 0);
  });
  return () => data.subscription.unsubscribe();
}

// ============================================================
// התפקיד כאן הוא **רמז לתצוגה**, ולא הכרעה
// ============================================================
// ⚠️ **השרת אינו קורא מכאן.** הוא מכריע לפי app_users בטבלה
// (requireManager ב-api/routes.js, ו-app.current_app_role() ב-SQL),
// כי `parkomat_role` באסימון נכתב פעם אחת ותקף שעה: מנהל שהושבת או
// שהורד לבקר ממשיך לשאת את התביעה הישנה עד שהאסימון יפוג.
//
// ⚠️ ולכן ייתכן פער של עד שעה שבו המסך מציג כפתור שהשרת ידחה. זה
// **מכוון ובטוח**: ההכרעה במקום אחד, והמסך מציג את הסיבה שחוזרת.
// הסתרת כפתור אינה אבטחה — ומסך ששותק במקום להסביר גרוע יותר מכפתור
// שמחזיר "הפעולה מותרת למנהלים בלבד".
//
// Supabase מקנן את app_metadata ואינו משטח אותו לתביעה עליונה, ולכן
// שני המקומות נבדקים.
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

// ============================================================
// קביעת סיסמה חדשה אחרי איפוס — **בלי הנוכחית**
// ============================================================
// ⚠️ **נשארה למרות שהמסך אינו מבקש איפוס יותר.** הבקשה הוסרה, אבל הקישור
// עדיין יכול להגיע — לוח הבקרה של Supabase מציע "Send password recovery"
// לכל משתמש. בלי הפונקציה הזו והמסך שמעליה, קישור כזה היה מכניס את
// המשתמש למערכת בלי שום דרך לקבוע סיסמה.
//
// ⚠️ זו הפונקציה היחידה שמדלגת על אימות הסיסמה הנוכחית, וזה מכוון:
// היא נקראת רק כשה-session הגיע מקישור איפוס שנשלח לתיבת המייל של
// המשתמש — כלומר ההוכחה שהוא הוא היא הגישה למייל, לא הסיסמה הישנה.
//
// ⚠️ ולכן היא **חייבת** להיקרא רק ממסך השחזור. קריאה שלה ממקום אחר
// הייתה מחזירה בדיוק את הפרצה ש-changePassword נועדה לסגור.
export async function setNewPassword(nextPassword) {
  if (!isSupabaseConfigured) return { error: "האימות אינו מוגדר" };

  const next = String(nextPassword || "");
  if (next.length < MIN_PASSWORD_LENGTH) {
    return { error: `הסיסמה צריכה ${MIN_PASSWORD_LENGTH} תווים לפחות` };
  }

  const { error } = await supabase.auth.updateUser({ password: next });
  if (error) {
    return /should be different|same as the old/i.test(error.message)
      ? { error: "הסיסמה החדשה זהה לקודמת" }
      : { error: error.message };
  }
  return { error: null };
}

// ============================================================
// האם ה-session הנוכחי הגיע מקישור איפוס
// ============================================================
// Supabase פולט PASSWORD_RECOVERY כשהקישור נפתח. ⚠️ האירוע נפלט **פעם
// אחת** ולפני שרכיבים נטענים, ולכן ההאזנה חייבת לרוץ מוקדם והתשובה
// להישמר — אחרת המשתמש מגיע למסך רגיל בלי שום דרך לקבוע סיסמה.
export function onPasswordRecovery(callback) {
  if (!isSupabaseConfigured) return () => {};
  const { data } = supabase.auth.onAuthStateChange((event) => {
    if (event === "PASSWORD_RECOVERY") callback();
  });
  return () => data.subscription.unsubscribe();
}
