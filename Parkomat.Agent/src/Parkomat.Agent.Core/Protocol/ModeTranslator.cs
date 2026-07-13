namespace Parkomat.Agent.Core.Protocol;

/// <summary>
/// מתרגם את מספר ה-MODE הגולמי מה-PLC אל מצב מערכת (SiteState).
/// שימי לב: ה-MODE הגולמי נשמר תמיד כמו שהוא במקום אחר —
/// כאן רק מחליטים איזה state לשלוח לשרת.
/// </summary>
public static class ModeTranslator
{
    /// <summary>
    /// ממיר MODE ל-SiteState.
    /// מחזיר null עבור MODE שאין לו מצב מוגדר (כמו 4=init),
    /// שפירושו: "אל תשלח הודעת state עבור זה".
    /// </summary>
    public static SiteState? FromMode(int mode)
    {
        return mode switch
        {
            0 => SiteState.Maintenance,  // לא באוטומט
            1 => SiteState.Ready,        // idle / מוכן
            2 => SiteState.Operating,    // enter — פעולת הכנסה
            3 => SiteState.Operating,    // exit  — פעולת הוצאה
            4 => null,                   // init — נשמר גולמי, לא מתורגם למצב
            5 => SiteState.Error,        // תקלה
            _ => null                    // ערך לא צפוי — מתעלמים בבטחה
        };
    }
}