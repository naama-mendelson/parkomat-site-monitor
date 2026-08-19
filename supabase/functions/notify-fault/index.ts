// supabase/functions/notify-fault — שולחת התראת push על אירוע באתר.
//
// ============================================================
// למה זה כאן ולא ב-master
// ============================================================
// ⚠️ ה-master נופל, וזה בדיוק הרגע שבו ההתראה נחוצה. Edge Function רצה
// בתשתית של Supabase, כלומר באותו מקום שבו כבר יושב הנתון — ואינה תלויה
// במחשב שבמשרד.
//
// ⚠️ **ומה שזה עדיין לא פותר, ויש לומר במפורש:** הקליטה מ-MQTT יושבת
// ב-master. אם הוא למטה, האירוע **אינו מתגלה כלל** ואין על מה להתריע.
// ההעברה לכאן מגנה מפני "השרת רץ והשולח נתקע", לא מפני שרת שנפל.
//
// ============================================================
// מי קורא לה
// ============================================================
// טריגר AFTER INSERT על status_history, דרך pg_net (אסינכרוני).
// ⚠️ האסינכרוניות היא תנאי: טריגר סינכרוני שנכשל היה מגלגל אחורה את
// **רישום התקלה עצמו** — התראה שנכשלה הייתה מוחקת את הנתון.
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:lolek@parkomat.co.il";

// ⚠️ מפתח השירות ולא ה-publishable: הפונקציה חייבת לקרוא את המנויים של
// **כל** המשתמשים, ו-RLS על push_subscriptions מגבילה כל אחד לשלו. זו
// בדיוק הסיבה שהשליחה אינה יכולה לרוץ בדפדפן.
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const TITLES: Record<string, string> = {
  fault: "תקלה",
  no_comm: "ניתוק תקשורת",
  maintenance: "תחזוקה",
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const body = await req.json().catch(() => null);
  if (!body?.site_id || !body?.kind) {
    return new Response(JSON.stringify({ error: "חסר site_id או kind" }), { status: 400 });
  }
  const { site_id, site_code, site_name, kind, fault_text } = body;

  // ============================================================
  // מניעת הצפה — הערך מ-settings, לא מהקוד
  // ============================================================
  // ⚠️ נשמר ב-settings כדי שכיוונו יהיה UPDATE אחד ולא סבב פריסה: את
  // החלון הנכון יודעים רק **אחרי** שרואים כמה התראות מגיעות בפועל.
  // ⚠️ ו-0 אינו מקרה מיוחד — הוא "בלי דילוג", כלומר כל אירוע נשלח.
  const { data: setting } = await db.from("settings")
    .select("value").eq("key", "push_window_minutes").maybeSingle();
  const windowMin = Number(setting?.value ?? 10);

  if (windowMin > 0) {
    const { data: last } = await db.from("push_last_sent")
      .select("sent_at").eq("site_id", site_id).maybeSingle();
    if (last?.sent_at) {
      const ageMin = (Date.now() - Date.parse(last.sent_at)) / 60000;
      if (ageMin < windowMin) {
        // ⚠️ 200 ולא 429: הקורא הוא טריגר, לא לקוח. שגיאה כאן הייתה נרשמת
        // בתור של pg_net כתקלה חוזרת, בעוד שדילוג מכוון הוא הצלחה.
        return new Response(JSON.stringify({ skipped: "rate-limited", ageMin }), { status: 200 });
      }
    }
  }

  // ⚠️ הכלל "מי מנוי" חי **רק** ב-SQL. שכפולו כאן היה נפרד ביום שבו מישהו
  // יתקן אחד מהם, והתסמין הוא התראה שלא הגיעה — כשל שקט בלי שום סימן.
  const { data: targets, error } = await db.rpc("push_targets_for_site", {
    p_site_id: site_id, p_kind: kind,
  });
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  if (!targets?.length) {
    return new Response(JSON.stringify({ sent: 0, reason: "אין מנויים" }), { status: 200 });
  }

  const server = await webpush.ApplicationServer.new({
    contactInformation: VAPID_SUBJECT,
    vapidKeys: await webpush.importVapidKeys(
      { publicKey: VAPID_PUBLIC, privateKey: VAPID_PRIVATE },
      { extractable: false },
    ),
  });

  const payload = JSON.stringify({
    kind,
    code: site_code,
    siteName: site_name || site_code,
    faultText: fault_text || null,
    title: TITLES[kind] ?? "אירוע",
  });

  let sent = 0;
  const dead: number[] = [];

  await Promise.all(targets.map(async (t: any) => {
    try {
      await server.subscribe({
        endpoint: t.endpoint,
        keys: { p256dh: t.p256dh, auth: t.auth },
      }).pushTextMessage(payload, {});
      sent++;
    } catch (e) {
      // ⚠️ 404/410 = המכשיר הוסר אצל שירות ה-push. **רק אלה** מוחקים.
      // ניתוק רשת חולף אינו מכשיר שנעלם, ומחיקה עליו הייתה משתיקה משתמש
      // אמיתי בשקט — בלי שהוא ידע ובלי שנדע.
      const msg = String(e?.message ?? e);
      if (msg.includes("410") || msg.includes("404")) dead.push(t.subscription_id);
    }
  }));

  if (dead.length) {
    await db.from("push_subscriptions").delete().in("id", dead);
  }

  // ⚠️ נרשם רק כששלחנו בפועל. עדכון גם על 0 נשלחו היה משתיק את האתר
  // לחלון שלם בגלל ניסיון שלא הגיע לאיש.
  if (sent > 0) {
    await db.from("push_last_sent")
      .upsert({ site_id, sent_at: new Date().toISOString() }, { onConflict: "site_id" });
  }

  return new Response(JSON.stringify({ sent, removed: dead.length }), {
    status: 200, headers: { "content-type": "application/json" },
  });
});
