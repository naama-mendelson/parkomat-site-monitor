// hooks/useSSE.js — האזנה ל-Server-Sent Events (עדכונים בזמן אמת)
//
// ==========================================================
// למה יש כאן callback שני, ולמה בלעדיו המסך שיקר
// ==========================================================
// ל-SSE אין מסירה חוזרת. EventSource מתחבר מחדש לבד, אבל **כל הודעה
// שנשלחה בזמן הנתק אבודה לתמיד** — והדשבורד טוען את רשימת האתרים פעם
// אחת ומשם רק מטליא אותה מהודעות. אין רענון תקופתי.
//
// התוצאה נצפתה בפועל: אתר 3501 הציג "בפעולה" בזמן שלוג הפעילות — שנשלף
// טרי — כבר הראה "המצב השתנה ל: מוכן". הודעת ה-state נשלחה בדיוק כשהשרת
// הופעל מחדש, הדפדפן התחבר מחדש בהצלחה, וההודעה פשוט לא הייתה שם.
// הכרטיס נשאר תקוע לנצח, כי שום דבר לא מפעיל שליפה מלאה.
//
// **זה הכשל המסוכן ביותר במסך ניטור**: לא הודעת שגיאה, לא סמל אפור —
// מסך שנראה תקין ומציג מצב שאינו נכון. הערה קודמת בקוד הניחה ש"שליפה
// מלאה מאוחרת" תתקן; לא היה מי שיבצע אותה.
//
// שני מסלולי התאוששות, כי הם מכסים שני כשלים שונים:
//   1. onopen אחרי onerror — נתק שהדפדפן זיהה (אתחול שרת, נפילת רשת).
//   2. חזרה לטאב — מחשב שנרדם או טאב ברקע. שם EventSource עלול *לא*
//      לדווח על שגיאה בכלל, והמסך פשוט מפגר בשקט.
import { useEffect, useRef } from "react";
import { useDirect } from "../services/dataSource";
import { subscribeRealtime } from "../services/realtimeDirect";

/**
 * @param onUpdate    נקרא לכל הודעה.
 * @param onReconnect נקרא כשהחיבור התאושש אחרי נתק, וכשחוזרים לטאב.
 *                    כאן צריך לבצע שליפה מלאה — היא מקור האמת היחיד
 *                    שאינו תלוי בהודעה בודדת.
 */
export function useSSE(onUpdate, onReconnect) {
  const callbackRef = useRef(onUpdate);
  callbackRef.current = onUpdate;

  const reconnectRef = useRef(onReconnect);
  reconnectRef.current = onReconnect;

  useEffect(() => {
    // ============================================================
    // אותו מתג בדיוק כמו הקריאות
    // ============================================================
    // ⚠️ **זהו הפער האחרון שסגר את התמונה.** כל הקריאות כבר עברו ל-Supabase,
    // אבל כאן נשאר `new EventSource("/api/stream")` — חיבור פתוח וקבוע לשרת.
    // כל עוד הוא קיים, "הדשבורד מדבר רק עם Supabase" אינו נכון.
    //
    // הזרועות אינן שני מנגנונים אלא **שני קוראים של אותה טבלה**: השרת כותב
    // כל אירוע סמנטי ל-`events` (bus.publish), ו-SSE ו-Realtime שניהם קוראים
    // משם. לכן ההחלפה היא החלפת קורא, ולא כתיבה מחדש של המנגנון.
    if (useDirect) {
      const unsubscribe = subscribeRealtime(
        (data) => callbackRef.current(data),
        () => reconnectRef.current?.()
      );
      const onVisibleRt = () => {
        if (document.visibilityState === "visible") reconnectRef.current?.();
      };
      document.addEventListener("visibilitychange", onVisibleRt);
      return () => {
        document.removeEventListener("visibilitychange", onVisibleRt);
        unsubscribe();
      };
    }

    // ---- זרוע ב': SSE דרך השרת. נשאר עובד, ולכן אינו נמחק. ----
    const source = new EventSource("/api/stream");

    // האם היה נתק מאז ההתחברות האחרונה. בלי הדגל הזה onopen הראשון (בטעינה)
    // היה מפעיל שליפה מיותרת — הרשימה בדיוק נטענה.
    let sawDisconnect = false;

    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        callbackRef.current(data);
      } catch (err) {
        console.warn("SSE parse error:", err);
      }
    };

    source.onopen = () => {
      if (!sawDisconnect) return;
      sawDisconnect = false;
      console.info("SSE reconnected — refetching to close the gap.");
      reconnectRef.current?.();
    };

    source.onerror = () => {
      sawDisconnect = true;
      console.warn("SSE disconnected — reconnecting automatically...");
    };

    // מחשב שנרדם או טאב ברקע: הדפדפן לא תמיד פולט error, ולכן ההסתמכות על
    // onopen לבדה משאירה מסך מיושן בלי שום סימן.
    const onVisible = () => {
      if (document.visibilityState === "visible") reconnectRef.current?.();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      source.close();
    };
  }, []);
}
