namespace Parkomat.Agent.Core.Supabase;

/// <summary>
/// האם המסלול הישיר "מחובר" — התשובה שסמל הענן ב-Tray מציג באתר שבו MQTT כבוי.
///
/// <para>⚠️ <b>למה זו פונקציה ולא "נכתב 1 אחרי שליחה מוצלחת".</b> כך זה
/// היה: הקובץ נכתב רק אחרי שליחה, כלומר באתר שקט <b>פעם בדקה</b> (הפעימה),
/// וה-Tray מחשיב אותו טרי <c>max(10, 3×poll)</c> שניות. הסמל היה צבעוני
/// עשר שניות ואפור חמישים — בכל דקה, באתר שעבד מצוין. סמל שמהבהב לבד מלמד
/// את הטכנאי להתעלם ממנו, ואז היום שבו הקשר באמת נפל נראה כמו כל יום.</para>
///
/// <para>עכשיו הסטטוס נכתב <b>בכל סבב</b>, כמו באתר MQTT, והערך נגזר מכאן.</para>
///
/// <para>⚠️ <b>והוא עדיין נופל כשהשליחות נכשלות — מיד, ולא אחרי דקות.</b>
/// כשל אחד מעלה את מונה הכשלים, והסטטוס אדום מהסבב הבא. חלון הזמן מכסה
/// את המקרה השני: שליחות שפשוט <b>אינן קורות</b> (שער סגור, בקשה תלויה) —
/// ואז הסמל מאדים אחרי <see cref="MaxSilence"/>.</para>
/// </summary>
public static class DirectLinkStatus
{
    /// <summary>
    /// ⚠️ <b>שלוש דקות — בדיוק הסף של <c>app.mark_silent_agents(3)</c> בשרת.</b>
    /// הסמל מאדים באותו רגע שבו השרת היה מסמן את האתר <c>no_comm</c>, כך
    /// שהטכנאי שעומד ליד המחשב והמסך במשרד אומרים את אותו הדבר.
    ///
    /// <para>וזה גם מרווח בטוח מעל פעימה של 60 שניות + timeout של 15 שניות
    /// לבקשה, כך שאתר תקין לעולם אינו מגיע לסף.</para>
    /// </summary>
    public static readonly TimeSpan MaxSilence = TimeSpan.FromMinutes(3);

    /// <param name="consecutiveFailures">מונה הכשלים של השליחה הישירה (0 = הניסיון האחרון הצליח).</param>
    /// <param name="lastSuccess">רגע השליחה המוצלחת האחרונה (<c>MinValue</c> = עוד לא הייתה).</param>
    /// <param name="now">השעה הנוכחית, מאותו שעון.</param>
    public static bool IsUp(int consecutiveFailures, DateTimeOffset lastSuccess, DateTimeOffset now)
    {
        if (consecutiveFailures > 0) return false;

        // ⚠️ גיל שלילי = השעון קפץ אחורה. "טרי" כאן היה שקר: הפעימה הבאה
        // נדחית עד שהשעון ישיג את החותם, כלומר דווקא עכשיו אין שליחות.
        TimeSpan age = now - lastSuccess;
        return age >= TimeSpan.Zero && age <= MaxSilence;
    }
}
