using System.Threading;
using System.Windows.Forms;
using Parkomat.Agent.Core.Configuration;

namespace Parkomat.Agent.Tray;

internal static class Program
{
    [STAThread]
    static void Main()
    {
        // מופע יחיד: ה-Tray עולה אוטומטית (HKCU Run). הרצה כפולה (login חופף או
        // דאבל-קליק ידני) הייתה יוצרת שני watchdogs שנלחמים — Exit מאחד הורג את מה
        // שהשני מפעיל, וכל אחד מפעיל מחדש. Mutex חוסם מופע שני בשקט.
        var single = new Mutex(initiallyOwned: true, @"Local\Parkomat.Agent.Tray.SingleInstance", out bool isNew);
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

            // ⚠️ וממתינים ל-Mutex במקום להניח שהוא התפנה. התהליך הקודם
            // משחרר אותו רק כשהוא באמת מת, ומירוץ כאן היה מייצר את שני
            // ה-watchdogs שה-Mutex קיים כדי למנוע.
            single.Dispose();
            single = new Mutex(initiallyOwned: true, @"Local\Parkomat.Agent.Tray.SingleInstance", out isNew);
            if (!isNew) { single.Dispose(); return; }
        }

        using var owned = single;

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
