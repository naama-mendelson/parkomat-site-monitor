// hooks/useExecutiveStats.js — נתוני המנהל הכללי, עם פילטרים ו-debounce
import { useState, useEffect, useRef } from "react";
import { fetchExecutiveStats } from "../services/api";

/**
 * params  — { period | from,to, sites, statuses, minFailureRate, groupBy, granularity }
 * version — עולה בכל הודעה חדשה (SSE) → שליפה מחדש
 *
 * debounce: גרירת סליידר או הקלדת תאריך משנה פילטרים במהירות; בלי השהיה
 * היינו יורים עשרות בקשות כבדות (אגרגציה על כל האתרים) לשרת.
 */
export function useExecutiveStats(params, version = 0, debounceMs = 300) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // מפתח יציב — מונע שליפה מחדש כשהאובייקט נוצר מחדש עם אותם ערכים
  const key = JSON.stringify(params);
  const first = useRef(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    // הבקשה הראשונה מיידית; רק שינויי פילטר נדחים
    const wait = first.current ? 0 : debounceMs;
    first.current = false;

    const timer = setTimeout(() => {
      fetchExecutiveStats(JSON.parse(key))
        .then((r) => { if (!cancelled) setData(r); })
        .catch((e) => { if (!cancelled) setError(e.message); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, wait);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, version, debounceMs]);

  return { data, loading, error };
}
