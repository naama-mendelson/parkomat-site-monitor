// utils/signature.js — מתי ציור על משטח החתימה נחשב חתימה.
//
// ⚠️ "יש דיו על המשטח" אינו מספיק. נגיעה מקרית של כף היד, נקודה אחת או קו
// קצר בפינה — כולם "לא ריקים", וכולם היו נשמרים כחתימה על ביקור תחזוקה
// שהוא מסמך שעשוי להיות מוצג לבודק או לביטוח. שני התנאים יחד:
//   • לפחות 30 נקודות — חתימה היא תנועה, לא הקשה;
//   • מסגרת הדיו מכסה לפחות 25% מהרוחב ו-20% מהגובה — לא שרבוט בפינה.
//
// הקואורדינטות מנורמלות (0..1) ביחס למשטח, ולכן הבדיקה אינה תלויה בגודל
// המסך — אותה חתימה עוברת בטלפון ובמחשב.
export const SIGNATURE_MIN_POINTS = 30;
export const SIGNATURE_MIN_WIDTH = 0.25;
export const SIGNATURE_MIN_HEIGHT = 0.2;

/** strokes: [[{x,y}, ...], ...] בקואורדינטות 0..1 */
export function signatureStats(strokes) {
  let points = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes || []) {
    for (const p of s) {
      points++;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  const width = points ? maxX - minX : 0;
  const height = points ? maxY - minY : 0;
  return {
    points,
    width,
    height,
    empty: points === 0,
    acceptable:
      points >= SIGNATURE_MIN_POINTS && width >= SIGNATURE_MIN_WIDTH && height >= SIGNATURE_MIN_HEIGHT,
  };
}
