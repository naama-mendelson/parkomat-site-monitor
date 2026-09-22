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

    // ============================================================
    // ⚠️ התקרה — 1,000 היה קטן מדי, וזה נמדד
    // ============================================================
    // המספר ירש את התור הישן שבזיכרון, ונשמר כדי שהתנהגות "נתק ארוך מדי"
    // לא תשתנה בשקט עם המעבר לדיסק. אבל התור ההוא שירת נתק של דקות מול
    // ברוקר מקומי; התור הזה שורד **ימים** מול האינטרנט.
    //
    // נמדד באביגיל 20 (22/09/2026): חומת האש של המחשב חסמה את Supabase,
    // הסוכן צבר הודעות חמישה ימים, התקרה נחצתה — ומאותו רגע כל הודעה
    // חדשה דחפה ישנה החוצה. בלוג נראה `0 message(s) queued (1000 waiting)`
    // שוב ושוב, כלומר **נתונים אבדו בזמן שהתור נראה מלא ותקין**.
    //
    // 10,000 הודעות הן כ-7 שבועות בקצב של אתר טיפוסי, ופחות ממגה־בייט
    // על הדיסק. הגבול קיים כדי שתיקייה לא תמלא את הדיסק ותפיל את המחשב,
    // וזה עדיין מושג — רק לא על חשבון נתק שבוע.
    //
    // ⚠️ והוא בטוח לביצועים רק בגלל ש-`Count` אינו נקרא בכל סבב: הוא סריקת
    // תיקייה, ו-Worker שומר את הערך (ראה ההערה שם). תקרה גדולה עם ספירה
    // בכל שנייה הייתה קונה עמידות בנתק במחיר עומס קבוע.
    public const int DefaultMaxFiles = 10_000;

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
        //
        // ⚠️ **ו-Flush(true) לפני ה-Move — בלעדיו האטומיות חלקית.** ‏
        // `WriteAllText` חוזר כשהבייטים במטמון של Windows, וה-Move נרשם ביומן
        // NTFS מיד. נפילת חשמל בחלון הזה משאירה קובץ `.json` **בשם תקין ובתוכן
        // ריק** — ו-`LoadAll` מוחק אותו כפגום. כלומר התור שנבנה לשרוד נפילת
        // חשמל איבד בדיוק את התפעול שנוצר רגע לפניה.
        using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            fs.Write(JsonSerializer.SerializeToUtf8Bytes(message, Json));
            fs.Flush(flushToDisk: true);
        }
        File.Move(tmp, path, overwrite: true);
        return path;
    }

    /// <summary>
    /// כל ההודעות הממתינות, <b>בסדר שבו נוצרו</b>.
    ///
    /// ⚠️ קובץ שאינו ניתן לפענוח מוסר ולא מפיל את הטעינה. קובץ פגום אחד —
    /// למשל כזה שנקטע בכתיבה בגרסה ישנה — היה חוסם את כל התור מאחוריו לנצח,
    /// וזה בדיוק ההפך ממה שהתור קיים בשבילו.
    ///
    /// ⚠️ <b>אבל רק קובץ שנקרא ולא פוענח.</b> המחיקה ישבה על <b>כל</b>
    /// חריגה — גם על sharing violation רגעית (אנטי-וירוס, גיבוי, אינדקס) —
    /// כלומר הודעה תקינה שטרם נמסרה נמחקה כי מישהו החזיק אותה באותה
    /// מילישנייה. קובץ שלא נקרא <b>מדולג ונשאר</b>, ויילקח בסבב הבא.
    /// </summary>
    public List<(string Path, T Message)> LoadAll<T>()
    {
        var outp = new List<(string, T)>();
        foreach (string path in Files())
        {
            string text;
            try
            {
                text = File.ReadAllText(path);
            }
            catch (Exception)
            {
                continue;   // לא נקרא עכשיו — אינו פגום. נשאר לסבב הבא.
            }

            try
            {
                T? msg = JsonSerializer.Deserialize<T>(text);
                if (msg is not null) outp.Add((path, msg));
                else TryDelete(path);
            }
            catch (JsonException)
            {
                TryDelete(path);
            }
            catch (Exception)
            {
                // ⚠️ לא JsonException = לא בעיה בנתונים (טיפוס שהממיר אינו
                // תומך בו). מחיקה הייתה מאבדת הודעה תקינה; זריקה הייתה חוסמת
                // את כל התור מאחוריה בכל סבב. מדלגים.
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
