// hooks/useFaultAck.js — מה ממתין לאישור, ואישור.
//
// ⚠️ **שלושה ערוצים, וכל אחד מכסה חור של האחר:**
//   - Realtime — התראה חדשה ואישור ממסך אחר, בתוך שנייה.
//   - חזרה לטאב — דפדפן משעה מנויים בטאב ברקע; מי שחוזר צריך את המצב עכשיו.
//   - סקר כל דקה — אם המנוי נפל בשקט (רשת, שינה), החלון עדיין נפתח.
//     שאילתה של "מה לא אושר" מחזירה בדרך כלל מערך ריק — עלות זניחה.
import { useCallback, useEffect, useState } from "react";
import { fetchOpenFaultAlarms, ackFaultAlarms, subscribeFaultAlarms } from "../services/dataSource";

const POLL_MS = 60_000;

export function useFaultAck() {
  const [alarms, setAlarms] = useState([]);
  const [loadError, setLoadError] = useState(null);

  const load = useCallback(async () => {
    try {
      setAlarms(await fetchOpenFaultAlarms());
      setLoadError(null);
    } catch (e) {
      // ⚠️ השגיאה נשמרת ולא נבלעת, אבל **הרשימה הקודמת נשארת**: כשל טעינה
      // רגעי אינו סיבה לסגור חלון שעדיין יש בו תקלות שלא אושרו.
      setLoadError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
    const unsubscribe = subscribeFaultAlarms(load);
    const poll = setInterval(load, POLL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      unsubscribe();
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  // ⚠️ זורק הלאה — החלון מציג את הסיבה. אחרי הצלחה טוענים מחדש ולא מוחקים
  // מקומית: המסד הוא שקובע מה עדיין פתוח, כולל התראה שנוספה באותה שנייה.
  const ack = useCallback(async (ids, name) => {
    await ackFaultAlarms(ids, name);
    await load();
  }, [load]);

  return { alarms, ack, loadError };
}
