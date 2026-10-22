namespace Parkomat.Agent.Core.Configuration;

/// <summary>
/// סוכן נוסף על אותו מחשב (1.0.62, 22/10/2026).
///
/// ============================================================
/// למה זה קיים
/// ============================================================
/// במעפילי אגוז יש מחשב (NUC) אחד שאליו מחוברים שני חניונים נפרדים לגמרי — שמאל (12282, בקר 6.6.7.3) וימין
/// (1228, בקר 6.6.6.3) — והבקרים שלהם אינם מדברים זה עם זה. שני אתרים, שני סוכנים. בחירת הבעלת: "שני סוכנים על
/// אותו מחשב" — כל אחד סוכן רגיל לגמרי, עם ההגדרות, התור, הלוג והזהות שלו.
///
/// ============================================================
/// איך סוכן יודע מי הוא — מתיקיית ההתקנה, בלי ארגומנטים
/// ============================================================
/// הסוכן השני מותקן ל-<c>{localappdata}\Parkomat\Agent-2</c> (מתקין נפרד, <c>/DInstance=2</c>). כל תהליך — ה-Tray,
/// הסוכן — גוזר את המופע מהתיקייה שהוא רץ ממנה, ולכן אין שום ארגומנט להעביר: לא ב-Run, לא במשימה המתוזמנת, ולא
/// כשה-Tray מפעיל את הסוכן. תיקייה בשם <c>Agent</c> (או כל דבר אחר — הרצה מ-bin בפיתוח, publish) = הסוכן הרגיל,
/// ולכן <b>שום דבר לא משתנה ב-90 האתרים הקיימים</b>.
///
/// ⚠️ כל מה שמשותף למחשב מקבל את המופע כסיומת, ורק במופע שאינו הרגיל: תיקיית הנתונים, ה-Mutex-ים, המשימה המתוזמנת,
/// ערך ה-Run. ה-Tray מזהה את התהליכים שלו לפי הנתיב (<see cref="ProcessOwnership"/>), לא לפי השם בלבד.
/// </summary>
public static class AgentInstance
{
    private const string Prefix = "Agent-";

    /// <summary>
    /// המופע של התהליך הזה: <c>""</c> — הסוכן הרגיל; <c>"2"</c> — הסוכן השני. נקבע פעם אחת, מתיקיית ההתקנה
    /// (התיקייה מעל <c>service</c> / <c>tray</c>).
    /// </summary>
    public static string Current { get; } = SafeFromBaseDirectory();

    private static string SafeFromBaseDirectory()
    {
        try { return FromInstallRoot(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, ".."))); }
        catch { return ""; }
    }

    /// <summary>
    /// המופע לפי שורש ההתקנה: <c>…\Agent-2</c> → <c>"2"</c>; כל שם אחר → <c>""</c>.
    /// אותיות לטיניות וספרות, עד 16 — שם שנכנס בבטחה לנתיב, ל-Mutex ולשם משימה.
    /// </summary>
    public static string FromInstallRoot(string? installRoot)
    {
        if (string.IsNullOrWhiteSpace(installRoot)) return "";
        string name = Path.GetFileName(installRoot.TrimEnd('\\', '/'));
        if (!name.StartsWith(Prefix, StringComparison.OrdinalIgnoreCase)) return "";
        string slug = name.Substring(Prefix.Length);
        return IsValidSlug(slug) ? slug : "";
    }

    /// <summary>
    /// המופע לפי נתיב של exe מהתקנה: <c>{root}\service\X.exe</c>, <c>{root}\tray\X.exe</c>,
    /// <c>{root}\mosquitto\mosquitto.exe</c> — שתי תיקיות למעלה.
    /// </summary>
    public static string FromExePath(string? exePath)
    {
        if (string.IsNullOrWhiteSpace(exePath)) return "";
        try
        {
            string? root = Path.GetDirectoryName(Path.GetDirectoryName(exePath));
            return FromInstallRoot(root);
        }
        catch { return ""; }
    }

    /// <summary>אותיות לטיניות וספרות בלבד, 1–16.</summary>
    public static bool IsValidSlug(string? s) =>
        !string.IsNullOrEmpty(s) && s.Length <= 16 && s.All(char.IsAsciiLetterOrDigit);

    /// <summary>
    /// השם עם המופע כסיומת: לסוכן הרגיל — כמו שהוא (<c>ParkomatAgentKeepAlive</c>); לשני —
    /// <c>ParkomatAgentKeepAlive-2</c>.
    /// </summary>
    public static string Suffixed(string name, string? instance = null)
    {
        string i = instance ?? Current;
        return i.Length == 0 ? name : $"{name}-{i}";
    }

    /// <summary>השם שמוצג בחלונות וב-Tray: "Parkomat Agent" או "Parkomat Agent 2".</summary>
    public static string ProductName(string? instance = null)
    {
        string i = instance ?? Current;
        return i.Length == 0 ? "Parkomat Agent" : $"Parkomat Agent {i}";
    }
}
