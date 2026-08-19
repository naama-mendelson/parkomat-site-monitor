// supabase/functions/delete-user — מחיקת משתמש, בלי השרת.
//
// ⚠️ **מחיקה, לא השבתה.** שתיהן קיימות ושונות: השבתה הפיכה והשורה נשארת,
// מחיקה מסירה גם את חשבון ה-auth וגם את השורה אצלנו. חזרה משמעותה הזמנה
// חדשה עם מזהה חדש.
//
// ⚠️ ומה ששורד את המחיקה: `audit_log.actor_name` ו-
// `maintenance_windows.set_by_name` הם **צילומי טקסט בלי FK**, בכוונה.
// שורת ביקורת עדיין אומרת מי עשה מה אחרי שהמשתמש נעלם.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "נדרשת הזדהות" }, 401);

  const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  // ⚠️ מול המסד ולא מול האסימון: app_users הוא מקור האמת. מנהל שהורד
  // לבקר נושא אסימון שאומר 'manager' עד שיפוג — והוא לא ימחק כאן איש.
  const { data: role } = await asCaller.rpc("my_role");
  if (role !== "manager") return json({ error: "הפעולה מותרת למנהלים בלבד" }, 403);

  const { data: meId } = await asCaller.rpc("my_app_user_id");
  if (!meId) return json({ error: "המשתמש אינו פעיל במערכת" }, 403);

  const id = Number((await req.json().catch(() => ({})))?.id);
  if (!Number.isInteger(id) || id <= 0) return json({ error: "מזהה משתמש לא תקין" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // ⚠️ **שליפה ישירה לפי id, ולא משיכת כל הטבלה וחיפוש בזיכרון.**
  // הגרסה הראשונה עשתה select() בלי תנאי ואז find() — וכשהשליפה חזרה
  // ריקה מכל סיבה, התוצאה הייתה "משתמש לא נמצא" על שורה שקיימת. שגיאה
  // שמצביעה על הנתון במקום על הגישה אליו, וזה בדיוק מה שקרה.
  const { data: target, error: findErr } = await admin
    .from("app_users").select("id, email, role, is_active, supabase_uid")
    .eq("id", id).maybeSingle();

  // ⚠️ כשל בשליפה **אינו** "לא נמצא": הראשון הוא בעיית גישה והשני עובדה
  // על הנתונים. מיזוגם הוא מה שהפך תקלת הרשאה לשגיאה מטעה.
  if (findErr) return json({ error: "שליפת המשתמש נכשלה: " + findErr.message }, 500);
  if (!target) return json({ error: "משתמש לא נמצא" }, 404);

  const { data: users, error: listErr } = await admin
    .from("app_users").select("id, role, is_active").eq("role", "manager").eq("is_active", true);
  if (listErr) return json({ error: "בדיקת המנהלים נכשלה: " + listErr.message }, 500);

  // ============================================================
  // שני המנעולים — ומדוע הם חשובים כאן יותר מאשר בהשבתה
  // ============================================================
  // ⚠️ מנהל שמשבית את עצמו יכול להיות מוחזר בידי אחר. מנהל שמוחק את עצמו
  // כשאין מנהל נוסף **אינו משאיר שום דרך חזרה מהממשק** — רק מפתח ה-Secret.
  if (target.id === meId) return json({ error: "אי אפשר למחוק את עצמך" }, 400);

  const activeManagers = users ?? [];
  if (target.role === "manager" && target.is_active && activeManagers.length <= 1) {
    return json({ error: "לא ניתן למחוק את המנהל הפעיל האחרון" }, 400);
  }

  // ⚠️ **Supabase קודם, הטבלה שלנו אחריה.** הסדר ההפוך משאיר, בכשל,
  // משתמש שעדיין יכול להתחבר בלי שורת app_users — מאומת, בלי זהות,
  // ו-provision_app_user לא ייצור לו שורה חדשה כי אין INSERT נוסף.
  if (target.supabase_uid) {
    const { error } = await admin.auth.admin.deleteUser(target.supabase_uid);
    // 404 = כבר לא קיים שם. זו הצלחה, לא כשל.
    if (error && !String(error.message).includes("not found")) {
      return json({ error: "המחיקה ב-Supabase נכשלה — המשתמש לא נמחק" }, 502);
    }
  }

  await admin.from("app_users").delete().eq("id", id);

  // ⚠️ **אחרי המחיקה, ובכוונה.** לפניה היה נרשם "נמחק" גם כשהמחיקה
  // בטבלה נכשלה — ביקורת שמעידה על מה שלא קרה. וזו הפעולה הבלתי-הפיכה
  // היחידה כאן, כלומר זו שהכי חייבת תיעוד.
  const { data: actor } = await admin.from("app_users").select("email").eq("id", meId).maybeSingle();
  await admin.from("audit_log").insert({
    at: new Date().toISOString(),
    actor_id: meId,
    actor_name: actor?.email ?? "לא ידוע",
    actor_role: "manager",
    trust: "token",
    action: "user.delete",
    target_type: "user",
    target_id: String(id),
    target_name: target.email,
    details: { email: target.email, role: target.role, via: "edge-function" },
  });

  return json({ ok: true, id, email: target.email });
});
