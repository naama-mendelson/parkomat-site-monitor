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
// קישור כניסה למייל (Magic Link)
// ============================================================
// ⚠️ **תיבת הדואר של הארגון היא ההוכחה.** כתובת @parkomat.co.il מונפקת רק
// לעובדים, ורק מי ששולט בתיבה יכול ללחוץ על הקישור. זו בדיוק התכונה
// ש-Google Workspace נותן — בלי OAuth, בלי Client ID, ובלי תלות בספק
// חיצוני שצריך להגדיר ולתחזק.
//
// ⚠️ `shouldCreateUser: true` בכוונה: זה מה שהופך את הקישור למסלול כניסה
// **ראשונה** ולא רק לחזרה. משתמש חדש נוצר, `enforce_user_creation` מוודא
// שהדומיין תקין ומעניק דרגת בקר, ו-`provision_app_user` יוצר את שורת
// app_users. כל אלה במסד, ולא כאן.
//
// ⚠️ ובקשה לכתובת של מישהו אחר אינה מסוכנת: הקישור נשלח **אליו**, לא
// למבקש. מי שמזין כתובת זרה פשוט שולח לה דואר.
//
// ⚠️ emailRedirectTo הוא ה-origin הנוכחי ולא כתובת קבועה — אחרת פיתוח
// (5173) היה מחזיר לפרודקשן אחרי הלחיצה על הקישור.
export async function sendMagicLink(email) {
  if (!isSupabaseConfigured) {
    return { error: "האימות אינו מוגדר בדשבורד (חסר VITE_SUPABASE_URL)" };
  }

  const clean = String(email || "").trim();
  if (!clean) return { error: "יש להזין כתובת אימייל" };

  const { error } = await supabase.auth.signInWithOtp({
    email: clean,
    options: { emailRedirectTo: window.location.origin, shouldCreateUser: true },
  });

  if (error) {
    // ⚠️ חסימת קצב היא המקרה הנפוץ ביותר כאן, ו-GoTrue מנסח אותה באנגלית.
    // "שגיאה" סתמית הייתה שולחת את המשתמש ללחוץ שוב ולהיחסם שוב.
    return {
      error: /rate limit|too many/i.test(error.message)
        ? "נשלחו יותר מדי בקשות. המתן דקה ונסה שוב."
        : error.message,
    };
  }
  return { error: null };
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
// איפוס סיסמה — המסלול היחיד למי ששכח
// ============================================================
// ⚠️ **changePassword דורשת את הסיסמה הנוכחית**, וזה נכון: הדשבורד רץ
// על מסך משותף בחדר בקרה, ובלי אימות כל מי שעובר ליד יכול לנעל בחוץ
// את בעל החשבון.
//
// אבל זה משאיר את מי ש**שכח** בלי שום דרך — הוא זקוק למישהו עם מפתח
// ה-Secret של הפרויקט. זה קרה בפועל, וזו הסיבה שהמסלול הזה נוסף.
//
// ⚠️ **התשובה זהה גם לכתובת שאינה קיימת**, ובכוונה: הודעה שמבחינה
// ביניהן הופכת את הטופס לכלי שמגלה מי רשום במערכת.
export async function requestPasswordReset(email) {
  if (!isSupabaseConfigured) {
    return { error: "האימות אינו מוגדר בדשבורד" };
  }

  const clean = String(email || "").trim();
  if (!clean) return { error: "יש להזין כתובת אימייל" };

  const { error } = await supabase.auth.resetPasswordForEmail(clean, {
    redirectTo: window.location.origin,
  });

  if (error) {
    // ⚠️ חסימת קצב היא המקרה הנפוץ ביותר — ה-SMTP המובנה של Supabase
    // מוגבל למספר מיילים בשעה. "שגיאה" סתמית הייתה שולחת ללחוץ שוב
    // ולהיחסם שוב.
    return {
      error: /rate limit|too many/i.test(error.message)
        ? "נשלחו יותר מדי בקשות. המתן דקה ונסה שוב."
        : error.message,
    };
  }
  return { error: null };
}

// ============================================================
// קביעת סיסמה חדשה אחרי איפוס — **בלי הנוכחית**
// ============================================================
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
