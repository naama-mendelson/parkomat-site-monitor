using System.Diagnostics;
using System.Text;
using Parkomat.Agent.Core.Time;

namespace Parkomat.Agent.Service.Diagnostics;

/// <summary>
/// דוח מצב שעון המחשב, לקובץ הלוג, פעם אחת בעליית הסוכן.
///
/// ==========================================================
/// למה זה קיים
/// ==========================================================
/// חותם הזמן של כל פעולה נלקח משעון המחשב באתר (AgentClock → DateTimeOffset.UtcNow
/// + היסט). מחשב עם שעון סוטה רושם את כל הפעולות שלו בזמן שגוי, והשרת אינו יכול
/// לדעת זאת — סטייה של דקות עדיין נראית כמו זמן סביר לגמרי.
///
/// נמדד בפועל בנתוני האמת: אתר 1343 מקדים ב-34 שניות, אתר 2439 מפגר עד 235
/// שניות, אתר 3513 מפגר ב-20. אף אחד מהם לא היה גלוי לאיש.
///
/// הדוח הזה הופך את זה לגלוי במקום שבו טכנאי כבר מסתכל — קובץ הלוג של הסוכן.
///
/// ==========================================================
/// מה הוא *לא* עושה: לא מכוון את השעון
/// ==========================================================
/// כיוון שעון המערכת והפעלת שירות w32time דורשים הרשאות מנהל, והפרויקט הזה
/// מותקן למשתמש בלבד בלי UAC (ראה installer.iss, PrivilegesRequired=lowest).
/// לכן כאן רק **מדווחים**: מה מצב w32time, מה הוא אומר על עצמו, ומה ההיסט
/// שמדדנו מול NTP בעצמנו. ההפעלה עצמה נעשית במתקין (best-effort, ורק אם מריצים
/// אותו כמנהל) — ראה installer.iss.
///
/// הכול best-effort ומוגבל בזמן: הדוח לא מעכב את עליית הסוכן ולא מפיל אותו.
/// </summary>
public static class HostClockDiagnostics
{
    // תקרת זמן לכל פקודה חיצונית. w32tm על מחשב בלי רשת יכול להשתהות.
    private static readonly TimeSpan CommandTimeout = TimeSpan.FromSeconds(8);

    // מעבר לזה, סטיית השעון אינה רעש אלא תקלה שדורשת טיפול באתר.
    private const double DriftWarnSeconds = 2.0;

    /// <summary>
    /// אוסף את מצב השעון ורושם אותו ללוג. לעולם לא זורק, ולא חוסם יותר
    /// מ-CommandTimeout לכל פקודה.
    /// </summary>
    public static async Task ReportAsync(
        ILogger logger, AgentClock clock, string ntpServer, CancellationToken ct = default)
    {
        try
        {
            var sb = new StringBuilder();
            sb.AppendLine("=== Host clock report ===");
            sb.AppendLine($"  System (local): {DateTime.Now:yyyy-MM-dd HH:mm:ss zzz}");
            sb.AppendLine($"  System (UTC):   {DateTime.UtcNow:yyyy-MM-dd HH:mm:ss}");

            // --- מה מצב שירות הזמן של Windows ---
            // 'sc query' מותר למשתמש רגיל, ולכן זה עובד גם בהתקנה בלי הרשאות.
            string scOutput = await RunAsync("sc.exe", "query w32time", ct);
            bool running = scOutput.Contains("RUNNING", StringComparison.OrdinalIgnoreCase);
            bool found = !scOutput.Contains("1060");   // 1060 = השירות אינו קיים
            sb.AppendLine($"  w32time service: {(!found ? "NOT INSTALLED" : running ? "RUNNING" : "NOT RUNNING")}");

            // --- מה w32time אומר על עצמו ---
            // /query /status הוא קריאה בלבד ועובד גם למשתמש רגיל (נבדק).
            // ('/query /source', לעומתו, דורש הרשאות מנהל — ומיותר, כי ה-Source
            //  מופיע כבר בפלט של /status.)
            string status = await RunAsync("w32tm.exe", "/query /status", ct);
            foreach (string line in Interesting(status))
                sb.AppendLine($"    {line}");

            // ============================================================
            // "רץ" איננו "מסונכרן" — וזו ההבחנה שכל הדוח הזה קיים בשבילה
            // ============================================================
            // נצפה על מחשב אמיתי: השירות RUNNING, ובכל זאת
            //     Leap Indicator: 3(not synchronized)
            //     Stratum: 0 (unspecified)
            // כלומר w32time דולק אבל אין לו מקור זמן תקף, והשעון נסחף בחופשיות.
            // בדיקת "האם השירות רץ" לבדה הייתה מדווחת שהכול תקין.
            //
            // בודקים את הצורות המספריות (LI=3, Stratum=0) ולא את הטקסט המילולי,
            // כי הפלט של w32tm מתורגם לשפת המערכת.
            bool notSynchronized =
                status.Contains("Leap Indicator: 3", StringComparison.OrdinalIgnoreCase) ||
                status.Contains("Stratum: 0", StringComparison.OrdinalIgnoreCase);
            if (notSynchronized)
                sb.AppendLine("    → w32time פועל אך **אינו מסונכרן** (אין מקור זמן תקף).");

            // --- ההיסט שאנחנו מודדים בעצמנו ---
            // זה החלק שלא תלוי ב-w32time בכלל: אותו NtpClient שהסוכן משתמש בו
            // כדי לתקן חותמי זמן. אם w32time מושבת, זה עדיין נותן תשובה.
            sb.Append("  Measured NTP offset: ");
            TimeSpan? offset = await NtpClient.GetOffsetAsync(ntpServer, TimeSpan.FromSeconds(5), ct);
            if (offset is null)
            {
                sb.AppendLine($"unavailable (no answer from '{ntpServer}' — UDP/123 blocked?)");
            }
            else
            {
                double sec = offset.Value.TotalSeconds;
                string verdict = Math.Abs(sec) >= DriftWarnSeconds ? "  ⚠️ DRIFTED" : "  (ok)";
                sb.AppendLine($"{sec:+0.000;-0.000;0.000}s vs '{ntpServer}'{verdict}");
            }

            sb.Append($"  Applied offset (published timestamps): {clock.Offset.TotalSeconds:+0.000;-0.000;0.000}s");
            if (clock.LastSyncUtc is DateTime last)
                sb.Append($", last sync {last:yyyy-MM-dd HH:mm:ss}Z");
            else
                sb.Append(", never synced this run");

            string report = sb.ToString();

            // סטייה אמיתית נרשמת כאזהרה כדי שתבלוט בקובץ; מצב תקין ב-Information.
            bool drifted = (offset is not null && Math.Abs(offset.Value.TotalSeconds) >= DriftWarnSeconds)
                        || !running || notSynchronized;
            if (drifted)
                logger.LogWarning("{Report}\n  → שעון האתר אינו מסונכרן. חותמי הזמן של הפעולות יהיו שגויים בהתאם.", report);
            else
                logger.LogInformation("{Report}", report);
        }
        catch (Exception ex)
        {
            // דוח אבחון לעולם לא מפיל את הסוכן ולא מעכב אותו.
            logger.LogWarning("Host clock report failed: {Message}", ex.Message);
        }
    }

    // רק השורות המעניינות מ-w32tm /query /status. הפלט מקומי (עברית/אנגלית),
    // ולכן מסננים לפי מילות מפתח בשתי השפות ולא לפי מספר שורה.
    private static IEnumerable<string> Interesting(string status)
    {
        if (string.IsNullOrWhiteSpace(status))
        {
            yield return "w32tm /query /status: (no output — service disabled or access denied)";
            yield break;
        }

        string[] keys =
        {
            "Stratum", "Source", "Last Successful Sync", "Poll Interval", "Leap Indicator",
            "שכבה", "מקור", "סנכרון", "מרווח",
        };

        foreach (string raw in status.Split('\n'))
        {
            string line = raw.Trim();
            if (line.Length == 0) continue;
            foreach (string k in keys)
            {
                if (line.Contains(k, StringComparison.OrdinalIgnoreCase))
                {
                    yield return line;
                    break;
                }
            }
        }
    }

    // מריץ פקודה חבויה ומחזיר את הפלט. לעולם לא זורק; מחזיר "" בכל כשל.
    private static async Task<string> RunAsync(string exe, string args, CancellationToken ct)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = exe,
                Arguments = args,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };

            using var proc = Process.Start(psi);
            if (proc is null) return "";

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(CommandTimeout);

            string stdout = await proc.StandardOutput.ReadToEndAsync(cts.Token);
            string stderr = await proc.StandardError.ReadToEndAsync(cts.Token);
            await proc.WaitForExitAsync(cts.Token);

            return stdout.Length > 0 ? stdout : stderr;
        }
        catch
        {
            // פקודה חסרה / הרשאה / timeout — הכול "אין מידע", לא תקלה.
            return "";
        }
    }
}
