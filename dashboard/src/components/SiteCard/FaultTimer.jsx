// components/SiteCard/FaultTimer.jsx — כמה זמן האתר בתקלה, **עכשיו**.
//
// ============================================================
// ⚠️ למה סטופר ולא "לפני 3 שעות"
// ============================================================
// הכרטיס כבר מראה `timeAgo(statusSince)` — אבל רק בכרטיס המורחב, וכטקסט
// שמחושב פעם אחת ברינדור. תקלה היא המצב היחיד שבו **הזמן עצמו הוא
// הנתון**: ההבדל בין תקלה בת 4 דקות לתקלה בת 4 שעות הוא ההבדל בין
// "קורה" לבין "אף אחד לא שם לב".
//
// ⚠️ **ולכן הוא מתקתק.** מסך בקרה נשאר פתוח שעות; ערך שמחושב פעם אחת
// קופא, ומציג "לפני 2 דקות" על תקלה בת שעתיים. זו לא אי-דיוק — זו
// הטעיה, ובדיוק בכיוון המסוכן.
import { useEffect, useState } from "react";
import "./FaultTimer.css";

/**
 * פורמט: שניות עד דקה, אחר כך דקות, אחר כך שעות:דקות.
 *
 * ⚠️ **לא `timeAgo`.** הוא מעגל ל"לפני כשעה", ובסטופר העיגול הזה מוחק
 * בדיוק את מה שמסתכלים עליו — האם זה 61 דקות או 119.
 */
function format(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} שנ׳`;

  const m = Math.floor(s / 60);
  if (m < 60) return `${m}:${String(s % 60).padStart(2, "0")}`;

  const h = Math.floor(m / 60);
  // ⚠️ מעל יממה — ימים, ולא "73:20". שעות דו-ספרתיות מעל 24 מפסיקות
  // להיקרא כמשך ומתחילות להיראות כמו שעון.
  if (h >= 24) {
    const d = Math.floor(h / 24);
    // ⚠️ עברית ולא תבנית אנגלית: "1 ימים" ו-"2 ימים" שגויים, והם היו
    // מופיעים בדיוק על התקלות הארוכות ביותר — אלה שמסתכלים עליהן.
    const days = d === 1 ? "יום" : d === 2 ? "יומיים" : `${d} ימים`;
    return `${days} ${h % 24} שע׳`;
  }
  return `${h}:${String(m % 60).padStart(2, "0")} שע׳`;
}

/**
 * הסטופר. מוצג רק כשיש ממה לספור.
 *
 * @param since  ISO של תחילת המצב (statusSince)
 * @param tone   "error" | "no_comm" — קובע צבע בלבד
 */
export default function FaultTimer({ since, tone = "error" }) {
  // ⚠️ `Date.now()` ולא `new Date()`: הערך היחיד שמשתנה הוא מספר, ו-state
  // שמחזיק אובייקט חדש בכל טיק מייצר רינדור גם כשהשנייה לא התחלפה.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!since) return undefined;
    // ⚠️ שנייה ולא 100ms: הפורמט הגס ביותר הוא שניות, וטיק מהיר יותר הוא
    // רינדור לכל כרטיס על המסך בלי שום שינוי גלוי. ב-18 כרטיסים זה נמדד.
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);

  if (!since) return null;

  const started = Date.parse(since);
  // ⚠️ חותם שאינו נפרס אינו "0 שניות" — הוא חוסר מידע, וסטופר שמתחיל
  // מאפס על נתון חסר הוא שקר שנראה כמו עובדה.
  if (Number.isNaN(started)) return null;

  return (
    <span className={`fault-timer fault-timer--${tone}`}
          title={`בתקלה מאז ${new Date(started).toLocaleString("he-IL")}`}>
      <span className="fault-timer-dot" />
      {format(now - started)}
    </span>
  );
}
