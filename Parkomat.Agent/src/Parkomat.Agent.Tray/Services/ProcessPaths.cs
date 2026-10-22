using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Parkomat.Agent.Core.Configuration;

namespace Parkomat.Agent.Tray;

/// <summary>
/// הנתיב של תהליך, ו"האם הוא שלנו" (1.0.62, 22/10/2026). ההחלטה עצמה טהורה — <see cref="ProcessOwnership"/>; כאן
/// רק הקריאה מהמכונה.
///
/// <para>⚠️ <b><c>QueryFullProcessImageName</c> ולא <c>Process.MainModule</c>.</b> MainModule פותח את התהליך בהרשאה
/// מלאה ומונה מודולים: זורק על תהליך 32-ביט (Mosquitto) מתהליך 64-ביט ועל תהליך של משתמש אחר. כאן מספיקה
/// <c>PROCESS_QUERY_LIMITED_INFORMATION</c>, שעובדת בשני המקרים.</para>
/// </summary>
internal static class ProcessPaths
{
    private const uint ProcessQueryLimitedInformation = 0x1000;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    /// <summary>הנתיב המלא של ה-exe של התהליך, או null אם אי אפשר לקרוא.</summary>
    internal static string? ExePathOf(Process p)
    {
        IntPtr h = IntPtr.Zero;
        try
        {
            h = OpenProcess(ProcessQueryLimitedInformation, false, p.Id);
            if (h == IntPtr.Zero) return null;
            var sb = new StringBuilder(1024);
            int size = sb.Capacity;
            return QueryFullProcessImageName(h, 0, sb, ref size) ? sb.ToString(0, size) : null;
        }
        catch { return null; }
        finally { if (h != IntPtr.Zero) CloseHandle(h); }
    }

    /// <summary>האם התהליך שייך להתקנה הזו — ראה <see cref="ProcessOwnership.IsOurs"/>.</summary>
    internal static bool IsOurs(Process p, string ourExePath) =>
        ProcessOwnership.IsOurs(ExePathOf(p), ourExePath, AgentInstance.Current);
}
