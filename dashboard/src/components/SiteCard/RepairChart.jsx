// components/SiteCard/RepairChart — מקל לכל תקלה, גובה לפי המשך.
//
// ============================================================
// למה גרף ולא פס יחסי
// ============================================================
// קדם לזה פס שחילק את התקלות לשלוש דרגות ברוחב יחסי. הוא ענה על "כמה
// מכל סוג" ולא על **"כמה חמור"** — ובנתונים כאן זו השאלה: 10% התקלות
// הארוכות מהוות 68% מזמן התקלה.
//
// מקל לכל תקלה מראה את זה מיד. אתר 2438 הוא שורה של מקלות נמוכים ושלושה
// שיאים (202, 424, 141 דקות) — תמונה שאף מספר בודד אינו מוסר.
//
// ⚠️ **וסדר כרונולוגי, לא מדורג.** הגרף הוא ציר זמן: מקלות גבוהים
// שנצמדים זה לזה אומרים "היה כאן שבוע רע", ואותם מקלות מפוזרים אומרים
// "יש כאן בעיה כרונית". מיון לפי גובה היה מוחק את ההבחנה הזו.
import { bucketOf } from "./repairBuckets";
import "./RepairChart.css";

/** דקות → צורה קריאה. זהה לזו שבכרטיס, בכוונה. */
function dur(min) {
  if (min < 1) return "< דקה";
  if (min < 60) return `${Math.round(min)} דק׳`;
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return m ? `${h}:${String(m).padStart(2, "0")} שע׳` : `${h} שע׳`;
}

/**
 * @param series מערך משכים בדקות, בסדר כרונולוגי
 * @param compact על הכרטיס — נמוך יותר
 */
function RepairChart({ series, compact = false }) {
  if (!series || series.length === 0) return null;

  const max = Math.max(...series);
  const H = compact ? 26 : 42;

  return (
    <div className={`rchart${compact ? " rchart--compact" : ""}`}
         style={{ height: `${H}px` }}
         role="img"
         aria-label={`${series.length} תקלות, הארוכה ${dur(max)}`}>
      {/* ⚠️ RTL: הראשון בדום הוא הימני, ולכן הסדר הכרונולוגי נקרא
          מימין לשמאל — הכיוון שבו קוראים את שאר הכרטיס. */}
      {series.map((m, i) => {
        const b = bucketOf(m);
        // ⚠️ **רצפה של 3px, וסקאלה לינארית.** לינארית היא הכנה — תקלה
        // של 424 דקות באמת גבוהה פי 90 מאחת של 4.7. אבל בלי רצפה
        // המקלות הקצרים היו נעלמים לגמרי, והגרף היה נראה כמו מקל בודד
        // על רקע ריק. הרצפה שומרת אותם נראים בלי לשקר על היחס.
        const h = Math.max(3, Math.round((m / max) * H));
        return (
          <span
            key={i}
            className={`rchart-bar rchart-bar--${b.key}`}
            style={{ height: `${h}px` }}
            title={dur(m)}
          />
        );
      })}
    </div>
  );
}

export default RepairChart;
