// api/periods.js — הגדרת התקופות (שבוע / חודש / שנה).
//
// ============================================================
// למה זה מודול נפרד, ולא הועתק פעמיים
// ============================================================
// גם ה-API של הדשבורד וגם עוזר ה-AI צריכים לתרגם "חודש" לטווח תאריכים. אם כל
// אחד היה מחזיק עותק משלו, הם היו נפרדים ביום שבו מישהו יתקן אחד מהם — והבוט
// היה מדווח מספרים ש**אינם תואמים למסך שהמשתמש מסתכל בו באותו רגע**. משתמש
// שרואה 24 פעולות בדשבורד ושומע מהבוט 31 לא יאמין לאף אחד מהם, ובצדק.
//
// מקור אמת אחד. הקוד הועבר לכאן כמות שהוא — בלי שינוי התנהגות.
// ============================================================

// גבולות התקופה הנבחרת + התקופה הקודמת המקבילה.
// הגבולות קלנדריים ומחושבים בשעון המקומי (השרת רץ בישראל), ומומרים ל-ISO לשאילתות.
function resolvePeriod(period) {
  const now = new Date();
  const iso = (d) => d.toISOString();

  if (period === "month") {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);       // 1 בחודש הנוכחי
    const prevFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return {
      period: "month",
      label: from.toLocaleDateString("he-IL", { month: "long", year: "numeric" }),
      comparisonLabel: `לעומת ${prevFrom.toLocaleDateString("he-IL", { month: "long" })}`,
      granularity: "day",
      range: { from: iso(from), to: iso(now) },
      prev: { from: iso(prevFrom), to: iso(from) },   // החודש הקודם במלואו
    };
  }

  if (period === "year") {
    const from = new Date(now.getFullYear(), 0, 1);                    // 1 בינואר
    const prevFrom = new Date(now.getFullYear() - 1, 0, 1);
    return {
      period: "year",
      label: String(now.getFullYear()),
      comparisonLabel: `לעומת ${now.getFullYear() - 1}`,
      granularity: "month",
      range: { from: iso(from), to: iso(now) },
      prev: { from: iso(prevFrom), to: iso(from) },   // השנה הקודמת במלואה
    };
  }

  // ברירת מחדל: שבוע — 7 ימים קלנדריים כולל היום, מיושר לחצות.
  // חשוב: חלון שמתחיל בשעה שרירותית (now פחות 168 שעות) יוצר ימים חלקיים
  // בשני הקצוות, והדלי של *היום* נופל מחוץ לסדרה — כך אבדו פעולות ותקלות של היום.
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  const prevFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 13);
  return {
    period: "week",
    label: "7 הימים האחרונים",
    comparisonLabel: "לעומת השבוע הקודם",
    granularity: "day",
    range: { from: iso(from), to: iso(now) },
    prev: { from: iso(prevFrom), to: iso(from) },   // 7 הימים הקלנדריים שלפני כן
  };
}

module.exports = { resolvePeriod };
