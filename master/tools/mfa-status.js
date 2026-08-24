// mfa-status.js — מי כבר רשום לאימות דו-שלבי, ומה מצב האכיפה.
//
// ⚠️ קיים כדי שההחלטה "אפשר להדליק" תתקבל ממדידה ולא מהערכה. הדלקת
// הדגל בזמן שמנהל אחד אינו רשום נועלת אותו מניהול האתרים, ואין שום
// חיווי שיאמר זאת מראש — הוא פשוט יקבל 403 בפעם הבאה שילחץ.
const db = require("../db/db");

(async () => {
  await db.init();

  const rows = await db.prepare(`
    SELECT u.email,
           u.role,
           u.is_active,
           COUNT(f.id) FILTER (WHERE f.status = 'verified') AS verified
      FROM app_users u
      LEFT JOIN auth.mfa_factors f ON f.user_id = u.supabase_uid
     GROUP BY u.email, u.role, u.is_active
     ORDER BY (COUNT(f.id) FILTER (WHERE f.status = 'verified')) DESC, u.email
  `).all();

  const flag = await db.prepare(
    "SELECT value FROM settings WHERE key = 'mfa_required_for_manager'"
  ).get();
  const on = String(flag?.value).toLowerCase() === "true";

  console.log("=== מי רשום לאימות דו-שלבי ===\n");
  let ready = 0, missing = [];
  for (const r of rows) {
    const has = Number(r.verified) > 0;
    if (!r.is_active) continue;             // מושבת אינו נכנס ממילא
    if (has) ready++; else missing.push(r.email.split("@")[0]);
    console.log(`  ${has ? "✅" : "⬜"} ${String(r.email.split("@")[0]).padEnd(12)} ${r.role}`);
  }

  const total = ready + missing.length;
  console.log(`\n  ${ready}/${total} רשומים`);
  console.log(`  מצב האכיפה: ${on ? "🔒 דלוקה" : "🔓 כבויה"}`);

  if (!on && missing.length === 0 && total > 0) {
    console.log("\n  ✅ כולם רשומים — אפשר להדליק את האכיפה.");
  } else if (!on) {
    console.log(`\n  ⏳ חסרים: ${missing.join(", ")}`);
    console.log("  ⚠️ הדלקה עכשיו תנעל אותם מניהול אתרים ומניהול משתמשים.");
  } else if (missing.length) {
    // ⚠️ המצב הגרוע: אכיפה דלוקה ומישהו אינו רשום — הוא כבר נעול.
    console.log(`\n  ❌ האכיפה דלוקה אבל ${missing.join(", ")} אינם רשומים — הם נעולים כרגע.`);
  }
  process.exit(0);
})();
