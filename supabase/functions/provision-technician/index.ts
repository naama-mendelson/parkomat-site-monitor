// supabase/functions/provision-technician — משתמש לטלפון של טכנאי, ל-QR שבכרטיס (21/10/2026). ההיגיון ב-handler.ts
// (שנבדק ב-Node); כאן רק החיבור.
//
// פריסה, ממחשב הפיתוח:
//   npx supabase functions deploy provision-technician --project-ref xvfsikwaaaohnmldjbtv --use-api
// ⚠️ בלי --no-verify-jwt: רק מי שהתחבר מגיע לכאן, והשער של Supabase בודק את חתימת האסימון. ההרשאה עצמה (עורך,
// בפיילוט) — ב-tech_phone_begin, בזהות הקורא.
// ⚠️ אין סודות משלה: SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY — Supabase מציב אותם בעצמו.
import { makeHandler } from "./handler.ts";

const env = (k: string) => (Deno.env.get(k) ?? "").trim();

Deno.serve(makeHandler({
  supabaseUrl: env("SUPABASE_URL"),
  anonKey: env("SUPABASE_ANON_KEY"),
  serviceKey: env("SUPABASE_SERVICE_ROLE_KEY"),
}));
