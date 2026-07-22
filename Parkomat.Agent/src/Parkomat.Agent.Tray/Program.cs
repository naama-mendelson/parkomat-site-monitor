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
        using var single = new Mutex(initiallyOwned: true, @"Local\Parkomat.Agent.Tray.SingleInstance", out bool isNew);
        if (!isNew)
            return;

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
