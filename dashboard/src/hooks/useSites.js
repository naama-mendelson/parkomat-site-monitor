// hooks/useSites.js — שליפת וניהול רשימת כל האתרים
import { useState, useEffect, useCallback } from "react";
import { fetchSites } from "../services/api";
import { applySiteUpdate } from "../utils/sitePatch";

export function useSites() {
  const [sites, setSites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadSites = useCallback(async () => {
    try {
      const data = await fetchSites();
      setSites(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // עדכון מקומי מהודעת SSE — בלי בקשת רשת.
  // applySiteUpdate מחזיר את *אותו* מערך אם אין מה לעדכן, ולכן React
  // לא מרנדר מחדש לחינם.
  const patch = useCallback((msg) => {
    setSites((current) => applySiteUpdate(current, msg));
  }, []);

  // טעינה ראשונית
  useEffect(() => {
    loadSites();
  }, [loadSites]);

  return { sites, loading, error, reload: loadSites, patch };
}