// supabase/functions/send-login-code/handler.ts — שולחת את קוד הכניסה במייל, מ-dashboard@parkomat.co.il (20/10/2026).
//
// בעלת המוצר: "כל פעם כשמישהו רוצה להיכנס לדשבורד נשלח לו מהדשבורד למייל שהוא חיבר כשהוא נרשם מייל עם קוד בן 4
// ספרות". המייל של החברה יושב ב-Microsoft 365, והיא בחרה שליחה דרך Microsoft Graph: הרשמת אפליקציה ב-Entra עם
// הרשאת Mail.Send, מוגבלת לתיבה dashboard@ בלבד. בלי SMTP, בלי סיסמת תיבה, ובלי שינוי DNS.
//
// ⚠️ **אין כאן לוגיקה עסקית (rule 3).** מתי לשלוח, מה התקרות, התוקף, הקוד עצמו ולאיזו כתובת (app_users.email) —
// הכול ב-public.login_code_issue (security.postgres.sql). הפונקציה מאמתת מי קורא, מבקשת קוד מהמסד ומעבירה אותו
// במייל. הנוסח של המייל הוא הדבר היחיד שנכתב כאן.
//
// ⚠️ **login_code_issue מחזירה את הקוד, ולכן נקראת במפתח השירות** — והפונקציה הזו היא הסיבה היחידה שהמפתח הזה
// נוגע בה. מה שעובר אליה (sub, session_id) מגיע מהאסימון של הקורא, אחרי שהשער של Supabase אימת את החתימה
// (verify_jwt) ו-GoTrue אישר שהמשתמש קיים. הקוד אינו חוזר לדפדפן לעולם.
//
// ⚠️ קובץ נפרד מ-index.ts כדי שאפשר יהיה לבדוק אותו ב-Node (master/tests/login-code-fn.test.js), עם fetch מוזרק.

export type Env = {
  supabaseUrl: string;
  anonKey: string;
  serviceKey: string;     // ⚠️ סוד — מהסביבה של Supabase, לא מקובץ
  tenantId: string;       // Entra: Directory (tenant) ID
  clientId: string;       // Entra: Application (client) ID
  clientSecret: string;   // ⚠️ סוד — ערך ה-Client secret
  from: string;           // dashboard@parkomat.co.il
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

// התביעות מהאסימון. ⚠️ החתימה כבר נבדקה בשער של Supabase (בלי --no-verify-jwt), ו-GoTrue מאשר את המשתמש למטה.
function claims(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
  } catch { return null; }
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function mailFor(code: string, name: string, ttlMin: number) {
  return {
    subject: `קוד הכניסה לדשבורד: ${code}`,
    html:
      `<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1f2937">` +
      `<p>שלום ${esc(name)},</p>` +
      `<p>קוד הכניסה שלך לדשבורד Parkomat:</p>` +
      `<p style="margin:18px 0"><span dir="ltr" style="font-size:32px;font-weight:bold;letter-spacing:8px">${code}</span></p>` +
      `<p>הקוד תקף ל-${ttlMin} דקות.</p>` +
      `<p style="color:#6b7280;font-size:13px">אם לא ניסית להיכנס עכשיו — מישהו אחר מכיר את הסיסמה שלך. ` +
      `כדאי להחליף אותה ולעדכן את המנהל.</p>` +
      `</div>`,
  };
}

export function makeHandler(env: Env, f: typeof fetch = fetch, now: () => number = Date.now) {
  // אסימון Graph (client credentials) — תקף כשעה; נשמר כל עוד מופע הפונקציה חי
  let graph = { token: "", exp: 0 };

  const call = (url: string, init: RequestInit) => f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

  const rpcService = async (fn: string, args: unknown) => {
    const res = await call(`${env.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: env.serviceKey, Authorization: `Bearer ${env.serviceKey}` },
      body: JSON.stringify(args),
    });
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { ok: res.ok, status: res.status, data };
  };

  const graphToken = async (fresh: boolean) => {
    if (!fresh && graph.token && graph.exp - 60_000 > now()) return graph.token;
    const res = await call(`https://login.microsoftonline.com/${encodeURIComponent(env.tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.clientId, client_secret: env.clientSecret,
        scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials",
      }).toString(),
    });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok || typeof body.access_token !== "string") {
      throw new Error(`Microsoft סירבו לתת אסימון (${res.status}${body.error ? `: ${body.error}` : ""})`);
    }
    graph = { token: body.access_token, exp: now() + Number(body.expires_in ?? 3600) * 1000 };
    return graph.token;
  };

  const sendMail = async (to: string, subject: string, html: string) => {
    const payload = JSON.stringify({
      message: { subject, body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: to } }] },
      saveToSentItems: false,
    });
    for (const fresh of [false, true]) {
      const token = await graphToken(fresh);
      const res = await call(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.from)}/sendMail`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: payload,
      });
      if (res.status === 202 || res.ok) return;
      // אסימון שפג באמצע — פעם אחת אסימון חדש; כל השאר — כשל
      if (res.status === 401 && !fresh) continue;
      const text = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`Microsoft לא שלחו את המייל (${res.status}) ${text}`);
    }
  };

  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

    const auth = req.headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return json({ error: "נדרשת הזדהות" }, 401);
    const c = claims(auth.slice(7));
    const sub = String(c?.sub ?? "");
    const sid = String(c?.session_id ?? "");
    if (!UUID.test(sub) || !UUID.test(sid)) return json({ error: "אימות נכשל" }, 401);

    // ⚠️ לפני שמנפיקים קוד: בלי הגדרות השליחה, קוד שנוצר לא יגיע לאיש — ולא נספר בתקרה בשביל כלום
    if (!env.tenantId || !env.clientId || !env.clientSecret || !env.from || !env.serviceKey) {
      return json({ error: "שליחת קוד הכניסה במייל עוד לא הוגדרה — יש לפנות למנהל" }, 503);
    }

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const resend = body?.resend === true;

    try {
      // המשתמש קיים, וה-session שלו לא בוטל (יציאה, השבתה)
      const me = await call(`${env.supabaseUrl}/auth/v1/user`, {
        method: "GET", headers: { apikey: env.anonKey, Authorization: auth },
      });
      const user = await me.json().catch(() => null) as Record<string, unknown> | null;
      if (!me.ok || String(user?.id ?? "") !== sub) return json({ error: "אימות נכשל" }, 401);

      const r = await rpcService("login_code_issue", { p_user: sub, p_session: sid, p_force: resend });
      if (!r.ok) return json({ error: "הפעולה נכשלה", detail: String((r.data as { message?: string })?.message ?? r.status) }, 500);
      const d = (r.data ?? {}) as Record<string, unknown>;
      const status = String(d.status ?? "");

      if (status === "send") {
        const code = String(d.code ?? "");
        const email = String(d.email ?? "");
        const { subject, html } = mailFor(code, String(d.name ?? email), Number(d.ttl_min ?? 10));
        try {
          await sendMail(email, subject, html);
        } catch (e) {
          // הקוד נמחק במסד, כדי ש"שלח שוב" יעבוד מיד
          await rpcService("login_code_unsend", { p_session: sid }).catch(() => null);
          return json({ error: "המייל לא נשלח — נסו שוב בעוד רגע", detail: String((e as Error)?.message ?? e).slice(0, 300) }, 502);
        }
        return json({ status: "sent", email, resend_in: 60 });
      }
      if (status === "pending" || status === "wait") {
        return json({ status, email: d.email ?? null, resend_in: Number(d.resend_in ?? 0) });
      }
      if (status === "limit") {
        const day = d.per === "day";
        return json({
          status, per: day ? "day" : "hour", email: d.email ?? null,
          error: day ? "נשלחו יותר מדי קודים היום — אפשר לנסות שוב מחר, או לפנות למנהל"
                     : "נשלחו יותר מדי קודים בשעה האחרונה — אפשר לנסות שוב מאוחר יותר",
        }, 429);
      }
      if (status === "verified" || status === "not_required") return json({ status });
      return json({ error: "אין הרשאה" }, 403);   // no_user — משתמש מושבת או שאינו קיים
    } catch (e) {
      const name = String((e as Error)?.name ?? "");
      const msg = String((e as Error)?.message ?? e);
      // ⚠️ ב-Deno ההודעה היא "Signal timed out." — לא "timeout" (נמצא בפונקציה wizenet). לכן השם קודם.
      if (name === "TimeoutError" || name === "AbortError" || /time[d ]*out|abort/i.test(msg)) {
        return json({ error: "השרת לא ענה בזמן — נסו שוב" }, 504);
      }
      return json({ error: "הפעולה נכשלה", detail: msg.slice(0, 300) }, 500);
    }
  };
}
