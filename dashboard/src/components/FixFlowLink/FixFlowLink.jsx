// כפתור "תקלות ופתרונות" על כרטיס האתר — הפיילוט של החיבור ל-FixFlow.
//
// ⚠️ כל הקוד של הפיילוט נמצא בתיקייה הזו וב-`services/fixflow.js`. נקודת החיבור
// היחידה לשאר הדשבורד היא שורה אחת ב-SiteCard. זו דרישת התכנון: "אם לא אהיה
// מרוצה תעיף את כל ה-FixFlow מהאתר".
import React from "react";
import { fixflowLinkFor, FIXFLOW_ENABLED } from "../../services/fixflow.js";
import "./FixFlowLink.css";

// ⚠️ הכפתור נפתח בלשונית חדשה, ותמיד. הדשבורד הוא PWA שמוקדן מחזיק פתוח באמצע
// אירוע; ניווט באותה לשונית היה מאבד את מצב המסך — הסינון, הכרטיס הפתוח,
// ההיסטוריה — בדיוק ברגע שבו הוא צריך את שניהם זה לצד זה.
const REL = "noopener noreferrer";

export default function FixFlowLink({ site, faultText }) {
  if (!FIXFLOW_ENABLED) return null;

  const link = fixflowLinkFor(site, faultText);
  if (!link) return null;

  // ⚠️ מצב שאינו "ok" מוצג כטקסט מושבת ולא מוסתר. הסתרה הייתה משאירה את המוקדן
  // בלי מושג למה באתר אחד יש כפתור ובאחר אין — ובמקרה של `no-type` הסיבה היא
  // שדה חסר שהוא **יכול** למלא בעצמו.
  if (link.status !== "ok") {
    return (
      <div className="ffl ffl-off" title={link.reason}>
        <span className="ffl-icon" aria-hidden="true">📚</span>
        <span className="ffl-text">אין ספריית תקלות</span>
      </div>
    );
  }

  // ⚠️ ספרייה ריקה מקבלת מראה משלה. שליחת מוקדן לרשימה ריקה אינה מציגה שגיאה —
  // היא נראית בדיוק כמו "אין תקלות ידועות לאתר הזה", וזה הכשל הכי שקט כאן.
  // שלושה אתרים במצב הזה היום (מצבט X), וכולם ממתינים לייצוא מסמכי Google.
  if (link.docs === 0) {
    return (
      <div className="ffl ffl-off" title={`הספרייה "${link.profile}" קיימת אך ריקה — ממתינה לייצוא המסמכים`}>
        <span className="ffl-icon" aria-hidden="true">📚</span>
        <span className="ffl-text">ספרייה ריקה</span>
      </div>
    );
  }

  return (
    <a
      className="ffl"
      href={link.url}
      target="_blank"
      rel={REL}
      // ⚠️ עצירת ההתפשטות: הכרטיס כולו לחיץ ופותח את חלון פרטי האתר. בלי זה
      // לחיצה על הכפתור הייתה גם פותחת לשונית וגם את החלון — ונראית כמו באג.
      onClick={(e) => e.stopPropagation()}
      // ⚠️ ה-title אומר **לאן** הקישור מוביל ולפי מה. ההבדל בין קישור לאתר
      // (עם חריגות האתר) לבין קישור לספריית סוג מכונה (בלעדיהן) הוא הבדל
      // בתוכן שהמוקדן יראה, ולכן הוא חייב להיות גלוי ולא רק נכון.
      title={
        (link.by === "name" || link.by === "chosen-site"
          ? `התקלות של ${link.scope} — כולל דרך טיפול ייחודית לאתר` +
            (link.overrides ? ` (${link.overrides} חריגות)` : "")
          : `ספריית סוג המכונה ${link.profile} (${link.system}) — ללא חריגות אתר`) +
        (faultText ? ` · מסונן לפי "${faultText}"` : "")
      }
    >
      <span className="ffl-icon" aria-hidden="true">📚</span>
      <span className="ffl-text">{faultText ? "פתרון לתקלה" : "תקלות ופתרונות"}</span>
    </a>
  );
}
