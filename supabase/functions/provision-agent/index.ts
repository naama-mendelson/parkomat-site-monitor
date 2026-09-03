// supabase/functions/provision-agent — זהות לסוכן של אתר, בלי השרת.
//
// ============================================================
// למה זה קיים
// ============================================================
// לכל אתר יש משתמש משלו, ו-`public.ingest_batch` גוזרת את האתר **מהזהות**
// ולא מהמטען — כך שסוכן אינו יכול לכתוב לאתר אחר גם אם ינסה.
//
// ⚠️ אבל עד כה יצירת הזהות הייתה פקודה ידנית
// (`tools/provision-agent-user.js`), כלומר **משהו שצריך לזכור**. מי ששכח
// התקין אתר שנראה תקין לחלוטין ופשוט אינו מדווח — בלי שגיאה, בלי שורה
// בלוג, ובלי שום מקום שבו זה נראה שבור. כאן זה קורה מעצמו בהרשמת האתר.
//
// ============================================================
// ⚠️ למה Edge Function ולא RPC
// ============================================================
// יצירת משתמש היא `POST /auth/v1/admin/users`, שדורש את ה-**Secret key**.
// SQL אינו יכול לקרוא לו, ולדפדפן אסור להחזיק אותו (כלל 7 ב-CLAUDE.md).
// זו בדיוק הקטגוריה שבגללה `invite-user` קיים — מחזיק-סוד, ולא לוגיקה
// עסקית — והקובץ הזה עוקב אחריו שורה בשורה.
//
// ⚠️ **ואין כאן שום תלות ב-master.** הפונקציה רצה בתוך Supabase, כך
// שהרשמת אתר עובדת גם כש-DELL008 כבוי — וזו כל הנקודה של המהלך.
//
// ============================================================
// ⚠️ אימות התפקיד — הדבר הקריטי כאן
// ============================================================
// לפונקציה יש את ה-Secret, כלומר כוח ליצור משתמשים. בלי בדיקת תפקיד, כל
// מי שפתח את האתר היה יכול ליצור לעצמו זהות סוכן ולכתוב נתוני אתר.
//
// והבדיקה מול המסד ולא מול האסימון: `my_role()` קורא מ-`app_users`, מקור
// האמת. מנהל שהורד לבקר לפני חמש דקות עדיין נושא אסימון שאומר 'manager'.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// ⚠️ חייב להיות זהה מילה במילה ל-`emailFor` ב-tools/provision-agent-user.js
// ול-`SupabaseDefaults.EmailFor` בסוכן. שלושה עותקים של אותה מוסכמה, ואם
// אחד מהם יזוז — הסוכן ינסה להתחבר כמשתמש שלא נוצר, ויקבל 400 בכל סבב.
const emailFor = (code: string) => `site-${code}@parkomat.co.il`;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...cors, "content-type": "application/json" },
  });

// ⚠️ 32 בתים אקראיים ולא סיסמה קריאה. אדם לעולם לא מקליד אותה מהזיכרון —
// היא נכנסת ל-config.json של הסוכן — ולכן אין סיבה להחליש אותה.
function newPassword(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "נדרשת הזדהות" }, 401);

  // לקוח בזהות **הקורא**, לא בזהות השירות — אחרת my_role() חסר משמעות.
  const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: role, error: roleErr } = await asCaller.rpc("my_role");
  if (roleErr) return json({ error: "אימות נכשל" }, 401);
  if (role !== "manager") return json({ error: "הפעולה מותרת למנהלים בלבד" }, 403);

  const body = await req.json().catch(() => null);
  const code = String(body?.code ?? "").trim();
  const rotate = body?.rotate === true;

  if (!code) return json({ error: "חסר קוד אתר" }, 400);

  // ⚠️ **קוראים את האתר בזהות הקורא, לא ב-service_role.** ל-service_role
  // אין GRANT על `sites` — בכוונה, הרשימה הצרה היא התיעוד של מי כותב לאן —
  // והוספת אחד כאן הייתה מרחיבה אותה בלי צורך. מנהל ממילא רשאי לקרוא.
  const { data: site, error: siteErr } = await asCaller
    .from("sites").select("id, code, site_name").eq("code", code).maybeSingle();

  if (siteErr) return json({ error: `קריאת האתר נכשלה: ${siteErr.message}` }, 500);
  if (!site) return json({ error: `אין אתר עם הקוד ${code}` }, 404);

  const email = emailFor(site.code);
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // ⚠️ קיים כבר? זו **אינה** שגיאה שכדאי לבלוע. הסיסמה אינה ניתנת לשחזור
  // (Supabase מחזיק גיבוב בלבד), ולכן "פשוט תריץ שוב כדי לראות אותה" הוא
  // בדיוק המצב שבו מישהו מנתק אתר עובד בלי לשים לב.
  const { data: existing, error: existErr } = await admin
    .from("app_users").select("id, supabase_uid, site_id")
    .ilike("email", email).maybeSingle();

  if (existErr) return json({ error: `בדיקת קיום נכשלה: ${existErr.message}` }, 500);

  if (existing && !rotate) {
    return json({
      error: `כבר קיימת זהות סוכן ל-${site.code}. הסיסמה אינה ניתנת לשחזור; ` +
             `להנפקת חדשה יש לבקש החלפה — והיא מנתקת את האתר עד שה-config שלו יעודכן.`,
      alreadyExists: true,
    }, 409);
  }

  const password = newPassword();
  let uid = existing?.supabase_uid as string | undefined;

  if (!existing) {
    // ⚠️ parkomat_role נכתב ביצירה עצמה — הטריגר enforce_invite_only דורש
    // אותו ב-commit, ובלעדיו היצירה נדחית.
    const { data: created, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
      app_metadata: { parkomat_role: "agent", site_code: String(site.code) },
    });
    if (error) {
      const msg = String(error.message ?? "");
      return json({ error: msg || "יצירת הזהות נכשלה" }, msg.includes("already") ? 409 : 400);
    }
    uid = created.user.id;
  } else {
    const { error } = await admin.auth.admin.updateUserById(uid!, { password });
    if (error) return json({ error: `החלפת סיסמה נכשלה: ${error.message}` }, 500);
  }

  // ⚠️ הדרגה והשיוך נכתבים ביד ולא נסמכים על הטריגר: `provision_app_user`
  // רץ ב-AFTER INSERT — לפני שגו-טרו כותב את app_metadata — ולכן השורה
  // נולדת כ-`operator` בלי site_id, ו-`app.agent_site_id()` מחזיר NULL.
  // סוכן כזה הוא סוכן בנייר בלבד: כל כתיבה שלו תידחה.
  //
  // ⚠️ **והשגיאה נבדקת.** זה בדיוק הכשל שקרה ב-invite-user: חסר GRANT
  // הפיל את העדכון ב-42501 בזמן שהקריאה החזירה 200, והמסך הציג הצלחה.
  const { error: linkErr } = await admin.from("app_users")
    .update({ role: "agent", site_id: site.id, is_active: true })
    .eq("supabase_uid", uid!);

  if (linkErr) {
    // ⚠️ 500 ולא "נכשל": החשבון **כבר נוצר**. המצב הוא "נוצר חלקית", וזו
    // העובדה שהמנהל חייב לדעת — אחרת ינסה שוב ויקבל 409 בלי להבין.
    return json({
      error: `החשבון ${email} נוצר, אך השיוך לאתר נכשל — הסוכן לא יוכל לכתוב. (${linkErr.message})`,
    }, 500);
  }

  // ⚠️ אימות אחרי הכתיבה, ולא אמון בה. `agent_site_id()` היא מה שמכריע
  // אם הסוכן יכול לכתוב בכלל, והיא קוראת בדיוק את שלושת השדות האלה.
  //
  // ⚠️ **והשגיאה נבדקת גם כאן** — `check-edge-grants` תפס בדיוק את השורה
  // הזו. קריאה שמתעלמת מ-`error` מחזירה `data: null`, ואז הבדיקה למטה
  // הייתה מדווחת "השורה אינה כצפוי" על **שגיאת הרשאה**, ושולחת את מי
  // שקורא לחפש באג בנתונים במקום ב-GRANT. זה בדיוק הכשל של invite-user.
  const { data: row, error: verifyErr } = await admin.from("app_users")
    .select("role, site_id, is_active").eq("supabase_uid", uid!).maybeSingle();

  if (verifyErr) {
    return json({
      error: `החשבון ${email} נוצר ושויך, אך האימות נכשל: ${verifyErr.message}`,
    }, 500);
  }

  if (!row || row.role !== "agent" || row.site_id !== site.id || !row.is_active) {
    return json({
      error: `החשבון ${email} נוצר, אך השורה אינה כצפוי: ${JSON.stringify(row)}`,
    }, 500);
  }

  return json({
    ok: true,
    site: { code: site.code, name: site.site_name },
    email,
    // ⚠️ מוצגת פעם אחת ואינה נשמרת אצלנו בשום מקום.
    password,
    rotated: Boolean(existing),
    message: `נוצרה זהות לאתר ${site.code}. העתיקו את הסיסמה — היא מוצגת פעם אחת בלבד.`,
  });
});
