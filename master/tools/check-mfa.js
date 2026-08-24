// check-mfa.js — האם הגורם השני באמת אוכף, ומי פטור ממנו.
//
// ============================================================
// ⚠️ למה שער התנהגותי ולא בדיקת יחידה
// ============================================================
// המסך ב-AuthGate אינו אבטחה — הוא נפתח מחדש בכלי פיתוח, ו-PostgREST
// מקבל בקשות בלי שום דשבורד. הדבר היחיד שמגן הוא `app.require_mfa()`
// בתוך `app.require_manager()`, והדרך היחידה להוכיח שהוא שם היא לקרוא
// ל-RPC אמיתי עם אסימון אמיתי ב-aal1 ולראות 403.
//
// ⚠️ **והשער מדליק את הדגל ומכבה אותו בכל מסלול יציאה, כולל כישלון.**
// דגל שנשאר דלוק חוסם את שמונת המנהלים מניהול אתרים — כלומר שער שנפל
// באמצע היה מייצר תקלה מלאה בייצור.
const fs = require("fs");
const path = require("path");
const db = require("../db/db");
const { gateToken } = require("./lib/gate-user");
const { totp } = require("./lib/totp");

const SB = process.env.SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const ANON = (fs.readFileSync(path.join(__dirname, "..", "..", "dashboard", ".env"), "utf8")
  .match(/^VITE_SUPABASE_PUBLISHABLE_KEY=(.*)$/m) || [])[1]?.trim();

async function f(url, opt) {
  let last;
  for (let i = 0; i < 5; i++) {
    try { return await fetch(url, opt); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 600)); }
  }
  throw last;
}

const FLAG = "mfa_required_for_manager";
const setFlag = (v) => db.prepare(
  "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) " +
  "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at"
).run(FLAG, String(v), new Date().toISOString());

(async () => {
  await db.init();
  const before = await db.prepare("SELECT value FROM settings WHERE key = ?").get(FLAG);
  const { token, cleanup: dropUser } = await gateToken(SB, ANON, SECRET, f);

  const checks = [];
  const restore = async () => {
    // ⚠️ מחזירים למצב שנמצא, ולא ל-false קשיח: אם מישהו כבר הדליק את
    // האכיפה, שער בדיקה שמכבה אותה מוריד את האבטחה בשקט.
    await setFlag(before ? before.value : "false");
    await dropUser();
  };

  const rpc = async (fn, body) => {
    const r = await f(`${SB}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    return { status: r.status, text: await r.text() };
  };

  try {
    // רמת האסימון שנוצר — סיסמה בלבד.
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
    console.log(`אסימון השער: aal=${claims.aal} · amr=${JSON.stringify((claims.amr || []).map((x) => x.method || x))}`);
    checks.push(["האסימון אכן aal1 (סיסמה בלבד)", claims.aal === "aal1"]);

    // ---- דגל כבוי: מנהל עובד כרגיל ----
    await setFlag(false);
    const off = await rpc("list_users");
    console.log(`\nדגל כבוי  → list_users: ${off.status}`);
    checks.push(["דגל כבוי — מנהל ב-aal1 עובד", off.status === 200]);

    // ---- דגל דלוק: אותו מנהל, אותו אסימון, נחסם ----
    await setFlag(true);
    const on = await rpc("list_users");
    console.log(`דגל דלוק  → list_users: ${on.status}  ${on.text.slice(0, 90)}`);
    checks.push(["דגל דלוק — מנהל ב-aal1 נחסם", on.status === 403]);
    checks.push(["ההודעה מסבירה שנדרש אימות דו-שלבי", /דו-שלבי/.test(on.text)]);

    // ---- ופעולה הרסנית באמת ----
    const del = await rpc("delete_site", { p_code: "__no_such_site__" });
    console.log(`דגל דלוק  → delete_site: ${del.status}`);
    // ⚠️ 403 ולא 404: החסימה חייבת לקדום לחיפוש האתר, אחרת קוד אתר
    // אמיתי היה נמחק לפני שמישהו בדק אם יש גורם שני.
    checks.push(["מחיקת אתר נחסמת לפני החיפוש (403, לא 404)", del.status === 403]);

    // ---- והשרת עצמו פטור, גם כשהדגל דלוק ----
    let serverOk = true;
    try { await db.prepare("SELECT app.require_mfa()").get(); } catch { serverOk = false; }
    console.log(`דגל דלוק  → קריאה מהשרת (בלי אסימון): ${serverOk ? "עברה" : "נחסמה"}`);
    checks.push(["⚠️ השרת פטור — הקליטה אינה נעצרת", serverOk]);

    // ============================================================
    // המחזור המלא — ובלעדיו השער מוכיח רק חצי
    // ============================================================
    // ⚠️ עד כאן הוכח שהחסימה קיימת. **זה לא מספיק:** חסימה שאין דרך
    // לעבור אותה אינה אבטחה אלא נעילה של כולם בחוץ — והיא הייתה נראית
    // ירוקה בדיוק אותו הדבר. כאן נרשם גורם אמיתי, נחשב קוד אמיתי,
    // ומוודאים שאותו מנהל שנחסם שורה אחת למעלה — עובר.
    const auth = (u, body, tk) => f(`${SB}/auth/v1${u}`, {
      method: "POST",
      headers: { apikey: ANON, Authorization: `Bearer ${tk || token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const lvlOf = (t) => JSON.parse(Buffer.from(t.split(".")[1], "base64").toString());

    const enrolled = await (await auth("/factors", { factor_type: "totp", friendly_name: "gate" })).json();
    const secret = enrolled?.totp?.secret;
    checks.push(["רישום גורם שני מחזיר מפתח", Boolean(secret)]);

    if (secret) {
      const ch = await (await auth(`/factors/${enrolled.id}/challenge`, {})).json();
      const ver = await (await auth(`/factors/${enrolled.id}/verify`,
        { challenge_id: ch.id, code: totp(secret) })).json();
      const aal2Token = ver?.access_token || null;
      const lvl = aal2Token ? lvlOf(aal2Token) : {};
      console.log(`  אחרי אימות הקוד: aal=${lvl.aal} · amr=${JSON.stringify((lvl.amr || []).map((x) => x.method || x))}`);
      checks.push(["קוד TOTP אמיתי מעלה ל-aal2", lvl.aal === "aal2"]);

      if (aal2Token) {
        const okNow = await f(`${SB}/rest/v1/rpc/list_users`, {
          method: "POST",
          headers: { apikey: ANON, Authorization: `Bearer ${aal2Token}`, "Content-Type": "application/json" },
          body: "{}",
        });
        console.log(`  דגל דלוק  → list_users עם aal2: ${okNow.status}`);
        checks.push(["⚠️ דגל דלוק — מנהל ב-aal2 **עובר**", okNow.status === 200]);
      }
    }

    console.log("\n" + "=".repeat(52));
    let bad = 0;
    for (const [n, ok] of checks) { if (!ok) bad++; console.log(`  ${ok ? "✅" : "❌"} ${n}`); }
    console.log("=".repeat(52));

    await restore();
    const now = await db.prepare("SELECT value FROM settings WHERE key = ?").get(FLAG);
    console.log(`הדגל הוחזר ל: ${now?.value ?? "(לא קיים)"}`);
    console.log(bad ? `❌ ${bad} כשלים` : "✅ הכל עבר");
    process.exit(bad ? 1 : 0);
  } catch (e) {
    console.error("שגיאה:", e.message);
    await restore();
    process.exit(1);
  }
})();
