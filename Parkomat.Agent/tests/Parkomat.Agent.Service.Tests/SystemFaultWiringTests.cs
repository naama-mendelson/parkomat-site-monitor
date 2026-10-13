using System.Text.RegularExpressions;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// 1.0.58/59 — החיווט של טקסט התקלה של מערכת אחת בתוך Worker.cs. ה-Worker אינו רץ בבדיקות (הוא כותב ל-ProgramData),
/// ולכן הבדיקה כאן קוראת את הקוד: ש-SystemFaultLatch מוזן בקבוצת המערכות שבתקלה, שהקריאה מהבקר היא קריאה אחת
/// ונעשית רק כשהוא אומר, ושהטקסט נכנס לתצלום שנוסע בפעימה. ההתנהגות עצמה — ב-TwoSystemFaultPipelineTests.
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
    public void TheLatchIsFedWithWhichSystemsAreInFault()
    {
        string src = Worker();
        // שתי המערכות נבדקות, והקבוצה (לא רק "יש תקלה") נמסרת ללטץ' — שינוי בקבוצה הוא תקלה חדשה
        Assert.Matches(new Regex(@"\(1, reading\.Mode\), \(2, reading\.Mode2 \?\? 4\)"), src);
        Assert.Matches(new Regex(@"systemFault\.Due\(errorUnits,"), src);
    }

    [Fact]
    public void TheTextIsReadOnce_OnlyWhenTheLatchSaysSo_AndAFailureDoesNotEscape()
    {
        string src = Worker();
        // ⚠️ קריאה אחת — ההמתנה ליציבות של ReadFaultTextOrNullAsync יכולה לעבור את סף ה-watchdog (30 שניות)
        Assert.Matches(new Regex(@"try \{ systemFault\.Set\(plc\.ReadFaultText\(\)\.Text\); \}"), src);
        Assert.DoesNotMatch(new Regex(@"systemFault\.Set\(await ReadFaultTextOrNullAsync"), src);
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
