namespace Parkomat.Agent.Core.Configuration;

/// <summary>
/// האם תהליך שנמצא לפי שם הוא <b>שלנו</b> — של ההתקנה הזו (1.0.62, 22/10/2026).
///
/// <para>עד כה ה-Tray זיהה, בדק והרג תהליכים לפי השם בלבד (<c>Parkomat.Agent.Service</c>, <c>mosquitto</c>,
/// <c>Parkomat.Agent.Tray</c>). עם שני סוכנים על אותו מחשב ה-Tray של אחד היה רואה את הסוכן של השני כ"רץ" ולא מפעיל
/// את שלו, והורג את שניהם ב"כבה", ביציאה ובשמירת הגדרות.</para>
///
/// <para>⚠️ <b>טהור בכוונה</b>, כמו <c>WatchdogPolicy</c>: קריאת הנתיב של תהליך היא I/O; ההחלטה היא כל מה שחשוב.</para>
///
/// <list type="bullet">
/// <item><b>הסוכן הרגיל</b> (<c>""</c>) — ההתנהגות של היום בדיוק, חוץ מדבר אחד: תהליך שרץ מתיקייה של סוכן אחר
/// (<c>…\Agent-2\…</c>) אינו שלו. תהליך שהנתיב שלו לא נקרא (משתמש אחר, שירות ישן מתקופת ההתקנה כמנהל) — שלו, כמו
/// היום: ההריגה לפי שם היא בדיוק מה שמנקה התקנה ישנה.</item>
/// <item><b>סוכן נוסף</b> — רק תהליך שרץ מה-exe שלו עצמו. נתיב שלא נקרא — <b>לא שלו</b>: הוא לא נוגע במה שאינו
/// יכול להוכיח שהוא שלו.</item>
/// </list>
/// </summary>
public static class ProcessOwnership
{
    /// <param name="candidateExePath">הנתיב של התהליך שנמצא, או null אם לא נקרא.</param>
    /// <param name="ourExePath">ה-exe שלנו עם אותו שם (הסוכן / Mosquitto / ה-Tray של ההתקנה הזו).</param>
    /// <param name="ourInstance">המופע שלנו (<see cref="AgentInstance.Current"/>).</param>
    public static bool IsOurs(string? candidateExePath, string ourExePath, string ourInstance)
    {
        if (ourInstance.Length > 0)
            return candidateExePath != null && SamePath(candidateExePath, ourExePath);
        if (candidateExePath == null) return true;
        return AgentInstance.FromExePath(candidateExePath).Length == 0;
    }

    private static bool SamePath(string a, string b)
    {
        try { return string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase); }
        catch { return false; }
    }
}
