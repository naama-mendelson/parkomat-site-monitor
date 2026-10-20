// tests/vehicles-ui.test.js — מה מסך הרכבים מציג (dashboard/src/utils/vehicles.js). הנתונים והמצב עצמו — vehicles.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  vehicleName, stateOf, stateText, rowAge, placeText, powerAlert, clockText, ageText, sortVehicles, stateCounts, syncState,
  placeNames, hasPosition, matchesVehicle, STATES, STALE_MS, SYNC_LATE_MS,
} from "../../dashboard/src/utils/vehicles.js";

const NOW = "2026-10-20T10:00:00Z";   // 13:00 בישראל
const ago = (min) => new Date(Date.parse(NOW) - min * 60_000).toISOString();
const v = (over = {}) => ({ plate: "1234567", name: "ישראל ישראלי 1234567", motion: "parking", state: "parking", lat: 32, lon: 34.8,
                            located_at: ago(5), state_since: null, places: [], ...over });

test("vehicleName: בלי מספר הרכב שאיתוראן מצרפים, גם כשהוא צמוד או בסוגריים; בלי שם — הלוחית", () => {
  assert.equal(vehicleName(v()), "ישראל ישראלי");
  assert.equal(vehicleName(v({ name: "דנה חדש1234567" })), "דנה חדש");
  assert.equal(vehicleName(v({ name: "זמני (משה ישן) 1234567" })), "זמני (משה ישן)");
  assert.equal(vehicleName(v({ name: "  רז   כהן  " })), "רז כהן");
  assert.equal(vehicleName(v({ name: "" })), "1234567");
  assert.equal(vehicleName({}), "רכב");
});

test("מצב: מה שהמסד החליט (state) — לא ה-motion של איתוראן; מצב לא מוכר — 'לא ידוע'", () => {
  for (const [state, label] of [["driving", "בנסיעה"], ["idle", "מנוע דולק"], ["parking", "חונה"], ["silent", "לא מתעדכן"],
                                ["unknown", "לא ידוע"], ["no_report", "לא מדווח"]]) {
    assert.equal(stateOf(v({ state }), NOW).label, label, state);
  }
  // "לא בנסיעה" (בעלת המוצר, 20/10): איתוראן אומרים driving, המסד אומר silent — המסך מציג silent
  assert.equal(stateOf(v({ motion: "driving", state: "silent", located_at: ago(400) }), NOW).tone, "silent");
  assert.equal(stateOf(v({ state: "flying" }), NOW).label, "לא ידוע");
  assert.equal(stateOf(v({ state: null }), NOW).label, "לא ידוע");
});

test("מצב ממסד ישן (בלי state): ההתנהגות הקודמת — איתוראן, ואחרי יממה 'לא מדווח'", () => {
  const old = (over) => { const x = v(over); delete x.state; delete x.state_since; return x; };
  assert.equal(stateOf(old({ motion: "driving" }), NOW).label, "בנסיעה");
  assert.equal(stateOf(old({ motion: "none" }), NOW).label, "לא ידוע");
  assert.equal(stateOf(old({ motion: "driving", located_at: ago(STALE_MS / 60_000 + 1) }), NOW).tone, "stale");
  assert.equal(stateOf(old({ motion: "parking", located_at: ago(STALE_MS / 60_000 - 1) }), NOW).tone, "parking");
  assert.equal(stateOf(old({ located_at: null }), NOW).tone, "stale");
  assert.equal(stateText(old({ motion: "driving", located_at: ago(2 * 24 * 60) }), NOW), "לא מדווח מאז 18/10 13:00");
});

test("שעה בשעון ישראל: היום, אתמול (לפי לוח השנה, גם ביום מעבר שעון), תאריך, שנה אחרת", () => {
  assert.equal(clockText("2026-10-20T06:05:00Z", NOW), "09:05");
  assert.equal(clockText("2026-10-19T20:59:00Z", NOW), "אתמול 23:59");
  assert.equal(clockText("2026-10-19T21:00:00Z", NOW), "00:00");                                       // כבר היום בישראל
  assert.equal(clockText("2026-10-18T05:00:00Z", NOW), "18/10 08:00");
  assert.equal(clockText("2025-12-31T10:00:00Z", NOW), "31/12/2025 12:00");
  // 26/10 ב-10:00 (חורף, +2); 25/10 היה יום של 25 שעות — "אתמול" לפי התאריך, לא לפי 24 שעות
  assert.equal(clockText("2026-10-24T21:30:00Z", "2026-10-26T08:00:00Z"), "אתמול 00:30");
  assert.equal(clockText("2026-10-24T20:30:00Z", "2026-10-26T08:00:00Z"), "24/10 23:30");
  assert.equal(clockText(null, NOW), "");
  assert.equal(clockText("2026-10-20T10:30:00Z", NOW), "13:30");   // שעון קצת קדימה — עדיין "היום"
});

test("שורת המצב: חונה מאז / לא מתעדכן מאז / לא מדווח מאז; בנסיעה — בלי זמן; חונה בלי 'מאז' — רק 'חונה'", () => {
  assert.equal(stateText(v({ state_since: "2026-10-20T06:12:00Z" }), NOW), "חונה מאז 09:12");
  assert.equal(stateText(v({ state_since: "2026-10-19T14:45:00Z" }), NOW), "חונה מאז אתמול 17:45");
  assert.equal(stateText(v({ state_since: null }), NOW), "חונה");
  assert.equal(stateText(v({ state: "silent", state_since: "2026-10-20T08:02:00Z" }), NOW), "לא מתעדכן מאז 11:02");
  assert.equal(stateText(v({ state: "no_report", state_since: "2026-10-13T05:00:00Z" }), NOW), "לא מדווח מאז 13/10 08:00");
  assert.equal(stateText(v({ state: "no_report", state_since: null, located_at: null }), NOW), "לא מדווח");
  assert.equal(stateText(v({ state: "driving", state_since: "2026-10-20T09:58:00Z" }), NOW), "בנסיעה");
  assert.equal(stateText(v({ state: "idle" }), NOW), "מנוע דולק");
});

test("עמודת הזמן: רק לבנסיעה / מנוע דולק / לא ידוע; לחונה ולמושתקים הזמן כבר בשורת המצב", () => {
  assert.equal(rowAge(v({ state: "driving", located_at: ago(2) }), NOW), "לפני 2 דק'");
  assert.equal(rowAge(v({ state: "idle", located_at: ago(0) }), NOW), "עכשיו");
  assert.equal(rowAge(v({ state: "unknown", located_at: ago(90) }), NOW), "לפני 1 שע'");
  for (const state of ["parking", "silent", "no_report"]) assert.equal(rowAge(v({ state, located_at: ago(4) }), NOW), "", state);
});

test("המקום: אזור ואם אין — כתובת; ברכב שלא מתעדכן — 'מקום אחרון'", () => {
  assert.equal(placeText(v({ places: [{ place_name: "משרד" }], address: "אילן רמון, נס ציונה" }), NOW), "משרד");
  assert.equal(placeText(v({ address: "אילן רמון, נס ציונה" }), NOW), "אילן רמון, נס ציונה");
  assert.equal(placeText(v({ state: "silent", address: "חניון, תל אביב" }), NOW), "מקום אחרון: חניון, תל אביב");
  assert.equal(placeText(v({ state: "no_report", places: [{ place_name: "מחסן" }] }), NOW), "מקום אחרון: מחסן");
  assert.equal(placeText(v({ address: null }), NOW), "");
});

test("התראת מתח: שם ושעה; בלי — null; זמן משובש — null", () => {
  assert.deepEqual(powerAlert(v({ power_alert: { at: "2026-10-20T05:54:11Z", name: "ניתוק מתח" } }), NOW),
                   { name: "ניתוק מתח", at: "2026-10-20T05:54:11Z", text: "ניתוק מתח מאז 08:54" });
  assert.equal(powerAlert(v({ power_alert: { at: "2026-10-20T05:54:11Z", name: " " } }), NOW).name, "תקלת מתח");
  assert.equal(powerAlert(v({ power_alert: null }), NOW), null);
  assert.equal(powerAlert(v(), NOW), null);
  assert.equal(powerAlert(v({ power_alert: { at: "אתמול", name: "ניתוק מתח" } }), NOW), null);
});

test("ageText", () => {
  assert.equal(ageText(ago(0), NOW), "עכשיו");
  assert.equal(ageText(ago(5), NOW), "לפני 5 דק'");
  assert.equal(ageText(ago(59), NOW), "לפני 59 דק'");
  assert.equal(ageText(ago(61), NOW), "לפני 1 שע'");
  assert.equal(ageText(ago(25 * 60), NOW), "לפני יום");
  assert.equal(ageText(ago(4 * 24 * 60), NOW), "לפני 4 ימים");
  assert.equal(ageText(null, NOW), "לא ידוע");
  assert.equal(ageText("2026-10-20T10:05:00Z", NOW), "עכשיו");   // שעון קצת קדימה — לא "לפני -5"
});

test("הסדר והסיכום: בנסיעה, מנוע דולק, חונה, לא מתעדכן, לא ידוע, לא מדווח — ובתוך קבוצה לפי שם", () => {
  const list = [
    v({ plate: "1", name: "תמר 1", state: "parking" }),
    v({ plate: "2", name: "אבי 2", state: "driving" }),
    v({ plate: "3", name: "בני 3", state: "no_report" }),
    v({ plate: "4", name: "גל 4", state: "idle" }),
    v({ plate: "5", name: "אורי 5", state: "parking" }),
    v({ plate: "6", name: "נעם 6", motion: "driving", state: "silent" }),
    v({ plate: "7", name: "דן 7", state: "unknown" }),
  ];
  assert.deepEqual(sortVehicles(list, NOW).map((x) => x.plate), ["2", "4", "5", "1", "6", "7", "3"]);
  assert.deepEqual(stateCounts(list, NOW), { driving: 1, idle: 1, parking: 2, silent: 1, unknown: 1, stale: 1 });
  // כל מצב שהמסד מחזיר נספר באחד מסלי הסיכום
  for (const k of Object.keys(STATES)) assert.ok(STATES[k].tone in stateCounts([], NOW), k);
});

test("מצב הסנכרון: עוד לא רץ / תקין / מאחר (5 דק') / נכשל אחרי ההצלחה האחרונה", () => {
  assert.equal(syncState(null, NOW), "never");
  assert.equal(syncState({ last_ok_at: ago(1) }, NOW), "ok");
  assert.equal(syncState({ last_ok_at: ago(SYNC_LATE_MS / 60_000 + 1) }, NOW), "late");
  assert.equal(syncState({ last_ok_at: ago(3), last_error_at: ago(1), last_error: "x" }, NOW), "error");
  assert.equal(syncState({ last_ok_at: ago(1), last_error_at: ago(3), last_error: "x" }, NOW), "ok");   // כשל ישן שתוקן
  assert.equal(syncState({ last_error_at: ago(1) }, NOW), "error");
});

test("מקומות, מיקום וחיפוש", () => {
  assert.deepEqual(placeNames(v({ places: [{ place_name: "משרד" }, { place_name: " " }, {}] })), ["משרד"]);
  assert.deepEqual(placeNames(v({ places: null })), []);
  assert.equal(hasPosition(v()), true);
  assert.equal(hasPosition(v({ lat: null })), false);
  assert.equal(hasPosition(v({ lat: 0, lon: 0 })), false);
  const x = v({ address: "הרצל 5, רחובות", places: [{ place_name: "מחסן" }] });
  for (const q of ["ישראל", "1234", "רחובות", "מחסן", "", "  ישראל   ישראלי "]) assert.equal(matchesVehicle(x, q), true, q);
  assert.equal(matchesVehicle(x, "חיפה"), false);
});
