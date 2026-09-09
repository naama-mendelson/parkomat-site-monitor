using System.Diagnostics;
using Parkomat.Agent.Core.Configuration;

namespace Parkomat.Agent.Tray;

/// <summary>
/// הצד המעשי של <see cref="TakeoverPolicy"/>: קורא מהמכונה, והורג.
///
/// <para>⚠️ <b>ההחלטה עצמה אינה כאן</b>, והיא טהורה — אותו דפוס כמו
/// <c>WatchdogPolicy</c> ו-<c>RestartPolicy</c>. מה שכאן הוא I/O שאי אפשר
/// לבדוק: גיל קובץ, רשימת תהליכים, והריגה.</para>
/// </summary>
internal static class TrayTakeover
{
    private const string TrayProcessName = "Parkomat.Agent.Tray";
    private const string AgentProcessName = "Parkomat.Agent.Service";

    /// <summary>
    /// האם המופע הרץ אינו מתפקד ויש להחליף אותו.
    ///
    /// <para>⚠️ <b>כל כשל בקריאה מסתיים ב-<c>false</c>.</b> החלטה להרוג
    /// טריי חייבת להישען על ידיעה; ספק מוביל ליציאה בשקט, שהיא ההתנהגות
    /// שהייתה עד היום. נכשל-סגור.</para>
    /// </summary>
    internal static bool ShouldTakeOver()
    {
        try
        {
            long? age = LivenessAgeSeconds();
            bool agentAlive = Process.GetProcessesByName(AgentProcessName).Length > 0;

            // ⚠️ קצב הדגימה נקרא מהקובץ ולא מקובע: הסף נגזר ממנו, ואתר
            // שהוגדר לדגימה איטית היה נשפט לפי סף של אתר אחר.
            int poll = ReadPollIntervalMs();

            // ⚠️ גיל הטריי הקיים — בלעדיו כל אתחול מסתיים בהשתלטות. ראה
            // `TakeoverPolicy`: קובץ החיוּת שורד הפסקת חשמל עם חותם ישן.
            long? trayAge = OldestOtherTrayAgeSeconds();

            return TakeoverPolicy.Decide(agentAlive, age, poll, trayAge)
                   == TakeoverPolicy.Action.TakeOver;
        }
        catch { return false; }
    }

    /// <summary>
    /// גיל הטריי הוותיק ביותר <b>שאינו אנחנו</b>.
    ///
    /// <para>הוותיק ולא הצעיר: השאלה היא האם <b>מישהו</b> כבר היה כאן
    /// מספיק זמן כדי לתקן. <c>null</c> אם אין כזה או אם אי אפשר לקרוא —
    /// ואז לא משתלטים.</para>
    /// </summary>
    private static long? OldestOtherTrayAgeSeconds()
    {
        // ⚠️ **איסוף בלבד — הבחירה עצמה טהורה ויושבת ב-TakeoverPolicy.**
        // כשההיגיון ישב כאן, שלוש מוטציות עליו עברו ירוקות: אין לשכבת
        // ה-I/O הזו שום בדיקה התנהגותית, ולא יכולה להיות לה.
        var found = new List<(int Id, DateTime StartedAt)>();

        foreach (Process p in Process.GetProcessesByName(TrayProcessName))
        {
            try { found.Add((p.Id, p.StartTime)); }
            catch { /* נעלם, או אין הרשאה לקרוא זמן התחלה */ }
            finally { p.Dispose(); }
        }

        return TakeoverPolicy.OldestOtherAgeSeconds(
            found, Environment.ProcessId, DateTime.Now);
    }

    private static long? LivenessAgeSeconds()
    {
        try
        {
            var f = new FileInfo(AgentPaths.LivenessFile);
            if (!f.Exists) return null;
            return (long)(DateTime.UtcNow - f.LastWriteTimeUtc).TotalSeconds;
        }
        catch { return null; }
    }

    private static int ReadPollIntervalMs()
    {
        // ⚠️ **לא `ConfigStore.Load()`** — הוא עלול לכתוב, וצורך את דגל
        // האיפוס שהמתקין מניח. מסלול שרץ בכל הפעלה של המשימה, כל חמש
        // דקות, אסור לו לגעת בהגדרות. אותו נימוק כמו ב-ParkomatProbe.
        try
        {
            if (!File.Exists(AgentPaths.ConfigFile)) return 1000;
            SiteConfig? c = ConfigStore.FromJson(File.ReadAllText(AgentPaths.ConfigFile));
            int poll = c?.PollIntervalMs ?? 1000;
            return poll > 0 ? poll : 1000;
        }
        catch { return 1000; }
    }

    /// <summary>
    /// הורג את מופע ה-Tray הקיים.
    ///
    /// <para>⚠️ <b>את הטריי בלבד, ולא את הסוכן ו-Mosquitto.</b> המופע
    /// החדש ימצא אותם וישגיח עליהם; הריגתם כאן הייתה מייצרת נתק מיותר
    /// באתר שאולי דיווח כל הזמן — ושידור מיותר של <c>no_comm</c>.</para>
    /// </summary>
    internal static void KillExistingTray()
    {
        int me = Environment.ProcessId;
        foreach (Process p in Process.GetProcessesByName(TrayProcessName))
        {
            try
            {
                if (p.Id == me) continue;
                p.Kill(entireProcessTree: false);
                p.WaitForExit(5000);
            }
            catch { /* נעלם בינתיים, או אין הרשאה — לא מפילים על זה */ }
            finally { p.Dispose(); }
        }
    }
}
