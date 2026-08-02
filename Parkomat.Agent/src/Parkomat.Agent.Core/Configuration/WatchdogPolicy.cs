namespace Parkomat.Agent.Core.Configuration;

/// <summary>מה ה-watchdog צריך לעשות בטיק הנוכחי.</summary>
public enum WatchdogAction
{
    /// <summary>לא לגעת. הסוכן עובד, או שהוא במצב שעוד לא מצדיק התערבות.</summary>
    None,

    /// <summary>הסוכן בריא — לדווח לריסון כדי שיתאפס אחרי שהות בריאה.</summary>
    NoteHealthy,

    /// <summary>התהליך אינו קיים — להפעיל.</summary>
    Start,

    /// <summary>התהליך חי אך תקוע — להרוג ואז להפעיל.</summary>
    KillAndStart,
}

/// <summary>
/// ההחלטה של ה-watchdog, כפונקציה טהורה.
///
/// ==========================================================
/// למה זה הוצא מ-ServiceManager
/// ==========================================================
/// ההחלטה הזו נשענה על שלושה מקורות (האם התהליך חי, פעימת לב, סף תקיעה),
/// ישבה בתוך מתודה שנוגעת בתהליכים ובקבצים אמיתיים, ולכן **לא הייתה ניתנת
/// לבדיקה**. שם בדיוק חי באג שהשבית אתרים:
///
///   פעימת הלב נכתבה רק אחרי קריאת PLC *מוצלחת*, ולכן נתק בקר נראה מכאן
///   זהה לתקיעה. נמדד: כשל קריאה עולה ~3.2 שניות, כלומר 10 כשלונות (הסף
///   לשידור state=error) לוקחים ~42 שניות, מול סף תקיעה של 30. הסוכן נהרג
///   לפני שהספיק לדווח, ההריגה איפסה את המונה, ולכן error לא שודר לעולם.
///
/// עכשיו ההחלטה מקבלת את שני הגילים בנפרד ומחזירה פעולה, ואפשר לבדוק כל
/// צירוף בלי תהליך אחד אמיתי — אותו דפוס כמו RestartPolicy ו-ResyncPolicy.
/// </summary>
public static class WatchdogPolicy
{
    /// <param name="processAlive">האם תהליך הסוכן קיים.</param>
    /// <param name="heartbeatAgeSeconds">
    /// גיל פעימת הלב — "מתי הקריאה מה-PLC הצליחה לאחרונה". null = אין קובץ.
    /// </param>
    /// <param name="livenessAgeSeconds">
    /// גיל קובץ החיוּת — "מתי הלולאה הסתובבה לאחרונה". null = אין קובץ.
    /// </param>
    /// <param name="pollIntervalMs">קצב הדגימה, שממנו נגזרים שני הספים.</param>
    public static WatchdogAction Decide(
        bool processAlive,
        long? heartbeatAgeSeconds,
        long? livenessAgeSeconds,
        int pollIntervalMs)
    {
        if (!processAlive)
            return WatchdogAction.Start;

        // בריא = הבקר נענה לאחרונה. זו השאלה של פעימת הלב, והיא גם מה שצובע
        // את הסמל — לכן היא נשארת מבוססת-heartbeat ולא מבוססת-חיוּת.
        int freshWindow = HeartbeatPolicy.FreshnessWindowSeconds(pollIntervalMs);
        if (heartbeatAgeSeconds is long hb && hb >= 0 && hb <= freshWindow)
            return WatchdogAction.NoteHealthy;

        // ==========================================================
        // תקוע = הלולאה לא הסתובבה. **לא** "הבקר לא ענה".
        // ==========================================================
        // בלי ההפרדה הזו נתק PLC היה מוביל להריגה, וזה היה הבאג.
        //
        // אין קובץ חיוּת — לא מכריזים על תקיעה. זה גם המקרה של התקנה טרייה
        // שעוד לא הספיקה סבב, וגם של סוכן מגרסה ישנה שאינו כותב את הקובץ:
        // בשניהם עדיף לא לגעת מאשר להיכנס ללופ הריגה.
        //
        // גיל שלילי = פעימה "מהעתיד", כלומר השעון קפץ אחורה. גם זה אינו
        // תקיעה, אחרת שינוי שעון היה מפעיל את הסוכן מחדש בלי סיבה.
        if (livenessAgeSeconds is long alive
            && alive >= 0
            && alive > RestartPolicy.WedgedAfterSeconds(pollIntervalMs))
        {
            return WatchdogAction.KillAndStart;
        }

        // חי, הבקר לא נענה, אבל הלולאה מסתובבת — זה בדיוק המצב של נתק PLC.
        // לא נוגעים: הסוכן צריך את השניות האלה כדי לדווח state=error בעצמו.
        return WatchdogAction.None;
    }
}
