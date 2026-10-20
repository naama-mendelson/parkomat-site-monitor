// supabase/functions/ituran-sync/handler.ts — מושכת את רכבי הטכנאים מאיתוראן ומעבירה אותם למסד (20/10/2026).
//
// נקראת מ-pg_cron כל דקה (app.ituran_sync_request, vehicles.postgres.sql) — לא מהדפדפן. מה שהיא עושה: מחזיקה טוקן של
// איתוראן, מושכת GET /api/v2/vehicles (עם LastLocation, Driver, Places — בלעדיהם איתוראן לא מחזירים מיקום; נמדד),
// ומעבירה את המערך **כמות שהוא** ל-public.ituran_ingest. כל הפענוח, השעון והמחיקה — ב-SQL (rule 3).
//
// ⚠️ **הטוקן בזיכרון בלבד, לא במסד ולא בקובץ** — כמו הטוקן של ויזנט. תקף 24 שעות (expires_in=1440 דקות); מופע חם
// משתמש בו שוב, מופע קר מבקש חדש (ונספר ב-vehicles_sync.token_fetches, כדי שנדע כמה פעמים זה קורה באמת). לפני שפג —
// חידוש ב-refresh_token; אם החידוש נכשל — שם משתמש וסיסמה. 401 מהרכבים = טוקן שבוטל אצלם: טוקן חדש, פעם אחת.
//
// ⚠️ **מי רשאי לקרוא — סוד משותף**, כמו notify-fault: השער של Supabase מעביר כל מי שמחזיק את המפתח הפומבי (והוא בכל
// דפדפן), ולכן הפונקציה דורשת x-parkomat-ituran-secret ששווה ל-ITURAN_CALLER_SECRET. בלי סוד מוגדר — סגור, לא פתוח.
//
// ⚠️ קובץ נפרד מ-index.ts כדי שאפשר יהיה לבדוק אותו ב-Node (master/tests/ituran-sync-fn.test.js), עם fetch מוזרק.

export type Env = {
  supabaseUrl: string;
  serviceKey: string;      // ⚠️ סוד — מהסביבה של Supabase
  callerSecret: string;    // ⚠️ סוד — זהה ל-settings.ituran_caller_secret
  ituranBase: string;      // https://api.ituran.com
  username: string;        // משתמש ה-API שאיתוראן הקימו
  password: string;        // ⚠️ סוד
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const TIMEOUT_MS = 20_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const RENEW_BEFORE_MS = 5 * 60_000;   // מחדשים 5 דקות לפני שפג, לא אחרי שסירבו

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function makeHandler(env: Env, f: typeof fetch = fetch, now: () => number = Date.now) {
  let tok = { access: "", refresh: "", exp: 0 };

  const call = (url: string, init: RequestInit) => f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

  const rpc = async (fn: string, args: unknown) => {
    const res = await call(`${env.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: env.serviceKey, Authorization: `Bearer ${env.serviceKey}` },
      body: JSON.stringify(args),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Supabase ${fn}: ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };

  const tokenRequest = (body: Record<string, unknown>) =>
    call(`${env.ituranBase}/api/v1/oauth/token`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });

  // { token, fresh } — fresh = הונפק עכשיו
  const getToken = async (force: boolean) => {
    if (!force && tok.access && tok.exp - RENEW_BEFORE_MS > now()) return { token: tok.access, fresh: false };
    let res: Response | null = null;
    if (!force && tok.refresh) {
      res = await tokenRequest({ grant_type: "refresh_token", refresh_token: tok.refresh });
      if (!res.ok) res = null;   // חידוש שנכשל — לא תקלה עדיין; שם משתמש וסיסמה
    }
    if (!res) res = await tokenRequest({ grant_type: "password", username: env.username, password: env.password });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok || typeof body.access_token !== "string" || !body.access_token) {
      tok = { access: "", refresh: "", exp: 0 };
      throw new Error(`איתוראן סירבו להתחבר (${res.status})`);
    }
    tok = {
      access: body.access_token,
      refresh: typeof body.refresh_token === "string" ? body.refresh_token : "",
      exp: now() + Number(body.expires_in ?? 60) * 60_000,
    };
    return { token: tok.access, fresh: true };
  };

  // { status, list, complete, pages } — status 401 = הטוקן לא תקף אצלם
  const vehicles = async (token: string) => {
    const list: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const q = `page_number=${page}&page_size=${PAGE_SIZE}` +
        "&realtime_fields=LastLocation&realtime_fields=Driver&realtime_fields=Places";
      const res = await call(`${env.ituranBase}/api/v2/vehicles?${q}`, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) return { status: 401, list, complete: false, pages: page - 1 };
      if (!res.ok) throw new Error(`איתוראן החזירו ${res.status} ברשימת הרכבים`);
      const body = await res.json().catch(() => ({})) as { vehicles?: unknown[]; metadata?: { pagination?: { page_count?: number } } };
      list.push(...(Array.isArray(body.vehicles) ? body.vehicles : []));
      const pageCount = Number(body.metadata?.pagination?.page_count ?? 1);
      if (page >= pageCount) return { status: 200, list, complete: true, pages: page };
    }
    return { status: 200, list, complete: false, pages: MAX_PAGES };   // יותר מ-2,000 רכבים — לא מוחקים על סמך חצי רשימה
  };

  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (!env.callerSecret) return json({ error: "ITURAN_CALLER_SECRET אינו מוגדר" }, 503);
    if (!sameSecret(req.headers.get("x-parkomat-ituran-secret") ?? "", env.callerSecret)) return json({ error: "אין הרשאה" }, 401);
    if (!env.serviceKey) return json({ error: "SUPABASE_SERVICE_ROLE_KEY חסר" }, 503);

    const t0 = now();
    try {
      if (!env.username || !env.password) throw new Error("פרטי ההתחברות לאיתוראן לא הוגדרו (ITURAN_USERNAME / ITURAN_PASSWORD)");
      let { token, fresh } = await getToken(false);
      let r = await vehicles(token);
      if (r.status === 401) {
        ({ token } = await getToken(true));
        fresh = true;
        r = await vehicles(token);
        if (r.status === 401) throw new Error("איתוראן דחו את הטוקן גם אחרי התחברות מחדש");
      }
      const n = await rpc("ituran_ingest", {
        p_vehicles: r.list,
        p_meta: { complete: r.complete, token_fresh: fresh, pages: r.pages, ms: now() - t0 },
      });
      return json({ ok: true, vehicles: n, complete: r.complete });
    } catch (e) {
      const name = String((e as Error)?.name ?? "");
      const raw = String((e as Error)?.message ?? e);
      const msg = name === "TimeoutError" || name === "AbortError" || /time[d ]*out|abort/i.test(raw)
        ? "איתוראן לא ענו בזמן" : raw;
      await rpc("ituran_sync_failed", { p_error: msg }).catch(() => null);
      return json({ error: msg.slice(0, 300) }, 502);
    }
  };
}
