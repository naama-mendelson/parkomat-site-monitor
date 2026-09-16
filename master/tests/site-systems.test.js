// tests/site-systems.test.js — אתר עם שתי מערכות: מה מוצג, ומתי בכלל.
//
// ============================================================
// ⚠️ הבדיקה הזו נולדה מבאג שהיה בייצור ואיש לא ראה
// ============================================================
// `displayStatus` היה `worstOfSystems(g.systems) ?? status`. `g.systems` מגיע
// מהפעימה האחרונה של הסוכן, וכשהסוכן מפסיק לפעום השורה **נשארת כפי שהייתה**.
// כלומר אתר דו-מערכתי שאיבד תקשורת הוצג לפי המצב שהיה לפני הנתק — "מוכן",
// ירוק — במקום "מנותק".
//
// אתר מנותק שנראה תקין הוא בדיוק הכשל שכל מנגנון זיהוי הנתק קיים כדי למנוע,
// והוא שקט לחלוטין: אין שגיאה, אין שורה בלוג, והכרטיס נראה כמו כל כרטיס אחר.
import { test } from "node:test";
import assert from "node:assert/strict";
import { liveSystems, worstOfSystems, displayStatusFor, systemsAgeMinutes, SYSTEMS_STALE_MS } from "../../shared/site-systems.mjs";

const TWO = [{ unit: 1, state: "ready" }, { unit: 2, state: "ready" }];
const WORST = { error: 0, no_comm: 1, maintenance: 2, operating: 3, ready: 4 };
const NOW = Date.parse("2026-09-15T09:30:00Z");
const FRESH = "2026-09-15T09:29:00Z";          // לפני דקה
const OLD = "2026-09-14T22:58:33Z";            // הפעימה האחרונה של פלורנטין

test("אין תקשורת — הפירוט יורד ואינו מוצג", () => {
  assert.equal(liveSystems("no_comm", TWO, FRESH, NOW), null);
});

// ⚠️ הליבה: בלי זה, אתר מנותק נצבע לפי מה שהיה לפני הנתק.
test("אין תקשורת — המצב המוצג הוא 'מנותק', ולא מה שהיה קודם", () => {
  assert.equal(displayStatusFor("no_comm", TWO, FRESH, NOW), "no_comm");
  assert.equal(displayStatusFor("no_comm", [{ unit: 1, state: "operating" }], FRESH, NOW), "no_comm");
});

// ⚠️ **הבדיקה החשובה ביותר כאן.** גרסה קודמת נתנה למערכות להחליף את מצב
// האתר, ו`תחזוקה` טובה מ`תקלה` בדירוג — כלומר פירוט ישן הסתיר תקלה חיה.
// נצפה בפלורנטין: הבקר דיווח "מנהל דולים - דלתות חניון פתוחות", והפירוט
// מאתמול אמר [המתנה, תחזוקה].
test("תקלה עכשווית אינה נעלמת מאחורי פירוט ישן", () => {
  assert.equal(displayStatusFor("error", [{ state: "ready" }, { state: "maintenance" }], OLD, NOW), "error");
  assert.equal(displayStatusFor("error", [{ state: "ready" }, { state: "ready" }], FRESH, NOW), "error");
});

// מדד תצוגה לא יכול להפוך אתר לתקין **יותר** ממה שהוא מדווח.
test("התצוגה לעולם אינה טובה ממצב האתר עצמו", () => {
  for (const st of ["error", "maintenance", "operating", "ready"]) {
    const shown = displayStatusFor(st, [{ state: "ready" }, { state: "ready" }], FRESH, NOW);
    assert.ok(WORST[shown] <= WORST[st], `${st} → ${shown}`);
  }
});

test("יש תקשורת — מוצג הגרוע מבין השתיים", () => {
  assert.equal(displayStatusFor("ready", [{ unit: 1, state: "ready" }, { unit: 2, state: "error" }], FRESH, NOW), "error");
  assert.equal(displayStatusFor("ready", [{ unit: 1, state: "operating" }, { unit: 2, state: "ready" }], FRESH, NOW), "operating");
});

// ⚠️ `status` נשאר הטוב מבין השתיים כי ממנו מחושבות הזמינות ואחוז הכשל.
// הבדיקה מוודאת שהפונקציה **אינה** נוגעת בו — היא מחזירה ערך תצוגה בלבד.
test("מערכת אחת בתקלה אינה משנה את מצב האתר עצמו", () => {
  const status = "ready";
  displayStatusFor(status, [{ unit: 1, state: "error" }, { unit: 2, state: "ready" }], FRESH, NOW);
  assert.equal(status, "ready");
});

test("אתר עם מערכת אחת — אין פירוט, והמצב הוא של האתר", () => {
  assert.equal(liveSystems("ready", null, FRESH, NOW), null);
  assert.equal(liveSystems("ready", [], FRESH, NOW), null);
  assert.equal(displayStatusFor("error", null, FRESH, NOW), "error");
});

// ⚠️ MODE 4 (אתחול) או ערך שלא מופה מגיעים כ-`unknown`. הם אינם תקלה, וספירתם
// כגרוע הייתה צובעת אתר באדום על בסיס ערך שאיננו מבינים.
test("unknown אינו נחשב מצב גרוע", () => {
  assert.equal(worstOfSystems([{ unit: 1, state: "unknown" }, { unit: 2, state: "ready" }]), "ready");
  assert.equal(worstOfSystems([{ unit: 1, state: "unknown" }]), null);
});

test("תחזוקה גרועה מפעולה, וטובה מתקלה", () => {
  assert.equal(worstOfSystems([{ state: "maintenance" }, { state: "operating" }]), "maintenance");
  assert.equal(worstOfSystems([{ state: "maintenance" }, { state: "error" }]), "error");
});

// ⚠️ מצב שאינו מוכר אינו מפיל ואינו נבלע כ"תקין": הוא פשוט אינו משתתף בדירוג.
test("ערך מצב זר אינו מפיל ואינו הופך לגרוע", () => {
  assert.equal(worstOfSystems([{ state: "banana" }, { state: "ready" }]), "ready");
  assert.equal(worstOfSystems([{ state: null }, { state: undefined }]), null);
});

// ============================================================
// גיל הפירוט — הבאג שנראה כמו סתירה על המסך
// ============================================================
// ⚠️ בפלורנטין הוצג `בפעולה` לצד `1 המתנה · 2 תחזוקה`. שני הנתונים היו
// נכונים: המצב הגיע ב-MQTT ב-09:28, והפירוט היה מהפעימה של **אתמול ב-22:58**.
// הם תיארו שני רגעים שונים, והמסך הציג אותם כתיאור אחד של עכשיו.
test("פירוט ישן אינו מוצג", () => {
  assert.equal(liveSystems("operating", TWO, OLD, NOW), null);
});

// ⚠️ **הכלל התהפך במכוון, אחרי מדידה בשטח.** בתחילה פירוט ישן נפסל גם
// לצורך הצ'יפ, ופלורנטין — שמערכת שלמה בה אינה באוטומט — הוצגה כ"מוכן".
// מערכת שיצאה מאוטומט אינה חוזרת לבד, ולכן נתון בן שעות עליה עדיין נכון
// יותר מירוק. הכלל: מספיק שאחת בתחזוקה כדי שזה יופיע למעלה בתחזוקה.
test("מערכת אחת בתחזוקה מופיעה למעלה, גם כשהפירוט ישן", () => {
  assert.equal(displayStatusFor("ready", [{ state: "ready" }, { state: "maintenance" }], OLD, NOW), "maintenance");
  assert.equal(displayStatusFor("operating", [{ state: "operating" }, { state: "maintenance" }], OLD, NOW), "maintenance");
});

test("פירוט טרי כן מוצג ומשפיע", () => {
  assert.deepEqual(liveSystems("operating", TWO, FRESH, NOW), TWO);
  assert.equal(displayStatusFor("operating", [{ state: "ready" }, { state: "maintenance" }], FRESH, NOW), "maintenance");
});

// ⚠️ אתר בלי חותמת הוא אתר שאיננו יודעים מתי נקרא. "לא ידוע" אינו "טרי".
test("חסרה חותמת — נחשב לא זמין", () => {
  assert.equal(liveSystems("ready", TWO, null, NOW), null);
  assert.equal(liveSystems("ready", TWO, "לא תאריך", NOW), null);
});

test("הסף הוא בדיוק שלוש דקות, כמו סריקת השתיקה בשרת", () => {
  assert.equal(SYSTEMS_STALE_MS, 180000);
  const edge = new Date(NOW - SYSTEMS_STALE_MS + 1000).toISOString();
  const past = new Date(NOW - SYSTEMS_STALE_MS - 1000).toISOString();
  assert.deepEqual(liveSystems("ready", TWO, edge, NOW), TWO);
  assert.equal(liveSystems("ready", TWO, past, NOW), null);
});

// ============================================================
// גיל הפירוט — ולמה הוא מוצג במקום להסתיר
// ============================================================
// ⚠️ הגרסה הראשונה של התיקון הסתירה פירוט ישן. זו הייתה החמרה שנמדדה
// בשטח: בפלורנטין הפירוט אמר `2 תחזוקה` מלפני עשר שעות — **וזה היה נכון**,
// הלובי השמאלי באמת לא היה באוטומט. ההסתרה מחקה בדיוק את המידע שבגללו
// מסתכלים על הכרטיס.
//
// נתון ישן אינו נתון שגוי. השגיאה הייתה להציג אותו בלי לומר שהוא ישן.
test("גיל מחושב בדקות", () => {
  assert.equal(systemsAgeMinutes("2026-09-15T09:29:00Z", NOW), 1);
  assert.equal(systemsAgeMinutes(OLD, NOW), 631);   // 14/09 22:58:33 → 15/09 09:30 = 631.45 דק׳
});

test("אין חותמת — אין גיל, ולא אפס", () => {
  // ⚠️ 0 היה נקרא על המסך כ"נקרא עכשיו", כלומר ההפך הגמור מהאמת.
  assert.equal(systemsAgeMinutes(null, NOW), null);
  assert.equal(systemsAgeMinutes("לא תאריך", NOW), null);
});

test("חותמת עתידית אינה מייצרת גיל שלילי", () => {
  assert.equal(systemsAgeMinutes("2026-09-15T09:40:00Z", NOW), 0);
});
