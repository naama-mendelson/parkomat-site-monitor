// tools/check-no-residue.js — השערים אינם מותירים עקבות בייצור.
//
// ============================================================
// ⚠️ למה זה שער בפני עצמו
// ============================================================
// השערים רצים מול **בסיס הנתונים של הייצור** — אין ברירה, כי זה מה שהם
// באים לאמת. המחיר הוא שכל דבר שהם יוצרים ולא מוחקים הופך לנתון אמיתי
// לכל דבר: מופיע במסך, נספר במדדים, ומבלבל את מי שקורא את הלוג.
//
// ⚠️ **נמדד:** 62 חלונות תחזוקה ו-297 שורות ביקורת הצטברו על אתר 1284
// לפני שנוקו ידנית. הם הופיעו בלוג הפעילות של אתר אמיתי כ"תחזוקה הופעלה"
// בידי `wcheck…@parkomat.co.il` — פעולות שאיש לא עשה.
//
// ⚠️ ו-check-writes **כן** ניקה — אבל רק את האתר שהוא יצר. את חלונות
// התחזוקה הוא פתח על אתר **אמיתי** (הראשון במסד), ואותם הוא לא מחק.
const PATTERN = "(wcheck|gate|permcheck|rcheck|dropcheck)[0-9]";

(async () => {
  const db = require("../db/db");
  await db.init();

  const checks = [];
  const add = (name, got) => checks.push([name, got]);

  // ⚠️ התבנית דורשת ספרה אחרי הקידומת — כל השערים מוסיפים חותם זמן.
  // בלעדיה, מילה כמו "gate" הייתה יכולה לתפוס כתובת של אדם אמיתי.
  const q = async (sql, ...args) => (await db.prepare(sql).get(...args)).n;

  add("משתמשים סינתטיים",
    await q("SELECT COUNT(*)::int AS n FROM app_users WHERE email ~ ?", PATTERN));
  add("⚠️ חלונות תחזוקה (מופיעים בלוג!)",
    await q("SELECT COUNT(*)::int AS n FROM maintenance_windows WHERE set_by_name ~ ?", PATTERN));
  add("שורות ביקורת",
    await q("SELECT COUNT(*)::int AS n FROM audit_log WHERE actor_name ~ ?", PATTERN));
  add("אירועים",
    await q("SELECT COUNT(*)::int AS n FROM events WHERE payload::text ~ ?", PATTERN));
  add("זריקות בדיקה",
    await q("SELECT COUNT(*)::int AS n FROM ingest_drops WHERE topic ~ ? OR site_code = ?", "dropcheck", "__drop"));
  // אתרי בדיקה: check-writes יוצר `zz-<חותם>`.
  add("אתרי בדיקה",
    await q("SELECT COUNT(*)::int AS n FROM sites WHERE code ~ ?", "^zz-"));

  // ⚠️ ויתומים: משתמש auth שנמחק בלי שורת app_users, או להפך. זה בדיוק
  // מה ש-check-writes צד — כאן זו רק ההשלמה מהכיוון של השערים עצמם.
  console.log("סוג עקבה                                  נמצאו   צפוי");
  let bad = 0;
  for (const [name, n] of checks) {
    if (n !== 0) bad++;
    console.log(`${name.padEnd(40)} ${String(n).padStart(6)}      0  ${n === 0 ? "✅" : "❌"}`);
  }
  console.log("");
  if (bad) {
    console.log(`❌ ${bad} סוגי עקבות נשארו בייצור`);
    console.log("   השער שיצר אותם חייב למחוק אותם ב-finally, לא רק במסלול ההצלחה.");
  } else {
    console.log("✅ השערים אינם מותירים עקבות");
  }
  process.exit(bad ? 1 : 0);
})().catch((err) => {
  console.error("check-no-residue: נפל —", err.message);
  process.exit(1);
});
