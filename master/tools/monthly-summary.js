// tools/monthly-summary.js — מרענן את הסיכום החודשי לחודשים האחרונים
// שימוש ידני: node --env-file=.env tools/monthly-summary.js [חודשים אחורה]
// שימוש מ-master: require("./tools/monthly-summary").runMonthlySummary()

const { getAllSites, generateMonthlySummary } = require("../db/queries");

// ============================================================
// חלון מתגלגל, ולא "פעם אחת לחודש שנגמר"
// ============================================================
// ⚠️ זה היה באג, והוא נמדד: יולי 2026 נשמר כ-633 פעולות כשבפועל היו 801 —
// חסר 21%, בכל אחד מ-12 האתרים בלי יוצא מן הכלל.
//
// השורש הוא **צירוף של שתי התנהגויות שכל אחת מהן נכונה בפני עצמה**:
//
//   1. HiveMQ שומר הודעות כשהשרת למטה ומוסר אותן מאוחר יותר **עם החותם
//      המקורי** (clean:false + clientId קבוע). זו תכונה ולא תקלה — היא מה
//      שמבטיח שאף פעולה לא תאבד בהשבתה.
//   2. הסיכום נכתב פעם אחת בלבד: `if (!await hasMonthlySummary(...))`.
//
// הסיכום ליולי נוצר ב-2026-08-02T05:10, ו-196 פעולות של יולי נקלטו **אחרי**
// הרגע הזה. השומר אמר "כבר קיים — דלג", ולכן הן לא נספרו לעולם.
//
// לכן: **לא לדלג. לחשב מחדש.** generateMonthlySummary כבר עושה UPSERT
// (ON CONFLICT DO UPDATE), ולכן ריצה חוזרת מעדכנת במקום לשכפל.
//
// ⚠️ החודש הנוכחי **כלול בכוונה**, למרות שהוא חלקי. עד היום הוא פשוט נעדר
// מהטבלה, ולכן /api/stats/system החזיר אפס לחודש הרץ — וחודש חסר מטעה יותר
// מחודש חלקי. `generated_at` אומר מתי נמדד.
//
// ⚠️ ובכוונה על גבולות **מקומיים**. הגרסה הקודמת גזרה את שם החודש ב-UTC
// (`getUTCMonth`) בעוד generateMonthlySummary חותך בגבולות מקומיים; אתחול
// בין חצות ל-03:00 ב-1 בחודש כיוון לחודש הקודם-לקודם. חלון מתגלגל שנבנה
// מתאריכים מקומיים אינו יכול להחטיא כך.
//
// העלות זניחה: 12 אתרים × 3 חודשים = 36 חישובים, פעם ביום.
const DEFAULT_MONTHS_BACK = 3;

/** ["2026-08", "2026-07", "2026-06"] — מהחודש הנוכחי אחורה, בזמן מקומי. */
function recentMonths(count, now = new Date()) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

async function runMonthlySummary(monthsBack = DEFAULT_MONTHS_BACK) {
  const sites = await getAllSites();
  if (sites.length === 0) return;

  const months = recentMonths(monthsBack);
  let written = 0;

  for (const yearMonth of months) {
    for (const site of sites) {
      // כשל באתר אחד לא צריך להשאיר את כל השאר בלי רענון.
      try {
        await generateMonthlySummary(site.id, yearMonth);
        written++;
      } catch (err) {
        console.error(`[summary] ❌ אתר ${site.code}, ${yearMonth}: ${err.message}`);
      }
    }
  }

  console.log(`[summary] ✅ ${written} סיכומים רועננו (${months.join(", ")})`);
}

if (require.main === module) {
  const back = Number(process.argv[2]) || DEFAULT_MONTHS_BACK;
  runMonthlySummary(back)
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { runMonthlySummary, recentMonths };
