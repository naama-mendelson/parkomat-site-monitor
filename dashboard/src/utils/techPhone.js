// utils/techPhone.js — הטלפון של הטכנאי (21/10/2026, שלב 2 של "צא ל:"): הקישור שבתוך ה-QR, וקריאתו בטלפון; מה הכרטיס
// אומר על הטלפון; והריבועים של ה-QR. פונקציות טהורות — נבדקות ב-master/tests/tech-phone-ui.test.js.
//
// ⚠️ הקישור נושא את פרטי ההתחברות של הטלפון, ולכן הם ב-# ולא ב-?: החלק שאחרי # לא נשלח לשום שרת (גם לא ל-Cloudflare),
// והטלפון מוחק אותו מהכתובת מיד אחרי שקרא אותו. והסיסמה מתחלפת בטלפון בהתחברות הראשונה — QR שצולם לא יעבוד שוב.
import { ageText, clockText } from "./vehicles.js";

const EMAIL = /^tech-\d+-\d+@parkomat\.co\.il$/;
const PASSWORD = /^[A-Za-z0-9_-]{20,200}$/;

const b64url = (s) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s) => atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));

/** הקישור ל-QR: הכתובת של הדשבורד, ופרטי הטלפון אחרי #pair=. */
export function pairLink(origin, email, password) {
  return `${String(origin).replace(/\/+$/, "")}/#pair=${b64url(JSON.stringify({ e: email, p: password }))}`;
}

/** קריאת הקישור בטלפון: { email, password }, או null כשאין / כשהוא אינו של טלפון של טכנאי. */
export function parsePairHash(hash) {
  const m = String(hash ?? "").match(/^#pair=([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  try {
    const o = JSON.parse(unb64url(m[1]));
    const email = String(o?.e ?? "").trim().toLowerCase();
    const password = String(o?.p ?? "");
    return EMAIL.test(email) && PASSWORD.test(password) ? { email, password } : null;
  } catch {
    return null;
  }
}

/** האם זה משתמש של טלפון של טכנאי (לפי האימייל) — כשהתפקיד מהמסד עוד לא ידוע, או שהטלפון נותק. */
export const isTechPhoneEmail = (email) => EMAIL.test(String(email ?? "").toLowerCase());

/**
 * מה הכרטיס אומר על הטלפון: none — לא חובר; qr — נוצר QR ועוד לא נסרק; ok — הטלפון פתח את האפליקציה.
 * ⚠️ "נפתח לאחרונה" ולא "מחובר עכשיו": הטלפון פונה אלינו רק כשהאפליקציה פתוחה. הצפצוף (שלב 4) מגיע גם כשהיא סגורה.
 */
export function phoneStatus(phone, nowIso) {
  if (!phone?.paired) return { key: "none", text: "אין טלפון מחובר" };
  if (!phone.seen_at) {
    return { key: "qr", text: `נוצר QR${phone.paired_at ? ` ב-${clockText(phone.paired_at, nowIso)}` : ""} — הטלפון עוד לא סרק` };
  }
  return { key: "ok", text: `הטלפון מחובר · נפתח לאחרונה ${ageText(phone.seen_at, nowIso)}` };
}

/** קישור ניווט לאתר (Waze), או null כשלאתר אין מיקום. */
export function navLink(d) {
  const lat = Number(d?.lat), lon = Number(d?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || d?.lat == null || d?.lon == null) return null;
  return `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`;
}

/**
 * הריבועים של ה-QR כנתיב SVG אחד: "M x y h1 v1 h-1 z" לכל ריבוע כהה, עם שוליים (margin) של ריבועים לבנים.
 * qr = אובייקט של qrcode-generator אחרי make(). מחזיר { size, d } ביחידות של ריבוע.
 */
export function qrPath(qr, margin = 4) {
  const n = qr.getModuleCount();
  const parts = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) parts.push(`M${c + margin} ${r + margin}h1v1h-1z`);
  }
  return { size: n + 2 * margin, d: parts.join("") };
}
