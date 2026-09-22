// supabase/functions/service-calls — קליטת קריאות שירות מאפליקציית הלקוחות.
//
// ============================================================
// ⚠️ למה בכלל פונקציה, ולא POST ישיר ל-PostgREST
// ============================================================
// הדרישה מצוות האפליקציה הייתה **שלא ישתנה אצלם כלום** מלבד הכתובת:
// אותו גוף, אותן כותרות. PostgREST דורש כותרת `apikey` בכל בקשה, כלומר
// POST ישיר היה מחייב אותם לשנות את הבקשה — בדיוק מה שנשלל.
//
// לכן יש כאן דלת דקה: היא מאמתת סוד, מכניסה שורה, ומחזירה תשובה. אין בה
// לוגיקה עסקית, והיא אינה מפרשת את התוכן — ראה rule 3 ב-CLAUDE.md
// והתקדימים invite-user / provision-agent / notify-fault.
//
// ============================================================
// ⚠️ הכתובת היא חוזה שאי אפשר לשנות — ומכאן שני כללים
// ============================================================
// 1. **לא דוחים תוכן.** גוף שאינו JSON, שדה לא מוכר, קידוד מוזר — הכול
//    נשמר. ההודעה הראשונה שלהם היא מה שילמד אותנו את המבנה, ודחייה
//    שלה הייתה מוחקת בדיוק את המידע שבגללו הדלת נפתחה.
// 2. **הסוד יושב בכתובת**, כי אין להם דרך להוסיף כותרת. ⚠️ סוד בכתובת
//    נרשם ביומנים — של Supabase ושל כל מתווך בדרך — ולכן הוא מגן על
//    "מי מכניס", ולא על סודיות התוכן. הטבלה ממילא אינה ניתנת לקריאה
//    בלי זהות צוות, ולא ניתנת למחיקה או לעדכון בכלל.
//
// ⚠️ **ולמה לא מפתח הפרסום כסוד:** הוא מופיע בכל דפדפן שפותח את הדשבורד.
// דלת שנפתחת לו היא דלת פתוחה לכל אחד.
//
// ============================================================
// ⚠️ הזהות שמכניסה — ולא service_role
// ============================================================
// הפונקציה יכלה להכניס עם ה-Secret key ולעקוף RLS. היא אינה עושה זאת:
// היא מזדהה כמשתמש הקולט, ולכן **המסד** הוא שאוכף "הכנסה בלבד" — לא
// תשומת הלב של מי שכתב את הקובץ הזה. אם הקוד כאן ינסה יום אחד לקרוא או
// למחוק, הוא יקבל דחייה.
//
// פריסה (פעם אחת, ממחשב הפיתוח):
//   supabase functions deploy service-calls --no-verify-jwt
// ⚠️ `--no-verify-jwt` הוא חלק מהדרישה: הם אינם שולחים כותרת Authorization.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const INTAKE_EMAIL = Deno.env.get("INTAKE_EMAIL")!;       // המשתמש הקולט
const INTAKE_PASSWORD = Deno.env.get("INTAKE_PASSWORD")!;
const INTAKE_SECRET = Deno.env.get("INTAKE_SECRET")!;     // הסוד שבכתובת

const MAX_BYTES = 100_000;   // אותה תקרה כמו ב-CHECK בטבלה

// ============================================================
// ⚠️ האסימון — מוחזק כאן, מתחדש לבד
// ============================================================
// השאיפה הייתה אסימון קבוע לנצח; Supabase אינו מנפיק כזה בלי מפתח
// החתימה של הפרויקט. לכן הדלת מתחברת בעצמה פעם אחת ומחזיקה את האסימון
// בזיכרון. מבחינת צוות האפליקציה אין הבדל: הם שולחים בקשה אחת, תמיד.
//
// ⚠️ **והחידוש הוא על 401 ולא על שעון.** מדידת תוקף בצד שלנו היא ניחוש
// שנשבר בשקט ביום ש-Supabase ישנה את אורך החיים; תשובת 401 היא עובדה.
let token: string | null = null;

async function signIn(): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify({ email: INTAKE_EMAIL, password: INTAKE_PASSWORD }),
  });
  if (!res.ok) throw new Error(`intake sign-in failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return body.access_token as string;
}

async function insertRow(row: unknown, retry = true): Promise<Response> {
  if (!token) token = await signIn();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/service_calls`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: ANON_KEY,
      Authorization: `Bearer ${token}`,
      Prefer: "return=minimal",     // ⚠️ אין לו הרשאת קריאה, ובקשת החזרה הייתה נכשלת
    },
    body: JSON.stringify(row),
  });
  if (res.status === 401 && retry) {
    token = null;
    return insertRow(row, false);   // ⚠️ ניסיון אחד בלבד: לולאה על 401 קבוע היא הצפה
  }
  return res;
}

// ⚠️ השוואה בזמן קבוע: השוואת מחרוזות רגילה יוצאת ברגע שתו אינו תואם,
// וההפרש בזמן מאפשר לנחש סוד תו אחר תו. זה זול לעשות נכון.
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  // ⚠️ הסוד הוא המקטע האחרון בנתיב: /functions/v1/service-calls/<secret>
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const given = parts[parts.length - 1] ?? "";
  if (!INTAKE_SECRET || !sameSecret(given, INTAKE_SECRET)) {
    // ⚠️ 404 ולא 401: תשובה שמבדילה בין "כתובת לא קיימת" לבין "סוד שגוי"
    // מאשרת למי שמנחש שהוא מצא את הדלת הנכונה.
    return new Response("not found", { status: 404 });
  }

  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const raw = await req.text();
  if (raw.length === 0) return new Response(JSON.stringify({ ok: false, error: "empty body" }), { status: 400 });
  if (new TextEncoder().encode(raw).length > MAX_BYTES) {
    return new Response(JSON.stringify({ ok: false, error: "body too large" }), { status: 413 });
  }

  // ⚠️ פירוק שנכשל אינו שגיאה כאן — הוא נתון. השורה נכנסת עם payload ריק,
  // ואנחנו נראה בדיוק מה הגיע.
  let payload: unknown = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed;
  } catch { /* נשמר כ-raw בלבד */ }

  // הכותרות נשמרות כדי ללמוד מה הם שולחים. ⚠️ בלי כותרות רגישות: אם ביום
  // מן הימים תתווסף אצלם כותרת הרשאה, אין סיבה שהיא תשב אצלנו בטבלה.
  const headers: Record<string, string> = {};
  for (const [k, v] of req.headers) {
    const key = k.toLowerCase();
    if (key === "authorization" || key === "apikey" || key === "cookie") continue;
    headers[key] = v;
  }

  const res = await insertRow({
    raw,
    payload,
    headers,
    remote_ip: req.headers.get("x-forwarded-for") ?? null,
    source: "app",
  });

  if (!res.ok) {
    // ⚠️ הטקסט נרשם ביומן ואינו חוזר אליהם: הודעת שגיאה של המסד מספרת על
    // המבנה הפנימי שלנו, ולצד השני היא אינה מוסיפה דבר שהוא יכול לתקן.
    console.error("intake insert failed", res.status, await res.text());
    return new Response(JSON.stringify({ ok: false }), { status: 502 });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
