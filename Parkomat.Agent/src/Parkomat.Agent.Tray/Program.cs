using System.Threading;
using System.Windows.Forms;
using Parkomat.Agent.Core.Configuration;

namespace Parkomat.Agent.Tray;

internal static class Program
{
    // שם ה-Mutex במקום אחד: הוא נתפס פעמיים בזרימת ההשתלטות, ושתי מחרוזות
    // שצריכות להישאר זהות הן שתי מחרוזות שיום אחד לא יהיו.
    private const string MutexName = @"Local\Parkomat.Agent.Tray.SingleInstance";

    // ⚠️ **עד 10 שניות, ולא ניסיון אחד.** פירוק התהליך ההרוג אינו מיידי,
    // וה-Mutex משתחרר רק בסופו. חצי שנייה בין הניסיונות: מספיק תכוף כדי
    // שההשתלטות תרגיש מיידית, ומספיק דליל כדי לא להעסיק מעבד על מחשב
    // שמריץ גם את המחסום.
    private static Mutex WaitForSingleInstance(out bool isNew)
    {
        for (int i = 0; i < 20; i++)
        {
            var m = new Mutex(initiallyOwned: true, MutexName, out isNew);
            if (isNew) return m;
            m.Dispose();
            Thread.Sleep(500);
        }
        return new Mutex(initiallyOwned: true, MutexName, out isNew);
    }

    [STAThread]
    static void Main()
    {
        // מופע יחיד: ה-Tray עולה אוטומטית (HKCU Run). הרצה כפולה (login חופף או
        // דאבל-קליק ידני) הייתה יוצרת שני watchdogs שנלחמים — Exit מאחד הורג את מה
        // שהשני מפעיל, וכל אחד מפעיל מחדש. Mutex חוסם מופע שני בשקט.
        var single = new Mutex(initiallyOwned: true, MutexName, out bool isNew);
        if (!isNew)
        {
            // ============================================================
            // ⚠️ יציאה בשקט הייתה הופכת טריי תקוע לאתר מת לצמיתות
            // ============================================================
            // ה-Tray מפעיל מחדש את הסוכן ואת Mosquitto, והמשימה המתוזמנת
            // מפעילה מחדש את ה-Tray. אבל **אף אחד לא משגיח על המשגיח**:
            // Tray תקוע — התהליך חי, הלולאה עומדת — מחזיק את ה-Mutex,
            // והמשימה מגיעה כל חמש דקות, נחסמת, ויוצאת. לנצח.
            //
            // ⚠️ אותו כשל בדיוק שכבר תועד שכבה אחת מתחת: הסוכן נהרג 12
            // שניות לפני שהספיק לדווח תקלת PLC. שם התשובה הייתה
            // `WatchdogPolicy`; כאן היא אותה תשובה, שכבה מעל.
            if (!TrayTakeover.ShouldTakeOver()) { single.Dispose(); return; }

            // ⚠️ **הורגים ואז ממשיכים — לא מבקשים סגירה מסודרת.** טריי
            // תקוע לא יענה להודעת סגירה; זו בדיוק ההגדרה של תקוע.
            TrayTakeover.KillExistingTray();

            // ⚠️ **וממתינים באמת — לא בודקים פעם אחת.** ה-Mutex משתחרר כשהליבה
            // מפרקת את התהליך ההרוג, ולא ברגע ה-`Kill`. ניסיון יחיד מיד אחרי
            // ההריגה מדווח "עדיין תפוס" על טריי שכבר מת, וההשתלטות נכשלת
            // בדיוק כשהיא הצליחה.
            single.Dispose();
            single = WaitForSingleInstance(out isNew);

            if (!isNew)
            {
                // ⚠️ **וכאן אסור לצאת בשקט — זו אותה יציאה שיצרה את החור.**
                // אם ההריגה נכשלה (תהליך תקוע בדרייבר, חוסר הרשאה), יציאה
                // שקטה מחזירה את האתר בדיוק למוות השקט שהקוד הזה נועד למנוע:
                // המשימה מגיעה כל חמש דקות, נחסמת, ויוצאת. לנצח, בלי סימן.
                // שורה בלוג היא ההבדל בין תקלה שאפשר לאבחן לבין אתר שפשוט
                // אינו מדווח.
                LogFatal("takeover", new InvalidOperationException(
                    "ההשתלטות נכשלה: המופע הקודם של הטריי לא שחרר את ה-Mutex " +
                    "גם אחרי הריגה והמתנה. בדוק תהליך Parkomat.Agent.Tray שאינו נהרג."));
                single.Dispose();
                return;
            }
        }

        using var owned = single;

        // ⚠️ **המשימה המתוזמנת מוגדרת מכאן, לא מהמתקין** — נמדד שהמתקין
        // יצר אותה שבורה בשקט (הרשאות, סוללות, IgnoreNew, 72 שעות).
        // ההסבר המלא ב-`KeepAliveTask`. נכתבת בכל עלייה כדי שמשימה
        // שנמחקה או שנוצרה בגרסה ישנה תתוקן בלי התקנה מחדש.
        KeepAliveTask.Ensure();

        ApplicationConfiguration.Initialize();

        // מטפל-חריגות גלובלי: בלעדיו, חריגה על thread ה-UI (טעינת אייקון שנכשלה,
        // פקד עם ערך חורג וכו') מפילה את התהליך בשקט — נראה כמו "התקנה נכשלה".
        // כאן היא נרשמת לקובץ ולכן ניתן לאבחן.
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (s, e) => LogFatal("UI thread", e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (s, e) => LogFatal("AppDomain", e.ExceptionObject as Exception);

        Application.Run(new TrayContext());
    }

    // רושם חריגה קטלנית לתיקיית הלוגים, כדי שיהיו עקבות במקום "נעלם בשקט".
    private static void LogFatal(string source, Exception? ex)
    {
        try
        {
            AgentPaths.EnsureLogsFolderExists();
            string path = Path.Combine(AgentPaths.LogsFolder, "tray-fatal.log");
            File.AppendAllText(path,
                $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss} [{source}] {ex}{Environment.NewLine}");
        }
        catch { /* גם רישום הכשל נכשל — אין מה לעשות */ }
    }
}
