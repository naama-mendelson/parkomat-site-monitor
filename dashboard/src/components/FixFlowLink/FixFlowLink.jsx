// כפתור "תקלות ופתרונות" על כרטיס האתר — הפיילוט של החיבור ל-FixFlow.
//
// ⚠️ כל הקוד של הפיילוט נמצא בתיקייה הזו וב-`services/fixflow.js`. נקודת החיבור
// היחידה לשאר הדשבורד היא שורה אחת ב-SiteCard. זו דרישת התכנון: "אם לא אהיה
// מרוצה תעיף את כל ה-FixFlow מהאתר".
import React, { useState } from "react";
import FixFlowAssign from "./FixFlowAssign.jsx";
import { useSavedAssignment, rememberAssignment } from "./savedAssignment.js";
import { fixflowLinkFor, fixflowSolutionFor, FIXFLOW_ENABLED } from "../../services/fixflow.js";
import "./FixFlowLink.css";

// ⚠️ הכפתור נפתח בלשונית חדשה, ותמיד. הדשבורד הוא PWA שמוקדן מחזיק פתוח באמצע
// אירוע; ניווט באותה לשונית היה מאבד את מצב המסך — הסינון, הכרטיס הפתוח,
// ההיסטוריה — בדיוק ברגע שבו הוא צריך את שניהם זה לצד זה.
const REL = "noopener noreferrer";

export default function FixFlowLink({ site, faultText }) {
  // ⚠️ ההוק לפני כל `return` מוקדם — React אוסר קריאה מותנית להוקים.
  const [assigning, setAssigning] = useState(false);
  // ⚠️ הבחירה שנשמרה זה עתה מוחזקת בחנות משותפת, כדי שהכפתור **והפאנל** יתעדכנו **מיד**.
  // בלי זה היה צריך לרענן את הדף כדי לראות שהשיוך תפס, ומי שלא רואה תוצאה
  // מניח שזה לא נשמר ומנסה שוב.
  const effective = useSavedAssignment(site);
  const onSaved = (v) => rememberAssignment(site, v);
  if (!FIXFLOW_ENABLED) return null;

  const link = fixflowLinkFor(effective, faultText);
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
  // ⚠️ `effective` ולא `site`: אחרי שיוך מחדש הכפתור פתח את נוהל הספרייה הקודמת.
  const solution = faultText ? fixflowSolutionFor(effective, faultText) : null;

  // ⚠️ מצב שאינו "ok" מוצג כטקסט מושבת ולא מוסתר. הסתרה הייתה משאירה את המוקדן
  // בלי מושג למה באתר אחד יש כפתור ובאחר אין — ובמקרה של `no-type` הסיבה היא
  // שדה חסר שהוא **יכול** למלא בעצמו.
  if (link.status !== "ok") {
    return (
      <>
        {/* ⚠️ כפתור ולא טקסט מושבת. הסיבה שהאתר בלי ספרייה ניתנת לתיקון
            בשתי לחיצות, והמקום שבו מגלים אותה הוא בדיוק המקום שבו כדאי
            לתקן — אחרת זה נדחה ונשכח. */}
        <button
          className="ffl ffl-off ffl-fix"
          title={`${link.reason} — לחצי כדי לשייך ספרייה`}
          onClick={(e) => { e.stopPropagation(); setAssigning(true); }}
        >
          <span className="ffl-icon" aria-hidden="true">📚</span>
          <span className="ffl-text">שייכי ספריית תקלות</span>
        </button>
        {assigning && (
          <FixFlowAssign
            site={effective}
            reason={link.reason}
            onClose={() => setAssigning(false)}
            onSaved={onSaved}
          />
        )}
      </>
    );
  }

  // ⚠️ ספרייה ריקה מקבלת מראה משלה. שליחת מוקדן לרשימה ריקה אינה מציגה שגיאה —
  // היא נראית בדיוק כמו "אין תקלות ידועות לאתר הזה", וזה הכשל הכי שקט כאן.
  // שלושה אתרים במצב הזה היום (מצבט X), וכולם ממתינים לייצוא מסמכי Google.
  if (link.docs === 0) {
    // ⚠️ גם ספרייה ריקה ניתנת לשינוי מכאן. לפעמים היא ריקה כי המסמכים טרם
    // יוצאו מהכונן — ואז אין מה לעשות — ולפעמים כי האתר משויך לספרייה הלא
    // נכונה. מהכרטיס אי אפשר לדעת מי משניהם, ולכן עדיף לאפשר.
    return (
      <>
        <button
          className="ffl ffl-off ffl-fix"
          title={`הספרייה "${link.profile}" קיימת אך ריקה — לחצי כדי לבחור אחרת`}
          onClick={(e) => { e.stopPropagation(); setAssigning(true); }}
        >
          <span className="ffl-icon" aria-hidden="true">📚</span>
          <span className="ffl-text">ספרייה ריקה</span>
        </button>
        {assigning && (
          <FixFlowAssign
            site={effective}
            reason={`"${link.profile}" קיימת אך אין בה אף מסמך.`}
            onClose={() => setAssigning(false)}
            onSaved={onSaved}
          />
        )}
      </>
    );
  }

  return (
    <>
    <a
      className="ffl"
      href={solution ? solution.url : link.url}
      target="_blank"
      rel={REL}
      // ⚠️ עצירת ההתפשטות: הכרטיס כולו לחיץ ופותח את חלון פרטי האתר. בלי זה
      // לחיצה על הכפתור הייתה גם פותחת לשונית וגם את החלון — ונראית כמו באג.
      onClick={(e) => e.stopPropagation()}
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
    </a>

    {/* ============================================================
        ⚠️ שינוי שיוך זמין **תמיד**, גם כשהקישור עובד
        ============================================================
        קישור שעובד ומוביל לספרייה הלא נכונה גרוע מקישור שבור: השבור אומר
        שהוא שבור, והשגוי נראה תקין וכל הצעדים בו סבירים. נמדד: הזורע 2
        קושר אוטומטית ל-`שאטל דולי` לפי דמיון שם — ואין שום דרך מהכרטיס
        לדעת אם זה נכון, ובוודאי לא לתקן.
        ⚠️ ולכן הוא **קטן ונפרד** מהכפתור הראשי. הפעולה באירוע היא לפתוח
        את הנוהל; שינוי הגדרות הוא לא, והוא לא צריך להתחרות עליה. */}
    <button
      className="ffl-edit"
      title={`משויך ל: ${link.system} / ${link.profile}${link.docs ? ` · ${link.docs} מסמכים` : ""} — לחצי לשינוי`}
      aria-label="שינוי ספריית התקלות"
      onClick={(e) => { e.stopPropagation(); setAssigning(true); }}
    >
      ✎
    </button>

    {assigning && (
      <FixFlowAssign
        site={effective}
        reason={`משויך כרגע ל-${link.system} / ${link.profile}${link.docs ? ` · ${link.docs} מסמכים` : ""}.`}
        onClose={() => setAssigning(false)}
        onSaved={onSaved}
      />
    )}
    </>
  );
}
