// tests/site-inactive-ui.test.js — "לא פעיל" בדשבורד (utils/siteInactive.js, 22/10/2026). שמות מומצאים — המאגר ציבורי.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isInactive, splitInactive, inactiveSince, inactiveLine } from "../../dashboard/src/utils/siteInactive.js";

test("חלוקה: הלא-פעילים בסוף, והסדר בתוך כל חלק נשמר", () => {
  const S = (code, inactive_at = null) => ({ code, inactive_at });
  const list = [S("1"), S("2", "2026-10-22T08:00:00.000Z"), S("3"), S("4", "2026-10-20T08:00:00.000Z"), S("5")];
  const { active, inactive } = splitInactive(list);
  assert.deepEqual(active.map((s) => s.code), ["1", "3", "5"]);
  assert.deepEqual(inactive.map((s) => s.code), ["2", "4"], "באותו סדר שהגיעו — לא לפי תאריך הסימון");
  assert.deepEqual(splitInactive([]), { active: [], inactive: [] });
  assert.deepEqual(splitInactive(null), { active: [], inactive: [] });
  assert.equal(isInactive({ inactive_at: "" }), false, "ריק — פעיל");
  assert.equal(isInactive({}), false);
  assert.equal(isInactive(null), false);
});

test("שורת הכרטיס: מתי (היום בישראל), ע״י מי (בלי הדומיין), ולמה; פעיל — ריק", () => {
  const s = { inactive_at: "2026-10-21T22:30:00.000Z", inactive_by: "dana@parkomat.co.il", inactive_reason: "בשיפוץ" };
  assert.equal(inactiveSince(s), "מ-22/10", "01:30 בישראל — כבר 22/10");
  assert.equal(inactiveLine(s), "לא פעיל מ-22/10 ע״י dana · בשיפוץ");
  assert.equal(inactiveLine({ ...s, inactive_by: "דנה עורכת", inactive_reason: null }), "לא פעיל מ-22/10 ע״י דנה עורכת");
  assert.equal(inactiveLine({ ...s, inactive_by: null }), "לא פעיל מ-22/10 · בשיפוץ");
  assert.equal(inactiveLine({ inactive_at: "x" }), "לא פעיל", "תאריך לא תקין — בלי 'מ-'");
  assert.equal(inactiveLine({ inactive_at: null }), "");
});
