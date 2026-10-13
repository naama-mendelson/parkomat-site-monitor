// supabase/functions/wizenet/handler.ts — הממסר בין הדשבורד ל-API של ויזנט (13/10/2026).
//
// ⚠️ למה פונקציה ולא קריאה מהדפדפן: ה-API של ויזנט דורש טוקן אישי בכותרת Authorization. טוקן בדפדפן הוא
// טוקן של כל מי שפותח את הדשבורד (אותו כלל כמו root rule 7 על ה-Secret key). הטוקן יושב כאן, כסוד של
// הפונקציה (WIZENET_TOKEN), ולא בשום קובץ — המאגר ציבורי.
//
// ⚠️ אין כאן לוגיקה עסקית (rule 3): הפונקציה מאמתת שהקורא איש צוות, מעבירה את הבקשה לוויזנט, ורושמת
// במסד מה שוויזנט אישרו — בזהות הקורא, כך שהמסד הוא שאוכף מי רשאי (app.require_staff). מה "פתוח", איך קריאה
// משויכת לאתר, ומה נחשב סגור — ב-SQL (db/service-calls-board.postgres.sql).
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
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

const TIMEOUT_MS = 15_000;

// ============================================================
// פענוח רשימה מוויזנט
// ============================================================
// ⚠️ מבנה התשובה לא תואר בקבצי ההסבר ("תוחזר הרשימה של המידע שביקשתם"). לכן הפענוח סובלני: מערך, או
// מערך בתוך אחד המפתחות המקובלים; בכל שורה — מפתח שהוא id (או מסתיים ב-id) ומפתח של שם. שורה שאין בה
// שניהם — לא נכנסת. כשלא נמצא כלום, הקורא מקבל קטע מהתשובה הגולמית, כדי שנלמד את המבנה מהפעם הראשונה.
export function parseLookup(body: unknown): { id: string; name: string }[] {
  let rows: unknown = body;
  if (rows && typeof rows === "object" && !Array.isArray(rows)) {
    const o = rows as Record<string, unknown>;
    const key = Object.keys(o).find((k) => Array.isArray(o[k]));
    rows = key ? o[key] : [];
  }
  if (!Array.isArray(rows)) return [];
  const out: { id: string; name: string }[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const keys = Object.keys(o);
    const idKey = keys.find((k) => k.toLowerCase() === "id") ?? keys.find((k) => /id$/i.test(k))
      ?? keys.find((k) => /^(קוד|מזהה)$/.test(k));
    const nameKey = keys.find((k) => k !== idKey && /(name|desc|title|שם|תיאור)/i.test(k))
      ?? (keys.length === 2 ? keys.find((k) => k !== idKey) : undefined);
    if (!idKey || !nameKey) continue;
    const id = String(o[idKey] ?? "").trim();
    const name = String(o[nameKey] ?? "").trim();
    if (id && name) out.push({ id, name });
  }
  return out;
}

// הודעות השגיאה של ויזנט (מקבצי ההסבר) — בעברית, כדי שמי שלחץ יבין מה קרה
export function wizenetError(text: string): string {
  const t = text.toLowerCase();
  if (t.includes("call not found")) return "הקריאה לא נמצאה בוויזנט";
  if (t.includes("callstatusid not found") || t.includes("calltypeid not found")) return "הערך שנבחר אינו קיים בוויזנט";
  if (t.includes("go_to_wizenet")) return "שגיאה במערכת של ויזנט — לנסות שוב מאוחר יותר";
  if (t.includes("unauthorized") || t.includes("token")) return "ויזנט דחו את הטוקן";
  return `ויזנט החזירו שגיאה: ${text.slice(0, 200)}`;
}

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

  const wizenet = async (func: string, body: unknown) => {
    let res: Response, text: string;
    try {
      res = await f(`${env.wizenetBase}?func=${func}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: env.token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      text = await res.text();
    } catch (e) {
      // ⚠️ מסומן: כשל בדרך לוויזנט ולא בדרך ל-Supabase — שתי תקלות שונות, ושתיהן היו "לא ענו בזמן"
      throw Object.assign(new Error(String((e as Error)?.message ?? e)), { name: (e as Error)?.name, wizenet: true });
    }
    let data: unknown = null;
    try { data = JSON.parse(text); } catch { data = null; }
    return { ok: res.ok, status: res.status, text, data };
  };

  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

    const auth = req.headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return json({ error: "נדרשת הזדהות" }, 401);

    // ⚠️ "כל אחד" (בעלת המוצר, 13/10/2026) — כל איש צוות. הבדיקה מול המסד (my_role קורא את app_users),
    // לא מול האסימון: מי שהושבת לפני חמש דקות כבר אינו עובר. ⚠️ וגם **לפני** הפנייה לוויזנט — אחרת מי שאינו
    // רשאי היה משנה קריאה אצלם, ורק הרישום אצלנו היה נדחה.
    const role = await rpc(auth, "my_role", {});
    if (!role.ok) return json({ error: "אימות נכשל" }, 401);
    if (role.data !== "manager" && role.data !== "operator") return json({ error: "אין הרשאה" }, 403);

    if (!env.token) return json({ error: "החיבור לוויזנט עוד לא הוגדר (חסר טוקן)" }, 503);

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const action = String(body?.action ?? "");

    try {
      // ---------- טעינת הרשימות (סטטוסים וסוגים) ----------
      if (action === "lookups") {
        // ⚠️ שני המזהים נבדקים לפני כל פנייה: אחרת הרשימה הראשונה נטענת והשנייה נכשלת — חצי עבודה
        if (!env.qryStatus || !env.qryType) return json({ error: "חסרים מזהי השאילתות של הרשימות" }, 503);
        const result: Record<string, unknown> = {};
        for (const [kind, qry] of [["status", env.qryStatus], ["type", env.qryType]] as const) {
          const w = await wizenet("wizeApp_getBIReportQuery", { QRYID: qry });
          if (!w.ok) return json({ error: wizenetError(w.text) }, 502);
          const items = parseLookup(w.data);
          if (items.length === 0) {
            return json({ error: "לא הצלחנו לקרוא את הרשימה מוויזנט", kind, sample: w.text.slice(0, 500) }, 502);
          }
          const saved = await rpc(auth, "wizenet_lookups_save", { p_kind: kind, p_items: items });
          if (!saved.ok) return json({ error: "שמירת הרשימה נכשלה", detail: saved.data }, 500);
          result[kind] = items.length;
        }
        return json({ ok: true, ...result });
      }

      // ---------- עדכון סטטוס או סוג של קריאה ----------
      if (action === "update") {
        const field = String(body?.field ?? "");
        const callid = String(body?.callid ?? "").trim();
        const value = String(body?.value ?? "").trim();
        if (field !== "status" && field !== "type") return json({ error: "שדה לא מוכר" }, 400);
        // ⚠️ ויזנט דוחים callid שאינו מספר חיובי — אומרים את זה לפני שפונים אליהם
        if (!/^\d+$/.test(callid) || Number(callid) <= 0) return json({ error: "מספר קריאה לא תקין" }, 400);
        if (!/^\d+$/.test(value)) return json({ error: "ערך לא תקין" }, 400);

        const w = field === "status"
          ? await wizenet("wizeApp_updateCallStatus", { callid, callstatusid: value })
          : await wizenet("wizeApp_updateCallType", { callid, calltypeid: value });
        // ⚠️ הצלחה רק במפורש ("update successfully"): תשובה 200 עם הודעת שגיאה בגוף היא שגיאה
        if (!w.ok || !/update successfully/i.test(w.text)) return json({ error: wizenetError(w.text) }, 502);

        // ⚠️ הרישום אצלנו **אחרי** האישור שלהם. כשל כאן אינו מבטל את השינוי בוויזנט — הוא כבר קרה — ולכן
        // ok נשאר true, עם אזהרה: המסך יתעדכן כשוויזנט ישלחו את העדכון שלהם.
        const rec = await rpc(auth, "service_call_record_change", { p_ticket: callid, p_field: field, p_value: value });
        if (!rec.ok) return json({ ok: true, recorded: false, warning: "השינוי נשמר בוויזנט, אבל לא נרשם אצלנו" });
        return json({ ok: true, recorded: true });
      }

      return json({ error: "פעולה לא מוכרת" }, 400);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      const fromWizenet = (e as { wizenet?: boolean })?.wizenet === true;
      // ⚠️ ב-Deno ההודעה היא "Signal timed out." — לא "timeout". נמצא בפריסה הראשונה (13/10/2026): קצב-זמן
      // מול ויזנט יצא "הפעולה נכשלה" במקום "ויזנט לא ענו בזמן". לכן השם קודם, וההודעה רק כגיבוי.
      const name = String((e as Error)?.name ?? "");
      if (name === "TimeoutError" || name === "AbortError" || /time[d ]*out|abort/i.test(msg)) {
        return json({ error: fromWizenet ? "ויזנט לא ענו בזמן" : "Supabase לא ענה בזמן" }, 504);
      }
      if (fromWizenet) return json({ error: "אין חיבור לוויזנט", detail: msg.slice(0, 300) }, 502);
      // ⚠️ הסיבה נשלחת: בלי יומני הפונקציה זו הדרך היחידה לדעת מה נכשל (הטוקן אינו בהודעות של fetch)
      return json({ error: "הפעולה נכשלה", detail: msg.slice(0, 300) }, 500);
    }
  };
}
