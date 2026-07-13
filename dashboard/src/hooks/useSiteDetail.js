// hooks/useSiteDetail.js — שליפת פרטי אתר בודד (לפאנל הפירוט)
import { useState, useEffect, useCallback } from "react";
import { fetchSiteDetail, fetchSiteStats, fetchMaintenance } from "../services/api";

export function useSiteDetail(code) {
  const [detail, setDetail] = useState(null);
  const [stats, setStats] = useState(null);
  const [maintenance, setMaintenance] = useState(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0); // מאלץ רענון ידני (אחרי שינוי תחזוקה)

  // רענון יזום של פרטי האתר (נקרא אחרי הפעלת/ביטול תחזוקה)
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // ניקוי מיידי כשעוברים לאתר אחר — כדי לא להציג את נתוני האתר הקודם עד
  // שהשליפה החדשה חוזרת (ובפרט למנוע הפעלת תחזוקה על קוד האתר הישן).
  // תלוי ב-code בלבד, ולכן לא רץ ברענון ידני (tick) של אותו אתר.
  useEffect(() => {
    setDetail(null);
    setStats(null);
    setMaintenance(null);
  }, [code]);

  useEffect(() => {
    if (!code) return;

    let cancelled = false;
    setLoading(true);

    async function load() {
      // allSettled: כשל בבקשה אחת (למשל stats) לא ירוקן את השאר.
      const [d, s, m] = await Promise.allSettled([
        fetchSiteDetail(code),
        fetchSiteStats(code),
        fetchMaintenance(code),
      ]);

      if (cancelled) return;

      if (d.status === "fulfilled") setDetail(d.value);
      else console.error("Error loading site detail:", d.reason);
      if (s.status === "fulfilled") setStats(s.value);
      else console.error("Error loading site stats:", s.reason);
      if (m.status === "fulfilled") setMaintenance(m.value);
      else console.error("Error loading maintenance:", m.reason);

      setLoading(false);
    }

    load();
    return () => { cancelled = true; };
  }, [code, tick]);

  return { detail, stats, maintenance, loading, refresh };
}
