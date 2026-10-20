// supabase/functions/send-login-code — קוד הכניסה במייל (20/10/2026). ההיגיון ב-handler.ts (שנבדק ב-Node); כאן
// רק החיבור.
//
// פריסה (פעם אחת, ממחשב הפיתוח), אחרי שמנהל ה-365 יצר את הרשמת האפליקציה (CLAUDE.md, "קוד כניסה במייל"):
//   supabase secrets set MS_TENANT_ID=... MS_CLIENT_ID=... MS_CLIENT_SECRET=...
//   supabase functions deploy send-login-code
// ⚠️ שלושת הערכים — מ-Entra, לא בקובץ: המאגר ציבורי. אפשר גם להזין אותם במסך Edge Functions → Secrets של Supabase.
// ⚠️ בלי --no-verify-jwt: רק מי שהתחבר בסיסמה מגיע לכאן, והשער של Supabase הוא שבודק את חתימת האסימון.
// ⚠️ trim לכל ערך — סוד WIZENET_TOKEN נשמר פעם עם שורה חדשה בסופו (15/10/2026).
import { makeHandler } from "./handler.ts";

const env = (k: string, d = "") => (Deno.env.get(k) ?? d).trim();

Deno.serve(makeHandler({
  supabaseUrl: env("SUPABASE_URL"),
  anonKey: env("SUPABASE_ANON_KEY"),
  serviceKey: env("SUPABASE_SERVICE_ROLE_KEY"),
  tenantId: env("MS_TENANT_ID"),
  clientId: env("MS_CLIENT_ID"),
  clientSecret: env("MS_CLIENT_SECRET"),
  from: env("LOGIN_CODE_FROM", "dashboard@parkomat.co.il"),
}));
