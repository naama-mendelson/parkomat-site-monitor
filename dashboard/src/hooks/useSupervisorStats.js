// hooks/useSupervisorStats.js — נתוני מנהל הבקרה לפי תקופה
import { useState, useEffect, useCallback } from "react";
import { fetchSupervisorStats } from "../services/api";

export function useSupervisorStats(period, version = 0) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);   // רענון יזום (אחרי ביטול תחזוקה)

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchSupervisorStats(period)
      .then((r) => { if (!cancelled) setData(r); })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [period, version, tick]);

  return { data, loading, error, refresh };
}
