// supabase/functions/ituran-sync — רכבי הטכנאים מאיתוראן, כל דקה מ-pg_cron (20/10/2026). ההיגיון ב-handler.ts (נבדק
// ב-Node); כאן רק החיבור.
//
// פריסה (פעם אחת, ממחשב הפיתוח):
//   supabase secrets set ITURAN_USERNAME=... ITURAN_PASSWORD=... ITURAN_CALLER_SECRET=<אקראי>
//   supabase functions deploy ituran-sync
//   ואז אותו ITURAN_CALLER_SECRET ל-settings.ituran_caller_secret — משם הסנכרון מתחיל (vehicles.postgres.sql).
// ⚠️ הערכים מאיתוראן — לא בקובץ: המאגר ציבורי. trim לכל ערך (סוד WIZENET_TOKEN נשמר פעם עם שורה חדשה בסופו).
import { makeHandler } from "./handler.ts";

const env = (k: string, d = "") => (Deno.env.get(k) ?? d).trim();

Deno.serve(makeHandler({
  supabaseUrl: env("SUPABASE_URL"),
  serviceKey: env("SUPABASE_SERVICE_ROLE_KEY"),
  callerSecret: env("ITURAN_CALLER_SECRET"),
  ituranBase: env("ITURAN_BASE", "https://api.ituran.com"),
  username: env("ITURAN_USERNAME"),
  password: env("ITURAN_PASSWORD"),
}));
