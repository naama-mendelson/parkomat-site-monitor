// hooks/useSiteDetail.js — שליפת פרטי אתר בודד (לפאנל הפירוט)
import { useState, useEffect, useCallback } from "react";
import { fetchSiteDetail, fetchMaintenance } from "../services/api";

export function useSiteDetail(code) {
  const [detail, setDetail] = useState(null);
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
    setMaintenance(null);
  }, [code]);

  useEffect(() => {
    if (!code) return;

    let cancelled = false;
    setLoading(true);

    async function load() {
      // allSettled: כשל בבקשה אחת (למשל maintenance) לא ירוקן את השאר.
      // הערה: /stats הוסר — הוא היה שליפה מתה (4 שאילתות) שהפאנל התעלם ממנה;
      // מדדי ה-KPI (פעולות/תקלות/אחוז כשל) מגיעים מ-analytics.stats.
      const [d, m] = await Promise.allSettled([
        fetchSiteDetail(code),
        fetchMaintenance(code),
      ]);

      if (cancelled) return;

      if (d.status === "fulfilled") setDetail(d.value);
      else console.error("Error loading site detail:", d.reason);
      if (m.status === "fulfilled") setMaintenance(m.value);
      else console.error("Error loading maintenance:", m.reason);

      setLoading(false);
    }

    load();
    return () => { cancelled = true; };
  }, [code, tick]);

  return { detail, maintenance, loading, refresh };
}
