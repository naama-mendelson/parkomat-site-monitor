// tests/vehicles-ui.test.js — מה מסך הרכבים מציג (dashboard/src/utils/vehicles.js). הנתונים עצמם — vehicles.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  vehicleName, isStale, motionOf, ageText, sortVehicles, motionCounts, syncState, placeNames, hasPosition, matchesVehicle,
  STALE_MS, SYNC_LATE_MS,
} from "../../dashboard/src/utils/vehicles.js";

const NOW = "2026-10-20T10:00:00Z";
const ago = (min) => new Date(Date.parse(NOW) - min * 60_000).toISOString();
const v = (over = {}) => ({ plate: "1234567", name: "ישראל ישראלי 1234567", motion: "parking", lat: 32, lon: 34.8, located_at: ago(5), places: [], ...over });

test("vehicleName: בלי מספר הרכב שאיתוראן מצרפים, גם כשהוא צמוד או בסוגריים; בלי שם — הלוחית", () => {
  assert.equal(vehicleName(v()), "ישראל ישראלי");
  assert.equal(vehicleName(v({ name: "דנה חדש1234567" })), "דנה חדש");
  assert.equal(vehicleName(v({ name: "זמני (משה ישן) 1234567" })), "זמני (משה ישן)");
  assert.equal(vehicleName(v({ name: "  רז   כהן  " })), "רז כהן");
  assert.equal(vehicleName(v({ name: "" })), "1234567");
  assert.equal(vehicleName({}), "רכב");
});

test("מצב: לפי איתוראן — עד שהרכב לא דיווח יממה, ואז 'לא מדווח' (גם אם כתוב 'בנסיעה')", () => {
  assert.equal(motionOf(v({ motion: "driving" }), NOW).label, "בנסיעה");
  assert.equal(motionOf(v({ motion: "idle" }), NOW).label, "מנוע דולק");
  assert.equal(motionOf(v({ motion: "parking" }), NOW).label, "חונה");
  assert.equal(motionOf(v({ motion: "none" }), NOW).label, "לא ידוע");
  assert.equal(motionOf(v({ motion: "driving", located_at: ago(STALE_MS / 60_000 + 1) }), NOW).tone, "stale");
  assert.equal(isStale(v({ located_at: ago(STALE_MS / 60_000 - 1) }), NOW), false);
  assert.equal(isStale(v({ located_at: null }), NOW), true);
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

test("הסדר והסיכום: בנסיעה, מנוע דולק, חונה, לא ידוע, לא מדווח — ובתוך קבוצה לפי שם", () => {
  const list = [
    v({ plate: "1", name: "תמר 1", motion: "parking" }),
    v({ plate: "2", name: "אבי 2", motion: "driving" }),
    v({ plate: "3", name: "בני 3", motion: "parking", located_at: ago(3 * 24 * 60) }),
    v({ plate: "4", name: "גל 4", motion: "idle" }),
    v({ plate: "5", name: "אורי 5", motion: "parking" }),
  ];
  assert.deepEqual(sortVehicles(list, NOW).map((x) => x.plate), ["2", "4", "5", "1", "3"]);
  assert.deepEqual(motionCounts(list, NOW), { driving: 1, idle: 1, parking: 2, stale: 1, unknown: 0 });
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
