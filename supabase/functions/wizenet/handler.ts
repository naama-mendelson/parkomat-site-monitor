// supabase/functions/wizenet/handler.ts — הדלת לטוקן של ויזנט, לממסרים בלבד (15/10/2026).
//
// ============================================================
// ⚠️ מה הפונקציה הזו הייתה, ולמה היא כבר לא
// ============================================================
// עד 14/10/2026 הפונקציה הזו פנתה לוויזנט בעצמה: הדשבורד שלח "שנה סטטוס", והיא קראה ל-WIZEAPI עם הטוקן ורשמה
// במסד. זה לא עבד אף פעם בייצור: ויזנט עונים רק לפניות מישראל, ופונקציות Edge רצות בחו"ל בלי כתובת קבועה —
// הבקשה פשוט לא נענתה עד קצב-הזמן ("ויזנט לא ענו בזמן"), ולכן הכפתור הוסתר (SERVICE_CALLS_WRITE=false).
//
// עכשיו הפנייה לוויזנט יוצאת ממחשב באתר (ממסר — db/wizenet-relay.postgres.sql), שנמצא בישראל. לפונקציה נשאר
// תפקיד אחד: **למסור לממסר את הטוקן**, כדי שהטוקן לא יישב בשום קובץ — לא במחשב האתר, לא במסד (שנוסע בכל
// pg_dump ובגיבוי היומי), ולא במאגר (ציבורי). הממסר מחזיק אותו בזיכרון בלבד.
//
// ⚠️ **מי מקבל את הטוקן — המסד מחליט, לא הקוד כאן.** wizenet_relay_me נקראת בזהות הקורא, ומחזירה true רק לסוכן
// של אתר שמופיע ב-wizenet_relays ומופעל. הזהות נגזרת מהאסימון (app.agent_site_id), כך שסוכן של אתר אחר, מנהל,
// או מי שגנב סיסמת סוכן של אתר שאינו ממסר — מקבלים 403. הוצאת מחשב מהשימוש היא מחיקת שורה, ולא החלפת טוקן.
//
// ⚠️ אין כאן לוגיקה עסקית (rule 3): מה לשלוח לוויזנט, ומה נחשב הצלחה — ב-SQL. הפענוח (parseLookup) והתרגום
// של הודעות השגיאה (wizenetError) עברו לשם כמות שהם (app.wizenet_parse_lookup, app.wizenet_error_text).
//
// ⚠️ קובץ נפרד מ-index.ts כדי שאפשר יהיה לבדוק אותו ב-Node (master/tests/wizenet-fn.test.js) — בלי Deno,
// בלי supabase-js: PostgREST נקרא ב-fetch ישיר, ו-fetch מוזרק.

export type Env = {
  supabaseUrl: string;
  anonKey: string;
  wizenetBase: string;      // https://parkomat.wizenet.co.il/WIZEAPI/Default.aspx
  token: string;            // ⚠️ סוד — מוויזנט, לא מקובץ
  qryStatus: string;        // QRYID של רשימת הסטטוסים
  qryType: string;          // QRYID של רשימת סוגי הקריאה
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
// ⚠️ no-store: תשובה שנושאת טוקן אינה נשמרת באף מטמון בדרך
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...cors, "content-type": "application/json", "cache-control": "no-store" },
  });

const TIMEOUT_MS = 15_000;

export function makeHandler(env: Env, f: typeof fetch = fetch) {
  // RPC בזהות הקורא — המסד אוכף את ההרשאה, לא הקוד כאן
  const rpc = async (auth: string, fn: string, args: unknown) => {
    const res = await f(`${env.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: env.anonKey, Authorization: auth },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { ok: res.ok, status: res.status, data };
  };

  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

    const auth = req.headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return json({ error: "נדרשת הזדהות" }, 401);

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const action = String(body?.action ?? "");

    try {
      // ---------- התצורה של הממסר: הטוקן, הכתובת, ומזהי השאילתות ----------
      if (action === "relay_config") {
        const me = await rpc(auth, "wizenet_relay_me", {});
        if (!me.ok) return json({ error: "אימות נכשל" }, 401);
        if (me.data !== true) return json({ error: "אין הרשאה — האתר הזה אינו ממסר לוויזנט" }, 403);
        // ⚠️ trim — נמדד (בדיקה חיה, 15/10/2026): הסוד WIZENET_TOKEN נשמר עם שורה חדשה בסופו. fetch של Deno ניקה אותה
        // בשקט כשהפונקציה פנתה לוויזנט בעצמה; ‏.NET בממסר שולח אותה כמות שהיא, והבקשה נשברה (411 מוויזנט).
        const token = (env.token ?? "").trim();
        if (!token) return json({ error: "החיבור לוויזנט עוד לא הוגדר (חסר טוקן)" }, 503);
        // ⚠️ מזהי השאילתות נמסרים גם כשהם ריקים: בלעדיהם רק רענון הרשימות נכשל, ושינוי סטטוס — לא. הממסר
        // מסרב לשלוח פנייה שמקום-שמור בה נשאר ריק, ואומר למה (ראו app.wizenet_call_error).
        return json({
          token,
          base: (env.wizenetBase ?? "").trim(),
          vars: { qry_status: (env.qryStatus ?? "").trim(), qry_type: (env.qryType ?? "").trim() },
        });
      }

      // ⚠️ "update" ו-"lookups" — הפעולות הקודמות — אינן כאן עוד, ובכוונה: דשבורד ישן שעוד שולח אותן מקבל 400
      // ברור, ולא פנייה לוויזנט שתיתקע 15 שניות ותיכשל.
      return json({ error: "פעולה לא מוכרת" }, 400);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      // ⚠️ ב-Deno ההודעה היא "Signal timed out." — לא "timeout". נמצא בפריסה הראשונה (13/10/2026). לכן השם קודם.
      const name = String((e as Error)?.name ?? "");
      if (name === "TimeoutError" || name === "AbortError" || /time[d ]*out|abort/i.test(msg)) {
        return json({ error: "Supabase לא ענה בזמן" }, 504);
      }
      // ⚠️ הסיבה נשלחת: בלי יומני הפונקציה זו הדרך היחידה לדעת מה נכשל (הטוקן אינו בהודעות של fetch)
      return json({ error: "הפעולה נכשלה", detail: msg.slice(0, 300) }, 500);
    }
  };
}
