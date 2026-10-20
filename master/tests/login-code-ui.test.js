// tests/login-code-ui.test.js — הטקסטים של מסך קוד הכניסה (dashboard/src/utils/loginCode.js). ההחלטות במסד
// (login-code.test.js); כאן רק מה שהמסך אומר על מה שחזר.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODE_LENGTH, codeDigits, verifyErrorText, sentText, needsNewCode } from "../../dashboard/src/utils/loginCode.js";

test("codeDigits: רק ספרות, עד 4 — גם מהדבקה של שורת הנושא מהמייל", () => {
  assert.equal(CODE_LENGTH, 4);
  assert.equal(codeDigits("קוד הכניסה לדשבורד: 0427"), "0427");
  assert.equal(codeDigits(" 04 27 "), "0427");
  assert.equal(codeDigits("042789"), "0427");
  assert.equal(codeDigits("12"), "12");
  assert.equal(codeDigits(null), "");
});

test("verifyErrorText: כל תשובה של login_code_verify — משפט, ולא מפתח באנגלית", () => {
  assert.equal(verifyErrorText({ error: "wrong", left: 3 }), "הקוד שגוי — נותרו 3 ניסיונות");
  assert.equal(verifyErrorText({ error: "wrong", left: 1 }), "הקוד שגוי — נותר ניסיון אחד");
  assert.match(verifyErrorText({ error: "locked" }), /קוד חדש/);
  assert.match(verifyErrorText({ error: "expired" }), /פג/);
  assert.match(verifyErrorText({ error: "none" }), /עוד לא נשלח/);
  assert.match(verifyErrorText({ error: "format" }), /4 ספרות/);
  assert.match(verifyErrorText({ error: "no_session" }), /התחברו מחדש/);
  assert.match(verifyErrorText({ error: "network" }), /נסו שוב/);
  assert.match(verifyErrorText(undefined), /נסו שוב/);
  for (const e of ["wrong", "locked", "expired", "none", "format", "no_session", "network"]) {
    assert.doesNotMatch(verifyErrorText({ error: e, left: 2 }), /[a-z]{3,}/i, e);
  }
});

test("sentText / needsNewCode", () => {
  assert.equal(sentText({ status: "sent", email: "a@parkomat.co.il" }), "שלחנו קוד בן 4 ספרות אל a@parkomat.co.il");
  // ⚠️ בלי נקודה אחרי הכתובת: במשפט RTL היא נדבקת לקצה השמאלי של הכתובת ונקראת "a."
  assert.doesNotMatch(sentText({ status: "pending", email: "a@parkomat.co.il" }), /[.]$/, "נקודה אחרי הכתובת");
  assert.equal(sentText({ status: "pending", email: "a@parkomat.co.il" }), "הקוד כבר נשלח (תקף 10 דקות) אל a@parkomat.co.il");
  assert.match(sentText(null, "b@parkomat.co.il"), /b@parkomat\.co\.il/);
  assert.match(sentText(null, null), /המייל שלך/);
  assert.equal(needsNewCode({ error: "locked" }), true);
  assert.equal(needsNewCode({ error: "expired" }), true);
  assert.equal(needsNewCode({ error: "none" }), true);
  assert.equal(needsNewCode({ error: "wrong", left: 2 }), false);
});
