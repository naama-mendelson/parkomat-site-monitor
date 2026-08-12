// hooks/useSiteInsights.js — סטטיסטיקה מעמיקה של אתר ("עוד מידע"),
// וגרסה מצרפת על כל האתרים (useGlobalInsights).
import { useState, useEffect } from "react";
// דרך המתג: במצב ישיר הדשבורד שולף שורות גולמיות מ-Supabase ומריץ
// עליהן את **אותה** computeInsights שהשרת מריץ (shared/insights.mjs).
import { fetchInsights } from "../services/dataSource";

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

    fetchInsights(code, period)
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

// גרסה מצרפת — כל האתרים יחד. אותו חוזה החזרה כמו useSiteInsights, כדי
// שה-InsightsModal יוכל להחליף ביניהן בלי הבדל בצריכת הנתונים.
export function useGlobalInsights(period, { enabled = true, version = 0 } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchInsights(null, period)
      .then((result) => { if (!cancelled) setData(result); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [period, enabled, version]);

  return { data, loading, error };
}
