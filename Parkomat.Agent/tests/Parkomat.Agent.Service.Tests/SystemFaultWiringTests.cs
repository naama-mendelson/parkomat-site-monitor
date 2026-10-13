using System.Text.RegularExpressions;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// 1.0.58 — החיווט של טקסט התקלה של מערכת אחת בתוך Worker.cs. ה-Worker אינו רץ בבדיקות (הוא כותב ל-ProgramData),
/// ולכן הבדיקה כאן קוראת את הקוד: ש-SystemFaultLatch אכן מוזן משתי המערכות, שהקריאה מהבקר נעשית רק כשהוא
/// אומר, ושהטקסט נכנס לתצלום שנוסע בפעימה. ההתנהגות עצמה — ב-TwoSystemFaultPipelineTests, מול בקר אמיתי.
/// ⚠️ בדיקה מבנית אינה מוכיחה שהקוד רץ — רק שהוא מחובר. לכן היא בנוסף לבדיקת השרשרת, לא במקומה.
/// </summary>
public class SystemFaultWiringTests
{
    private static string Worker()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return File.ReadAllText(Path.Combine(dir!.FullName, "src", "Parkomat.Agent.Service", "Worker.cs"));
    }

    [Fact]
    public void TheLatchIsFedByBothSystems()
    {
        string src = Worker();
        Assert.Matches(new Regex(@"ModeTranslator\.FromMode\(reading\.Mode\)\s*==\s*SiteState\.Error\s*\|\|\s*ModeTranslator\.FromMode\(reading\.Mode2 \?\? 4\)\s*==\s*SiteState\.Error"), src);
        Assert.Matches(new Regex(@"systemFault\.Due\(anySystemInError,"), src);
    }

    [Fact]
    public void TheTextIsReadOnlyWhenTheLatchSaysSo_AndAFailureDoesNotEscape()
    {
        string src = Worker();
        Assert.Matches(new Regex(@"if \(systemFault\.Due\([^)]*\)\)\s*\{\s*//[^\n]*\n\s*try \{ systemFault\.Set\(await ReadFaultTextOrNullAsync\(SiteState\.Error, stoppingToken\)\); \}"), src);
        Assert.Matches(new Regex(@"catch \(Exception fex\)"), src);
    }

    [Fact]
    public void TheTextRidesInTheSnapshotOfTheBeat()
    {
        string src = Worker();
        Assert.Matches(new Regex(@"latestSystems = BatchPayload\.Systems\(TwoSystemDetector\.Snapshot\([\s\S]{0,200}?systemFault\.Text\)\)"), src);
        // אחד ויחיד: לטץ' לכל הלולאה, לא לכל סבב (אחרת "רק כשנכנסים לתקלה" היה "בכל סבב")
        Assert.Single(Regex.Matches(src, @"new SystemFaultLatch\(\)"));
    }
}
