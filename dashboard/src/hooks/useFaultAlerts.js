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

import { useEffect, useRef } from "react";
import { notifyFaults } from "../utils/audio/alerts";

export function useFaultAlerts(sites) {
  const previousRef = useRef(null);

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

    if (entered.length === 0) return;

    // הקיבוץ עצמו הוא באחריות המנוע: כאן מדווחים את כל מה שהשתנה בבת אחת,
    // והוא מחליט אם זה צלצול חדש או שהוא נופל לתוך חלון פתוח.
    const outcome = notifyFaults(entered);
    console.info(
      `[alert] ${entered.length} אתר/ים נכנסו לתקלה (${entered.join(", ")}) — ${outcome}`
    );
  }, [sites]);
}
