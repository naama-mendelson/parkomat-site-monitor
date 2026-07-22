// hooks/useSiteAnalytics.js — שליפת נתוני האנליטיקה של אתר לפי תקופה
import { useState, useEffect, useRef } from "react";
import { fetchSiteAnalytics } from "../services/api";

// code: קוד האתר | period: 'week' | 'month' | 'year'
// version: מונה שמתעדכן בכל הודעה חדשה מהאתר (SSE) — מאלץ שליפה מחדש,
//          כך שהנתונים תמיד מסונכרנים עם ה-DB ולא "קופאים" על ערך ישן.
export function useSiteAnalytics(code, period, version = 0) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const keyRef = useRef(null); // האתר+התקופה שאליהם שייך data הנוכחי

  useEffect(() => {
    if (!code) {
      setData(null);
      keyRef.current = null;
      return;
    }

    // כשהאתר או התקופה משתנים — מנקים את data מיד. אחרת, אם השליפה החדשה
    // נכשלת, הפאנל היה ממשיך להציג את מספרי התקופה *הקודמת* כאילו הם של החדשה.
    // בעדכון SSE בלבד (אותם code+period, version עולה) שומרים על data הקיים,
    // כדי שרענון רגעי שנכשל לא ירוקן את הפאנל.
    const key = `${code}|${period}`;
    if (keyRef.current !== key) {
      keyRef.current = key;
      setData(null);
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchSiteAnalytics(code, period)
      .then((result) => {
        if (cancelled) return;
        setData(result);
      })
      .catch((err) => {
        if (cancelled) return;
        // שומרים על הנתונים הקודמים כדי שהפאנל לא יקרוס לריק על כשל רגעי
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [code, period, version]);

  return { data, loading, error };
}
