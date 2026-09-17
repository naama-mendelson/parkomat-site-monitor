using System.Globalization;

namespace Parkomat.Agent.Core.Configuration;

/// <summary>
/// המצב שה-detector צריך כדי להמשיך מאיפה שהפסיק אחרי הפעלה מחדש:
/// ה-MODE האחרון שנראה, והכרטיס של הפעולה הפתוחה.
///
/// ==========================================================
/// למה יש כאן חסם גיל, ולמה הוא הדוק
/// ==========================================================
/// המצב השמור מונע פעולה פיקטיבית בכל עלייה (ראה AgentPaths.DetectorStateFile).
/// אבל מצב **ישן** גרוע מאין-מצב: אם הסוכן היה למטה שעה וה-MODE זז בינתיים,
/// שחזור היה מייצר `end` עם חותם "עכשיו" — כלומר פעולה שנראית כאילו נמשכה
/// שעה, בזמן שפעולת כניסה אמיתית נמשכת שניות. זה מזהם בדיוק את הנתון שהמערכת
/// קיימת בשביל למדוד.
///
/// עשר דקות: מכסה בנדיבות את ההמתנה המקסימלית של הריסון (5 דקות, ראה
/// RestartPolicy) ועוד סבב, כלומר כל הפעלה-מחדש לגיטימית — ונעצר הרבה לפני
/// שמשך פעולה משוחזר הופך למספר שמטעה.
///
/// גיל שלילי (השעון קפץ אחורה) נפסל גם הוא, מאותו טעם כמו ב-AgentClock.
/// ברירת המחדל הבטוחה היא תמיד "בלי שחזור" — כלומר ההתנהגות שהייתה קודם.
/// </summary>
public sealed record DetectorState(int PreviousMode, string OperationCard)
{
    /// <summary>מעבר לזה — לא משחזרים. ראה ההסבר למעלה.</summary>
    public static readonly TimeSpan MaxAge = TimeSpan.FromMinutes(10);

    /// <summary>
    /// קורא מצב שמור, אם הוא קיים ועדיין תקף. מחזיר null אם אין / ישן / פגום.
    /// לעולם לא זורק — כשל קריאה פירושו "מתחילים נקי", וזה בטוח.
    /// </summary>
    public static DetectorState? TryLoad(string? path = null)
    {
        try
        {
            path ??= AgentPaths.DetectorStateFile;
            if (!File.Exists(path)) return null;

            // פורמט: "<unix> <mode> <card>". הכרטיס אחרון ויכול להיות ריק,
            // ולכן הפיצול מוגבל לשלושה חלקים — אחרת כרטיס ריק היה מקצר את
            // המערך והשורה כולה נפסלת.
            string[] parts = File.ReadAllText(path).Trim().Split(' ', 3);
            if (parts.Length < 2) return null;

            if (!long.TryParse(parts[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out long savedAt))
                return null;
            if (!int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out int mode))
                return null;

            TimeSpan age = DateTimeOffset.UtcNow - DateTimeOffset.FromUnixTimeSeconds(savedAt);
            if (age < TimeSpan.Zero || age > MaxAge) return null;

            string card = parts.Length >= 3 ? parts[2].Trim() : "";
            return new DetectorState(mode, card);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// שומר את המצב יחד עם רגע השמירה. כתיבה אטומית, כמו כל קובץ שהשירות כותב
    /// (ראה CLAUDE.md): הפסקת חשמל באמצע כתיבה לא משאירה קובץ חצי-כתוב.
    /// לעולם לא זורק.
    /// </summary>
    public void Save(string? path = null, DateTimeOffset? savedAt = null)
    {
        try
        {
            path ??= AgentPaths.DetectorStateFile;
            // ⚠️ התיקייה של **הנתיב שנמסר**, ולא תיקיית הבסיס תמיד: בדיקה
            // שכותבת לתיקייה זמנית אינה אמורה ליצור או לגעת ב-ProgramData.
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);

            // הכרטיס מנוקה מרווחים ומשורות — הוא האיבר האחרון בפורמט, ורווח
            // בתוכו היה נבלע בשקט בקריאה.
            string card = (OperationCard ?? "").Replace(' ', '_').Replace('\n', '_').Replace('\r', '_');
            string content = string.Format(
                CultureInfo.InvariantCulture, "{0} {1} {2}",
                (savedAt ?? DateTimeOffset.UtcNow).ToUnixTimeSeconds(), PreviousMode, card);

            string temp = path + ".tmp";
            File.WriteAllText(temp, content);
            File.Move(temp, path, overwrite: true);
        }
        catch
        {
            // כשל שמירה אינו קריטי — המצב חי בזיכרון, והעלייה הבאה פשוט
            // תתחיל נקי כמו קודם.
        }
    }
}

/// <summary>
/// מחליט <b>מתי</b> לכתוב מצב גלאי אחד לקובץ אחד: מיד על שינוי, ובלי
/// שינוי — פעם ב-<see cref="RefreshInterval"/>.
///
/// ==========================================================
/// ⚠️ למה "רק על שינוי" לא הספיק
/// ==========================================================
/// ‏<see cref="DetectorState.MaxAge"/> נמדד מהחותם שבקובץ, והקובץ נכתב רק
/// כש-MODE או הכרטיס זזו. כלומר הגיל שנפסל היה "כמה זמן עבר מהשינוי
/// האחרון" — ולא "כמה זמן עבר מאז שראינו את המצב". MODE שתקוע על 2 יותר
/// מעשר דקות, ואז הפעלה מחדש: המצב נפסל כישן, והדגימה הראשונה פותחת
/// **תפעול פיקטיבי** — בדיוק באתר התקוע שהשחזור נבנה בשבילו.
///
/// ⚠️ **ולא כתיבה בכל דגימה.** הבלוק הדו-מערכתי ב-Worker עשה בדיוק את זה:
/// שני קבצים בכל שנייה, כלומר ארבע פעולות דיסק לשנייה על מחשב שמריץ גם את
/// המחסום, בשביל ערך שלא זז. רענון פעם בדקה נותן את אותה הגנה ב-1/60 מהעלות.
///
/// ⚠️ הרענון קורה **רק בזמן שדוגמים**. סוכן שהיה למטה יותר מ-MaxAge עדיין
/// נפסל — וזה בדיוק מה שהחסם קיים בשבילו.
/// </summary>
public sealed class DetectorStateSaver
{
    /// <summary>
    /// ⚠️ יחד עם ההמתנה הארוכה ביותר של ה-Tray (<c>RestartPolicy.MaxDelaySeconds</c>)
    /// חייב להישאר מתחת ל-<see cref="DetectorState.MaxAge"/> — נעול בבדיקה.
    /// </summary>
    public static readonly TimeSpan RefreshInterval = TimeSpan.FromMinutes(1);

    private readonly string _path;
    private int? _mode;
    private string? _card;
    private DateTimeOffset _lastWrite = DateTimeOffset.MinValue;

    public DetectorStateSaver(string path)
    {
        _path = path ?? throw new ArgumentNullException(nameof(path));
    }

    /// <summary>רושם דגימה; כותב אם צריך. מחזיר האם נכתב.</summary>
    public bool Observe(int mode, string card, DateTimeOffset now)
    {
        card ??= "";
        TimeSpan sinceWrite = now - _lastWrite;

        // ⚠️ `sinceWrite` שלילי = השעון קפץ אחורה. בלי הבדיקה הזו חותם
        // "מהעתיד" היה מקפיא את הרענון עד שהשעון ישיג אותו — ו-TryLoad
        // פוסל חותם מהעתיד ממילא, כלומר שחזור מת בדיוק באותו חלון.
        bool unchanged = _mode == mode && _card == card;
        if (unchanged && sinceWrite >= TimeSpan.Zero && sinceWrite < RefreshInterval)
            return false;

        new DetectorState(mode, card).Save(_path, now);
        _mode = mode;
        _card = card;
        _lastWrite = now;
        return true;
    }
}
