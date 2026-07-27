using System.Globalization;
using Parkomat.Agent.Core.Configuration;

namespace Parkomat.Agent.Core.Time;

/// <summary>
/// מקור הזמן היחיד לכל מה שהסוכן משדר.
///
/// ==========================================================
/// למה היסט, ולא כיוון שעון המערכת
/// ==========================================================
/// כיוון שעון המערכת דורש הרשאות מנהל — והפרויקט הזה נמנע מהן בכוונה
/// (התקנה per-user, בלי UAC; ראה CLAUDE.md). לכן שומרים כאן את ההפרש בין
/// זמן ה-NTP לשעון המקומי, ומוסיפים אותו לכל חותמת זמן שמשודרת. שעון
/// המחשב באתר נשאר כפי שהוא; רק מה שמדווח לענן מתוקן.
///
/// ==========================================================
/// למה ההיסט מוחל על השעון המקומי ולא "זמן NTP קפוא"
/// ==========================================================
/// שואלים NTP אחת לשעה, לא בכל פעולה (אחרת כל כניסת רכב הייתה תלויה
/// בסיבוב רשת, וחניון בלי אינטרנט היה משתתק). בין סנכרון לסנכרון הזמן
/// מתקדם לפי השעון המקומי — שמדויק מאוד לטווח קצר — עם ההיסט מעליו.
///
/// אם NTP לא זמין כלל (UDP/123 חסום, אין אינטרנט), ההיסט נשאר 0 והתנהגות
/// הסוכן זהה לחלוטין למה שהייתה קודם. אף פעולה לא אובדת בגלל זה.
/// </summary>
public sealed class AgentClock
{
    private long _offsetTicks;       // ההיסט האחרון שנמדד
    private long _lastSyncUtcTicks;  // 0 = מעולם לא סונכרן

    /// <summary>האם הצליח סנכרון NTP כלשהו מאז עליית הסוכן.</summary>
    public bool IsSynced => Interlocked.Read(ref _lastSyncUtcTicks) != 0;

    /// <summary>ההיסט שנמדד: זמן-אמת פחות שעון המחשב. חיובי = השעון מפגר.</summary>
    public TimeSpan Offset => TimeSpan.FromTicks(Interlocked.Read(ref _offsetTicks));

    /// <summary>מתי בוצע הסנכרון האחרון (UTC), או null אם מעולם לא.</summary>
    public DateTime? LastSyncUtc
    {
        get
        {
            long ticks = Interlocked.Read(ref _lastSyncUtcTicks);
            return ticks == 0 ? null : new DateTime(ticks, DateTimeKind.Utc);
        }
    }

    /// <summary>הזמן הנוכחי המתוקן.</summary>
    public DateTimeOffset UtcNow => DateTimeOffset.UtcNow + Offset;

    /// <summary>הזמן הנוכחי המתוקן ב-unix-שניות — הפורמט של חוזה ה-MQTT.</summary>
    public long UnixNow() => UtcNow.ToUnixTimeSeconds();

    // ==========================================================
    // חסם על גודל ההיסט — ולמה בלעדיו אתר נכבה בשקט
    // ==========================================================
    // ApplyOffset קיבל קודם **כל** ערך. היסט מופרך יכול להגיע משרת NTP שבור,
    // מתשובה מזויפת, או מכשל בפירוש חותמת (למשל גלישת עידן 2036 שלא טופלה).
    // וההשלכה אינה "זמן מעט לא מדויק" אלא אובדן מלא:
    //
    //   השרת מסווג כל חותם לפני קליטה (ingestion/plausibility.js). חותם יותר
    //   מ-5 דקות בעתיד — **נדחה**. חותם לפני רגע רישום האתר — **נדחה**. כלומר
    //   היסט מופרך אחד מפיל *כל* הודעה מהאתר, והאתר נראה שקט ותקין: אין תקלה,
    //   אין no_comm, פשוט אין נתונים.
    //
    // שעה היא הגבול הנכון: סטייה אמיתית שנמדדה בשדה היא שניות עד דקות (34s,
    // 235s), ואפילו שעון שאיבד את אזור הזמן חורג לכל היותר בשעות בודדות —
    // שם כבר עדיף להשאיר את השעון המקומי כפי שהוא ולתת ל-HostClockDiagnostics
    // לזעוק בלוג, מאשר "לתקן" למקום שהשרת ידחה.
    public static readonly TimeSpan MaxPlausibleOffset = TimeSpan.FromHours(1);

    /// <summary>האם היסט נמצא בטווח שאפשר לתקן לפיו. פונקציה טהורה.</summary>
    public static bool IsPlausibleOffset(TimeSpan offset)
        => Math.Abs(offset.Ticks) <= MaxPlausibleOffset.Ticks;

    /// <summary>
    /// מחיל היסט חדש שנמדד מול שרת NTP.
    /// מחזיר false אם ההיסט מופרך — ואז **לא נוגעים בכלום**, ונשארים על השעון
    /// המקומי. ברירת המחדל הבטוחה היא תמיד "בלי תיקון".
    /// </summary>
    public bool ApplyOffset(TimeSpan offset)
    {
        if (!IsPlausibleOffset(offset))
            return false;

        Interlocked.Exchange(ref _offsetTicks, offset.Ticks);
        Interlocked.Exchange(ref _lastSyncUtcTicks, DateTime.UtcNow.Ticks);
        return true;
    }

    // ==========================================================
    // שמירה לדיסק — ולמה היא מוגבלת בזמן
    // ==========================================================
    // התועלת: סוכן שעולה כשהאינטרנט למטה מתחיל מההיסט הידוע האחרון במקום מאפס.
    //
    // הסיכון: אם השעון תוקן או קפץ בזמן שהסוכן היה כבוי, היסט ישן דווקא *יקלקל*
    // את הזמן במקום לתקן אותו. התרחיש אינו תיאורטי — סוללת RTC גוססת מאפסת את
    // השעון בכל אתחול, וטכנאי משנה שעון ידנית.
    //
    // לכן ההיסט נשמר יחד עם *מתי* נמדד, ונפסל אם הוא ישן מדי. גיל שלילי (השעון
    // מראה זמן מוקדם מרגע המדידה) פירושו שהשעון קפץ אחורה — בדיוק מקרה ה-RTC —
    // ולכן גם הוא נפסל. ברירת המחדל הבטוחה היא תמיד "בלי תיקון".
    public static readonly TimeSpan MaxPersistedAge = TimeSpan.FromHours(24);

    /// <summary>טוען היסט שמור, אם הוא קיים ועדיין תקף. מחזיר true אם הוחל.</summary>
    public bool TryLoadPersisted(string? path = null)
    {
        try
        {
            path ??= AgentPaths.ClockOffsetFile;
            if (!File.Exists(path)) return false;

            string[] parts = File.ReadAllText(path).Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length != 2) return false;

            if (!double.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out double seconds)) return false;
            if (!long.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out long measuredAtUnix)) return false;

            TimeSpan age = DateTimeOffset.UtcNow - DateTimeOffset.FromUnixTimeSeconds(measuredAtUnix);
            if (age < TimeSpan.Zero || age > MaxPersistedAge) return false;   // ישן / שעון קפץ אחורה

            // אותו חסם גודל כמו במדידה טרייה. קובץ שנכתב בגרסה קודמת (לפני שהיה
            // חסם) יכול להכיל ערך מופרך, ובלי הבדיקה הזו הוא היה מוחל בעלייה —
            // כלומר האתר היה מתחיל את חייו עם כל ההודעות נדחות.
            TimeSpan persisted = TimeSpan.FromSeconds(seconds);
            if (!IsPlausibleOffset(persisted)) return false;

            Interlocked.Exchange(ref _offsetTicks, persisted.Ticks);
            // *לא* מסמנים IsSynced: זה היסט משוחזר, לא מדידה טרייה מול NTP.
            return true;
        }
        catch
        {
            return false;   // קובץ פגום — מתעלמים ונשארים בלי תיקון
        }
    }

    /// <summary>שומר את ההיסט הנוכחי יחד עם רגע המדידה. כתיבה אטומית.</summary>
    public void Persist(string? path = null)
    {
        try
        {
            path ??= AgentPaths.ClockOffsetFile;
            string content = string.Format(
                CultureInfo.InvariantCulture, "{0:F3} {1}",
                Offset.TotalSeconds, DateTimeOffset.UtcNow.ToUnixTimeSeconds());

            string temp = path + ".tmp";
            File.WriteAllText(temp, content);
            File.Move(temp, path, overwrite: true);
        }
        catch
        {
            // כשל בשמירה אינו קריטי — ההיסט חי בזיכרון ממילא.
        }
    }
}
