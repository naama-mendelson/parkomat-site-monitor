// hooks/useSites.js — שליפת וניהול רשימת כל האתרים
import { useState, useEffect, useCallback, useRef } from "react";
// ה-hook לא יודע מאיפה הנתונים מגיעים — dataSource מכריע, והמבנה זהה
// בשני המסלולים. ראה services/dataSource.js לתוכנית ב'.
import { fetchSitesList } from "../services/dataSource";
import { applySiteUpdate } from "../utils/sitePatch";

// ============================================================
// ⚠️ הודעה לבן אדם, לא ל-console
// ============================================================
// `TypeError: Failed to fetch` על מסך עברי בחדר בקרה אינו אומר דבר למי
// שקורא אותו, ובעיקר אינו אומר **מה לעשות**. הוא גם נראה כמו תקלה
// במערכת בזמן שברוב המקרים זו קפיצת רשת של שתי שניות.
//
// ⚠️ ההודעה המקורית לא נמחקת אלא נבלעת בכוונה רק כשזיהינו אותה: שגיאה
// שאיננו מכירים חייבת להגיע למסך כמות שהיא, אחרת נסתיר בדיוק את התקלה
// שאיש עוד לא ראה.
function humanError(err) {
  const msg = String(err?.message ?? err ?? "");
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "אין חיבור לאינטרנט. המסך יתעדכן כשהחיבור יחזור.";
  }
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return "לא הצלחנו להגיע לשרת הנתונים. ייתכן נתק רשת רגעי — מנסים שוב אוטומטית.";
  }
  return msg;
}

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
  // ============================================================
  // ⚠️ שלושה ניסיונות עם השהיה גדלה — 1.5ש' לא הספיקו
  // ============================================================
  // שני ניסיונות בהפרש 1.5 שניות מכסים נתק של שנייה וחצי. נתק של חמש —
  // מעבר בין נקודות Wi-Fi, VPN שמתחבר מחדש, מחשב שהתעורר — עובר את שניהם,
  // והמסך נשאר ריק עם `TypeError: Failed to fetch` **עד השליפה הבאה, בעוד
  // 60 שניות**. זה מה שנראה על המסך בפועל.
  //
  // 1.5 ואז 4 שניות מכסים כשש שניות בסך הכול, ועדיין אינם מסתירים נתק
  // אמיתי: מי שבאמת מנותק יראה את ההודעה, רק שש שניות מאוחר יותר.
  const RETRY_DELAYS = [1500, 4000];

  // ============================================================
  // ⚠️ שתי שליפות במקביל — והישנה עלולה לנצח
  // ============================================================
  // loadSites נקראת מארבעה מקומות: הטעינה הראשונית, הרענון התקופתי
  // (60ש'), `online`, ו-`visibilitychange`. עם עד שני ניסיונות חוזרים
  // ובהשהיה של 5.5 שניות, קל מאוד ששתיים ירוצו יחד — למשל מחשב שהתעורר
  // משינה מפעיל את שניהם ברצף.
  //
  // ⚠️ ואז מי שמסיים אחרון קובע, ולא מי שהתחיל אחרון: שליפה איטית שהחלה
  // לפני השינוי דורסת את התוצאה החדשה. המסך חוזר למצב ישן **אחרי**
  // שהראה את החדש, בלי שגיאה ובלי סימן, עד הרענון הבא.
  //
  // ⚠️ וגם `setError(null)` נדרס כך: שליפה ישנה שנכשלה מציבה הודעת
  // שגיאה על מסך שכבר קיבל נתונים תקינים.
  const seq = useRef(0);

  const loadSites = useCallback(async () => {
    const mine = ++seq.current;
    const stale = () => mine !== seq.current;

    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        const data = await fetchSitesList();
        if (stale()) return;          // שליפה חדשה יותר כבר בדרך
        setSites(data);
        setError(null);
        setLoading(false);
        return;
      } catch (err) {
        if (stale()) return;
        if (attempt === RETRY_DELAYS.length) {
          setError(humanError(err));
          setLoading(false);
          return;
        }
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
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

  // ============================================================
  // ⚠️ חזרה מנתק — שולפים מיד, ולא ממתינים לשליפה הבאה
  // ============================================================
  // בלי זה המסך נשאר עם הודעת השגיאה **עד 60 שניות** אחרי שהרשת כבר
  // חזרה. מי שרואה את זה מרענן את הדף, וזו בדיוק הפעולה שאנחנו רוצים
  // שלא תידרש.
  //
  // ⚠️ שני אירועים ולא אחד: `online` תופס חזרת רשת, אבל מחשב שהתעורר
  // משינה לא בהכרח מפעיל אותו — שם `visibilitychange` הוא זה שיורה.
  // ⚠️ **רק כשיש שגיאה בפועל.** גרסה ראשונה של זה שלפה בכל מעבר לשונית,
  // כלומר הוסיפה בקשות בדיוק כשהכול תקין. כשאין שגיאה, השליפה התקופתית
  // (60ש') כבר עושה את העבודה, ואין מה למהר.
  const hasError = error !== null;
  useEffect(() => {
    if (!hasError) return undefined;

    const retry = () => {
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      loadSites();
    };
    const onVisible = () => { if (document.visibilityState === "visible") retry(); };

    // ⚠️ שני אירועים ולא אחד: `online` תופס חזרת רשת, אבל מחשב שהתעורר
    // משינה לא בהכרח מפעיל אותו — שם `visibilitychange` הוא זה שיורה.
    window.addEventListener("online", retry);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [hasError, loadSites]);

  return { sites, loading, error, reload: loadSites, patch };
}