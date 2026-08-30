// services/executiveDirect.js — מסך ההנהלה ישירות מ-Supabase, בלי השרת.
//
// ============================================================
// מרכיב שני מקורות שכבר קיימים — ולא בונה שום דבר חדש
// ============================================================
// computeExecutive זקוקה לשלושה קלטים, ולכולם יש מסלול ישיר:
//
//   allRows  — שורות מסך הבקרה  -> fetchSupervisorDirect (site_stats/uptime/globals)
//   series   — הסדרה המצטברת    -> public.executive_series
//   allSites — רשימת האתרים     -> טבלת sites
//
// **לא נכתבה כאן שום אריתמטיקה.** כל החישוב — הדליים, מפת החום,
// הפילוחים, ה-KPI-ים — הוא shared/executive.mjs, אותו קובץ שהשרת מריץ.
//
// ============================================================
// ⚠️ מה השתנה, ולמה: 10,630 שורות הפכו ל-480
// ============================================================
// עד עכשיו הזרוע הזו שלפה שורות **גולמיות** — ops, status_history,
// maintenance_windows — והריצה עליהן את החישוב בדפדפן. נמדד על הייצור:
//
//     תצוגת חודש: 10,630 שורות · 1.6MB · 8 נסיעות רשת סדרתיות
//     תצוגת שנה : 14,386 שורות · 2.2MB
//
// וכל זה כדי להפיק גרף של 30 נקודות. `executive_series` מצטברת במסד
// ומחזירה שורה לכל (דלי × אתר): **480 שורות, 68KB, קריאה אחת.**
//
// ⚠️ **הזרוע הזו אינה מגדירה מדד מחדש.** ה-SQL מרכיב את site_uptime
// ואת app.error_segments — שכבר עברו parity מול ה-JS — ומוסיף רק פילוח
// כניסות/יציאות. `tools/parity-exec-series.js` מזין את שני הקלטים
// לאותה computeExecutive ודורש תוצאה זהה: 146 השוואות, 0 הבדלים.
//
// ⚠️ **וזה תפס באג אמיתי לפני האימוץ**: הגרסה הראשונה קראה ל-site_stats
// לכל דלי בנפרד, וקיפול הריצוד איבד את ההקשר שלפני הדלי. מגדל 1 קיבל
// JS=1 מול SQL=2 תקלות. לכן הקיפול רץ פעם אחת על **כל התקופה**.

import { supabase, isSupabaseConfigured } from "./supabase";
import { computeExecutive, getBucketRanges } from "../../../shared/executive.mjs";
import { fetchSupervisorDirect } from "./supervisorDirect";

function messageFor(error) {
  if (!error) return "שגיאה לא ידועה";
  if (error.code === "42501") return "אין הרשאת קריאה — נדרשת התחברות";
  return error.message || "השליפה נכשלה";
}

export async function fetchExecutiveDirect({ from, to, ...filters }) {
  if (!isSupabaseConfigured) {
    throw new Error("Supabase אינו מוגדר בדשבורד");
  }

  // ⚠️ הדליים נחתכים **כאן** באותה getBucketRanges ש-computeExecutive
  // תשתמש בה מיד אחר כך. מקור אמת אחד לגבולות התקופה — שכפול החיתוך
  // ב-SQL היה יוצר הגדרה שנייה, בדיוק מה ש-api/periods.js קיים למנוע.
  const buckets = getBucketRanges({ from, to, granularity: filters.granularity || "day" });

  // ⚠️ הדלי הנוסף בקצה הוא **כל הטווח**. הסיכומים (כניסות/יציאות
  // לאריחים מתחת לגרף) מחושבים ממנו ולא מסכימת הדליים — בדיוק כמו
  // שהענף הישן קורא ל-directionFromData על הטווח המלא בנפרד.
  const withTotal = [...buckets.map((b) => ({ from: b.from, to: b.to })), { from, to }];

  const [supervisor, seriesRes, sitesRes] = await Promise.all([
    fetchSupervisorDirect(from, to),
    // ⚠️ p_site_ids = null (כל האתרים). הסינון לפי פילטרים קורה ב-
    // computeExecutive על allRows, ו-foldSeries מסננת לפי selectedIds.
    // שליחת רשימה מסוננת לכאן הייתה מפצלת את הסינון לשני מקומות.
    supabase.rpc("executive_series", {
      p_site_ids: null,
      p_from: from,
      p_to: to,
      p_buckets: withTotal,
    }),
    supabase.from("sites").select("id, code, site_name"),
  ]);

  if (seriesRes.error) throw new Error(messageFor(seriesRes.error));
  if (sitesRes.error) throw new Error(messageFor(sitesRes.error));

  // ⚠️ הסדר חייב להיות זהה לשרת (getAllSites → ORDER BY code): computeExecutive
  // ממפה קוד→מזהה דרך allSites, וסדר שונה משנה איזה אתר נופל לאיזו שורה
  // במפת החום.
  const allSites = (sitesRes.data || [])
    .slice()
    .sort((a, b) => String(a.code).localeCompare(String(b.code)));

  return computeExecutive({
    allRows: supervisor.sites,
    series: seriesRes.data || [],
    allSites,
    from, to,
    ...filters,
  });
}
