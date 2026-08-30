// hooks/useExecutiveStats.js — נתוני המנהל הכללי, עם פילטרים ו-debounce
import { useState, useEffect, useRef } from "react";
// דרך המתג: במצב ישיר הדשבורד שולף מ-Supabase ומריץ עליו את **אותה**
// computeExecutive שהשרת מריץ (shared/executive.mjs).
import { fetchExecutive } from "../services/dataSource";
import { createRunner } from "./fetchRunner";

// ============================================================
// ⚠️ שלוש מהירויות, ולא אחת
// ============================================================
// נמדד בדפדפן על הייצור: **כל שליפה של המסך הזה רצה פעמיים.** המסך
// נטען, ותוך שניות מגיעה הודעת SSE מאתר כלשהו, `dataVersion` עולה,
// והשליפה מתחילה שוב בזמן שהראשונה עדיין באוויר:
//
//     site_stats        1.58s  ו-  1.15s
//     site_uptime       1.71s  ו-   629ms
//     executive_series  2.44s  ו-  2.35s
//
// שתים-עשרה בקשות מקבילות מאיטות זו את זו — site_stats נמדד 1.58s
// בדפדפן מול 0.5s כשנמדד לבדו.
//
// ⚠️ **התיקון אינו לבטל את הרענון**; עדכון חי הוא כל הנקודה של המסך.
// הוא לא להריץ שניים במקביל (`createRunner`), ולתת לרענון מ-SSE חלון
// איחוד רחב יותר: הודעות מגיעות בפרצים מ-16 אתרים, ו-300ms אינן
// מספיקות כדי לאחד פרץ. הנתון הוא אגרגציה על 30 יום — שתי שניות אינן
// נראות בו, ושתי שליפות כבדות במקביל — כן.
const LIVE_DEBOUNCE_MS = 2000;

/**
 * params  — { period | from,to, sites, statuses, minFailureRate, groupBy, granularity }
 * version — עולה בכל הודעה חדשה (SSE) → שליפה מחדש
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

  // ⚠️ נוצר **פעם אחת** ומוחזק ב-ref. יצירה בכל רינדור הייתה מאפסת את
  // דגל "כבר באוויר", וההגנה כולה הייתה נעלמת בלי שום סימן.
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

    // • טעינה ראשונה — מיידית. כל השהיה כאן היא מסך ריק בלי סיבה.
    // • שינוי פילטר — 300ms. בקשה מפורשת של המשתמשת, מגיעה ביחידים.
    // • רענון מ-SSE — 2 שניות. ראה ההסבר למעלה.
    const isLive = !first.current && key === lastKey.current;
    const wait = first.current ? 0 : (isLive ? LIVE_DEBOUNCE_MS : debounceMs);
    first.current = false;
    lastKey.current = key;

    const timer = setTimeout(() => runner.current.run(key), wait);
    return () => clearTimeout(timer);
  }, [key, version, debounceMs]);

  return { data, loading, error };
}
