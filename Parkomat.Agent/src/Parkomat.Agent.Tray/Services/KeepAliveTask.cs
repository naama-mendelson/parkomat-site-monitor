using System.Diagnostics;
using System.Security.Principal;
using System.Text;

namespace Parkomat.Agent.Tray;

/// <summary>
/// המשימה המתוזמנת שמרימה את ה-Tray — <b>מוגדרת כאן ולא במתקין</b>.
///
/// <para>⚠️ <b>למה זה עבר לקוד: המתקין יצר משימה שבורה בשקט.</b> נמדד
/// ב-09/09/2026 מול Task Scheduler אמיתי. <c>schtasks /Create /SC ONLOGON</c>
/// מחזיר <c>Access is denied</c> למשתמש שאינו מנהל — וההתקנה כאן היא
/// <c>PrivilegesRequired=lowest</c> בכוונה, והפקודה רצה <c>runhidden</c> בלי
/// בדיקת שגיאה. כלומר המשימה **לא הייתה נוצרת באף אתר**, וההתקנה הייתה
/// מדווחת הצלחה.</para>
///
/// <para>⚠️ <b>ושלוש ברירות המחדל של <c>schtasks</c> משביתות את המשימה
/// בשקט</b> — כולן נקראו מה-XML שהוא עצמו ייצר:</para>
///
/// <list type="bullet">
/// <item><c>DisallowStartIfOnBatteries=true</c> — מחשב על UPS אינו מריץ
/// אותה <b>כלל</b>. זו בדיוק אוכלוסיית האתרים שהמנגנון נבנה בשבילה.</item>
/// <item><c>MultipleInstancesPolicy=IgnoreNew</c> — המשימה נחשבת "רצה" כל
/// עוד הטריי שהיא הפעילה חי. טריי <b>תקוע</b> משאיר אותה רצה לנצח, ולכן
/// כל הפעלה הבאה נבלעת — <b>וההשתלטות לעולם לא מקבלת הזדמנות</b>. זה
/// מבטל בדיוק את המנגנון שנבנה מעל.</item>
/// <item><c>ExecutionTimeLimit</c> חסר ⇒ 72 שעות. הטריי נהרג אחרי שלושה
/// ימים.</item>
/// </list>
///
/// <para>⚠️ <b>ומשימה אחת, לא שתיים.</b> <c>schtasks</c> אינו יודע לתת שני
/// מפעילים למשימה אחת, ולכן הגרסה הקודמת ניסתה שתי משימות — והשנייה היא
/// זו שנדחתה בהרשאות. XML נותן את שניהם, ו-<c>/Create /XML</c> נבדק ועובד
/// <b>בלי מנהל</b> כשה-<c>LogonTrigger</c> ממוקד ל-SID של המשתמש עצמו.</para>
///
/// <para>⚠️ <b>ומתקנת את עצמה:</b> נכתבת בכל עליית טריי, לא רק בהתקנה.
/// משימה שנמחקה ידנית או שנוצרה בגרסה ישנה עם ברירות המחדל השבורות
/// מתוקנת בעלייה הבאה, בלי התקנה מחדש.</para>
/// </summary>
internal static class KeepAliveTask
{
    internal const string TaskName = "ParkomatAgentKeepAlive";

    /// <summary>
    /// כותב/מעדכן את המשימה. כל כשל נבלע — כישלון כאן אסור לו למנוע
    /// מהטריי לעלות, שכן הטריי עצמו הוא ההגנה העיקרית.
    /// </summary>
    internal static void Ensure()
    {
        try
        {
            string? exe = Environment.ProcessPath;
            if (string.IsNullOrWhiteSpace(exe)) return;

            string sid = WindowsIdentity.GetCurrent().User?.Value ?? "";
            if (sid.Length == 0) return;

            string xml = BuildXml(exe, sid, DateTime.Now);

            // ⚠️ **UTF-16 עם BOM.** schtasks דורש Unicode; קובץ UTF-8 נדחה
            // בשגיאת פענוח, וגם זה היה נבלע.
            string path = Path.Combine(Path.GetTempPath(), "parkomat-keepalive.xml");
            File.WriteAllText(path, xml, new UnicodeEncoding(false, true));

            try
            {
                var psi = new ProcessStartInfo(
                    Path.Combine(Environment.SystemDirectory, "schtasks.exe"))
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                psi.ArgumentList.Add("/Create");
                psi.ArgumentList.Add("/TN");
                psi.ArgumentList.Add(TaskName);
                psi.ArgumentList.Add("/XML");
                psi.ArgumentList.Add(path);
                psi.ArgumentList.Add("/F");

                using Process? p = Process.Start(psi);
                p?.WaitForExit(15000);
            }
            finally
            {
                try { File.Delete(path); } catch { /* קובץ זמני */ }
            }
        }
        catch { /* המשימה היא רשת ביטחון, לא תנאי לעלייה */ }
    }

    /// <summary>
    /// ה-XML עצמו — <b>טהור</b>, כדי שכל טענה בו תהיה ניתנת לבדיקה בלי
    /// לגעת ב-Task Scheduler. אותו דפוס כמו <c>TakeoverPolicy</c>.
    /// </summary>
    internal static string BuildXml(string exePath, string userSid, DateTime now)
    {
        string start = now.ToString("yyyy-MM-dd'T'HH:mm:ss");

        return $"""
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Date>{start}</Date>
    <Description>מרים את Parkomat Agent Tray בכניסה וכל חמש דקות</Description>
  </RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>{userSid}</UserId>
      <LogonType>InteractiveToken</LogonType>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <Enabled>true</Enabled>
  </Settings>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{userSid}</UserId>
    </LogonTrigger>
    <TimeTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>{start}</StartBoundary>
      <Repetition>
        <Interval>PT5M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Actions Context="Author">
    <Exec>
      <Command>"{exePath}"</Command>
    </Exec>
  </Actions>
</Task>
""";
    }
}
