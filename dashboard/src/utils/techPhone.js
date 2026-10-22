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

// ⚠️ הקישור מוביל תמיד לאתר החי, לא לכתובת של הדפדפן שיצר את ה-QR (21/10/2026). ה-QR הראשון נוצר מהדשבורד שרץ במחשב
// הפיתוח (localhost:5173), והקישור הוביל ל-localhost — כתובת שקיימת רק במחשב ההוא, והטלפון ענה "לא ניתן לגשת לאתר".
// גם עותק DELL008 נגיש רק ברשת המשרד, וכתובת תצוגה מקדימה של Pages מתחלפת בכל פריסה. VITE_PUBLIC_ORIGIN — לכתובת אחרת.
export const PUBLIC_ORIGIN = "https://parkomat-site-monitor.pages.dev";

/** הכתובת שאליה מוביל ה-QR: VITE_PUBLIC_ORIGIN אם הוא כתובת https תקינה, אחרת האתר החי. */
export function pairOrigin(override) {
  const o = String(override ?? "").trim().replace(/\/+$/, "");
  return /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(o) ? o : PUBLIC_ORIGIN;
}

/** הקישור ל-QR: הכתובת של האתר (pairOrigin), ופרטי הטלפון אחרי #pair=. */
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
  const push = phone.push_ready === true ? " · צפצוף מופעל" : phone.push_ready === false ? " · צפצוף לא הופעל" : "";
  return { key: "ok", text: `הטלפון מחובר · נפתח לאחרונה ${ageText(phone.seen_at, nowIso)}${push}`, push: phone.push_ready ?? null };
}

/**
 * הודעת הוואטסאפ עם קישור החיבור (22/10/2026). הבעלת: "אני רוצה שהטכנאים לא יצטרכו לבוא לפה" — ה-QR הוא קישור,
 * ואפשר לשלוח אותו. wa.me בלי מספר — וואטסאפ שואל למי לשלוח. ⚠️ הקישור עובד פעם אחת, כמו ה-QR: הטלפון מחליף את
 * הסיסמה ברגע שנפתח, ולכן הודעה שנשארת בצ'אט לא פותחת דבר אחר כך.
 */
export function pairMessage(link, name) {
  const who = String(name ?? "").trim();
  return [
    `${who ? `שלום ${who}, ` : ""}זה הקישור לחיבור הטלפון שלך למשימות של פרקומט.`,
    "לפתוח אותו בטלפון (בכרום), ולאשר צפצוף כשהוא שואל:",
    link,
    "הקישור עובד פעם אחת.",
  ].join("\n");
}
export const whatsappLink = (link, name) => `https://wa.me/?text=${encodeURIComponent(pairMessage(link, name))}`;

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
