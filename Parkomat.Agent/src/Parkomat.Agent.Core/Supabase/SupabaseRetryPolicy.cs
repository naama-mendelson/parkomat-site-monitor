namespace Parkomat.Agent.Core.Supabase;

/// <summary>
/// כמה להמתין לפני ניסיון שליחה נוסף אחרי כשל.
///
/// <para>⚠️ <b>עד עכשיו — אפס.</b> שער השליחה נפתח בכל סבב שבו התור אינו
/// ריק, כלומר <b>כל שנייה</b>. הודעה שנכשלת חוזרת לתור, התור נשאר לא ריק,
/// והלולאה סוגרת את עצמה:</para>
///
/// <code>תור לא ריק → שליחה → כשל → חזרה לתור → תור לא ריק → ...</code>
///
/// <para>⚠️ <b>וזה נמדד באתר 1326 ב-09/09/2026.</b> הסיסמה הייתה פסולה,
/// והלוג הראה ניסיון כל ~1.1 שניות ברציפות: <b>כ-78,000 בקשות ביום מאתר
/// אחד</b>. Supabase כבר החזירה <c>429 over_request_rate_limit</c> לסירוגין
/// — כלומר השרת הגן על עצמו מפני הסוכן שלנו.</para>
///
/// <para>⚠️ <b>וזה אינו ייחודי לסיסמה.</b> כל כשל מתמשך — רשת שנפלה
/// לשעות, שגיאת שרת, תעודה שפגה — מייצר בדיוק את אותה לולאה. התור נבנה
/// כדי לשרוד נתק, אבל הניסיון החוזר שלו לא רוסן מעולם.</para>
///
/// <para>⚠️ <b>ומכסת התעבורה כבר חורגת</b> — 6.03GB מתוך 5GB. אתר בודד
/// בלולאה כזו הוא סדר גודל מעל כל מה שהמערכת מייצרת בשגרה.</para>
/// </summary>
public static class SupabaseRetryPolicy
{
    /// <summary>ההמתנה אחרי הכשל הראשון.</summary>
    public const int FirstDelaySeconds = 5;

    /// <summary>
    /// התקרה. ⚠️ <b>חמש דקות ולא יותר, ובכוונה.</b> ההמתנה חלה גם על
    /// הפעימה, ו-<c>app.mark_silent_agents</c> מסמנת אתר מנותק אחרי שלוש
    /// דקות בלי פעימה. תקרה גבוהה יותר הייתה משאירה אתר שהתאושש מסומן
    /// מנותק זמן רב אחרי שהתקשורת חזרה.
    ///
    /// <para>וזה מקובל: כשהשליחה נכשלת האתר ממילא אינו יכול לפעום, ולכן
    /// אין כאן אובדן — רק דחיית הניסיון הבא.</para>
    /// </summary>
    public const int MaxDelaySeconds = 300;

    /// <summary>
    /// ההמתנה אחרי <paramref name="consecutiveFailures"/> כשלים רצופים.
    /// הכפלה מ-5 שניות עד התקרה.
    /// </summary>
    public static int DelaySeconds(int consecutiveFailures)
    {
        if (consecutiveFailures <= 0) return 0;

        // ⚠️ הכפלה בלולאה ולא Math.Pow: מונה גבוה (אתר שנכשל יממה שלמה)
        // היה מייצר חזקה ענקית, ו-int היה עולה על גדותיו לערך **שלילי** —
        // כלומר "לנסות מיד", בדיוק ההפך מהכוונה, ודווקא במקרה הקיצוני.
        int delay = FirstDelaySeconds;
        for (int i = 1; i < consecutiveFailures && delay < MaxDelaySeconds; i++)
            delay *= 2;

        return delay > MaxDelaySeconds ? MaxDelaySeconds : delay;
    }

    /// <summary>
    /// האם הכשל <b>קבוע</b> — כזה שניסיון חוזר לא יפתור.
    ///
    /// <para>⚠️ <b>הזדהות שנדחתה היא המקרה המובהק:</b> סיסמה שגויה תישאר
    /// שגויה בעוד שנייה ובעוד שעה. קפיצה ישירה לתקרה חוסכת את מאות
    /// הניסיונות הראשונים שאין להם שום סיכוי.</para>
    ///
    /// <para>⚠️ <b>ולא "מפסיקים לנסות" — קופצים לתקרה.</b> הטכנאי יכול
    /// לתקן את הסיסמה בטופס בכל רגע, וסוכן שוויתר לצמיתות היה דורש הפעלה
    /// מחדש כדי לשים לב. חמש דקות הן פשרה בין "לא להטריד" לבין "לשים לב".</para>
    ///
    /// <para>⚠️ ו-<c>429</c> נחשב קבוע גם הוא, אף שהוא זמני במהותו: הוא
    /// אומר שהשרת כבר מגן על עצמו מפנינו, וזו בדיוק הנקודה שבה להאט הכי
    /// חשוב. הוא הופיע לסירוגין עם 400 באותו לוג.</para>
    /// </summary>
    public static bool IsPermanent(int status, string? error)
    {
        // 429 — השרת מבקש מאיתנו במפורש להאט.
        if (status == 429) return true;

        // 400/401/403 עם רמז להזדהות. ⚠️ הבדיקה על הטקסט ולא רק על הקוד:
        // 400 הוא גם "הודעה פגומה", וזה כשל שכן משתנה בין הודעה להודעה.
        if (status is 400 or 401 or 403)
        {
            string e = error ?? "";
            return e.Contains("invalid_credentials", StringComparison.OrdinalIgnoreCase)
                || e.Contains("Invalid login", StringComparison.OrdinalIgnoreCase)
                || e.Contains("invalid_grant", StringComparison.OrdinalIgnoreCase);
        }

        return false;
    }

    /// <summary>
    /// המונה שיש להחזיק אחרי כשל — מקדם רגיל, או קפיצה לתקרה כשהכשל קבוע.
    /// </summary>
    public static int NextFailureCount(int current, int status, string? error)
    {
        if (IsPermanent(status, error)) return FailuresAtCeiling;
        return current >= FailuresAtCeiling ? FailuresAtCeiling : current + 1;
    }

    /// <summary>
    /// כמה כשלים רצופים דרושים כדי להגיע לתקרה. נגזר ולא מקובע, אחרת
    /// שינוי ב-<see cref="FirstDelaySeconds"/> היה משאיר כאן מספר שקרי.
    /// </summary>
    public static int FailuresAtCeiling
    {
        get
        {
            int n = 1, delay = FirstDelaySeconds;
            while (delay < MaxDelaySeconds) { delay *= 2; n++; }
            return n;
        }
    }
}
