using System.Globalization;
using System.Text.Json;

namespace Parkomat.Agent.Core.Queue;

/// <summary>
/// תור פעולות שטרם שודרו — <b>על הדיסק</b>, כדי שישרוד נפילת חשמל.
///
/// <para>
/// ⚠️ <b>מה זה מחליף.</b> התור היה <c>List&lt;OperationMessage&gt;</c> בזיכרון, ו-Worker.cs
/// עצמו כבר תיעד את הפער: "והתור חי בזיכרון בלבד — כלומר כל הפעולות שהוא נועד
/// להציל היו אובדות בדיוק כאן". נפילת חשמל באתר מוחקת אותו לגמרי.
/// </para>
///
/// <para>
/// ⚠️ <b>וזה החצי השני של באג שנמדד היום.</b> <c>cleansession true</c> בגשר גרם לכך
/// שכל הודעה שנוצרה בזמן נתק אינטרנט אבדה לתמיד (0 מתוך 5 בניסוי מבוקר). התיקון
/// שם סגר את <b>נתק האינטרנט</b>; התור של Mosquitto יושב על אותו מחשב, ולכן
/// <b>נפילת חשמל</b> נשארה פתוחה. זה מה שסוגר אותה.
/// </para>
///
/// <para>
/// ⚠️ <b>קובץ לכל הודעה, ולא קובץ אחד עם אינדקס.</b> קובץ מרכזי מחייב לעדכן אותו
/// בכל הסרה, וכתיבה שנקטעת באמצע משאירה אינדקס פגום — כלומר מבנה שנועד למנוע
/// אובדן הופך למקור אובדן. קובץ נפרד נכתב אטומית (tmp ואז Move) ונמחק אטומית;
/// אין מצב ביניים שאפשר להיתקע בו. זה גם אותו דפוס בדיוק ש-ConfigStore
/// ו-BridgeConfigWriter כבר משתמשים בו.
/// </para>
///
/// <para>
/// ⚠️ <b>פעולות בלבד, לא הודעות מצב</b> — ובכוונה. פעולה היא אירוע חד-פעמי:
/// ה-detector הוא edge-triggered ומקדם את מצבו מיד, ולכן אין דרך "לזהות שוב" את
/// המעבר. מצב, לעומת זאת, מתקן את עצמו: בעלייה הסוכן משדר resync עם חותם
/// <b>טרי</b>. הודעת מצב ישנה שהייתה נפרקת מהתור הייתה נדחית ממילא בשומר
/// ה-backfill של השרת — כלומר תור עבורה הוא עבודה שתוצאתה זריקה.
/// </para>
/// </summary>
public sealed class PendingQueue
{
    private readonly string _folder;
    private readonly int _maxFiles;
    private int _seq;

    // ⚠️ אותה תקרה כמו התור הישן. היא נשמרת כדי שהתנהגות "נתק ארוך מדי"
    // לא תשתנה בשקט יחד עם המעבר לדיסק.
    public const int DefaultMaxFiles = 1000;

    private static readonly JsonSerializerOptions Json = new()
    {
        WriteIndented = false,
    };

    public PendingQueue(string folder, int maxFiles = DefaultMaxFiles)
    {
        _folder = folder ?? throw new ArgumentNullException(nameof(folder));
        _maxFiles = maxFiles > 0 ? maxFiles : DefaultMaxFiles;
        Directory.CreateDirectory(_folder);
    }

    /// <summary>מספר ההודעות הממתינות כרגע.</summary>
    public int Count => Files().Length;

    /// <summary>
    /// מוסיף הודעה לתור. מחזיר את נתיב הקובץ שנוצר.
    ///
    /// ⚠️ שם הקובץ הוא <c>{מילישניות:D13}-{רץ:D4}.json</c>. שני שדות ולא אחד:
    /// שתי פעולות יכולות להיווצר באותה מילישנייה (מעבר MODE אחד מייצר שתיים),
    /// ובלי הרץ השנייה הייתה דורסת את הראשונה. והריפוד ל-13 ספרות הוא מה
    /// שהופך מיון <b>לקסיקלי</b> של שמות הקבצים לסדר כרונולוגי נכון.
    /// </summary>
    public string Enqueue<T>(T message)
    {
        TrimToCap();

        long ms = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        int seq = Interlocked.Increment(ref _seq) & 0xFFF;
        string name = string.Format(CultureInfo.InvariantCulture, "{0:D13}-{1:D4}.json", ms, seq);
        string path = Path.Combine(_folder, name);
        string tmp = path + ".tmp";

        // ⚠️ כתיבה אטומית: קודם ל-.tmp, ואז Move. נפילת חשמל באמצע הכתיבה
        // משאירה .tmp חלקי שאיש אינו קורא — ולא קובץ תור קטוע שייקרא כהודעה.
        File.WriteAllText(tmp, JsonSerializer.Serialize(message, Json));
        File.Move(tmp, path, overwrite: true);
        return path;
    }

    /// <summary>
    /// כל ההודעות הממתינות, <b>בסדר שבו נוצרו</b>.
    ///
    /// ⚠️ קובץ שאינו ניתן לפענוח מוסר ולא מפיל את הטעינה. קובץ פגום אחד —
    /// למשל כזה שנקטע בכתיבה בגרסה ישנה — היה חוסם את כל התור מאחוריו לנצח,
    /// וזה בדיוק ההפך ממה שהתור קיים בשבילו.
    /// </summary>
    public List<(string Path, T Message)> LoadAll<T>()
    {
        var outp = new List<(string, T)>();
        foreach (string path in Files())
        {
            try
            {
                T? msg = JsonSerializer.Deserialize<T>(File.ReadAllText(path));
                if (msg is not null) outp.Add((path, msg));
                else TryDelete(path);
            }
            catch (Exception)
            {
                TryDelete(path);
            }
        }
        return outp;
    }

    /// <summary>מסיר הודעה מהתור אחרי שידור מוצלח.</summary>
    public void Remove(string path) => TryDelete(path);

    /// <summary>מוחק הכול. לבדיקות ולאיפוס ידני.</summary>
    public void Clear()
    {
        foreach (string p in Files()) TryDelete(p);
    }

    // ⚠️ ‎.tmp מוחרג: קובץ שנקטע בכתיבה אינו הודעה. הוא גם מנוקה כאן, כדי
    // שנפילות חוזרות לא יצברו זבל בתיקייה עד שתיגמר הדיסק.
    private string[] Files()
    {
        if (!Directory.Exists(_folder)) return [];

        foreach (string stale in Directory.GetFiles(_folder, "*.tmp"))
            TryDelete(stale);

        string[] files = Directory.GetFiles(_folder, "*.json");
        Array.Sort(files, StringComparer.Ordinal);
        return files;
    }

    // ⚠️ מוחק את ה**ישן ביותר**, כמו התור הישן. פעולה שאבדה בגלל נתק ארוך
    // מדי היא הפסד ידוע; תיקייה שמתמלאת עד שהדיסק נגמר מפילה את כל המחשב.
    private void TrimToCap()
    {
        string[] files = Files();
        for (int i = 0; i <= files.Length - _maxFiles; i++)
        {
            if (i >= files.Length) break;
            TryDelete(files[i]);
        }
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); } catch { /* מחיקה שנכשלה אינה מפילה קליטה */ }
    }
}
