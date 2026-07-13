// hooks/useSiteInsights.js — סטטיסטיקה מעמיקה של אתר ("עוד מידע")
import { useState, useEffect } from "react";
import { fetchSiteInsights } from "../services/api";

// enabled: שולפים רק כשהמסך פתוח, כדי לא לבזבז בקשות
// version: מתעדכן בכל הודעה חדשה מהאתר → שליפה מחדש (סנכרון עם ה-DB)
export function useSiteInsights(code, period, { enabled = true, version = 0 } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!code || !enabled) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchSiteInsights(code, period)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [code, period, enabled, version]);

  return { data, loading, error };
}
