// supabase/functions/notify-tech — הצפצוף לטלפון של הטכנאי (21/10/2026). ההיגיון ב-handler.ts (שנבדק ב-Node); כאן החיבור
// ל-Web Push (@negrel/webpush, כמו notify-fault) ולסודות.
//
// פריסה: npx supabase functions deploy notify-tech --project-ref xvfsikwaaaohnmldjbtv --use-api
// ⚠️ בלי סודות חדשים: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT ו-PUSH_CALLER_SECRET כבר מוגדרים (notify-fault).
// ⚠️ pg_net שולח את מפתח ה-anon כ-Bearer (כמו ituran-sync), ולכן בלי --no-verify-jwt.
import * as webpush from "jsr:@negrel/webpush";
import { makeHandler, type Sub } from "./handler.ts";

const env = (k: string, d = "") => (Deno.env.get(k) ?? d).trim();
const VAPID_PUBLIC = env("VAPID_PUBLIC_KEY");
const VAPID_PRIVATE = env("VAPID_PRIVATE_KEY");
const VAPID_SUBJECT = env("VAPID_SUBJECT", "mailto:admin@parkomat.co.il");

// ⚠️ המפתחות שמורים כ-base64url (web-push generate-vapid-keys), והספרייה מצפה ל-JWK — אותה המרה כמו ב-notify-fault.
function b64urlToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from([...bin].map((c) => c.charCodeAt(0)));
}
function bytesToB64url(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function vapidJwk(pub: string, priv: string) {
  const raw = b64urlToBytes(pub);
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error("VAPID_PUBLIC_KEY אינו נקודת P-256 לא-דחוסה");
  const x = bytesToB64url(raw.slice(1, 33));
  const y = bytesToB64url(raw.slice(33, 65));
  return {
    publicKey: { kty: "EC", crv: "P-256", x, y, ext: true },
    privateKey: { kty: "EC", crv: "P-256", x, y, d: priv, ext: true },
  };
}

let server: Promise<webpush.ApplicationServer> | null = null;
const appServer = () => (server ??= (async () => webpush.ApplicationServer.new({
  contactInformation: VAPID_SUBJECT,
  vapidKeys: await webpush.importVapidKeys(vapidJwk(VAPID_PUBLIC, VAPID_PRIVATE), { extractable: false }),
}))());

// דחוף (מנסה למסור מיד, גם לטלפון בחיסכון סוללה), ותקף 10 דקות — צפצוף מאוחר יותר כבר לא רלוונטי (התזכורת תבוא)
const send = async (s: Sub, payload: string) => {
  const srv = await appServer();
  await srv.subscribe({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } })
    // deno-lint-ignore no-explicit-any
    .pushTextMessage(payload, { urgency: "high", ttl: 600 } as any);
};

Deno.serve(makeHandler({
  supabaseUrl: env("SUPABASE_URL"),
  serviceKey: env("SUPABASE_SERVICE_ROLE_KEY"),
  callerSecret: env("PUSH_CALLER_SECRET"),
}, fetch, send));
