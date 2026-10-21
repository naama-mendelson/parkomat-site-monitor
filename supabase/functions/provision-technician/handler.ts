// supabase/functions/provision-technician/handler.ts — משתמש לטלפון של טכנאי, ל-QR שבכרטיס (21/10/2026).
//
// בעלת המוצר: "על כל כרטיס כפתור 'צא ל:' … ובסופו של דבר שזה יצפצף לאותו טכנאי", ובחרה "סריקת QR מהכרטיס". הטלפון
// מתחבר במשתמש משלו (תפקיד 'technician'), שרואה רק את המשימה של הטכנאי. יצירת משתמש היא
// `POST /auth/v1/admin/users`, שדורש את ה-Secret key — ולכן Edge Function, כמו provision-agent.
//
// ⚠️ **אין כאן לוגיקה עסקית (rule 3).** מי רשאי (עורך, בפיילוט), איזה טכנאי, מספר החיבור והאימייל — ב-
// public.tech_phone_begin, שנקראת **בזהות הקורא**; הקישור והשבתת הטלפון הקודם — ב-public.tech_phone_link, בזהות
// השירות (master/db/technicians.postgres.sql). כאן רק: ליצור את המשתמש, ולמחוק את הקודם מ-GoTrue.
//
// ⚠️ **משתמש חדש לכל QR.** אסימון גישה נשאר תקף עד שעה גם אחרי החלפת סיסמה, ורק משתמש מושבת נסגר מיד. tech_phone_link
// משביתה את הקודם, וכאן הוא נמחק גם מ-GoTrue (כך גם אסימון הרענון שלו מת). כשל במחיקה אינו כשל בחיבור — הקודם כבר
// מושבת במסד, והגישה שלו סגורה — ולכן הוא מוחזר כאזהרה.
//
// ⚠️ הסיסמה חוזרת פעם אחת, לדפדפן של הרכז, ונכנסת ל-QR. היא אינה נשמרת אצלנו. הטלפון מחליף אותה בעצמו מיד אחרי
// ההתחברות הראשונה, כך שצילום של ה-QR אינו פותח דבר אחר כך.
//
// ⚠️ קובץ נפרד מ-index.ts כדי שאפשר יהיה לבדוק אותו ב-Node (master/tests/provision-technician-fn.test.js), עם fetch מוזרק.

export type Env = {
  supabaseUrl: string;
  anonKey: string;
  serviceKey: string;     // ⚠️ סוד — מהסביבה של Supabase, לא מקובץ
};

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...cors, "content-type": "application/json", "cache-control": "no-store" },
  });

const TIMEOUT_MS = 15_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEBREW = /[֐-׿]/;

// ⚠️ 32 בתים אקראיים ולא סיסמה קריאה: אדם לא מקליד אותה — היא בתוך ה-QR.
export function newPassword(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// שגיאה של PostgREST → סטטוס והודעה. ההודעות בעברית באות מה-SQL; אחרת — הודעה כללית, בלי פרטים פנימיים.
function rpcError(status: number, data: unknown) {
  const d = (data ?? {}) as Record<string, unknown>;
  const code = String(d.code ?? "");
  const msg = String(d.message ?? "");
  const http = code === "42501" ? 403 : code === "PT404" ? 404 : code === "PT409" ? 409 : status >= 500 ? 502 : 400;
  return { http, message: HEBREW.test(msg) ? msg : "הפעולה נכשלה — נסו שוב", code };
}

export function makeHandler(env: Env, f: typeof fetch = fetch) {
  const call = (url: string, init: RequestInit) => f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const read = async (res: Response) => {
    const text = await res.text();
    try { return text ? JSON.parse(text) : null; } catch { return text; }
  };
  const service = { apikey: env.serviceKey, Authorization: `Bearer ${env.serviceKey}` };

  const rpc = async (fn: string, args: unknown, headers: Record<string, string>) => {
    const res = await call(`${env.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(args),
    });
    return { ok: res.ok, status: res.status, data: await read(res) };
  };
  const deleteUser = async (uid: string) => {
    const res = await call(`${env.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(uid)}`, {
      method: "DELETE", headers: service,
    });
    return res.ok || res.status === 404;   // כבר לא קיים — גם זו הצלחה
  };

  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

    const auth = req.headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return json({ error: "נדרשת הזדהות" }, 401);
    if (!env.serviceKey) return json({ error: "הפונקציה אינה מוגדרת" }, 503);

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const tech = Number(body?.technician_id);
    if (!Number.isInteger(tech) || tech <= 0) return json({ error: "חסר מזהה טכנאי" }, 400);

    try {
      // 1. בזהות הקורא: המסד מחליט אם מותר, ונותן את האימייל של החיבור החדש
      const begin = await rpc("tech_phone_begin", { p_tech: tech }, { apikey: env.anonKey, Authorization: auth });
      if (!begin.ok) {
        const e = rpcError(begin.status, begin.data);
        return json({ error: e.message, code: e.code }, e.http === 400 && begin.status === 401 ? 401 : e.http);
      }
      const b = begin.data as Record<string, unknown>;
      const email = String(b?.email ?? "");
      const gen = Number(b?.gen);
      if (!/^tech-\d+-\d+@parkomat\.co\.il$/.test(email) || !Number.isInteger(gen)) {
        return json({ error: "תשובה לא צפויה מהמסד" }, 502);
      }

      // 2. המשתמש. ⚠️ parkomat_role ביצירה עצמה — enforce_invite_only דורש אותו ב-commit
      const password = newPassword();
      const created = await call(`${env.supabaseUrl}/auth/v1/admin/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...service },
        body: JSON.stringify({
          email, password, email_confirm: true,
          app_metadata: { parkomat_role: "technician", technician_id: tech },
          user_metadata: { full_name: String(b?.name ?? "") },
        }),
      });
      const user = await read(created) as Record<string, unknown> | null;
      const uid = String(user?.id ?? "");
      if (!created.ok || !UUID.test(uid)) {
        return json({ error: `יצירת המשתמש לטלפון נכשלה (${created.status})` }, 502);
      }

      // 3. בזהות השירות: הקישור, והשבתת הטלפון הקודם. נכשל — המשתמש שנוצר נמחק, כדי לא להשאיר משתמש יתום
      const link = await rpc("tech_phone_link", { p_tech: tech, p_gen: gen, p_uid: uid, p_actor: String(b?.actor ?? "") }, service);
      if (!link.ok) {
        await deleteUser(uid).catch(() => false);
        const e = rpcError(link.status, link.data);
        return json({ error: e.message, code: e.code }, e.http);
      }

      // 4. הקודם — גם מ-GoTrue (במסד הוא כבר מושבת)
      const old = String(b?.old_uid ?? "");
      let warning: string | null = null;
      if (UUID.test(old) && old !== uid) {
        const gone = await deleteUser(old).catch(() => false);
        if (!gone) warning = "הטלפון הקודם נותק במסד, אך המשתמש שלו לא נמחק מ-Supabase";
      }

      const l = link.data as Record<string, unknown>;
      return json({
        ok: true, technician_id: tech, name: String(b?.name ?? ""), email,
        password,                      // ⚠️ פעם אחת — לתוך ה-QR. לא נשמרת אצלנו.
        replaced: l?.replaced === true, rev: Number(l?.rev ?? 0),
        ...(warning ? { warning } : {}),
      });
    } catch (e) {
      const name = (e as Error)?.name ?? "";
      const timeout = name === "TimeoutError" || name === "AbortError" || /timed out/i.test(String((e as Error)?.message));
      return json({ error: timeout ? "Supabase לא ענו בזמן — נסו שוב" : "הפעולה נכשלה — נסו שוב" }, 502);
    }
  };
}
