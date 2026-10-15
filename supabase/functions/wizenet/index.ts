// supabase/functions/wizenet — הדלת לטוקן של ויזנט, לממסרים (מחשבי אתרים) בלבד. ההיגיון ב-handler.ts (שנבדק
// ב-Node); כאן רק החיבור.
//
// פריסה (פעם אחת, ממחשב הפיתוח):
//   supabase secrets set WIZENET_TOKEN=... WIZENET_QRY_STATUS=... WIZENET_QRY_TYPE=...
//   supabase functions deploy wizenet
// ⚠️ שלושת הערכים — מוויזנט (הטוקן נמסר מהם; מזהי השאילתות מקבצי ההסבר). לא בקובץ: המאגר ציבורי.
// ⚠️ בלי --no-verify-jwt: רק משתמש מחובר מגיע לכאן.
import { makeHandler } from "./handler.ts";

Deno.serve(makeHandler({
  supabaseUrl: Deno.env.get("SUPABASE_URL")!,
  anonKey: Deno.env.get("SUPABASE_ANON_KEY")!,
  wizenetBase: Deno.env.get("WIZENET_BASE") ?? "https://parkomat.wizenet.co.il/WIZEAPI/Default.aspx",
  token: Deno.env.get("WIZENET_TOKEN") ?? "",
  qryStatus: Deno.env.get("WIZENET_QRY_STATUS") ?? "",
  qryType: Deno.env.get("WIZENET_QRY_TYPE") ?? "",
}));
