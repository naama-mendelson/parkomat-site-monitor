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
import { supabase } from "../services/supabase";
// ⚠️ אותה כתובת בסיס בדיוק כמו שאר הקריאות. בפיצול לשני קונטיינרים
// "/api/stream" היה מפנה ל-Apache, וההודעות החיות פשוט לא היו מגיעות —
// בלי שום שגיאה על המסך.
import { API_ROOT } from "../services/api";

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
    //
    // ============================================================
    // האסימון נוסע בשאילתה — כי אין שום דרך אחרת
    // ============================================================
    // ⚠️ **ל-EventSource אין פרמטר headers.** זו מגבלת ה-API בדפדפן ולא
    // בחירה: אי אפשר לשלוח Authorization בחיבור SSE, נקודה. נתיבי הקריאה
    // בשרת מוגנים עכשיו (requireAuth), והנתיב הזה לבדו מקבל את האסימון
    // כפרמטר — ראה requireAuthSse בשרת, שם מתועדת הפשרה במלואה.
    //
    // ⚠️ **וההשגה היא אסינכרונית**, ולכן החיבור נפתח רק אחרי שהאסימון בא.
    // הדגל cancelled קיים כי ה-effect עלול להתפרק בזמן ההמתנה — בלעדיו
    // ייפתח חיבור אחרי הפירוק, ואיש כבר לא סוגר אותו.
    let source = null;
    let cancelled = false;
    let retryTimer = null;
    let attempt = 0;

    // האם היה נתק מאז ההתחברות האחרונה. בלי הדגל הזה onopen הראשון (בטעינה)
    // היה מפעיל שליפה מיותרת — הרשימה בדיוק נטענה.
    let sawDisconnect = false;

    // ==========================================================
    // מתחברים מחדש **עם אסימון טרי**, ולא נותנים ל-EventSource לנסות לבד
    // ==========================================================
    // ⚠️ **זה תיקון לבאג שההגנה על הנתיב יצרה.** EventSource מתחבר מחדש
    // מעצמו — אבל תמיד **לאותו URL**, כלומר עם אותו אסימון. אסימון Supabase
    // פג אחרי כשעה, ומאותו רגע כל ניסיון חוזר מקבל 401 והדפדפן מנסה שוב
    // עם אותו אסימון מת, לנצח.
    //
    // ⚠️ והכשל שקט לחלוטין: הדף פתוח, הכרטיסים מוצגים, ופשוט מפסיקים
    // להתעדכן. **בדיוק בתרחיש שהדשבורד נבנה בשבילו** — מסך שפתוח כל היום.
    //
    // לכן סוגרים ידנית ובונים חיבור חדש: getSession מרענן את האסימון
    // אוטומטית, כך שהחיבור החדש נושא אסימון תקף.
    const connect = async () => {
      if (cancelled) return;

      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      const token = data.session?.access_token;

      source = new EventSource(
        token
          ? `${API_ROOT}/api/stream?access_token=${encodeURIComponent(token)}`
          : `${API_ROOT}/api/stream`
      );

      source.onmessage = (event) => {
        try {
          callbackRef.current(JSON.parse(event.data));
        } catch (err) {
          console.warn("SSE parse error:", err);
        }
      };

      source.onopen = () => {
        attempt = 0;                     // חיבור מוצלח מאפס את ההשהיה
        if (!sawDisconnect) return;
        sawDisconnect = false;
        console.info("SSE reconnected — refetching to close the gap.");
        reconnectRef.current?.();
      };

      source.onerror = () => {
        sawDisconnect = true;
        // ⚠️ **סוגרים לפני שמנסים שוב.** בלי זה נשארת גם הלולאה הפנימית של
        // EventSource עם האסימון הישן, ושני חיבורים מתחרים על אותו נתיב.
        source.close();

        // נסיגה מעריכית עד 30 שניות: שרת שנפל לא צריך לקבל בקשה כל שנייה
        // מכל טאב פתוח.
        const delay = Math.min(30_000, 1000 * 2 ** attempt++);
        console.warn(`SSE disconnected — reconnecting in ${delay}ms...`);
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();

    // מחשב שנרדם או טאב ברקע: הדפדפן לא תמיד פולט error, ולכן ההסתמכות על
    // onopen לבדה משאירה מסך מיושן בלי שום סימן.
    const onVisible = () => {
      if (document.visibilityState === "visible") reconnectRef.current?.();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", onVisible);
      // ⚠️ ?. — החיבור אולי טרם נפתח (ההמתנה לאסימון עדיין רצה).
      source?.close();
    };
  }, []);
}
