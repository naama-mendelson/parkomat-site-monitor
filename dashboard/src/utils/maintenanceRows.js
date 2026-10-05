// utils/maintenanceRows.js — "תחזוקות פעילות" במסך המפקח: שורה אחת לכל אתר.
//
// ============================================================
// ⚠️ שני חלונות פעילים לאותו אתר — וזה קיים בייצור
// ============================================================
// נמדד 05/10/2026: לאתר 1311 שני חלונות פעילים, שנפתחו ב-16/09 בהפרש של
// 25 שניות (30 יום, ו-29 יום ו-4 שעות). `start_maintenance` אינו בודק אם
// כבר יש חלון — ולכן לחיצה כפולה, או תיקון משך בפתיחה שנייה, משאירים שניים.
//
// הרשימה הציגה את האתר פעמיים, עם אותו `key` (React התריע על מפתח כפול),
// ועם שני כפתורי "בטל" — כש-`cancel_maintenance` מבטל את **כל** החלונות
// הפעילים של האתר בלחיצה אחת. כלומר שתי שורות לפעולה אחת, וכל אחת מהן
// מציגה תאריך תפוגה אחר.
//
// ⚠️ **התפוגה היא המאוחרת מביניהם**, כי זה הרגע שבו האתר באמת יוצא
// מתחזוקה (החלונות מתמזגים גם בחישוב הזמינות). הפתיחה — המוקדמת.
// ⚠️ והאיחוד כאן, במסך, ולא ב-`toSupervisorShape`: הצורה מושווית לשרת
// ב-`parity-supervisor`, ושינוי שלה היה מאדים שער על הבדל מכוון.
export function oneRowPerSite(list) {
  const bySite = new Map();
  for (const m of list || []) {
    const key = m.siteCode ?? `?${bySite.size}`;
    const prev = bySite.get(key);
    if (!prev) {
      bySite.set(key, { ...m, windows: 1 });
      continue;
    }
    // הבסיס הוא החלון שפג אחרון — ממנו מי הפעיל והסיבה, כי הוא זה שקובע.
    const later = String(m.expiresAt) > String(prev.expiresAt) ? m : prev;
    bySite.set(key, {
      ...later,
      startedAt: String(m.startedAt) < String(prev.startedAt) ? m.startedAt : prev.startedAt,
      windows: prev.windows + 1,
    });
  }
  // אותו סדר כמו השאילתה: הקרוב לפוג ראשון.
  return [...bySite.values()].sort((a, b) => String(a.expiresAt).localeCompare(String(b.expiresAt)));
}
