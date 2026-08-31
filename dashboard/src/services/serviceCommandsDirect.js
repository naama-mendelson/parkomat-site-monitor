// services/serviceCommandsDirect.js — הפעלה מחדש של מכונת השרת, מהדשבורד.
//
// ============================================================
// ⚠️ למה זה לא קורא לשרת
// ============================================================
// הכפתור נחוץ **בדיוק** כשהשרת אינו עונה. קריאה אליו הייתה נכשלת ברגע
// היחיד שבו היא נדרשת — וזו לא תיאוריה: ב-27/08/2026 DELL008 איבד חשמל,
// Docker לא עלה בלי התחברות משתמש, והמערכת הייתה למטה 2.5 ימים.
//
// לכן: הדשבורד כותב שורה ב-Supabase, וסקריפט על מכונת השרת — שרץ
// **מחוץ ל-Docker** — קורא ומבצע. שני הצדדים אינם מכירים זה את זה, ואף
// אחד מהם אינו תלוי ב-master.
//
// ⚠️ והדשבורד עצמו שורד כי הוא PWA: הוא נטען מהמטמון של הדפדפן וקורא
// מ-Supabase ישירות. אם Caddy למטה, דף שכבר נפתח פעם עדיין ייפתח.
//
// כלל 5 נשמר: הרכיבים אינם מייבאים supabase-js. הם מייבאים מ-dataSource.
import { supabase, isSupabaseConfigured } from "./supabase";

function messageFor(error) {
  if (!error) return "שגיאה לא ידועה";
  if (error.code === "42501") return "אין הרשאה — הפעולה הזו למנהלת בלבד";
  return error.message || "הפעולה נכשלה";
}

/**
 * מבקשת הפעלה מחדש. מנהלת בלבד — נאכף ב-RPC, לא כאן.
 *
 * ⚠️ מחזירה גם כשכבר יש בקשה פתוחה, ועם `status` שאומר זאת — ולא זורקת.
 * לחיצה שנייה בזמן שהראשונה רצה היא התנהגות **צפויה** של מי שלא רואה
 * תוצאה מיידית, ושגיאה אדומה עליה הייתה קוראת ככשל של הכפתור.
 */
export async function requestServiceRestart(reason = "") {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");

  const { data, error } = await supabase.rpc("request_service_restart", {
    p_reason: String(reason ?? "").trim() || null,
  });
  if (error) throw new Error(messageFor(error));

  const row = Array.isArray(data) ? data[0] : data;
  return {
    id: row?.id ?? null,
    status: row?.status ?? "pending",
    message: row?.message ?? "הבקשה נשלחה",
  };
}

/** היסטוריית הפקודות האחרונות — כדי שהמסך יראה מה קרה, לא רק "נשלח". */
export async function recentServiceCommands(limit = 5) {
  if (!isSupabaseConfigured) return [];
  const { data, error } = await supabase
    .from("service_commands")
    .select("id, command, status, reason, requested_by, requested_at, claimed_at, finished_at, result")
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw new Error(messageFor(error));
  return data || [];
}

/**
 * מנוי חי על שינויי סטטוס.
 *
 * ⚠️ בלעדיו המסך היה מציג "נשלח" ונשאר כך. הפעלה מחדש לוקחת עד ארבע
 * דקות (Docker Desktop מרים מכונת WSL), ומסך קפוא לארבע דקות הוא מסך
 * שגורם ללחוץ שוב — ולכן הריסון ב-RPC וההצגה החיה כאן הם אותו פתרון
 * משני צדדיו.
 */
export function subscribeServiceCommands(onChange) {
  if (!isSupabaseConfigured) return () => {};

  const ch = supabase
    .channel("service-commands")
    .on("postgres_changes",
      { event: "*", schema: "public", table: "service_commands" },
      (payload) => { if (payload.new) onChange(payload.new); })
    .subscribe();

  return () => { try { supabase.removeChannel(ch); } catch { /* כבר נסגר */ } };
}

// ============================================================
// ⚠️ מצב המבצע — הדבר שחסר וגרם לכפתור להיכשל בשקט
// ============================================================
// נמדד בייצור: בקשת הפעלה מחדש מ-30/08 16:27 נשארה `pending` **יומיים**.
// הכפתור נלחץ, שום דבר לא קרה, ולא היה שום מקום לראות זאת — המבצע
// כותב למסד רק כשיש לו מה לבצע, ולכן "אין פקודות" ו"המבצע מת" נראים
// זהים לחלוטין.
//
// ⚠️ **מנגנון חירום שנכשל בלי להכריז הוא בדיוק הכשל שהוא בא למנוע.**
export async function fetchServiceHealth() {
  if (!isSupabaseConfigured) return null;
  const { data, error } = await supabase.rpc("service_health");
  if (error) return null;           // מחוון, לא נתון שהמסך בנוי עליו
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;

  const age = row.poller_age_secs === null || row.poller_age_secs === undefined
    ? null
    : Number(row.poller_age_secs);

  return {
    seenAt: row.poller_seen_at ?? null,
    ageSeconds: age,
    // ⚠️ המבצע רץ כל דקה. חמש דקות הן חמש הרצות שהוחמצו — סף שלא נורה
    // על עומס רגעי. `null` פירושו **מעולם לא רץ**, וזה מצב שונה: לא
    // "נפל" אלא "לא הותקן", ומי שקוראת צריכה לדעת מה מהם.
    alive: age !== null && age < 300,
    neverRan: age === null,
    openId: row.open_command_id ?? null,
    openStatus: row.open_status ?? null,
  };
}

/** בדיקת חיבור — עוברת את כל השרשרת ואינה מפעילה כלום מחדש. */
export async function requestServicePing() {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");
  const { data, error } = await supabase.rpc("request_service_ping");
  if (error) throw new Error(messageFor(error));
  const row = Array.isArray(data) ? data[0] : data;
  return { id: row?.id ?? null, status: row?.status ?? "pending", message: row?.message ?? "נשלח" };
}
