// services/sitesWriteDirect.js — רישום, עדכון ומחיקה של אתר, ישירות ל-Supabase.
//
// ============================================================
// כאן תפקיד **כן** נדרש — בשונה מתחזוקה
// ============================================================
// `maintenanceDirect.js` פתוח לכל משתמש פעיל, וזו החלטת מוצר מפורשת:
// "ייחוס במקום מנע". **הפעולות כאן הן ההפך**, ולכן `app.require_manager()`
// חוסם בקר ב-403:
//
//   • `code` הוא ה-`{code}` בנתיב ה-MQTT. שינויו קובע **לאיזה אתר** משויכות
//     ההודעות הנכנסות — כלומר הוא מסיט נתונים, לא רק תווית.
//   • מחיקה מוחקת את כל ההיסטוריה של האתר, ואין לה ביטול.
//
// ============================================================
// ⚠️ ומה שהוחלף כאן הוא **הקוד המשותף** `admin123`
// ============================================================
// עד כה שלוש הפעולות היו מוגנות ב-`x-admin-code` — סוד אחד לכל המערכת,
// שערך ברירת המחדל שלו מופיע בקוד הפתוח ומעולם לא הוחלף. מי שהכיר אותו
// היה "מנהל", ושורת הביקורת לא ידעה לומר מי זה היה.
//
// ⚠️ `app.is_manager()` קורא את התפקיד מ-`app_users`, **לא מהאסימון**:
// תפקיד שהורד נכנס לתוקף מיד ולא כשהאסימון יפוג.
//
// ============================================================
// ⚠️ באג שהמעבר הזה מתקן בדרך: `POST /api/sites` היה שבור מאז ומתמיד
// ============================================================
// `insertSite` ב-`master/db/queries.js` מפרט שש עמודות ומספק שמונה
// מקומות, ולכן הרישום החזיר `500` **בכל** קריאה. נמדד מול המסד:
// "INSERT has more expressions than target columns". זה לא נתפס כי אף שער
// לא רשם אתר — 12 האתרים הקיימים נוספו דרך `tools/add-test-site.js`.
//
// ⚠️ **הנתיב בשרת נשאר שבור**, וזה לא הזנחה: הוא דרך החזרה, ולכן הוא
// יתוקן בנפרד. המסלול הזה אינו תלוי בו.
import { supabase, isSupabaseConfigured } from "./supabase";

/**
 * ממיר שגיאת PostgREST להודעה בעברית.
 *
 * ⚠️ `42501` הוא ההודעה של Postgres ("permission denied for function"), ומי
 * שיראה אותה לא יבין שהמשמעות היא "אינך מנהל". כל השאר מגיע מהפונקציה
 * עצמה, שמנפיקה קודי SQLSTATE מכוונים ולכן הודעתה בעברית וניתנת להצגה.
 */
function messageFor(error, fallback) {
  if (!error) return fallback;
  if (error.code === "42501") {
    return "הפעולה מותרת למנהלים בלבד";
  }
  return error.message || fallback;
}

function assertConfigured() {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");
}

/**
 * רישום אתר חדש.
 *
 * ⚠️ החתימה זהה ל-`registerSite` בזרוע השרת — אובייקט עם `code`,
 * `site_name`, `tier`, `plc_type` — כדי שהמסך לא ידע מי ענה. וגם ההחזרה
 * זהה: `{ ok, site }`.
 */
export async function registerSiteDirect(payload = {}) {
  assertConfigured();

  const { data, error } = await supabase.rpc("register_site", {
    p_code: String(payload.code ?? ""),
    p_site_name: String(payload.site_name ?? ""),
    // ⚠️ `undefined` הופך ל-`null` ב-JSON, ובפונקציה `null` פירושו
    // "בלי סוג מתקן" — מצב תקין לגמרי (כך כל 12 האתרים הקיימים).
    p_plc_type: payload.plc_type ? String(payload.plc_type) : null,
    p_tier: payload.tier ? String(payload.tier) : "basic",
  });

  if (error) throw new Error(messageFor(error, "רישום האתר נכשל"));

  const row = Array.isArray(data) ? data[0] : data;
  const site = { id: row?.id ?? null, code: row?.code, site_name: row?.site_name };

  // ============================================================
  // ⚠️ הזהות נוצרת כאן, מיד, ולא בפקודה שצריך לזכור
  // ============================================================
  // בלי זה, הפעלת אתר חדש דורשת להריץ `tools/provision-agent-user.js` על
  // DELL008 — ומי ששוכח מתקין אתר שנראה תקין לחלוטין ופשוט **אינו מדווח**:
  // אין שגיאה, אין שורה בלוג, ואין שום מסך שבו זה נראה שבור.
  //
  // ⚠️ **וכישלון כאן אינו מבטל את רישום האתר, בכוונה.** האתר כבר נרשם,
  // וזו עובדה שאי אפשר "לבטל" בשקט — `register_site` התחייב. לכן מדווחים
  // אתר-שנרשם-בלי-זהות כמצב מפורש, ולא כשגיאת רישום: הודעת "הרישום נכשל"
  // הייתה שולחת את המנהל לנסות שוב ולקבל "קוד כבר קיים".
  let agent = null, agentError = null;
  try {
    agent = await provisionAgentDirect(site.code);
  } catch (e) {
    agentError = e.message || "יצירת זהות הסוכן נכשלה";
  }

  return { ok: true, site, agent, agentError };
}

/**
 * סימון "הוחלף בקר" — הקריאה הבאה נקלטת כבסיס בלי להוסיף למונה.
 *
 * ⚠️ **הבעיה שאי אפשר להסיק ממנה.** בקר שהתאפס במקום (נפילת חשמל)
 * וב-5 דקות ספר 5 מחזורים — חמשת אלה **אמיתיים**, ולכן הקליטה מוסיפה
 * אותם. בקר **שהוחלף** מגיע עם מחזורי בדיקות מפעל, ואותם אסור להוסיף.
 * שני המקרים נראים זהים לחלוטין מהמספר, ולכן צריך לומר למערכת.
 *
 * ⚠️ נמדד: בקר חדש עם 87 מחזורי מפעל מוסיף 87 מחזורים מדומים,
 * ו-`cycle_total` הוא בלתי הפיך.
 */
export async function markControllerReplacedDirect(code) {
  assertConfigured();

  const { data, error } = await supabase.rpc("mark_controller_replaced", {
    p_code: String(code),
  });

  if (error) throw new Error(messageFor(error, "סימון החלפת הבקר נכשל"));

  const row = Array.isArray(data) ? data[0] : data;
  return { ok: true, code: row?.code, cycleTotal: row?.cycle_total };
}

/**
 * יצירת זהות סוכן לאתר — Edge Function `provision-agent`.
 *
 * ⚠️ **Edge Function ולא RPC**, ומאותה סיבה בדיוק כמו `invite-user`:
 * יצירת משתמש היא `POST /auth/v1/admin/users`, שדורש את ה-Secret key.
 * SQL אינו יכול לקרוא לו, ולדפדפן אסור להחזיק אותו.
 *
 * ⚠️ ו**אין כאן תלות ב-master**: הפונקציה רצה בתוך Supabase, כך שהרשמת
 * אתר עובדת גם כש-DELL008 כבוי.
 *
 * ⚠️ הכלל "מנהלים בלבד" אינו כאן אלא בפונקציה, שבודקת `my_role()` מול
 * המסד. בדיקה בקוד הזה הייתה נעקפת בפתיחת DevTools.
 */
export async function provisionAgentDirect(code, { rotate = false } = {}) {
  assertConfigured();

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("נדרשת התחברות מחדש");

  const res = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/provision-agent`, {
      method: "POST",
      headers: {
        apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: String(code), rotate }),
    });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "יצירת זהות הסוכן נכשלה");
  return body;
}

/**
 * עדכון אתר.
 *
 * ⚠️ **המפתח כאן הוא ההבדל בין "לא נשלח" ל"נשלח ריק"**, והוא זהה לשרת:
 * שדה חסר פירושו "אל תיגע", ומחרוזת ריקה בסוג המתקן פירושה "מחק". בלי
 * ההבחנה הזו אי אפשר לבטל סוג מתקן — וזה בדיוק מה ש-`AdminPanel` עושה
 * כשהמשתמשת מנקה את השדה.
 *
 * ⚠️ ולכן `p_plc_type` נשלח כמחרוזת גם כשהיא ריקה, אבל **לא נשלח בכלל**
 * כשהמאפיין חסר מה-payload. `?? null` היה מוחק את הסוג בכל עדכון שם.
 */
export async function updateSiteDirect(code, payload = {}) {
  assertConfigured();

  const body = { p_code: String(code) };
  if (payload.code !== undefined) body.p_new_code = String(payload.code);
  if (payload.site_name !== undefined) body.p_site_name = String(payload.site_name);
  if (payload.tier !== undefined) body.p_tier = String(payload.tier);
  if (payload.plc_type !== undefined) body.p_plc_type = String(payload.plc_type);

  const { data, error } = await supabase.rpc("update_site", body);
  if (error) throw new Error(messageFor(error, "עדכון האתר נכשל"));

  const row = Array.isArray(data) ? data[0] : data;
  return { ok: true, site: { id: row?.id ?? null, code: row?.code, site_name: row?.site_name } };
}

/**
 * מחיקת אתר וכל ההיסטוריה שלו.
 *
 * ⚠️ ההחזרה חייבת להיות `{ ok, deleted: { code, name, operations,
 * statusHistory } }` — **`AdminPanel` קורא בדיוק את השדות האלה** כדי להציג
 * "X פעולות ו-Y שינויי מצב הוסרו". שם שדה שונה היה מציג `undefined` בהודעת
 * האישור, בלי שום שגיאה.
 */
export async function deleteSiteDirect(code) {
  assertConfigured();

  const { data, error } = await supabase.rpc("delete_site", { p_code: String(code) });
  if (error) throw new Error(messageFor(error, "מחיקת האתר נכשלה"));

  const row = Array.isArray(data) ? data[0] : data;
  return {
    ok: true,
    deleted: {
      code: row?.code ?? code,
      name: row?.site_name ?? null,
      operations: Number(row?.operations ?? 0),
      statusHistory: Number(row?.status_history ?? 0),
    },
  };
}
