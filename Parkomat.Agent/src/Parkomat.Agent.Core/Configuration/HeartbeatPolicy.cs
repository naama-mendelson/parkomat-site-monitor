namespace Parkomat.Agent.Core.Configuration;

/// <summary>
/// מדיניות רעננות ה-heartbeat, במקום אחד ומשותף. ה-Agent כותב heartbeat אחרי כל
/// קריאת PLC מוצלחת (פעם בכל מחזור דגימה); ה-Tray מחשיב את הסוכן "באמת עובד" רק
/// אם ה-heartbeat טרי. אם החלון היה קבוע (10s) בזמן שקצב הדגימה יכול להגיע ל-600s,
/// טכנאי שמאט את הדגימה היה גורם לסמל להראות "אין קשר לבקר" למרות שהכול תקין.
/// </summary>
public static class HeartbeatPolicy
{
    /// <summary>רצפת החלון: לעולם לא פחות מ-10 שניות, גם בדגימה מהירה מאוד.</summary>
    public const int FloorSeconds = 10;

    /// <summary>
    /// חלון הרעננות בשניות: max(10s, 3 × מחזור-הדגימה). מכפלת 3 נותנת מרווח
    /// לכמה דגימות שנכשלו/איטיות לפני שמכריזים "לא טרי". פונקציה טהורה — נבדקת בנפרד.
    /// </summary>
    public static int FreshnessWindowSeconds(int pollIntervalMs)
    {
        int pollSeconds = (int)System.Math.Ceiling(pollIntervalMs / 1000.0);
        return System.Math.Max(FloorSeconds, 3 * pollSeconds);
    }
}
