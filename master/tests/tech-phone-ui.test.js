// tests/tech-phone-ui.test.js — הטלפון של הטכנאי (utils/techPhone.js, 21/10/2026, שלב 2 של "צא ל:"): הקישור שב-QR
// וקריאתו בטלפון, מה הכרטיס אומר על הטלפון, הניווט, וה-QR עצמו. ההחלטות (מי רשאי, איזה משתמש) — במסד
// (technicians.test.js) ובפונקציה (provision-technician-fn.test.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isTechPhoneEmail, navLink, pairLink, parsePairHash, phoneStatus, qrPath } from "../../dashboard/src/utils/techPhone.js";

const PW = "aB3-_xYz0123456789aB3-_xYz0123456789abcdE";   // בצורה של הסיסמה מהפונקציה (base64url)
const NOW = "2026-10-21T08:00:00Z";                         // 11:00 בישראל

test("הקישור: הפרטים אחרי # (לא נשלחים לשרת), ונקראים בטלפון כמו שנכתבו", () => {
  const link = pairLink("https://parkomat-site-monitor.pages.dev/", "tech-7-3@parkomat.co.il", PW);
  assert.match(link, /^https:\/\/parkomat-site-monitor\.pages\.dev\/#pair=[A-Za-z0-9_-]+$/, "בלי / כפול, בלי ? ובלי = או +");
  const hash = link.slice(link.indexOf("#"));
  assert.deepEqual(parsePairHash(hash), { email: "tech-7-3@parkomat.co.il", password: PW });
  assert.ok(!link.includes(PW), "הסיסמה אינה גלויה בקישור כמחרוזת");
});

test("הקישור: רק של טלפון של טכנאי — כל השאר null", () => {
  const enc = (o) => "#pair=" + Buffer.from(JSON.stringify(o)).toString("base64url");
  assert.equal(parsePairHash(""), null);
  assert.equal(parsePairHash("#other=1"), null);
  assert.equal(parsePairHash("#pair="), null);
  assert.equal(parsePairHash("#pair=@@@"), null);
  assert.equal(parsePairHash("#pair=bm90LWpzb24"), null, "base64 תקין שאינו JSON");
  assert.equal(parsePairHash(enc({ e: "site-1227@parkomat.co.il", p: PW })), null, "משתמש של סוכן — לא");
  assert.equal(parsePairHash(enc({ e: "naama@parkomat.co.il", p: PW })), null, "משתמש של אדם — לא");
  assert.equal(parsePairHash(enc({ e: "tech-7-3@evil.com", p: PW })), null, "דומיין אחר — לא");
  assert.equal(parsePairHash(enc({ e: "tech-7-3@parkomat.co.il", p: "short" })), null, "סיסמה קצרה — לא");
  assert.equal(parsePairHash(enc({ e: "tech-7-3@parkomat.co.il", p: "has space and more chars here" })), null);
  assert.deepEqual(parsePairHash(enc({ e: " TECH-7-3@Parkomat.co.il ", p: PW })), { email: "tech-7-3@parkomat.co.il", password: PW },
    "רווחים ואותיות גדולות באימייל — מנורמלים");
  assert.equal(parsePairHash(enc({ e: "tech-7-3@parkomat.co.il", p: PW }) + "&x=1"), null, "תוספת אחרי הקוד — לא");
});

test("אימייל של טלפון", () => {
  assert.equal(isTechPhoneEmail("tech-12-1@parkomat.co.il"), true);
  assert.equal(isTechPhoneEmail("TECH-12-1@PARKOMAT.CO.IL"), true);
  assert.equal(isTechPhoneEmail("tech-12@parkomat.co.il"), false, "בלי מספר חיבור");
  assert.equal(isTechPhoneEmail("site-12@parkomat.co.il"), false);
  assert.equal(isTechPhoneEmail(null), false);
});

test("מה הכרטיס אומר: אין טלפון / QR שעוד לא נסרק / מחובר, ומתי נפתח לאחרונה", () => {
  assert.deepEqual(phoneStatus(null, NOW), { key: "none", text: "אין טלפון מחובר" });
  assert.equal(phoneStatus({ paired: false, seen_at: "2026-10-21T07:00:00Z" }, NOW).key, "none", "מנותק — גם אם נראה פעם");
  assert.deepEqual(phoneStatus({ paired: true, paired_at: "2026-10-21T07:42:00Z", seen_at: null }, NOW),
    { key: "qr", text: "נוצר QR ב-10:42 — הטלפון עוד לא סרק" });
  assert.deepEqual(phoneStatus({ paired: true, paired_at: null, seen_at: null }, NOW),
    { key: "qr", text: "נוצר QR — הטלפון עוד לא סרק" });
  assert.deepEqual(phoneStatus({ paired: true, seen_at: "2026-10-21T07:57:00Z" }, NOW),
    { key: "ok", text: "הטלפון מחובר · נפתח לאחרונה לפני 3 דק'", push: null }, "מסד בלי push_ready — בלי סיומת");
  assert.deepEqual(phoneStatus({ paired: true, seen_at: "2026-10-21T07:57:00Z", push_ready: true }, NOW),
    { key: "ok", text: "הטלפון מחובר · נפתח לאחרונה לפני 3 דק' · צפצוף מופעל", push: true });
  assert.deepEqual(phoneStatus({ paired: true, seen_at: "2026-10-21T07:57:00Z", push_ready: false }, NOW),
    { key: "ok", text: "הטלפון מחובר · נפתח לאחרונה לפני 3 דק' · צפצוף לא הופעל", push: false });
});

test("ניווט: Waze לפי מיקום האתר; בלי מיקום — אין קישור", () => {
  assert.equal(navLink({ lat: 32.0705, lon: 34.7905 }), "https://waze.com/ul?ll=32.0705,34.7905&navigate=yes");
  assert.equal(navLink({ lat: null, lon: null }), null);
  assert.equal(navLink({ lat: 32.07 }), null);
  assert.equal(navLink(null), null);
  assert.equal(navLink({ place: "המחסן" }), null, "מקום חופשי — אין מיקום");
});

test("ה-QR: ריבוע לכל מודול כהה, בתוך שוליים", () => {
  const dark = new Set(["0,0", "1,2", "2,1"]);
  const qr = { getModuleCount: () => 3, isDark: (r, c) => dark.has(`${r},${c}`) };
  const { size, d } = qrPath(qr, 4);
  assert.equal(size, 11);
  assert.equal(d.match(/M/g).length, 3);
  assert.match(d, /^M4 4h1v1h-1z/, "השורה העליונה-שמאלית — אחרי 4 שוליים");
  assert.ok(d.includes("M6 5h1v1h-1z"), "שורה 1, עמודה 2");
  assert.equal(qrPath(qr, 0).size, 3);
});
