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

// ============================================================
// ⚠️ איחוד בקשות — כי לא הצלחתי לאתר את מקור הכפילות
// ============================================================
// נמדד בדפדפן על הייצור, ארבע פעמים ברצף: **fetchExecutiveDirect רץ
// פעמיים בכל טעינה** — שני גלים מלאים של שמונה בקשות.
//
//     site_stats        1.53s  ו-  911ms
//     site_uptime       1.36s  ו-  898ms
//     executive_series  2.55s  ו-  2.51s
//
// ⚠️ **חיפשתי את הטריגר ולא מצאתי אותו בוודאות.** נשללו: השהיה
// (debounce לא עוזר כשאין שקט), חסם קצב ב-hook (שני הקוראים "ראשונים",
// כלומר הרכיב מותקן מחדש), StrictMode (אינו מכפיל בבנייה לייצור),
// ו-onReconnect של Realtime (יש לו כבר הגנה על החיבור הראשון).
//
// החשוד שנותר הוא AuthGate: הוא מציג ספינר עד ש-mfaChecked מתמלא,
// ומאפס אותו כש-user מהבהב — ואז App כולו נעקר ומותקן מחדש.
//
// ⚠️ **ובמקום לתקן ניחוש חמישי, ההגנה יושבת כאן.** שתי קריאות זהות
// בתוך חלון קצר הן **אותה שאלה**, ואין סיבה לשאול אותה פעמיים — לא
// משנה מי שאל. זו לא הסתרה של הבאג: הכפילות עדיין תיראה כקריאה אחת
// ל-fetchExecutiveDirect, פשוט לא כשמונה בקשות רשת.
//
// ⚠️ החלון קצר בכוונה. הוא נועד לאחד **גל טעינה**, לא לשמש מטמון —
// מטמון היה מחזיר נתון ישן אחרי שינוי פילטר, וזה כשל שקט.
const COALESCE_MS = 5000;
let lastKey = null;
let lastAt = 0;
let lastPromise = null;


function messageFor(error) {
  if (!error) return "שגיאה לא ידועה";
  if (error.code === "42501") return "אין הרשאת קריאה — נדרשת התחברות";
  return error.message || "השליפה נכשלה";
}

export async function fetchExecutiveDirect(params) {
  if (!isSupabaseConfigured) {
    throw new Error("Supabase אינו מוגדר בדשבורד");
  }

  const cacheKey = JSON.stringify(params);
  if (lastPromise && lastKey === cacheKey && Date.now() - lastAt < COALESCE_MS) {
    return lastPromise;
  }
  lastKey = cacheKey;
  lastAt = Date.now();
  lastPromise = runExecutive(params);
  // ⚠️ כישלון אינו נשמר: ניסיון חוזר אחרי שגיאה חייב באמת לרוץ.
  lastPromise.catch(() => { if (lastKey === cacheKey) lastPromise = null; });
  return lastPromise;
}

async function runExecutive({ from, to, ...filters }) {

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
