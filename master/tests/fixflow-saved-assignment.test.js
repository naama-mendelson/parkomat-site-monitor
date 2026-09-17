// tests/fixflow-saved-assignment.test.js — שיוך ספרייה שנשמר זה עתה.
//
// ⚠️ הכפתור והפאנל שלצדו חישבו מאתר שונה: הכפתור ראה את השמירה, הפאנל לא —
// ואזהרת הבטיחות שהוצגה אחרי שיוך מחדש הייתה של הספרייה הקודמת. החנות
// המשותפת פותרת את זה, והבדיקות כאן נועלות את שני הכללים שלה: הדריסה חלה
// מיד, והיא **נסוגה** ברגע שהרשימה זזה — אחרת שינוי של משתמשת אחרת היה
// מוסתר עד רענון הדף.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { rememberAssignment, withSavedAssignment } = require(path.join(
  __dirname, "..", "..", "dashboard", "src", "components", "FixFlowLink", "savedAssignment.js"));

test("שיוך שנשמר חל מיד, גם על קורא שלא ביצע את השמירה", () => {
  const site = { code: "t1", fixflow_profile: "old" };
  rememberAssignment(site, "new");
  assert.equal(withSavedAssignment(site).fixflow_profile, "new");
});

test("הרשימה התעדכנה — היא גוברת, והדריסה נסוגה", () => {
  const site = { code: "t2", fixflow_profile: "old" };
  rememberAssignment(site, "new");
  assert.equal(withSavedAssignment({ code: "t2", fixflow_profile: "new" }).fixflow_profile, "new");
  // ⚠️ מישהי אחרת שינתה שוב — השמירה הישנה שלי אינה מסתירה את זה
  assert.equal(withSavedAssignment({ code: "t2", fixflow_profile: "third" }).fixflow_profile, "third");
});

test("ניקוי שיוך (מחרוזת ריקה) הוא שמירה תקפה, ולא 'אין שמירה'", () => {
  const site = { code: "t3", fixflow_profile: "old" };
  rememberAssignment(site, "");
  assert.equal(withSavedAssignment(site).fixflow_profile, "");
});

test("אתר אחר אינו מושפע", () => {
  rememberAssignment({ code: "t4", fixflow_profile: null }, "x");
  const other = { code: "t5", fixflow_profile: null };
  assert.equal(withSavedAssignment(other), other);
});
