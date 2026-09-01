namespace Parkomat.Agent.Core.Supabase;

/// <summary>
/// מתי צריך אסימון חדש. פונקציה טהורה, כמו <c>ResyncPolicy</c> ו-<c>WatchdogPolicy</c>.
///
/// <para>
/// ⚠️ <b>למה זו החלטה נפרדת ולא <c>if</c> בתוך הכותב.</b> אותו שיקול בדיוק
/// שהוציא את <c>WatchdogPolicy</c> החוצה: החלטה שקבורה בתוך קוד רשת אינה
/// ניתנת לבדיקה בלי רשת, ולכן היא נבדקת רק בייצור. הבאג ב-watchdog שרד 127
/// בדיקות עוברות בדיוק מהסיבה הזו.
/// </para>
///
/// <para>
/// ⚠️ <b>מרענן <em>לפני</em> הפקיעה, לא אחריה.</b> אסימון של Supabase חי
/// שעה. רענון בתגובה ל-401 נשמע חסכוני והוא הדרך הבטוחה לאבד הודעות: כל
/// שידור שנופל על 401 חייב לחזור, והתור מתמלא בזמן שהסוכן מגלה מחדש בכל
/// סבב שהאסימון פג. סף מוקדם הופך את זה לאירוע אחד ומתוזמן.
/// </para>
///
/// <para>
/// ⚠️ <b>וגם שעון סוטה נלקח בחשבון.</b> באתר שהשעון שלו מקדים בדקה, אסימון
/// ייראה פג לפני שהוא פג באמת; באתר שמפגר — להפך. הסף של חמש דקות מכסה את
/// הסטיות שנמדדו בשטח (34 שניות באתר 1343, 70 באתר 2439) בשוליים גדולים.
/// </para>
/// </summary>
public static class TokenPolicy
{
    /// <summary>כמה זמן לפני הפקיעה כבר מרעננים.</summary>
    public static readonly TimeSpan RefreshMargin = TimeSpan.FromMinutes(5);

    /// <summary>
    /// האם דרוש אסימון חדש כרגע.
    ///
    /// ⚠️ אין אסימון, או שאין לו זמן פקיעה ידוע ⇒ <b>כן</b>. ברירת המחדל
    /// היא לרענן: ניסיון מיותר עולה בקשה אחת, ואילו הימנעות שגויה עולה
    /// בכל ההודעות שיישלחו עד שמישהו ישים לב.
    /// </summary>
    public static bool ShouldRefresh(string? token, DateTimeOffset? expiresAt, DateTimeOffset now)
    {
        if (string.IsNullOrWhiteSpace(token)) return true;
        if (expiresAt is null) return true;
        return now >= expiresAt.Value - RefreshMargin;
    }

    /// <summary>
    /// זמן הפקיעה מתוך <c>expires_in</c> (שניות) שהתקבל בתשובה.
    ///
    /// ⚠️ ערך לא-סביר (אפס, שלילי, או ארוך בצורה מגוחכת) מוחזר כ-<c>null</c>
    /// ולא "מתוקן" לערך שנראה הגיוני. <c>null</c> פירושו "רענן בפעם הבאה",
    /// שהוא המצב הבטוח; ניחוש היה יוצר אסימון שנחשב תקף אחרי שפג.
    /// </summary>
    public static DateTimeOffset? ExpiryFrom(int expiresInSeconds, DateTimeOffset now)
    {
        if (expiresInSeconds <= 0) return null;
        if (expiresInSeconds > 24 * 3600) return null;
        return now.AddSeconds(expiresInSeconds);
    }
}
