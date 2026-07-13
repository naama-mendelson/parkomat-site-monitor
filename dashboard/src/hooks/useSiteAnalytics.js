// hooks/useSiteAnalytics.js — שליפת נתוני האנליטיקה של אתר לפי תקופה
import { useState, useEffect } from "react";
import { fetchSiteAnalytics } from "../services/api";

// code: קוד האתר | period: 'week' | 'month' | 'year'
// version: מונה שמתעדכן בכל הודעה חדשה מהאתר (SSE) — מאלץ שליפה מחדש,
//          כך שהנתונים תמיד מסונכרנים עם ה-DB ולא "קופאים" על ערך ישן.
export function useSiteAnalytics(code, period, version = 0) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!code) {
      setData(null);
      return;
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
