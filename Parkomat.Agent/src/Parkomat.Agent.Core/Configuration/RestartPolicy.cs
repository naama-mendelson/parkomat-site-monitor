namespace Parkomat.Agent.Core.Configuration;

/// <summary>
/// מדיניות ההפעלה-מחדש של ה-watchdog: כמה להמתין בין ניסיונות, ומתי להכריז
/// שסוכן "חי" הוא בעצם תקוע.
///
/// ==========================================================
/// למה צריך ריסון, ולמה זה נעשה דחוף בגרסה 1.0.15
/// ==========================================================
/// ה-watchdog של ה-Tray פועל כל 5 שניות והפעיל מחדש כל תהליך שאינו רץ — בלי
/// שום המתנה. סוכן שקורס מיד בעלייה (הגדרה פגומה, קובץ חסר, DLL שנעלם) קיבל
/// אלפי ניסיונות ביום.
///
/// עד 1.0.15 זה היה בעיקר בזבוז. מ-1.0.15 זה הפך למשחית-נתונים: ה-detector
/// פותח עכשיו פעולה גם בקריאה הראשונה שנוחתת באמצע מחזור (MODE 2/3). חותם
/// הזמן שלה הוא "עכשיו", ומפתח ה-dedup בשרת בנוי על החותם המדווח — ולכן **כל
/// הפעלה מחדש מייצרת שורת פעולה חדשה**.
///
/// אתר עם MODE תקוע על 2 שהסוכן שלו קורס בלופ היה מייצר פעולה חדשה כל 5
/// שניות: 17,280 פעולות פיקטיביות ביום. וזה לא רק רעש — מכנה אחוז הכשל הוא
/// מספר הפעולות, ולכן **אתר שבור היה מקבל ציון בריא יותר** ככל שהוא נשבר
/// יותר. זה בדיוק סוג הכשל שהמערכת קיימת כדי לתפוס.
/// </summary>
public static class RestartPolicy
{
    /// <summary>ההמתנה הראשונה, בשניות. תואמת לקצב ה-watchdog.</summary>
    public const int BaseDelaySeconds = 5;

    /// <summary>
    /// תקרת ההמתנה: 5 דקות. גבוה מספיק כדי שקריסה-בלופ תיעצר כמעט לגמרי, ונמוך
    /// מספיק שסוכן שהתקלה שלו נפתרה מעצמה (למשל הרשת חזרה) יחזור לעבוד בלי
    /// שטכנאי ייסע לאתר.
    /// </summary>
    public const int MaxDelaySeconds = 300;

    /// <summary>
    /// כמה חלונות-רעננות של פעימת לב עוברים לפני שסוכן *חי* נחשב תקוע.
    ///
    /// שלושה, ולא אחד: חלון בודד נחשב "לא טרי" גם בדגימה איטית או בכמה קריאות
    /// PLC שנכשלו, ולהרוג את הסוכן על זה היה גרוע מלא לעשות כלום. שלושה חלונות
    /// (ברירת מחדל: 30 שניות) הם כבר לא רעש — סוכן שלא הצליח לקרוא מהבקר חצי
    /// דקה שלמה בזמן שהתהליך שלו חי אינו במצב שהוא יֵצא ממנו לבד.
    /// </summary>
    public const int WedgedHeartbeatWindows = 3;

    /// <summary>
    /// כמה זמן של פעימות טריות נדרש כדי לאפס את מונה הניסיונות. בלי זה, סוכן
    /// שקרס פעם אחת לפני יומיים היה נשאר עם ההמתנה המקסימלית לנצח.
    /// </summary>
    public static readonly TimeSpan HealthyResetAfter = TimeSpan.FromMinutes(2);

    /// <summary>
    /// ההמתנה לפני הניסיון הבא, לפי מספר הניסיונות שכבר בוצעו.
    /// 0 → מיד (הקריסה הראשונה מטופלת ללא דחייה), ואז 5, 10, 20, 40, 80, 160, 300…
    /// פונקציה טהורה.
    /// </summary>
    public static int DelaySecondsFor(int consecutiveRestarts)
    {
        if (consecutiveRestarts <= 0)
            return 0;

        // שומרים על 2^n מלגלוש: מעל 16 הכפלות ממילא חורגים מהתקרה.
        if (consecutiveRestarts > 16)
            return MaxDelaySeconds;

        long delay = (long)BaseDelaySeconds << (consecutiveRestarts - 1);
        return (int)System.Math.Min(delay, MaxDelaySeconds);
    }

    /// <summary>
    /// אחרי כמה שניות בלי פעימת לב סוכן *חי* נחשב תקוע, לפי קצב הדגימה.
    /// נגזר מ-HeartbeatPolicy כדי שיהיה מקור אמת אחד לחלון הרעננות.
    /// </summary>
    public static int WedgedAfterSeconds(int pollIntervalMs)
        => WedgedHeartbeatWindows * HeartbeatPolicy.FreshnessWindowSeconds(pollIntervalMs);
}

/// <summary>
/// המצב של הריסון — מי כבר הופעל מחדש, מתי, וכמה. מופרד מ-ServiceManager
/// כדי שיהיה ניתן לבדיקה בלי תהליכים אמיתיים ובלי להמתין בזמן אמת: השעון
/// מוזרק.
/// </summary>
public sealed class RestartThrottle
{
    private readonly Func<DateTime> _utcNow;

    private int _consecutive;
    private DateTime? _lastRestartUtc;

    public RestartThrottle(Func<DateTime>? utcNow = null)
        => _utcNow = utcNow ?? (() => DateTime.UtcNow);

    /// <summary>כמה הפעלות-מחדש רצופות בוצעו בלי תקופה בריאה ביניהן.</summary>
    public int ConsecutiveRestarts => _consecutive;

    /// <summary>ההמתנה שתידרש לפני הניסיון הבא, בשניות.</summary>
    public int NextDelaySeconds => RestartPolicy.DelaySecondsFor(_consecutive);

    /// <summary>מתי בוצעה ההפעלה-מחדש האחרונה, או null אם לא הייתה.</summary>
    public DateTime? LastRestartUtc => _lastRestartUtc;

    /// <summary>
    /// מבקש רשות להפעיל מחדש. מחזיר true רק אם ההמתנה חלפה, ואז גם מקדם את
    /// המונה ורושם את הזמן. מחזיר false = עוד לא, אל תיגע בתהליך.
    /// </summary>
    public bool TryTake()
    {
        DateTime now = _utcNow();

        if (_lastRestartUtc is DateTime last)
        {
            var wait = TimeSpan.FromSeconds(RestartPolicy.DelaySecondsFor(_consecutive));
            if (now - last < wait)
                return false;
        }

        _consecutive++;
        _lastRestartUtc = now;
        return true;
    }

    /// <summary>
    /// מדווח שהסוכן נראה בריא כרגע. אחרי HealthyResetAfter של בריאות רצופה
    /// הריסון מתאפס, כדי שתקלה עתידית תטופל שוב מיד ולא אחרי 5 דקות.
    /// </summary>
    public void NoteHealthy()
    {
        if (_lastRestartUtc is not DateTime last)
            return;

        if (_utcNow() - last >= RestartPolicy.HealthyResetAfter)
            Reset();
    }

    /// <summary>איפוס מלא — לפעולה מפורשת של המשתמש (הפעל / עצור / החל הגדרות).</summary>
    public void Reset()
    {
        _consecutive = 0;
        _lastRestartUtc = null;
    }
}
