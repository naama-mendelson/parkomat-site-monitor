// utils/coalesce.js — רענון שמתאחד: פרץ בקשות הופך לקריאה אחת, ולשונית מוסתרת אינה מרעננת כלל (18/10/2026).
//
// ⚠️ למה זה קיים, במספרים. נמדד בייצור ב-18/10: 29 מסכים פתוחים מאזינים ל-Realtime. כל אירוע "קריאת ויזנט"
// גרם לכל אחד מהם — גם ללשוניות מוסתרות — לשתי קריאות RPC של ~55 אלפיות, כולן באותה שנייה. בחלון של 10 דקות
// עם 8 אירועים: 208 קריאות, 86 שניות של זמן מסד, ממוצע 413 אלפיות לקריאה (העומס הוא שהופך 55 ל-413), **56%
// מכל זמן המסד** באותו חלון. ופרץ קריאות אמיתי (8 כרטיסים ב-16 שניות מאותו דייר) הוא 8 אירועים רצופים.
//
// שני כללים, שניהם בלי מחיר נראה:
// - **לשונית מוסתרת לא מרעננת.** מה שהיא תראה כשחוזרים אליה הוא מה שיטען אז — onRecover ב-App.jsx מרענן את
//   המספרים בחזרה ללשונית (מ-18/10). עד אז לשונית ברקע עשתה את כל העבודה של לשונית גלויה, ואף אחד לא ראה.
// - **פרץ מתאחד.** בקשה מתחילה מונה; עוד בקשה בתוך החלון מאפסת אותו; הטעינה רצה פעם אחת כשנרגע. 1.5 שניות:
//   מרווח הפרצים שנמדד הוא 2–5 שניות בין כרטיסים, ולכן זה מאחד את רובם בלי שהמסך ירגיש איחור.
//
// טהור ובלי DOM: הנסתר, השעון וההפעלה מוזרקים, כדי שהכלל ייבדק ב-node:test. ⚠️ `request` אינו קורא ל-fn
// ישירות אף פעם, גם לא בפעם הראשונה — אחרת 29 מסכים היו עדיין יורים יחד על האירוע הראשון של פרץ.

/**
 * @param {() => void} fn   מה לרענן
 * @param {object} [opts]
 * @param {number} [opts.delayMs=1500]
 * @param {() => boolean} [opts.isHidden]  ברירת מחדל: document.hidden
 * @param {Function} [opts.setTimer]  ברירת מחדל: setTimeout
 * @param {Function} [opts.clearTimer]  ברירת מחדל: clearTimeout
 * @returns {{ request: () => void, cancel: () => void, pending: () => boolean }}
 */
export function makeCoalesced(fn, {
  delayMs = 1500,
  isHidden = () => typeof document !== "undefined" && document.hidden === true,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let timer = null;
  const cancel = () => { if (timer !== null) { clearTimer(timer); timer = null; } };
  const request = () => {
    if (isHidden()) return;           // לשונית מוסתרת — כלום. החזרה אליה תרענן.
    cancel();
    timer = setTimer(() => { timer = null; fn(); }, delayMs);
  };
  return { request, cancel, pending: () => timer !== null };
}

/** עטיפה לטיימר תקופתי: רץ רק כשהלשונית גלויה (ללשונית מוסתרת אין למי להראות) */
export function unlessHidden(fn, isHidden = () => typeof document !== "undefined" && document.hidden === true) {
  return () => { if (!isHidden()) fn(); };
}
