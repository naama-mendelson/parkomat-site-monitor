// utils/loginCode.js — הטקסטים של מסך קוד הכניסה (20/10/2026). פונקציות טהורות; נבדקות ב-master/tests/login-code-ui.test.js.
//
// ⚠️ ההחלטות (תוקף, ניסיונות, מתי נשלח) — במסד. כאן רק התרגום של מה שחזר.

export const CODE_LENGTH = 4;

/** רק ספרות, עד 4 — גם כשמדביקים "קוד: 0427" מהמייל. */
export function codeDigits(v) {
  return String(v ?? "").replace(/\D/g, "").slice(0, CODE_LENGTH);
}

/** מה המסך אומר על תשובה שלילית מ-login_code_verify. */
export function verifyErrorText(r) {
  switch (r?.error) {
    case "wrong":
      return Number(r.left) === 1 ? "הקוד שגוי — נותר ניסיון אחד" : `הקוד שגוי — נותרו ${Number(r.left) || 0} ניסיונות`;
    case "locked":
      return "יותר מדי ניסיונות שגויים — בקשו קוד חדש";
    case "expired":
      return "תוקף הקוד פג — בקשו קוד חדש";
    case "none":
      return "עוד לא נשלח קוד להתחברות הזו — בקשו קוד";
    case "format":
      return `יש להקליד ${CODE_LENGTH} ספרות`;
    case "no_session":
      return "ההתחברות פגה — צאו והתחברו מחדש";
    default:
      return "הבדיקה נכשלה — נסו שוב";
  }
}

/** שורת ההסבר מעל השדה, לפי תשובת השליחה.
 *  ⚠️ הכתובת בסוף ובלי נקודה אחריה: במשפט RTL הנקודה עוברת לקצה השמאלי, צמוד לכתובת, ונקראת "naama.". */
export function sentText(r, fallbackEmail) {
  const to = r?.email || fallbackEmail || "המייל שלך";
  if (r?.status === "pending") return `הקוד כבר נשלח (תקף 10 דקות) אל ${to}`;
  return `שלחנו קוד בן ${CODE_LENGTH} ספרות אל ${to}`;
}

/** האם תשובת login_code_verify אומרת שצריך קוד חדש (ואז "שלח קוד חדש" מודגש). */
export function needsNewCode(r) {
  return r?.error === "locked" || r?.error === "expired" || r?.error === "none";
}
