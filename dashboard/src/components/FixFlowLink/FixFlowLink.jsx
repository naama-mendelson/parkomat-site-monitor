// כפתור "תקלות ופתרונות" על כרטיס האתר — הפיילוט של החיבור ל-FixFlow.
//
// ⚠️ כל הקוד של הפיילוט נמצא בתיקייה הזו וב-`services/fixflow.js`. נקודת החיבור
// היחידה לשאר הדשבורד היא שורה אחת ב-SiteCard. זו דרישת התכנון: "אם לא אהיה
// מרוצה תעיף את כל ה-FixFlow מהאתר".
import React, { useState } from "react";
import FixFlowFrame from "./FixFlowFrame.jsx";
import { fixflowLinkFor, fixflowSolutionFor, FIXFLOW_ENABLED } from "../../services/fixflow.js";
import "./FixFlowLink.css";

// ⚠️ **הכפתור פתח לשונית חדשה, וזה הוחלף** (23/09/2026). הנימוק המקורי נשאר
// נכון — ניווט באותה לשונית היה מאבד את מצב המסך, והמוקדן צריך את שניהם זה
// לצד זה — אבל המחיר התגלה בשטח: "מפריע לי שהטיפול בתקלות נפתח בטאב חדש ואי
// אפשר לחזור ממנו לעמוד הבית". ל-FixFlow אין כפתור חזרה, והקוד שלה אינו כאן.
//
// `FixFlowFrame` נותן את שניהם: הדשבורד נשאר חי מאחור על כל מצבו, ויש דרך
// חזרה אחת ברורה. מי שרוצה מסך שני מקבל "פתיחה בלשונית" בכותרת.

export default function FixFlowLink({ site, faultText }) {
  // ⚠️ ההוק לפני כל `return` מוקדם — React אוסר קריאה מותנית להוקים.
  const [open, setOpen] = useState(false);
  // ⚠️ אין יותר שיוך ידני מהכרטיס (11/10/2026, בעלת המוצר: "תעיף את זה. שזה יעשה אוטומטי בכל
  // מקרה"): הספרייה נגזרת תמיד — משם האתר או מסוג המתקן והמערכת. אתר שהגזירה נכשלת בו מתוקן
  // בעריכת האתר (סוג מתקן, מערכת) או במיפוי ב-shared/fixflow-profiles.mjs — לא בבחירה על האתר.
  if (!FIXFLOW_ENABLED) return null;

  const link = fixflowLinkFor(site, faultText);
  if (!link) return null;

  // ============================================================
  // ⚠️ כשיש נוהל לתקלה הזו — הכפתור נוחת עליו, לא על רשימה
  // ============================================================
  // עד כה הוא פתח את רשימת התקלות של האתר עם `?q=` — מדורגת לפי רלוונטיות,
  // אבל עדיין רשימה שצריך לבחור ממנה. למוקדן באמצע אירוע אין צעד פנוי,
  // ובחירה מתוך 67 מסמכים היא צעד.
  //
  // ⚠️ **ורק בהתאמה ודאית.** כשאין — חוזרים לרשימה המדורגת, שהיא עדיין
  // התשובה הנכונה. קפיצה ל"הכי קרוב" הייתה פותחת נוהל של תקלה אחרת, וכל
  // הצעדים בו נראים סבירים.
  const solution = faultText ? fixflowSolutionFor(site, faultText) : null;

  // ⚠️ מצב שאינו "ok" מוצג כטקסט מושבת ולא מוסתר. הסתרה הייתה משאירה את המוקדן
  // בלי מושג למה באתר אחד יש כפתור ובאחר אין — ובמקרה של `no-type` הסיבה היא
  // שדה חסר שהוא **יכול** למלא בעצמו.
  if (link.status !== "ok") {
    return (
      <span className="ffl ffl-off" title={link.reason}>
        <span className="ffl-icon" aria-hidden="true">📚</span>
        <span className="ffl-text">אין ספריית תקלות</span>
      </span>
    );
  }

  // ⚠️ ספרייה ריקה מקבלת מראה משלה. שליחת מוקדן לרשימה ריקה אינה מציגה שגיאה —
  // היא נראית בדיוק כמו "אין תקלות ידועות לאתר הזה", וזה הכשל הכי שקט כאן.
  // שלושה אתרים במצב הזה היום (מצבט X), וכולם ממתינים לייצוא מסמכי Google.
  if (link.docs === 0) {
    return (
      <span className="ffl ffl-off" title="אין ספריית תקלות עם תוכן לאתר הזה">
        <span className="ffl-icon" aria-hidden="true">📚</span>
        <span className="ffl-text">ספריית תקלות ריקה</span>
      </span>
    );
  }

  return (
    <>
    <button
      type="button"
      className="ffl"
      // ⚠️ עצירת ההתפשטות: הכרטיס כולו לחיץ ופותח את חלון פרטי האתר. בלי זה
      // לחיצה על הכפתור הייתה גם פותחת את הספרייה וגם את החלון — ונראית כמו באג.
      onClick={(e) => { e.stopPropagation(); setOpen(true); }}
      // ⚠️ ה-title אומר **לאן** הקישור מוביל ולפי מה. ההבדל בין קישור לאתר
      // (עם חריגות האתר) לבין קישור לספריית סוג מכונה (בלעדיהן) הוא הבדל
      // בתוכן שהמוקדן יראה, ולכן הוא חייב להיות גלוי ולא רק נכון.
      title={
        solution
          ? `נוהל: ${solution.title} — נפתח ישירות, בלי לחפש`
          : (link.by === "name" || link.by === "chosen-site"
              ? `התקלות של ${link.scope} — כולל דרך טיפול ייחודית לאתר` +
                (link.overrides ? ` (${link.overrides} חריגות)` : "")
              : `ספריית סוג המכונה ${link.profile} (${link.system}) — ללא חריגות אתר`) +
            (faultText ? ` · מדורג לפי "${faultText}"` : "")
      }
    >
      <span className="ffl-icon" aria-hidden="true">📚</span>
      {/* ⚠️ "פתרון לתקלה" על כפתור שפותח רשימה הוא הבטחה שאינה מתקיימת,
          והמוקדן לומד לא להאמין לה. הכיתוב אומר בדיוק לאן זה מוביל. */}
      <span className="ffl-text">{solution ? "הנוהל לתקלה הזו" : "תקלות ופתרונות"}</span>
    </button>

    {open && (
      <FixFlowFrame
        url={solution ? solution.url : link.url}
        title={solution ? "נוהל: " + solution.title : "תקלות ופתרונות — " + (link.scope || link.profile)}
        onClose={() => setOpen(false)}
      />
    )}

    </>
  );
}
