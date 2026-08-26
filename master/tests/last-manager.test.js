// tests/last-manager.test.js — "המנהל הפעיל האחרון", ומי באמת נחסם.
//
// ============================================================
// ⚠️ הכלל ספר כמה מנהלים פעילים יש — ולא כמה יישארו
// ============================================================
// שלושת השומרים (השבתה, הורדה בתפקיד, מחיקה) ספרו את כל המנהלים הפעילים
// במערכת, בלי להוציא את היעד. כשהיעד עצמו **מושבת**, הוא ממילא אינו אחד
// מהפעילים — ולכן הספירה החזירה 1, הפעולה נחסמה, וההודעה "לא ניתן למחוק
// את המנהל הפעיל האחרון" נאמרה על מי שאינו פעיל ואינו אחרון.
//
// התוצאה המעשית: חשבון מנהל שהושבת נתקע לנצח. אי אפשר למחוק אותו ואי
// אפשר להוריד אותו בתפקיד, כל עוד יש בדיוק מנהל פעיל אחד.
//
// ⚠️ וההגנה עצמה לא נחלשה — הבדיקה מוודאת את שני הכיוונים.
const test = require("node:test");
const assert = require("node:assert/strict");

const { canDeactivate, canChangeRole, canDelete } = require("../auth/deactivation.js");

const M = (id, active) => ({ id, role: "manager", is_active: active });
const C = (id) => ({ id, role: "operator", is_active: true });

// מנהל פעיל אחד (1), מנהל מושבת (2), בקר (3). ⚠️ החתימה היא
// (users, targetId, actorId, nextRole) — והתפקיד הוא "operator".
const USERS = [M(1, true), M(2, false), C(3)];


test("⚠️ מנהל מושבת ניתן למחיקה גם כשיש מנהל פעיל אחד", () => {
  const r = canDelete(USERS, 2, 1);
  assert.equal(r.allowed, true, r.reason);
});

test("⚠️ ומנהל מושבת ניתן להורדה בתפקיד", () => {
  const r = canChangeRole(USERS, 2, 1, "operator");
  assert.equal(r.allowed, true, r.reason);
});

test("⚠️ ולהשבתה (פעולה ריקה, אבל לא אמורה להיחסם בשקר)", () => {
  const r = canDeactivate(USERS, 2, 1);
  assert.equal(r.allowed, true, r.reason);
});


// ===== והכיוון השני: ההגנה עדיין תופסת =====

test("המנהל הפעיל היחיד — כל שלוש הפעולות חסומות", () => {
  // שחקן אחר (בקר) מנסה. איסור "על עצמך" אינו מה שחוסם כאן.
  assert.equal(canDeactivate(USERS, 1, 3).allowed, false);
  assert.equal(canChangeRole(USERS, 1, 3, "operator").allowed, false);
  assert.equal(canDelete(USERS, 1, 3).allowed, false);
});

test("שני מנהלים פעילים — מותר להוריד אחד, ואז נעצרים", () => {
  const two = [M(1, true), M(2, true), C(3)];
  assert.equal(canDelete(two, 2, 1).allowed, true);
  assert.equal(canDeactivate(two, 2, 1).allowed, true);

  // אחרי שהאחד הושבת, השני נעול.
  const after = [M(1, true), M(2, false), C(3)];
  assert.equal(canDeactivate(after, 1, 3).allowed, false);
});

test("מנהל מושבת אינו נחשב כמציל — לא ניתן להשבית את הפעיל היחיד", () => {
  const many = [M(1, true), M(2, false), M(4, false), C(3)];
  assert.equal(canDeactivate(many, 1, 3).allowed, false,
    "שני מנהלים מושבתים נספרו כאילו הם יכולים להחליף");
});
