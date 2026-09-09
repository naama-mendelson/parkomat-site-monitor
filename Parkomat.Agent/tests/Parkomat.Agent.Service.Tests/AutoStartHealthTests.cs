using System.Text.RegularExpressions;
using Parkomat.Agent.Core.Configuration;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// ההערכה של שלוש שכבות ההפעלה האוטומטית.
///
/// <para>⚠️ <b>נולד מאתר 1089, 09/09/2026:</b> עדכון Windows אתחל את
/// המחשב פעמיים, המשתמש הוחזר לסשן, הערך ב-<c>Run</c> היה קיים ותקין —
/// והטריי לא עלה 5 שעות. ולא הייתה שום דרך לדעת באיזה אתר ההגנה קיימת
/// בלי לנסוע ל-21 מחשבים.</para>
/// </summary>
public class AutoStartHealthTests
{
    private const string Tray = @"C:\Users\USER\AppData\Local\Parkomat\Agent\tray\Parkomat.Agent.Tray.exe";

    private static AutoStartHealth.Probe Healthy() => new()
    {
        RunValue = $"\"{Tray}\"",
        TrayPath = Tray,
        TaskExists = true,
        AutoLogon = true,
    };

    private static string[] Keys(AutoStartHealth.Probe p) =>
        AutoStartHealth.Evaluate(p).Select(f => f.Key).ToArray();

    [Fact]
    public void AFullyProtectedMachineReportsNothing()
    {
        Assert.Empty(AutoStartHealth.Evaluate(Healthy()));
        Assert.False(AutoStartHealth.AnythingUnknown(Healthy()));
    }

    // ⚠️ המקרה שקרה: המשימה חסרה, וכל השאר תקין. בלי הממצא הזה המכונה
    // נראית מוגנת לחלוטין — ואז נופלת בעדכון הבא.
    [Fact]
    public void AMissingScheduledTaskIsCritical()
    {
        var p = new AutoStartHealth.Probe
        {
            RunValue = $"\"{Tray}\"", TrayPath = Tray, TaskExists = false, AutoLogon = true,
        };
        AutoStartHealth.Finding f = Assert.Single(AutoStartHealth.Evaluate(p));
        Assert.Equal("task_missing", f.Key);
        Assert.True(f.Critical);
    }

    // ⚠️ **קריטי, כי בלעדיה שתי השכבות האחרות אינן רצות כלל** — שתיהן
    // דורשות סשן משתמש. זה תרחיש הפסקת החשמל, זה שהשבית את DELL008
    // ל-2.5 ימים.
    [Fact]
    public void NoAutoLogonIsCritical()
    {
        var p = new AutoStartHealth.Probe
        {
            RunValue = $"\"{Tray}\"", TrayPath = Tray, TaskExists = true, AutoLogon = false,
        };
        AutoStartHealth.Finding f = Assert.Single(AutoStartHealth.Evaluate(p));
        Assert.Equal("no_autologon", f.Key);
        Assert.True(f.Critical);
    }

    [Fact]
    public void AMissingRunValueIsReportedButNotCritical()
    {
        var p = new AutoStartHealth.Probe
        {
            RunValue = null, TrayPath = Tray, TaskExists = true, AutoLogon = true,
        };
        AutoStartHealth.Finding f = Assert.Single(AutoStartHealth.Evaluate(p));
        Assert.Equal("run_missing", f.Key);
        // המשימה מכסה עליו, ולכן זו אינה השבתה — רק השהיה של עד 5 דקות.
        Assert.False(f.Critical);
    }

    // ⚠️ **ערך שמצביע על נתיב אחר גרוע מערך חסר**: הוא עובר כל בדיקה
    // שסופרת קיום, ומפעיל בינארי שאינו קיים או ישן.
    [Fact]
    public void ARunValuePointingSomewhereElseIsCaught()
    {
        var p = new AutoStartHealth.Probe
        {
            RunValue = @"""C:\Old\Parkomat\tray\Parkomat.Agent.Tray.exe""",
            TrayPath = Tray, TaskExists = true, AutoLogon = true,
        };
        Assert.Equal(new[] { "run_wrong_path" }, Keys(p));
    }

    // מרכאות ורווחים סביב הנתיב הם הצורה הרגילה ברישום, ולא סטייה.
    [Fact]
    public void QuotesAndCaseDoNotCountAsADifference()
    {
        var p = new AutoStartHealth.Probe
        {
            RunValue = $"  \"{Tray.ToUpperInvariant()}\"  ",
            TrayPath = Tray, TaskExists = true, AutoLogon = true,
        };
        Assert.Empty(AutoStartHealth.Evaluate(p));
    }

    // ============================================================
    // ⚠️ "לא ידוע" אינו "תקין"
    // ============================================================
    // קריאת רישום עלולה להיחסם בהרשאות ו-schtasks עלול לא לענות. שקט
    // במקרה כזה היה מדווח מכונה חשופה כמוגנת — כלומר בדיוק הכשל שכל
    // המנגנון הזה קיים כדי לחשוף.
    [Theory]
    [InlineData(null, true)]
    [InlineData(true, null)]
    [InlineData(null, null)]
    public void UnknownIsNotSilentlyTreatedAsHealthy(bool? task, bool? autoLogon)
    {
        var p = new AutoStartHealth.Probe
        {
            RunValue = $"\"{Tray}\"", TrayPath = Tray, TaskExists = task, AutoLogon = autoLogon,
        };
        // אין ממצא — כי אין ידיעה שמשהו חסר...
        Assert.Empty(AutoStartHealth.Evaluate(p));
        // ...אבל המצב **מסומן** במפורש, והקורא חייב לטפל בו.
        Assert.True(AutoStartHealth.AnythingUnknown(p));
    }

    [Fact]
    public void EverythingMissingIsReportedTogether()
    {
        var p = new AutoStartHealth.Probe
        {
            RunValue = null, TrayPath = Tray, TaskExists = false, AutoLogon = false,
        };
        Assert.Equal(new[] { "run_missing", "task_missing", "no_autologon" }, Keys(p));
    }

    // ⚠️ הסוכן חייב **לקרוא** ולא לתקן: כתיבה ל-HKLM דורשת הרשאת מנהל,
    // ויצירת משימה שייכת למתקין שרץ פעם אחת ובידיעת אדם. כלי אבחון
    // שמשנה את מה שהוא בא לאבחן הוא מלכודת.
    [Fact]
    public void TheProbeOnlyReads()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);

        string probe = File.ReadAllText(Path.Combine(dir!.FullName, "src",
            "Parkomat.Agent.Service", "Diagnostics", "AutoStartProbe.cs"));
        string code = string.Join("\n",
            probe.Split('\n').Where(l => !l.TrimStart().StartsWith("//")));

        Assert.DoesNotContain("SetValue", code);
        Assert.DoesNotContain("DeleteValue", code);
        Assert.DoesNotContain("/Create", code);
        Assert.Contains("OpenSubKey", code);
    }

    // ============================================================
    // ⚠️ כל כשל בגשש הופך ל"לא ידוע", לעולם לא ל"לא קיים"
    // ============================================================
    // מוטציה שהחליפה `catch { return null; }` ב-`return false` **עברה
    // בשקט**: כל הבדיקות שלמעלה מריצות את `Evaluate` על גששים
    // שאני בונה ביד, ואינן נוגעות ב-`AutoStartProbe` כלל.
    //
    // ⚠️ **וזו בדיקה מבנית, לא התנהגותית.** הקריאות שם הן רישום
    // ותהליך חיצוני — אי אפשר לבדוק אותן בלי להריץ על מכונה
    // מוגדרת כך וכך. היא מקבעת את התכונה ולא מוכיחה אותה.
    //
    // התכונה עצמה: רישום שנחסם בהרשאות או `schtasks` שלא עונה
    // מדווח "לא ידוע". `false` היה מסמן מכונה **מוגנת** כחשופה,
    // ואחרי כמה כאלה איש לא יאמין לדיווח.
    [Fact]
    public void EveryProbeFailureBecomesUnknown()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);

        string probe = File.ReadAllText(Path.Combine(dir!.FullName, "src",
            "Parkomat.Agent.Service", "Diagnostics", "AutoStartProbe.cs"));
        string code = string.Join("\n",
            probe.Split('\n').Where(l => !l.TrimStart().StartsWith("//")));

        Assert.DoesNotContain("catch { return false", code);
        Assert.DoesNotContain("catch { return true", code);

        // שלוש הקריאות — Run, כניסה אוטומטית, והמשימה.
        // ⚠️ הספירה חשובה: בלעדיה קובץ שמישהו מחק ממנו את כל
        // ה-catch-ים היה עובר את שתי השורות שמעל בהצלחה מלאה.
        Assert.True(Regex.Matches(code, @"catch \{ return null; \}").Count >= 2,
            "חסרות נפילות-ל-null בגשש");
    }
}
