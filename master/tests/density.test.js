// tests/density.test.js — צפיפות רשת הכרטיסים (dashboard/src/utils/constants.js → densityFor).
//
// ⚠️ בעלת המוצר, 06/10/2026, על 60 אתרים שהצטמצמו לכרטיסים של שם ונקודה: "אני לא רוצה
// שה-DASHBOARD יצטמצם אף פעם לכזה גודל, זה מדי קטן". הרמה הצפופה ביותר היא compact;
// כשגם היא לא נכנסת — גוללים.
import { test } from "node:test";
import assert from "node:assert/strict";
import { densityFor } from "../../dashboard/src/utils/constants.js";

test("⚠️ לעולם לא mini — גם ב-500 אתרים על מסך של טלפון", () => {
  for (const [n, w, h] of [[60, 1860, 640], [130, 1371, 900], [500, 390, 300], [61, 0, 0], [5, 1371, 900], [21, 1100, 500]]) {
    assert.notEqual(densityFor(n, w, h), "mini", `${n} אתרים, ${w}×${h}`);
  }
});

test("normal כשהרשת נכנסת (עם סובלנות גלילה), אחרת compact; מעל 60 אתרים — compact", () => {
  assert.equal(densityFor(12, 1371, 900), "normal");
  assert.equal(densityFor(60, 1860, 300), "compact", "לא נכנס — compact, לא mini");
  assert.equal(densityFor(61, 3000, 3000), "compact", "מעל 60 — compact גם כשיש מקום");
  assert.equal(densityFor(5, 0, 0), "normal", "לפני המדידה");
});
