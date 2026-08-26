// services/fieldReportsDirect.js — דיווח מהשטח, ישירות ל-Supabase.
//
// ============================================================
// ⚠️ אין כאן זרוע שנייה, וזה מכוון
// ============================================================
// שאר המסכים עוברים דרך `dataSource.js` כי הם קיימים בשני המסלולים —
// ישירות ל-PostgREST, או דרך השרת. הדיווחים נולדו **אחרי** שהמתג הוכרע,
// ומעולם לא היה להם נתיב שרת. בניית אחד "לשלמות" הייתה יוצרת קוד רדום
// שאיש לא מריץ, וקובץ ההנחיות אומר במפורש מה קורה לנתיב כזה: הוא מרקיב.
//
// ⚠️ ואם המתג יוחזר אי-פעם ל-false, המסך הזה פשוט לא יעבוד — וזה עדיף על
// מסך שנראה עובד ושולח לשום מקום.
//
// כלל 5 נשמר: הרכיבים אינם מייבאים supabase-js. הם מייבאים מכאן.
import { supabase, isSupabaseConfigured } from "./supabase";

// ============================================================
// ⚠️ הדחיסה היא מה שהופך את זה לשמיש בטלפון
// ============================================================
// צילום מסך מאייפון הוא 2–5MB. ה-RPC חוסם מעל 2MB, כלומר בלי דחיסה
// **רוב הצילומים פשוט יידחו** — והמשתמש יקבל שגיאה על פעולה סבירה לגמרי.
//
// 1280px ברוחב הארוך זה מספיק כדי לקרוא טקסט על מסך בקר, ומוריד צילום
// טיפוסי לכ-150KB. JPEG ולא PNG: צילום מסך של ממשק גרפי נדחס פי כמה,
// והאיכות שנשמרת מספיקה בהחלט למה שהתמונה באה לומר.
//
// ⚠️ **והתקרה נאכפת שוב ב-SQL.** הדחיסה כאן חוסכת רשת; היא אינה גבול.
// DevTools פתוח עוקף אותה בשלוש שניות.
const MAX_EDGE = 1280;
const JPEG_QUALITY = 0.82;

export const MAX_FILES = 4;
export const MAX_BODY = 4000;
// ⚠️ אותו סף כמו ב-RPC. שני מספרים שונים היו יוצרים טופס שמאשר שם
// שהמסד דוחה — כלומר שגיאה אחרי לחיצה במקום לפניה.
export const MIN_NAME = 2;

/**
 * דוחס תמונה ומחזיר { mime, data } — data הוא base64 **נטו**, בלי הקידומת
 * `data:image/jpeg;base64,`. הקידומת נבנית בתצוגה מ-mime; שמירתה הייתה
 * כופלת מידע שכבר יש בעמודה שלידה.
 */
export async function compressImage(file) {
  // ⚠️ createImageBitmap ולא new Image(): הוא לא דורש הוספה ל-DOM, הוא
  // מכבד את ה-EXIF orientation בדפדפנים מודרניים, והוא אינו נכשל בשקט על
  // קובץ פגום — הוא זורק, וזה מה שמאפשר להודיע למשתמש.
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`"${file.name}" אינו תמונה שאפשר לקרוא`);
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  const comma = dataUrl.indexOf(",");
  if (comma === -1) throw new Error("דחיסת התמונה נכשלה");

  return { mime: "image/jpeg", data: dataUrl.slice(comma + 1) };
}

/**
 * ממיר שגיאת PostgREST להודעה בעברית.
 *
 * ⚠️ ה-RPC מנפיק **קודי SQLSTATE מכוונים** ולכן ההודעה שלו ניתנת להצגה
 * כמות שהיא. מה שצריך תרגום הוא `42501` — "permission denied for
 * function" — שהוא הודעה של Postgres ולא שלנו, ומי שיראה אותה לא יבין
 * שהמשמעות היא "אינך מחובר, או שהחשבון הושבת".
 */
function messageFor(error) {
  if (!error) return "שגיאה לא ידועה";
  if (error.code === "42501") {
    return "אין הרשאה — יש להתחבר מחדש, או שהחשבון הושבת";
  }
  return error.message || "הפעולה נכשלה";
}

/**
 * שליחת דיווח. `files` הוא מערך של קבצים מהדפדפן (File), לפני דחיסה.
 *
 * ⚠️ `reportedByName` הוא **חובה**, למרות שהזהות כבר מאומתת. הסיבה היא
 * ש-`sherut@parkomat.co.il` היא תיבה משותפת ולאף אחד מהמשתמשים אין
 * full_name — כלומר החשבון עונה על "מאיפה נשלח" ולא על "מי ראה".
 * אותו שדה ואותו נימוק בדיוק כמו בתחזוקה ידנית.
 */
export async function submitFieldReport({ body, siteCode = null, files = [], reportedByName = "" }) {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");

  // ⚠️ הדחיסה בטור ולא ב-Promise.all: ארבע תמונות במקביל על טלפון ישן
  // מקפיאות את הממשק לכמה שניות, והמשתמש לוחץ שוב.
  const compressed = [];
  for (const f of files.slice(0, MAX_FILES)) {
    compressed.push(await compressImage(f));
  }

  const { data, error } = await supabase.rpc("submit_field_report", {
    p_body: String(body ?? "").trim(),
    // ⚠️ נשלח **לצד** הזהות ולא במקומה. ה-RPC דוחה שם ריק או בן תו אחד;
    // הבדיקה כאן היא נוחות, לא גבול.
    p_reported_by_name: String(reportedByName ?? "").trim() || null,
    p_site_code: siteCode ? String(siteCode) : null,
    p_files: compressed,
  });

  if (error) throw new Error(messageFor(error));

  // ⚠️ RETURNS TABLE מגיע כמערך גם כשיש שורה אחת. בלי הפירוק הזה שכבת
  // ה-UI מקבלת מערך ומציגה undefined בשקט.
  const row = Array.isArray(data) ? data[0] : data;
  return { id: row?.id ?? null, createdAt: row?.created_at ?? null };
}

/**
 * רשימת הדיווחים. **RLS היא הסינון** — מנהלת מקבלת הכול, מדווח מקבל את
 * שלו. אין כאן שום תנאי הרשאה, ובכוונה: תנאי בקוד הזה היה נראה כמו הגנה
 * ואפשר לעקוף אותו בשורת fetch אחת.
 */
export async function fetchFieldReports({ status = null, limit = 100 } = {}) {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");

  let q = supabase
    .from("field_reports")
    .select("id, site_id, body, reported_by, reported_by_name, created_at, status, resolved_at, resolved_by, resolved_note")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (status) q = q.eq("status", status);

  const { data, error } = await q;
  if (error) throw new Error(messageFor(error));

  const rows = data || [];
  if (rows.length === 0) return [];

  // ============================================================
  // ⚠️ שאילתה אחת לכל התמונות, ולא אחת לכל דיווח
  // ============================================================
  // JOIN מקונן ב-PostgREST היה מביא את ה-base64 של **כל** התמונות יחד עם
  // הרשימה — כלומר מגה-בייטים לפני שמישהו פתח דיווח אחד. כאן מגיעים רק
  // המזהים והגדלים; ה-base64 נשלף כשפותחים.
  const ids = rows.map((r) => r.id);
  const { data: files, error: fErr } = await supabase
    .from("field_report_files")
    .select("id, report_id, mime, byte_size")
    .in("report_id", ids);
  if (fErr) throw new Error(messageFor(fErr));

  const byReport = new Map();
  for (const f of files || []) {
    if (!byReport.has(f.report_id)) byReport.set(f.report_id, []);
    byReport.get(f.report_id).push(f);
  }

  return rows.map((r) => ({ ...r, files: byReport.get(r.id) || [] }));
}

// ============================================================
// השיחה — שני הכיוונים
// ============================================================
// ⚠️ הבקשה המקורית הייתה "סוג של צ'אט", והגרסה הראשונה בנתה רק כיוון
// אחד. מי שדיווח לא ידע אם מישהו ראה, ולא היה לו למי לענות — וזה בדיוק
// מה שגורם לאנשים להפסיק לכתוב.

/** כל התשובות בשיחה. RLS היא הסינון — שיחה של מישהו אחר אינה מגיעה. */
export async function fetchReplies(reportId) {
  if (!isSupabaseConfigured) return [];
  const { data, error } = await supabase
    .from("field_report_replies")
    .select("id, report_id, body, author, author_name, created_at")
    .eq("report_id", reportId)
    .order("id", { ascending: true });
  if (error) throw new Error(messageFor(error));
  return data || [];
}

/** תשובה בשיחה. מנהלת, או בעל הדיווח — נאכף ב-RPC, לא כאן. */
export async function replyToReport(reportId, body) {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");
  const { error } = await supabase.rpc("reply_to_field_report", {
    p_report_id: reportId,
    p_body: String(body ?? "").trim(),
  });
  if (error) throw new Error(messageFor(error));
}

/** ה-base64 של תמונה בודדת — נשלף רק כשפותחים אותה. */
export async function fetchReportImage(fileId) {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");

  const { data, error } = await supabase
    .from("field_report_files")
    .select("mime, data_b64")
    .eq("id", fileId)
    .single();
  if (error) throw new Error(messageFor(error));

  return `data:${data.mime};base64,${data.data_b64}`;
}

/** סימון "טופל". מנהלת בלבד — נאכף ב-RPC, לא כאן. */
export async function resolveFieldReport(id, note = "") {
  if (!isSupabaseConfigured) throw new Error("Supabase אינו מוגדר בדשבורד");

  const { data, error } = await supabase.rpc("resolve_field_report", {
    p_id: id,
    p_note: note ? String(note).trim() : null,
  });
  if (error) throw new Error(messageFor(error));

  const row = Array.isArray(data) ? data[0] : data;
  // ⚠️ 0 אינו כשל: ייתכן ששניים לחצו יחד, או שהוא כבר טופל.
  return { updated: Number(row?.updated ?? 0) };
}
