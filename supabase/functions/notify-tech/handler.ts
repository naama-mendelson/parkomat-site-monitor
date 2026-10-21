// supabase/functions/notify-tech/handler.ts — הצפצוף לטלפון של הטכנאי כשנשלחת אליו משימה (21/10/2026, שלב 4 של "צא ל:").
//
// בעלת המוצר: "בסופו של דבר אני רוצה שזה יצפצף לאותו טכנאי". נקראת מ-pg_net בלבד (app.tech_push_request — בשליחה,
// ובתזכורת כל 2 דקות עד 3, עד "קיבלתי"), עם הסוד המשותף של ה-push (PUSH_CALLER_SECRET, כמו notify-fault).
//
// ⚠️ **אין כאן לוגיקה עסקית (rule 3).** האם לשלוח, למי ומה כתוב — public.tech_push_claim (master/db/technicians.postgres.sql);
// מה הגיע ומה למחוק — public.tech_push_result. כאן רק: לאמת את הקורא, לבקש מהמסד, לשלוח Web Push לכל מכשיר, ולדווח.
// ⚠️ מנוי שנעלם = HTTP 404/410 משירות ה-push — **רק אלה** נמחקים. ⚠️ PushMessageError של @negrel/webpush נוצר בלי הודעה
// (super() ריק) — הסטטוס ב-error.response.status, לא בטקסט. (notify-fault מחפש "410" בטקסט, ולכן אינו מוחק לעולם.)
//
// ⚠️ קובץ נפרד מ-index.ts כדי שאפשר יהיה לבדוק אותו ב-Node (master/tests/notify-tech-fn.test.js), עם fetch ושולח מוזרקים.

export type Env = {
  supabaseUrl: string;
  serviceKey: string;      // ⚠️ סוד — מהסביבה של Supabase
  callerSecret: string;    // PUSH_CALLER_SECRET — אותו ערך כמו settings.push_caller_secret
};
export type Sub = { id: number; endpoint: string; p256dh: string; auth: string };
export type Sender = (sub: Sub, payload: string) => Promise<void>;   // זורק כשהשליחה נכשלה

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const TIMEOUT_MS = 15_000;

function sameSecret(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

/** הסטטוס של שגיאת שליחה: response.status (PushMessageError), status, או מספר בטקסט. */
export function pushStatus(e: unknown): number | null {
  const o = e as { response?: { status?: number }; status?: number; statusCode?: number; message?: string } | null;
  const s = o?.response?.status ?? o?.status ?? o?.statusCode;
  if (Number.isInteger(s)) return Number(s);
  const m = /\b(4\d\d|5\d\d)\b/.exec(String(o?.message ?? e ?? ""));
  return m ? Number(m[1]) : null;
}

export function makeHandler(env: Env, f: typeof fetch = fetch, send: Sender) {
  const rpc = async (fn: string, args: unknown) => {
    const res = await f(`${env.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: env.serviceKey, Authorization: `Bearer ${env.serviceKey}` },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { ok: res.ok, status: res.status, data };
  };

  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (!env.callerSecret || !env.serviceKey) return json({ error: "not configured" }, 503);
    if (!sameSecret(req.headers.get("x-parkomat-push-secret") ?? "", env.callerSecret)) return json({ error: "unauthorized" }, 401);
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const id = Number(body?.dispatch_id);
    if (!Number.isInteger(id) || id <= 0) return json({ error: "dispatch_id" }, 400);

    try {
      const c = await rpc("tech_push_claim", { p_dispatch: id });
      if (!c.ok) return json({ error: `claim ${c.status}` }, 502);
      const claim = c.data as { send?: boolean; reason?: string; n?: number; title?: string; body?: string; tag?: string; subs?: Sub[] };
      if (!claim?.send) return json({ sent: 0, reason: claim?.reason ?? "unknown" });

      // ⚠️ השדות ש-sw.js קורא: kind = "dispatch" מבדיל מהתראות התקלות; tag — אחד לכל משימה, כך שתזכורת מחליפה את הקודמת
      const payload = JSON.stringify({ kind: "dispatch", id, n: claim.n ?? 1, title: claim.title ?? "משימה חדשה",
                                       body: claim.body ?? "", tag: claim.tag ?? `dispatch-${id}`, url: "/" });
      let sent = 0;
      const dead: number[] = [];
      const errors: string[] = [];
      await Promise.all((claim.subs ?? []).map(async (s) => {
        try {
          await send(s, payload);
          sent++;
        } catch (e) {
          const st = pushStatus(e);
          if (st === 404 || st === 410) dead.push(s.id);
          else errors.push(st ? `שירות ההתראות סירב (${st})` : "שירות ההתראות לא ענה");
        }
      }));
      const error = sent > 0 ? null : (errors[0] ?? (dead.length ? "הטלפון הסיר את ההרשמה לצפצוף — יש להפעיל צפצוף מחדש" : null));
      await rpc("tech_push_result", { p_dispatch: id, p_sent: sent, p_dead: dead, p_error: error });
      return json({ sent, removed: dead.length, n: claim.n ?? 1 });
    } catch (e) {
      const name = (e as Error)?.name ?? "";
      return json({ error: name === "TimeoutError" || name === "AbortError" ? "timeout" : "failed" }, 502);
    }
  };
}
