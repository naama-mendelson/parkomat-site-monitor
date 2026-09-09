using System.Diagnostics;
using Microsoft.Win32;
using Parkomat.Agent.Core.Configuration;

namespace Parkomat.Agent.Service.Diagnostics;

/// <summary>
/// קורא מהמכונה את שלוש שכבות ההפעלה האוטומטית.
///
/// <para>⚠️ <b>קריאה בלבד, ואינה מתקנת דבר.</b> תיקון מהסוכן היה דורש
/// כתיבה ל-HKLM (הרשאת מנהל) או יצירת משימה — ושניהם שייכים למתקין,
/// שרץ פעם אחת ובידיעת אדם. כלי אבחון שמשנה את מה שהוא בא לאבחן הוא
/// מלכודת, ואותו נימוק כבר רשום ב-<c>ParkomatProbe</c>.</para>
///
/// <para>⚠️ <b>כל כשל מוחזר כ-<c>null</c> ולא כ-<c>false</c>.</b> הרשום
/// עלול להיחסם בהרשאות ו-<c>schtasks</c> עלול לא לענות; דיווח "לא קיים"
/// במקרה כזה היה מסמן מכונה מוגנת כחשופה — ואחרי כמה כאלה איש לא היה
/// מאמין לדיווח.</para>
/// </summary>
public static class AutoStartProbe
{
    // ⚠️ פסק זמן קצר ומפורש. `schtasks` על מכונה עמוסה עלול להיתקע,
    // וקריאת אבחון שתולה את עליית הסוכן היא נזק גדול מהמידע שהיא נותנת.
    private const int TaskQueryTimeoutMs = 5000;

    public static AutoStartHealth.Probe Read(string trayPath)
    {
        return new AutoStartHealth.Probe
        {
            RunValue = ReadRunValue(),
            TrayPath = trayPath,
            TaskExists = TaskExists(),
            AutoLogon = ReadAutoLogon(),
        };
    }

    private static string? ReadRunValue()
    {
        try
        {
            using RegistryKey? key = Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Run");
            return key?.GetValue(AutoStartHealth.RunValueName) as string;
        }
        catch { return null; }
    }

    private static bool? ReadAutoLogon()
    {
        try
        {
            using RegistryKey? key = Registry.LocalMachine.OpenSubKey(
                @"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon");
            // ⚠️ הערך הוא **מחרוזת** "1"/"0" ולא DWORD — קריאה כמספר
            // מחזירה null ומדווחת "לא ידוע" על מכונה מוגדרת היטב.
            object? raw = key?.GetValue("AutoAdminLogon");
            if (raw is null) return false;
            return raw.ToString()?.Trim() == "1";
        }
        catch { return null; }
    }

    private static bool? TaskExists()
    {
        try
        {
            using var p = Process.Start(new ProcessStartInfo
            {
                FileName = "schtasks.exe",
                Arguments = $"/Query /TN \"{AutoStartHealth.TaskName}\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            });
            if (p is null) return null;
            if (!p.WaitForExit(TaskQueryTimeoutMs)) { try { p.Kill(true); } catch { } return null; }
            return p.ExitCode == 0;
        }
        catch { return null; }
    }
}
