// hooks/useExecutiveStats.js — נתוני המנהל הכללי, עם פילטרים וחסם קצב
import { useState, useEffect, useRef } from "react";
// דרך המתג: במצב ישיר הדשבורד שולף מ-Supabase ומריץ עליו את **אותה**
// computeExecutive שהשרת מריץ (shared/executive.mjs).
import { fetchExecutive } from "../services/dataSource";
import { createRunner } from "./fetchRunner";

// ============================================================
// ⚠️ חסם קצב, לא השהיה — וזו ההבחנה שהחמצתי פעמיים
// ============================================================
// נמדד בדפדפן על הייצור, שוב ושוב: **כל טעינה של המסך הזה שולפת הכול
// פעמיים.**
//
//     site_stats        2.32s  ו-  1.97s
//     site_uptime       2.02s  ו-   977ms
//     executive_series  3.54s  ו-  3.38s
//
// המקור: המסך נטען, ותוך שניות מגיעה הודעת SSE מאחד מ-16 האתרים,
// `dataVersion` עולה, והמסך שולף את הכול מחדש.
//
// ⚠️ **השהיה (debounce) לא פותרת את זה.** היא ממתינה לשקט — ואצל 16
// אתרים שמדווחים כל הזמן, שקט אין. ניסיתי 2 שניות, והגל השני פשוט זז
// שתי שניות אחורה במקום להיעלם.
//
// ⚠️ **והשליפה השנייה מיותרת מיסודה.** המסך הזה הוא אגרגציה על 30 יום;
// פעולה אחת משנה אותו בכ-0.03%. לשלם 12 בקשות ו-2.4 שניות כדי לא לשנות
// כלום זה בזבוז, לא עדכניות.
//
// לכן: **לכל היותר רענון אחד בדקה.** הטעינה עצמה נחשבת רענון, ולכן הגל
// השני בטעינה נעלם לגמרי. זה גם מתיישב עם מה שכבר קיים — App.jsx מריץ
// resync תקופתי כל 60 שניות, מאותו שיקול בדיוק.
//
// ⚠️ המחיר, במפורש: מספר על המסך יכול להיות ישן בעד דקה. באגרגציה של
// 30 יום זה בלתי נראה; שתי שליפות כבדות בכל טעינה — נראות מאוד.
const LIVE_MIN_INTERVAL_MS = 60_000;

/**
 * params  — { period | from,to, sites, statuses, minFailureRate, groupBy, granularity }
 * version — עולה בכל הודעה חדשה (SSE) → מועמד לרענון, בכפוף לחסם הקצב
 *
 * debounce: גרירת סליידר או הקלדת תאריך משנה פילטרים במהירות; בלי השהיה
 * היינו יורים עשרות בקשות כבדות (אגרגציה על כל האתרים).
 */
export function useExecutiveStats(params, version = 0, debounceMs = 300) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // מפתח יציב — מונע שליפה מחדש כשהאובייקט נוצר מחדש עם אותם ערכים
  const key = JSON.stringify(params);

  // ⚠️ refs ולא state: שינוי state כאן היה מרנדר מחדש ומריץ את ה-effect,
  // כלומר המנגנון שנועד למנוע שליפה כפולה היה יוצר אחת.
  const latestKey = useRef(null);
  const lastKey = useRef(null);
  const first = useRef(true);
  const lastRunAt = useRef(0);

  // ⚠️ נוצר **פעם אחת** ומוחזק ב-ref. יצירה בכל רינדור הייתה מאפסת את
  // דגל "כבר באוויר", וההגנה מפני שתי שליפות מקבילות הייתה נעלמת בלי
  // שום סימן.
  const runner = useRef(null);
  if (!runner.current) {
    runner.current = createRunner({
      fetcher: (k) => fetchExecutive(JSON.parse(k)),
      getLatest: () => latestKey.current,
      on: { data: setData, error: setError, loading: setLoading },
    });
  }

  useEffect(() => {
    latestKey.current = key;

    const isFirst = first.current;
    // "חי" = רק ה-version זז, הפילטרים לא. שינוי פילטר הוא בקשה מפורשת
    // של המשתמשת ואינו כפוף לחסם — היא מחכה לתשובה עכשיו.
    const isLive = !isFirst && key === lastKey.current;
    first.current = false;
    lastKey.current = key;

    let wait;
    if (isFirst) {
      wait = 0;                       // טעינה — מיידית. מסך ריק בלי סיבה הוא הגרוע מכול.
    } else if (isLive) {
      wait = Math.max(0, LIVE_MIN_INTERVAL_MS - (Date.now() - lastRunAt.current));
    } else {
      wait = debounceMs;              // שינוי פילטר
    }

    const timer = setTimeout(() => {
      lastRunAt.current = Date.now();
      runner.current.run(key);
    }, wait);
    return () => clearTimeout(timer);
  }, [key, version, debounceMs]);

  return { data, loading, error };
}
