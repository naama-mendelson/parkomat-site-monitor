// db/cycle-rules.js — ההחלטה על מונה המחזורים. טהור: בלי DB, בלי שעון.
//
// מופרד מ-queries.js בכוונה, משתי סיבות:
//   1. כל ההיגיון העדין (first / backfill / delta / אתחול / נפילה חשודה) נבדק
//      ב-unit tests על כל ענף, במקום להיות קבור בתוך טרנזקציה.
//   2. queries.js גורר את db.js, שדורש DATABASE_URL בעליית המודול. מודול טהור
//      נטען בבדיקות בלי שום סביבה — ובלי שום סיכון לגעת במסד אמיתי.

// ============================================================
// כמה מחזורים מותר ל"אתחול בקר" להוסיף — התקרה שמונעת ניפוח
// ============================================================
// ענף ה-reset המקורי היה `total = total + current`, כלומר: כל קריאה שנמוכה
// מקודמתה נחשבה אתחול בקר, ו**כל הערך שלה** נכנס למונה המצטבר.
//
// למה זה מסוכן: cycle_total הוא סכום רץ. הוא לעולם לא מחושב מחדש מהנתונים
// הגולמיים, ולכן כל ניפוח בו הוא **קבוע ובלתי הפיך**. קריאת Modbus אחת פגומה,
// או כתובת רגיסטר שגויה (וזה תרחיש אמיתי — כל התקנה מאפסת את כתובות הרגיסטרים
// לברירת המחדל), שמחזירה 1000 באתר שהמונה שלו 12,249 — הייתה מוסיפה 1000
// מחזורי בלאי מדומים בפעולה אחת, ומעוותת תחזוקה מונעת מכאן והלאה.
//
// אתחול בקר *אמיתי* נראה אחרת: המונה יורד לאפס ומתחיל לעלות. בקצב דגימה של
// שנייה אנחנו רואים אותו כשהוא עוד 0-2. לכן ערך נמוך אחרי נפילה הוא אתחול
// אמין; ערך גבוה הוא קריאה חשודה.
//
// הבחירה כאן היא **חוסר-ספירה חסום על פני ספירת-יתר בלתי חסומה**: מונה בלאי
// שמפגר מעט ניתן להסביר ולתקן; מונה שניפח את עצמו ב-1000 הוא שקר קבוע.
const RESET_PLAUSIBLE_MAX = 100;

/**
 * ההחלטה על מונה המחזורים.
 *
 * @returns { mode, total, nextLast, write, ignoredAmount }
 *          write=false → אין לכתוב כלום (backfill / קריאה פסולה).
 *          mode: first | normal | backfill | reset | reset_suspect | invalid
 */
function decideCycleUpdate({ last, lastTs, total, isNewSite, current, occurredAt }) {
  // מונה שלילי או לא-שלם אינו אפשרי בבקר, והיה נכנס ישירות לסכום המצטבר.
  // (ה-dispatcher מאמת Number.isInteger, אך isInteger(-5) הוא true.)
  if (!Number.isInteger(current) || current < 0) {
    return { mode: "invalid", total, nextLast: last, write: false, ignoredAmount: 0 };
  }

  if (last === null) {
    // קריאה ראשונה מהבקר:
    //  - אתר ותיק (is_new_site = 0): מאמצים את המונה ההיסטורי.
    //  - אתר חדש  (is_new_site = 1): cycle_total נשאר 0, והערך רק בסיס ל-delta.
    return {
      mode: "first",
      total: isNewSite === 0 ? current : total,
      nextLast: current,
      write: true,
      ignoredAmount: 0,
    };
  }

  // הודעה שקרתה לפני העדכון האחרון הגיעה מאוחר (מסירה חוזרת / סדר הפוך).
  // אסור לה לגעת במונה — היא כבר נספרה, או שהיא שייכת לעבר.
  if (lastTs !== null && occurredAt < lastTs) {
    return { mode: "backfill", total, nextLast: last, write: false, ignoredAmount: 0 };
  }

  if (current >= last) {
    return {
      mode: "normal",
      total: total + (current - last),
      nextLast: current,
      write: true,
      ignoredAmount: 0,
    };
  }

  // --- המונה ירד ---
  if (current <= RESET_PLAUSIBLE_MAX) {
    // אתחול בקר אמין: המונה חזר לאפס וספר מעט מאז.
    return {
      mode: "reset",
      total: total + current,
      nextLast: current,
      write: true,
      ignoredAmount: 0,
    };
  }

  // נפילה לערך גבוה — לא נראה כמו אתחול. **לא מוסיפים כלום** למונה המצטבר.
  // כן מזיזים את הבסיס: אילו נשארנו על הבסיס הישן, בקר שהוחלף באמת (ומדווח
  // מעכשיו ערכים נמוכים) היה מייצר "נפילה" בכל הודעה — ותקוע בלוג לנצח.
  // מהבסיס החדש הספירה ממשיכה נכון, ורק המחזורים שאין להם הסבר אובדים.
  return {
    mode: "reset_suspect",
    total,
    nextLast: current,
    write: true,
    ignoredAmount: current,
  };
}

module.exports = { decideCycleUpdate, RESET_PLAUSIBLE_MAX };
