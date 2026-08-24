// services/mfaDirect.js — אימות דו-שלבי (TOTP), מאחורי ה-seam.
//
// ============================================================
// למה TOTP ולא מייל, ולא passkey
// ============================================================
// ⚠️ **מייל אינו אפשרות כאן, וזה נמדד ולא הונח.** אין SMTP מוגדר בפרויקט,
// ולכן Supabase נופל למיילר המובנה — שמוגבל בקצב **ושולח רק לחברי
// הפרויקט**. אותה סיבה בדיוק שבגללה הוסרו magic-link ואיפוס-סיסמה
// מ-`auth.js`. גורם שני שנשען על מייל היה נכשל בדיוק ברגע שצריך אותו.
//
// ⚠️ **passkey (WebAuthn) אינו נתמך ב-GoTrue של Supabase היום.** ביקשו
// אותו במפורש, ולכן שווה לרשום למה לא: אין ל-GoTrue רושם WebAuthn, כלומר
// מימוש היה אומר לנהל אתגר-חתימה בשרת שלנו — כלומר להחזיר לשרת בדיוק את
// תפקיד האימות שהוצא ממנו. TOTP נתמך במקור (אימתנו: רישום מחזיר 200),
// עובד בכל אפליקציית מאמת, ואינו תלוי ברשת בזמן ההתחברות.
//
// ⚠️ **הפונקציות כאן מחזירות שגיאה כערך ולא זורקות** — כמו `signIn`
// באותו seam. מסך שנופל על חריגה בזמן התחברות משאיר את המשתמש בלי דרך
// פנימה ובלי הסבר.
import { supabase } from "./supabase";

/** רמת האימות בפועל. nextLevel === "aal2" אומר שיש גורם שני רשום. */
export async function assuranceLevel() {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) return { current: null, next: null, error: error.message };
  return { current: data.currentLevel, next: data.nextLevel, error: null };
}

/** האם חובה להשלים אתגר עכשיו — כלומר יש גורם רשום והוא לא הוצג. */
export async function challengeRequired() {
  const { current, next, error } = await assuranceLevel();
  if (error) return false;          // ⚠️ ספק אינו נועל החוצה — ראה למטה
  return next === "aal2" && current === "aal1";
}

/** הגורמים הרשומים, רק אלה שאומתו. */
export async function listFactors() {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) return { factors: [], error: error.message };
  return { factors: (data?.totp || []).filter((f) => f.status === "verified"), error: null };
}

/**
 * פותח רישום חדש. מחזיר { id, qr, secret } —
 * qr הוא data-URI של SVG שמגיע מ-Supabase, ולכן אין כאן ספריית QR
 * ואין בקשה לשרת חיצוני (חשוב: CSP).
 */
export async function startEnroll(friendlyName) {
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: friendlyName || `מכשיר ${new Date().toLocaleDateString("he-IL")}`,
  });
  if (error) return { error: error.message };
  return { id: data.id, qr: data.totp?.qr_code, secret: data.totp?.secret, error: null };
}

/**
 * מסיים רישום: המשתמש מקליד את הקוד מהאפליקציה.
 * ⚠️ הרישום אינו "נרשם" עד לצעד הזה. בלעדיו נשאר גורם במצב unverified,
 * שאינו מגן על כלום ומופיע ברשימה — ולכן listFactors מסננת לפי status.
 */
export async function confirmEnroll(factorId, code) {
  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId, code: String(code || "").trim(),
  });
  return { ok: !error, error: error ? readable(error.message) : null };
}

/** אתגר בהתחברות: מעלה את ה-session ל-aal2. */
export async function verifyCode(factorId, code) {
  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId, code: String(code || "").trim(),
  });
  return { ok: !error, error: error ? readable(error.message) : null };
}

/** מסיר גורם. דורש session ב-aal2 — כלומר אי אפשר להסיר בלי לעבור אותו. */
export async function removeFactor(factorId) {
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  return { ok: !error, error: error ? readable(error.message) : null };
}

// GoTrue מחזיר אנגלית טכנית; המסך הזה נקרא ברגע לחוץ.
function readable(msg) {
  if (/invalid|incorrect/i.test(msg)) return "הקוד שגוי או שפג תוקפו — נסה את הקוד הנוכחי באפליקציה";
  if (/rate|too many/i.test(msg)) return "יותר מדי ניסיונות — המתן דקה";
  return msg;
}
