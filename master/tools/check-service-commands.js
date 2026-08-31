// tools/check-service-commands.js — הכפתור "הפעל מחדש את השרת", מקצה לקצה.
//
// ============================================================
// ⚠️ למה שער ולא בדיקת יחידה
// ============================================================
// המסלול חוצה שלושה גבולות: דפדפן → RPC ב-Postgres → סקריפט על מכונת
// השרת. בדיקת יחידה לא נוגעת באף אחד מהם, וכפתור חירום שלא הופעל
// מעולם הוא בדיוק סוג הנתיב הרדום שקובץ ההנחיות מזהיר שמרקיב — ומגלים
// שהוא שבור ביום שבו הוא נחוץ.
//
// ⚠️ **הכול בטרנזקציה שמתגלגלת אחורה.** הפונקציות נבדקות על מסד הייצור
// כי שם הן ירוצו, אבל בקשת הפעלה מחדש שנשארת ב-pending הייתה גורמת
// למשימה המתוזמנת על DELL008 להפעיל את השרת מחדש באמת — כלומר שער
// שמפיל את הייצור. הזהות מוזרקת דרך ה-GUC `app.user_id`, אותה עקיפה
// ש-check-writes משתמשת בה.
const db = require("../db/db.js");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
};

(async () => {
  await db.init();
  console.log("=== check-service-commands ===\n");

  const mgr = await db.prepare(
    `SELECT id, supabase_uid::text AS uid, full_name FROM app_users
      WHERE role='manager' AND is_active AND supabase_uid IS NOT NULL LIMIT 1`).get();
  const op = await db.prepare(
    `SELECT id, supabase_uid::text AS uid FROM app_users
      WHERE role<>'manager' AND is_active AND supabase_uid IS NOT NULL LIMIT 1`).get();

  if (!mgr) {
    console.log("❌ אין מנהל פעיל עם supabase_uid — לא ניתן לבדוק.");
    process.exit(2);
  }

  // ⚠️ הגלילה היא דרך חריגה מכוונת, כמו ב-check-writes: db.transaction
  // מגלגל על exception. ROLLBACK מפורש שנשכח היה משאיר בקשה אמיתית.
  const SENTINEL = new Error("__rollback__");
  try {
    await db.transaction(async () => {
      // ⚠️ בלי ארגומנט: db.transaction משתמש ב-AsyncLocalStorage, כלומר
      // db.prepare בתוך ה-callback כבר רץ על לקוח הטרנזקציה.
      const q = (sql, ...args) => db.prepare(sql).all(...args);
      const one = (sql, ...args) => db.prepare(sql).get(...args);

      const beAs = async (uid) => { await one("SELECT set_config('app.user_id', ?, true) AS s", uid); };

      // ============================================================
      // ⚠️ מנקים פקודה פתוחה **אמיתית** לפני שמתחילים
      // ============================================================
      // הריסון מחזיר את הפקודה הפתוחה במקום ליצור חדשה — וזו התנהגות
      // נכונה. אבל אם בייצור יש בקשה תלויה (למשל כי המבצע אינו רץ),
      // השער קיבל אותה וכל הבדיקות שאחריה בדקו את הפקודה הלא נכונה.
      //
      // ⚠️ נמדד: בקשה #15 מ-31/08 07:36 שהמשתמשת שלחה ושאיש לא ביצע.
      // השער דיווח כישלון על **מצב ייצור**, לא על באג — וזה בדיוק סוג
      // הרעש שגורם להפסיק להאמין לשער.
      //
      // הניקוי בתוך הטרנזקציה שמתגלגלת אחורה, ולכן הבקשה האמיתית
      // שורדת ותבוצע כשהמבצע יחזור.
      await db.prepare(
        "UPDATE service_commands SET status = 'expired' WHERE status IN ('pending','running')").run();

      // ---------- 1. מנהלת יכולה לבקש ----------
      await beAs(mgr.uid);
      const r1 = (await q("SELECT * FROM request_service_restart(?)", "בדיקת שער"))[0];
      ok("מנהלת מקבלת בקשה", r1 && r1.status === "pending", JSON.stringify(r1));

      const row = await one("SELECT * FROM service_commands WHERE id = ?", r1.id);
      ok("נוצרה שורה עם הפרטים הנכונים",
        row && row.command === "restart" && row.status === "pending" && row.reason === "בדיקת שער");

      // ---------- 2. ⚠️ הריסון — לחיצה שנייה אינה יוצרת בקשה שנייה ----------
      // בלי זה חמש לחיצות של מי שלא רואה תוצאה מיידית הן חמש הפעלות
      // מחדש ברצף, כלומר הכפתור שנועד להציל הופך למי שמפיל.
      const before = (await one("SELECT COUNT(*)::int AS n FROM service_commands")).n;
      const r2 = (await q("SELECT * FROM request_service_restart(?)", "שוב"))[0];
      const after = (await one("SELECT COUNT(*)::int AS n FROM service_commands")).n;
      ok("לחיצה חוזרת אינה יוצרת בקשה נוספת", before === after, `${before} → ${after}`);
      ok("ומחזירה את הבקשה הפתוחה", r2 && Number(r2.id) === Number(r1.id));

      // ============================================================
      // ⚠️ בדיקת דחייה חייבת SAVEPOINT
      // ============================================================
      // ב-Postgres, שגיאה בתוך טרנזקציה מבטלת את **כולה** — כל פקודה
      // אחריה מקבלת "current transaction is aborted". כלומר בדיקה
      // שמצפה לדחייה הורגת את כל מה שבא אחריה, וזה בדיוק מה שקרה כאן.
      // SAVEPOINT מגביל את הביטול לבדיקה עצמה.
      const expectReject = async (label, fn) => {
        await db.prepare("SAVEPOINT sp_reject").run();
        let blocked = false;
        try { await fn(); }
        catch { blocked = true; }
        await db.prepare("ROLLBACK TO SAVEPOINT sp_reject").run();
        await db.prepare("RELEASE SAVEPOINT sp_reject").run();
        ok(label, blocked);
      };

      // ---------- 3. אופרטור נדחה ----------
      if (op) {
        await beAs(op.uid);
        await expectReject("אופרטור נדחה",
          () => q("SELECT * FROM request_service_restart(?)", "לא אמור לעבור"));
      } else {
        console.log("  ⏭️  אין אופרטור פעיל — דילוג על בדיקת ההרשאה");
      }

      // ---------- 4. אנונימי נדחה ----------
      // ⚠️ הבדיקה החשובה מכולן: המפתח הציבורי נמצא בכל דפדפן. אם זה
      // עובר, כל אדם באינטרנט יכול להפיל את השרת בלולאה.
      await beAs("");
      await expectReject("אנונימי נדחה",
        () => q("SELECT * FROM request_service_restart(?)", "אנונימי"));

      // חוזרים לזהות המנהלת להמשך המסלול.
      await beAs(mgr.uid);

      // ---------- 5. המבצע תופס ----------
      const claimed = (await q("SELECT * FROM claim_service_command()"))[0];
      ok("המבצע תופס את הפקודה", claimed && Number(claimed.id) === Number(r1.id));

      const running = await one("SELECT status FROM service_commands WHERE id = ?", r1.id);
      ok("הסטטוס עבר ל-running", running && running.status === "running");

      // ⚠️ תפיסה שנייה לא תחזיר את אותה פקודה — אחרת שני מבצעים היו
      // מריצים שתי הפעלות מחדש במקביל על אותה בקשה.
      const again = await q("SELECT * FROM claim_service_command()");
      ok("תפיסה שנייה אינה מחזירה את אותה פקודה", again.length === 0);

      // ---------- 6. סיום ----------
      const done = (await q("SELECT * FROM complete_service_command(?, ?, ?)",
        r1.id, true, "בוצע בבדיקה"))[0];
      ok("הסיום מעדכן שורה אחת", Number(done.updated) === 1);

      const fin = await one("SELECT status, result, finished_at FROM service_commands WHERE id = ?", r1.id);
      ok("הסטטוס done והתוצאה נשמרה",
        fin && fin.status === "done" && fin.result === "בוצע בבדיקה" && fin.finished_at);

      // ⚠️ סיום כפול אינו מעדכן שוב: דיווח שהגיע פעמיים (ניסיון חוזר
      // ברשת) לא ידרוס תוצאה שכבר נרשמה.
      const twice = (await q("SELECT * FROM complete_service_command(?, ?, ?)",
        r1.id, false, "לא אמור לדרוס"))[0];
      ok("סיום כפול אינו דורס", Number(twice.updated) === 0);

      // ============================================================
      // ⚠️ 7. בקשה תקועה **אינה** נועלת את הכפתור
      // ============================================================
      // הפקיעה ישבה רק ב-claim_service_command, שאותה קורא המבצע בלבד.
      // כשהמבצע אינו רץ, הבקשה נשארת pending לנצח והריסון מסרב ליצור
      // חדשה — כלומר **כפתור החירום נועל את עצמו בדיוק כשצריך אותו**.
      //
      // נמדד בייצור: בקשה #12 מ-30/08 16:27 נשארה תלויה יומיים.
      await beAs(mgr.uid);
      const oldStamp = new Date(Date.now() - 30 * 60000).toISOString();
      await db.prepare(
        `INSERT INTO service_commands (command, status, reason, requested_by, requested_at)
         VALUES ('restart', 'pending', 'תקועה', ?, ?)`).run(mgr.uid, oldStamp);

      const afterStuck = (await q("SELECT * FROM request_service_restart(?)", "אחרי תקיעה"))[0];
      ok("בקשה ישנה אינה נועלת את הכפתור",
        afterStuck && afterStuck.status === "pending" && afterStuck.message.includes("נשלחה"),
        JSON.stringify(afterStuck));

      const expired = await one(
        "SELECT status FROM service_commands WHERE reason = ?", "תקועה");
      ok("והישנה סומנה כפגה", expired && expired.status === "expired", expired?.status);

      // מנקים את החדשה כדי שההמשך יעבוד על הפקודה המקורית
      await db.prepare("UPDATE service_commands SET status='expired' WHERE id = ?")
        .run(afterStuck.id);

      // ---------- 8. בדיקת חיבור — אותו מסלול, בלי להפיל כלום ----------
      const ping = (await q("SELECT * FROM request_service_ping()"))[0];
      ok("בדיקת חיבור נוצרת", ping && ping.status === "pending");
      const pingRow = await one("SELECT command FROM service_commands WHERE id = ?", ping.id);
      ok("והיא מסוג ping ולא restart", pingRow && pingRow.command === "ping", pingRow?.command);
      await db.prepare("UPDATE service_commands SET status='expired' WHERE id = ?").run(ping.id);

      // ---------- 9. מצב המבצע ----------
      const health = await one("SELECT * FROM service_health()");
      ok("service_health עונה", health !== undefined && health !== null);



      throw SENTINEL;
    });
  } catch (e) {
    if (e !== SENTINEL) throw e;
  }

  // ---------- 7. הכול התגלגל אחורה ----------
  // ⚠️ הבדיקה האחרונה ולא הראשונה, ובכוונה: שער שמותיר בקשת הפעלה
  // מחדש בייצור יגרום למשימה על DELL008 להפיל את השרת באמת.
  const left = await db.prepare(
    "SELECT COUNT(*)::int AS n FROM service_commands WHERE reason IN (?, ?, ?)")
    .get("בדיקת שער", "שוב", "אנונימי");
  ok("לא נותרו שאריות בייצור", left.n === 0, `נותרו ${left.n}`);

  console.log(`\nעברו ${pass} · נפלו ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("שגיאה:", e.message); process.exit(1); });
