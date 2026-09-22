// hooks/useFaultAlerts.js — מזהה *מעבר* לתקלה ומדווח עליו למנוע הקול.
//
// ==========================================================
// למה השוואת מצב, ולא האזנה להודעת ה-SSE
// ==========================================================
// מתבקש לצלצל ישירות מתוך ה-handler של ה-SSE, אבל זה שביר: הודעה בודדת
// שאובדת בזמן נתק הייתה משתיקה את הצליל לגמרי, בלי שאיש ידע. השוואה בין
// המצב הקודם לנוכחי אינה תלויה באף הודעה בודדת — היא נגזרת מהמצב עצמו,
// ולכן עובדת גם אחרי ריענון מלא, גם אחרי נתק, וגם אחרי חיבור מחדש.
//
// ==========================================================
// שלושה מקרים שאסור לצלצל בהם
// ==========================================================
//   1. **טעינה ראשונה.** בלי זה כל רענון דף היה מצלצל על כל אתר שכבר מושבת.
//      הריצה הראשונה רק זוכרת את המצב.
//   2. **אתר שכבר בתקלה.** before === status → אין מעבר, אין צליל. זה מה
//      שמונע צלצול חוזר על כל הודעת SSE ועל כל שליפה מחדש.
//   3. **אתר חדש שהופיע.** אין לו מצב קודם להשוות אליו, ולכן אי אפשר לדעת
//      אם הוא *נכנס* לתקלה או שרק נרשם ככזה.
//
// בונוס מהשרת: הסטטוס כאן הוא ה*אפקטיבי* (תחזוקה כבר גוברת), ולכן אתר
// בחלון תחזוקה לעולם לא יגיע ל-error ולא יצלצל — בלי תנאי מיוחד כאן.

//
// ==========================================================
// ⚠️ ועקבה על המסך — כי צליל לבד אי אפשר לשחזר
// ==========================================================
// נמדד 22/09/2026: שלוש מתוך שמונה התקלות של היום נמשכו פחות מדקה (2438:
// ‏33 שניות). הצליל התנגן, הכרטיס חזר לירוק לפני שמישהו הרים את הראש,
// ולא נשאר על המסך דבר שאומר **איזה** אתר צלצל. "צליל של תקלה בלי תקלה
// על המסך" — והצליל דווקא צדק.
//
// לכן כל כניסה לתקלה נרשמת, וגם **איך היא נגמרה ומתי**. הרשימה נשארת עד
// שסוגרים אותה: היא נועדה בדיוק למי שלא הסתכל ברגע הנכון.
//
// ⚠️ **הצליל עצמו לא השתנה** — מיידי, כמו קודם. השהיית הצליל עד שהתקלה
// "מתייצבת" הייתה משתיקה את הקצרות, אבל גם מאחרת כל תקלה אמיתית.

import { useCallback, useEffect, useRef, useState } from "react";
import { notifyFaults } from "../utils/audio/alerts";

/** כמה רשומות נשמרות. סערה של עשר תקלות אינה צריכה עשר שורות על המסך. */
const TRAIL_MAX = 5;

export function useFaultAlerts(sites) {
  const previousRef = useRef(null);
  const [trail, setTrail] = useState([]);

  useEffect(() => {
    if (!sites || sites.length === 0) return;

    const current = new Map(sites.map((s) => [s.code, s.status]));
    const previous = previousRef.current;
    previousRef.current = current;

    if (!previous) return;                    // מקרה 1

    const entered = [];
    for (const [code, status] of current) {
      const before = previous.get(code);
      if (!before || before === status) continue;   // מקרים 2 ו-3
      if (status === "error") entered.push(code);
    }

    // ⚠️ **גם כשאין כניסה חדשה.** רשומה פתוחה נסגרת ברגע שהאתר יוצא
    // מתקלה — וזה קורה בדיוק בעדכונים שבהם אף אתר לא נכנס לתקלה.
    const now = Date.now();
    const byCode = new Map(sites.map((s) => [s.code, s]));
    setTrail((prev) => {
      let changed = false;
      let next = prev.map((e) => {
        if (e.endedAt) return e;
        const status = byCode.get(e.code)?.status;
        if (!status || status === "error") return e;
        changed = true;
        return { ...e, endedAt: now, endedTo: status };
      });
      if (entered.length) {
        changed = true;
        const fresh = entered.map((code) => ({
          id: `${code}-${now}`,
          code,
          name: byCode.get(code)?.site_name || code,
          // זמן הזיהוי בדפדפן, לא חותמת האירוע מהאתר: זה הרגע שבו הצליל
          // התנגן, וזה מה שמי ששמע אותו צריך להתאים אליו.
          at: now,
          endedAt: null,
          endedTo: null,
        }));
        next = [...fresh, ...next].slice(0, TRAIL_MAX);
      }
      return changed ? next : prev;
    });

    if (entered.length === 0) return;

    // הקיבוץ עצמו הוא באחריות המנוע: כאן מדווחים את כל מה שהשתנה בבת אחת,
    // והוא מחליט אם זה צלצול חדש או שהוא נופל לתוך חלון פתוח.
    const outcome = notifyFaults(entered);
    console.info(
      `[alert] ${entered.length} אתר/ים נכנסו לתקלה (${entered.join(", ")}) — ${outcome}`
    );
  }, [sites]);

  const dismissTrail = useCallback(() => setTrail([]), []);
  return { trail, dismissTrail };
}
