using Parkomat.Agent.Core.Configuration;

namespace Parkomat.Agent.Service;

/// <summary>
/// מונע ריצה של שני מופעי Agent על אותה מכונה.
///
/// ============================================================
/// ⚠️ למה זה קיים — זה קרה בייצור, ונמדד
/// ============================================================
/// באתר 1284 (עמנואל הרומי 10) רצו **שני** מופעים של השירות מ-26/08/2026
/// 22:23:07 — שניהם ילדים של אותו Tray, שניהם באותה שנייה. שניהם התחברו
/// ל-Mosquitto המקומי עם אותו clientId, ולכן **ניתקו זה את זה בלולאה**.
/// כל ניתוק ירה את הצוואה (LWT), וב-HiveMQ נמדדו **174 הודעות ב-90 שניות**
/// מאתר אחד — כ-170,000 ביום.
///
/// ⚠️ ובדשבורד האתר נראה **תקין**: השרת דוחה את ההצפה כראוי
/// (`no_comm_rejected`), ולכן הכשל היה בלתי נראה לגמרי במשך ימים.
///
/// המקור הוא מרוץ ב-`ServiceManager.StartAgent` — בדיקה ואז הפעלה, בלי
/// נעילה, כשההתקנה והשומר קוראים לה משני תהליכונים. **המרוץ תוקן שם**,
/// אבל הנעילה כאן היא הרשת האמיתית: היא עומדת גם מול התקנה שמפעילה
/// ידנית, מול לחיצה כפולה על ה-exe, ומול כל קורא עתידי שאיש לא זוכר.
/// אותו נימוק בדיוק כמו `db/single-instance.js` בשרת.
/// </summary>
public static class SingleInstance
{
    private const string Name = "Parkomat.Agent.Service.SingleInstance";

    // ⚠️ ה-Mutex מוחזק בשדה סטטי ולא במשתנה מקומי. משתנה מקומי היה נאסף
    // על ידי ה-GC בזמן שהתהליך עדיין רץ, הנעילה הייתה משתחררת, והמופע
    // הבא היה עולה לצדו — כלומר הגנה שנעלמת בלי שאיש ישים לב.
    private static Mutex? _held;

    /// <summary>
    /// מנסה לתפוס את הנעילה. מחזיר true אם זה המופע היחיד.
    /// כשמחזיר false — על הקורא לצאת מיד, לפני שהוא נוגע ב-MQTT.
    /// </summary>
    public static bool TryAcquire()
    {
        // ============================================================
        // ⚠️ Global קודם, Local כגיבוי — ושניהם נחוצים
        // ============================================================
        // `Global\` חוצה סשנים, וזה מה שתופס את המקרה החמור: השירות רץ
        // בסשן 0 (Program.cs קורא ל-AddWindowsService) בזמן שה-Tray מפעיל
        // מופע נוסף בסשן של המשתמש. `Local\` עיוור לזה לגמרי.
        //
        // ⚠️ אבל יצירת אובייקט `Global\` דורשת SeCreateGlobalPrivilege,
        // שאינה ניתנת למשתמש רגיל — והסוכן רץ מ-%LOCALAPPDATA% כמשתמש.
        // נעילה שזורקת בהתקנה רגילה היא הגנה שלא קיימת, ולכן יש נסיגה.
        if (TryOne($"Global\\{Name}")) return true;
        if (_globalDenied) return TryOne($"Local\\{Name}");
        return false;
    }

    private static bool _globalDenied;

    private static bool TryOne(string name)
    {
        try
        {
            var m = new Mutex(initiallyOwned: false, name);

            // ⚠️ אפס המתנה: מופע שני אינו אמור לחכות עד שהראשון יסיים —
            // הוא אמור לצאת. WaitOne עם timeout היה יוצר תור של תהליכים
            // שממתינים לנצח, וזה גרוע מהבעיה המקורית.
            bool got;
            try
            {
                got = m.WaitOne(TimeSpan.Zero, exitContext: false);
            }
            catch (AbandonedMutexException)
            {
                // המחזיק הקודם מת בלי לשחרר (kill -9, נפילת חשמל). הנעילה
                // עברה אלינו והיא תקפה — זה **לא** כשל, וזו בדיוק הסיבה
                // שאסור לתפוס AbandonedMutexException יחד עם שאר החריגות.
                got = true;
            }

            if (!got)
            {
                m.Dispose();
                return false;
            }

            _held = m;
            return true;
        }
        catch (UnauthorizedAccessException)
        {
            // ⚠️ שתי משמעויות שונות, ואי אפשר להבחין ביניהן מכאן:
            //   • אין הרשאה ליצור אובייקט Global (משתמש רגיל)
            //   • האובייקט קיים ונוצר על ידי משתמש אחר — כלומר יש מופע שני
            // הנסיגה ל-Local מכסה את הראשונה; אם גם היא תיכשל, נצא.
            _globalDenied = true;
            return false;
        }
        catch (Exception)
        {
            // ⚠️ כל כשל אחר — נותנים לסוכן לעלות. סוכן שאינו עולה בגלל
            // מנגנון ההגנה שלו הוא אתר שאינו מנוטר בכלל, וזה נזק גדול
            // יותר מהכפילות שהמנגנון בא למנוע.
            _held = null;
            return true;
        }
    }

    /// <summary>
    /// רושם שורה ללוג היומי ישירות. נחוץ כי הסירוב קורה **לפני** שה-Host
    /// נבנה, כלומר לפני שקיים ILogger — ומופע שיוצא בשקט הוא בדיוק סוג
    /// הכשל שלקח כאן ארבעה ימים לגלות.
    /// </summary>
    public static void LogRefusal()
    {
        try
        {
            AgentPaths.EnsureLogsFolderExists();
            string file = Path.Combine(AgentPaths.LogsFolder, $"agent-{DateTime.Now:yyyy-MM-dd}.log");
            string line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} [warn] מופע נוסף של הסוכן ניסה לעלות ונדחה — כבר רץ מופע אחר{Environment.NewLine}";
            File.AppendAllText(file, line);
        }
        catch
        {
            // כתיבת הלוג לא תמנע יציאה נקייה.
        }
    }
}
