// hooks/useSites.js — שליפת וניהול רשימת כל האתרים
import { useState, useEffect, useCallback } from "react";
// ה-hook לא יודע מאיפה הנתונים מגיעים — dataSource מכריע, והמבנה זהה
// בשני המסלולים. ראה services/dataSource.js לתוכנית ב'.
import { fetchSitesList } from "../services/dataSource";
import { applySiteUpdate } from "../utils/sitePatch";

export function useSites() {
  const [sites, setSites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // ============================================================
  // ניסיון שני לפני שמכריזים על שגיאה
  // ============================================================
  // ⚠️ `TypeError: Failed to fetch` הוא כשל **ברמת הדפדפן** — הבקשה לא
  // יצאה או לא חזרה. הוא חולף כמעט תמיד: קפיצת Wi-Fi, חידוש אסימון, שנייה
  // שבה ה-DNS לא ענה. עד עכשיו כשל בודד כזה הודלף ישירות למסך, והשליפה
  // הבאה הייתה רק בעוד 60 שניות — כלומר דקה שלמה של הודעת שגיאה על סמך
  // תקלה שנמשכה חצי שנייה.
  //
  // ⚠️ שני ניסיונות ולא יותר, וזה מכוון: המטרה היא לבלוע רעש, לא להסתיר
  // נתק אמיתי. אם גם השני נכשל — זו כבר לא קפיצה, והמסך צריך לדעת.
  const loadSites = useCallback(async () => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const data = await fetchSitesList();
        setSites(data);
        setError(null);
        setLoading(false);
        return;
      } catch (err) {
        if (attempt === 2) {
          setError(err.message);
          setLoading(false);
          return;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
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