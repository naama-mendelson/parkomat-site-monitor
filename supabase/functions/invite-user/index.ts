// supabase/functions/invite-user — יצירת משתמש חדש, בלי השרת.
//
// ============================================================
// למה זה עבר לכאן
// ============================================================
// זו הייתה אחת משתי הפעולות היחידות שנשארו ב-master, ומסיבה טובה: היא
// דורשת את ה-**Secret key**, שאסור שיגיע לדפדפן לעולם.
//
// ⚠️ אבל מרגע שהדשבורד עבר ל-Cloudflare, ה-master אינו נגיש ממנו — הוא
// מאחורי NAT, ובלי כתובת ציבורית. התוצאה על המסך הייתה "הזמנת המשתמש
// נכשלה", בלי רמז לסיבה.
//
// Edge Function פותרת את שניהם: הסוד נשאר בצד השרת, והפונקציה נגישה
// מכל מקום.
//
// ============================================================
// ⚠️ אימות התפקיד — הדבר הקריטי בקובץ הזה
// ============================================================
// הפונקציה מחזיקה את ה-Secret, כלומר יש לה כוח ליצור משתמשים. בלי בדיקת
// תפקיד, **כל מי שמחזיק את המפתח הציבורי** (כלומר כל מי שפתח את האתר)
// היה יכול ליצור לעצמו חשבון מנהל.
//
// ⚠️ והבדיקה נעשית מול המסד ולא מול האסימון: `my_role()` קורא מ-app_users,
// שהוא מקור האמת. מנהל שהורד לבקר לפני חמש דקות עדיין נושא אסימון שאומר
// 'manager' עד שיפוג — והוא לא ייצור כאן משתמשים.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const ROLES = ["manager", "operator"];

// ⚠️ אותו כלל שהמסד אוכף בטריגר. הבדיקה כאן אינה מחליפה אותו — היא רק
// נותנת הודעה מובנת במקום שגיאת מסד גולמית.
const DOMAIN = "@parkomat.co.il";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...cors, "content-type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "נדרשת הזדהות" }, 401);

  // ⚠️ לקוח בזהות **הקורא**, לא בזהות השירות: כך my_role() רואה את מי
  // ששלח את הבקשה. לקוח service_role היה עוקף RLS ומחזיר תשובה חסרת משמעות.
  const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: role, error: roleErr } = await asCaller.rpc("my_role");
  if (roleErr) return json({ error: "אימות נכשל" }, 401);
  if (role !== "manager") return json({ error: "הפעולה מותרת למנהלים בלבד" }, 403);

  const body = await req.json().catch(() => null);
  const email = String(body?.email ?? "").trim().toLowerCase();
  const wantRole = String(body?.role ?? "operator");

  if (!email.includes("@")) return json({ error: "כתובת מייל לא תקינה" }, 400);
  if (!email.endsWith(DOMAIN)) return json({ error: `כתובת חייבת להיות ${DOMAIN}` }, 400);
  if (!ROLES.includes(wantRole)) return json({ error: "תפקיד לא תקין" }, 400);

  // ⚠️ סיסמה זמנית אקראית, ולא קבועה: היא מוצגת פעם אחת למזמין והוא
  // מעביר אותה. קבועה הייתה הופכת כל חשבון חדש לניתן לניחוש.
  const tempPassword = "Pk-" + crypto.randomUUID().slice(0, 12) + "!9";

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // ⚠️ parkomat_role נכתב **ביצירה עצמה**. הטריגר enforce_invite_only
  // דורש אותו ב-commit, ובלעדיו היצירה נדחית — וזו בדיוק ההגנה שמונעת
  // הרשמה עצמית.
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
    app_metadata: { parkomat_role: wantRole },
  });

  if (error) {
    // ⚠️ מעבירים את הסיבה של המסד ולא "שגיאת שרת": כשהטריגר דוחה (דומיין,
    // או משתמש קיים) המזמין צריך לדעת למה, אחרת הוא מנסה שוב אותו דבר.
    const msg = String(error.message ?? "");
    const status = msg.includes("already") ? 409 : 400;
    return json({ error: msg || "יצירת המשתמש נכשלה" }, status);
  }

  // ⚠️ provision_app_user רץ ב-AFTER INSERT — **לפני** שגו-טרו כותב את
  // app_metadata — ולכן הוא יוצר את השורה כבקר גם למנהל. בלי העדכון הזה
  // מנהל שהוזמן היה מקבל 403 בכל פעולה, וזה כבר קרה למשתמשת אמיתית.
  //
  // ⚠️ **והשגיאה נבדקת.** הגרסה הראשונה התעלמה ממנה, ואז חסר GRANT ל-
  // service_role הפיל את העדכון ב-42501 — בזמן שהקריאה החזירה 200 וגוף
  // שמכריז `role: "manager"`. המסך הציג הצלחה, הסיסמה הזמנית עבדה, והמוזמן
  // קיבל 403 בכל פעולת ניהול בלי שום הודעה שמסבירה למה.
  //
  // ⚠️ ומדווחים 500 ולא ממשיכים: המשתמש **כבר נוצר**, כלומר המצב אינו
  // "נכשל" אלא "נוצר חלקית", וזו בדיוק העובדה שהמזמין חייב לדעת. שקט כאן
  // הוא הכשל היחיד שאין ממנו דרך חזרה בלי לקרוא את המסד.
  const { error: roleWriteErr } = await admin.from("app_users")
    .update({ role: wantRole })
    .eq("supabase_uid", created.user.id);

  if (roleWriteErr) {
    return json({
      error: `המשתמש ${email} נוצר, אך קביעת הדרגה נכשלה — הוא נשאר בקר. ` +
             `הדרגה ניתנת לשינוי במסך המשתמשים. (${roleWriteErr.message})`,
    }, 500);
  }

  return json({
    ok: true,
    user: { id: created.user.id, email: created.user.email, role: wantRole },
    // מוצגת פעם אחת ואינה נשמרת בשום מקום.
    tempPassword,
    message: `נוצר משתמש ${created.user.email}. העבירו לו את הסיסמה הזמנית — היא מוצגת פעם אחת.`,
  });
});
